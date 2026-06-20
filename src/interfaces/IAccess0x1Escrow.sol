// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IAccess0x1Escrow
/// @author Rensley R. @vyperpilleddev
/// @notice The external surface of {Access0x1Escrow} — the CONDITIONAL-SETTLEMENT leg the instant-push
///         {Access0x1Router} structurally cannot do. The router settles a payment atomically: pull →
///         split → push, all in one tx, no hold. An escrow instead HOLDS a buyer's deposit until a
///         condition resolves — the buyer confirms, an optional arbiter rules, or a deadline lapses —
///         then either RELEASES to the seller through the router's exact fee-split or REFUNDS the buyer
///         in full. It is the missing primitive for "pay now, settle on delivery" commerce on top of
///         the same zero-custody money spine.
/// @dev    Lifecycle is a strict three-state machine: `OPEN` (funded, awaiting resolution), `RELEASED`
///         (terminal — settled to the seller through the router fee-split), `REFUNDED` (terminal — the
///         full deposit returned to the buyer). `OPEN` is the only state any value path may leave;
///         `RELEASED` and `REFUNDED` are absorbing, so a double-settle reverts by the state guard
///         itself. Funds are NEVER stranded: a release auto-fires after the deadline (anyone may call
///         {claimAfterTimeout}), and every push (to the seller, the treasury, or the buyer) falls back
///         to a per-account pull-map on a failed send, so a hostile recipient can never lock an escrow
///         or block a refund.
interface IAccess0x1Escrow {
    // ──────────────────────── types ────────────────────────

    /// @notice The lifecycle state of an escrow.
    /// @dev    `OPEN` is the only resolvable state; `RELEASED` and `REFUNDED` are terminal (absorbing) —
    ///         no path transitions out of them, which is what makes "settles at most once" hold by
    ///         construction (a re-entrant or replayed resolution reverts {NotOpen}).
    enum EscrowState {
        NONE, // 0 — never opened (a zeroed slot reads as NONE; the open path skips this value)
        OPEN, // 1 — funded and awaiting resolution
        RELEASED, // 2 — settled to the seller through the router fee-split (terminal)
        REFUNDED // 3 — the full deposit refunded to the buyer (terminal)
    }

    /// @notice A single conditional deposit.
    /// @dev    Every field except `state` is write-once at {open} and never mutated — the immutable
    ///         escrow snapshot (no party can re-target, re-price, or re-arbiter a live deposit). Only
    ///         `state` ever changes after creation, OPEN → {RELEASED | REFUNDED}, one-way.
    struct Escrow {
        address buyer; // immutable — funded the deposit; may {confirm} a release and signs {releaseWithSig}
        address seller; // immutable — receives the net on release; may {cancel} to refund the buyer
        uint256 merchantId; // immutable — the router merchant whose fee-split prices the release leg
        address asset; // immutable — the held token (address(0) = the chain's native coin)
        uint256 amount; // immutable — the exact held amount, in the asset's own decimals
        address arbiter; // immutable — optional ruler (address(0) = none); may release OR refund
        uint64 deadline; // immutable — at/after this, anyone may {claimAfterTimeout} to auto-release
        EscrowState state; // the ONLY mutable field: OPEN → {RELEASED | REFUNDED}, one-way
    }

    // ──────────────────────── events ────────────────────────

    /// @notice A new conditional deposit was opened and funded.
    /// @param id         The newly assigned escrow id (≥ 1).
    /// @param buyer      The depositor.
    /// @param seller     The release beneficiary.
    /// @param merchantId The router merchant whose fee-split prices the release.
    /// @param asset      The held token (address(0) = native).
    /// @param amount     The exact held amount.
    /// @param arbiter    The optional arbiter (address(0) = none).
    /// @param deadline   The auto-release deadline.
    event EscrowOpened(
        uint256 indexed id,
        address indexed buyer,
        address indexed seller,
        uint256 merchantId,
        address asset,
        uint256 amount,
        address arbiter,
        uint64 deadline
    );

