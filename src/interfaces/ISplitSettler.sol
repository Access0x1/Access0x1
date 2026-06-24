// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC2981 } from "@openzeppelin/contracts/interfaces/IERC2981.sol";

/// @title  ISplitSettler
/// @author Access0x1
/// @notice The external surface of {SplitSettler} — the REVENUE-SPLIT leg of Access0x1. One incoming
///         payment fans out to N configured payees (seller + platform-affiliate + creator + tax + …) by
///         basis-point shares that sum to EXACTLY the gross. Settlement is a two-stage pipe: the gross is
///         settled THROUGH {Access0x1Router}'s fee-split first (so Access0x1's platform fee is taken
///         ONCE, at the router, exactly like a direct payment), and the NET the router returns is then
///         split among the configured payees by their shares. Every payee leg is PULL-claimable and
///         NEVER-BLOCKABLE: a failed push credits a per-(account, asset) withdrawable map the payee
///         claims later via {withdraw}, so a hostile or unreachable payee can never block the split for
///         the others. The merchant owner configures the split once (immutable shares snapshot); anyone
///         pays it.
/// @dev    ERCs advertised via ERC-165 {supportsInterface}: this interface, {IERC2981} (the royalty /
///         share-shape standard — {royaltyInfo} reports a split's PRIMARY payee + its cut of a sale
///         price so a marketplace can discover the share shape), and ERC-165 itself. Per-payee payout
///         lanes are the withdrawable map (the "or per-payee withdrawable" form). The money invariant the
///         fuzzer proves: the contract's balance for each asset == Σ unclaimed withdrawable for that
///         asset, and every configured split has Σ shares == TOTAL_BPS (== the gross after the split).
interface ISplitSettler is IERC2981 {
    // ──────────────────────── types ────────────────────────

    /// @notice One payee leg of a split: where the leg lands and its basis-point share of the net.
    /// @dev    `account` is the payout destination (non-zero); `shareBps` is its cut of the post-router
    ///         net in basis points. Across a split the `shareBps` sum to {TOTAL_BPS} (10_000) EXACTLY —
    ///         no dust is created or lost, the last leg absorbs the rounding remainder (see {settleToken}).
    struct Payee {
        address account; // immutable — where this leg's funds land (or queue, never-blockable)
        uint16 shareBps; // immutable — this leg's share of the net, in basis points (Σ == TOTAL_BPS)
    }

    /// @notice A configured revenue split.
    /// @dev    `merchantId`, `payees`, and `primaryPayee` are write-once at {createSplit} and never
    ///         mutated — the immutable split snapshot (an operator cannot retroactively re-weight or
    ///         re-target a live split). Only `active` ever changes after creation (the merchant owner may
    ///         pause new settlements via {setSplitActive}). `merchantId` is the router merchant whose
    ///         fee-split + USD pricing the settlement routes through.
    struct Split {
        uint256 merchantId; // immutable — the router merchant the gross settles through (fee-split + quote)
        uint16 primaryIndex; // immutable — index into `payees` of the ERC-2981 primary (royalty) payee
        bool active; // the ONLY mutable field — false ⇒ new settlements revert (existing claims unaffected)
        Payee[] payees; // immutable — the fan-out legs; Σ shareBps == TOTAL_BPS, 1..MAX_PAYEES entries
    }

    // ──────────────────────── events ────────────────────────

    /// @notice A new revenue split was configured.
    /// @param id           The newly assigned split id (≥ 1).
    /// @param merchantId   The router merchant the gross settles through.
    /// @param payeeCount   The number of payee legs.
    /// @param primaryIndex The index of the ERC-2981 primary (royalty) payee.
    event SplitCreated(
        uint256 indexed id, uint256 indexed merchantId, uint256 payeeCount, uint16 primaryIndex
    );

    /// @notice A split's `active` flag was toggled by the merchant owner.
    /// @param id     The split.
    /// @param active The new flag (false ⇒ new settlements revert).
    event SplitActiveSet(uint256 indexed id, bool active);

