// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {
    ReentrancyGuardTransient
} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Access0x1Router } from "../Access0x1Router.sol";

/// @title  BookingToken
/// @author Access0x1
/// @notice A time-slot/reservation as a TRANSFERABLE ERC-721 with an ATTACHED, USD-priced deposit and a
///         refund that a merchant can NEVER block. Minting a booking pulls a USD-priced deposit (an
///         allowlisted token, quoted in-tx via the shared {Access0x1Router}) into escrow and mints the
///         reservation NFT to the buyer; the deposit then follows whoever HOLDS the NFT. The booking
///         resolves through exactly one terminal transition:
///           - CONFIRM (merchant-owner) — release the deposit to the operator through the router
///             fee-split and burn the reservation (service committed);
///           - CANCEL (the current NFT holder, any time before confirm) — refund the FULL deposit to
///             the holder and burn the reservation;
///           - EXPIRE (holder OR merchant-owner, after the expiry) — same full refund to the holder.
///         A refund is NEVER blocked: a failed push lands in a per-token pull-map the holder claims
///         later (money-safety law #5 — money rolls back, never swallowed; refunds are never blocked).
///         The merchant has NO path that touches an unconfirmed deposit, so it can never strand a
///         holder's refund.
/// @dev    COMPOSITION, NOT DUPLICATION. This is the TOKENIZED reservation (a resellable slot NFT) — it
///         composes, never re-derives, the audited money spine: the confirm RELEASE leg routes through
///         {Access0x1Router.payToken}, so `net + fee == gross` is proven by the router's own fuzz
///         invariants. Every USD→token conversion is read in-tx through {Access0x1Router.quote} (the
///         OracleLib staleness guard) at mint AND at confirm, so price drift cannot be gamed.
///
///         ZERO CUSTODY (escrow-ledger form). The deposit lives as a fully-backed per-token escrow: the
///         contract's balance of a token equals {escrowedOf} = Σ live `deposit`s in that token. A
///         finished booking leaves ~zero escrow. CEI + `nonReentrant` + `SafeERC20` on every value path.
///
///         AUTHORITY. `merchantId` binds a booking to a router merchant; only that merchant's router
///         `owner` may {confirm}. There is no admin key over an unconfirmed deposit — the contract is
///         non-custodial and immutable (no proxy, no upgrade): a clone deploys its own instance wired to
///         the shared router. Refund-never-blocked is enforced with the same length-safe low-level push
///         the sibling booking ledger uses (a USDT-style no-return-data token cannot brick a refund).
contract BookingToken is ERC721, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 CONFIG
    //////////////////////////////////////////////////////////////*/

    /// @notice The floor on a booking's hold window: a booking is un-expirable for at least this long
    ///         after mint, closing a mint→expire slot-cycling grief (mirrors the sibling ledger's O-2 fix).
    uint64 public constant MIN_HOLD_SECS = 60;

    /// @notice The reservation lifecycle. HELD is the only non-terminal state; CONFIRMED/CANCELLED/
    ///         EXPIRED are absorbing (the NFT is burned on entry to any of them).
    enum BStatus {
        NONE,
        HELD,
        CONFIRMED,
        CANCELLED,
        EXPIRED
    }

    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice The shared, audited money spine the release leg flows through (fee-split + in-tx pricing).
    Access0x1Router public immutable router;

    /// @notice A reservation record. Immutable at mint except `status`.
    struct Booking {
        uint256 merchantId; // the router merchant this slot belongs to
        address token; // the deposit token (allowlisted on the router)
        uint256 deposit; // the escrowed token amount (quoted from USD at mint)
        uint256 depositUsd8; // the USD deposit (8 decimals) — re-quoted at confirm for the release
        uint64 expiresAt; // unix time the hold lapses (mint + holdSecs)
        BStatus status; // lifecycle
    }

    /// @notice tokenId ⇒ the reservation record.
    mapping(uint256 tokenId => Booking booking) private _bookings;

    /// @notice tokenId ⇒ the opaque slotKey it occupies. Immutable after mint.
    mapping(uint256 tokenId => bytes32 slotKey) private _slotKeyOf;

    /// @notice (merchantId, slotKey) ⇒ the tokenId occupying that merchant's slot (0 = vacant). Cleared on
    ///         any terminal transition.
    ///
    ///         TENANCY ISOLATION (security): occupancy is namespaced BY MERCHANT. `slotKey` is a public,
    ///         deterministic, caller-supplied slot identity and {mintBooking} is permissionless, so a
    ///         GLOBAL `slotKey ⇒ tokenId` map would let an attacker pin `occupant[victimSlotKey]` (under
    ///         any merchant) with a near-zero-cost, near-unbounded hold and permanently DoS a victim merchant's
    ///         slot (real customers revert `SlotTaken`, no recourse). Keying by (merchantId, slotKey)
    ///         keeps each merchant's calendar independent.
    mapping(uint256 merchantId => mapping(bytes32 slotKey => uint256 tokenId)) public occupant;

    /// @notice token ⇒ total escrowed across live bookings (the conservation anchor = contract balance).
    mapping(address token => uint256 amount) private _escrowedOf;

    /// @notice holder ⇒ token ⇒ refund queued after a failed push (pull-pattern; never blockable).
    mapping(address holder => mapping(address token => uint256 amount)) private _refundRescue;

    /// @notice clientNonce ⇒ consumed (mint idempotency — a replayed mint reverts).
    mapping(bytes32 clientNonce => bool used) public nonceUsed;

    /// @notice The id assigned to the next {mintBooking}. Starts at 1 (0 = unset sentinel).
    uint256 public nextBookingId;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice A slot was reserved: `tokenId` minted to `to`, `deposit` of `token` escrowed.
    /// @dev    Emitted BEFORE the deposit is pulled in (CEI orders the ledger write and the mint ahead
    ///         of the external transfer), so an indexer must treat the enclosing tx's success as the
    ///         confirmation that the escrow was actually funded.
    /// @param  tokenId    The freshly minted reservation NFT.
    /// @param  merchantId The router merchant whose calendar the slot belongs to.
    /// @param  to         The buyer the NFT was minted to (the initial holder; the deposit follows
    ///                    whoever HOLDS the NFT, not this address).
    /// @param  slotKey    The opaque slot identity now occupied for `merchantId`.
    /// @param  token      The deposit token.
    /// @param  deposit    The escrowed token amount, quoted from USD in this tx.
    /// @param  expiresAt  The instant the hold lapses (`mint + holdSecs`).
    event BookingHeld(
        uint256 indexed tokenId,
        uint256 indexed merchantId,
        address indexed to,
        bytes32 slotKey,
        address token,
        uint256 deposit,
        uint64 expiresAt
    );

    /// @notice A booking was confirmed: `settled` released to the operator, `refund` (surplus) to holder.
    /// @dev    `settled + refund == deposit` always. A `settled` of 0 with the FULL deposit refunded is
    ///         the deliberate degraded outcome when the release could not be priced (dead/stale feed or
    ///         a de-allowlisted token): the booking still resolves and the holder is made whole rather
    ///         than the deposit being stranded.
    /// @param  tokenId The reservation that was confirmed and burned.
    /// @param  settled The token amount actually routed through the router fee-split (measured, not
    ///                 assumed).
    /// @param  refund  The surplus returned to the holder (price drift, quote-inversion dust, or the
    ///                 whole deposit when nothing could be routed).
    event BookingConfirmed(uint256 indexed tokenId, uint256 settled, uint256 refund);

    /// @notice A booking was cancelled by the holder: full `refund` returned.
    /// @param  tokenId The reservation that was cancelled and burned.
    /// @param  holder  The NFT holder at cancel time, who is owed the refund.
    /// @param  refund  The full escrowed deposit (pushed, or queued to the pull-map if the push failed).
    event BookingCancelled(uint256 indexed tokenId, address indexed holder, uint256 refund);

    /// @notice A booking expired: full `refund` returned to the holder.
    /// @param  tokenId The reservation that lapsed and was burned.
    /// @param  holder  The NFT holder at expiry time, who is owed the refund — NOT necessarily the
    ///                 caller, since the merchant owner may also trigger an expiry to free the slot.
    /// @param  refund  The full escrowed deposit (pushed, or queued to the pull-map if the push failed).
    event BookingExpired(uint256 indexed tokenId, address indexed holder, uint256 refund);

    /// @notice A refund push failed and was queued to the pull-map.
    /// @dev    The refund-never-blocked signal: the lifecycle transition still succeeded and the money
    ///         is still owed — see {claimRefund}. A payee that cannot receive a push (a reverting
    ///         contract, a blocklisted address) can never brick the transition itself.
    /// @param  holder The party the refund is now owed to.
    /// @param  token  The token owed.
    /// @param  amount The amount added to that holder's claimable credit.
    event RefundQueued(address indexed holder, address indexed token, uint256 amount);

    /// @notice A queued refund was claimed.
    /// @param  holder The claimant.
    /// @param  token  The token withdrawn.
    /// @param  amount The amount paid out (always the full outstanding credit — claims are not partial).
    event RefundClaimed(address indexed holder, address indexed token, uint256 amount);

    /// @notice A required address argument was the zero address — the deposit `token` at
    ///         {mintBooking}, or `router_` at construction. Refused rather than stored: a zero deposit
    ///         token has no feed and no allowlist entry, and a zero router would leave the collection
    ///         permanently unable to price or release a deposit.
    error BookingToken__ZeroAddress();

    /// @notice {mintBooking} was called with `depositUsd8 == 0`. A zero-value hold would occupy a
    ///         merchant's slot at no cost, which is exactly the slot-squatting grief `MIN_HOLD_SECS`
    ///         and the deposit exist to price.
    error BookingToken__ZeroAmount();

    /// @notice The requested hold window is shorter than {MIN_HOLD_SECS}, so the booking would be
    ///         expirable at (or near) the moment it was minted. Refused to close the mint→expire
    ///         slot-cycling grief.
    /// @param  holdSecs The window the caller asked for, in seconds.
    /// @param  min      The enforced floor ({MIN_HOLD_SECS}).
    error BookingToken__HoldTooShort(uint64 holdSecs, uint64 min);

    /// @notice No merchant with this id is registered on the {Access0x1Router} (its `owner` reads back
    ///         as the zero address). Bookings are only ever minted against a live router seat, so an
    ///         unregistered id can never accumulate escrow that nobody is authorized to confirm.
    /// @param  merchantId The id that resolved to no merchant.
    error BookingToken__MerchantNotFound(uint256 merchantId);

    /// @notice The caller is not the router `owner` of the booking's merchant. Thrown by {confirm} —
    ///         the release leg — so only the operator that is owed the money may commit the service.
    ///         Authority is read LIVE from the router, so a merchant-seat handover moves it too.
    /// @param  merchantId The merchant whose owner was required.
    /// @param  caller     The address that attempted the call.
    error BookingToken__NotMerchantOwner(uint256 merchantId, address caller);

    /// @notice This `clientNonce` was already consumed by an earlier {mintBooking}. The idempotency
    ///         guard: a re-submitted (or replayed) mint reverts instead of escrowing a second deposit
    ///         and occupying a second slot.
    /// @param  clientNonce The nonce that was already spent.
    error BookingToken__NonceUsed(bytes32 clientNonce);

    /// @notice A live booking already occupies this merchant's `slotKey`. Occupancy is namespaced by
    ///         merchant, so this only ever signals a double-book of the SAME merchant's slot — the
    ///         identical `slotKey` under a different merchant is unaffected.
    /// @param  slotKey The contested slot.
    /// @param  tokenId The reservation currently holding it.
    error BookingToken__SlotTaken(bytes32 slotKey, uint256 tokenId);

    /// @notice No booking was ever minted under this id (its status is `NONE`). Distinguished from
    ///         {BookingToken__WrongStatus} so a caller can tell "never existed" from "already resolved".
    /// @param  tokenId The unknown reservation id.
    error BookingToken__NotFound(uint256 tokenId);

    /// @notice The booking is not in the state this transition requires. Every terminal state is
    ///         absorbing, so this is what a replayed {confirm}/{cancel}/{expire} hits — the second
    ///         one-shot guard that stops a resolved deposit being released or refunded twice.
    /// @param  tokenId  The reservation.
    /// @param  current  Its actual status.
    /// @param  required The status the transition demanded (always `HELD` today).
    error BookingToken__WrongStatus(uint256 tokenId, BStatus current, BStatus required);

    /// @notice The caller does not hold the reservation NFT. Thrown by {cancel} (holder-only) and by
    ///         {expire} when the caller is neither the holder nor the merchant owner — so no third
    ///         party can churn a merchant's calendar or force someone else's refund.
    /// @param  tokenId The reservation.
    /// @param  caller  The address that attempted the call.
    error BookingToken__NotHolder(uint256 tokenId, address caller);

    /// @notice {expire} was called before the hold window lapsed. The deposit stays escrowed until
    ///         `expiresAt`; before it, only the holder's {cancel} or the merchant's {confirm} resolve
    ///         the booking.
    /// @param  tokenId   The reservation.
    /// @param  expiresAt The instant the hold lapses.
    /// @param  nowTs     `block.timestamp` at the attempt.
    error BookingToken__NotExpired(uint256 tokenId, uint64 expiresAt, uint256 nowTs);

    /// @notice The measured balance delta of the deposit pull did not equal the quoted deposit, i.e.
    ///         the token takes a transfer fee or rebases. Refused at mint: the escrow ledger records
    ///         `deposit`, so a short pull would leave the conservation invariant
    ///         (`balance == Σ live escrow`) broken and a later refund under-funded.
    /// @param  expected The quoted deposit the ledger was credited with.
    /// @param  received What the contract's balance actually rose by.
    error BookingToken__FeeOnTransferToken(uint256 expected, uint256 received);

    /// @notice {claimRefund} was called with no queued refund for that token. Nothing is owed, so
    ///         there is nothing to pull; the pull-map itself is never blockable, only ever empty.
    /// @param  token The token the caller tried to claim.
    error BookingToken__NothingToClaim(address token);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploy a fresh booking collection wired to the shared router. Immutable — a clone deploys
    ///         its own instance against the same router (no admin, no upgrade, non-custodial).
    /// @param name_    The ERC-721 collection name.
    /// @param symbol_  The ERC-721 collection symbol.
    /// @param router_  The {Access0x1Router} that prices + fee-splits the release leg (non-zero).
    constructor(string memory name_, string memory symbol_, address router_)
        ERC721(name_, symbol_)
    {
        if (router_ == address(0)) revert BookingToken__ZeroAddress();
        router = Access0x1Router(router_);
        nextBookingId = 1;
    }

    /*//////////////////////////////////////////////////////////////
                                  MINT
    //////////////////////////////////////////////////////////////*/

    /// @notice Reserve a slot: pull a USD-priced deposit into escrow and mint the reservation NFT to
    ///         `to`. Permissionless (anyone books; the caller funds the deposit from its own balance).
    ///         CEI + `nonReentrant`: checks (token set, non-zero deposit, hold long enough, merchant
    ///         exists, nonce fresh, slot vacant) → effects (write the record, occupy the slot, consume the
    ///         nonce, bump the escrow ledger, mint) → interaction (pull the deposit, delta-checked to
    ///         reject fee-on-transfer). The deposit is quoted from USD in-tx (OracleLib staleness guard),
    ///         so a stale feed reverts the mint rather than escrowing a bad amount.
    /// @dev    ORDERING CAVEAT worth knowing before you edit this function: `_safeMint` is ITSELF an
    ///         external call — it invokes `onERC721Received` on a contract `to` — and it runs BEFORE the
    ///         deposit is pulled in. So inside that receiver callback the escrow ledger already counts
    ///         `deposit` that the contract does not yet hold, i.e. the `balance == Σ live escrow`
    ///         conservation invariant is transiently over-stated. `nonReentrant` is what makes this
    ///         safe: every escrow-touching entry point ({mintBooking}, {confirm}, {cancel}, {expire},
    ///         {claimRefund}) carries the guard, so the callback cannot re-enter and act on the
    ///         inflated figure, and the invariant is restored (or the whole tx reverts) before the
    ///         guard is released. A receiver that reverts, or a deposit pull that comes up short,
    ///         unwinds the entire mint.
    /// @param to          The buyer/holder of the reservation NFT (must accept ERC-721).
    /// @param merchantId  The router merchant the slot belongs to (must exist).
    /// @param slotKey     Opaque slot reference (must be vacant).
    /// @param depositUsd8 The deposit in USD, 8 decimals (> 0).
    /// @param token       The deposit token (allowlisted + priced on the router).
    /// @param holdSecs    The hold window in seconds (≥ `MIN_HOLD_SECS`).
    /// @param clientNonce Idempotency nonce (fresh).
    /// @return tokenId    The minted reservation id.
    function mintBooking(
        address to,
        uint256 merchantId,
        bytes32 slotKey,
        uint256 depositUsd8,
        address token,
        uint64 holdSecs,
        bytes32 clientNonce
    ) external nonReentrant returns (uint256 tokenId) {
        if (token == address(0)) revert BookingToken__ZeroAddress();
        if (depositUsd8 == 0) revert BookingToken__ZeroAmount();
        if (holdSecs < MIN_HOLD_SECS) revert BookingToken__HoldTooShort(holdSecs, MIN_HOLD_SECS);
        if (_merchantOwner(merchantId) == address(0)) {
            revert BookingToken__MerchantNotFound(merchantId);
        }
        if (nonceUsed[clientNonce]) revert BookingToken__NonceUsed(clientNonce);
        // Occupancy is namespaced by merchant (tenancy isolation): only blocks a double-book of THIS
        // merchant's slot, never another merchant's identical slotKey.
        uint256 occupiedBy = occupant[merchantId][slotKey];
        if (occupiedBy != 0) revert BookingToken__SlotTaken(slotKey, occupiedBy);

        // Price the deposit USD→token in-tx (allowlist + feed + staleness enforced by quote).
        uint256 deposit = router.quote(merchantId, token, depositUsd8);

        tokenId = nextBookingId++;
        uint64 expiresAt = uint64(block.timestamp) + holdSecs;

        _bookings[tokenId] = Booking({
            merchantId: merchantId,
            token: token,
            deposit: deposit,
            depositUsd8: depositUsd8,
            expiresAt: expiresAt,
            status: BStatus.HELD
        });
        _slotKeyOf[tokenId] = slotKey;
        occupant[merchantId][slotKey] = tokenId;
        nonceUsed[clientNonce] = true;
        _escrowedOf[token] += deposit;

        emit BookingHeld(tokenId, merchantId, to, slotKey, token, deposit, expiresAt);
        _safeMint(to, tokenId);

        // Interaction: pull the deposit from the caller and verify the delta (reject fee-on-transfer).
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), deposit);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        if (received != deposit) revert BookingToken__FeeOnTransferToken(deposit, received);
    }

    /*//////////////////////////////////////////////////////////////
                                 CONFIRM
    //////////////////////////////////////////////////////////////*/

    /// @notice Confirm a booking: release the deposit to the operator through the router fee-split and
    ///         burn the reservation. Only the router `owner` of the booking's `merchantId`. The USD
    ///         deposit is RE-QUOTED at confirm (fee-application-time oracle read), CLAMPED to the held
    ///         escrow (a confirm never reverts because the token cheapened), and routed through
    ///         {Access0x1Router.payToken}; any surplus (price drift, quote-inversion dust) refunds to the
    ///         current NFT holder. CEI + `nonReentrant`.
    /// @param tokenId The booking to confirm (must be HELD).
    function confirm(uint256 tokenId) external nonReentrant {
        Booking storage b = _bookings[tokenId];
        _requireStatus(tokenId, b.status, BStatus.HELD);
        _requireMerchantOwner(b.merchantId);

        address holder = _ownerOf(tokenId);
        uint256 escrow = b.deposit;
        address token = b.token;
        uint256 merchantId = b.merchantId;
        uint256 usd8 = b.depositUsd8;

        b.status = BStatus.CONFIRMED;
        _vacate(tokenId);
        _release(token, escrow);
        _burn(tokenId);

        uint256 settled = _settleThroughRouter(merchantId, token, usd8, escrow);
        uint256 refund = escrow - settled;
        if (refund > 0) _payoutOrQueue(holder, token, refund);

        emit BookingConfirmed(tokenId, settled, refund);
    }

    /*//////////////////////////////////////////////////////////////
                              CANCEL / EXPIRE
    //////////////////////////////////////////////////////////////*/

    /// @notice Cancel a booking and refund the FULL deposit to the current NFT holder. Callable ONLY by
    ///         the current holder, any time while HELD (before the merchant confirms). The merchant has
    ///         NO cancel path and NO claim on an unconfirmed deposit, so a holder's refund can never be
    ///         blocked. A failed push queues to the pull-map (never reverts the cancel). CEI +
    ///         `nonReentrant`.
    /// @param tokenId The booking to cancel (must be HELD; caller must hold the NFT).
    function cancel(uint256 tokenId) external nonReentrant {
        Booking storage b = _bookings[tokenId];
        _requireStatus(tokenId, b.status, BStatus.HELD);
        address holder = _ownerOf(tokenId);
        if (msg.sender != holder) revert BookingToken__NotHolder(tokenId, msg.sender);

        uint256 refund = b.deposit;
        address token = b.token;
        b.status = BStatus.CANCELLED;
        _vacate(tokenId);
        _release(token, refund);
        _burn(tokenId);
        _payoutOrQueue(holder, token, refund);

        emit BookingCancelled(tokenId, holder, refund);
    }

    /// @notice Expire a lapsed booking and refund the FULL deposit to the holder. Callable by the holder
    ///         OR the merchant owner after `expiresAt` (both have standing: the holder reclaiming, the
    ///         operator freeing the slot) — NOT permissionless, so no third party can churn the calendar.
    ///         The refund is unconditional once authorized; a failed push queues to the pull-map. CEI +
    ///         `nonReentrant`.
    /// @param tokenId The booking to expire (must be HELD and past `expiresAt`).
    function expire(uint256 tokenId) external nonReentrant {
        Booking storage b = _bookings[tokenId];
        _requireStatus(tokenId, b.status, BStatus.HELD);
        address holder = _ownerOf(tokenId);
        if (msg.sender != holder && msg.sender != _merchantOwner(b.merchantId)) {
            revert BookingToken__NotHolder(tokenId, msg.sender);
        }
        if (block.timestamp < b.expiresAt) {
            revert BookingToken__NotExpired(tokenId, b.expiresAt, block.timestamp);
        }

        uint256 refund = b.deposit;
        address token = b.token;
        b.status = BStatus.EXPIRED;
        _vacate(tokenId);
        _release(token, refund);
        _burn(tokenId);
        _payoutOrQueue(holder, token, refund);

        emit BookingExpired(tokenId, holder, refund);
    }

    /// @notice Withdraw a refund that was queued when a push failed. Pure pull-pattern; open always.
    ///         CEI + `nonReentrant`: the credit is zeroed BEFORE the transfer, so a re-entrant claimer
    ///         finds nothing owed. A queued refund can always be withdrawn — no party can block it.
    /// @param token The token to claim.
    function claimRefund(address token) external nonReentrant {
        uint256 amount = _refundRescue[msg.sender][token];
        if (amount == 0) revert BookingToken__NothingToClaim(token);
        _refundRescue[msg.sender][token] = 0;
        emit RefundClaimed(msg.sender, token, amount);
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice The full booking record for `tokenId` (zeroed if it never existed / was burned).
    /// @dev    Never reverts, so a router or UI can staticcall it blind. NOTE the record SURVIVES the
    ///         terminal transitions: `confirm`/`cancel`/`expire` burn the NFT but leave the struct in
    ///         place with its absorbing `status`, so this is also the post-mortem read for a resolved
    ///         booking. Read `status == BStatus.NONE` — not a zero `deposit` — to test existence.
    /// @param  tokenId The reservation id to read.
    /// @return The stored {Booking} (all-zero, i.e. `status == NONE`, for an id never minted).
    function bookingOf(uint256 tokenId) external view returns (Booking memory) {
        return _bookings[tokenId];
    }

    /// @notice Whether `slotKey` is currently available for `merchantId` (no live booking occupies that
    ///         merchant's slot). Occupancy is per-merchant, so the same slotKey may be available for one
    ///         merchant and taken for another.
    /// @dev    An availability HINT, not a reservation: it reflects state at call time only, and
    ///         {mintBooking} is permissionless, so a slot can be taken between this read and the mint.
    ///         The authoritative check is {mintBooking}'s own `SlotTaken` revert.
    /// @param  merchantId The merchant whose calendar to check.
    /// @param  slotKey    The opaque slot identity to check.
    /// @return True when no live reservation occupies that merchant's slot.
    function isSlotFree(uint256 merchantId, bytes32 slotKey) external view returns (bool) {
        return occupant[merchantId][slotKey] == 0;
    }

    /// @notice Total token escrowed across live bookings (equals the contract's balance of `token`).
    /// @dev    The conservation anchor an auditor checks: `IERC20(token).balanceOf(this)` should equal
    ///         this value plus any credits queued in the refund pull-map. Credited at mint and debited
    ///         on every terminal transition.
    /// @param  token The deposit token to total.
    /// @return The sum of live (HELD) deposits denominated in `token`.
    function escrowedOf(address token) external view returns (uint256) {
        return _escrowedOf[token];
    }

    /// @notice A holder's queued (claimable) refund of `token`.
    /// @dev    Non-zero only when a refund push failed and fell back to the pull-map. Withdrawn in full
    ///         by {claimRefund}; no party can block or reduce it.
    /// @param  holder The party owed the refund.
    /// @param  token  The token owed.
    /// @return The amount `holder` may currently {claimRefund} in `token`.
    function refundRescueOf(address holder, address token) external view returns (uint256) {
        return _refundRescue[holder][token];
    }

    /// @notice The opaque slotKey `tokenId` occupies (0 if it never existed).
    /// @dev    Written once at mint and never cleared, so a resolved booking still reports the slot it
    ///         HELD — use {isSlotFree} (or {occupant}) to test current availability.
    /// @param  tokenId The reservation id to read.
    /// @return The slot identity recorded at mint (`bytes32(0)` for an id never minted).
    function slotKeyOf(uint256 tokenId) external view returns (bytes32) {
        return _slotKeyOf[tokenId];
    }

    /*//////////////////////////////////////////////////////////////
                                 INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev Settle a USD-priced deposit through the router fee-split, never re-deriving the split. The
    ///      deposit is RE-QUOTED at confirm and the routed gross CLAMPED to the held `escrow`. Returns
    ///      the token amount ACTUALLY routed (measured), so the caller refunds the exact surplus.
    ///      REFUND-NEVER-BLOCKED: a stale/dead oracle or de-allowlisted token makes the re-quote revert;
    ///      rather than bricking confirm, treat it as "cannot price the release" — route nothing, so the
    ///      full escrow refunds to the holder.
    /// @dev TRUST + FAILURE MODES. The router is the only external contract called here and is trusted
    ///      to honour `net + fee == gross`; the amount routed is nevertheless MEASURED as a balance
    ///      delta rather than assumed, so even a router that pulled less than approved cannot make the
    ///      caller over-refund. The `payToken` call is `try`/`catch`ed and the approval is reset to 0 on
    ///      BOTH branches, so a failed release leaves no standing allowance for the router to draw on
    ///      later. Reachable only from {confirm}, which is `nonReentrant`; the approve → call → revoke
    ///      window therefore cannot be re-entered.
    /// @param merchantId The router merchant to pay.
    /// @param token      The escrowed deposit token.
    /// @param usd8       The USD amount recorded at mint, re-quoted here at confirm-time price.
    /// @param escrow     The held deposit — the hard ceiling on what may be routed.
    /// @return settled The token amount actually routed (0 when the release could not be priced or the
    ///                 router call reverted, in which case the caller refunds the full escrow).
    function _settleThroughRouter(uint256 merchantId, address token, uint256 usd8, uint256 escrow)
        private
        returns (uint256 settled)
    {
        (uint256 grossNow, bool ok) = _trySafeQuote(merchantId, token, usd8);
        if (!ok) return 0;
        uint256 target = grossNow > escrow ? escrow : grossNow;
        if (target == 0) return 0;

        uint256 usdToRoute = _tokenToUsd8(merchantId, token, target);
        if (usdToRoute == 0) return 0;

        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).forceApprove(address(router), target);
        // slither-disable-next-line reentrancy-events,reentrancy-benign
        try router.payToken(merchantId, token, usdToRoute, _orderId(token)) {
            settled = balBefore - IERC20(token).balanceOf(address(this));
        } catch {
            settled = 0;
        }
        IERC20(token).forceApprove(address(router), 0);
    }

    /// @dev A stable per-token orderId for the router receipt (opaque; the router echoes it in its event).
    ///      NOT unique per booking — every confirm of the same token emits the same reference, so an
    ///      indexer must key router receipts by tx hash / log index rather than treating this as an
    ///      idempotency key. It is a label, never a guard; the booking's own absorbing status is what
    ///      makes a confirm one-shot.
    /// @param token The deposit token being released.
    /// @return The order reference passed to {Access0x1Router.payToken}.
    function _orderId(address token) private pure returns (bytes32) {
        return bytes32(uint256(uint160(token)));
    }

    /// @dev {Access0x1Router.quote} wrapped so a revert (stale/zero price, de-allowlist, missing feed) is
    ///      surfaced as `ok == false` instead of bubbling and bricking a refund (law #5).
    ///      DELIBERATELY SWALLOWS the revert reason: this sits on the REFUND path, where the correct
    ///      response to "cannot price" is to route nothing and return the holder's money, not to strand
    ///      the deposit. The money-path counterpart is the opposite — {mintBooking} calls
    ///      `router.quote` unwrapped, so a stale feed reverts the mint outright rather than escrowing a
    ///      deposit priced off a bad answer.
    /// @param merchantId The router merchant to quote against.
    /// @param token      The token to price.
    /// @param usd8       The USD amount (8 decimals) to convert.
    /// @return amount The quoted token amount, or 0 when the quote failed.
    /// @return ok     False when the router reverted for ANY reason; the caller must not treat the
    ///                accompanying zero `amount` as a real price.
    function _trySafeQuote(uint256 merchantId, address token, uint256 usd8)
        private
        view
        returns (uint256 amount, bool ok)
    {
        try router.quote(merchantId, token, usd8) returns (uint256 q) {
            return (q, true);
        } catch {
            return (0, false);
        }
    }

    /// @dev Invert {Access0x1Router.quote}: given a token `amount`, the USD-8dp value whose quote is ≤
    ///      `amount`, so a subsequent `payToken(usd8)` pulls no more than the contract holds. `quote` is
    ///      linear in usd8 (rounded up), so probe `quote(1e8)` (=$1) and divide, rounding DOWN. Returns 0
    ///      when `amount` is below one dollar's worth of token (caller treats it as dust). Wrapped for
    ///      the same law-#5 reason: an unreadable oracle routes nothing.
    /// @dev  Rounding is DOWN by construction, and that direction is the safety property: the router
    ///       re-quotes this USD figure and rounds UP, so rounding down here guarantees the gross the
    ///       router pulls never exceeds the `target` this contract approved. The residue stays in
    ///       escrow and refunds to the holder as surplus.
    /// @param merchantId The router merchant to quote against.
    /// @param token      The token being valued.
    /// @param amount     The token amount to express in USD.
    /// @return usd8 The USD value (8 decimals) whose quote is ≤ `amount`; 0 when the oracle is
    ///              unreadable or `amount` is worth less than one dollar (treated as dust).
    function _tokenToUsd8(uint256 merchantId, address token, uint256 amount)
        private
        view
        returns (uint256 usd8)
    {
        (uint256 tokenPerDollar, bool ok) = _trySafeQuote(merchantId, token, 1e8);
        if (!ok || tokenPerDollar == 0) return 0;
        usd8 = Math.mulDiv(amount, 1e8, tokenPerDollar, Math.Rounding.Floor);
    }

    /// @dev Decrement the escrow ledger for `token` by `amount` BEFORE any external transfer of that
    ///      escrow (CEI), so `balance == Σ live escrow` holds at every external-call boundary on the
    ///      RELEASE side — the ledger is never left claiming escrow that has already left the contract.
    ///      (The one place the invariant is transiently over-stated instead is the MINT side, where
    ///      `_safeMint`'s receiver callback fires before the deposit is pulled; `nonReentrant` covers
    ///      that window — see {mintBooking}.) Deliberately CHECKED arithmetic: an `amount` exceeding the
    ///      recorded escrow underflows and reverts rather than silently wrapping, so a bookkeeping bug
    ///      can never mint escrow out of thin air.
    /// @param token  The deposit token whose escrow total is being reduced.
    /// @param amount The amount leaving escrow (must not exceed the recorded total).
    function _release(address token, uint256 amount) private {
        _escrowedOf[token] -= amount;
    }

    /// @dev Vacate the slot a terminal reservation occupied so the slotKey can be reused for that merchant.
    ///      Idempotent. The `occupant[merchantId][slotKey] == id` equality is load-bearing, not
    ///      defensive: it guarantees a booking can only ever release the occupancy IT holds, so a stale
    ///      or repeated call can never evict the reservation that legitimately owns the slot now.
    /// @param id The reservation reaching a terminal state.
    function _vacate(uint256 id) private {
        uint256 merchantId = _bookings[id].merchantId;
        bytes32 slotKey = _slotKeyOf[id];
        if (occupant[merchantId][slotKey] == id) occupant[merchantId][slotKey] = 0;
    }

    /// @dev Push `amount` of `token` to `to`, or queue it to the pull-map on failure. LENGTH-SAFE like
    ///      SafeERC20: a raw `try transfer() returns (bool)` would ABI-decode in the success path, so a
    ///      USDT-style no-return-data token would revert the WHOLE transition and brick the booking. We
    ///      low-level `call` and inspect: empty return-data = success (USDT), 32-byte `true` = success,
    ///      only a genuine revert or a `false`-liar queues. So every refund pays out or queues — it NEVER
    ///      reverts the lifecycle transition (law #5). CEI: runs after all status/ledger effects.
    /// @dev THE LOW-LEVEL CALL IS THE POINT, and it is reentrancy-relevant: `token` is merchant-chosen,
    ///      so this hands control to an arbitrary address. Safe here because (a) every caller reaches
    ///      this only from a `nonReentrant` entry point, and (b) CEI has already run — status is
    ///      terminal, the slot is vacated, the escrow ledger is debited and the NFT burned — so a
    ///      re-entrant token finds a fully settled booking and nothing left to double-spend. A
    ///      `false`-returning or reverting token costs the recipient nothing: the amount lands in the
    ///      pull-map instead, claimable forever via {claimRefund}.
    /// @param to     The party owed the money.
    /// @param token  The token to push.
    /// @param amount The amount to push; a zero amount is a no-op and queues nothing.
    // slither-disable-next-line reentrancy-events
    function _payoutOrQueue(address to, address token, uint256 amount) private {
        if (amount == 0) return;
        // slither-disable-next-line low-level-calls
        (bool callOk, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        bool transferOk =
            callOk && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
        if (!transferOk) {
            _refundRescue[to][token] += amount;
            emit RefundQueued(to, token, amount);
        }
    }

    /// @dev Revert unless `msg.sender` is the router owner of `merchantId` (single source of truth).
    ///      Read LIVE on every call, never cached at mint, so transferring the router merchant seat
    ///      moves confirm authority with it and a former owner loses it in the same tx.
    /// @param merchantId The merchant whose current owner is required.
    function _requireMerchantOwner(uint256 merchantId) private view {
        address owner_ = _merchantOwner(merchantId);
        if (owner_ == address(0)) revert BookingToken__MerchantNotFound(merchantId);
        if (msg.sender != owner_) revert BookingToken__NotMerchantOwner(merchantId, msg.sender);
    }

    /// @dev Revert unless booking `tokenId`'s status equals `required` (NotFound for an unset id).
    ///      Checking `NONE` first is what keeps "never existed" and "already resolved" distinguishable
    ///      to a caller instead of collapsing both into one opaque revert.
    /// @param id       The reservation id (for the revert payload).
    /// @param current  The status actually stored.
    /// @param required The status the caller's transition demands.
    function _requireStatus(uint256 id, BStatus current, BStatus required) private pure {
        if (current == BStatus.NONE) revert BookingToken__NotFound(id);
        if (current != required) revert BookingToken__WrongStatus(id, current, required);
    }

    /// @dev Read the router owner of `merchantId` (the `owner` field of the Merchant record).
    ///      `address(0)` means the seat was never registered — every auth check above treats that as
    ///      "unknown merchant" and reverts rather than falling through.
    /// @param merchantId The merchant seat to look up.
    /// @return owner_ The seat's current owner, or `address(0)` if it was never registered.
    function _merchantOwner(uint256 merchantId) private view returns (address owner_) {
        (, owner_,,,,) = router.merchants(merchantId);
    }
}
