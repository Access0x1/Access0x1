// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IAccess0x1Invoices
/// @author Rensley R. @vyperpilleddev
/// @notice The external surface of {Access0x1Invoices} — a USD-priced, pay-once payment request that
///         composes {Access0x1Router}'s fee-split and {OracleLib}'s in-tx USD→token pricing. An
///         operator issues a request (`amountUsd8`, optional `dueBy`, optional `payer` lock); anyone
///         (or only the locked payer) pays it ONCE; settlement is routed THROUGH the router fee-split
///         (the contract holds ~zero balance), and the invoice moves `OPEN → PAID` one-way. There is
///         NO escrow in v0 — a `pay` is a straight pull → router → split → push in one tx.
/// @dev    Lifecycle is a strict three-state machine: `OPEN` (payable), `PAID` (terminal, settled),
///         `VOID` (terminal, cancelled by the operator). `OPEN` is the only state any money path may
///         leave; `PAID` and `VOID` are absorbing. Money-moving entries are idempotent by the
///         terminal-state guard itself (a second `pay` reverts because the invoice is no longer OPEN),
///         and the `clientNonce` is echoed into the router receipt's `orderId` for off-chain reconcile.
interface IAccess0x1Invoices {
    // ──────────────────────── types ────────────────────────

    /// @notice The lifecycle state of an invoice.
    /// @dev    `OPEN` is the only payable state; `PAID` and `VOID` are terminal (absorbing) — no path
    ///         transitions out of them, which is what makes "settles at most once" hold by construction.
    enum InvStatus {
        NONE, // 0 — never created (a zeroed slot reads as NONE; the create path skips this value)
        OPEN, // 1 — issued and payable
        PAID, // 2 — settled exactly once (terminal)
        VOID // 3 — cancelled by the operator before payment (terminal)
    }

    /// @notice A single USD-priced payment request.
    /// @dev    `merchantId`, `payer`, `token`, `amountUsd8` are write-once at creation and never
    ///         mutated by any path — the immutable policy snapshot (an operator cannot retroactively
    ///         re-price or re-target a live request). Only `status` ever changes after creation.
    struct Invoice {
        uint256 merchantId; // immutable — the router merchant the payment settles to (fee-split target)
        address payer; // immutable — address(0) ⇒ anyone may pay; else the only allowed payer
        address token; // immutable — requested settlement token (address(0) = native)
        uint256 amountUsd8; // immutable — the USD price, 8 decimals (e.g. $29.00 = 29e8)
        uint64 dueBy; // immutable — informational expiry (0 = none); payment is allowed while OPEN
        InvStatus status; // the ONLY mutable field: OPEN → {PAID | VOID}, one-way
        bytes32 memoHash; // immutable — opaque off-chain memo commitment (no PII on-chain)
    }

    // ──────────────────────── events ────────────────────────

    /// @notice A new payment request was issued.
    /// @param id         The newly assigned invoice id (≥ 1).
    /// @param merchantId The router merchant the payment will settle to.
    /// @param payer      The locked payer (address(0) ⇒ open to anyone).
    /// @param token      The requested settlement token (address(0) = native).
    /// @param amountUsd8 The USD price (8 decimals).
    /// @param dueBy      The informational expiry (0 = none).
    /// @param memoHash   The opaque off-chain memo commitment.
    event InvoiceCreated(
        uint256 indexed id,
        uint256 indexed merchantId,
        address indexed payer,
        address token,
        uint256 amountUsd8,
        uint64 dueBy,
        bytes32 memoHash
    );

    /// @notice An invoice was paid exactly once and routed through the router fee-split.
    /// @dev    This is the INVOICE-level anchor. The authoritative `net + fee == gross` breakdown is
    ///         the router's own `PaymentReceived` event, emitted in the same tx and keyed on this
    ///         `clientNonce` (passed to the router as its `orderId`) — so this event deliberately
    ///         carries only the settled `gross` and the linkage, never a re-derived split.
    /// @param id          The invoice that settled.
    /// @param payer       The address that actually paid.
    /// @param token       The settlement token (address(0) = native).
    /// @param gross       The token amount the router quoted and split (the full settled amount).
    /// @param clientNonce The idempotency tag echoed into the router receipt's `orderId`.
    event InvoicePaid(
        uint256 indexed id,
        address indexed payer,
        address indexed token,
        uint256 gross,
        bytes32 clientNonce
    );