    /// @notice An escrow was released to the seller through the router fee-split.
    /// @dev    `fee` is the platform leg (`amount * router.platformFeeBps() / 10_000`) sent to
    ///         `router.platformTreasury()`; `net == amount - fee` is what the seller nets. The split is
    ///         MIRRORED from the router's live public values, never re-derived as a constant here, so
    ///         `net + fee == amount` is the router's own audited arithmetic.
    /// @param id     The escrow that settled.
    /// @param caller The address that triggered the release (buyer / arbiter / timeout claimant / relayer).
    /// @param net    The token amount the seller received (or had queued to the pull-map).
    /// @param fee    The platform fee routed to the treasury.
    event EscrowReleased(uint256 indexed id, address indexed caller, uint256 net, uint256 fee);

    /// @notice An escrow was refunded in full to the buyer (no fee is ever taken on a refund).
    /// @param id     The escrow that refunded.
    /// @param caller The address that triggered the refund (seller / arbiter).
    /// @param amount The full deposit returned to the buyer (or queued to the pull-map).
    event EscrowRefunded(uint256 indexed id, address indexed caller, uint256 amount);

    /// @notice A push (to the seller, treasury, or buyer) failed and was queued to the pull-map. The
    ///         owed party (or a keeper) claims it later via {withdraw}; the escrow still resolved.
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

    // ──────────────────────── errors ────────────────────────

    /// @notice A zero address was supplied where a non-zero one is required.
    error Access0x1Escrow__ZeroAddress();

    /// @notice A zero amount was supplied; an escrow must hold a positive amount.
    error Access0x1Escrow__ZeroAmount();

    /// @notice The supplied `deadline` is not strictly in the future, so a timeout could fire at once.
    error Access0x1Escrow__BadDeadline(uint64 deadline, uint256 nowTs);

    /// @notice The referenced escrow was never opened.
    error Access0x1Escrow__Unknown(uint256 id);

    /// @notice The escrow is not in `OPEN` state, so it cannot be resolved again.
    error Access0x1Escrow__NotOpen(uint256 id, EscrowState state);

    /// @notice `msg.sender` (or the signer) is not the party authorized for this action.
    error Access0x1Escrow__NotAuthorized(uint256 id, address caller);

    /// @notice A native `open` was called with `msg.value != amount` (or a token `open` with value).
    error Access0x1Escrow__ValueMismatch(uint256 expected, uint256 provided);

    /// @notice A token took a fee on transfer: the pulled balance delta did not match `amount`.
    error Access0x1Escrow__FeeOnTransferToken(uint256 expected, uint256 received);

    /// @notice {claimAfterTimeout} was called before the escrow's deadline.
    error Access0x1Escrow__TimeoutNotReached(uint256 id, uint64 deadline, uint256 nowTs);

    /// @notice {withdraw} was called with nothing owed for that asset.
    error Access0x1Escrow__NothingToWithdraw(address asset);

    /// @notice A native {withdraw} send to the claimant failed (their `receive` reverted); the
    ///         withdrawable credit is restored by the revert so it can be claimed once they can receive.
    error Access0x1Escrow__WithdrawFailed(address account, uint256 amount);

    /// @notice A {withdrawTo} redirect send to the chosen `to` address failed; the credit is restored by
    ///         the revert so the claimant can retry to a receivable address (their balance is never lost).
    error Access0x1Escrow__WithdrawToFailed(address to, uint256 amount);

    /// @notice The EIP-712 release authorization signature did not recover to the escrow's buyer.
    error Access0x1Escrow__BadSignature(uint256 id);

    // ──────────────────────── views ────────────────────────

    /// @notice Read a full escrow record by id.
    /// @param id The escrow id.
    /// @return The {Escrow} (zeroed, `state == NONE`, if it never existed).
    function escrowOf(uint256 id) external view returns (Escrow memory);

    /// @notice The balance an account may {withdraw} for a token (credited when a push failed).
    /// @param account The owed party.
    /// @param asset   The token (address(0) = native).
    /// @return The withdrawable amount.
    function withdrawable(address account, address asset) external view returns (uint256);