    /// @notice A payment was settled through a split: the gross was routed through the router fee-split
    ///         and the returned net fanned out to the payee legs.
    /// @dev    `net` is what the router returned to this contract after taking the platform fee ONCE; it
    ///         is what was divided among the payees (Σ leg credits == `net`, exactly). The authoritative
    ///         platform-fee breakdown is the router's own {PaymentReceived} receipt, keyed on `orderId`.
    /// @param id      The split that settled.
    /// @param payer   The address that paid.
    /// @param asset   The settled asset (address(0) = native).
    /// @param gross   The gross the router quoted and split (the full settled amount).
    /// @param net     The net the router returned, which was fanned out to the payees.
    /// @param orderId The idempotency tag echoed into the router receipt's `orderId`.
    event SplitSettled(
        uint256 indexed id,
        address indexed payer,
        address indexed asset,
        uint256 gross,
        uint256 net,
        bytes32 orderId
    );

    /// @notice A payee leg's net share was credited (queued) for pull-claim.
    /// @param id      The split that settled.
    /// @param account The payee the share is owed to.
    /// @param asset   The asset owed (address(0) = native).
    /// @param amount  The amount credited to the payee's withdrawable balance.
    event ShareCredited(
        uint256 indexed id, address indexed account, address indexed asset, uint256 amount
    );

    /// @notice A payee withdrew their queued payout.
    /// @param account The claimant.
    /// @param asset   The asset withdrawn (address(0) = native).
    /// @param amount  The amount paid out.
    event Withdrawn(address indexed account, address indexed asset, uint256 amount);

    /// @notice A payee redirected THEIR OWN queued payout to a different receivable address. Only the
    ///         credited party (`msg.sender`) can move `msg.sender`'s own credit — never another party's.
    /// @param account The claimant whose own credit was redirected (`msg.sender`).
    /// @param to      The receivable address the funds were sent to.
    /// @param asset   The asset withdrawn (address(0) = native).
    /// @param amount  The amount paid out to `to`.
    event WithdrawnTo(
        address indexed account, address indexed to, address indexed asset, uint256 amount
    );

    // ──────────────────────── errors ────────────────────────

    /// @notice A zero address was supplied where a non-zero one is required.
    error SplitSettler__ZeroAddress();

    /// @notice A zero amount was supplied where a positive one is required.
    error SplitSettler__ZeroAmount();

    /// @notice The payee set was empty or exceeded {MAX_PAYEES} (unbounded-loop guard).
    error SplitSettler__BadPayeeCount(uint256 count, uint256 max);

    /// @notice The supplied shares did not sum to exactly {TOTAL_BPS}.
    error SplitSettler__SharesNotExact(uint256 sum, uint256 expected);

    /// @notice The supplied {Split.primaryIndex} is out of range for the payee set.
    error SplitSettler__BadPrimaryIndex(uint256 index, uint256 count);

    /// @notice The referenced split was never created.
    error SplitSettler__SplitUnknown(uint256 id);

    /// @notice The split is not active, so it cannot be settled.
    error SplitSettler__SplitInactive(uint256 id);

    /// @notice Caller is not the owner of the split's router merchant.
    error SplitSettler__NotMerchantOwner(uint256 merchantId, address caller);

    /// @notice {settleNative} was called for a token-denominated settlement, or {settleToken} with a
    ///         native asset (use {settleNative} for the native path).
    error SplitSettler__WrongSettlePath(uint256 id, address asset);

    /// @notice `msg.value` was below the quoted gross required to settle a native split.
    error SplitSettler__Underpaid(uint256 required, uint256 provided);

    /// @notice A native refund of the buyer's excess failed.
    error SplitSettler__NativeRefundFailed(address to, uint256 amount);

    /// @notice A token took a fee on transfer: the pulled balance delta did not match the gross.
    error SplitSettler__FeeOnTransferToken(uint256 expected, uint256 received);

    /// @notice {withdraw} was called with nothing owed for that asset.
    error SplitSettler__NothingToWithdraw(address asset);

    /// @notice A native {withdraw} send to the claimant failed; the credit is restored by the revert so
    ///         it can be claimed once the claimant can receive (or via {withdrawTo} to another address).
    error SplitSettler__WithdrawFailed(address account, uint256 amount);

    /// @notice A {withdrawTo} redirect send to the chosen `to` failed; the credit is restored by the
    ///         revert so the claimant can retry to a receivable address (their balance is never lost).
    error SplitSettler__WithdrawToFailed(address to, uint256 amount);

    // ──────────────────────── views ────────────────────────

    /// @notice The basis-point denominator a split's shares sum to (10_000 = 100% of the net).
    function TOTAL_BPS() external view returns (uint16);

    /// @notice The hard ceiling on payee legs per split (the unbounded-loop guard).
    function MAX_PAYEES() external view returns (uint256);

