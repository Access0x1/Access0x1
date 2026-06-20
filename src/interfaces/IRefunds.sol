// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IRefunds
/// @author Rensley R. @vyperpilleddev
/// @notice The external surface of {Refunds} — a time-boxed, merchant-authorized refund of a settled
///         payment, keyed by `orderId`. It unifies the ad-hoc "rescue" pull-maps scattered across the
///         estate's money contracts into ONE first-class refund primitive: a merchant FUNDS and
///         AUTHORIZES a refund for an `orderId` (the off-chain settled-payment id) within a claim
///         WINDOW, and the buyer CLAIMS it later as a never-blockable pull. No custody beyond the live
///         requested-but-unclaimed amount; a claimed refund can never be claimed twice.
/// @dev    The lifecycle is the ERC-7540 asynchronous REQUEST → CLAIM shape (the deposit/redeem two-phase
///         pattern, here specialised to refunds): {requestRefund} is the request leg (the merchant
///         escrows the refund amount and opens a claimable position for the buyer), {claim} is the claim
///         leg (the buyer redeems the claimable position to the underlying asset). The position lives as
///         an ERC-6909 RECEIPT — one id per POSITION (`refundTokenId(merchantId, orderId)`), the buyer's
///         claimable balance is the receipt balance on that id, and claiming burns the receipt. After the window lapses
///         unclaimed, the merchant may {reclaim} the funds back (the time-box). Lifecycle states:
///         `NONE → PENDING → {CLAIMED | RECLAIMED}`, the latter two absorbing — a double-claim or a
///         claim-after-reclaim reverts by the state guard itself.
///
///         ERCs implemented: ERC-7540 (async request→claim shape), EIP-3009 `receiveWithAuthorization`
///         + EIP-2612 `permit` (the merchant funds the refund GASLESSLY with a signed authorization on
///         the funding asset — no separate approval tx), ERC-6909 (per-asset claim ids for the buyer's
///         claimable receipt), and ERC-165 ({supportsInterface}).
interface IRefunds {
    // ──────────────────────── types ────────────────────────

    /// @notice The lifecycle state of a refund position keyed by `(merchantId, orderId)`.
    /// @dev    `PENDING` is the only claimable/reclaimable state; `CLAIMED` and `RECLAIMED` are terminal
    ///         (absorbing) — no path transitions out of them, which is what makes "settles at most once"
    ///         hold by construction (a re-entrant or replayed claim/reclaim reverts {NotPending}).
    enum RefundState {
        NONE, // 0 — never requested (a zeroed slot reads as NONE; {requestRefund} skips this value)
        PENDING, // 1 — funded and claimable by the buyer until the deadline
        CLAIMED, // 2 — the buyer pulled the refund (terminal)
        RECLAIMED // 3 — the window lapsed unclaimed and the merchant pulled the funds back (terminal)
    }

    /// @notice A single time-boxed refund position.
    /// @dev    Every field except `state` is write-once at {requestRefund} and never mutated — the
    ///         immutable refund snapshot (no party can re-target, re-price, or extend a live refund).
    ///         Only `state` ever changes after creation, PENDING → {CLAIMED | RECLAIMED}, one-way.
    struct Refund {
        uint256 merchantId; // immutable — the router merchant that authorized + funded the refund
        address buyer; // immutable — the only address that may {claim} the refund
        address asset; // immutable — the refunded token (address(0) = the chain's native coin)
        uint256 amount; // immutable — the exact refund amount, in the asset's own decimals
        uint64 deadline; // immutable — at/after this the buyer can no longer claim; the merchant may reclaim
        RefundState state; // the ONLY mutable field: PENDING → {CLAIMED | RECLAIMED}, one-way
    }

    /// @notice The EIP-3009 `receiveWithAuthorization` parameters (minus `to`/`value`, which the
    ///         {Refunds} contract pins to itself and `amount` respectively). `from` is the funder, `nonce`
    ///         is the token's own 3009 replay nonce.
    /// @dev    Used by {requestRefundWithAuthorization}; the contract supplies `to = address(this)` and
    ///         `value = amount` so the authorization can only ever fund THIS refund into THIS contract.
    struct ReceiveAuthorization {
        address from; // the funder the authorization debits (the merchant owner)
        uint256 validAfter; // the authorization is valid only at/after this timestamp
        uint256 validBefore; // the authorization is valid only before this timestamp
        bytes32 nonce; // the token's per-from 3009 authorization nonce (replay protection on the token)
    }

    // ──────────────────────── events ────────────────────────

