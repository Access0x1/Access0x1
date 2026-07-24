// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {
    ReentrancyGuardTransient
} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Access0x1Router } from "../Access0x1Router.sol";
import { IERC3009Authorization } from "../interfaces/IGaslessPayIn.sol";

/// @title  InvoiceToken
/// @author Access0x1
/// @notice A USD-priced INVOICE as an ERC-721 with a GASLESS, MERCHANT-BOUND settlement hook. An
///         operator (a registered {Access0x1Router} merchant's owner) issues an invoice NFT for a USD
///         amount, optionally locked to a single payer; the debtor settles it ONCE — gaslessly, off a
///         single EIP-3009 `transferWithAuthorization` token signature that ANY relayer may submit — and
///         the payment routes through the router fee-split (net→merchant + fee→treasury, priced in-tx),
///         after which the invoice NFT is marked PAID. The invoice itself is a transferable receipt of
///         the obligation (a factor can buy the NFT), but only the terminal PAID transition settles it.
/// @dev    MERCHANT-BINDING (the security core — reused verbatim from the {GaslessPayIn} 3009 rail). The
///         3009 authorization the debtor signs is otherwise MERCHANT-BLIND: the token only sees
///         `(from, to, value, nonce)`. We defeat relayer redirection with a STRUCTURED NONCE: the buyer
///         MUST set the 3009 `nonce` to `settlementNonce(invoiceId, payer)` =
///         `keccak256(chainid, this, merchantId, token, amountUsd8, payer, invoiceId)`. The token
///         signature therefore ALSO covers the merchant, token, amount, and invoice; a relayer that
///         passes a different invoice/merchant/amount recomputes a different expected nonce, so
///         `auth.nonce` no longer matches and settlement reverts BEFORE any pull. No new replay state:
///         the token still marks the 3009 nonce single-use, and the invoice's own OPEN→PAID terminal
///         machine is the second one-shot guard (a replayed settle reverts `NotOpen`).
///
///         COMPOSITION, NOT DUPLICATION. This contract owns the invoice lifecycle + the binding check
///         ONLY. The USD→token quote (in-tx, OracleLib staleness guard), the exact fee-split
///         (`net + fee == gross`), the allowlist, and the zero-custody push all live in
///         {Access0x1Router}; a settle pulls exactly the quoted gross in and routes it out in the same
///         tx, so the contract holds ~zero token afterwards (a residual check enforces it). CEI +
///         `nonReentrant` + `SafeERC20` on the value path.
///
///         AUTHORITY. `merchantId` binds an invoice to a router merchant; only that merchant's router
///         `owner` may {issue} under it or {void} an unpaid one. The contract is immutable + non-custodial
///         (no proxy, no admin key over funds); a clone deploys its own instance against the shared router.
contract InvoiceToken is ERC721, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice The invoice lifecycle. OPEN is the only non-terminal state; PAID and VOID are absorbing.
    enum IStatus {
        NONE,
        OPEN,
        PAID,
        VOID
    }

    /// @notice The shared, audited money spine every settlement routes through.
    Access0x1Router public immutable router;

    /// @notice An invoice record. Immutable at issue except `status`.
    struct Invoice {
        uint256 merchantId; // the router merchant owed
        address token; // the settlement token (allowlisted + priced on the router)
        uint256 amountUsd8; // the amount owed, USD 8 decimals
        address payer; // the locked payer, or address(0) for "anyone may pay"
        IStatus status; // lifecycle
    }

    /// @notice invoiceId (tokenId) ⇒ the invoice record.
    mapping(uint256 invoiceId => Invoice invoice) private _invoices;

    /// @notice The id assigned to the next {issue}. Starts at 1 (0 = unset sentinel).
    uint256 public nextInvoiceId;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice An invoice was issued: NFT `invoiceId` minted to `to` for `amountUsd8` of `token`.
    /// @param  invoiceId  The freshly minted invoice NFT / obligation id.
    /// @param  merchantId The router merchant owed — the seat settlement will pay, regardless of who
    ///                    later holds the NFT.
    /// @param  to         The initial creditor the NFT was minted to (typically the merchant itself, so
    ///                    a factor can buy the receivable).
    /// @param  token      The settlement token the debt is denominated in.
    /// @param  amountUsd8 The amount owed in USD, 8 decimals. The USD figure is what is fixed; the token
    ///                    gross is priced in the settling tx, so it is NOT known at issue time.
    /// @param  payer      The locked payer, or `address(0)` when anyone may settle.
    event InvoiceIssued(
        uint256 indexed invoiceId,
        uint256 indexed merchantId,
        address indexed to,
        address token,
        uint256 amountUsd8,
        address payer
    );

    /// @notice An invoice was settled: `gross` of `token` routed through the fee-split for the holder.
    /// @dev    Emitted only on the successful terminal OPEN→PAID transition, after the zero-residual
    ///         assertion, so its presence is proof the money reached the merchant and none stuck here.
    /// @param  invoiceId The invoice now PAID. Its NFT is deliberately NOT burned — it survives as a
    ///                   transferable proof of payment.
    /// @param  payer     The account whose EIP-3009 signature funded the settlement.
    /// @param  relayer   `msg.sender` — whoever submitted the tx and paid the gas. Untrusted and
    ///                   unrestricted by design: the structured nonce is what binds the payment, so an
    ///                   arbitrary relayer cannot redirect it. Logged for attribution only.
    /// @param  gross     The token amount pulled from the payer and routed through the fee-split.
    event InvoiceSettled(
        uint256 indexed invoiceId, address indexed payer, address indexed relayer, uint256 gross
    );

    /// @notice An unpaid invoice was voided by the merchant owner.
    /// @dev    Terminal and one-directional: a voided invoice can never be settled, and a PAID invoice
    ///         can never be voided. Only reachable while OPEN, so this never cancels a payment that
    ///         already moved money.
    /// @param  invoiceId The invoice moved OPEN→VOID, whose NFT was burned.
    event InvoiceVoided(uint256 indexed invoiceId);

    /// @notice A required address argument was the zero address — the settlement `token` at {issue}, or
    ///         `router_` at construction. Refused rather than stored: a zero token has no feed and no
    ///         allowlist entry, so an invoice denominated in it could never be quoted or settled.
    error InvoiceToken__ZeroAddress();

    /// @notice {issue} was called with `amountUsd8 == 0`. A zero-value invoice has nothing to settle
    ///         and would mint a permanently meaningless obligation NFT.
    error InvoiceToken__ZeroAmount();

    /// @notice No merchant with this id is registered on the {Access0x1Router} (its `owner` reads back
    ///         as the zero address), so there is no seat to owe the money to and no owner to authorize
    ///         the action.
    /// @param  merchantId The id that resolved to no merchant.
    error InvoiceToken__MerchantNotFound(uint256 merchantId);

    /// @notice The caller is not the router `owner` of the invoice's merchant. Gates {issue} and
    ///         {void}, so only the operator that is owed the money may create an obligation under its
    ///         seat or cancel an unpaid one. Authority is read LIVE from the router on every call.
    /// @param  merchantId The merchant whose owner was required.
    /// @param  caller     The address that attempted the call.
    error InvoiceToken__NotMerchantOwner(uint256 merchantId, address caller);

    /// @notice No invoice was ever issued under this id (its status is `NONE`). Distinguished from
    ///         {InvoiceToken__NotOpen} so a caller can tell "never existed" from "already resolved".
    /// @param  invoiceId The unknown invoice id.
    error InvoiceToken__NotFound(uint256 invoiceId);

    /// @notice The invoice exists but is no longer OPEN — it is already PAID or VOID. Both terminal
    ///         states are absorbing, so this is the guard a replayed {settle} hits: the one-shot
    ///         protection that layers on top of the token's own single-use 3009 nonce.
    /// @param  invoiceId The invoice whose status blocked the transition.
    error InvoiceToken__NotOpen(uint256 invoiceId);

    /// @notice The invoice is locked to a specific payer and a different account was presented. The
    ///         lock is enforced here AND cryptographically by the structured nonce, which commits to
    ///         the payer — so a relayer cannot settle a locked invoice with a third party's signature.
    /// @param  invoiceId The locked invoice.
    /// @param  expected  The payer the invoice was locked to.
    /// @param  actual    The payer presented by the caller.
    error InvoiceToken__WrongPayer(uint256 invoiceId, address expected, address actual);

    /// @notice {settle} was called with the zero address as `payer`. Rejected explicitly so a
    ///         malformed call can never reach signature recovery, where a zero address is the classic
    ///         "recovery failed" sentinel.
    error InvoiceToken__ZeroPayer();

    /// @notice THE MERCHANT-BINDING GUARD. The submitted 3009 `nonce` does not equal
    ///         `settlementNonce(invoiceId, payer)`, so the payer's token signature does not commit to
    ///         THIS invoice / merchant / token / amount on THIS chain and contract. Thrown BEFORE any
    ///         pull, which is what stops a relayer redirecting an otherwise merchant-blind EIP-3009
    ///         authorization to a different merchant or amount.
    /// @param  expected The nonce the payer must have signed.
    /// @param  provided The nonce actually submitted.
    error InvoiceToken__IntentMismatch(bytes32 expected, bytes32 provided);

    /// @notice The signed 3009 `value` does not equal the in-tx router quote for the invoice's USD
    ///         amount. A 3009 authorization pulls a FIXED amount, so it must match exactly — an
    ///         inequality means the price moved between signing and submission, and settling anyway
    ///         would under- or over-pay the merchant. The payer re-signs at the new quote.
    /// @param  signed The value the payer authorized.
    /// @param  quoted The gross the router priced in this tx.
    error InvoiceToken__AuthorizationValueMismatch(uint256 signed, uint256 quoted);

    /// @notice The contract's balance rose by less than the authorized gross, i.e. the token takes a
    ///         transfer fee or rebases. Refused: the router is about to be approved for the full gross,
    ///         so a short pull would route money this contract does not hold.
    /// @param  expected The gross that should have arrived.
    /// @param  received What the balance actually rose by.
    error InvoiceToken__PullShortfall(uint256 expected, uint256 received);

    /// @notice ZERO-CUSTODY ASSERTION. After routing, the token balance did not return to its
    ///         pre-settlement level, meaning this contract retained value it should have passed
    ///         straight through. The whole settlement reverts rather than leaving a residual in a
    ///         contract that has no withdrawal path for it.
    /// @param  token   The settlement token.
    /// @param  balance The balance measured after routing.
    error InvoiceToken__CustodyResidual(address token, uint256 balance);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploy a fresh invoice collection wired to the shared router. Immutable, non-custodial.
    /// @param name_   The ERC-721 collection name.
    /// @param symbol_ The ERC-721 collection symbol.
    /// @param router_ The {Access0x1Router} that prices + fee-splits every settlement (non-zero).
    constructor(string memory name_, string memory symbol_, address router_)
        ERC721(name_, symbol_)
    {
        if (router_ == address(0)) revert InvoiceToken__ZeroAddress();
        router = Access0x1Router(router_);
        nextInvoiceId = 1;
    }

    /*//////////////////////////////////////////////////////////////
                                  ISSUE
    //////////////////////////////////////////////////////////////*/

    /// @notice Issue an invoice NFT. Only the router `owner` of `merchantId`. The invoice may be locked
    ///         to a single `payer` (only that address can settle) or open to anyone (`payer == 0`). The
    ///         NFT is minted to `to` (typically the merchant, so a factor can later buy the receivable).
    /// @dev    Deliberately NOT `nonReentrant`, and that is a considered choice rather than an
    ///         oversight — here is the reasoning so a reviewer can check it rather than trust it: the only
    ///         external call is `_safeMint`'s `onERC721Received` callback, and by the time it fires the
    ///         id counter is bumped, the record is written and the event emitted. A receiver that
    ///         re-enters {issue} therefore just mints a second, independent invoice under its own fresh
    ///         id — it cannot overwrite or double-spend the first. No money moves here at all; {issue}
    ///         only records an obligation, so there is no value path to guard.
    /// @dev    Issuing does NOT check that `token` is currently allowlisted or priced on the router.
    ///         Pricing is deferred to settlement time by design (the USD figure is the fixed term), so
    ///         an invoice denominated in a token the router will not quote simply cannot be settled
    ///         until it is wired up — it is never silently settled at a bad price.
    /// @param to         The invoice-NFT holder (the creditor; must accept ERC-721).
    /// @param merchantId The router merchant owed (caller must be its owner).
    /// @param token      The settlement token (allowlisted + priced on the router).
    /// @param amountUsd8 The amount owed, USD 8 decimals (> 0).
    /// @param payer      The locked payer, or `address(0)` for "anyone may settle".
    /// @return invoiceId The minted invoice id.
    function issue(address to, uint256 merchantId, address token, uint256 amountUsd8, address payer)
        external
        returns (uint256 invoiceId)
    {
        if (token == address(0)) revert InvoiceToken__ZeroAddress();
        if (amountUsd8 == 0) revert InvoiceToken__ZeroAmount();
        _requireMerchantOwner(merchantId);

        invoiceId = nextInvoiceId++;
        _invoices[invoiceId] = Invoice({
            merchantId: merchantId,
            token: token,
            amountUsd8: amountUsd8,
            payer: payer,
            status: IStatus.OPEN
        });
        emit InvoiceIssued(invoiceId, merchantId, to, token, amountUsd8, payer);
        _safeMint(to, invoiceId);
    }

    /*//////////////////////////////////////////////////////////////
                          SETTLEMENT (gasless, bound)
    //////////////////////////////////////////////////////////////*/

    /// @notice The structured 3009 nonce the payer MUST sign to settle `invoiceId`. Binds the otherwise
    ///         merchant-blind token authorization to THIS invoice on THIS chain/contract, so a relayer
    ///         cannot redirect the pull to a different merchant/amount/invoice. Recomputed in {settle}
    ///         and required to equal `auth.nonce`.
    /// @param invoiceId The invoice being settled.
    /// @param payer     The paying account (whose 3009 signature this nonce binds).
    /// @return The structured nonce = keccak256(chainid, this, merchantId, token, amountUsd8, payer, invoiceId).
    function settlementNonce(uint256 invoiceId, address payer) public view returns (bytes32) {
        Invoice storage inv = _invoices[invoiceId];
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                inv.merchantId,
                inv.token,
                inv.amountUsd8,
                payer,
                invoiceId
            )
        );
    }

    /// @notice Settle an OPEN invoice gaslessly via the payer's EIP-3009 `transferWithAuthorization`.
    ///         ANY relayer may submit it; the payer is bound by the STRUCTURED NONCE (the token signature
    ///         also covers merchant/token/amount/invoice, so it cannot be redirected). The token is pulled
    ///         directly from the payer into this contract, then routed through {Access0x1Router.payToken}
    ///         (net→merchant + fee→treasury, priced in-tx); the invoice transitions OPEN→PAID.
    /// @dev    CEI + `nonReentrant`. Checks: invoice OPEN, payer matches the lock (if any) and is
    ///         non-zero, `auth.nonce == settlementNonce(...)` (the binding), quote the gross and require
    ///         the signed `value` EQUALS it (a 3009 auth pulls a fixed amount). Effects: mark PAID.
    ///         Interaction: the 3009 pull (NOT try/catch — a failed pull IS the settlement failing, so it
    ///         must revert), verified by the balance delta (rejects fee-on-transfer), then route through
    ///         the router; assert a zero residual (delta) so the contract retains no token.
    /// @param invoiceId The OPEN invoice to settle.
    /// @param payer     The paying account (must match a locked payer; non-zero).
    /// @param value     The signed 3009 transfer value (must equal the in-tx router quote).
    /// @param validAfter  The 3009 validity-window start.
    /// @param validBefore The 3009 validity-window end.
    /// @param nonce     The 3009 nonce — MUST equal `settlementNonce(invoiceId, payer)`.
    /// @param v         ECDSA v.
    /// @param r         ECDSA r.
    /// @param s         ECDSA s.
    function settle(
        uint256 invoiceId,
        address payer,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.status == IStatus.NONE) revert InvoiceToken__NotFound(invoiceId);
        if (inv.status != IStatus.OPEN) revert InvoiceToken__NotOpen(invoiceId);
        if (payer == address(0)) revert InvoiceToken__ZeroPayer();
        // Locked-payer enforcement: an invoice locked to a payer can be settled only by that payer's
        // signature; an open invoice (payer == 0) accepts any payer.
        if (inv.payer != address(0) && inv.payer != payer) {
            revert InvoiceToken__WrongPayer(invoiceId, inv.payer, payer);
        }

        // MERCHANT-BINDING: the 3009 nonce must equal the structured intent nonce. A relayer passing a
        // different invoice/merchant/amount recomputes a different expected value → mismatch → revert
        // BEFORE any pull. Recomputed with `payer` (not the locked field) so an open invoice binds to
        // whoever actually signed.
        bytes32 expectedNonce = settlementNonce(invoiceId, payer);
        if (nonce != expectedNonce) revert InvoiceToken__IntentMismatch(expectedNonce, nonce);

        uint256 merchantId = inv.merchantId;
        address token = inv.token;
        uint256 amountUsd8 = inv.amountUsd8;

        uint256 gross = router.quote(merchantId, token, amountUsd8); // in-tx price
        if (value != gross) revert InvoiceToken__AuthorizationValueMismatch(value, gross);

        // Effect: mark PAID before the external calls (CEI; the terminal machine is the second one-shot
        // guard on top of the token's single-use nonce).
        inv.status = IStatus.PAID;

        // Interaction: direct 3009 pull, with no separate allowance step, of exactly `gross` from the payer into this
        // contract, verified by the balance delta (rejects fee-on-transfer / rebasing). NOT wrapped —
        // a 3009 pull IS the settlement, so its failure MUST revert.
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC3009Authorization(token)
            .transferWithAuthorization(
                payer, address(this), gross, validAfter, validBefore, nonce, v, r, s
            );
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        if (received != gross) revert InvoiceToken__PullShortfall(gross, received);

        _routeToMerchant(merchantId, token, amountUsd8, gross, balBefore, invoiceId);

        // The invoice NFT is left in the holder's wallet as a PAID receipt (not burned) — a paid invoice
        // is a useful, transferable proof-of-payment; the absorbing PAID state prevents re-settlement.
        // Settlement pays the router MERCHANT (net→payout + fee→treasury), never the NFT holder directly.
        emit InvoiceSettled(invoiceId, payer, msg.sender, gross);
    }

    /*//////////////////////////////////////////////////////////////
                                  VOID
    //////////////////////////////////////////////////////////////*/

    /// @notice Void an unpaid invoice. Only the router `owner` of its `merchantId`. OPEN→VOID is
    ///         terminal, so a voided invoice can never be settled. The NFT is burned (a void invoice is
    ///         not a receipt). A PAID invoice cannot be voided (the status guard).
    /// @param invoiceId The OPEN invoice to void.
    function void(uint256 invoiceId) external {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.status == IStatus.NONE) revert InvoiceToken__NotFound(invoiceId);
        if (inv.status != IStatus.OPEN) revert InvoiceToken__NotOpen(invoiceId);
        _requireMerchantOwner(inv.merchantId);

        inv.status = IStatus.VOID;
        emit InvoiceVoided(invoiceId);
        _burn(invoiceId);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice The full invoice record for `invoiceId` (zeroed if it never existed).
    /// @dev    Never reverts, so a UI or router can staticcall it blind. The record SURVIVES both
    ///         terminal transitions — a settled or voided invoice keeps its struct with an absorbing
    ///         `status` — so this is also the post-mortem read. Test existence with
    ///         `status == IStatus.NONE`, never with a zero `amountUsd8`.
    /// @param  invoiceId The invoice id to read.
    /// @return The stored {Invoice} (all-zero, i.e. `status == NONE`, for an id never issued).
    function invoiceOf(uint256 invoiceId) external view returns (Invoice memory) {
        return _invoices[invoiceId];
    }

    /// @notice The in-tx router quote (token gross) for `invoiceId`'s USD amount — what a payer signs.
    /// @dev    A LIVE, MOVING figure, not a stored term: it is re-read from the oracle on every call,
    ///         so it changes with the price and a signature authorizing an older value will be refused
    ///         by {settle}'s exact-match check. Callers should quote and sign in the same breath.
    ///         Unlike the read paths in this contract, this one CAN revert — it bubbles the router's
    ///         staleness / allowlist / missing-feed reverts rather than returning a fabricated price,
    ///         and reverts {InvoiceToken__NotFound} for an id that was never issued. Do not staticcall
    ///         it expecting a safe default.
    /// @param invoiceId The invoice.
    /// @return The token amount owed at the current price.
    function quoteGross(uint256 invoiceId) external view returns (uint256) {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.status == IStatus.NONE) revert InvoiceToken__NotFound(invoiceId);
        return router.quote(inv.merchantId, inv.token, inv.amountUsd8);
    }

    /*//////////////////////////////////////////////////////////////
                                 INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev Route exactly `gross` (already pulled in) to the merchant through the router fee-split, then
    ///      assert zero residual (measured as a DELTA against `balBefore`, so pre-existing dust cannot
    ///      brick settlement). The router re-quotes the SAME `amountUsd8` in this tx (same feed round) and
    ///      pulls the approved gross, pushing net→merchant + fee→treasury. The dangling approval is reset
    ///      to 0 defensively. `net + fee == gross` is the router's audited invariant, never re-derived.
    /// @dev TRUST + FAILURE MODES. The router is the one external contract trusted here, and the trust
    ///      is bounded three ways: the approval is scoped to exactly `gross`, it is revoked in the same
    ///      tx, and the residual assertion independently verifies the outcome. Unlike the sibling
    ///      {BookingToken} release, `payToken` is NOT wrapped in try/catch — a failed route IS the
    ///      settlement failing, so it must bubble and unwind the whole {settle}, leaving the invoice
    ///      OPEN and the payer's 3009 nonce unspent. Reachable only from {settle}, which is
    ///      `nonReentrant`, so the approve → call → revoke window cannot be re-entered.
    /// @param merchantId The router merchant to pay.
    /// @param token      The settlement token already pulled into this contract.
    /// @param amountUsd8 The invoice's USD term, re-quoted by the router within this same tx (and so
    ///                   against the same feed round that priced `gross`).
    /// @param gross      The token amount pulled in, and the exact approval granted to the router.
    /// @param balBefore  The pre-pull balance the zero-residual assertion measures against — a DELTA,
    ///                   so pre-existing dust in this contract cannot brick a settlement.
    /// @param invoiceId  Passed through as the router's opaque order reference.
    function _routeToMerchant(
        uint256 merchantId,
        address token,
        uint256 amountUsd8,
        uint256 gross,
        uint256 balBefore,
        uint256 invoiceId
    ) private {
        IERC20(token).forceApprove(address(router), gross);
        router.payToken(merchantId, token, amountUsd8, bytes32(invoiceId));
        IERC20(token).forceApprove(address(router), 0);

        // Zero-custody delta check: we pulled `gross` in (balance rose to balBefore+gross) and the router
        // pulled exactly that back out, so the balance must return to `balBefore`.
        uint256 balAfter = IERC20(token).balanceOf(address(this));
        if (balAfter != balBefore) revert InvoiceToken__CustodyResidual(token, balAfter);
    }

    /// @dev Revert unless `msg.sender` is the router owner of `merchantId` (single source of truth).
    ///      Read LIVE on every call, never cached at issue time, so transferring the router merchant
    ///      seat moves issue/void authority with it and a former owner loses it in the same tx.
    /// @param merchantId The merchant whose current owner is required.
    function _requireMerchantOwner(uint256 merchantId) private view {
        address owner_ = _merchantOwner(merchantId);
        if (owner_ == address(0)) revert InvoiceToken__MerchantNotFound(merchantId);
        if (msg.sender != owner_) revert InvoiceToken__NotMerchantOwner(merchantId, msg.sender);
    }

    /// @dev Read the router owner of `merchantId` (the `owner` field of the Merchant record).
    ///      `address(0)` means the seat was never registered — every auth check above treats that as
    ///      "unknown merchant" and reverts rather than falling through.
    /// @param merchantId The merchant seat to look up.
    /// @return owner_ The seat's current owner, or `address(0)` if it was never registered.
    function _merchantOwner(uint256 merchantId) private view returns (address owner_) {
        (, owner_,,,,) = router.merchants(merchantId);
    }
}
