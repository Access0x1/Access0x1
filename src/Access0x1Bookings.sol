// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    Ownable2StepUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {
    ReentrancyGuardTransient
} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Access0x1Router } from "./Access0x1Router.sol";
import { ISessionGrant } from "./interfaces/ISessionGrant.sol";
import { IAccess0x1Bookings } from "./interfaces/IAccess0x1Bookings.sol";

/// @title  Access0x1Bookings
/// @author Access0x1
/// @notice A vertical-agnostic deposit-escrow primitive with a GUARANTEED, never-blockable refund. A
///         payer escrows a USD-priced deposit against a unique opaque `slotKey` with a hold deadline;
///         the booking then resolves through exactly one lifecycle transition — confirm (release to
///         the operator via the Router fee-split), expire (refund the payer), cancel (full / late-fee /
///         blocked-inside-window per an IMMUTABLE policy snapshot), or no-show (keep the fee, refund
///         the remainder). A refund is never blocked: a failed push lands in a per-token pull-map the
///         owed party (or a keeper) claims later (money-safety invariant #5 — money rolls back, never swallowed;
///         refunds are never blocked).
/// @dev    COMPOSITION, NOT DUPLICATION. This contract owns lifecycle/eligibility ONLY. It never
///         re-derives the fee split: the confirm RELEASE leg and the cancel/no-show FEE leg flow
///         through {Access0x1Router.payToken}, so `net + fee == gross` is proven by the Router's own
///         audited fuzz invariants, not re-proven here. Every USD→token conversion is read in-tx
///         through {Access0x1Router.quote} (which applies the OracleLib staleness guard) at reserve
///         AND at fee-application time, so price drift between reserve and settle cannot be gamed.
///
///         ZERO CUSTODY. The deposit lives as a fully-backed escrow ledger: the contract's ERC-20
///         balance of a token always equals {escrowedOf}, which equals the sum of every HELD/CONFIRMED
///         reservation's `escrowAmount` in that token (conservation — nothing leaks, the contract holds
///         no free-floating balance). A finished booking leaves ~zero escrow. This is the escrow-ledger
///         form of the zero-custody law (the ADR permits a PaymentLanes lane OR a balance ledger); it
///         is the sibling shape of {PaymentLanes}, kept internal so a per-reservation release from a
///         shared per-token pool is a single, reentrancy-safe debit.
///
///         POLICY SNAPSHOT. The cancellation {Policy} is written once at {reserve} and never mutated —
///         an operator can never retroactively raise the fees on a live booking.
///
///         TENANCY. `merchantId`, `payer`, `token`, `slotKey`, and `policy` are immutable per
///         reservation, and no path touches another reservation's or another merchant's storage —
///         preserving the Router's isolation invariant. `slotKey`, `slotTimestamp`, and `clientNonce`
///         are opaque, so a booking app, a rental window, a ticketed seat, or a partner's vertical all
///         reuse the SAME contract.
///
///         UPGRADEABILITY (the Access0x1 UUPS TEMPLATE — every system contract follows this exact
///         shape): the contract is deployed behind an `ERC1967Proxy`; storage lives in the proxy, logic
///         in this implementation. State is set once via {initialize} (the constructor-replacement,
///         `initializer`-guarded — `router`, `sessionGrant`, the admin owner, and `nextReservationId`);
///         the implementation's own constructor calls `_disableInitializers()` so the logic contract can
///         never be initialized or hijacked directly. Upgrades route through {upgradeToAndCall} and are
///         authorized by {_authorizeUpgrade} (contract-`owner`-only — the `Ownable2StepUpgradeable`
///         owner, the UPGRADE ADMIN, which holds NO authority over any escrow or refund). Calling
///         `renounceOwnership()` permanently freezes the implementation (no owner ⇒ no authorized
///         upgrade ⇒ immutable forever). A trailing `__gap` reserves slots for safe future storage
///         appends. NOTE: `router` and `sessionGrant` are no longer Solidity `immutable`s — an
///         upgradeable contract cannot read immutables (they live in the implementation's bytecode, not
///         the proxy's storage) — so they are plain storage set ONCE in {initialize} and never mutated.
contract Access0x1Bookings is
    IAccess0x1Bookings,
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    /// @notice The floor on a reservation's hold window. A `holdSecs` below this reverts at {reserve},
    ///         so a HELD slot is ALWAYS un-expirable for at least this long. This closes the
    ///         slot-cycling griefing vector (audit O-2): a zero/too-small hold would otherwise be
    ///         immediately expirable in the same (or the very next) block, letting an attacker reserve
    ///         and instantly expire a merchant's slots in a tight loop to keep the calendar churning.
    ///         The minimum guarantees a genuine, payer-protecting hold window before {expireHold} can
    ///         ever fire (and {expireHold} is itself authorization-gated below).
    uint64 public constant MIN_HOLD_SECS = 60;

    /// @notice The audited money spine the release/fee legs flow through (fee-split + in-tx pricing).
    /// @dev    Set ONCE in {initialize} and never mutated (the upgradeable equivalent of `immutable` —
    ///         an upgradeable contract cannot use Solidity `immutable`s, which read from the impl
    ///         bytecode rather than the proxy's storage).
    Access0x1Router public router;

    /// @notice The optional manage-token authority: a payer may open a scoped session delegating a
    ///         relayer to {cancelWithSession} their own booking without full wallet auth. `address(0)`
    ///         disables the relayed-cancel path entirely (payer/merchant-owner cancel still work).
    /// @dev    Set ONCE in {initialize} and never mutated (see {router} for why it is not `immutable`).
    ISessionGrant public sessionGrant;

    /// @notice reservationId ⇒ the reservation record.
    mapping(uint256 id => Reservation reservation) private _reservations;

    /// @notice reservationId ⇒ the opaque slotKey it occupies. Stored so a terminal transition (which
    ///         only carries the id) can free the slot. Immutable after {reserve}.
    mapping(uint256 id => bytes32 slotKey) private _slotKeyOf;

    /// @notice (merchantId, slotKey) ⇒ the reservation id occupying that merchant's slot. A slot is
    ///         "occupied" only while its reservation is HELD or CONFIRMED; a terminal transition clears
    ///         it back to 0 so the slot is reusable. 0 is the free sentinel (reservation ids start at 1).
    ///
    ///         TENANCY ISOLATION (security): occupancy is namespaced BY MERCHANT. `slotKey` is a public,
    ///         deterministic, caller-supplied slot identity, so a GLOBAL `slotKey ⇒ id` map would let an
    ///         attacker — who can register their OWN merchant for gas (permissionless registry) and
    ///         reserve permissionlessly — pin `occupant[victimSlotKey]` under their own merchant with a
    ///         ~free, near-unbounded hold, permanently DoSing the VICTIM merchant's slot (whose real
    ///         customers would then revert `SlotTaken` with no on-chain recourse). Keying by
    ///         (merchantId, slotKey) keeps each merchant's calendar independent — two merchants may hold
    ///         the same `slotKey` at once, and neither can touch the other's occupancy.
    mapping(uint256 merchantId => mapping(bytes32 slotKey => uint256 reservationId)) public
        occupant;

    /// @notice token ⇒ the total token amount escrowed across all live reservations. The conservation
    ///         anchor: it equals the contract's ERC-20 balance of `token` and the sum of live
    ///         `escrowAmount`s. Incremented on {reserve}, decremented on every release/refund.
    mapping(address token => uint256 amount) private _escrowedOf;

    /// @notice account ⇒ token ⇒ refund queued after a failed push. Pull-pattern: the owed party (or a
    ///         keeper on their behalf) claims via {claimRefund}; a refund can never be lost or blocked.
    mapping(address account => mapping(address token => uint256 amount)) private _refundRescue;

    /// @notice payer ⇒ relayer ⇒ approved to {cancelWithSession} this payer's bookings. A SECOND,
    ///         contract-scoped consent gate on top of the live-session check: a generic SessionGrant
    ///         spend-session (the headline agent-budget delegation) must NOT double as authority to
    ///         cancel a payer's reservations. The payer opts a relayer in via {setCancelRelayer}; an
    ///         un-approved relayer holding a live session is rejected. Set by the payer only.
    mapping(address payer => mapping(address relayer => bool approved)) public
        approvedCancelRelayer;

    /// @notice clientNonce ⇒ consumed. The on-chain idempotency guard: a replayed {reserve} reverts.
    mapping(bytes32 clientNonce => bool used) public nonceUsed;

    /// @notice The id assigned to the next {reserve}. Starts at 1, so 0 is the unset/free sentinel.
    uint256 public nextReservationId;

    /// @dev Reserved storage slots so future versions can APPEND new state without shifting the layout
    ///      above (UUPS storage-collision safety). Each new variable added in a later version consumes
    ///      one slot from the head of this gap; shrink `__gap` by exactly the number of slots added so
    ///      the total stays 50. NEVER reorder or insert a variable above this gap — only append.
    uint256[50] private __gap;

    /// @dev The implementation is the logic half of a UUPS pair; its OWN storage is never used in
    ///      production (the proxy holds state). `_disableInitializers()` burns the implementation's
    ///      initializer so it can never be initialized — and therefore never owned or upgraded —
    ///      directly, closing the classic uninitialized-implementation takeover. Runs at
    ///      implementation-deploy time.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time initializer — the constructor-replacement for the proxy. Wires the admin
    ///         (upgrade-admin) owner and the two composed singletons, and seeds the reservation
    ///         counter. Guarded by `initializer`, so it runs exactly once per proxy; the typical deploy
    ///         is `new ERC1967Proxy(impl, abi.encodeCall(initialize, ...))`.
    /// @dev    Wires every base in inheritance order: Ownable + its 2-step extension and the reentrancy
    ///         guard. `initialOwner` becomes the UPGRADE ADMIN (the `Ownable2Step` owner); it must be
    ///         non-zero (`__Ownable_init` reverts on zero). Then the old constructor body runs verbatim.
    /// @param initialOwner  The admin (Ownable2Step) — burner at the event, multisig in prod. Holds NO
    ///                       authority over any escrow or refund; the admin surface is intentionally
    ///                       empty beyond ownership (the contract is non-custodial).
    /// @param router_        The Access0x1Router that prices and fee-splits the release/fee legs.
    /// @param sessionGrant_  The SessionGrant manage-token authority, or `address(0)` to disable the
    ///                       relayed-cancel path.
    function initialize(address initialOwner, address router_, address sessionGrant_)
        external
        initializer
    {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        // No `__UUPSUpgradeable_init()`: in OZ 5.x `UUPSUpgradeable` re-exports the non-upgradeable
        // contract (it holds no initializable storage), so there is no such initializer to call.

        if (router_ == address(0)) revert Access0x1Bookings__ZeroAddress();
        router = Access0x1Router(router_);
        // sessionGrant_ == address(0) is a DELIBERATE sentinel ("no relayed cancels"); not an error.
        sessionGrant = ISessionGrant(sessionGrant_);
        nextReservationId = 1;
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Bookings
    function reservationOf(uint256 id) external view returns (Reservation memory) {
        return _reservations[id];
    }

    /// @inheritdoc IAccess0x1Bookings
    function isSlotFree(uint256 merchantId, bytes32 slotKey) external view returns (bool) {
        return occupant[merchantId][slotKey] == 0;
    }

    /// @inheritdoc IAccess0x1Bookings
    function escrowedOf(address token) external view returns (uint256) {
        return _escrowedOf[token];
    }

    /// @inheritdoc IAccess0x1Bookings
    function refundRescueOf(address account, address token) external view returns (uint256) {
        return _refundRescue[account][token];
    }

    /// @notice The opaque slotKey reservation `id` occupies (0 if it never existed).
    /// @param id The reservation id.
    /// @return The slotKey.
    function slotKeyOf(uint256 id) external view returns (bytes32) {
        return _slotKeyOf[id];
    }

    /*//////////////////////////////////////////////////////////////
                                 RESERVE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Bookings
    /// @dev CEI + `nonReentrant`. Checks (token set, non-zero deposit, hold long enough, slot moment in
    ///      the future, merchant exists, nonce fresh, slot free) → effects (write the immutable record +
    ///      snapshot, occupy the slot, consume the nonce, bump the escrow ledger) → interaction (pull the
    ///      deposit in, verifying the balance delta to reject fee-on-transfer / rebasing tokens). The
    ///      deposit token amount is quoted from USD via the Router IN-TX (OracleLib staleness guard), so a
    ///      stale feed reverts the reserve rather than escrowing a bad amount.
    function reserve(
        uint256 merchantId,
        bytes32 slotKey,
        uint64 slotTimestamp,
        address token,
        uint256 depositUsd8,
        uint256 balanceDueUsd8,
        Policy calldata policy,
        uint64 holdSecs,
        bytes32 clientNonce
    ) external nonReentrant returns (uint256 id) {
        if (token == address(0)) revert Access0x1Bookings__ZeroAddress();
        if (depositUsd8 == 0) revert Access0x1Bookings__ZeroAmount();
        // A hold shorter than MIN_HOLD_SECS (including 0) is rejected: it would be immediately/near-
        // immediately expirable, enabling reserve→expire slot-cycling griefing of the calendar (O-2).
        if (holdSecs < MIN_HOLD_SECS) {
            revert Access0x1Bookings__HoldTooShort(holdSecs, MIN_HOLD_SECS);
        }
        // `slotTimestamp` is opaque, but a ZERO value floors `_windowStart` at the epoch, forcing EVERY
        // cancel into the late branch (a late fee on a free-cancel booking, or — with `lateFeeUsd8 == 0`
        // — a permanently BLOCKED cancel trapping a CONFIRMED escrow). Rejecting zero keeps the
        // cancel-window math well-formed; a non-zero past slot is left to the merchant's chosen policy.
        if (slotTimestamp == 0) {
            revert Access0x1Bookings__ZeroSlotTimestamp();
        }
        _requireMerchantExists(merchantId);
        if (nonceUsed[clientNonce]) revert Access0x1Bookings__NonceUsed(clientNonce);
        // Occupancy is namespaced by merchant (tenancy isolation): this only blocks a double-book of
        // THIS merchant's slot, never another merchant's identical slotKey.
        uint256 occupiedBy = occupant[merchantId][slotKey];
        if (occupiedBy != 0) revert Access0x1Bookings__SlotTaken(slotKey, occupiedBy);

        // Price the deposit USD→token IN-TX (allowlist + feed + staleness all enforced by quote).
        uint256 escrowAmount = router.quote(merchantId, token, depositUsd8);

        id = nextReservationId++;
        uint64 holdExpiresAt = uint64(block.timestamp) + holdSecs;

        // Effects: the whole record is immutable except `status`; the policy is snapshotted here and
        // never mutated again.
        _reservations[id] = Reservation({
            merchantId: merchantId,
            payer: msg.sender,
            token: token,
            escrowAmount: escrowAmount,
            depositUsd8: depositUsd8,
            balanceDueUsd8: balanceDueUsd8,
            holdExpiresAt: holdExpiresAt,
            slotTimestamp: slotTimestamp,
            policy: policy,
            status: RStatus.HELD
        });
        _slotKeyOf[id] = slotKey;
        occupant[merchantId][slotKey] = id;
        nonceUsed[clientNonce] = true;
        _escrowedOf[token] += escrowAmount;

        emit SlotHeld(id, merchantId, msg.sender, slotKey, token, escrowAmount, holdExpiresAt);

        // Interaction: pull the deposit in and verify the balance delta (reject fee-on-transfer).
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), escrowAmount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        if (received != escrowAmount) {
            revert Access0x1Bookings__FeeOnTransferToken(escrowAmount, received);
        }
    }

    /*//////////////////////////////////////////////////////////////
                             CONFIRM / COMPLETE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Bookings
    /// @dev CEI + `nonReentrant`. HELD→CONFIRMED, merchant-owner only. A
    ///      PURE state transition: the operator commits to honor the slot, but the deposit stays
    ///      ESCROWED so it remains available as cancel/no-show collateral. No money moves here. The
    ///      slot stays occupied (CONFIRMED still blocks it) until {complete}/{cancel}/{markNoShow}. The
    ///      deposit is RELEASED to the operator at {complete} (service rendered) — this is the
    ///      "deposit held, release-or-refund" model: confirm is intent, complete is settlement.
    function confirm(uint256 id) external nonReentrant {
        Reservation storage r = _reservations[id];
        _requireStatus(id, r.status, RStatus.HELD);
        _requireMerchantOwner(r.merchantId);

        r.status = RStatus.CONFIRMED;
        emit Confirmed(id);
    }

    /// @inheritdoc IAccess0x1Bookings
    /// @dev CONFIRMED→COMPLETED, merchant-owner only. RELEASES the held deposit to the operator through
    ///      the Router fee-split: the snapshotted `depositUsd8` is RE-QUOTED at complete time (the
    ///      fee-application-time oracle read), CLAMPED so the routed gross never exceeds the held escrow,
    ///      and routed through {Access0x1Router.payToken} — `net→payout` + `fee→treasury` is the
    ///      Router's audited split (never re-derived here). Any escrow surplus (re-quoted gross below
    ///      the escrow, or quote-inversion dust) is refunded to the payer, so the contract is left
    ///      holding ~zero of this reservation's token (exact conservation). A `balanceDueUsd8` remainder
    ///      is settled off-chain or in a separate leg — never pre-collected (zero custody). CEI +
    ///      `nonReentrant`.
    function complete(uint256 id) external nonReentrant {
        Reservation storage r = _reservations[id];
        _requireStatus(id, r.status, RStatus.CONFIRMED);
        _requireMerchantOwner(r.merchantId);

        uint256 escrow = r.escrowAmount;
        r.status = RStatus.COMPLETED;
        _vacate(id);

        // Free the full escrow from the ledger first (CEI: ledger written before any external call).
        _release(r.token, escrow);

        // Route the deposit through the fee-split, clamped to the escrow; `settled` is what the Router
        // actually pulled, so the refund captures both price-drift surplus and quote-inversion dust.
        uint256 settled = _settleThroughRouter(r.merchantId, r.token, r.depositUsd8, escrow);
        uint256 refund = escrow - settled;
        if (refund > 0) _payoutOrQueue(r.payer, r.token, refund);

        emit Completed(id, settled, refund, r.balanceDueUsd8);
    }

    /*//////////////////////////////////////////////////////////////
                          EXPIRE / CANCEL / NO-SHOW
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Bookings
    /// @dev Callable by the PAYER or the MERCHANT OWNER after the hold deadline while HELD — NOT
    ///      permissionless (audit O-2). Restricting it to the two parties with standing (the payer
    ///      reclaiming their deposit, or the operator freeing their own slot) removes the slot-cycling
    ///      griefing surface where a third party churned a merchant's calendar by expiring holds the
    ///      instant they lapsed. The refund itself is unconditional once authorized: the full escrow
    ///      goes back to the payer (failed push → pull-map, NEVER blocked) and the slot frees. CEI +
    ///      `nonReentrant`.
    function expireHold(uint256 id) external nonReentrant {
        Reservation storage r = _reservations[id];
        _requireStatus(id, r.status, RStatus.HELD);
        if (msg.sender != r.payer && msg.sender != _merchantOwner(r.merchantId)) {
            revert Access0x1Bookings__NotAuthorized(id, msg.sender);
        }
        if (block.timestamp < r.holdExpiresAt) {
            revert Access0x1Bookings__HoldNotExpired(id, r.holdExpiresAt, block.timestamp);
        }

        uint256 refund = r.escrowAmount;
        r.status = RStatus.EXPIRED;
        _vacate(id);
        _release(r.token, refund);
        _payoutOrQueue(r.payer, r.token, refund);

        emit HoldExpired(id, r.payer, refund);
    }

    /// @inheritdoc IAccess0x1Bookings
    /// @dev Cancellable by the payer or the merchant owner. Reads the IMMUTABLE policy snapshot: a
    ///      cancel before `slotTimestamp - cancelWindowSecs` is a FULL refund; inside the window the
    ///      `lateFeeUsd8` is RE-QUOTED to token at cancel time and routed to the operator through the
    ///      fee-split, with `escrow - lateFee` refunded to the payer; a `lateFeeUsd8 == 0` policy BLOCKS
    ///      a late cancel (reverts {CancellationWindowActive}). The fee taken is clamped to the escrow,
    ///      so the payer refund is never negative. CEI + `nonReentrant`.
    function cancel(uint256 id, ActorType actorType) external nonReentrant {
        Reservation storage r = _reservations[id];
        if (msg.sender != r.payer && msg.sender != _merchantOwner(r.merchantId)) {
            revert Access0x1Bookings__NotAuthorized(id, msg.sender);
        }
        _cancel(id, r, actorType);
    }

    /// @inheritdoc IAccess0x1Bookings
    /// @dev A pure consent toggle the PAYER sets for THEMSELVES — `msg.sender` is the payer granting (or
    ///      revoking) `relayer` the right to {cancelWithSession} bookings the caller paid for. No
    ///      reservation is touched and no money moves, so the check is just "the caller speaks only for
    ///      its own (payer ⇒ relayer) bit"; a third party can never approve a relayer on someone else's
    ///      behalf. This is the contract-scoped half of the relayed-cancel authority (see
    ///      {approvedCancelRelayer}) — required IN ADDITION to a live SessionGrant session.
    function setCancelRelayer(address relayer, bool approved) external {
        approvedCancelRelayer[msg.sender][relayer] = approved;
        emit CancelRelayerSet(msg.sender, relayer, approved);
    }

    /// @notice Cancel a reservation via a SessionGrant manage-token: a relayer the PAYER both opened a
    ///         live session for (delegate == caller) AND opted in via {setCancelRelayer} may cancel on
    ///         the payer's behalf without the payer's wallet. The session is read-only here (no budget
    ///         is spent — a cancel moves no new money, only resolves the existing escrow), so the
    ///         authority is the AND of two payer consents: a live, non-revoked session whose recomputed
    ///         id binds to (payer, caller, nonce), AND `approvedCancelRelayer[payer][caller]`.
    /// @dev    TWO gates so a generic agent-budget session can't double as cancel authority (a confused
    ///         deputy): the contract-scoped {approvedCancelRelayer} allowlist is a SEPARATE consent the
    ///         payer grants for THIS purpose, checked alongside the live-session check. Reverts
    ///         {NotAuthorized} if no SessionGrant is configured, the relayer is not allowlisted, or the
    ///         session is not the payer's live manage-token. CEI + `nonReentrant`.
    /// @param id        The reservation id.
    /// @param ownerNonce The nonce the payer opened the session with (binds the session id to the payer).
    /// @param actorType The actor label recorded in the event (does not affect the refund math).
    function cancelWithSession(uint256 id, uint256 ownerNonce, ActorType actorType)
        external
        nonReentrant
    {
        Reservation storage r = _reservations[id];
        if (r.status == RStatus.NONE) revert Access0x1Bookings__ReservationNotFound(id);
        if (address(sessionGrant) == address(0)) {
            revert Access0x1Bookings__NotAuthorized(id, msg.sender);
        }
        // Contract-scoped consent: the payer must have separately allowlisted this relayer FOR CANCELS,
        // so a generic spend-session delegate can't repurpose its budget authority into a cancel.
        if (!approvedCancelRelayer[r.payer][msg.sender]) {
            revert Access0x1Bookings__NotAuthorized(id, msg.sender);
        }
        // Recompute the session id from (payer, caller, nonce). The id is a pure function of the
        // triple, so a caller cannot forge a session that binds to a payer they are not the delegate
        // of: the session must EXIST with the caller as delegate AND still be live.
        bytes32 sessionId = sessionGrant.computeSessionId(r.payer, msg.sender, ownerNonce);
        ISessionGrant.Session memory s = sessionGrant.sessionOf(sessionId);
        bool live = s.delegate == msg.sender && !s.revoked && block.timestamp <= s.expiry;
        if (!live) revert Access0x1Bookings__NotAuthorized(id, msg.sender);
        _cancel(id, r, actorType);
    }

    /// @inheritdoc IAccess0x1Bookings
    /// @dev CONFIRMED→NO_SHOW, merchant-owner only. The deposit was held through CONFIRMED (confirm is
    ///      a pure intent transition), so the full escrow is available here as the no-show collateral.
    ///      Keeps the no-show fee (RE-QUOTED to token at no-show time and routed to the operator through
    ///      the fee-split) and refunds the remainder to the payer. CEI + `nonReentrant`.
    function markNoShow(uint256 id) external nonReentrant {
        Reservation storage r = _reservations[id];
        _requireStatus(id, r.status, RStatus.CONFIRMED);
        _requireMerchantOwner(r.merchantId);

        uint256 escrow = r.escrowAmount;
        uint256 feeTarget = _feeToken(r.merchantId, r.token, r.policy.noShowFeeUsd8, escrow);

        r.status = RStatus.NO_SHOW;
        _vacate(id);
        _release(r.token, escrow);

        // `fee` is what the Router actually took; refund the exact remainder (exact conservation).
        uint256 fee = _routeFeeThroughRouter(r.merchantId, r.token, feeTarget);
        uint256 refund = escrow - fee; // fee ≤ feeTarget ≤ escrow by clamp, so this never underflows
        if (refund > 0) _payoutOrQueue(r.payer, r.token, refund);

        emit NoShow(id, refund, fee);
    }

    /*//////////////////////////////////////////////////////////////
                                  RESCUE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Bookings
    /// @dev Pure pull-pattern. CEI + `nonReentrant`: the credit is zeroed BEFORE the transfer, so a
    ///      re-entrant claimer finds nothing owed. A refund parked here can always be withdrawn — no
    ///      party can block it.
    function claimRefund(address token) external nonReentrant {
        uint256 amount = _refundRescue[msg.sender][token];
        if (amount == 0) revert Access0x1Bookings__NothingToClaim(token);
        _refundRescue[msg.sender][token] = 0; // effect before interaction
        emit RefundClaimed(msg.sender, token, amount);
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                 INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @notice Authorize a UUPS upgrade. Restricted to the contract `owner` (the upgrade admin) — the
    ///         single gate {upgradeToAndCall} consults before swapping the implementation.
    /// @dev    Empty body: the `onlyOwner` modifier IS the policy. Once `renounceOwnership()` sets the
    ///         owner to address(0), every call here reverts, so the implementation becomes permanently
    ///         immutable (the on-chain "freeze"). `newImplementation` is intentionally unnamed — no
    ///         per-target allow-listing; the owner is fully trusted to vet the target off-chain.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }

    /// @dev Shared cancel body (used by {cancel} and {cancelWithSession}). The status must be HELD or
    ///      CONFIRMED — both hold escrow. Free policy outside the window; clamped late fee inside it;
    ///      blocked when `lateFeeUsd8 == 0` inside the window.
    function _cancel(uint256 id, Reservation storage r, ActorType actorType) private {
        RStatus status = r.status;
        if (status != RStatus.HELD && status != RStatus.CONFIRMED) {
            // Surface a HELD "expected" hint for a terminal/unknown reservation.
            revert Access0x1Bookings__WrongStatus(id, status, RStatus.HELD);
        }

        uint256 escrow = r.escrowAmount;
        uint256 feeTarget;
        // Cancel window: free before `slotTimestamp - cancelWindowSecs`, late at/after it.
        if (block.timestamp >= _windowStart(r.slotTimestamp, r.policy.cancelWindowSecs)) {
            if (r.policy.lateFeeUsd8 == 0) {
                revert Access0x1Bookings__CancellationWindowActive(id);
            }
            feeTarget = _feeToken(r.merchantId, r.token, r.policy.lateFeeUsd8, escrow);
        }

        r.status = RStatus.CANCELLED;
        _vacate(id);
        _release(r.token, escrow);

        // The fee leg routes through the fee-split; `fee` is what the Router ACTUALLY took, so the
        // refund is the exact remainder and the contract is left holding ~zero (exact conservation).
        uint256 fee = _routeFeeThroughRouter(r.merchantId, r.token, feeTarget);
        uint256 refund = escrow - fee; // fee ≤ feeTarget ≤ escrow by clamp
        if (refund > 0) _payoutOrQueue(r.payer, r.token, refund);

        emit Cancelled(id, actorType, refund, fee);
    }

    /// @dev The token fee for a USD-priced policy fee, RE-QUOTED at action time (drift cannot be gamed)
    ///      and CLAMPED to the escrow so the fee can never exceed what is held (the payer refund is
    ///      therefore never negative). A zero USD fee yields zero token (no quote, no revert).
    /// @dev REFUND-NEVER-BLOCKED. The re-quote is wrapped: a STALE/dead/zero-price feed (or a token
    ///      de-allowlisted between reserve and resolution) makes {Access0x1Router.quote} REVERT. If we
    ///      let that bubble, the oracle outage would brick the cancel/no-show — and therefore the
    ///      payer's refund (law #5). Instead a failed re-quote yields a ZERO fee target: the operator
    ///      takes nothing and the FULL escrow flows back to the payer. The fee leg is best-effort; the
    ///      refund is unconditional. (`reserve` deliberately does NOT do this — you must never escrow
    ///      against a bad price; only the resolution/refund paths are made oracle-fault-tolerant.)
    function _feeToken(uint256 merchantId, address token, uint256 feeUsd8, uint256 escrow)
        private
        view
        returns (uint256 feeToken)
    {
        if (feeUsd8 == 0) return 0;
        (uint256 quoted, bool ok) = _trySafeQuote(merchantId, token, feeUsd8);
        if (!ok) return 0; // oracle outage / de-allowlist → take no fee, refund everything
        feeToken = quoted > escrow ? escrow : quoted;
    }

    /// @dev {Access0x1Router.quote} wrapped so a revert (stale/zero price, de-allowlisted token,
    ///      missing feed) is surfaced as `ok == false` instead of bubbling and bricking a refund. Used
    ///      ONLY on the resolution legs where law #5 requires the refund to proceed regardless of the
    ///      oracle's health; the fee/release simply takes nothing when the price cannot be read.
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

    /// @dev Settle a USD-priced deposit leg through the Router fee-split, NEVER re-deriving the split.
    ///      The deposit is RE-QUOTED at action time; the routed gross is CLAMPED to the held `escrow`
    ///      (so the Router's pull never exceeds the contract's backing — a confirm cannot revert just
    ///      because the token cheapened since reserve). Returns the token amount ACTUALLY routed
    ///      through the fee-split (measured, so the caller can refund the exact remainder).
    /// @return settled The token amount the Router actually pulled and split.
    function _settleThroughRouter(uint256 merchantId, address token, uint256 usd8, uint256 escrow)
        private
        returns (uint256 settled)
    {
        // REFUND-NEVER-BLOCKED: a stale/dead oracle (or a de-allowlisted token) makes the re-quote
        // revert; rather than bricking {complete} and stranding the deposit, treat it as "cannot price
        // the release" — route nothing, so the FULL escrow refunds to the payer (law #5).
        (uint256 grossNow, bool ok) = _trySafeQuote(merchantId, token, usd8);
        if (!ok) return 0;
        uint256 target = grossNow > escrow ? escrow : grossNow;
        settled = _routeFeeThroughRouter(merchantId, token, target);
    }

    /// @dev Route up to `amount` of `token` to merchant `merchantId` through the Router fee-split,
    ///      NEVER re-deriving the split, and return the amount the Router ACTUALLY pulled (so the caller
    ///      refunds any remainder and the contract is left holding ~zero of this token). The Router's
    ///      `payToken` is USD-priced: it re-quotes a USD value and pulls the re-quoted gross from THIS
    ///      contract. To route a token amount we invert {Access0x1Router.quote} to the USD-8dp value
    ///      whose quote is ≤ `amount` (a price READ via the public view — not a copy of the fee-split),
    ///      then approve and call `payToken`. The actual pull is measured by the balance delta; the
    ///      residual approval is reset to 0 so no allowance dangles. The Router's PaymentReceived split
    ///      proves `net + fee == gross` for this leg.
    /// @dev REFUND-NEVER-BLOCKED. The `payToken` call is wrapped in try/catch: if the Router rejects
    ///      the leg (e.g. the merchant was deactivated, or the token was de-allowlisted, between reserve
    ///      and resolution), the fee leg simply takes NOTHING — `pulled` is 0, the dangling approval is
    ///      reset, and the FULL escrow flows back to the payer as refund. An operator config change can
    ///      never strand a payer's deposit or block a cancel/expire/no-show refund (law #5).
    /// @return pulled The token amount the Router pulled and split (≤ `amount`; 0 if the leg failed).
    function _routeFeeThroughRouter(uint256 merchantId, address token, uint256 amount)
        private
        returns (uint256 pulled)
    {
        if (amount == 0) return 0;
        uint256 usd8 = _tokenToUsd8(merchantId, token, amount);
        if (usd8 == 0) {
            // Below one USD-8dp unit of resolution: no USD value quotes to a positive token amount, so
            // route nothing (a zero-USD payToken would revert). The dust stays on the contract and the
            // caller refunds it as part of the remainder.
            return 0;
        }
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).forceApprove(address(router), amount);
        // slither-disable-next-line reentrancy-events,reentrancy-benign
        try router.payToken(merchantId, token, usd8, bytes32(uint256(uint160(token)))) {
            // The router pulled (balBefore − balAfter) out of this contract.
            pulled = balBefore - IERC20(token).balanceOf(address(this));
        } catch {
            // The fee leg failed: take nothing, reset the approval, let the caller refund it all.
            pulled = 0;
        }
        IERC20(token).forceApprove(address(router), 0);
    }

    /// @dev Invert {Access0x1Router.quote}: given a token `amount`, return the USD-8dp value whose
    ///      quote is ≤ `amount`, so a subsequent `payToken(usd8)` pulls no more than the contract holds.
    ///      `quote` is linear in usd8 (`tokenAmount = usd8 · feed/decimals factor`, rounded UP), so we
    ///      probe the token-per-dollar ceiling with `quote(1e8)` (=$1.00) and divide, rounding DOWN.
    ///      Returns 0 when `amount` is below one dollar's worth of token (caller treats it as dust).
    function _tokenToUsd8(uint256 merchantId, address token, uint256 amount)
        private
        view
        returns (uint256 usd8)
    {
        // Wrapped for the same law-#5 reason as the callers: if the oracle cannot be read, route
        // nothing (the caller refunds the full remainder) rather than bricking the resolution.
        (uint256 tokenPerDollar, bool ok) = _trySafeQuote(merchantId, token, 1e8); // ceil(tokens/$1)
        if (!ok || tokenPerDollar == 0) return 0;
        // Round DOWN: floor(amount · 1e8 / tokenPerDollar). The re-quote of this usd8 is then ≤ amount.
        usd8 = Math.mulDiv(amount, 1e8, tokenPerDollar, Math.Rounding.Floor);
    }

    /// @dev Decrement the escrow ledger for `token` by `amount`. Called BEFORE any external transfer of
    ///      that escrow (CEI), so the conservation invariant (`balance == Σ live escrow`) holds at
    ///      every external-call boundary.
    function _release(address token, uint256 amount) private {
        _escrowedOf[token] -= amount;
    }

    /// @dev Free the slot a terminal reservation occupied, so the slotKey can be reused. Reads the
    ///      stored (merchantId, slotKey) by id and clears that merchant's occupant entry. Idempotent for
    ///      a never-occupied id.
    function _vacate(uint256 id) private {
        uint256 merchantId = _reservations[id].merchantId;
        bytes32 slotKey = _slotKeyOf[id];
        // Only clear if this reservation still owns the slot (it always does at a terminal transition,
        // but the guard makes the write safe against any future re-entrancy on slot reuse).
        if (occupant[merchantId][slotKey] == id) occupant[merchantId][slotKey] = 0;
    }

    /// @dev Push `amount` of `token` to `to`, or queue it to the pull-map on failure. A refund/surplus
    ///      must never be lost or block a lifecycle transition (law #5): a recipient whose transfer
    ///      fails (a reverting ERC-777 hook, a blocklisted address, etc.) is credited to
    ///      {refundRescueOf} and claims later via {claimRefund}. CEI: this runs AFTER all status/ledger
    ///      effects.
    /// @dev LENGTH-SAFE, like SafeERC20: a raw `try transfer() returns (bool)` would ABI-decode the
    ///      return data in the SUCCESS path (not the catch), so a USDT-style token that moves value but
    ///      returns NO data — a token class this product supports (`reserve`/`claimRefund` use
    ///      SafeERC20) — makes the decode revert the WHOLE transition, bricking the booking and locking
    ///      the escrow (the opposite of never-blocked). Instead we low-level `call` and inspect the
    ///      return data ourselves: empty return-data is a success (USDT), a 32-byte `true` is a success,
    ///      and only a genuine revert or a `false`-returning liar queues to the pull-map. So every
    ///      refund/surplus push either pays out or queues — it NEVER reverts the lifecycle transition.
    // slither-disable-next-line reentrancy-events
    function _payoutOrQueue(address to, address token, uint256 amount) private {
        if (amount == 0) return;
        // slither-disable-next-line low-level-calls
        (bool callOk, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        bool transferOk =
            callOk && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
        if (!transferOk) _refundRescue[to][token] += amount;
    }

    /// @dev `slotTimestamp - cancelWindowSecs`, floored at 0 so an early/zero slot time never
    ///      underflows (the window simply starts at the epoch — every cancel is then "late").
    function _windowStart(uint64 slotTimestamp, uint32 cancelWindowSecs)
        private
        pure
        returns (uint256)
    {
        return slotTimestamp > cancelWindowSecs ? slotTimestamp - cancelWindowSecs : 0;
    }

    /// @dev Revert unless merchant `merchantId` exists on the Router (owner != address(0)).
    function _requireMerchantExists(uint256 merchantId) private view {
        if (_merchantOwner(merchantId) == address(0)) {
            revert Access0x1Bookings__MerchantNotFound(merchantId);
        }
    }

    /// @dev Revert unless `msg.sender` is the Router owner of `merchantId`.
    function _requireMerchantOwner(uint256 merchantId) private view {
        address owner_ = _merchantOwner(merchantId);
        if (owner_ == address(0)) revert Access0x1Bookings__MerchantNotFound(merchantId);
        if (msg.sender != owner_) {
            revert Access0x1Bookings__NotMerchantOwner(merchantId, msg.sender);
        }
    }

    /// @dev Revert unless reservation `id`'s status equals `required` (NotFound for an unset id).
    function _requireStatus(uint256 id, RStatus current, RStatus required) private pure {
        if (current == RStatus.NONE) revert Access0x1Bookings__ReservationNotFound(id);
        if (current != required) revert Access0x1Bookings__WrongStatus(id, current, required);
    }

    /// @dev Read the Router owner of `merchantId` (the `owner` field of the Merchant record).
    function _merchantOwner(uint256 merchantId) private view returns (address owner_) {
        (, owner_,,,,) = router.merchants(merchantId);
    }
}
