// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Rebates } from "../../src/Access0x1Rebates.sol";
import { IAccess0x1Rebates } from "../../src/interfaces/IAccess0x1Rebates.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { FeeOnTransferToken } from "../mocks/FeeOnTransferToken.sol";
import { BlocklistToken } from "../mocks/BlocklistToken.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import {
    OwnableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/// @notice A trivial v2 implementation for the upgrade test: one added view, no new storage, so an
///         upgrade to it must preserve every prior slot (promos, claims, queues).
contract Access0x1RebatesV2 is Access0x1Rebates {
    /// @notice A marker the original implementation does not expose — proves the new logic is live.
    function version2Marker() external pure returns (string memory) {
        return "v2";
    }
}

/// @notice The conditional-rebate unit suite: the full surface in one fixture — initializer,
///         createPromo (auth + validation + the no-re-aim-over-live-money rule), fundPromo (exact
///         pull, open funding, dead-window rejection), payWithRebate (the settle-through-router +
///         same-tx rebate pipe: every predicate leg, the orderId idempotency key incl. the
///         replay-reverts-before-value-moves guarantee, the funded cap, the zero-rounding no-burn,
///         the push-or-queue never-blockable rebate leg), reclaim (owner-only, post-window,
///         router-pause-immune — law: unspent promo money is never hostage), withdraw/withdrawTo,
///         previewRebate parity, and the UUPS upgrade. Asserts the platform fee is taken ONCE at the
///         router and that the module holds ZERO settlement custody (only pool + queue). Deployed
///         BEHIND a UUPS proxy via the shared {ProxyDeployer}, the production shape.
contract Access0x1RebatesTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    Access0x1Rebates internal rebates;

    address internal owner = makeAddr("owner"); // router admin
    address internal admin = makeAddr("admin"); // rebates upgrade admin
    address internal treasury = makeAddr("treasury");
    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%

    address internal merchantOwner = makeAddr("merchantOwner");
    address internal merchantPayout = makeAddr("merchantPayout");
    address internal buyer = makeAddr("buyer");
    address internal stranger = makeAddr("stranger");
    bytes32 internal constant NAME_HASH = keccak256("acme");

    MockV3Aggregator internal usdcFeed;
    MockUSDC internal usdc; // 6 dp

    uint256 internal merchantId;

    // The canonical promo: 5% back on $25+, open now, closing in 30 days, funded 1,000 USDC.
    uint16 internal constant REBATE_BPS = 500; // 5%
    uint256 internal constant MIN_USD8 = 25e8; // $25
    uint256 internal constant POOL = 1_000e6; // 1,000 USDC
    uint64 internal promoStart;
    uint64 internal promoEnd;

    uint256 internal constant USD = 100e8; // $100 (8 decimals) — a qualifying purchase

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        promoStart = uint64(block.timestamp);
        promoEnd = uint64(block.timestamp + 30 days);

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (owner, treasury, PLATFORM_FEE_BPS))
            )
        );

        rebates = Access0x1Rebates(
            deployProxy(
                address(new Access0x1Rebates()),
                abi.encodeCall(Access0x1Rebates.initialize, (admin, router))
            )
        );

        usdcFeed = new MockV3Aggregator(8, 1e8); // $1/USDC
        usdc = new MockUSDC();
        vm.startPrank(owner);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        // A NORMAL merchant: payout is the merchant's own wallet (the module is a conduit for the
        // gross, never the payout — settlement custody here is zero).
        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(merchantPayout, address(0), 0, NAME_HASH);

        _createCanonicalPromo();
        _fund(merchantOwner, POOL);

        usdc.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        usdc.approve(address(rebates), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _createCanonicalPromo() internal {
        vm.prank(merchantOwner);
        rebates.createPromo(merchantId, address(usdc), promoStart, promoEnd, REBATE_BPS, MIN_USD8);
    }

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(rebates), amount);
        rebates.fundPromo(merchantId, amount);
        vm.stopPrank();
    }

    /// @dev The router's fee split of a gross (1%): fee → treasury, net → the merchant payout.
    function _routerSplit(uint256 gross) internal pure returns (uint256 fee, uint256 net) {
        fee = gross * PLATFORM_FEE_BPS / 10_000;
        net = gross - fee;
    }

    function _funded() internal view returns (uint256 funded) {
        (,,,,, funded) = rebates.promos(merchantId);
    }

    function _payAs(address who, uint256 usd8, bytes32 orderId) internal returns (uint256 gross) {
        gross = router.quote(merchantId, address(usdc), usd8);
        vm.prank(who);
        rebates.payWithRebate(merchantId, address(usdc), usd8, orderId);
    }

    /// @dev Assert the SETTLES-WITHOUT-REBATE contract: the payment lands exactly as a direct router
    ///      payment (net → payout, fee → treasury, buyer pays the full gross), the promo pool is
    ///      untouched, and the orderId is NOT burned (a non-qualifying call is not an error and
    ///      consumes nothing).
    function _assertSettlesNoRebate(uint256 seat, uint256 usd8, bytes32 orderId) internal {
        uint256 gross = router.quote(seat, address(usdc), usd8);
        (uint256 fee, uint256 net) = _routerSplit(gross);
        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 payoutBefore = usdc.balanceOf(merchantPayout);
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        (,,,,, uint256 fundedBefore) = rebates.promos(seat);

        vm.prank(buyer);
        rebates.payWithRebate(seat, address(usdc), usd8, orderId);

        assertEq(usdc.balanceOf(buyer), buyerBefore - gross, "buyer paid full gross, no rebate");
        assertEq(usdc.balanceOf(merchantPayout), payoutBefore + net, "merchant net landed");
        assertEq(usdc.balanceOf(treasury), treasuryBefore + fee, "platform fee landed once");
        (,,,,, uint256 fundedAfter) = rebates.promos(seat);
        assertEq(fundedAfter, fundedBefore, "pool untouched");
        assertFalse(rebates.claimedOrder(orderId), "orderId not burned");
    }

    /*//////////////////////////////////////////////////////////////
                              INITIALIZE
    //////////////////////////////////////////////////////////////*/

    function test_initializeSetsRouterAndOwner() public view {
        assertEq(address(rebates.router()), address(router));
        assertEq(OwnableUpgradeable(address(rebates)).owner(), admin);
        assertEq(rebates.TOTAL_BPS(), 10_000);
    }

    function test_initializeRevertsOnZeroRouter() public {
        address impl = address(new Access0x1Rebates());
        vm.expectRevert(IAccess0x1Rebates.Access0x1Rebates__ZeroAddress.selector);
        deployProxy(
            impl, abi.encodeCall(Access0x1Rebates.initialize, (admin, Access0x1Router(payable(0))))
        );
    }

    function test_initializeRevertsOnSecondCall() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        rebates.initialize(admin, router);
    }

    /*//////////////////////////////////////////////////////////////
                               CREATE PROMO
    //////////////////////////////////////////////////////////////*/

    function test_createStoresPromoAndEmits() public {
        vm.prank(merchantOwner);
        uint256 fresh = router.registerMerchant(merchantPayout, address(0), 0, keccak256("m2"));
        vm.expectEmit(true, true, false, true, address(rebates));
        emit IAccess0x1Rebates.PromoCreated(
            fresh, address(usdc), promoStart, promoEnd, REBATE_BPS, MIN_USD8
        );
        vm.prank(merchantOwner);
        rebates.createPromo(fresh, address(usdc), promoStart, promoEnd, REBATE_BPS, MIN_USD8);

        (address token, uint64 start, uint64 end, uint16 bps, uint256 minUsd8, uint256 funded) =
            rebates.promos(fresh);
        assertEq(token, address(usdc));
        assertEq(start, promoStart);
        assertEq(end, promoEnd);
        assertEq(bps, REBATE_BPS);
        assertEq(minUsd8, MIN_USD8);
        assertEq(funded, 0); // funding is a separate exact-pull step
    }

    function test_createRevertsForNonOwner() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Rebates.Access0x1Rebates__NotMerchantOwner.selector, merchantId, stranger
            )
        );
        vm.prank(stranger);
        rebates.createPromo(merchantId, address(usdc), promoStart, promoEnd, REBATE_BPS, MIN_USD8);
    }

    function test_createRevertsForUnknownMerchant() public {
        // A never-registered seat has owner address(0), which no caller equals.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Rebates.Access0x1Rebates__NotMerchantOwner.selector, 999, merchantOwner
            )
        );
        vm.prank(merchantOwner);
        rebates.createPromo(999, address(usdc), promoStart, promoEnd, REBATE_BPS, MIN_USD8);
    }

    function test_createRevertsOnZeroToken() public {
        vm.prank(merchantOwner);
        uint256 fresh = router.registerMerchant(merchantPayout, address(0), 0, keccak256("m3"));
        vm.expectRevert(IAccess0x1Rebates.Access0x1Rebates__ZeroAddress.selector);
        vm.prank(merchantOwner);
        rebates.createPromo(fresh, address(0), promoStart, promoEnd, REBATE_BPS, MIN_USD8);
    }

    function test_createRevertsOnBadWindow() public {
        vm.prank(merchantOwner);
        uint256 fresh = router.registerMerchant(merchantPayout, address(0), 0, keccak256("m4"));

        // start >= end
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Rebates.Access0x1Rebates__BadWindow.selector, promoEnd, promoStart
            )
        );
        vm.prank(merchantOwner);
        rebates.createPromo(fresh, address(usdc), promoEnd, promoStart, REBATE_BPS, MIN_USD8);

        // end in the past
        uint64 past = uint64(block.timestamp - 1);
        uint64 pastStart = past - 100;
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Rebates.Access0x1Rebates__BadWindow.selector, pastStart, past
            )
        );
        vm.prank(merchantOwner);
        rebates.createPromo(fresh, address(usdc), pastStart, past, REBATE_BPS, MIN_USD8);
    }

    function test_createRevertsOnBadRebateBps() public {
        vm.prank(merchantOwner);
        uint256 fresh = router.registerMerchant(merchantPayout, address(0), 0, keccak256("m5"));

        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1Rebates.Access0x1Rebates__BadRebateBps.selector, 0)
        );
        vm.prank(merchantOwner);
        rebates.createPromo(fresh, address(usdc), promoStart, promoEnd, 0, MIN_USD8);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Rebates.Access0x1Rebates__BadRebateBps.selector, 10_001
            )
        );
        vm.prank(merchantOwner);
        rebates.createPromo(fresh, address(usdc), promoStart, promoEnd, 10_001, MIN_USD8);
    }

    function test_createRevertsWhileFunded() public {
        // The canonical promo holds POOL — re-aiming terms over live money must revert.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Rebates.Access0x1Rebates__PromoStillFunded.selector, merchantId, POOL
            )
        );
        vm.prank(merchantOwner);
        rebates.createPromo(merchantId, address(usdc), promoStart, promoEnd, 100, 0);
    }

    function test_createAllowsReconfigureAfterReclaim() public {
        vm.warp(promoEnd + 1);
        vm.prank(merchantOwner);
        rebates.reclaim(merchantId, merchantOwner);

        uint64 newStart = uint64(block.timestamp);
        uint64 newEnd = uint64(block.timestamp + 7 days);
        vm.prank(merchantOwner);
        rebates.createPromo(merchantId, address(usdc), newStart, newEnd, 100, 0);
        (, uint64 start,, uint16 bps,,) = rebates.promos(merchantId);
        assertEq(start, newStart);
        assertEq(bps, 100);
    }

    /*//////////////////////////////////////////////////////////////
                                 FUND
    //////////////////////////////////////////////////////////////*/

    function test_fundPullsExactAndEmits() public {
        uint256 balBefore = usdc.balanceOf(address(rebates));
        usdc.mint(merchantOwner, 50e6);
        vm.startPrank(merchantOwner);
        usdc.approve(address(rebates), 50e6);
        vm.expectEmit(true, true, false, true, address(rebates));
        emit IAccess0x1Rebates.PromoFunded(merchantId, merchantOwner, 50e6, POOL + 50e6);
        rebates.fundPromo(merchantId, 50e6);
        vm.stopPrank();

        assertEq(_funded(), POOL + 50e6);
        assertEq(usdc.balanceOf(address(rebates)), balBefore + 50e6); // fully backed
    }

    function test_fundByAnyone() public {
        usdc.mint(stranger, 10e6);
        vm.startPrank(stranger);
        usdc.approve(address(rebates), 10e6);
        rebates.fundPromo(merchantId, 10e6);
        vm.stopPrank();
        assertEq(_funded(), POOL + 10e6);
    }

    function test_fundRevertsOnZeroAmountNoPromoAndEnded() public {
        vm.expectRevert(IAccess0x1Rebates.Access0x1Rebates__ZeroAmount.selector);
        rebates.fundPromo(merchantId, 0);

        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1Rebates.Access0x1Rebates__NoPromo.selector, 999)
        );
        rebates.fundPromo(999, 1);

        vm.warp(promoEnd + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Rebates.Access0x1Rebates__PromoEnded.selector, merchantId, promoEnd
            )
        );
        rebates.fundPromo(merchantId, 1);
    }

    function test_fundRejectsFeeOnTransferToken() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        vm.prank(merchantOwner);
        uint256 fresh = router.registerMerchant(merchantPayout, address(0), 0, keccak256("m6"));
        vm.prank(merchantOwner);
        rebates.createPromo(fresh, address(fot), promoStart, promoEnd, REBATE_BPS, 0);

        fot.mint(merchantOwner, 100e18);
        vm.startPrank(merchantOwner);
        fot.approve(address(rebates), 100e18);
        vm.expectRevert(); // Access0x1Rebates__FeeOnTransferToken(amount, received)
        rebates.fundPromo(fresh, 100e18);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                             PAY WITH REBATE
    //////////////////////////////////////////////////////////////*/

    function test_payHappyPathSettlesAndRebates() public {
        uint256 gross = router.quote(merchantId, address(usdc), USD);
        (uint256 fee, uint256 net) = _routerSplit(gross);
        uint256 rebate = gross * REBATE_BPS / 10_000;
        uint256 buyerBefore = usdc.balanceOf(buyer);
        bytes32 orderId = keccak256("order-1");

        vm.expectEmit(true, true, true, true, address(rebates));
        emit IAccess0x1Rebates.RebatePaid(merchantId, buyer, address(usdc), rebate, orderId);
        vm.prank(buyer);
        rebates.payWithRebate(merchantId, address(usdc), USD, orderId);

        // The router split landed once: net → payout, fee → treasury.
        assertEq(usdc.balanceOf(merchantPayout), net, "merchant net");
        assertEq(usdc.balanceOf(treasury), fee, "platform fee, once");
        // The buyer paid the gross and got the rebate back in the SAME tx.
        assertEq(usdc.balanceOf(buyer), buyerBefore - gross + rebate, "buyer net-of-rebate");
        // The pool funded the rebate; the settlement itself left ZERO custody here.
        assertEq(_funded(), POOL - rebate, "pool decremented");
        assertEq(usdc.balanceOf(address(rebates)), POOL - rebate, "zero settlement custody");
        assertTrue(rebates.claimedOrder(orderId), "idempotency key consumed");
    }

    function test_payBeforeStartSettlesWithoutRebate() public {
        vm.prank(merchantOwner);
        uint256 fresh = router.registerMerchant(merchantPayout, address(0), 0, keccak256("m7"));
        vm.prank(merchantOwner);
        rebates.createPromo(
            fresh,
            address(usdc),
            uint64(block.timestamp + 1 days),
            uint64(block.timestamp + 10 days),
            REBATE_BPS,
            0
        );
        _assertSettlesNoRebate(fresh, USD, keccak256("early"));
    }

    function test_payAfterEndSettlesWithoutRebate() public {
        vm.warp(promoEnd + 1);
        usdcFeed.updateAnswer(1e8); // refresh the feed so the WINDOW, not staleness, is what gates
        _assertSettlesNoRebate(merchantId, USD, keccak256("late"));
    }

    function test_payBelowMinimumSettlesWithoutRebate() public {
        _assertSettlesNoRebate(merchantId, MIN_USD8 - 1, keccak256("small"));
    }

    function test_payEmptyPoolSettlesWithoutRebate() public {
        vm.prank(merchantOwner);
        uint256 fresh = router.registerMerchant(merchantPayout, address(0), 0, keccak256("m8"));
        vm.prank(merchantOwner);
        rebates.createPromo(fresh, address(usdc), promoStart, promoEnd, REBATE_BPS, 0);
        // created but never funded
        _assertSettlesNoRebate(fresh, USD, keccak256("dry"));
    }

    function test_payWrongTokenSettlesWithoutRebate() public {
        MockUSDC other = new MockUSDC();
        MockV3Aggregator otherFeed = new MockV3Aggregator(8, 1e8);
        vm.startPrank(owner);
        router.setTokenAllowed(address(other), true);
        router.setPriceFeed(address(other), address(otherFeed));
        vm.stopPrank();
        other.mint(buyer, 1_000e6);
        vm.prank(buyer);
        other.approve(address(rebates), type(uint256).max);

        uint256 fundedBefore = _funded();
        bytes32 orderId = keccak256("wrong-token");
        vm.prank(buyer);
        rebates.payWithRebate(merchantId, address(other), USD, orderId);

        assertEq(_funded(), fundedBefore, "pool untouched");
        assertFalse(rebates.claimedOrder(orderId), "orderId not burned");
    }

    function test_payWithNoPromoSettlesWithoutRebate() public {
        vm.prank(merchantOwner);
        uint256 fresh = router.registerMerchant(merchantPayout, address(0), 0, keccak256("m9"));
        _assertSettlesNoRebate(fresh, USD, keccak256("no-promo"));
    }

    function test_payReplayRevertsBeforeAnyValueMoves() public {
        bytes32 orderId = keccak256("order-replay");
        _payAs(buyer, USD, orderId); // consumes the key (rebate paid)

        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 payoutBefore = usdc.balanceOf(merchantPayout);
        uint256 fundedBefore = _funded();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Rebates.Access0x1Rebates__OrderAlreadyClaimed.selector, orderId
            )
        );
        vm.prank(buyer);
        rebates.payWithRebate(merchantId, address(usdc), USD, orderId);

        // The replay settled NOTHING: no pull, no router leg, no pool movement.
        assertEq(usdc.balanceOf(buyer), buyerBefore, "buyer untouched");
        assertEq(usdc.balanceOf(merchantPayout), payoutBefore, "payout untouched");
        assertEq(_funded(), fundedBefore, "pool untouched");
    }

    function test_payRebateCappedAtRemainingPool() public {
        vm.prank(merchantOwner);
        uint256 fresh = router.registerMerchant(merchantPayout, address(0), 0, keccak256("m10"));
        vm.prank(merchantOwner);
        rebates.createPromo(fresh, address(usdc), promoStart, promoEnd, REBATE_BPS, 0);
        // Fund a pool SMALLER than the computed rebate: $100 @5% = 5 USDC; fund only 1 USDC.
        usdc.mint(merchantOwner, 1e6);
        vm.startPrank(merchantOwner);
        usdc.approve(address(rebates), 1e6);
        rebates.fundPromo(fresh, 1e6);
        vm.stopPrank();

        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 gross = router.quote(fresh, address(usdc), USD);
        vm.prank(buyer);
        rebates.payWithRebate(fresh, address(usdc), USD, keccak256("capped"));

        assertEq(usdc.balanceOf(buyer), buyerBefore - gross + 1e6, "rebate == whole pool");
        (,,,,, uint256 funded) = rebates.promos(fresh);
        assertEq(funded, 0, "pool drained exactly");
    }

    function test_payZeroRoundedRebateBurnsNothing() public {
        vm.prank(merchantOwner);
        uint256 fresh = router.registerMerchant(merchantPayout, address(0), 0, keccak256("m11"));
        vm.prank(merchantOwner);
        rebates.createPromo(fresh, address(usdc), promoStart, promoEnd, 1, 0); // 0.01%
        usdc.mint(merchantOwner, 1e6);
        vm.startPrank(merchantOwner);
        usdc.approve(address(rebates), 1e6);
        rebates.fundPromo(fresh, 1e6);
        vm.stopPrank();

        // $0.00000001 quotes (rounded up) to 1 token unit; 1 * 1 / 10_000 floors to 0.
        bytes32 orderId = keccak256("dust");
        vm.prank(buyer);
        rebates.payWithRebate(fresh, address(usdc), 1, orderId);

        assertFalse(rebates.claimedOrder(orderId), "zero rebate burns no key");
        (,,,,, uint256 funded) = rebates.promos(fresh);
        assertEq(funded, 1e6, "pool untouched");
    }

    function test_payNativeRejected() public {
        vm.expectRevert(IAccess0x1Rebates.Access0x1Rebates__NativeNotSupported.selector);
        vm.prank(buyer);
        rebates.payWithRebate(merchantId, address(0), USD, keccak256("native"));
    }

    function test_payQueuesRebateWhenPushBlocked() public {
        // A USDC-style compliance token: the buyer can SEND (the pull leg works) but is blocked
        // from RECEIVING — the inline rebate push reverts and must QUEUE, never revert the payment.
        BlocklistToken blk = new BlocklistToken();
        MockV3Aggregator blkFeed = new MockV3Aggregator(8, 1e8);
        vm.startPrank(owner);
        router.setTokenAllowed(address(blk), true);
        router.setPriceFeed(address(blk), address(blkFeed));
        vm.stopPrank();

        vm.prank(merchantOwner);
        uint256 fresh = router.registerMerchant(merchantPayout, address(0), 0, keccak256("m12"));
        vm.prank(merchantOwner);
        rebates.createPromo(fresh, address(blk), promoStart, promoEnd, REBATE_BPS, 0);
        blk.mint(merchantOwner, 100e6);
        vm.startPrank(merchantOwner);
        blk.approve(address(rebates), 100e6);
        rebates.fundPromo(fresh, 100e6);
        vm.stopPrank();

        blk.mint(buyer, 1_000e6);
        vm.prank(buyer);
        blk.approve(address(rebates), type(uint256).max);
        blk.setBlocked(buyer, true); // buyer can still send; receiving reverts

        uint256 gross = router.quote(fresh, address(blk), USD);
        uint256 rebate = gross * REBATE_BPS / 10_000;
        bytes32 orderId = keccak256("queued");

        vm.expectEmit(true, true, true, true, address(rebates));
        emit IAccess0x1Rebates.RebateQueued(fresh, buyer, address(blk), rebate, orderId);
        vm.prank(buyer);
        rebates.payWithRebate(fresh, address(blk), USD, orderId);

        // Settlement stood; the rebate is parked, claimable, and the key is consumed.
        assertEq(rebates.withdrawable(buyer, address(blk)), rebate, "queued for pull");
        assertTrue(rebates.claimedOrder(orderId));
        (,,,,, uint256 funded) = rebates.promos(fresh);
        assertEq(funded, 100e6 - rebate, "pool decremented despite queue");

        // The buyer unblocks and pulls the parked rebate — never lost.
        blk.setBlocked(buyer, false);
        uint256 before = blk.balanceOf(buyer);
        vm.prank(buyer);
        rebates.withdraw(address(blk));
        assertEq(blk.balanceOf(buyer), before + rebate, "queued rebate claimed");
        assertEq(rebates.withdrawable(buyer, address(blk)), 0);
    }

    function test_payRevertsWhileRouterPaused() public {
        vm.prank(owner);
        router.pause();
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        vm.prank(buyer);
        rebates.payWithRebate(merchantId, address(usdc), USD, keccak256("paused"));
    }

    /*//////////////////////////////////////////////////////////////
                                RECLAIM
    //////////////////////////////////////////////////////////////*/

    function test_reclaimOnlyOwnerOnlyAfterEndFullAmount() public {
        // Too early.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Rebates.Access0x1Rebates__PromoNotEnded.selector, merchantId, promoEnd
            )
        );
        vm.prank(merchantOwner);
        rebates.reclaim(merchantId, merchantOwner);

        vm.warp(promoEnd + 1);

        // Wrong caller.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Rebates.Access0x1Rebates__NotMerchantOwner.selector, merchantId, stranger
            )
        );
        vm.prank(stranger);
        rebates.reclaim(merchantId, stranger);

        // Zero destination.
        vm.expectRevert(IAccess0x1Rebates.Access0x1Rebates__ZeroAddress.selector);
        vm.prank(merchantOwner);
        rebates.reclaim(merchantId, address(0));

        // Owner reclaims the FULL remainder to a chosen address.
        vm.expectEmit(true, true, true, true, address(rebates));
        emit IAccess0x1Rebates.PromoReclaimed(merchantId, merchantOwner, address(usdc), POOL);
        vm.prank(merchantOwner);
        rebates.reclaim(merchantId, merchantOwner);
        assertEq(usdc.balanceOf(merchantOwner), POOL);
        assertEq(_funded(), 0);

        // Nothing left.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Rebates.Access0x1Rebates__NothingToReclaim.selector, merchantId
            )
        );
        vm.prank(merchantOwner);
        rebates.reclaim(merchantId, merchantOwner);
    }

    function test_reclaimWorksWhileRouterPaused() public {
        // LAW: unspent promo money is NEVER hostage — reclaim touches no router value path, so even
        // a fully paused router cannot stand between the merchant and the pool.
        vm.prank(owner);
        router.pause();

        vm.warp(promoEnd + 1);
        vm.prank(merchantOwner);
        rebates.reclaim(merchantId, merchantOwner);
        assertEq(usdc.balanceOf(merchantOwner), POOL);
    }

    /*//////////////////////////////////////////////////////////////
                               WITHDRAW
    //////////////////////////////////////////////////////////////*/

    function test_withdrawRevertsWhenNothingOwed() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Rebates.Access0x1Rebates__NothingToWithdraw.selector, address(usdc)
            )
        );
        vm.prank(buyer);
        rebates.withdraw(address(usdc));
    }

    function test_withdrawToRedirectsOwnCreditOnly() public {
        // Queue a rebate via the blocklist path, then redirect it to a fresh address.
        BlocklistToken blk = new BlocklistToken();
        MockV3Aggregator blkFeed = new MockV3Aggregator(8, 1e8);
        vm.startPrank(owner);
        router.setTokenAllowed(address(blk), true);
        router.setPriceFeed(address(blk), address(blkFeed));
        vm.stopPrank();
        vm.prank(merchantOwner);
        uint256 fresh = router.registerMerchant(merchantPayout, address(0), 0, keccak256("m13"));
        vm.prank(merchantOwner);
        rebates.createPromo(fresh, address(blk), promoStart, promoEnd, REBATE_BPS, 0);
        blk.mint(merchantOwner, 100e6);
        vm.startPrank(merchantOwner);
        blk.approve(address(rebates), 100e6);
        rebates.fundPromo(fresh, 100e6);
        vm.stopPrank();
        blk.mint(buyer, 1_000e6);
        vm.prank(buyer);
        blk.approve(address(rebates), type(uint256).max);
        blk.setBlocked(buyer, true);
        vm.prank(buyer);
        rebates.payWithRebate(fresh, address(blk), USD, keccak256("redirect"));
        uint256 owed = rebates.withdrawable(buyer, address(blk));
        assertGt(owed, 0);

        // Zero destination rejected; a stranger has no credit to move.
        vm.expectRevert(IAccess0x1Rebates.Access0x1Rebates__ZeroAddress.selector);
        vm.prank(buyer);
        rebates.withdrawTo(address(blk), address(0));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Rebates.Access0x1Rebates__NothingToWithdraw.selector, address(blk)
            )
        );
        vm.prank(stranger);
        rebates.withdrawTo(address(blk), stranger);

        // The buyer redirects THEIR OWN credit to a receivable address (still blocked themselves).
        address sidecar = makeAddr("sidecar");
        vm.prank(buyer);
        rebates.withdrawTo(address(blk), sidecar);
        assertEq(blk.balanceOf(sidecar), owed);
        assertEq(rebates.withdrawable(buyer, address(blk)), 0);
    }

    /*//////////////////////////////////////////////////////////////
                                PREVIEW
    //////////////////////////////////////////////////////////////*/

    function test_previewMatchesActualAndFailsClosed() public {
        uint256 gross = router.quote(merchantId, address(usdc), USD);
        uint256 expected = gross * REBATE_BPS / 10_000;
        bytes32 orderId = keccak256("preview");

        assertEq(rebates.previewRebate(merchantId, address(usdc), USD, orderId), expected);
        assertEq(rebates.previewRebate(merchantId, address(usdc), MIN_USD8 - 1, orderId), 0);
        assertEq(rebates.previewRebate(merchantId, address(0), USD, orderId), 0);
        assertEq(rebates.previewRebate(999, address(usdc), USD, orderId), 0);

        uint256 paid = _payAs(buyer, USD, orderId);
        assertGt(paid, 0);
        assertEq(
            rebates.previewRebate(merchantId, address(usdc), USD, orderId),
            0,
            "consumed key previews zero"
        );
    }

    /*//////////////////////////////////////////////////////////////
                                 UUPS
    //////////////////////////////////////////////////////////////*/

    function test_upgradePreservesStateAndGates() public {
        // Non-admin cannot upgrade.
        address v2 = address(new Access0x1RebatesV2());
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger)
        );
        vm.prank(stranger);
        rebates.upgradeToAndCall(v2, "");

        // Admin upgrades; every prior slot survives.
        vm.prank(admin);
        rebates.upgradeToAndCall(v2, "");
        assertEq(Access0x1RebatesV2(address(rebates)).version2Marker(), "v2");
        assertEq(address(rebates.router()), address(router), "router slot preserved");
        assertEq(_funded(), POOL, "pool slot preserved");
    }
}

/// @notice Verifies the module composes the LIVE router pause honestly (settlement brakes with the
///         router) while its own reclaim lane stays open — split from the main fixture only to keep
///         the pause pranks isolated.
contract Access0x1RebatesPauseSplitTest is Access0x1RebatesTest {
    function test_settleThenPauseThenReclaimLifecycle() public {
        // A qualifying settlement while live…
        _payAs(buyer, USD, keccak256("lifecycle-1"));
        // …the router pauses (incident mode): pay path brakes…
        vm.prank(owner);
        router.pause();
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        vm.prank(buyer);
        rebates.payWithRebate(merchantId, address(usdc), USD, keccak256("lifecycle-2"));
        // …and after the window the merchant still exits with the remainder, pause and all.
        vm.warp(promoEnd + 1);
        uint256 remainder = _funded();
        vm.prank(merchantOwner);
        rebates.reclaim(merchantId, merchantOwner);
        assertEq(usdc.balanceOf(merchantOwner), remainder);
    }
}
