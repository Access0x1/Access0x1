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
    event BookingConfirmed(uint256 indexed tokenId, uint256 settled, uint256 refund);

    /// @notice A booking was cancelled by the holder: full `refund` returned.
    event BookingCancelled(uint256 indexed tokenId, address indexed holder, uint256 refund);

    /// @notice A booking expired: full `refund` returned to the holder.
    event BookingExpired(uint256 indexed tokenId, address indexed holder, uint256 refund);

    /// @notice A refund push failed and was queued to the pull-map.
    event RefundQueued(address indexed holder, address indexed token, uint256 amount);

    /// @notice A queued refund was claimed.
    event RefundClaimed(address indexed holder, address indexed token, uint256 amount);

    error BookingToken__ZeroAddress();
    error BookingToken__ZeroAmount();
    error BookingToken__HoldTooShort(uint64 holdSecs, uint64 min);
    error BookingToken__MerchantNotFound(uint256 merchantId);
    error BookingToken__NotMerchantOwner(uint256 merchantId, address caller);
    error BookingToken__NonceUsed(bytes32 clientNonce);
    error BookingToken__SlotTaken(bytes32 slotKey, uint256 tokenId);
    error BookingToken__NotFound(uint256 tokenId);
    error BookingToken__WrongStatus(uint256 tokenId, BStatus current, BStatus required);
    error BookingToken__NotHolder(uint256 tokenId, address caller);
    error BookingToken__NotExpired(uint256 tokenId, uint64 expiresAt, uint256 nowTs);
    error BookingToken__FeeOnTransferToken(uint256 expected, uint256 received);
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
    function bookingOf(uint256 tokenId) external view returns (Booking memory) {
        return _bookings[tokenId];
    }

    /// @notice Whether `slotKey` is currently available for `merchantId` (no live booking occupies that
    ///         merchant's slot). Occupancy is per-merchant, so the same slotKey may be available for one
    ///         merchant and taken for another.
    function isSlotFree(uint256 merchantId, bytes32 slotKey) external view returns (bool) {
        return occupant[merchantId][slotKey] == 0;
    }

    /// @notice Total token escrowed across live bookings (equals the contract's balance of `token`).
    function escrowedOf(address token) external view returns (uint256) {
        return _escrowedOf[token];
    }

    /// @notice A holder's queued (claimable) refund of `token`.
    function refundRescueOf(address holder, address token) external view returns (uint256) {
        return _refundRescue[holder][token];
    }

    /// @notice The opaque slotKey `tokenId` occupies (0 if it never existed).
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
    function _orderId(address token) private pure returns (bytes32) {
        return bytes32(uint256(uint160(token)));
    }

    /// @dev {Access0x1Router.quote} wrapped so a revert (stale/zero price, de-allowlist, missing feed) is
    ///      surfaced as `ok == false` instead of bubbling and bricking a refund (law #5).
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
    ///      escrow (CEI), so `balance == Σ live escrow` holds at every external-call boundary.
    function _release(address token, uint256 amount) private {
        _escrowedOf[token] -= amount;
    }

    /// @dev Vacate the slot a terminal reservation occupied so the slotKey can be reused for that merchant.
    ///      Idempotent.
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
    function _requireMerchantOwner(uint256 merchantId) private view {
        address owner_ = _merchantOwner(merchantId);
        if (owner_ == address(0)) revert BookingToken__MerchantNotFound(merchantId);
        if (msg.sender != owner_) revert BookingToken__NotMerchantOwner(merchantId, msg.sender);
    }

    /// @dev Revert unless booking `tokenId`'s status equals `required` (NotFound for an unset id).
    function _requireStatus(uint256 id, BStatus current, BStatus required) private pure {
        if (current == BStatus.NONE) revert BookingToken__NotFound(id);
        if (current != required) revert BookingToken__WrongStatus(id, current, required);
    }

    /// @dev Read the router owner of `merchantId` (the `owner` field of the Merchant record).
    function _merchantOwner(uint256 merchantId) private view returns (address owner_) {
        (, owner_,,,,) = router.merchants(merchantId);
    }
}