    /// @notice A merchant funded and authorized a time-boxed refund for `orderId`.
    /// @param merchantId The router merchant that authorized the refund.
    /// @param orderId    The off-chain settled-payment id the refund is keyed to.
    /// @param buyer      The address that may claim the refund.
    /// @param asset      The refunded token (address(0) = native).
    /// @param amount     The exact refund amount funded.
    /// @param deadline   The claim window deadline (the time-box).
    /// @param tokenId    The ERC-6909 claim id minted to the buyer (`refundTokenId(merchantId, orderId)`).
    event RefundRequested(
        uint256 indexed merchantId,
        bytes32 indexed orderId,
        address indexed buyer,
        address asset,
        uint256 amount,
        uint64 deadline,
        uint256 tokenId
    );

    /// @notice The buyer claimed a pending refund (the ERC-7540 claim leg). The ERC-6909 receipt is
    ///         burned and the underlying asset paid out — or, on a failed push, queued to the pull-map.
    /// @param merchantId The router merchant that funded the refund.
    /// @param orderId    The settled-payment id the refund was keyed to.
    /// @param buyer      The claimant (the refund's authorized buyer).
    /// @param asset      The refunded token (address(0) = native).
    /// @param amount     The amount claimed.
    event RefundClaimed(
        uint256 indexed merchantId,
        bytes32 indexed orderId,
        address indexed buyer,
        address asset,
        uint256 amount
    );

    /// @notice A pending refund's window lapsed unclaimed and the merchant pulled the funds back.
    /// @param merchantId The router merchant that reclaimed.
    /// @param orderId    The settled-payment id the refund was keyed to.
    /// @param to         The address the reclaimed funds were sent to (the caller-supplied sink).
    /// @param asset      The refunded token (address(0) = native).
    /// @param amount     The amount reclaimed.
    event RefundReclaimed(
        uint256 indexed merchantId,
        bytes32 indexed orderId,
        address indexed to,
        address asset,
        uint256 amount
    );

    /// @notice A push (to the buyer on claim, or the sink on reclaim) failed and was queued to the
    ///         pull-map. The owed party (or a keeper) claims it later via {withdraw}; the refund still
    ///         resolved (its terminal state is already set).
    /// @param account The party the funds are owed to.
    /// @param asset   The token owed (address(0) = native).
    /// @param amount  The amount credited to the account's withdrawable balance.
    event PayoutQueued(address indexed account, address indexed asset, uint256 amount);

    /// @notice A queued payout was withdrawn by its owed party.
    /// @param account The claimant.
    /// @param asset   The token withdrawn (address(0) = native).
    /// @param amount  The amount paid out.
    event Withdrawn(address indexed account, address indexed asset, uint256 amount);

    /// @notice The owed party redirected THEIR OWN queued payout to a different receivable address. The
    ///         credit moves from the claimant to `to`, never another party's — only `msg.sender`'s own
    ///         balance can be redirected.
    /// @param account The claimant whose own credit was redirected (`msg.sender`).
    /// @param to      The receivable address the funds were sent to.
    /// @param asset   The token withdrawn (address(0) = native).
    /// @param amount  The amount paid out to `to`.
    event WithdrawnTo(
        address indexed account, address indexed to, address indexed asset, uint256 amount
    );

    // ──────────────────── ERC-6909 events ────────────────────

    /// @notice ERC-6909 transfer of a refund claim receipt. A mint is `from == address(0)` (a new
    ///         {requestRefund}); a burn is `to == address(0)` (a {claim}). The receipt is otherwise
    ///         non-transferable — it is a claim ticket, not a tradeable token.
    /// @param caller   The address that initiated the movement.
    /// @param from     The sender (address(0) on a mint).
    /// @param to       The receiver (address(0) on a burn).
    /// @param id       The ERC-6909 claim id (`refundTokenId(merchantId, orderId)`).
    /// @param amount   The amount moved.
    event Transfer(
        address caller, address indexed from, address indexed to, uint256 indexed id, uint256 amount
    );

    // ──────────────────────── errors ────────────────────────

    /// @notice A zero address was supplied where a non-zero one is required.
    error Refunds__ZeroAddress();

    /// @notice A zero amount was supplied; a refund must be a positive amount.
    error Refunds__ZeroAmount();

    /// @notice The supplied `deadline` is not strictly in the future, so the claim window would be empty.
    error Refunds__BadDeadline(uint64 deadline, uint256 nowTs);

    /// @notice The caller is not the owner of the router merchant the refund is authorized against.
    error Refunds__NotMerchantOwner(uint256 merchantId, address caller);

    /// @notice A refund already exists for this `(merchantId, orderId)`; an order id refunds at most once.
    error Refunds__AlreadyRequested(uint256 merchantId, bytes32 orderId);

    /// @notice The referenced refund was never requested.
    error Refunds__Unknown(uint256 merchantId, bytes32 orderId);