    /// @notice Read a full split record by id.
    /// @param id The split id.
    /// @return The {Split} (zeroed — `merchantId == 0`, empty `payees` — if it never existed).
    function splitOf(uint256 id) external view returns (Split memory);

    /// @notice The balance an account may {withdraw} for an asset (credited when a push failed, or on the
    ///         pull-credit settle path).
    /// @param account The owed party.
    /// @param asset   The asset (address(0) = native).
    /// @return The withdrawable amount.
    function withdrawable(address account, address asset) external view returns (uint256);

    /// @notice Whether a split can be settled right now (it exists and is `active`).
    /// @param id The split id.
    /// @return True iff the split is active.
    function isActive(uint256 id) external view returns (bool);

    /// @notice Preview the per-leg net amounts a split would credit for a given net.
    /// @dev    Pure helper for the frontend/SDK: floors each leg by its share, the LAST leg absorbing the
    ///         remainder, so Σ returned == `net` exactly (no dust created or lost). Mirrors the credit
    ///         math {settleToken}/{settleNative} apply to the router's returned net.
    /// @param id  The split id.
    /// @param net The net to fan out.
    /// @return amounts The per-leg amounts, aligned to the split's `payees` order (Σ == `net`).
    function previewSplit(uint256 id, uint256 net) external view returns (uint256[] memory amounts);

    // ──────────────────────── mutating ────────────────────────

    /// @notice Configure a revenue split. Only the router merchant's owner may create it. The shares are
    ///         write-once and must sum to EXACTLY {TOTAL_BPS}; the payee count must be 1..{MAX_PAYEES}.
    /// @param merchantId   The router merchant the gross settles through (must exist; caller must own it).
    /// @param payees       The fan-out legs (1..{MAX_PAYEES}; each `account` non-zero; Σ `shareBps` == TOTAL_BPS).
    /// @param primaryIndex The index of the ERC-2981 primary (royalty) payee within `payees`.
    /// @return id          The newly assigned split id (≥ 1).
    function createSplit(uint256 merchantId, Payee[] calldata payees, uint16 primaryIndex)
        external
        returns (uint256 id);

    /// @notice Toggle a split's `active` flag. Only the split's router-merchant owner may call. A paused
    ///         split rejects NEW settlements; existing queued claims are unaffected (no hostage funds).
    /// @param id     The split.
    /// @param active The new flag.
    function setSplitActive(uint256 id, bool active) external;

    /// @notice Settle a token-denominated, USD-priced payment through a split. Pulls the quoted gross from
    ///         the payer, routes it through the router fee-split (platform fee taken ONCE), then fans the
    ///         returned net out to the payee legs (each leg pull-claimable, never-blockable).
    /// @param id         The split to settle.
    /// @param token      The allowlisted pay-in ERC-20 (native is rejected — use {settleNative}).
    /// @param usdAmount8 The price in USD (8 decimals, must be > 0).
    /// @param orderId    An idempotency tag echoed into the router receipt's `orderId`.
    function settleToken(uint256 id, address token, uint256 usdAmount8, bytes32 orderId) external;

    /// @notice Settle a native-denominated, USD-priced payment through a split, refunding any excess
    ///         `msg.value`. Routes the gross through the router fee-split (platform fee once), then fans
    ///         the returned net out to the payee legs (each leg pull-claimable, never-blockable).
    /// @param id         The split to settle.
    /// @param usdAmount8 The price in USD (8 decimals, must be > 0).
    /// @param orderId    An idempotency tag echoed into the router receipt's `orderId`.
    function settleNative(uint256 id, uint256 usdAmount8, bytes32 orderId) external payable;

    /// @notice Withdraw funds queued to you (a fanned-out share, or a payout that failed its push). Pure
    ///         pull-pattern: you claim, the contract never decides when you are paid.
    /// @param asset The asset to withdraw (address(0) = native).
    function withdraw(address asset) external;

    /// @notice Redirect YOUR OWN queued payout for `asset` to a different, receivable address. The
    ///         anti-strand escape hatch: a credited party whose own address can never receive (a
    ///         permanently-reverting `receive`, a blocklisted account) would otherwise see {withdraw}
    ///         revert forever, locking the credit. Only the CREDITED party (`msg.sender`) can move
    ///         `msg.sender`'s credit — no caller can ever touch another party's balance.
    /// @param asset The asset to withdraw (address(0) = native).
    /// @param to    The receivable destination (non-zero).
    function withdrawTo(address asset, address to) external;
}
