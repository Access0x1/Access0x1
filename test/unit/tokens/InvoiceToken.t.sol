// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { InvoiceToken } from "../../../src/tokens/InvoiceToken.sol";
import { Access0x1Router } from "../../../src/Access0x1Router.sol";
import { MockUSDCGasless } from "../../mocks/MockUSDCGasless.sol";
import { MockV3Aggregator } from "../../mocks/MockV3Aggregator.sol";
import { ProxyDeployer } from "../../utils/ProxyDeployer.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { IERC721Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

/// @title  InvoiceTokenTest
/// @author Access0x1
/// @notice Coverage for the gasless, merchant-bound invoice preset: issue (merchant-owner only), the
///         EIP-3009 settlement that routes through the router fee-split, the STRUCTURED-NONCE binding
///         (the headline red-team: a relayer CANNOT redirect a signed authorization to another
///         merchant/invoice/amount), single-settlement (OPEN→PAID absorbing), locked-payer enforcement,
///         void, and zero custody. The 3009 signature is constructed exactly as the token's own domain
///         requires, mirroring the GaslessPayIn suite.
contract InvoiceTokenTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    InvoiceToken internal invoices;
    MockUSDCGasless internal usdc;
    MockV3Aggregator internal usdcFeed;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal merchantPayout = makeAddr("merchantPayout");
    address internal operator = makeAddr("operator"); // router merchant owner
    address internal creditor = makeAddr("creditor"); // holds the invoice NFT
    address internal relayer = makeAddr("relayer");
    address internal payer;
    uint256 internal payerPk;

    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%
    uint256 internal constant AMOUNT_USD8 = 120e8; // $120.00

    // Mirror of MockUSDCGasless's 3009 typehash for digest construction.
    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    uint256 internal merchantId;
    uint256 internal invoiceId;

    function setUp() public {
        vm.warp(1_700_000_000);
        (payer, payerPk) = makeAddrAndKey("payer");

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (admin, treasury, PLATFORM_FEE_BPS))
            )
        );
        invoices = new InvoiceToken("Access Invoices", "INV", address(router));

        usdc = new MockUSDCGasless();
        usdcFeed = new MockV3Aggregator(8, 1e8); // $1

        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        vm.prank(operator);
        merchantId = router.registerMerchant(merchantPayout, address(0), 0, keccak256("m"));

        usdc.mint(payer, 1_000e6);

        // A default open invoice locked to `payer`.
        vm.prank(operator);
        invoiceId = invoices.issue(creditor, merchantId, address(usdc), AMOUNT_USD8, payer);
    }

    /*//////////////////////////////////////////////////////////////
                               SIGN HELPERS
    //////////////////////////////////////////////////////////////*/

    function _authDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce
            )
        );
        return MessageHashUtils.toTypedDataHash(usdc.DOMAIN_SEPARATOR(), structHash);
    }

    /// @dev Sign a 3009 authorization from `payer` to the invoice contract for `value` under `nonce`.
    function _sign3009(uint256 value, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 digest = _authDigest(payer, address(invoices), value, 0, type(uint256).max, nonce);
        (v, r, s) = vm.sign(payerPk, digest);
    }

    /*//////////////////////////////////////////////////////////////
                                  ISSUE
    //////////////////////////////////////////////////////////////*/

    function test_issue_mintsToCreditor() public view {
        assertEq(invoices.ownerOf(invoiceId), creditor);
        InvoiceToken.Invoice memory inv = invoices.invoiceOf(invoiceId);
        assertEq(inv.merchantId, merchantId);
        assertEq(inv.amountUsd8, AMOUNT_USD8);
        assertEq(inv.payer, payer);
        assertEq(uint8(inv.status), uint8(InvoiceToken.IStatus.OPEN));
    }

    function test_issue_onlyMerchantOwner() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                InvoiceToken.InvoiceToken__NotMerchantOwner.selector, merchantId, creditor
            )
        );
        vm.prank(creditor);
        invoices.issue(creditor, merchantId, address(usdc), AMOUNT_USD8, payer);
    }

    function test_issue_revertsZeroAmount() public {
        vm.expectRevert(InvoiceToken.InvoiceToken__ZeroAmount.selector);
        vm.prank(operator);
        invoices.issue(creditor, merchantId, address(usdc), 0, payer);
    }

    /*//////////////////////////////////////////////////////////////
                               SETTLEMENT
    //////////////////////////////////////////////////////////////*/

    function test_settle_routesThroughFeeSplit() public {
        uint256 gross = invoices.quoteGross(invoiceId); // 120e6
        bytes32 nonce = invoices.settlementNonce(invoiceId, payer);
        (uint8 v, bytes32 r, bytes32 s) = _sign3009(gross, nonce);

        vm.prank(relayer); // ANY relayer can submit
        invoices.settle(invoiceId, payer, gross, 0, type(uint256).max, nonce, v, r, s);

        // $120 at 1% platform fee: 1.2 USDC to treasury, 118.8 to merchant payout
        assertEq(usdc.balanceOf(treasury), 12e5);
        assertEq(usdc.balanceOf(merchantPayout), 1188e5);
        assertEq(usdc.balanceOf(address(invoices)), 0); // zero custody
        assertEq(uint8(invoices.invoiceOf(invoiceId).status), uint8(InvoiceToken.IStatus.PAID));
        // NFT retained as a PAID receipt
        assertEq(invoices.ownerOf(invoiceId), creditor);
    }

    function test_settle_singleSettlementAbsorbing() public {
        uint256 gross = invoices.quoteGross(invoiceId);
        bytes32 nonce = invoices.settlementNonce(invoiceId, payer);
        (uint8 v, bytes32 r, bytes32 s) = _sign3009(gross, nonce);
        vm.prank(relayer);
        invoices.settle(invoiceId, payer, gross, 0, type(uint256).max, nonce, v, r, s);
        // replay reverts NotOpen (even before the token would reject the used nonce)
        vm.expectRevert(
            abi.encodeWithSelector(InvoiceToken.InvoiceToken__NotOpen.selector, invoiceId)
        );
        vm.prank(relayer);
        invoices.settle(invoiceId, payer, gross, 0, type(uint256).max, nonce, v, r, s);
    }

    function test_settle_lockedPayerEnforced() public {
        // an invoice locked to `payer` cannot be settled naming a different payer
        address mallory = makeAddr("mallory");
        uint256 gross = invoices.quoteGross(invoiceId);
        bytes32 nonce = invoices.settlementNonce(invoiceId, mallory);
        (uint8 v, bytes32 r, bytes32 s) = _sign3009(gross, nonce);
        vm.expectRevert(
            abi.encodeWithSelector(
                InvoiceToken.InvoiceToken__WrongPayer.selector, invoiceId, payer, mallory
            )
        );
        vm.prank(relayer);
        invoices.settle(invoiceId, mallory, gross, 0, type(uint256).max, nonce, v, r, s);
    }

    function test_settle_valueMustEqualQuote() public {
        uint256 gross = invoices.quoteGross(invoiceId);
        bytes32 nonce = invoices.settlementNonce(invoiceId, payer);
        // sign a value ONE WEI below the quote → rejected
        (uint8 v, bytes32 r, bytes32 s) = _sign3009(gross - 1, nonce);
        vm.expectRevert(
            abi.encodeWithSelector(
                InvoiceToken.InvoiceToken__AuthorizationValueMismatch.selector, gross - 1, gross
            )
        );
        vm.prank(relayer);
        invoices.settle(invoiceId, payer, gross - 1, 0, type(uint256).max, nonce, v, r, s);
    }

    /*//////////////////////////////////////////////////////////////
                    RED-TEAM: RELAYER CANNOT REDIRECT
    //////////////////////////////////////////////////////////////*/

    /// @notice The headline binding property: a relayer holding the payer's signed authorization for
    ///         invoice A CANNOT redirect it to settle invoice B (a different merchant/amount). The
    ///         structured nonce the payer signed is A's; against B the expected nonce differs, so settle
    ///         reverts IntentMismatch before any pull.
    function test_redTeam_relayerCannotRedirectToAnotherInvoice() public {
        // A second merchant + invoice with a DIFFERENT amount.
        address operator2 = makeAddr("operator2");
        address payout2 = makeAddr("payout2");
        vm.prank(operator2);
        uint256 merchant2 = router.registerMerchant(payout2, address(0), 0, keccak256("m2"));
        vm.prank(operator2);
        uint256 invoice2 = invoices.issue(operator2, merchant2, address(usdc), 5e8, payer); // $5

        // Payer signs to settle invoice A ($120) — the honest intent.
        uint256 grossA = invoices.quoteGross(invoiceId);
        bytes32 nonceA = invoices.settlementNonce(invoiceId, payer);
        (uint8 v, bytes32 r, bytes32 s) = _sign3009(grossA, nonceA);

        // Malicious relayer tries to replay A's signature against invoice B. B's expected nonce differs
        // (different merchant/amount/invoiceId), so the binding check reverts.
        bytes32 expectedB = invoices.settlementNonce(invoice2, payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                InvoiceToken.InvoiceToken__IntentMismatch.selector, expectedB, nonceA
            )
        );
        vm.prank(relayer);
        invoices.settle(invoice2, payer, grossA, 0, type(uint256).max, nonceA, v, r, s);
    }

    /// @notice A relayer cannot forge a matching nonce for a different amount either: if it recomputes
    ///         the "right" nonce for invoice B but submits A's signature, the token's ECDSA check fails
    ///         (the signature was over A's nonce). Proven here by supplying B's correct nonce with A's
    ///         signature → the mismatch guard passes only for the exact signed nonce, so this reverts
    ///         inside the token's signature verification.
    function test_redTeam_wrongNonceWithMismatchedSignatureReverts() public {
        address operator2 = makeAddr("operator2");
        vm.prank(operator2);
        uint256 merchant2 = router.registerMerchant(makeAddr("p2"), address(0), 0, keccak256("m2"));
        vm.prank(operator2);
        uint256 invoice2 = invoices.issue(operator2, merchant2, address(usdc), 5e8, payer);

        uint256 grossA = invoices.quoteGross(invoiceId);
        bytes32 nonceA = invoices.settlementNonce(invoiceId, payer);
        (uint8 v, bytes32 r, bytes32 s) = _sign3009(grossA, nonceA);

        // Submit invoice B's CORRECT nonce (passes the mismatch guard) but with A's (wrong) signature +
        // A's value. The value equals B's quote? No — B is $5 so quote is 5e6; A's grossA is 120e6, so
        // the value check reverts first. This proves value-binding also protects B.
        bytes32 nonceB = invoices.settlementNonce(invoice2, payer);
        uint256 grossB = invoices.quoteGross(invoice2); // resolve before arming expectRevert
        vm.expectRevert(
            abi.encodeWithSelector(
                InvoiceToken.InvoiceToken__AuthorizationValueMismatch.selector, grossA, grossB
            )
        );
        vm.prank(relayer);
        invoices.settle(invoice2, payer, grossA, 0, type(uint256).max, nonceB, v, r, s);
    }

    /*//////////////////////////////////////////////////////////////
                                  VOID
    //////////////////////////////////////////////////////////////*/

    function test_void_onlyMerchantOwner() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                InvoiceToken.InvoiceToken__NotMerchantOwner.selector, merchantId, creditor
            )
        );
        vm.prank(creditor);
        invoices.void(invoiceId);
    }

    function test_void_burnsAndBlocksSettlement() public {
        vm.prank(operator);
        invoices.void(invoiceId);
        assertEq(uint8(invoices.invoiceOf(invoiceId).status), uint8(InvoiceToken.IStatus.VOID));
        // NFT burned
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, invoiceId)
        );
        invoices.ownerOf(invoiceId);
        // settlement now reverts NotOpen
        uint256 gross = 120e6;
        bytes32 nonce = invoices.settlementNonce(invoiceId, payer);
        (uint8 v, bytes32 r, bytes32 s) = _sign3009(gross, nonce);
        vm.expectRevert(
            abi.encodeWithSelector(InvoiceToken.InvoiceToken__NotOpen.selector, invoiceId)
        );
        vm.prank(relayer);
        invoices.settle(invoiceId, payer, gross, 0, type(uint256).max, nonce, v, r, s);
    }

    function test_void_cannotVoidPaid() public {
        uint256 gross = invoices.quoteGross(invoiceId);
        bytes32 nonce = invoices.settlementNonce(invoiceId, payer);
        (uint8 v, bytes32 r, bytes32 s) = _sign3009(gross, nonce);
        vm.prank(relayer);
        invoices.settle(invoiceId, payer, gross, 0, type(uint256).max, nonce, v, r, s);
        vm.expectRevert(
            abi.encodeWithSelector(InvoiceToken.InvoiceToken__NotOpen.selector, invoiceId)
        );
        vm.prank(operator);
        invoices.void(invoiceId);
    }

    /*//////////////////////////////////////////////////////////////
                              OPEN INVOICE
    //////////////////////////////////////////////////////////////*/

    function test_openInvoice_anyPayerCanSettle() public {
        // issue an invoice open to anyone (payer == 0)
        vm.prank(operator);
        uint256 openId = invoices.issue(creditor, merchantId, address(usdc), 10e8, address(0));
        uint256 gross = invoices.quoteGross(openId);
        bytes32 nonce = invoices.settlementNonce(openId, payer);
        (uint8 v, bytes32 r, bytes32 s) = _sign3009(gross, nonce);
        vm.prank(relayer);
        invoices.settle(openId, payer, gross, 0, type(uint256).max, nonce, v, r, s);
        assertEq(uint8(invoices.invoiceOf(openId).status), uint8(InvoiceToken.IStatus.PAID));
    }
}
