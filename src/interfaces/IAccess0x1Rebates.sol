// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IAccess0x1Rebates
/// @author Access0x1
/// @notice The external surface of {Access0x1Rebates} — the CONDITIONAL-REBATE leg of Access0x1: a
///         merchant pre-funds a promotional pool, and a buyer who settles a qualifying USD-priced
///         payment through the router receives an instant rebate FROM that pool in the SAME
///         transaction. The release condition is a pure function of chain state plus the settlement
///         call itself (promo window by the chain clock, qualifying amount from the call's own
///         argument, pool balance, and an order-id idempotency key) — no off-chain fact, no oracle,
///         no trusted human anywhere on the path.
/// @dev    Settlement composes the router, never duplicates it: {payWithRebate} pulls the router-quoted
///         gross from the buyer and routes it through {Access0x1Router.payToken}, so USD pricing, the
///         token allowlist, and the platform fee are the router's own audited arithmetic, applied
///         exactly once at the router. The rebate leg then pays the SAME buyer from the merchant's
///         pre-funded pool, atomically: if the settlement reverts, no rebate exists; if the rebate
///         push cannot land (a blocklisted or reverting receiver), it is QUEUED to a per-(account,
///         asset) withdrawable map instead of blocking the settlement — a rebate is never lost and
///         never holds the payment hostage. The pool is fully backed at rest: the contract holds, per
///         asset, EXACTLY the sum of every promo's remaining `funded` plus every unclaimed queued
///         rebate (conservation — the invariant suite proves it). Unspent promo money is NEVER
///         hostage: after the window closes the merchant owner (read LIVE from the router registry)
///         reclaims the remainder with one call that touches nothing but this contract's own state.
interface IAccess0x1Rebates {
    // ──────────────────────── types ────────────────────────

    /// @notice A merchant's promotional rebate program — one active promo per merchant seat.
    /// @dev    `token`, `start`, `end`, `rebateBps`, and `minUsd8` are written at {createPromo} and
    ///         never mutated while the pool holds funds (a promo cannot be re-aimed mid-flight);
    ///         `funded` is the remaining fully-backed pool, increased by {fundPromo} and decreased by
    ///         each rebate or the post-window {reclaim}. A promo with `token == address(0)` was never
    ///         created (the unset sentinel — native promos are not supported in v1).
    struct Promo {
        address token; // the pay-in ERC-20 this promo qualifies on AND rebates in (never native)
        uint64 start; // promo window opens (unix seconds, inclusive; the chain clock is the judge)
        uint64 end; // promo window closes (unix seconds, inclusive)
        uint16 rebateBps; // the rebate as basis points of the settled gross (1..TOTAL_BPS)
        uint256 minUsd8; // the qualifying minimum, in USD with 8 decimals (the settle call's own arg)
        uint256 funded; // the remaining pre-funded pool, in the promo token's own decimals
    }

    // ──────────────────────── events ────────────────────────

    /// @notice A merchant owner configured a promotional rebate program.
    /// @param merchantId The router merchant seat the promo binds to.
    /// @param token      The pay-in ERC-20 the promo qualifies on and rebates in.
    /// @param start      Window open (unix seconds, inclusive).
    /// @param end        Window close (unix seconds, inclusive).
    /// @param rebateBps  The rebate in basis points of the settled gross.
    /// @param minUsd8    The qualifying minimum purchase (USD, 8 decimals).
    event PromoCreated(
        uint256 indexed merchantId,
        address indexed token,
        uint64 start,
        uint64 end,
        uint16 rebateBps,
        uint256 minUsd8
    );

    /// @notice The promo pool was topped up. Anyone may fund (the merchant typically does).
    /// @param merchantId The promo's merchant seat.
    /// @param funder     Who supplied the funds.
    /// @param amount     The amount pulled into the pool (promo-token decimals).
    /// @param newFunded  The pool's new remaining balance.
    event PromoFunded(
        uint256 indexed merchantId, address indexed funder, uint256 amount, uint256 newFunded
    );

    /// @notice A qualifying settlement paid its rebate to the buyer, in the settlement transaction.
    /// @param merchantId The promo's merchant seat (also the settled merchant).
    /// @param buyer      The payer of the settlement — the rebate lands with the ACTUAL payer.
    /// @param token      The asset rebated (the promo token, which the settlement rode).
    /// @param rebate     The amount paid from the pool.
    /// @param orderId    The settlement's order id — the idempotency key this rebate consumed.
    event RebatePaid(
        uint256 indexed merchantId,
        address indexed buyer,
        address indexed token,
        uint256 rebate,
        bytes32 orderId
    );

