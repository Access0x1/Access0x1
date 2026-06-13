// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Invoices } from "../../src/Access0x1Invoices.sol";
import { IAccess0x1Invoices } from "../../src/interfaces/IAccess0x1Invoices.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { FeeOnTransferToken } from "../mocks/FeeOnTransferToken.sol";

/// @notice An 18-decimal USD stablecoin (the "Arc trap": native USDC on Arc is 18-dec while the
///         ERC-20 USDC most chains ship is 6-dec, and the Chainlink feed is 8-dec). Used to prove the
///         conservation + zero-custody invariants survive the widest decimals spread the router faces.
contract Mock18DecStable is ERC20 {
    constructor() ERC20("Arc USDC", "aUSDC") { }

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice A contract payer that OVERPAYS a native invoice and then reverts when the excess refund
///         lands. The point: the invoice must NOT silently swallow the excess (law #4 — refunds are
///         never blocked/lost) — instead the whole tx reverts, the invoice stays OPEN, and the same
///         payer can settle later by paying the EXACT gross (no refund leg). Also used to attempt a
///         re-entrant settle of a DIFFERENT invoice during the refund hook.
contract NativeRefundGriefer {
    Access0x1Invoices public immutable invoices;
    bool public rejectRefund = true;
    uint256 public reenterId; // 0 ⇒ no reentry attempt; else try to pay this id during the refund
    bytes32 private constant N = keccak256("griefer");

    constructor(Access0x1Invoices invoices_) {
        invoices = invoices_;
    }

    function setRejectRefund(bool v) external {
        rejectRefund = v;
    }

    function setReenter(uint256 id) external {
        reenterId = id;
    }

    function payOverpaying(uint256 id, uint256 value) external {
        invoices.payNative{ value: value }(id, N);
    }

    function payExact(uint256 id, uint256 value) external {
        invoices.payNative{ value: value }(id, N);
    }

    receive() external payable {
        if (reenterId != 0) {
            // Attempt to settle a *different* invoice while the outer payNative still holds the guard.
            invoices.payNative{ value: msg.value }(reenterId, keccak256("reenter-other"));
        }
        if (rejectRefund) revert("griefer: no refund");
    }
}

/// @notice Deep adversarial pass on Access0x1Invoices — the attacks the happy-path attack suite does
///         NOT cover: the 18-dec Arc-trap conservation, native-refund griefing + cross-invoice
///         re-entry during the refund hook, dust-rounding conservation at $0.00000001, void-after-pay
///         races, fee-on-transfer rejection on the invoice hop, and the unknown-merchant / id-0 edges.
contract Access0x1InvoicesRedTeam is Test {
    Access0x1Router internal router;
    Access0x1Invoices internal invoices;
    MockV3Aggregator internal nativeFeed;
    MockV3Aggregator internal usdcFeed;
    MockV3Aggregator internal arcFeed;
    MockUSDC internal usdc;
    Mock18DecStable internal arc;
    FeeOnTransferToken internal fot;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal payer = makeAddr("payer");
    address internal attacker = makeAddr("attacker");
    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5%
    bytes32 internal constant MEMO = keccak256("memo");

    uint256 internal merchantId;

    function setUp() public {
        vm.warp(1_700_000_000);
        router = new Access0x1Router(owner, treasury, PLATFORM_FEE_BPS);
        invoices = new Access0x1Invoices(router);

        nativeFeed = new MockV3Aggregator(8, 2000e8); // ETH/USD
        usdcFeed = new MockV3Aggregator(8, 1e8); // USDC/USD (6-dec token)
        arcFeed = new MockV3Aggregator(8, 1e8); // aUSDC/USD (18-dec token)
        usdc = new MockUSDC();
        arc = new Mock18DecStable();
        fot = new FeeOnTransferToken();

        vm.startPrank(owner);
        router.setPriceFeed(address(0), address(nativeFeed));
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        router.setTokenAllowed(address(arc), true);
        router.setPriceFeed(address(arc), address(arcFeed));
        router.setTokenAllowed(address(fot), true);
        router.setPriceFeed(address(fot), address(usdcFeed));
        vm.stopPrank();

        vm.prank(merchantOwner);
        merchantId =
            router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, keccak256("acme"));
    }

    /*//////////////////////////////////////////////////////////////
                    ATTACK 1 — ARC 18-DEC TRAP CONSERVATION
    //////////////////////////////////////////////////////////////*/

    /// @notice ATTACK: try to break `net + fee == gross` (and zero custody) on the widest decimals
    ///         spread — 18-dec token, 8-dec feed, 8-dec USD price. If the invoice's pull / approve /
    ///         router-split mishandled the scale, value would be created, destroyed, or stranded.
    function testFuzz_attack_arc18DecConservationAndZeroCustody(uint256 usd) public {
        usd = bound(usd, 1e8, 1_000_000e8); // $1 .. $1M
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, address(0), address(arc), usd, 0, MEMO);

        uint256 gross = router.quote(merchantId, address(arc), usd);
        arc.mint(payer, gross);

        vm.startPrank(payer);
        arc.approve(address(invoices), gross);
        invoices.pay(id, keccak256("arc"));
        vm.stopPrank();

        // Conservation: every minted unit landed in a sink; the invoice + router keep nothing.
        assertEq(
            arc.balanceOf(payout) + arc.balanceOf(feeRecipient) + arc.balanceOf(treasury),
            gross,
            "net+fee must equal gross on the 18-dec path"
        );
        assertEq(arc.balanceOf(address(invoices)), 0, "invoice zero custody");
        assertEq(arc.balanceOf(address(router)), 0, "router zero custody");
        assertEq(arc.balanceOf(payer), 0, "payer fully debited gross, no skim");
    }

    /*//////////////////////////////////////////////////////////////
              ATTACK 2 — NATIVE REFUND GRIEFING (law #4)
    //////////////////////////////////////////////////////////////*/

    /// @notice ATTACK: a contract payer overpays a native invoice and reverts on the refund. The
    ///         invoice must NOT swallow the excess — the whole tx reverts and the invoice stays OPEN,
    ///         leaving no funds stranded in the invoice or router. The same payer then settles by
    ///         paying the EXACT gross (no refund leg), proving the griefer only hurts itself.
    function test_attack_nativeRefundRevertDoesNotStrandOrSwallow() public {
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, address(0), address(0), 20e8, 0, MEMO);
        uint256 gross = router.quote(merchantId, address(0), 20e8);

        NativeRefundGriefer g = new NativeRefundGriefer(invoices);
        vm.deal(address(g), 100 ether);

        // Overpay → refund reverts → whole tx reverts. Nothing settled, nothing stranded.
        vm.expectRevert();
        g.payOverpaying(id, gross + 5 ether);

        assertTrue(invoices.isPayable(id), "invoice must stay OPEN after a reverted overpay");
        assertEq(address(invoices).balance, 0, "no native stranded in invoice");
        assertEq(address(router).balance, 0, "no native stranded in router");
        assertEq(payout.balance, 0, "merchant not paid by a reverted tx");

        // The griefer can still settle by paying the exact gross — no refund leg to revert on.
        g.payExact(id, gross);
        assertFalse(invoices.isPayable(id), "exact-value settlement succeeds");
        assertEq(payout.balance + treasury.balance + feeRecipient.balance, gross, "conserved");
        assertEq(address(invoices).balance, 0, "zero custody after exact settle");
    }

    /// @notice ATTACK: during the native refund hook, the griefer re-enters the invoice to settle a
    ///         DIFFERENT open invoice. The shared `nonReentrant` guard must block the inner call —
    ///         which makes the refund hook revert, reverting the whole tx; BOTH invoices stay OPEN.
    function test_attack_crossInvoiceReentryDuringRefundBlocked() public {
        vm.startPrank(merchantOwner);
        uint256 idA = invoices.createInvoice(merchantId, address(0), address(0), 20e8, 0, MEMO);
        uint256 idB = invoices.createInvoice(merchantId, address(0), address(0), 20e8, 0, MEMO);
        vm.stopPrank();
        uint256 gross = router.quote(merchantId, address(0), 20e8);

        NativeRefundGriefer g = new NativeRefundGriefer(invoices);
        g.setRejectRefund(false); // the only revert should come from the blocked re-entry
        g.setReenter(idB); // try to settle B while paying A
        vm.deal(address(g), 100 ether);

        vm.expectRevert(); // ReentrancyGuardReentrantCall bubbles up and reverts the outer tx
        g.payOverpaying(idA, gross + 1 ether);

        assertTrue(invoices.isPayable(idA), "A stays OPEN");
        assertTrue(invoices.isPayable(idB), "B stays OPEN, no cross-invoice double-spend");
        assertEq(address(invoices).balance, 0);
        assertEq(payout.balance, 0);
    }

    /*//////////////////////////////////////////////////////////////
              ATTACK 3 — DUST ROUNDING CONSERVATION
    //////////////////////////////////////////////////////////////*/

    /// @notice ATTACK: the smallest possible price ($0.00000001 = 1e0 in 8-dec USD) — try to make the
    ///         ceil-rounded quote, the fee floors, and the net subtraction disagree so `net + fee !=
    ///         gross`. The split is computed by the router; this proves the invoice hop preserves it
    ///         exactly even when fees floor to zero on a 1-wei-ish gross.
    function test_attack_dustPriceConservationNoLeak() public {
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, address(0), address(usdc), 1, 0, MEMO); // $1e-8

        uint256 gross = router.quote(merchantId, address(usdc), 1);
        assertGt(gross, 0, "ceil rounding keeps gross > 0");
        usdc.mint(payer, gross);

        vm.startPrank(payer);
        usdc.approve(address(invoices), gross);
        invoices.pay(id, keccak256("dust"));
        vm.stopPrank();

        assertEq(
            usdc.balanceOf(payout) + usdc.balanceOf(feeRecipient) + usdc.balanceOf(treasury),
            gross,
            "dust gross fully conserved"
        );
        assertEq(usdc.balanceOf(address(invoices)), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    /*//////////////////////////////////////////////////////////////
              ATTACK 4 — FEE-ON-TRANSFER REJECTED AT THE INVOICE HOP
    //////////////////////////////////////////////////////////////*/

    /// @notice ATTACK: settle with a fee-on-transfer token. The invoice's own `_pullExact` balance-delta
    ///         check must reject it BEFORE routing, so the router never splits a short gross. The flip
    ///         to PAID rolls back with the revert, so the invoice stays OPEN.
    function test_attack_feeOnTransferRejectedKeepsInvoiceOpen() public {
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, address(0), address(fot), 20e8, 0, MEMO);
        uint256 gross = router.quote(merchantId, address(fot), 20e8);

        fot.mint(payer, gross * 2);
        vm.startPrank(payer);
        fot.approve(address(invoices), gross * 2);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__FeeOnTransferToken.selector,
                gross,
                gross - gross / 100 // 1% skimmed by the token
            )
        );
        invoices.pay(id, keccak256("fot"));
        vm.stopPrank();

        assertTrue(invoices.isPayable(id), "invoice stays OPEN after a rejected FOT pull");
        assertEq(fot.balanceOf(address(invoices)), 0, "no FOT stranded in invoice");
    }

    /*//////////////////////////////////////////////////////////////
              ATTACK 5 — VOID / PAY TERMINAL-STATE RACES & AUTH
    //////////////////////////////////////////////////////////////*/

    /// @notice ATTACK: a non-owner tries to void someone else's invoice (tenant boundary). Must revert,
    ///         and the invoice stays OPEN and payable.
    function test_attack_strangerCannotVoid() public {
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, address(0), address(usdc), 20e8, 0, MEMO);

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotMerchantOwner.selector, id, attacker
            )
        );
        invoices.void(id);
        assertTrue(invoices.isPayable(id));
    }

    /// @notice ATTACK: void after paying (terminal race) — a void on a PAID invoice must revert; and a
    ///         pay after a void must revert. Both terminal states are absorbing.
    function test_attack_voidAfterPayAndPayAfterVoidBothRevert() public {
        vm.startPrank(merchantOwner);
        uint256 paidId =
            invoices.createInvoice(merchantId, address(0), address(usdc), 20e8, 0, MEMO);
        uint256 voidId =
            invoices.createInvoice(merchantId, address(0), address(usdc), 20e8, 0, MEMO);
        vm.stopPrank();
        uint256 gross = router.quote(merchantId, address(usdc), 20e8);

        usdc.mint(payer, gross * 2);
        vm.startPrank(payer);
        usdc.approve(address(invoices), gross * 2);
        invoices.pay(paidId, keccak256("p"));
        vm.stopPrank();

        // void(PAID) reverts
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotOpen.selector,
                paidId,
                IAccess0x1Invoices.InvStatus.PAID
            )
        );
        invoices.void(paidId);

        // pay(VOID) reverts
        vm.prank(merchantOwner);
        invoices.void(voidId);
        vm.startPrank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotOpen.selector,
                voidId,
                IAccess0x1Invoices.InvStatus.VOID
            )
        );
        invoices.pay(voidId, keccak256("p2"));
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
              ATTACK 6 — UNKNOWN-MERCHANT / ID-0 / WRONG-PATH EDGES
    //////////////////////////////////////////////////////////////*/

    /// @notice ATTACK: create against a never-registered merchant (owner == address(0)). Must revert —
    ///         no caller equals the zero owner, so an unknown merchant can never have an invoice issued.
    function test_attack_createOnUnknownMerchantReverts() public {
        uint256 ghostMerchant = 99_999;
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotMerchantOwner.selector,
                ghostMerchant,
                attacker
            )
        );
        invoices.createInvoice(ghostMerchant, address(0), address(usdc), 20e8, 0, MEMO);
    }

    /// @notice ATTACK: pay / void invoice id 0 (the unset sentinel) and any never-created id. Both must
    ///         revert `InvoiceUnknown` — a zeroed slot reads as NONE and is never payable or voidable.
    function test_attack_payAndVoidUnknownIdRevert() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1Invoices.Access0x1Invoices__InvoiceUnknown.selector, 0)
        );
        invoices.pay(0, keccak256("x"));

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__InvoiceUnknown.selector, 4242
            )
        );
        invoices.payNative{ value: 1 ether }(4242, keccak256("x"));

        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1Invoices.Access0x1Invoices__InvoiceUnknown.selector, 7)
        );
        invoices.void(7);
    }

    /// @notice ATTACK: route a native invoice through `pay` (the token path) and a token invoice through
    ///         `payNative`. Both must revert `WrongPayPath` — the settlement asset can never be coerced.
    function test_attack_wrongPayPathReverts() public {
        vm.startPrank(merchantOwner);
        uint256 nativeId = invoices.createInvoice(merchantId, address(0), address(0), 20e8, 0, MEMO);
        uint256 tokenId =
            invoices.createInvoice(merchantId, address(0), address(usdc), 20e8, 0, MEMO);
        vm.stopPrank();

        usdc.mint(payer, 1000e6);
        vm.deal(payer, 10 ether);
        vm.startPrank(payer);
        usdc.approve(address(invoices), 1000e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__WrongPayPath.selector, nativeId, address(0)
            )
        );
        invoices.pay(nativeId, keccak256("wp"));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__WrongPayPath.selector, tokenId, address(usdc)
            )
        );
        invoices.payNative{ value: 1 ether }(tokenId, keccak256("wp"));
        vm.stopPrank();
    }

    /// @notice ATTACK: underpay a native invoice (msg.value < gross). Must revert `Underpaid`, flip
    ///         rolls back, invoice stays OPEN — no partial settlement.
    function test_attack_nativeUnderpayReverts() public {
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, address(0), address(0), 20e8, 0, MEMO);
        uint256 gross = router.quote(merchantId, address(0), 20e8);

        vm.deal(payer, gross);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__Underpaid.selector, gross, gross - 1
            )
        );
        invoices.payNative{ value: gross - 1 }(id, keccak256("u"));
        assertTrue(invoices.isPayable(id));
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK 7 — NATIVE OVERPAY: EXACT REFUND, NO DANGLING CUSTODY
    //////////////////////////////////////////////////////////////*/

    /// @notice ATTACK: overpay a native invoice by an arbitrary excess from an EOA. Try to make the
    ///         invoice keep the excess (custody break) or refund the wrong amount. The buyer must be
    ///         refunded `msg.value - gross` to the wei, the sinks must net exactly `gross`, and the
    ///         invoice + router must hold zero afterwards.
    function testFuzz_attack_nativeOverpayRefundsExactNoCustody(uint256 excess) public {
        excess = bound(excess, 0, 50 ether);
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, address(0), address(0), 20e8, 0, MEMO);
        uint256 gross = router.quote(merchantId, address(0), 20e8);

        vm.deal(payer, gross + excess);
        vm.prank(payer);
        invoices.payNative{ value: gross + excess }(id, keccak256("over"));

        assertEq(payer.balance, excess, "buyer refunded exactly the excess");
        assertEq(payout.balance + treasury.balance + feeRecipient.balance, gross, "sinks net gross");
        assertEq(address(invoices).balance, 0, "invoice holds zero native");
        assertEq(address(router).balance, 0, "router holds zero native");
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK 8 — NO DANGLING ROUTER ALLOWANCE AFTER A TOKEN PAY
    //////////////////////////////////////////////////////////////*/

    /// @notice ATTACK: after a token settlement, probe for a leftover invoice→router allowance an
    ///         attacker (or a later buggy router call) could drain. The invoice resets the approval to
    ///         0 defensively, so the allowance must be exactly 0 after the happy path.
    function test_attack_noDanglingRouterAllowanceAfterTokenPay() public {
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, address(0), address(usdc), 20e8, 0, MEMO);
        uint256 gross = router.quote(merchantId, address(usdc), 20e8);

        usdc.mint(payer, gross);
        vm.startPrank(payer);
        usdc.approve(address(invoices), gross);
        invoices.pay(id, keccak256("t"));
        vm.stopPrank();

        assertEq(
            usdc.allowance(address(invoices), address(router)),
            0,
            "no residual invoice->router allowance"
        );
        assertEq(usdc.balanceOf(address(invoices)), 0, "no residual token custody");
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK 9 — PAUSED ROUTER GATES PAY-INS, NOTHING STRANDED
    //////////////////////////////////////////////////////////////*/

    /// @notice ATTACK: settle an invoice while the router is paused. The router's `whenNotPaused` must
    ///         revert the settlement; the invoice's flip-to-PAID rolls back with it (invoice stays
    ///         OPEN), and no funds are pulled or stranded. After unpause the same invoice settles once.
    function test_attack_pausedRouterBlocksPayThenResumes() public {
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, address(0), address(usdc), 20e8, 0, MEMO);
        uint256 gross = router.quote(merchantId, address(usdc), 20e8);
        usdc.mint(payer, gross);

        vm.prank(owner);
        router.pause();

        vm.startPrank(payer);
        usdc.approve(address(invoices), gross);
        vm.expectRevert(); // EnforcedPause bubbles from the router
        invoices.pay(id, keccak256("paused"));
        vm.stopPrank();

        assertTrue(invoices.isPayable(id), "invoice stays OPEN while router paused");
        assertEq(usdc.balanceOf(address(invoices)), 0, "no token pulled during paused revert");
        assertEq(usdc.balanceOf(payer), gross, "payer not debited");

        vm.prank(owner);
        router.unpause();
        vm.prank(payer);
        invoices.pay(id, keccak256("resumed"));
        assertFalse(invoices.isPayable(id), "settles once after unpause");
        assertEq(
            usdc.balanceOf(payout) + usdc.balanceOf(treasury) + usdc.balanceOf(feeRecipient), gross
        );
    }
}
