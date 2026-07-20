// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IAccess0x1Bookings
/// @author Access0x1
/// @notice Surface for Access0x1Bookings — a vertical-agnostic deposit-escrow primitive with a
///         GUARANTEED, never-blockable refund. A caller holds a USD-priced deposit against a unique,
///         opaque `slotKey` with a hold deadline, then the booking resolves through one of the
///         lifecycle transitions: confirm (release to the operator via the Router fee-split), expire
///         (refund the payer), cancel (full / late-fee / blocked-inside-window per an IMMUTABLE policy
///         snapshot), or no-show (keep the operator's fee, refund the remainder). A refund is NEVER
///         blocked: a failed push lands in a pull-map the owed party (or a keeper) claims later.
/// @dev    COMPOSES the audited money spine, never re-deriving it: the deposit escrow is a fully-backed
///         ledger (zero custody beyond the live escrow); the confirm/complete RELEASE flows through
///         `Access0x1Router` so `net + fee == gross` is proven by the Router's own fuzz invariants;
///         every USD→token conversion is read in-tx via the Router's `quote` (OracleLib staleness
///         guard) at reserve AND at fee-application time, so price drift cannot be gamed. `slotKey`,
///         `slotTimestamp`, and `clientNonce` are opaque — a booking app, a rental, a ticketed seat,
///         or a partner's vertical all reuse the SAME contract.
interface IAccess0x1Bookings {
    // ──────────────────────── types ────────────────────────

    /// @notice The reservation lifecycle. `NONE` is the unset sentinel (a reservation id that was
    ///         never created). HELD and CONFIRMED are the two OCCUPYING states (they hold escrow and
    ///         block the slot); COMPLETED / EXPIRED / CANCELLED / NO_SHOW are terminal and release it.
    enum RStatus {
        NONE,
        HELD,
        CONFIRMED,
        COMPLETED,
        EXPIRED,
        CANCELLED,
        NO_SHOW
    }

    /// @notice Who is acting on a `cancel` — recorded in the event for off-chain reconciliation. Has
    ///         NO effect on the refund math (the immutable policy snapshot alone decides the split); it
    ///         is an audit label only, so a relayer cannot change the outcome by claiming to be someone.
    enum ActorType {
        PAYER,
        MERCHANT
    }

    /// @notice The cancellation policy, SNAPSHOTTED once at `reserve` and immutable thereafter — an
    ///         operator can never retroactively raise the fees on a live booking.
    /// @param cancelWindowSecs Seconds before `slotTimestamp` inside which a cancel is "late". A cancel
    ///                         at `now < slotTimestamp - cancelWindowSecs` carries no fee; at/after it the
    ///                         late policy applies.
    /// @param lateFeeUsd8      The USD (8-dp) late-cancellation fee. `0` means a late cancel is BLOCKED
    ///                         (reverts `CancellationWindowActive`) — the "no late cancellations" policy.
    /// @param noShowFeeUsd8    The USD (8-dp) no-show fee the operator keeps when a payer never shows.
    struct Policy {
        uint32 cancelWindowSecs;
        uint256 lateFeeUsd8;
        uint256 noShowFeeUsd8;
    }

    /// @notice One reservation. `merchantId`, `payer`, `token`, `escrowAmount`, `balanceDueUsd8`,
    ///         `slotTimestamp`, and `policy` are written once at `reserve` and immutable; only `status`
    ///         (and the slot occupancy map) ever changes after creation.
    /// @param merchantId     The Router merchant the release pays (fee-split target + owner auth).
    /// @param payer          The address that funded the deposit and is refunded.
    /// @param token          The escrowed ERC-20 (must be an allowlisted Router pay-in token).
    /// @param escrowAmount   The token amount held (the deposit, quoted from `depositUsd8` at reserve).
    /// @param depositUsd8    The USD (8-dp) deposit price snapshotted at reserve (re-quoted at release).
    /// @param balanceDueUsd8 The in-person remainder asserted at service time; `0` for a full deposit.
    /// @param holdExpiresAt  The unix second after which a HELD reservation may be permissionlessly
    ///                       expired.
    /// @param slotTimestamp  The service moment the slot is for (drives the cancel-window math).
    /// @param policy         The immutable cancellation-policy snapshot.
    /// @param status         The current lifecycle state.
    struct Reservation {
        uint256 merchantId;
        address payer;
        address token;
        uint256 escrowAmount;
        uint256 depositUsd8;
        uint256 balanceDueUsd8;
        uint64 holdExpiresAt;
        uint64 slotTimestamp;
        Policy policy;
        RStatus status;
    }

