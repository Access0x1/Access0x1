// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Access0x1Router } from "./Access0x1Router.sol";
import { IAccess0x1Invoices } from "./interfaces/IAccess0x1Invoices.sol";

/// @title  Access0x1Invoices
/// @author Access0x1
/// @notice The simplest Access0x1 commerce primitive: a USD-priced, pay-ONCE payment request. An
///         operator (a registered {Access0x1Router} merchant's owner) issues a request for
///         `amountUsd8`, optionally locked to one payer and/or stamped with an informational `dueBy`;
///         anyone (or only the locked payer) pays it ONCE; the payment is priced USD→token in-tx and
///         settled THROUGH the router fee-split, so the invoice earns the same application fee as a
///         direct payment and `net + fee == gross` is proven by the router, never re-derived here.
/// @dev    COMPOSES, never duplicates: this contract owns LIFECYCLE/ELIGIBILITY only. The fee-split,
///         the USD→token quote (via {OracleLib}'s staleness guard), the zero-custody push, and the
///         merchant registry / owner-auth all live in {Access0x1Router}; an invoice `pay` becomes the
///         router's `msg.sender` for exactly one settlement, holding ~zero balance afterwards. There
///         is NO escrow in v0 — `pay` is a straight pull → router → split → push in a single tx.
///
///         Idempotency / single-settlement is enforced by the terminal-state machine itself:
///         `OPEN → {PAID | VOID}` is one-way and `PAID`/`VOID` are absorbing, so a replayed `pay`
///         reverts `Access0x1Invoices__NotOpen` (the on-chain UNIQUE-index / ON-CONFLICT-DO-NOTHING).
///         CEI + `nonReentrant` + `SafeERC20` guard every value path; tenant isolation is inherited
///         from the router (a pay against invoice X routes only to invoice X's immutable `merchantId`).
contract Access0x1Invoices is IAccess0x1Invoices, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The native-token sentinel: `address(0)` as a token means the chain's native coin.
    address private constant NATIVE = address(0);

    /// @notice The shared, audited payments router this contract composes. Immutable — the fee-split,
    ///         pricing, merchant registry, and zero-custody push are all delegated to it, so there is
    ///         no admin surface here to repoint it (a new router = a new Invoices deployment).
    Access0x1Router public immutable router;

    /// @notice invoiceId ⇒ the request record. Public getter for the frontend/SDK; {invoiceOf}
    ///         returns the same data as a struct for typed callers.
    mapping(uint256 => Invoice) private _invoices;

    /// @notice The id assigned to the next {createInvoice}. Starts at 1, so 0 is an unset sentinel
    ///         (matching the router's `nextMerchantId` convention).
    uint256 public nextInvoiceId;

    /// @param router_ The deployed {Access0x1Router} this contract settles every payment through.
    constructor(Access0x1Router router_) {
        if (address(router_) == address(0)) revert Access0x1Invoices__ZeroAddress();
        router = router_;
        nextInvoiceId = 1;
    }

    /*//////////////////////////////////////////////////////////////
                                CREATE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Invoices
    /// @dev    `onlyMerchantOwner`: the issuer must own the router merchant the payment settles to —
    ///         read live from `router.merchants(merchantId).owner`, so the single source of truth for
    ///         tenant authorization is the audited registry, never a copy here. The four economic
    ///         fields are written ONCE and never mutated (the immutable policy snapshot); only `status`
    ///         changes after this. `token`/`feed` validity is NOT checked at creation — it is enforced
    ///         in-tx at `pay` time by the router's `quote` (allowlist + feed + staleness), so a request
    ///         can be issued before a token is allowlisted and still settles safely once it is.
    function createInvoice(
        uint256 merchantId,
        address payer,
        address token,
        uint256 amountUsd8,
        uint64 dueBy,
        bytes32 memoHash
    ) external returns (uint256 id) {
        if (amountUsd8 == 0) revert Access0x1Invoices__ZeroAmount();
        // Authorize against the router's registry: the caller must be this merchant's owner. A
        // never-registered merchant has owner == address(0), which no caller can equal, so an unknown
        // merchant is rejected by the same check (msg.sender can never be the zero address).
        address merchantOwner = _merchantOwner(merchantId);
        if (msg.sender != merchantOwner) {
            revert Access0x1Invoices__NotMerchantOwner(merchantId, msg.sender);
        }

        id = nextInvoiceId++;
        _invoices[id] = Invoice({
            merchantId: merchantId,
            payer: payer,
            token: token,
            amountUsd8: amountUsd8,
            dueBy: dueBy,
            status: InvStatus.OPEN,
            memoHash: memoHash
        });
        emit InvoiceCreated(id, merchantId, payer, token, amountUsd8, dueBy, memoHash);
    }

    /*//////////////////////////////////////////////////////////////
                                  PAY
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Invoices
    /// @dev    CEI: checks (OPEN + payer authorization + token path) → effect (flip to PAID BEFORE any
    ///         external call, so a re-entrant `pay` finds the invoice no longer OPEN and reverts) →
    ///         interactions (pull the quoted gross from the payer, approve the router, route through
    ///         the fee-split). The router quotes the SAME gross in the same tx (identical feed round),
    ///         so the amount pulled is exactly what the router splits. `nonReentrant` is belt-and-
    ///         suspenders on top of the state flip. The contract holds ~zero token balance afterwards:
    ///         the router pulls the full approval and pushes net + fee out in the same call (zero
    ///         custody). A fee-on-transfer token is rejected by the balance-delta check before routing.
    function pay(uint256 id, bytes32 clientNonce) external nonReentrant {
        Invoice storage inv = _invoices[id];
        address token = _authorizePay(inv, id);
        if (token == NATIVE) revert Access0x1Invoices__WrongPayPath(id, token);

        uint256 merchantId = inv.merchantId;
        uint256 amountUsd8 = inv.amountUsd8;

        // EFFECT — flip to terminal PAID before any interaction. This is the single-settlement /
        // idempotency guard: a replay (re-entrant or later) reverts at `_authorizePay`'s NotOpen check.
        inv.status = InvStatus.PAID;

        // INTERACTIONS — quote, pull the exact gross from the payer, route through the router split.
        uint256 gross = router.quote(merchantId, token, amountUsd8); // allowlist + feed + staleness
        _pullExact(token, msg.sender, gross);

        // Approve the router for exactly this settlement and route through its audited fee-split. The
        // router pulls `gross` (its own in-tx quote equals ours — same feed round) and pushes
        // net → merchant payout + fee → treasury, all in this tx. `orderId = clientNonce` ties the
        // router receipt (which carries the authoritative net/fee split) back to the off-chain request.
        IERC20(token).forceApprove(address(router), gross);
        router.payToken(merchantId, token, amountUsd8, clientNonce);
        // The router pulled the full approval; reset any dangling allowance to 0 defensively so no
        // stale approval can ever be reused (it is already 0 on the happy path).
        IERC20(token).forceApprove(address(router), 0);

        emit InvoicePaid(id, msg.sender, token, gross, clientNonce);
    }

    /// @inheritdoc IAccess0x1Invoices
    /// @dev    The native mirror of {pay}. CEI: flip to PAID, quote the gross, require `msg.value`
    ///         covers it, forward exactly `gross` into `router.payNative` (which splits + pushes), then
    ///         refund the buyer's excess. A failed refund DOES revert (the buyer is present and must
    ///         not silently lose the excess); a net/fee push that fails is queued to the router's
    ///         `rescue` pull-map by the router itself — never blocked. `nonReentrant` + state-flip-first.
    function payNative(uint256 id, bytes32 clientNonce) external payable nonReentrant {
        Invoice storage inv = _invoices[id];
        address token = _authorizePay(inv, id);
        if (token != NATIVE) revert Access0x1Invoices__WrongPayPath(id, token);

        uint256 merchantId = inv.merchantId;
        uint256 amountUsd8 = inv.amountUsd8;

        // EFFECT — terminal flip before any interaction (idempotency / single-settlement).
        inv.status = InvStatus.PAID;

        // INTERACTIONS — quote, check msg.value, forward exactly gross to the router, refund excess.
        uint256 gross = router.quote(merchantId, NATIVE, amountUsd8);
        if (msg.value < gross) revert Access0x1Invoices__Underpaid(gross, msg.value);

        // Forward exactly `gross` to the router; it re-quotes the same gross in this tx (same feed
        // round) so the value sent matches what it splits, and it refunds itself nothing.
        router.payNative{ value: gross }(merchantId, amountUsd8, clientNonce);

        uint256 refund = msg.value - gross;
        if (refund > 0) {
            // slither-disable-next-line low-level-calls
            (bool ok,) = msg.sender.call{ value: refund }("");
            if (!ok) revert Access0x1Invoices__NativeRefundFailed(msg.sender, refund);
        }

        // gross == net + fee (the router split). The exact breakdown lives in the router's own
        // `PaymentReceived` receipt keyed on this `clientNonce` as `orderId`.
        emit InvoicePaid(id, msg.sender, NATIVE, gross, clientNonce);
    }

    /*//////////////////////////////////////////////////////////////
                                  VOID
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Invoices
    /// @dev    `onlyMerchantOwner` + OPEN-only: a PAID invoice can never be voided (it is terminal),
    ///         and only the merchant owner can cancel an unpaid request. `OPEN → VOID` is one-way.
    function void(uint256 id) external {
        Invoice storage inv = _invoices[id];
        if (inv.status == InvStatus.NONE) revert Access0x1Invoices__InvoiceUnknown(id);
        address merchantOwner = _merchantOwner(inv.merchantId);
        if (msg.sender != merchantOwner) {
            // First field is the MERCHANT id (the convention this error family follows — see
            // {createInvoice} and the sibling router error), not the invoice id, so an off-chain
            // decoder attributes the failed void to the right merchant.
            revert Access0x1Invoices__NotMerchantOwner(inv.merchantId, msg.sender);
        }
        if (inv.status != InvStatus.OPEN) revert Access0x1Invoices__NotOpen(id, inv.status);

        inv.status = InvStatus.VOID;
        emit InvoiceVoided(id);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Invoices
    function invoiceOf(uint256 id) external view returns (Invoice memory) {
        return _invoices[id];
    }

    /// @inheritdoc IAccess0x1Invoices
    function isPayable(uint256 id) external view returns (bool) {
        return _invoices[id].status == InvStatus.OPEN;
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev Read a router merchant's owner. A never-registered merchant returns `address(0)`, which is
    ///      how an unknown merchant is rejected by every owner-equality check (no caller is address(0)).
    function _merchantOwner(uint256 merchantId) private view returns (address) {
        (, address owner,,,,) = router.merchants(merchantId);
        return owner;
    }

    /// @dev The shared pay-path precondition gate: the invoice must exist, be OPEN, and (if locked)
    ///      `msg.sender` must be the locked payer. Returns the invoice's immutable settlement token so
    ///      the caller can branch on the native/ERC-20 path. Reverts otherwise — no state is mutated.
    function _authorizePay(Invoice storage inv, uint256 id) private view returns (address token) {
        InvStatus status = inv.status;
        if (status == InvStatus.NONE) revert Access0x1Invoices__InvoiceUnknown(id);
        if (status != InvStatus.OPEN) revert Access0x1Invoices__NotOpen(id, status);
        address lockedPayer = inv.payer;
        if (lockedPayer != address(0) && msg.sender != lockedPayer) {
            revert Access0x1Invoices__NotAuthorizedPayer(id, lockedPayer, msg.sender);
        }
        token = inv.token;
    }

    /// @dev Pull exactly `amount` of an ERC-20 in, verifying via the balance delta that the token did
    ///      not skim (fee-on-transfer / rebasing) — those are rejected so the router always splits the
    ///      full gross. Mirrors the router's own `_pullExact` so the doctrine is identical at both hops.
    function _pullExact(address token, address from, uint256 amount) private {
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(from, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        if (received != amount) revert Access0x1Invoices__FeeOnTransferToken(amount, received);
    }
}
