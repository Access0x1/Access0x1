// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";

import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Invoices } from "../../src/Access0x1Invoices.sol";
import { IAccess0x1Invoices } from "../../src/interfaces/IAccess0x1Invoices.sol";

import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";

/// @title  InvoicePayOnce — a payment request that can be paid EXACTLY once
/// @author Access0x1
/// @notice SCENARIO: a freelance designer sends a client a $1,200 invoice. The client pays it in USDC,
///         the money settles through the same router fee-split, and then — the property that matters —
///         a SECOND attempt to pay the same invoice REVERTS. An invoice is a one-shot: a double-pay
///         (whether an honest double-click or a malicious replay) can never charge the client twice.
///
///         What an auditor is checking:
///           1. Single settlement: OPEN -> PAID is one-way and PAID is absorbing. The state flips to
///              PAID BEFORE any external call (CEI), so even a re-entrant pay finds it no longer OPEN.
///           2. The payment routes through the audited router (net + fee == gross proven there); the
///              invoice contract holds ~zero token after (zero custody).
///           3. A locked invoice can only be paid by its named payer.
///           4. An unpaid invoice can be voided by the merchant, and a voided invoice is unpayable.
contract InvoicePayOnceScenarioTest is Test {
    Access0x1Router internal router;
    Access0x1Invoices internal invoices;

    MockUSDC internal usdc;
    MockV3Aggregator internal usdcFeed;

    address internal platformAdmin = makeAddr("access0x1-platform-admin");
    address internal treasury = makeAddr("access0x1-treasury");
    address internal designer = makeAddr("freelance-designer"); // the merchant owner
    address internal designerPayout = makeAddr("designer-payout");
    address internal client = makeAddr("invoice-client"); // the named payer

    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%
    uint256 internal constant INVOICE_USD8 = 1_200e8; // a $1,200 design invoice

    uint256 internal merchantId;

    function setUp() public {
        vm.warp(1_700_000_000);

        router = new Access0x1Router(platformAdmin, treasury, PLATFORM_FEE_BPS);
        invoices = new Access0x1Invoices(router);

        usdc = new MockUSDC();
        usdcFeed = new MockV3Aggregator(8, 1e8);

        vm.startPrank(platformAdmin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        vm.prank(designer);
        merchantId = router.registerMerchant(
            designerPayout, address(0), 0, keccak256("freelance-designer")
        );

        usdc.mint(client, 100_000e6);
        vm.prank(client);
        usdc.approve(address(invoices), type(uint256).max);
    }

    /// @notice The designer invoices the client; the client pays once; a second pay reverts.
    function test_scenario_invoice_paidOnce_secondPayReverts() public {
        // The designer issues a $1,200 invoice LOCKED to this one client.
        vm.prank(designer);
        uint256 id = invoices.createInvoice(
            merchantId, client, address(usdc), INVOICE_USD8, 0, keccak256("memo-design-job")
        );
        assertTrue(invoices.isPayable(id), "freshly created invoice is payable");

        uint256 gross = router.quote(merchantId, address(usdc), INVOICE_USD8); // 1_200e6
        assertEq(gross, 1_200e6, "$1,200 at $1/USDC == 1,200 USDC");
        uint256 platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        uint256 net = gross - platformFee;

        uint256 clientBefore = usdc.balanceOf(client);
        uint256 payoutBefore = usdc.balanceOf(designerPayout);
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        // ── The client pays. One transaction settles through the router fee-split. ──────────────────
        vm.prank(client);
        invoices.pay(id, keccak256("clientNonce-pay-1"));

        assertEq(usdc.balanceOf(client), clientBefore - gross, "client paid exactly the gross once");
        assertEq(usdc.balanceOf(designerPayout), payoutBefore + net, "designer paid the net");
        assertEq(usdc.balanceOf(treasury), treasuryBefore + platformFee, "platform fee -> treasury");
        assertEq(
            usdc.balanceOf(address(invoices)), 0, "invoices contract holds zero (zero custody)"
        );

        // The invoice is now terminal PAID and no longer payable.
        assertFalse(invoices.isPayable(id), "invoice is no longer payable after settlement");
        IAccess0x1Invoices.Invoice memory inv = invoices.invoiceOf(id);
        assertEq(uint8(inv.status), uint8(IAccess0x1Invoices.InvStatus.PAID), "terminal PAID");

        // ── The property that matters: a SECOND pay reverts. No double-charge is possible. ─────────
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotOpen.selector,
                id,
                IAccess0x1Invoices.InvStatus.PAID
            )
        );
        invoices.pay(id, keccak256("clientNonce-pay-2"));

        // The client's balance is untouched by the failed replay — still down exactly one gross.
        assertEq(
            usdc.balanceOf(client), clientBefore - gross, "replay did not charge the client again"
        );
    }

    /// @notice A locked invoice rejects a stranger, and a voided invoice can never be paid.
    function test_scenario_invoice_lockedPayer_andVoid_areEnforced() public {
        address stranger = makeAddr("not-the-client");
        usdc.mint(stranger, 100_000e6);
        vm.prank(stranger);
        usdc.approve(address(invoices), type(uint256).max);

        vm.prank(designer);
        uint256 id = invoices.createInvoice(
            merchantId, client, address(usdc), INVOICE_USD8, 0, keccak256("memo-locked")
        );

        // A stranger cannot pay an invoice locked to someone else.
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotAuthorizedPayer.selector,
                id,
                client,
                stranger
            )
        );
        invoices.pay(id, keccak256("nonce-stranger"));

        // The designer voids the still-unpaid invoice; it then can never be paid.
        vm.prank(designer);
        invoices.void(id);
        assertFalse(invoices.isPayable(id), "voided invoice is not payable");

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotOpen.selector,
                id,
                IAccess0x1Invoices.InvStatus.VOID
            )
        );
        invoices.pay(id, keccak256("nonce-after-void"));
    }
}
