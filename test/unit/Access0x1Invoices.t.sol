// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Invoices } from "../../src/Access0x1Invoices.sol";
import { IAccess0x1Invoices } from "../../src/interfaces/IAccess0x1Invoices.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { FeeOnTransferToken } from "../mocks/FeeOnTransferToken.sol";
import { RevertingReceiver } from "../mocks/RevertingReceiver.sol";

/// @notice The invoice contract's unit suite: the full surface in one fixture — constructor, create,
///         the token + native pay paths (with adversarial mocks), void, the terminal-state machine,
///         and the views. Asserts the contract composes the router's fee-split exactly (net + fee ==
///         gross, zero custody) without re-deriving it.
contract Access0x1InvoicesTest is Test {
    Access0x1Router internal router;
    Access0x1Invoices internal invoices;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%

    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient");
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5%
    bytes32 internal constant NAME_HASH = keccak256("acme");

    MockV3Aggregator internal nativeFeed; // ETH/USD, 8 dp
    MockV3Aggregator internal usdcFeed; // USDC/USD, 8 dp
    MockUSDC internal usdc; // 6 dp

    address internal payer = makeAddr("payer");
    address internal stranger = makeAddr("stranger");
    bytes32 internal constant NONCE = keccak256("nonce-1");
    bytes32 internal constant MEMO = keccak256("memo");

    uint256 internal merchantId;

    function setUp() public virtual {
        vm.warp(1_700_000_000); // fixed, fresh time so the feeds stay inside the staleness window

        router = new Access0x1Router(owner, treasury, PLATFORM_FEE_BPS);
        invoices = new Access0x1Invoices(router);

        nativeFeed = new MockV3Aggregator(8, 2000e8); // ETH/USD = $2000
        usdcFeed = new MockV3Aggregator(8, 1e8); // USDC/USD = $1
        usdc = new MockUSDC();
        vm.startPrank(owner);
        router.setPriceFeed(address(0), address(nativeFeed));
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);
    }

    /// @dev The two-leg split for the default merchant.
    function _fees(uint256 gross)
        internal
        pure
        returns (uint256 platformFee, uint256 merchantFee, uint256 net)
    {
        platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        net = gross - platformFee - merchantFee;
    }

    /// @dev Create the default OPEN, unlocked, USDC invoice for $20.
    function _createToken(address lockedPayer) internal returns (uint256 id) {
        vm.prank(merchantOwner);
        id = invoices.createInvoice(merchantId, lockedPayer, address(usdc), 20e8, 0, MEMO);
    }

    /// @dev Create the default OPEN native invoice for $20.
    function _createNative(address lockedPayer) internal returns (uint256 id) {
        vm.prank(merchantOwner);
        id = invoices.createInvoice(merchantId, lockedPayer, address(0), 20e8, 0, MEMO);
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_constructorSetsRouterAndNextId() public view {
        assertEq(address(invoices.router()), address(router));
        assertEq(invoices.nextInvoiceId(), 1); // 0 stays the unset sentinel
    }

    function test_constructorRevertsOnZeroRouter() public {
        vm.expectRevert(IAccess0x1Invoices.Access0x1Invoices__ZeroAddress.selector);
        new Access0x1Invoices(Access0x1Router(payable(address(0))));
    }

    /*//////////////////////////////////////////////////////////////
                             CREATE INVOICE
    //////////////////////////////////////////////////////////////*/

    function test_createStoresInvoiceAndEmits() public {
        vm.expectEmit(true, true, true, true, address(invoices));
        emit IAccess0x1Invoices.InvoiceCreated(1, merchantId, payer, address(usdc), 20e8, 123, MEMO);
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, payer, address(usdc), 20e8, 123, MEMO);

        assertEq(id, 1);
        IAccess0x1Invoices.Invoice memory inv = invoices.invoiceOf(id);
        assertEq(inv.merchantId, merchantId);
        assertEq(inv.payer, payer);
        assertEq(inv.token, address(usdc));
        assertEq(inv.amountUsd8, 20e8);
        assertEq(inv.dueBy, 123);
        assertEq(uint8(inv.status), uint8(IAccess0x1Invoices.InvStatus.OPEN));
        assertEq(inv.memoHash, MEMO);
        assertEq(invoices.nextInvoiceId(), 2);
        assertTrue(invoices.isPayable(id));
    }

    function test_createIncrementsId() public {
        assertEq(_createToken(address(0)), 1);
        assertEq(_createToken(address(0)), 2);
    }

    function test_createRevertsOnZeroAmount() public {
        vm.prank(merchantOwner);
        vm.expectRevert(IAccess0x1Invoices.Access0x1Invoices__ZeroAmount.selector);
        invoices.createInvoice(merchantId, payer, address(usdc), 0, 0, MEMO);
    }

    function test_createRevertsWhenNotMerchantOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotMerchantOwner.selector,
                merchantId,
                stranger
            )
        );
        invoices.createInvoice(merchantId, payer, address(usdc), 20e8, 0, MEMO);
    }

    function test_createRevertsForUnknownMerchant() public {
        // An unknown merchant has owner == address(0); no caller can equal it, so this rejects.
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotMerchantOwner.selector, 999, merchantOwner
            )
        );
        invoices.createInvoice(999, payer, address(usdc), 20e8, 0, MEMO);
    }

    function test_createAllowsUnknownTokenAtIssueTime() public {
        // Token validity is checked at pay time (router.quote), not creation — so a request can be
        // issued before a token is allowlisted.
        MockUSDC other = new MockUSDC();
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, payer, address(other), 20e8, 0, MEMO);
        assertTrue(invoices.isPayable(id));
    }

    /*//////////////////////////////////////////////////////////////
                                 PAY
    //////////////////////////////////////////////////////////////*/

    function test_paySettlesThroughRouterFeeSplit() public {
        uint256 id = _createToken(payer);
        uint256 gross = router.quote(merchantId, address(usdc), 20e8);
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _fees(gross);

        usdc.mint(payer, 100e6);
        vm.startPrank(payer);
        usdc.approve(address(invoices), gross);

        vm.expectEmit(true, true, true, true, address(invoices));
        emit IAccess0x1Invoices.InvoicePaid(id, payer, address(usdc), gross, NONCE);
        invoices.pay(id, NONCE);
        vm.stopPrank();

        // Router fee-split landed exactly: net → payout, platform cut → treasury, surcharge → feeRecipient.
        assertEq(usdc.balanceOf(payout), net);
        assertEq(usdc.balanceOf(treasury), platformFee);
        assertEq(usdc.balanceOf(feeRecipient), merchantFee);
        assertEq(net + platformFee + merchantFee, gross); // net + fee == gross
        // Zero custody at BOTH hops.
        assertEq(usdc.balanceOf(address(invoices)), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
        // Terminal state.
        assertEq(uint8(invoices.invoiceOf(id).status), uint8(IAccess0x1Invoices.InvStatus.PAID));
        assertFalse(invoices.isPayable(id));
        // No dangling allowance left for the router.
        assertEq(usdc.allowance(address(invoices), address(router)), 0);
    }

    function test_payByAnyoneWhenUnlocked() public {
        uint256 id = _createToken(address(0)); // unlocked
        uint256 gross = router.quote(merchantId, address(usdc), 20e8);
        usdc.mint(stranger, 100e6);
        vm.startPrank(stranger);
        usdc.approve(address(invoices), gross);
        invoices.pay(id, NONCE);
        vm.stopPrank();
        assertEq(uint8(invoices.invoiceOf(id).status), uint8(IAccess0x1Invoices.InvStatus.PAID));
    }

    function test_payRevertsWhenLockedAndWrongPayer() public {
        uint256 id = _createToken(payer); // locked to `payer`
        uint256 gross = router.quote(merchantId, address(usdc), 20e8);
        usdc.mint(stranger, 100e6);
        vm.startPrank(stranger);
        usdc.approve(address(invoices), gross);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotAuthorizedPayer.selector,
                id,
                payer,
                stranger
            )
        );
        invoices.pay(id, NONCE);
        vm.stopPrank();
    }

    function test_paySecondTimeRevertsNotOpen() public {
        uint256 id = _createToken(address(0));
        uint256 gross = router.quote(merchantId, address(usdc), 20e8);
        usdc.mint(payer, 100e6);
        vm.startPrank(payer);
        usdc.approve(address(invoices), gross * 2);
        invoices.pay(id, NONCE);
        // Second pay: invoice is PAID, not OPEN → revert (single-settlement guard).
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotOpen.selector,
                id,
                IAccess0x1Invoices.InvStatus.PAID
            )
        );
        invoices.pay(id, NONCE);
        vm.stopPrank();
    }

    function test_payRevertsOnUnknownInvoice() public {
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__InvoiceUnknown.selector, 42
            )
        );
        invoices.pay(42, NONCE);
    }

    function test_payRevertsWhenVoided() public {
        uint256 id = _createToken(address(0));
        vm.prank(merchantOwner);
        invoices.void(id);
        usdc.mint(payer, 100e6);
        vm.startPrank(payer);
        usdc.approve(address(invoices), 100e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotOpen.selector,
                id,
                IAccess0x1Invoices.InvStatus.VOID
            )
        );
        invoices.pay(id, NONCE);
        vm.stopPrank();
    }

    function test_payRevertsOnNativeInvoiceWrongPath() public {
        uint256 id = _createNative(address(0));
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__WrongPayPath.selector, id, address(0)
            )
        );
        invoices.pay(id, NONCE);
    }

    function test_payRevertsOnFeeOnTransferToken() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        vm.startPrank(owner);
        router.setTokenAllowed(address(fot), true);
        router.setPriceFeed(address(fot), address(usdcFeed)); // $1
        vm.stopPrank();

        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, payer, address(fot), 20e8, 0, MEMO);
        uint256 gross = router.quote(merchantId, address(fot), 20e8);
        uint256 received = gross - gross / 100; // token skims 1%
        fot.mint(payer, 100e6);
        vm.startPrank(payer);
        fot.approve(address(invoices), gross);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__FeeOnTransferToken.selector, gross, received
            )
        );
        invoices.pay(id, NONCE);
        vm.stopPrank();
    }

    function test_payRevertsOnStalePrice() public {
        uint256 id = _createToken(payer);
        usdcFeed.setRoundData(2, 1e8, block.timestamp, block.timestamp - 3601, 2); // > 1h stale
        usdc.mint(payer, 100e6);
        vm.startPrank(payer);
        usdc.approve(address(invoices), 100e6);
        vm.expectRevert(); // OracleLib__StalePrice bubbles through router.quote
        invoices.pay(id, NONCE);
        vm.stopPrank();
    }

    function test_payRevertsWhenRouterMerchantInactive() public {
        uint256 id = _createToken(payer);
        vm.prank(merchantOwner);
        router.updateMerchant(merchantId, payout, feeRecipient, MERCHANT_FEE_BPS, false);
        usdc.mint(payer, 100e6);
        vm.startPrank(payer);
        usdc.approve(address(invoices), 100e6);
        vm.expectRevert(); // router rejects an inactive merchant; the flip-to-PAID rolls back
        invoices.pay(id, NONCE);
        vm.stopPrank();
        // The whole tx reverted, so the invoice is still OPEN and payable once the merchant is active.
        assertTrue(invoices.isPayable(id));
    }

    /*//////////////////////////////////////////////////////////////
                              PAY NATIVE
    //////////////////////////////////////////////////////////////*/

    function test_payNativeSettlesThroughRouterFeeSplit() public {
        uint256 id = _createNative(payer);
        uint256 gross = router.quote(merchantId, address(0), 20e8);
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _fees(gross);

        vm.deal(payer, 1 ether);
        vm.expectEmit(true, true, true, true, address(invoices));
        emit IAccess0x1Invoices.InvoicePaid(id, payer, address(0), gross, NONCE);
        vm.prank(payer);
        invoices.payNative{ value: gross }(id, NONCE);

        assertEq(payout.balance, net);
        assertEq(treasury.balance, platformFee);
        assertEq(feeRecipient.balance, merchantFee);
        assertEq(net + platformFee + merchantFee, gross);
        assertEq(address(invoices).balance, 0); // zero custody
        assertEq(address(router).balance, 0);
        assertEq(uint8(invoices.invoiceOf(id).status), uint8(IAccess0x1Invoices.InvStatus.PAID));
    }

    function test_payNativeRefundsExcess() public {
        uint256 id = _createNative(payer);
        uint256 gross = router.quote(merchantId, address(0), 20e8);

        vm.deal(payer, 1 ether);
        vm.prank(payer);
        invoices.payNative{ value: gross + 0.3 ether }(id, NONCE);

        assertEq(payer.balance, 1 ether - gross); // net effect: paid exactly gross
        assertEq(address(invoices).balance, 0);
    }

    function test_payNativeRevertsUnderpaid() public {
        uint256 id = _createNative(payer);
        uint256 gross = router.quote(merchantId, address(0), 20e8);
        vm.deal(payer, 1 ether);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__Underpaid.selector, gross, gross - 1
            )
        );
        invoices.payNative{ value: gross - 1 }(id, NONCE);
    }

    function test_payNativeRevertsOnTokenInvoiceWrongPath() public {
        uint256 id = _createToken(address(0));
        vm.deal(payer, 1 ether);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__WrongPayPath.selector, id, address(usdc)
            )
        );
        invoices.payNative{ value: 1 ether }(id, NONCE);
    }

    function test_payNativeRevertsWhenLockedAndWrongPayer() public {
        uint256 id = _createNative(payer);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotAuthorizedPayer.selector,
                id,
                payer,
                stranger
            )
        );
        invoices.payNative{ value: 1 ether }(id, NONCE);
    }

    function test_payNativeSecondTimeRevertsNotOpen() public {
        uint256 id = _createNative(address(0));
        uint256 gross = router.quote(merchantId, address(0), 20e8);
        vm.deal(payer, 1 ether);
        vm.startPrank(payer);
        invoices.payNative{ value: gross }(id, NONCE);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotOpen.selector,
                id,
                IAccess0x1Invoices.InvStatus.PAID
            )
        );
        invoices.payNative{ value: gross }(id, NONCE);
        vm.stopPrank();
    }

    function test_payNativeRevertsWhenRefundFails() public {
        uint256 id = _createNative(address(0)); // unlocked, so the reverting receiver may pay
        uint256 gross = router.quote(merchantId, address(0), 20e8);
        RevertingReceiver badBuyer = new RevertingReceiver();
        vm.deal(address(badBuyer), 1 ether);
        vm.prank(address(badBuyer));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NativeRefundFailed.selector,
                address(badBuyer),
                0.3 ether
            )
        );
        invoices.payNative{ value: gross + 0.3 ether }(id, NONCE);
    }

    /*//////////////////////////////////////////////////////////////
                                 VOID
    //////////////////////////////////////////////////////////////*/

    function test_voidByMerchantOwner() public {
        uint256 id = _createToken(address(0));
        vm.expectEmit(true, false, false, false, address(invoices));
        emit IAccess0x1Invoices.InvoiceVoided(id);
        vm.prank(merchantOwner);
        invoices.void(id);
        assertEq(uint8(invoices.invoiceOf(id).status), uint8(IAccess0x1Invoices.InvStatus.VOID));
        assertFalse(invoices.isPayable(id));
    }

    function test_voidRevertsWhenNotMerchantOwner() public {
        uint256 id = _createToken(address(0));
        vm.prank(stranger);
        // First field is the MERCHANT id (matching {createInvoice}'s convention), not the invoice id.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotMerchantOwner.selector,
                merchantId,
                stranger
            )
        );
        invoices.void(id);
    }

    /// @notice Regression (audit I-2): `void`'s `NotMerchantOwner` carries the MERCHANT id in field one,
    ///         matching {createInvoice}. Pin it on an invoice whose id differs from its merchant id, so a
    ///         decoder following the "first field = merchant id" convention cannot mis-attribute the void.
    function test_voidRevertsWithMerchantIdNotInvoiceId() public {
        // Register a SECOND merchant so the next invoice's id (2) differs from its merchant id.
        vm.prank(merchantOwner);
        uint256 otherMerchant =
            router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(otherMerchant, address(0), address(usdc), 20e8, 0, MEMO);
        assertTrue(id != otherMerchant, "id and merchant id must differ for this regression");

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotMerchantOwner.selector,
                otherMerchant,
                stranger
            )
        );
        invoices.void(id);
    }

    function test_voidRevertsOnUnknownInvoice() public {
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1Invoices.Access0x1Invoices__InvoiceUnknown.selector, 7)
        );
        invoices.void(7);
    }

    function test_voidRevertsWhenAlreadyPaid() public {
        uint256 id = _createToken(address(0));
        uint256 gross = router.quote(merchantId, address(usdc), 20e8);
        usdc.mint(payer, 100e6);
        vm.startPrank(payer);
        usdc.approve(address(invoices), gross);
        invoices.pay(id, NONCE);
        vm.stopPrank();
        // A PAID invoice can never be voided.
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotOpen.selector,
                id,
                IAccess0x1Invoices.InvStatus.PAID
            )
        );
        invoices.void(id);
    }

    function test_voidRevertsWhenAlreadyVoid() public {
        uint256 id = _createToken(address(0));
        vm.startPrank(merchantOwner);
        invoices.void(id);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotOpen.selector,
                id,
                IAccess0x1Invoices.InvStatus.VOID
            )
        );
        invoices.void(id);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function test_invoiceOfUnknownIsZeroed() public view {
        IAccess0x1Invoices.Invoice memory inv = invoices.invoiceOf(123);
        assertEq(inv.merchantId, 0);
        assertEq(uint8(inv.status), uint8(IAccess0x1Invoices.InvStatus.NONE));
        assertFalse(invoices.isPayable(123));
    }
}
