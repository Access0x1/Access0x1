// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockFailedTransfer } from "../mocks/MockFailedTransfer.sol";
import { MockFailedTransferFrom } from "../mocks/MockFailedTransferFrom.sol";
import { MockReturnsNothingToken } from "../mocks/MockReturnsNothingToken.sol";
import { MockReentrantToken } from "../mocks/MockReentrantToken.sol";
import { RevertingReceiver } from "../mocks/RevertingReceiver.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @notice The failure-injection money matrix: deploy each hostile token into a FRESH router, drive
///         the money path, and assert the contract REVERTS + rolls back — no phantom payment, no
///         residual token stranded in the router, refunds never silently swallowed. This is the
///         literal, executable proof of estate law 5 ("money paths roll back, never swallow; refunds
///         never blocked") against the SafeERC20 wrapper choice the router rests on.
/// @dev    fund-me's `MockFailedTransfer`/`MockFailedTransferFrom` work because DSCEngine checks a raw
///         boolean; Access0x1's router uses `SafeERC20`, which ALREADY reverts on a `false`/empty
///         return — so the port here proves the ROUTER's recovery contract: that SafeERC20 catches the
///         liar BEFORE the router books a leg, that a returns-nothing-but-honest (USDT-style) token
///         still settles, and that a reentrant-on-transfer token cannot double-settle. Each test
///         snapshots balances/ledger before, forces the failing leg, and asserts the after-state is
///         byte-for-byte the before-state (atomic rollback).
contract RouterMoneyFailureAttackTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    MockV3Aggregator internal feed; // a generic 8-dec $1 feed reused for each hostile token

    address internal owner = makeAddr("mf_owner");
    address internal treasury = makeAddr("mf_treasury");
    address internal payout = makeAddr("mf_payout");
    address internal feeRecipient = makeAddr("mf_feeRecipient");
    address internal buyer = makeAddr("mf_buyer");

    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1.00%
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.50%
    uint256 internal constant USD = 100e8; // $100, 8-dec
    bytes32 internal constant ORDER = keccak256("money-failure");

    function setUp() public {
        vm.warp(1_700_000_000);
        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (owner, treasury, PLATFORM_FEE_BPS))
            )
        );
        feed = new MockV3Aggregator(8, 1e8); // token/USD = $1
    }

    /// @dev Allowlist `token` on the fresh router with the shared $1 feed (owner-gated), then register
    ///      a merchant the buyer will pay. Returns the merchantId.
    function _allowAndRegister(address token) internal returns (uint256 id) {
        vm.startPrank(owner);
        router.setTokenAllowed(token, true);
        router.setPriceFeed(token, address(feed));
        vm.stopPrank();
        vm.prank(makeAddr("mf_merchantOwner"));
        id = router.registerMerchant(
            payout, feeRecipient, MERCHANT_FEE_BPS, keccak256("mf_merchant")
        );
    }

    /// @dev Snapshot every party's token balance + the router's residual into one tuple so a test can
    ///      assert the post-revert state is identical to the pre-attack state.
    function _balances(IERC20 token)
        internal
        view
        returns (
            uint256 buyerBal,
            uint256 routerBal,
            uint256 payoutBal,
            uint256 treasuryBal,
            uint256 feeBal
        )
    {
        buyerBal = token.balanceOf(buyer);
        routerBal = token.balanceOf(address(router));
        payoutBal = token.balanceOf(payout);
        treasuryBal = token.balanceOf(treasury);
        feeBal = token.balanceOf(feeRecipient);
    }

    /*//////////////////////////////////////////////////////////////
        1. OUTBOUND PUSH LIES (transfer → false): rollback, no phantom
    //////////////////////////////////////////////////////////////*/

    /// @notice ATTACK: the net/fee leg's `transfer` returns false (claims failure, moves nothing).
    ///         SafeERC20 reverts on the false return, so the WHOLE `payToken` reverts after the
    ///         pull-in — atomic rollback. No `PaymentReceived` stands against money that never left the
    ///         router, and the router holds ZERO residual of the hostile token afterwards.
    function test_attack_transferReturnsFalse_revertsAndRollsBack() public {
        MockFailedTransfer token = new MockFailedTransfer();
        uint256 id = _allowAndRegister(address(token));

        uint256 gross = router.quote(id, address(token), USD);
        token.mint(buyer, gross);
        vm.prank(buyer);
        token.approve(address(router), gross);

        (uint256 b0, uint256 r0, uint256 p0, uint256 t0, uint256 f0) =
            _balances(IERC20(address(token)));

        vm.prank(buyer);
        vm.expectRevert(); // SafeERC20FailedOperation on the net push
        router.payToken(id, address(token), USD, ORDER);

        // Atomic rollback: every balance is exactly the pre-attack snapshot — the pull-in that
        // SafeERC20 undid included. The router booked nothing.
        (uint256 b1, uint256 r1, uint256 p1, uint256 t1, uint256 f1) =
            _balances(IERC20(address(token)));
        assertEq(b1, b0, "buyer balance moved");
        assertEq(r1, r0, "router holds residual"); // r0 == 0; no phantom custody
        assertEq(r1, 0, "router is not zero-custody");
        assertEq(p1, p0, "merchant phantom-credited");
        assertEq(t1, t0, "treasury phantom-credited");
        assertEq(f1, f0, "fee recipient phantom-credited");
        // The buyer keeps every token: a failed settlement never costs the payer.
        assertEq(token.balanceOf(buyer), gross);
    }

    /*//////////////////////////////////////////////////////////////
        2. PULL-IN LIES (transferFrom → false): revert before emit
    //////////////////////////////////////////////////////////////*/

    /// @notice ATTACK: the pull-in `transferFrom` returns false (claims failure, moves nothing).
    ///         SafeERC20 reverts inside `_pullExact`, so `payToken` reverts BEFORE the split/emit/push.
    ///         A buyer whose pull silently failed can never mint a phantom payment.
    function test_attack_transferFromReturnsFalse_revertsBeforeSettlement() public {
        MockFailedTransferFrom token = new MockFailedTransferFrom();
        uint256 id = _allowAndRegister(address(token));

        uint256 gross = router.quote(id, address(token), USD);
        token.mint(buyer, gross);
        vm.prank(buyer);
        token.approve(address(router), gross);

        (uint256 b0, uint256 r0, uint256 p0, uint256 t0, uint256 f0) =
            _balances(IERC20(address(token)));

        vm.prank(buyer);
        vm.expectRevert(); // SafeERC20FailedOperation on the pull-in
        router.payToken(id, address(token), USD, ORDER);

        (uint256 b1, uint256 r1, uint256 p1, uint256 t1, uint256 f1) =
            _balances(IERC20(address(token)));
        assertEq(b1, b0, "buyer charged on a failed pull");
        assertEq(r1, r0, "router took custody on a failed pull");
        assertEq(r1, 0, "router is not zero-custody");
        assertEq(p1, p0, "merchant phantom-credited");
        assertEq(t1, t0, "treasury phantom-credited");
        assertEq(f1, f0, "fee recipient phantom-credited");
    }

    /*//////////////////////////////////////////////////////////////
        3. NO-BOOL RETURN (USDT-style honest move): SafeERC20 is load-bearing
    //////////////////////////////////////////////////////////////*/

    /// @notice PROOF: a USDT-style token that returns NOTHING (no bool) but moves value settles
    ///         correctly. A raw `require(token.transfer(...))` router would revert on the empty return
    ///         (USDT unusable); the SafeERC20 choice accepts the no-data success — so the payment
    ///         settles, fees split exactly, and the router stays zero-custody. This is why the wrapper
    ///         is load-bearing, not cosmetic.
    function test_returnsNothingToken_settlesUnderSafeERC20() public {
        MockReturnsNothingToken token = new MockReturnsNothingToken();
        uint256 id = _allowAndRegister(address(token));

        uint256 gross = router.quote(id, address(token), USD);
        uint256 platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        uint256 merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        uint256 net = gross - platformFee - merchantFee;

        token.mint(buyer, gross);
        vm.prank(buyer);
        token.approve(address(router), gross);

        vm.prank(buyer);
        router.payToken(id, address(token), USD, ORDER);

        // Real settlement: net→payout, platform fee→treasury, merchant fee→feeRecipient, zero residual.
        assertEq(token.balanceOf(payout), net);
        assertEq(token.balanceOf(treasury), platformFee);
        assertEq(token.balanceOf(feeRecipient), merchantFee);
        assertEq(token.balanceOf(address(router)), 0, "router is not zero-custody");
        assertEq(token.balanceOf(buyer), 0);
        // Conservation: nothing minted or burned by the router.
        assertEq(net + platformFee + merchantFee, gross);
    }

    /*//////////////////////////////////////////////////////////////
        4. REENTRANT-ON-TRANSFER: guard blocks double-settle, full rollback
    //////////////////////////////////////////////////////////////*/

    /// @notice ATTACK: a token re-enters `payToken` during the router's outbound push. The shared
    ///         `nonReentrant` guard reverts the inner call; because the push is a plain `safeTransfer`
    ///         (not a try/catch), the inner revert propagates and the WHOLE outer payment rolls back.
    ///         No double-settle, no phantom receipt, zero residual.
    function test_attack_reentrantTokenCannotDoubleSettle() public {
        MockReentrantToken token = new MockReentrantToken();
        uint256 id = _allowAndRegister(address(token));

        uint256 gross = router.quote(id, address(token), USD);
        // Fund the buyer for TWO payments so a successful re-entry would actually be affordable —
        // ruling out "it only reverted because there were no funds for the second leg."
        token.mint(buyer, gross * 2);
        vm.prank(buyer);
        token.approve(address(router), gross * 2);
        token.setTarget(router, id, USD);
        token.arm(true);

        (uint256 b0, uint256 r0, uint256 p0, uint256 t0, uint256 f0) =
            _balances(IERC20(address(token)));

        vm.prank(buyer);
        vm.expectRevert(); // ReentrancyGuardReentrantCall bubbles up through safeTransfer
        router.payToken(id, address(token), USD, ORDER);

        // Whole tx reverted → nothing settled, nothing stranded.
        (uint256 b1, uint256 r1, uint256 p1, uint256 t1, uint256 f1) =
            _balances(IERC20(address(token)));
        assertEq(b1, b0, "buyer charged across a reverted reentrancy");
        assertEq(r1, r0, "router took custody across a reverted reentrancy");
        assertEq(r1, 0, "router is not zero-custody");
        assertEq(p1, p0, "merchant settled across a reverted reentrancy");
        assertEq(t1, t0, "treasury settled across a reverted reentrancy");
        assertEq(f1, f0, "fee recipient settled across a reverted reentrancy");
    }

    /*//////////////////////////////////////////////////////////////
        5. REFUND NEVER BLOCKED (native): a hostile buyer cannot strand its excess
    //////////////////////////////////////////////////////////////*/

    /// @notice ATTACK / LAW 5: a buyer that overpays in native but REJECTS the refund (a contract whose
    ///         `receive` reverts) must not silently lose the excess. The router reverts
    ///         `Access0x1__NativePushFailed` rather than swallowing it — refunds are never blocked,
    ///         and the whole payment rolls back so the buyer keeps its full balance.
    function test_attack_refundToRejectingBuyerRevertsNeverSwallows() public {
        // Native feed: $2000/ETH, on the fresh router.
        MockV3Aggregator nativeFeed = new MockV3Aggregator(8, 2000e8);
        vm.prank(owner);
        router.setPriceFeed(address(0), address(nativeFeed));

        RevertingReceiver hostileBuyer = new RevertingReceiver();
        vm.prank(makeAddr("mf_m2"));
        uint256 id =
            router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, keccak256("mf2"));

        uint256 gross = router.quote(id, address(0), 20e8); // $20 in native
        uint256 overpay = gross + 1 ether; // excess that must be refunded
        vm.deal(address(hostileBuyer), overpay);

        uint256 buyerBefore = address(hostileBuyer).balance;

        vm.prank(address(hostileBuyer));
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__NativePushFailed.selector, address(hostileBuyer), 1 ether
            )
        );
        router.payNative{ value: overpay }(id, 20e8, ORDER);

        // Refund was NOT swallowed (the tx reverted) and the whole payment rolled back: the buyer
        // keeps its full balance, the merchant/treasury got nothing, the router holds nothing.
        assertEq(address(hostileBuyer).balance, buyerBefore, "refund silently swallowed");
        assertEq(payout.balance, 0);
        assertEq(treasury.balance, 0);
        assertEq(address(router).balance, 0, "router stranded native after a reverted refund");
        assertEq(router.rescue(address(hostileBuyer)), 0, "a blocked refund must not become rescue");
    }
}
