// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC4906 } from "@openzeppelin/contracts/interfaces/IERC4906.sol";

/// @title  IReceivables
/// @author Rensley R. @vyperpilleddev
/// @notice The external surface of {Receivables} — an OPEN invoice minted as a TRANSFERABLE,
///         FACTORABLE ERC-721 where whoever HOLDS the token is the on-chain creditor and receives the
///         {Access0x1Router} settlement at pay time. A merchant operator mints a receivable to an
///         initial creditor for `amountUsd8` in an allowlisted settlement `token` (optionally locked to
///         one `debtor`); the NFT can then be sold/assigned/factored freely; paying it pulls the quoted
///         gross from the debtor, routes it through the Router fee-split, pays the NET to the CURRENT
///         token holder, and BURNS the token — so a receivable settles AT MOST once and the holder at
///         settlement time is the sole beneficiary.
/// @dev    This interface is intentionally narrow: it declares only the {Receivables}-OWNED surface
///         (the receivable lifecycle, its money paths, and its views). The inherited ERC-721 surface
///         (`ownerOf`/`transferFrom`/`approve`/…), the ERC-2981 `royaltyInfo`, the EIP-7572
///         `contractURI`, and the ERC-4906 `MetadataUpdate`/`BatchMetadataUpdate` metadata-refresh
///         events are declared by their own standard interfaces ({IERC721}, {IERC2981}, {IERC4906}),
///         which {Receivables} also implements; only the ERC-4906 events are re-surfaced here (via the
///         `is IERC4906` base) so an integrator typing this interface still sees the metadata-update
///         signal a marketplace listens for.
///
///         LIFECYCLE is a strict three-state machine per tokenId:
///           `OPEN` (minted, payable, transferable) → `SETTLED` (paid once, token burned, terminal)
///                                                  → `CANCELLED` (voided by the merchant, terminal).
///         `OPEN` is the only state any money path may leave; `SETTLED`/`CANCELLED` are absorbing. The
///         single-settlement / no-double-pay property is enforced by the terminal flip happening BEFORE
///         any external call (CEI) AND by the burn (a settled receivable's tokenId no longer exists), so
///         a replayed `pay` reverts. Settlement composes the audited Router for ALL pricing + fee math
///         (the contract never re-derives a fee); the Router proves `net + fee == gross`.
interface IReceivables is IERC4906 {
    // ──────────────────────── types ────────────────────────

    /// @notice The lifecycle state of a receivable.
    /// @dev    `OPEN` is the only payable/transferable state; `SETTLED` and `CANCELLED` are terminal
    ///         (absorbing) — no path transitions out of them, which is what makes "settles at most once"
    ///         hold by construction. A `NONE` slot is one that was never minted (a zeroed record reads
    ///         as `NONE`; the mint path never writes this value).
    enum Status {
        NONE, // 0 — never minted (a zeroed slot reads as NONE)
        OPEN, // 1 — minted, payable, and freely transferable/factorable
        SETTLED, // 2 — paid exactly once and burned (terminal)
        CANCELLED // 3 — voided by the merchant before payment (terminal)
    }

    /// @notice A single open-invoice receivable. The CREDITOR is NOT stored here — it is always the
    ///         live `ownerOf(tokenId)`, so a transfer/factoring of the NFT is the sole, atomic way the
    ///         creditor changes (one creditor per OPEN receivable, by construction).
    /// @dev    `merchantId`, `debtor`, `token`, `amountUsd8`, `dueBy` are write-once at mint and never
    ///         mutated by any path — the immutable policy snapshot (an operator cannot retroactively
    ///         re-price, re-target, or re-route a live receivable). Only `status` ever changes.
    /// @param merchantId The Router merchant whose fee policy + treasury the settlement composes, and
    ///                   whose `payout` MUST be this {Receivables} contract (the conduit invariant) so
    ///                   the Router's net returns here to be forwarded to the live holder.
    /// @param debtor     The address obligated to pay. `address(0)` ⇒ anyone may settle on the debtor's
    ///                   behalf; else only this address may call `pay`/`payNative`.
    /// @param token      The settlement token (`address(0)` = native). Allowlisting + the feed are
    ///                   enforced in-tx by the Router at pay time, not at mint.
    /// @param amountUsd8 The face value in USD with 8 decimals (e.g. $1,000.00 == 1000e8).
    /// @param dueBy      Informational maturity (0 ⇒ none); payment is allowed while `OPEN` regardless.
    /// @param status     The ONLY mutable field: `OPEN → {SETTLED | CANCELLED}`, one-way.
    struct Receivable {
        uint256 merchantId;
        address debtor;
        address token;
        uint256 amountUsd8;
        uint64 dueBy;
        Status status;
    }