    // ──────────────────────── events ────────────────────────

    /// @notice A slot was held: a deposit was escrowed against `slotKey`.
    /// @param id           The new reservation id.
    /// @param merchantId   The Router merchant.
    /// @param payer        The depositor.
    /// @param slotKey      The opaque slot key now occupied.
    /// @param token        The escrowed token.
    /// @param escrowAmount The token amount escrowed.
    /// @param holdExpiresAt The HELD deadline.
    event SlotHeld(
        uint256 indexed id,
        uint256 indexed merchantId,
        address indexed payer,
        bytes32 slotKey,
        address token,
        uint256 escrowAmount,
        uint64 holdExpiresAt
    );

    /// @notice A reservation was confirmed (HELD→CONFIRMED). A pure intent transition — the deposit
    ///         stays escrowed as cancel/no-show collateral; no money moves until {complete}.
    /// @param id The reservation id.
    event Confirmed(uint256 indexed id);

    /// @notice A confirmed reservation was completed: the held deposit was RELEASED to the operator
    ///         through the Router fee-split. `settled` is the token amount routed; `refunded` is any
    ///         escrow surplus (price-drift / rounding) returned to the payer.
    /// @param id            The reservation id.
    /// @param settled       The token amount routed through the fee-split.
    /// @param refunded      The escrow surplus returned to the payer (0 if none).
    /// @param balanceDueUsd8 The in-person remainder recorded at service time (informational).
    event Completed(uint256 indexed id, uint256 settled, uint256 refunded, uint256 balanceDueUsd8);

    /// @notice A HELD reservation passed its deadline and was expired; the escrow was refunded.
    /// @param id       The reservation id.
    /// @param payer    The refunded depositor.
    /// @param refunded The token amount refunded (or queued to the pull-map on a failed push).
    event HoldExpired(uint256 indexed id, address indexed payer, uint256 refunded);

    /// @notice A reservation was cancelled. `fee` (if any) was routed to the operator through the
    ///         fee-split; `refund` was returned to the payer.
    /// @param id        The reservation id.
    /// @param actorType Who initiated the cancel (audit label only).
    /// @param refund    The token amount refunded to the payer.
    /// @param fee       The token late-fee routed to the operator (0 on a no-fee cancel).
    event Cancelled(uint256 indexed id, ActorType actorType, uint256 refund, uint256 fee);

    /// @notice A reservation was marked a no-show: the no-show fee was kept (routed to the operator)
    ///         and any remainder refunded to the payer.
    /// @param id     The reservation id.
    /// @param refund The token remainder refunded to the payer.
    /// @param fee    The token no-show fee routed to the operator.
    event NoShow(uint256 indexed id, uint256 refund, uint256 fee);

    /// @notice A queued refund was claimed from the pull-map.
    /// @param to     The party that claimed.
    /// @param token  The token claimed.
    /// @param amount The amount claimed.
    event RefundClaimed(address indexed to, address indexed token, uint256 amount);

    // ──────────────────────── errors ────────────────────────

    /// @notice A zero address was supplied where a non-zero one is required.
    error Access0x1Bookings__ZeroAddress();

    /// @notice A zero amount/price was supplied where a positive one is required.
    error Access0x1Bookings__ZeroAmount();

    /// @notice The merchant `id` was never registered on the Router.
    error Access0x1Bookings__MerchantNotFound(uint256 merchantId);

    /// @notice The caller is not the Router owner of merchant `id`.
    error Access0x1Bookings__NotMerchantOwner(uint256 merchantId, address caller);

    /// @notice The caller may not act on reservation `id` (not the payer, the merchant owner, or an
    ///         authorized manage-session delegate).
    error Access0x1Bookings__NotAuthorized(uint256 id, address caller);

    /// @notice `slotKey` is already occupied by an active reservation.
    error Access0x1Bookings__SlotTaken(bytes32 slotKey, uint256 occupiedBy);

    /// @notice `clientNonce` was already used (idempotency / replay guard).
    error Access0x1Bookings__NonceUsed(bytes32 clientNonce);