    /// @notice Whether an escrow can be resolved right now (it exists and is `OPEN`).
    /// @param id The escrow id.
    /// @return True iff the escrow is `OPEN`.
    function isOpen(uint256 id) external view returns (bool);

    // ──────────────────────── mutating ────────────────────────

    /// @notice Open and fund a conditional deposit. The caller is the `buyer`. For a token escrow,
    ///         `amount` is pulled via `transferFrom` (the balance delta must equal `amount`, so a
    ///         fee-on-transfer token is rejected); for a native escrow (`asset == address(0)`),
    ///         `msg.value` must equal `amount`.
    /// @param seller     The release beneficiary (non-zero).
    /// @param merchantId The router merchant whose fee-split prices the release (must exist).
    /// @param asset      The held token (address(0) = native).
    /// @param amount     The exact amount to hold (> 0).
    /// @param arbiter    The optional arbiter (address(0) = none).
    /// @param deadline   The auto-release deadline (strictly in the future).
    /// @return id        The newly assigned escrow id (≥ 1).
    function open(
        address seller,
        uint256 merchantId,
        address asset,
        uint256 amount,
        address arbiter,
        uint64 deadline
    ) external payable returns (uint256 id);

    /// @notice Release the escrow to the seller. Buyer-only — the buyer signs off that the condition
    ///         (delivery) is met. Settles through the router fee-split: `fee` → treasury, `net` → seller.
    /// @param id The escrow to release.
    function confirm(uint256 id) external;

    /// @notice Auto-release the escrow to the seller once its deadline has passed. PERMISSIONLESS — a
    ///         keeper, the seller, or anyone may call it, so funds can never lock if the buyer goes
    ///         silent. Settles through the same router fee-split as {confirm}.
    /// @param id The escrow to release.
    function claimAfterTimeout(uint256 id) external;

    /// @notice Refund the escrow in full to the buyer. Seller-only — the seller cancels the deal. No fee
    ///         is taken; the entire deposit goes back to the buyer (never-blockable).
    /// @param id The escrow to cancel.
    function cancel(uint256 id) external;

    /// @notice The arbiter's ruling on a disputed escrow. Arbiter-only (an escrow with no arbiter has
    ///         none, so this can never be called against it). `release == true` settles to the seller
    ///         through the fee-split; `release == false` refunds the buyer in full.
    /// @param id      The disputed escrow.
    /// @param release True to release to the seller, false to refund the buyer.
    function arbitrate(uint256 id, bool release) external;

    /// @notice Release the escrow to the seller against a BUYER-signed EIP-712 authorization, submitted
    ///         by any relayer. Lets the buyer authorize the release off-chain (gasless / agentic) while
    ///         a relayer pays the gas. The signature is validated against the escrow's `buyer` over a
    ///         typed-data digest binding `(id, this contract, chainid)`; settlement is the same router
    ///         fee-split as {confirm}.
    /// @dev    EIP-712 (typed structured data) + ERC-1271 (smart-account signature validation) — a
    ///         deployed smart-account buyer signs via its `isValidSignature`, an EOA via ECDSA.
    /// @param id        The escrow to release.
    /// @param signature The buyer's EIP-712 signature over the release authorization for `id`.
    function releaseWithSig(uint256 id, bytes calldata signature) external;

    /// @notice Withdraw funds that were queued to you when a push failed during a release/refund. Pure
    ///         pull-pattern: you claim, the contract never decides when you are paid.
    /// @param asset The token to withdraw (address(0) = native).
    function withdraw(address asset) external;

    /// @notice Redirect YOUR OWN queued payout for `asset` to a different, receivable address. The
    ///         anti-strand escape hatch: a credited party whose own address can never receive (a
    ///         permanently-reverting `receive`, a blocklisted account) would otherwise see {withdraw}
    ///         revert forever, locking the credit. {withdrawTo} lets that party send THEIR balance to an
    ///         address that can receive. Only the CREDITED party (`msg.sender`) can move `msg.sender`'s
    ///         credit — no caller can ever touch another party's balance.
    /// @param asset The token to withdraw (address(0) = native).
    /// @param to    The receivable destination (non-zero).
    function withdrawTo(address asset, address to) external;
}