    // ──────────────────────── events ────────────────────────

    /// @notice A new receivable was minted to an initial creditor (the first NFT holder).
    /// @param tokenId    The newly assigned receivable / ERC-721 token id (≥ 1).
    /// @param merchantId The Router merchant the settlement composes (its `payout` is this contract).
    /// @param creditor   The initial holder credited as creditor (the NFT recipient at mint).
    /// @param debtor     The locked debtor (address(0) ⇒ anyone may settle).
    /// @param token      The settlement token (address(0) = native).
    /// @param amountUsd8 The face value in USD (8 decimals).
    /// @param dueBy      The informational maturity (0 = none).
    event ReceivableMinted(
        uint256 indexed tokenId,
        uint256 indexed merchantId,
        address indexed creditor,
        address debtor,
        address token,
        uint256 amountUsd8,
        uint64 dueBy
    );

    /// @notice A receivable was settled exactly once: the gross was routed through the Router fee-split
    ///         and the NET was paid to the holder-at-settlement, then the token was burned.
    /// @dev    The authoritative `net + fee == gross` breakdown is the Router's own `PaymentReceived`
    ///         receipt, emitted in the same tx and keyed on this `orderId`. This event deliberately
    ///         carries the settled `gross` and the `net` paid to the creditor, never a re-derived fee.
    /// @param tokenId  The receivable that settled (now burned).
    /// @param payer    The address that actually paid (the debtor, or anyone if unlocked).
    /// @param creditor The holder AT settlement time, who received the net (`ownerOf` just before burn).
    /// @param token    The settlement token (address(0) = native).
    /// @param gross    The token amount the Router quoted and split (the full settled amount).
    /// @param net      The amount forwarded to the creditor (gross minus the Router's fee legs).
    /// @param orderId  The reference echoed into the Router receipt's `orderId` for reconciliation.
    event ReceivableSettled(
        uint256 indexed tokenId,
        address indexed payer,
        address indexed creditor,
        address token,
        uint256 gross,
        uint256 net,
        bytes32 orderId
    );

    /// @notice An unpaid receivable was cancelled by the merchant owner and its token burned.
    /// @param tokenId The cancelled receivable.
    event ReceivableCancelled(uint256 indexed tokenId);

    /// @notice The collection-level metadata (EIP-7572 `contractURI`) was changed.
    /// @param contractURI The new contract-level metadata URI.
    event ContractURIUpdated(string contractURI);

    // ──────────────────────── errors ────────────────────────

    /// @notice A zero address was supplied where a non-zero one is required.
    error Receivables__ZeroAddress();

    /// @notice A zero USD amount was supplied; a receivable must be for a positive face value.
    error Receivables__ZeroAmount();

    /// @notice The referenced Router merchant does not exist.
    error Receivables__MerchantNotFound(uint256 merchantId);

    /// @notice The caller is not the Router owner of the referenced merchant.
    error Receivables__NotMerchantOwner(uint256 merchantId, address caller);

    /// @notice The merchant's Router `payout` is not this contract, so a settlement's net would not
    ///         return here to be forwarded to the holder. Mint is rejected to keep the conduit invariant
    ///         (net always lands here) true for every live receivable.
    error Receivables__MerchantPayoutNotConduit(uint256 merchantId, address payout);

    /// @notice The referenced receivable does not exist (never minted) or is no longer `OPEN`.
    error Receivables__NotOpen(uint256 tokenId, Status status);

    /// @notice The receivable is locked to a specific debtor and `msg.sender` is not that debtor.
    error Receivables__NotAuthorizedDebtor(uint256 tokenId, address expected, address caller);

    /// @notice `payNative` was called for a token-denominated receivable, or `pay` for a native one.
    error Receivables__WrongPayPath(uint256 tokenId, address token);

    /// @notice `msg.value` was below the quoted gross required to settle a native receivable.
    error Receivables__Underpaid(uint256 required, uint256 provided);

    /// @notice A native refund of the payer's excess failed.
    error Receivables__NativeRefundFailed(address to, uint256 amount);

    /// @notice The net push to the creditor failed (a contract creditor that rejects the asset/native).
    error Receivables__CreditorPushFailed(address creditor, uint256 amount);

    /// @notice A token took a fee on transfer: the pulled balance delta did not match the gross.
    error Receivables__FeeOnTransferToken(uint256 expected, uint256 received);

    /// @notice A royalty fraction above 100% (`> _feeDenominator()`) was supplied.
    error Receivables__RoyaltyTooHigh(uint96 feeNumerator, uint96 denominator);