    /// @notice Reservation `id` does not exist.
    error Access0x1Bookings__ReservationNotFound(uint256 id);

    /// @notice Reservation `id` is not in the state this transition requires.
    error Access0x1Bookings__WrongStatus(uint256 id, RStatus current, RStatus required);

    /// @notice The hold deadline has not yet passed, so the reservation cannot be permissionlessly
    ///         expired.
    error Access0x1Bookings__HoldNotExpired(uint256 id, uint64 holdExpiresAt, uint256 nowTs);

    /// @notice A late cancel was attempted under a policy that blocks late cancellation
    ///         (`lateFeeUsd8 == 0` inside the cancel window).
    error Access0x1Bookings__CancellationWindowActive(uint256 id);

    /// @notice The escrow could not be fully backed: a fee-on-transfer / rebasing token skimmed the
    ///         pull, so the received amount did not match the requested escrow.
    error Access0x1Bookings__FeeOnTransferToken(uint256 expected, uint256 received);

    /// @notice `claimRefund` was called with nothing owed for that token.
    error Access0x1Bookings__NothingToClaim(address token);

    // ──────────────────────── views ────────────────────────

    /// @notice Read a reservation by id.
    /// @param id The reservation id.
    /// @return The full {Reservation} record (zeroed if it never existed).
    function reservationOf(uint256 id) external view returns (Reservation memory);

    /// @notice Whether `slotKey` is available to reserve right now.
    /// @param slotKey The opaque slot key.
    /// @return True if no occupying (HELD/CONFIRMED) reservation holds the slot.
    function isSlotFree(bytes32 slotKey) external view returns (bool);

    /// @notice The token amount currently escrowed across all live reservations for `token`. Equals the
    ///         contract's backing balance of `token` (the conservation invariant).
    /// @param token The escrowed token.
    /// @return The total token amount held in escrow.
    function escrowedOf(address token) external view returns (uint256);

    /// @notice The refund amount queued to `account` in `token` after a failed push.
    /// @param account The owed party.
    /// @param token   The token owed.
    /// @return The claimable amount.
    function refundRescueOf(address account, address token) external view returns (uint256);

    // ──────────────────────── mutating ────────────────────────

    /// @notice Hold a slot by escrowing a USD-priced deposit. Permissionless — anyone may reserve.
    /// @param merchantId    The Router merchant the booking belongs to.
    /// @param slotKey       The opaque slot key (e.g. keccak256 of the vertical's slot identity).
    /// @param slotTimestamp The service moment the slot is for.
    /// @param token         The allowlisted ERC-20 to escrow.
    /// @param depositUsd8   The deposit price in USD (8 decimals).
    /// @param balanceDueUsd8 The in-person remainder asserted at service time; 0 for a full deposit.
    /// @param policy        The cancellation policy to snapshot (immutable after this call).
    /// @param holdSecs      Seconds from now until the hold may be permissionlessly expired.
    /// @param clientNonce   An idempotency key (a replay reverts {NonceUsed}).
    /// @return id           The new reservation id.
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
    ) external returns (uint256 id);

    /// @notice Confirm a HELD reservation: release the escrow to the operator through the Router
    ///         fee-split. Only the merchant owner (or an authorized manage-session relayer) may call.
    /// @param id The reservation id.
    function confirm(uint256 id) external;

    /// @notice Complete a CONFIRMED reservation. Only the merchant owner may call.
    /// @param id The reservation id.
    function complete(uint256 id) external;

    /// @notice Expire a HELD reservation after its deadline, refunding the escrow to the payer.
    ///         Permissionless.
    /// @param id The reservation id.
    function expireHold(uint256 id) external;

    /// @notice Cancel a HELD or CONFIRMED reservation per the immutable policy snapshot.
    /// @param id        The reservation id.
    /// @param actorType The actor label recorded in the event (does not affect the refund math).
    function cancel(uint256 id, ActorType actorType) external;

    /// @notice Mark a CONFIRMED reservation a no-show: keep the no-show fee, refund the remainder. Only
    ///         the merchant owner may call.
    /// @param id The reservation id.
    function markNoShow(uint256 id) external;

    /// @notice Withdraw a queued refund for `token` (pull-pattern; the contract never decides when you
    ///         are paid — you claim).
    /// @param token The token to claim.
    function claimRefund(address token) external;
}