    /// @notice The refund is not in `PENDING` state, so it cannot be claimed or reclaimed again.
    error Refunds__NotPending(uint256 merchantId, bytes32 orderId, RefundState state);

    /// @notice `msg.sender` is not the buyer authorized to claim this refund.
    error Refunds__NotBuyer(uint256 merchantId, bytes32 orderId, address caller);

    /// @notice {claim} was called at/after the window deadline — the buyer's claim window has closed.
    error Refunds__ClaimWindowClosed(uint256 merchantId, bytes32 orderId, uint64 deadline);

    /// @notice {reclaim} was called before the window deadline — the buyer can still claim.
    error Refunds__WindowNotClosed(uint256 merchantId, bytes32 orderId, uint64 deadline);

    /// @notice A native {requestRefund} was called with `msg.value != amount` (or a token request with
    ///         value, or a gasless funding path that carries native value).
    error Refunds__ValueMismatch(uint256 expected, uint256 provided);

    /// @notice A token took a fee on transfer: the pulled balance delta did not match `amount`.
    error Refunds__FeeOnTransferToken(uint256 expected, uint256 received);

    /// @notice A gasless funding path (`permit` / `receiveWithAuthorization`) was used for a NATIVE
    ///         refund, which has no signed-authorization funding (native arrives as `msg.value`).
    error Refunds__GaslessNotForNative();

    /// @notice {withdraw} was called with nothing owed for that asset.
    error Refunds__NothingToWithdraw(address asset);

    /// @notice A native {withdraw} send to the claimant failed; the credit is restored by the revert so
    ///         it can be claimed once they can receive.
    error Refunds__WithdrawFailed(address account, uint256 amount);

    /// @notice A {withdrawTo} redirect send to the chosen `to` failed; the credit is restored by the
    ///         revert so the claimant can retry to a receivable address.
    error Refunds__WithdrawToFailed(address to, uint256 amount);

    // ──────────────────────── views ────────────────────────

    /// @notice Read a full refund record by `(merchantId, orderId)`.
    /// @param merchantId The router merchant the refund is keyed to.
    /// @param orderId    The settled-payment id the refund is keyed to.
    /// @return The {Refund} (zeroed, `state == NONE`, if it never existed).
    function refundOf(uint256 merchantId, bytes32 orderId) external view returns (Refund memory);

    /// @notice Whether a refund can be claimed by its buyer right now (it exists, is PENDING, and the
    ///         window is still open). The ERC-7540 "claimable request" predicate.
    /// @param merchantId The router merchant the refund is keyed to.
    /// @param orderId    The settled-payment id the refund is keyed to.
    /// @return True iff the buyer can claim it in this block.
    function isClaimable(uint256 merchantId, bytes32 orderId) external view returns (bool);

    /// @notice The deterministic ERC-6909 claim id for ONE refund position. The id is keyed on the
    ///         `(merchantId, orderId)` position — not the asset — so each refund holds a DISTINCT,
    ///         non-fungible receipt: a buyer's `balanceOf(buyer, refundTokenId(merchantId, orderId))` is the
    ///         exact still-open amount of THAT one refund, and resolving it never disturbs any other.
    /// @param merchantId The router merchant the refund is keyed to.
    /// @param orderId    The settled-payment id the refund is keyed to.
    /// @return id        `keccak256("Access0x1Refund", merchantId, orderId)` — one id per position.
    function refundTokenId(uint256 merchantId, bytes32 orderId) external pure returns (uint256 id);

    /// @notice The balance an account may {withdraw} for a token (credited when a push failed).
    /// @param account The owed party.
    /// @param asset   The token (address(0) = native).
    /// @return The withdrawable amount.
    function withdrawable(address account, address asset) external view returns (uint256);

    // ──────────────────── ERC-6909 read ────────────────────

    /// @notice ERC-6909: the claimable refund receipt balance of `owner` for claim id `id`. This IS the
    ///         buyer's still-open refund value for the single position that `id` represents.
    /// @param owner The receipt holder (the buyer).
    /// @param id    The ERC-6909 claim id (`refundTokenId(merchantId, orderId)`).
    /// @return The receipt balance.
    function balanceOf(address owner, uint256 id) external view returns (uint256);

    // ──────────────────────── mutating ────────────────────────

    /// @notice Fund and authorize a time-boxed refund for `orderId`, pulling the asset from the merchant
    ///         owner via a STANDARD allowance (the merchant approved this contract beforehand). For a
    ///         native refund (`asset == address(0)`), send `msg.value == amount` and the allowance path
    ///         is skipped. The caller must own the router merchant. The ERC-7540 request leg.
    /// @param merchantId The router merchant authorizing the refund (the caller must own it).
    /// @param orderId    The off-chain settled-payment id to key the refund to (unique per merchant).
    /// @param buyer      The address that may claim the refund (non-zero).
    /// @param asset      The refunded token (address(0) = native).
    /// @param amount     The exact amount to refund (> 0).
    /// @param deadline   The claim window deadline (strictly in the future).
    function requestRefund(
        uint256 merchantId,
        bytes32 orderId,
        address buyer,
        address asset,
        uint256 amount,
        uint64 deadline
    ) external payable;