    /// @notice A qualifying rebate could not be pushed to the buyer (a reverting or blocklisted
    ///         receiver), so it was QUEUED to the buyer's withdrawable balance instead — the
    ///         settlement stands, the rebate is claimable via {withdraw}, nothing is lost or blocked.
    /// @param merchantId The promo's merchant seat.
    /// @param buyer      The payer whose rebate was queued.
    /// @param token      The asset queued.
    /// @param rebate     The amount queued.
    /// @param orderId    The settlement's order id — the idempotency key this rebate consumed.
    event RebateQueued(
        uint256 indexed merchantId,
        address indexed buyer,
        address indexed token,
        uint256 rebate,
        bytes32 orderId
    );

    /// @notice The merchant owner reclaimed the unspent pool after the promo window closed.
    /// @param merchantId The promo's merchant seat.
    /// @param to         Where the remainder was sent (the owner's chosen, receivable address).
    /// @param token      The asset reclaimed.
    /// @param amount     The remainder returned.
    event PromoReclaimed(
        uint256 indexed merchantId, address indexed to, address indexed token, uint256 amount
    );

    /// @notice A buyer withdrew a queued rebate.
    /// @param account The claimant.
    /// @param asset   The asset withdrawn.
    /// @param amount  The amount paid out.
    event Withdrawn(address indexed account, address indexed asset, uint256 amount);

    /// @notice A buyer redirected THEIR OWN queued rebate to a different receivable address. Only the
    ///         credited party (`msg.sender`) can move `msg.sender`'s own credit — never another's.
    /// @param account The claimant whose own credit was redirected (`msg.sender`).
    /// @param to      The receivable address the funds were sent to.
    /// @param asset   The asset withdrawn.
    /// @param amount  The amount paid out to `to`.
    event WithdrawnTo(
        address indexed account, address indexed to, address indexed asset, uint256 amount
    );

    // ──────────────────────── errors ────────────────────────

    /// @notice A zero address was supplied where a non-zero one is required.
    error Access0x1Rebates__ZeroAddress();

    /// @notice A zero amount was supplied where a positive one is required.
    error Access0x1Rebates__ZeroAmount();

    /// @notice Caller is not the owner of the promo's router merchant seat (read live).
    error Access0x1Rebates__NotMerchantOwner(uint256 merchantId, address caller);

    /// @notice No promo was ever created for this merchant seat.
    error Access0x1Rebates__NoPromo(uint256 merchantId);

    /// @notice {createPromo} on a seat whose pool still holds funds — reclaim (or drain) first, so a
    ///         promo's terms can never be re-aimed while money sits behind them.
    error Access0x1Rebates__PromoStillFunded(uint256 merchantId, uint256 funded);

    /// @notice The promo window is malformed: `start >= end`, or `end` is not in the future.
    error Access0x1Rebates__BadWindow(uint64 start, uint64 end);

    /// @notice The rebate share is out of range (must be 1..TOTAL_BPS).
    error Access0x1Rebates__BadRebateBps(uint16 rebateBps);

    /// @notice {fundPromo} after the window closed — a dead promo takes no new money; reclaim instead.
    error Access0x1Rebates__PromoEnded(uint256 merchantId, uint64 end);

    /// @notice {reclaim} before the window closed — the pool is committed until `end` passes.
    error Access0x1Rebates__PromoNotEnded(uint256 merchantId, uint64 end);

    /// @notice Nothing left in the pool to reclaim.
    error Access0x1Rebates__NothingToReclaim(uint256 merchantId);

    /// @notice This `orderId` already claimed its rebate — the idempotency key. The replay reverts
    ///         BEFORE any value moves, so a duplicate submission can never settle twice.
    error Access0x1Rebates__OrderAlreadyClaimed(bytes32 orderId);

    /// @notice Native settlement is not supported — promos are ERC-20 only in v1 (use the router's
    ///         {payNative} directly for native payments; they simply carry no rebate).
    error Access0x1Rebates__NativeNotSupported();

    /// @notice A token took a fee on transfer: the pulled balance delta did not match the amount.
    error Access0x1Rebates__FeeOnTransferToken(uint256 expected, uint256 received);

    /// @notice {withdraw} was called with nothing owed for that asset.
    error Access0x1Rebates__NothingToWithdraw(address asset);

    // ──────────────────────── views ────────────────────────

    /// @notice The basis-point denominator (10_000 = 100% of the gross).
    function TOTAL_BPS() external view returns (uint16);

    /// @notice Read a merchant seat's promo. `token == address(0)` means never created.
    /// @param merchantId The merchant seat.
    /// @return token     The promo's pay-in / rebate ERC-20.
    /// @return start     Window open (unix seconds, inclusive).
    /// @return end       Window close (unix seconds, inclusive).
    /// @return rebateBps The rebate in basis points of the settled gross.
    /// @return minUsd8   The qualifying minimum (USD, 8 decimals).
    /// @return funded    The remaining fully-backed pool.
    function promos(uint256 merchantId)
        external
        view
        returns (
            address token,
            uint64 start,
            uint64 end,
            uint16 rebateBps,
            uint256 minUsd8,
            uint256 funded
        );