    // ──────────────────────── views ────────────────────────

    /// @notice Read a full receivable record by token id.
    /// @param tokenId The receivable / token id.
    /// @return The {Receivable} (zeroed, `status == NONE`, if it never existed or was burned).
    function receivableOf(uint256 tokenId) external view returns (Receivable memory);

    /// @notice The current creditor of an OPEN receivable — the live NFT holder.
    /// @dev    Reverts (ERC-721 `ownerOf`) for a non-existent/burned token; the creditor is never
    ///         stored, only derived, so it is always exactly one address per OPEN receivable.
    /// @param tokenId The receivable / token id.
    /// @return The address that holds the token and will receive the net at settlement.
    function creditorOf(uint256 tokenId) external view returns (address);

    /// @notice Whether a receivable can be paid right now (it exists and is `OPEN`).
    /// @param tokenId The receivable / token id.
    /// @return True iff the receivable is `OPEN`.
    function isPayable(uint256 tokenId) external view returns (bool);

    /// @notice The next token id {mint} will assign (the head of the monotonic id counter).
    /// @return The next receivable id (≥ 1).
    function nextTokenId() external view returns (uint256);

    /// @notice The collection-level metadata URI (EIP-7572). Marketplaces read this for the
    ///         collection name/description/image.
    /// @return The contract-level metadata URI.
    function contractURI() external view returns (string memory);

    // ──────────────────────── mutating ────────────────────────

    /// @notice Mint an OPEN receivable as a transferable/factorable ERC-721 to an initial creditor. Only
    ///         the Router owner of `merchantId` may mint, and that merchant's Router `payout` MUST be
    ///         this contract (the conduit invariant).
    /// @param merchantId The Router merchant whose fee policy + treasury the settlement composes.
    /// @param creditor   The initial holder / creditor (the NFT recipient; non-zero).
    /// @param debtor     address(0) ⇒ anyone may settle; else only this address may pay.
    /// @param token      The settlement token (address(0) = native).
    /// @param amountUsd8 The face value in USD (8 decimals, must be > 0).
    /// @param dueBy      Informational maturity (0 = none; payment is still allowed while OPEN).
    /// @param uri        The per-token metadata URI (ERC-721 metadata / ERC-4906); "" for none.
    /// @return tokenId   The newly assigned receivable / token id (≥ 1).
    function mint(
        uint256 merchantId,
        address creditor,
        address debtor,
        address token,
        uint256 amountUsd8,
        uint64 dueBy,
        string calldata uri
    ) external returns (uint256 tokenId);

    /// @notice Settle an OPEN, token-denominated receivable exactly once. Pulls the quoted gross from the
    ///         payer, routes it through the Router fee-split, pays the NET to the CURRENT holder, and
    ///         burns the token.
    /// @param tokenId The receivable to settle.
    /// @param orderId An opaque reference echoed into the Router receipt's `orderId`.
    function pay(uint256 tokenId, bytes32 orderId) external;

    /// @notice Settle an OPEN, native-denominated receivable exactly once, refunding any excess
    ///         `msg.value`. Pays the NET to the current holder and burns the token.
    /// @param tokenId The receivable to settle.
    /// @param orderId An opaque reference echoed into the Router receipt's `orderId`.
    function payNative(uint256 tokenId, bytes32 orderId) external payable;

    /// @notice Cancel an unpaid receivable and burn its token. Only the Router merchant's owner may
    ///         cancel it; a SETTLED receivable can never be cancelled (its token no longer exists).
    /// @param tokenId The receivable to cancel.
    function cancel(uint256 tokenId) external;

    /// @notice Set the default ERC-2981 royalty taken on secondary sales of receivables (the
    ///         factoring-fee signal a marketplace voluntarily honors).
    /// @param receiver     The royalty recipient (address(0) clears the default royalty).
    /// @param feeNumerator The royalty fraction in `_feeDenominator()` units (bps; 500 = 5%).
    function setDefaultRoyalty(address receiver, uint96 feeNumerator) external;

    /// @notice Set the per-token ERC-2981 royalty for a specific receivable, overriding the default.
    /// @param tokenId      The receivable / token id.
    /// @param receiver     The royalty recipient.
    /// @param feeNumerator The royalty fraction in `_feeDenominator()` units (bps).
    function setTokenRoyalty(uint256 tokenId, address receiver, uint96 feeNumerator) external;

    /// @notice Set the collection-level metadata URI (EIP-7572 `contractURI`).
    /// @param newContractURI The new contract-level metadata URI.
    function setContractURI(string calldata newContractURI) external;
}