    /// @notice Fund and authorize a refund where the merchant owner funds it GASLESSLY via an EIP-2612
    ///         `permit` on the ERC-20 (so no separate approval tx is needed). The permit grants this
    ///         contract the `amount` allowance from the merchant owner; everything else matches
    ///         {requestRefund}. Native refunds have no permit path ({GaslessNotForNative}).
    /// @param merchantId The router merchant authorizing the refund (the caller must own it).
    /// @param orderId    The off-chain settled-payment id to key the refund to (unique per merchant).
    /// @param buyer      The address that may claim the refund (non-zero).
    /// @param asset      The refunded ERC-20 (non-zero — native has no permit).
    /// @param amount     The exact amount to refund (> 0).
    /// @param deadline   The claim window deadline (strictly in the future).
    /// @param permitDeadline The EIP-2612 permit's own deadline (independent of the claim window).
    /// @param v          The permit signature `v`.
    /// @param r          The permit signature `r`.
    /// @param s          The permit signature `s`.
    function requestRefundWithPermit(
        uint256 merchantId,
        bytes32 orderId,
        address buyer,
        address asset,
        uint256 amount,
        uint64 deadline,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @notice Fund and authorize a refund where the merchant owner funds it GASLESSLY via an EIP-3009
    ///         `receiveWithAuthorization` on the ERC-20 (USDC-native): the signed authorization PUSHES
    ///         the `amount` straight from the merchant owner into this contract, no allowance involved.
    ///         The authorization's `to` must be this contract and its `value` must equal `amount`.
    ///         Native refunds have no 3009 path ({GaslessNotForNative}).
    /// @param merchantId The router merchant authorizing the refund (the caller must own it).
    /// @param orderId    The off-chain settled-payment id to key the refund to (unique per merchant).
    /// @param buyer      The address that may claim the refund (non-zero).
    /// @param asset      The refunded ERC-20 (non-zero — native has no 3009).
    /// @param amount     The exact amount to refund (> 0); must equal the authorization's `value`.
    /// @param deadline   The claim window deadline (strictly in the future).
    /// @param auth       The EIP-3009 authorization tuple `(from, validAfter, validBefore, nonce)` —
    ///                   `from` is the funder (the merchant owner), the contract is the implicit `to`.
    /// @param v          The authorization signature `v`.
    /// @param r          The authorization signature `r`.
    /// @param s          The authorization signature `s`.
    function requestRefundWithAuthorization(
        uint256 merchantId,
        bytes32 orderId,
        address buyer,
        address asset,
        uint256 amount,
        uint64 deadline,
        ReceiveAuthorization calldata auth,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @notice Claim a pending refund (the ERC-7540 claim leg). Buyer-only, before the window deadline.
    ///         Burns the buyer's ERC-6909 receipt and pays the underlying asset out (never-blockable: a
    ///         failed push queues to the pull-map and the buyer pulls it via {withdraw}).
    /// @param merchantId The router merchant that funded the refund.
    /// @param orderId    The settled-payment id the refund is keyed to.
    function claim(uint256 merchantId, bytes32 orderId) external;

    /// @notice Reclaim a pending refund whose claim window has lapsed unclaimed, returning the funds to
    ///         `to`. Merchant-owner-only, at/after the deadline. Burns the buyer's stale receipt. The
    ///         time-box escape: a buyer who never claims can never permanently lock the merchant's funds.
    /// @param merchantId The router merchant that funded the refund (the caller must own it).
    /// @param orderId    The settled-payment id the refund is keyed to.
    /// @param to         The address to return the reclaimed funds to (non-zero).
    function reclaim(uint256 merchantId, bytes32 orderId, address to) external;

    /// @notice Withdraw funds that were queued to you when a push failed during a claim/reclaim. Pure
    ///         pull-pattern: you claim, the contract never decides when you are paid.
    /// @param asset The token to withdraw (address(0) = native).
    function withdraw(address asset) external;

    /// @notice Redirect YOUR OWN queued payout for `asset` to a different, receivable address — the
    ///         anti-strand escape hatch. Only the CREDITED party (`msg.sender`) can move `msg.sender`'s
    ///         credit; no caller can ever touch another party's balance.
    /// @param asset The token to withdraw (address(0) = native).
    /// @param to    The receivable destination (non-zero).
    function withdrawTo(address asset, address to) external;
}