    /// @notice An unpaid invoice was cancelled by the merchant owner.
    /// @param id The voided invoice.
    event InvoiceVoided(uint256 indexed id);

    // ──────────────────────── errors ────────────────────────

    /// @notice A zero address was supplied where a non-zero one is required.
    error Access0x1Invoices__ZeroAddress();

    /// @notice A zero USD amount was supplied; a payment request must be for a positive amount.
    error Access0x1Invoices__ZeroAmount();

    /// @notice The referenced invoice was never created.
    error Access0x1Invoices__InvoiceUnknown(uint256 id);

    /// @notice Caller is not the owner of the invoice's router merchant.
    error Access0x1Invoices__NotMerchantOwner(uint256 id, address caller);

    /// @notice The invoice is not in `OPEN` state, so it cannot be paid or voided.
    error Access0x1Invoices__NotOpen(uint256 id, InvStatus status);

    /// @notice The invoice is locked to a specific payer and `msg.sender` is not that payer.
    error Access0x1Invoices__NotAuthorizedPayer(uint256 id, address expected, address caller);

    /// @notice `payNative` was called for a token-denominated invoice, or `pay` for a native one.
    error Access0x1Invoices__WrongPayPath(uint256 id, address token);

    /// @notice `msg.value` was below the quoted gross required to settle a native invoice.
    error Access0x1Invoices__Underpaid(uint256 required, uint256 provided);

    /// @notice A native refund of the buyer's excess failed.
    error Access0x1Invoices__NativeRefundFailed(address to, uint256 amount);

    /// @notice A token took a fee on transfer: the pulled balance delta did not match the gross.
    error Access0x1Invoices__FeeOnTransferToken(uint256 expected, uint256 received);

    // ──────────────────────── views ────────────────────────

    /// @notice Read a full invoice record by id.
    /// @param id The invoice id.
    /// @return The {Invoice} (zeroed, `status == NONE`, if it never existed).
    function invoiceOf(uint256 id) external view returns (Invoice memory);

    /// @notice Whether an invoice can be paid right now (it exists and is `OPEN`).
    /// @param id The invoice id.
    /// @return True iff the invoice is `OPEN`.
    function isPayable(uint256 id) external view returns (bool);

    // ──────────────────────── mutating ────────────────────────

    /// @notice Issue a USD-priced payment request. Only the router merchant's owner may create it.
    /// @param merchantId The router merchant the payment will settle to (must exist).
    /// @param payer      address(0) ⇒ anyone may pay; else only this address may pay.
    /// @param token      The requested settlement token (address(0) = native).
    /// @param amountUsd8 The USD price (8 decimals, must be > 0).
    /// @param dueBy      Informational expiry (0 = none; payment is still allowed while OPEN).
    /// @param memoHash   An opaque off-chain memo commitment (no PII on-chain).
    /// @return id        The newly assigned invoice id (≥ 1).
    function createInvoice(
        uint256 merchantId,
        address payer,
        address token,
        uint256 amountUsd8,
        uint64 dueBy,
        bytes32 memoHash
    ) external returns (uint256 id);

    /// @notice Pay an OPEN, token-denominated invoice exactly once. Pulls the quoted gross from the
    ///         payer and routes it through the router fee-split (net → merchant, fee → treasury).
    /// @param id          The invoice to pay.
    /// @param clientNonce An idempotency tag echoed into the router receipt's `orderId`.
    function pay(uint256 id, bytes32 clientNonce) external;

    /// @notice Pay an OPEN, native-denominated invoice exactly once, refunding any excess `msg.value`.
    /// @param id          The invoice to pay.
    /// @param clientNonce An idempotency tag echoed into the router receipt's `orderId`.
    function payNative(uint256 id, bytes32 clientNonce) external payable;

    /// @notice Cancel an unpaid invoice. Only the router merchant's owner may void it; a PAID invoice
    ///         can never be voided.
    /// @param id The invoice to void.
    function void(uint256 id) external;
}