    /// @notice Whether an `orderId` already consumed its rebate (the idempotency key).
    function claimedOrder(bytes32 orderId) external view returns (bool);

    /// @notice The queued-rebate balance an account may {withdraw} for an asset.
    /// @param account The owed party.
    /// @param asset   The asset.
    /// @return The withdrawable amount.
    function withdrawable(address account, address asset) external view returns (uint256);

    /// @notice Preview the rebate a settlement would earn RIGHT NOW: zero when any predicate leg
    ///         fails (no promo, wrong token, outside the window, below the minimum, empty pool, or a
    ///         consumed orderId), else `min(gross * rebateBps / TOTAL_BPS, funded)`.
    /// @dev    Read-only mirror of {payWithRebate}'s qualify-then-cap arithmetic for the frontend/SDK.
    ///         Quotes the router in-view, so it reverts wherever a real settlement would (unallowed
    ///         token, missing or stale feed).
    /// @param merchantId The merchant seat being paid.
    /// @param token      The pay-in ERC-20.
    /// @param usdAmount8 The price in USD (8 decimals).
    /// @param orderId    The order id the settlement would carry.
    /// @return rebate The rebate the buyer would receive (0 = settles with no rebate).
    function previewRebate(uint256 merchantId, address token, uint256 usdAmount8, bytes32 orderId)
        external
        view
        returns (uint256 rebate);

    // ──────────────────────── mutating ────────────────────────

    /// @notice Configure a promotional rebate program for a merchant seat. Only the seat's router
    ///         owner (read live) may call, and only while the pool is empty — terms are never
    ///         re-aimed over live money. Funding is a separate step ({fundPromo}).
    /// @param merchantId The router merchant seat the promo binds to (caller must own it).
    /// @param token      The pay-in ERC-20 the promo qualifies on and rebates in (non-zero; never native).
    /// @param start      Window open (unix seconds, inclusive; may be in the past for an immediate start).
    /// @param end        Window close (unix seconds, inclusive; must be > start and in the future).
    /// @param rebateBps  The rebate in basis points of the settled gross (1..TOTAL_BPS).
    /// @param minUsd8    The qualifying minimum purchase (USD, 8 decimals; 0 = every amount qualifies).
    function createPromo(
        uint256 merchantId,
        address token,
        uint64 start,
        uint64 end,
        uint16 rebateBps,
        uint256 minUsd8
    ) external;

    /// @notice Top up a promo's pool. ANYONE may fund (the merchant typically does); the pull is
    ///         exact (fee-on-transfer tokens are rejected) so the pool is always fully backed.
    /// @param merchantId The promo's merchant seat.
    /// @param amount     The amount of the promo token to pull from the caller (must be approved).
    function fundPromo(uint256 merchantId, uint256 amount) external;

    /// @notice Settle a USD-priced payment through the router AND collect the promo rebate in the
    ///         same transaction, if it qualifies. The payment ALWAYS settles (the router's audited
    ///         path, platform fee taken once at the router); the rebate leg fires only when the
    ///         promo predicate holds — `token` matches the promo, the chain clock is inside the
    ///         window, `usdAmount8` meets the minimum, and the pool holds funds. A consumed
    ///         `orderId` reverts BEFORE any value moves (the idempotency key), so a replayed
    ///         submission can never settle twice.
    /// @param merchantId The merchant seat to pay (also the promo looked up).
    /// @param token      The allowlisted pay-in ERC-20 (native is rejected).
    /// @param usdAmount8 The price in USD (8 decimals, must be > 0 — the router enforces it).
    /// @param orderId    The order reference echoed into the router receipt — and the rebate's
    ///                   idempotency key.
    function payWithRebate(uint256 merchantId, address token, uint256 usdAmount8, bytes32 orderId)
        external;

    /// @notice Reclaim the unspent pool after the promo window closed. Only the seat's router owner
    ///         (read live) may call. Touches nothing but this contract's own state — no router call,
    ///         no pause, no gate can ever hold the merchant's unspent money hostage.
    /// @param merchantId The promo's merchant seat.
    /// @param to         The receivable destination for the remainder (non-zero, owner's choice).
    function reclaim(uint256 merchantId, address to) external;

    /// @notice Withdraw a queued rebate (one whose inline push failed). Pure pull-pattern.
    /// @param asset The asset to withdraw.
    function withdraw(address asset) external;

    /// @notice Redirect YOUR OWN queued rebate for `asset` to a different, receivable address — the
    ///         anti-strand escape hatch for a claimant whose own address cannot receive. Only the
    ///         credited party (`msg.sender`) can move `msg.sender`'s credit.
    /// @param asset The asset to withdraw.
    /// @param to    The receivable destination (non-zero).
    function withdrawTo(address asset, address to) external;
}
