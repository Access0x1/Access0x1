// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Invoices } from "../../src/Access0x1Invoices.sol";
import { IAccess0x1Invoices } from "../../src/interfaces/IAccess0x1Invoices.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

/// @notice The actor that drives the invoice invariant fuzzer through every state-changing path —
///         create, pay (token + native), and void — while keeping the ghost accounting the suite
///         checks the contract against.
/// @dev    The handler owns TWO router merchants (so it can create + void their invoices) and is the
///         sole payer (so it can always authorize a locked or unlocked pay). Every action is written
///         to NEVER revert (the suite runs `fail_on_revert = true`): inputs are `bound`ed and
///         preconditions early-return. Fee/treasury/payout sinks are dedicated, disjoint addresses so
///         every unit in them provably came from the router — that is what makes the conservation and
///         "settles at most once" checks exact.
contract InvoicesHandler is Test {
    Access0x1Router public immutable router;
    Access0x1Invoices public immutable invoices;
    MockUSDC public immutable usdc;
    address public immutable treasury;

    /// @notice The two merchants the handler owns (the frozen canary invoice belongs to merchant A).
    uint256 public merchantA;
    uint256 public merchantB;

    /// @notice Net + fee sinks per merchant. payoutA/feeA back merchant A, payoutB/feeB back B. All
    ///         four + treasury are disjoint so a delivered unit is unambiguously attributable.
    address public payoutA = makeAddr("inv_payoutA");
    address public feeA = makeAddr("inv_feeA");
    address public payoutB = makeAddr("inv_payoutB");
    address public feeB = makeAddr("inv_feeB");

    /// @notice Invoice ids the handler created (the frozen canary is deliberately excluded).
    uint256[] public invoiceIds;

    // ---- ghost accounting (the spec the contract is checked against) ----
    uint256 public ghostGrossSettled; // Σ token gross successfully settled (the value the router split)
    uint256 public ghostGrossSettledNative; // Σ native gross successfully settled
    uint256 public ghostSettleCount; // total number of successful settlements across all invoices
    uint256 public ghostCreatedCount; // total invoices the handler created (excludes the canary)
    mapping(uint256 => uint256) public settleCountOf; // per-invoice settlement count (must be ≤ 1)

    uint16 internal constant MERCHANT_FEE_BPS = 50;

    constructor(
        Access0x1Router router_,
        Access0x1Invoices invoices_,
        MockUSDC usdc_,
        address treasury_
    ) {
        router = router_;
        invoices = invoices_;
        usdc = usdc_;
        treasury = treasury_;
        // Register the two merchants FROM the handler so the handler IS their owner — only then can it
        // create + void their invoices (the router's merchant owner is immutable, so there is no
        // post-hoc transfer). The fee recipient + payout sinks are the handler's dedicated addresses.
        merchantA = router.registerMerchant(payoutA, feeA, MERCHANT_FEE_BPS, keccak256("handlerA"));
        merchantB = router.registerMerchant(payoutB, feeB, MERCHANT_FEE_BPS, keccak256("handlerB"));
    }

    /// @dev Pick a created invoice from a seed; `ok` is false when none exist.
    function _pick(uint256 seed) internal view returns (uint256 id, bool ok) {
        uint256 len = invoiceIds.length;
        if (len == 0) return (0, false);
        id = invoiceIds[seed % len];
        ok = true;
    }

    /*//////////////////////////////////////////////////////////////
                                ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Create an invoice on one of the two merchants, in USDC or native, sometimes locked to
    ///         the handler (the sole payer). The token is recorded on-chain so {pay}/{payNative} pick
    ///         the right path; the two conservation sums are kept per-asset.
    function createInvoice(uint256 merchantSeed, uint256 usdSeed, bool locked, bool native)
        external
    {
        uint256 merchantId = merchantSeed % 2 == 0 ? merchantA : merchantB;
        uint256 usd = bound(usdSeed, 1e8, 100_000e8); // $1 .. $100k
        address lockedPayer = locked ? address(this) : address(0);
        address token = native ? address(0) : address(usdc);
        uint256 id = invoices.createInvoice(merchantId, lockedPayer, token, usd, 0, bytes32(usd));
        invoiceIds.push(id);
        ghostCreatedCount++;
    }

    /// @notice Pay a created TOKEN invoice if it is currently OPEN. Early-returns otherwise (a PAID/
    ///         VOID/native invoice would revert, tripping `fail_on_revert` — which is exactly the
    ///         single-settlement property: the handler can never settle the same invoice twice).
    function pay(uint256 idSeed) external {
        (uint256 id, bool ok) = _pick(idSeed);
        if (!ok) return;
        if (!invoices.isPayable(id)) return; // not OPEN ⇒ skip (replay would revert)
        IAccess0x1Invoices.Invoice memory inv = invoices.invoiceOf(id);
        if (inv.token != address(usdc)) return; // native invoice ⇒ wrong path ⇒ skip

        uint256 gross = router.quote(inv.merchantId, address(usdc), inv.amountUsd8);
        usdc.mint(address(this), gross);
        usdc.approve(address(invoices), gross);
        invoices.pay(id, bytes32(id));

        ghostGrossSettled += gross;
        ghostSettleCount++;
        settleCountOf[id]++;
    }

    /// @notice Pay a created NATIVE invoice if it is currently OPEN. Pays exactly gross (no excess, so
    ///         no refund leg perturbs the handler's own balance), keeping the native conservation sum
    ///         exact. Early-returns on a token/PAID/VOID invoice.
    function payNative(uint256 idSeed) external {
        (uint256 id, bool ok) = _pick(idSeed);
        if (!ok) return;
        if (!invoices.isPayable(id)) return;
        IAccess0x1Invoices.Invoice memory inv = invoices.invoiceOf(id);
        if (inv.token != address(0)) return; // token invoice ⇒ wrong path ⇒ skip

        uint256 gross = router.quote(inv.merchantId, address(0), inv.amountUsd8);
        vm.deal(address(this), gross);
        invoices.payNative{ value: gross }(id, bytes32(id));

        ghostGrossSettledNative += gross;
        ghostSettleCount++;
        settleCountOf[id]++;
    }

    /// @notice Void a created invoice if it is currently OPEN (the handler owns both merchants, so it
    ///         is authorized). Early-returns otherwise.
    function void(uint256 idSeed) external {
        (uint256 id, bool ok) = _pick(idSeed);
        if (!ok) return;
        if (!invoices.isPayable(id)) return; // not OPEN ⇒ skip (a PAID/VOID void would revert)
        invoices.void(id);
    }

    /*//////////////////////////////////////////////////////////////
                              GHOST VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Σ token delivered across every payout + fee + treasury sink — what the router pushed
    ///         out across all settlements. Must equal `ghostGrossSettled` (conservation / net+fee==gross).
    function deliveredToken() external view returns (uint256 total) {
        total += usdc.balanceOf(payoutA);
        total += usdc.balanceOf(feeA);
        total += usdc.balanceOf(payoutB);
        total += usdc.balanceOf(feeB);
        total += usdc.balanceOf(treasury);
    }

    /// @notice Σ native delivered across every sink + any still owed back through the router's rescue
    ///         pull-map. Must equal `ghostGrossSettledNative` (native conservation). All sinks are
    ///         EOAs that accept ETH, so the rescue legs are zero in practice, but they are summed for
    ///         completeness so the invariant holds even if a sink ever queued.
    function deliveredNative() external view returns (uint256 total) {
        total += payoutA.balance + router.rescue(payoutA);
        total += feeA.balance + router.rescue(feeA);
        total += payoutB.balance + router.rescue(payoutB);
        total += feeB.balance + router.rescue(feeB);
        total += treasury.balance + router.rescue(treasury);
    }

    /// @notice The number of invoices created by the handler (for the at-most-once-per-invoice check
    ///         the suite iterates with {invoiceIdAt}).
    function invoiceCount() external view returns (uint256) {
        return invoiceIds.length;
    }

    /// @notice The created invoice id at `index` (for the suite to iterate per-invoice settlement counts).
    function invoiceIdAt(uint256 index) external view returns (uint256) {
        return invoiceIds[index];
    }
}
