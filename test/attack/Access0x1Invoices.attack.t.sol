// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Invoices } from "../../src/Access0x1Invoices.sol";
import { IAccess0x1Invoices } from "../../src/interfaces/IAccess0x1Invoices.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { ReentrantInvoicePayer } from "../mocks/ReentrantInvoicePayer.sol";

/// @notice Adversarial tests for the invoice money path — exploit attempts, not happy-path coverage.
///         A green run here proves the pay-once primitive resists double-settlement (replay + reentry),
///         payer-lock bypass, terminal-state violations, and settling on a stale price.
contract Access0x1InvoicesAttackTest is Test {
    Access0x1Router internal router;
    Access0x1Invoices internal invoices;
    MockV3Aggregator internal nativeFeed;
    MockV3Aggregator internal usdcFeed;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal payer = makeAddr("payer");
    address internal attacker = makeAddr("attacker");
    uint16 internal constant PLATFORM_FEE_BPS = 100;
    uint16 internal constant MERCHANT_FEE_BPS = 50;
    bytes32 internal constant MEMO = keccak256("memo");

    uint256 internal merchantId;

    function setUp() public {
        vm.warp(1_700_000_000);
        router = new Access0x1Router(owner, treasury, PLATFORM_FEE_BPS);
        invoices = new Access0x1Invoices(router);
        nativeFeed = new MockV3Aggregator(8, 2000e8);
        usdcFeed = new MockV3Aggregator(8, 1e8);
        usdc = new MockUSDC();
        vm.startPrank(owner);
        router.setPriceFeed(address(0), address(nativeFeed));
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();
        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, NAME());
    }

    function NAME() internal pure returns (bytes32) {
        return keccak256("acme");
    }

    /// @notice ATTACK: re-entrant double-settlement on the native path. A malicious payer over-pays so
    ///         the refund re-enters `payNative` for the SAME invoice. The `nonReentrant` guard reverts
    ///         the inner call; the refund then fails, so the WHOLE tx reverts — the invoice never
    ///         settles twice, and no funds are stranded (it stays OPEN and fully refundable on retry).
    function test_attack_reentrantNativeDoubleSettleReverts() public {
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, address(0), address(0), 20e8, 0, MEMO);
        uint256 gross = router.quote(merchantId, address(0), 20e8);

        ReentrantInvoicePayer evil = new ReentrantInvoicePayer(invoices, id);
        vm.deal(address(evil), 10 ether);

        // The over-payment triggers a refund → re-entry → inner payNative reverts → refund fails →
        // outer reverts. The whole attack tx reverts.
        vm.expectRevert();
        evil.attack{ value: gross + 1 ether }(gross + 1 ether);

        // Nothing settled: invoice still OPEN, no value left the contracts to a sink.
        assertTrue(invoices.isPayable(id));
        assertEq(payout.balance, 0);
        assertEq(treasury.balance, 0);
        assertEq(address(invoices).balance, 0);
        assertEq(address(router).balance, 0);
    }

    /// @notice ATTACK: replay a token payment. A second `pay` on a now-PAID invoice must revert at the
    ///         terminal-state guard — the on-chain UNIQUE-index. The merchant is paid exactly once.
    function test_attack_tokenReplayCannotDoubleCharge() public {
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, address(0), address(usdc), 20e8, 0, MEMO);
        uint256 gross = router.quote(merchantId, address(usdc), 20e8);

        usdc.mint(payer, 1000e6);
        vm.startPrank(payer);
        usdc.approve(address(invoices), gross * 5);
        invoices.pay(id, keccak256("first"));
        uint256 payoutAfterFirst = usdc.balanceOf(payout);

        // Replay with the same AND a fresh nonce — both revert because the invoice is no longer OPEN.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotOpen.selector,
                id,
                IAccess0x1Invoices.InvStatus.PAID
            )
        );
        invoices.pay(id, keccak256("first"));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotOpen.selector,
                id,
                IAccess0x1Invoices.InvStatus.PAID
            )
        );
        invoices.pay(id, keccak256("second"));
        vm.stopPrank();

        // The merchant was credited exactly once.
        assertEq(usdc.balanceOf(payout), payoutAfterFirst);
    }

    /// @notice ATTACK: a third party tries to pay a payer-locked invoice. The lock holds on both paths.
    function test_attack_lockedPayerCannotBeBypassed() public {
        vm.startPrank(merchantOwner);
        uint256 tokenId = invoices.createInvoice(merchantId, payer, address(usdc), 20e8, 0, MEMO);
        uint256 nativeId = invoices.createInvoice(merchantId, payer, address(0), 20e8, 0, MEMO);
        vm.stopPrank();

        usdc.mint(attacker, 1000e6);
        vm.deal(attacker, 10 ether);
        vm.startPrank(attacker);
        usdc.approve(address(invoices), 1000e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotAuthorizedPayer.selector,
                tokenId,
                payer,
                attacker
            )
        );
        invoices.pay(tokenId, keccak256("n"));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotAuthorizedPayer.selector,
                nativeId,
                payer,
                attacker
            )
        );
        invoices.payNative{ value: 1 ether }(nativeId, keccak256("n"));
        vm.stopPrank();

        assertTrue(invoices.isPayable(tokenId));
        assertTrue(invoices.isPayable(nativeId));
    }

    /// @notice ATTACK: void a PAID invoice (terminal-state violation). Must revert — a settled receipt
    ///         can never be cancelled.
    function test_attack_cannotVoidPaidInvoice() public {
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, address(0), address(usdc), 20e8, 0, MEMO);
        uint256 gross = router.quote(merchantId, address(usdc), 20e8);
        usdc.mint(payer, 100e6);
        vm.startPrank(payer);
        usdc.approve(address(invoices), gross);
        invoices.pay(id, keccak256("p"));
        vm.stopPrank();

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

    /// @notice ATTACK: pay a VOID invoice (terminal-state violation). Must revert on both paths — a
    ///         cancelled request can never be paid.
    function test_attack_cannotPayVoidInvoice() public {
        vm.startPrank(merchantOwner);
        uint256 tokenId =
            invoices.createInvoice(merchantId, address(0), address(usdc), 20e8, 0, MEMO);
        uint256 nativeId = invoices.createInvoice(merchantId, address(0), address(0), 20e8, 0, MEMO);
        invoices.void(tokenId);
        invoices.void(nativeId);
        vm.stopPrank();

        usdc.mint(payer, 100e6);
        vm.deal(payer, 1 ether);
        vm.startPrank(payer);
        usdc.approve(address(invoices), 100e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotOpen.selector,
                tokenId,
                IAccess0x1Invoices.InvStatus.VOID
            )
        );
        invoices.pay(tokenId, keccak256("p"));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotOpen.selector,
                nativeId,
                IAccess0x1Invoices.InvStatus.VOID
            )
        );
        invoices.payNative{ value: 1 ether }(nativeId, keccak256("p"));
        vm.stopPrank();
    }

    /// @notice ATTACK: settle on a stale price. The feed last updated > 1h ago; `pay` must revert
    ///         through the in-tx staleness guard (in `router.quote`) rather than settle on a bad quote.
    ///         The flip-to-PAID rolls back with the tx, so the invoice stays OPEN.
    function test_attack_stalePriceBlocksSettlement() public {
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, address(0), address(usdc), 20e8, 0, MEMO);
        usdcFeed.setRoundData(2, 1e8, block.timestamp, block.timestamp - 3601, 2);

        usdc.mint(payer, 100e6);
        vm.startPrank(payer);
        usdc.approve(address(invoices), 100e6);
        vm.expectRevert();
        invoices.pay(id, keccak256("p"));
        vm.stopPrank();
        assertTrue(invoices.isPayable(id));
    }

    /// @notice ATTACK (fuzz): no sequence of pay attempts can settle an invoice more than once or
    ///         charge more than one gross, regardless of how many distinct nonces are tried.
    function testFuzz_attack_settlesAtMostOnce(uint8 attempts, uint256 usdAmount8) public {
        usdAmount8 = bound(usdAmount8, 1e8, 100_000e8);
        attempts = uint8(bound(attempts, 1, 8));

        vm.prank(merchantOwner);
        uint256 id =
            invoices.createInvoice(merchantId, address(0), address(usdc), usdAmount8, 0, MEMO);
        uint256 gross = router.quote(merchantId, address(usdc), usdAmount8);

        usdc.mint(payer, gross * 20);
        vm.startPrank(payer);
        usdc.approve(address(invoices), gross * 20);

        uint256 successes;
        for (uint256 i = 0; i < attempts; ++i) {
            try invoices.pay(id, keccak256(abi.encode(i))) {
                successes++;
            } catch { }
        }
        vm.stopPrank();

        assertEq(successes, 1); // exactly one settlement, ever
        assertEq(
            usdc.balanceOf(payout) + usdc.balanceOf(treasury) + usdc.balanceOf(feeRecipient), gross
        );
        assertEq(usdc.balanceOf(address(invoices)), 0); // zero custody
        assertEq(uint8(invoices.invoiceOf(id).status), uint8(IAccess0x1Invoices.InvStatus.PAID));
    }
}
