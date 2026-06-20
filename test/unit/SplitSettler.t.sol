// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { SplitSettler } from "../../src/SplitSettler.sol";
import { ISplitSettler } from "../../src/interfaces/ISplitSettler.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { FeeOnTransferToken } from "../mocks/FeeOnTransferToken.sol";
import { RevertingReceiver } from "../mocks/RevertingReceiver.sol";
import { BlocklistToken } from "../mocks/BlocklistToken.sol";
import { MockReturnsNothingToken } from "../mocks/MockReturnsNothingToken.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC2981 } from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    OwnableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @notice A trivial v2 implementation for the upgrade test: a subclass adding one view and changing
///         nothing else, so an upgrade to it must preserve all prior state. It carries no new storage
///         (it would consume from `__gap` if it did), proving the proxy keeps every slot across the swap.
contract SplitSettlerV2 is SplitSettler {
    /// @notice A marker the original implementation does not expose — proves the new logic is live.
    function version2Marker() external pure returns (string memory) {
        return "v2";
    }
}

/// @notice A native receiver that rejects ETH while `blocking`, then accepts once toggled off. Drives the
///         full never-blockable native path: a fanned-out share's {withdraw} fails (the credit stays
///         queued), the payee unblocks, and a second {withdraw} pays it out — proving the parked credit
///         is real and claimable, never lost. While blocking it can still be CREDITED (the fan-out is a
///         pull-credit, never an inline push), so a hostile payee can never block the OTHER legs.
contract ToggleableReceiver {
    bool public blocking = true;

    function setBlocking(bool b) external {
        blocking = b;
    }

    receive() external payable {
        if (blocking) revert("ToggleableReceiver: blocked");
    }
}

/// @notice The revenue-split unit suite: the full surface in one fixture — initializer, createSplit
///         (validation + immutability), setSplitActive, settleToken + settleNative (the two-stage
///         router-then-fan-out pipe), the per-payee pull-map (withdraw / withdrawTo), the never-blockable
///         guarantees, ERC-2981 share-shape, ERC-165, and the UUPS upgrade/freeze. Asserts the platform
///         fee is taken ONCE at the router (treasury gets exactly the router's cut), that Σ(fanned-out
///         legs) == net EXACTLY (the last leg absorbs rounding, no dust), and that one hostile payee can
///         never block the split for the others. Deployed BEHIND a UUPS proxy via the shared
///         {ProxyDeployer}, the production shape.
contract SplitSettlerTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    SplitSettler internal settler;

    address internal owner = makeAddr("owner"); // router admin
    address internal admin = makeAddr("admin"); // settler upgrade admin
    address internal treasury = makeAddr("treasury");
    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%

    address internal merchantOwner = makeAddr("merchantOwner");
    bytes32 internal constant NAME_HASH = keccak256("acme");

    // The five canonical payee legs: seller 70% · platform 5% · affiliate 10% · creator 10% · tax 5%.
    address internal seller = makeAddr("seller");
    address internal platform = makeAddr("platform");
    address internal affiliate = makeAddr("affiliate");
    address internal creator = makeAddr("creator");
    address internal tax = makeAddr("tax");
    address internal payer = makeAddr("payer");
    address internal stranger = makeAddr("stranger");

    MockV3Aggregator internal nativeFeed;
    MockV3Aggregator internal usdcFeed;
    MockUSDC internal usdc; // 6 dp

    uint256 internal merchantId;
    uint256 internal splitId;
    uint256 internal constant USD = 100e8; // $100 (8 decimals)

    function setUp() public virtual {
        vm.warp(1_700_000_000);

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (owner, treasury, PLATFORM_FEE_BPS))
            )
        );

        address settlerImpl = address(new SplitSettler());
        settler = SplitSettler(
            payable(deployProxy(
                    settlerImpl, abi.encodeCall(SplitSettler.initialize, (admin, router))
                ))
        );

        nativeFeed = new MockV3Aggregator(8, 2000e8); // $2000/ETH
        usdcFeed = new MockV3Aggregator(8, 1e8); // $1/USDC
        usdc = new MockUSDC();
        vm.startPrank(owner);
        router.setPriceFeed(address(0), address(nativeFeed));
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        // The merchant's router payout IS the settler — that is what returns the net here for the fan-out.
        // No merchant surcharge (feeBps 0): the ONLY fee on the path is the platform fee, taken once.
        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(address(settler), address(0), 0, NAME_HASH);

        splitId = _createCanonicalSplit();
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev The five canonical legs summing to 10_000 bps. Primary (ERC-2981) payee = the seller (idx 0).
    function _canonicalPayees() internal view returns (ISplitSettler.Payee[] memory p) {
        p = new ISplitSettler.Payee[](5);
        p[0] = ISplitSettler.Payee({ account: seller, shareBps: 7000 }); // 70%
        p[1] = ISplitSettler.Payee({ account: platform, shareBps: 500 }); // 5%
        p[2] = ISplitSettler.Payee({ account: affiliate, shareBps: 1000 }); // 10%
        p[3] = ISplitSettler.Payee({ account: creator, shareBps: 1000 }); // 10%
        p[4] = ISplitSettler.Payee({ account: tax, shareBps: 500 }); // 5%
    }

    function _createCanonicalSplit() internal returns (uint256 id) {
        vm.prank(merchantOwner);
        id = settler.createSplit(merchantId, _canonicalPayees(), 0);
    }

    /// @dev The router's platform-fee split of a gross (1%): fee → treasury, net → the settler.
    function _routerSplit(uint256 gross) internal pure returns (uint256 fee, uint256 net) {
        fee = gross * PLATFORM_FEE_BPS / 10_000;
        net = gross - fee;
    }

    /// @dev The five legs of a net under the canonical shares; the last (tax) absorbs the remainder.
    function _legs(uint256 net) internal pure returns (uint256[5] memory legs) {
        legs[0] = net * 7000 / 10_000;
        legs[1] = net * 500 / 10_000;
        legs[2] = net * 1000 / 10_000;
        legs[3] = net * 1000 / 10_000;
        legs[4] = net - legs[0] - legs[1] - legs[2] - legs[3]; // remainder
    }

    function _settleTokenAs(address who, uint256 id) internal returns (uint256 gross) {
        gross = router.quote(merchantId, address(usdc), USD);
        usdc.mint(who, gross);
        vm.startPrank(who);
        usdc.approve(address(settler), gross);
        settler.settleToken(id, address(usdc), USD, keccak256("order"));
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                              INITIALIZE
    //////////////////////////////////////////////////////////////*/

    function test_initializeSetsRouterNextIdAndOwner() public view {
        assertEq(address(settler.router()), address(router));
        assertEq(settler.nextSplitId(), 2); // one split created in setUp
        assertEq(OwnableUpgradeable(address(settler)).owner(), admin);
        assertEq(settler.TOTAL_BPS(), 10_000);
        assertEq(settler.MAX_PAYEES(), 64);
    }

    function test_initializeRevertsOnZeroRouter() public {
        address impl = address(new SplitSettler());
        vm.expectRevert(ISplitSettler.SplitSettler__ZeroAddress.selector);
        deployProxy(
            impl, abi.encodeCall(SplitSettler.initialize, (admin, Access0x1Router(payable(0))))
        );
    }

    function test_initializeRevertsOnSecondCall() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        settler.initialize(admin, router);
    }

    /*//////////////////////////////////////////////////////////////
                                CREATE
    //////////////////////////////////////////////////////////////*/

    function test_createStoresSplitAndEmits() public {
        ISplitSettler.Payee[] memory p = _canonicalPayees();
        vm.expectEmit(true, true, false, true, address(settler));
        emit ISplitSettler.SplitCreated(2, merchantId, 5, 1);
        vm.prank(merchantOwner);
        uint256 id = settler.createSplit(merchantId, p, 1);

        ISplitSettler.Split memory s = settler.splitOf(id);
        assertEq(s.merchantId, merchantId);
        assertEq(s.primaryIndex, 1);
        assertTrue(s.active);
        assertEq(s.payees.length, 5);
        assertEq(s.payees[0].account, seller);
        assertEq(s.payees[0].shareBps, 7000);
        assertEq(s.payees[4].account, tax);
        assertTrue(settler.isActive(id));
    }

    function test_createIncrementsId() public {
        vm.prank(merchantOwner);
        uint256 a = settler.createSplit(merchantId, _canonicalPayees(), 0);
        vm.prank(merchantOwner);
        uint256 b = settler.createSplit(merchantId, _canonicalPayees(), 0);
        assertEq(b, a + 1);
    }

    function test_createRevertsWhenNotMerchantOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISplitSettler.SplitSettler__NotMerchantOwner.selector, merchantId, stranger
            )
        );
        settler.createSplit(merchantId, _canonicalPayees(), 0);
    }

    function test_createRevertsForUnknownMerchant() public {
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISplitSettler.SplitSettler__NotMerchantOwner.selector, 999, merchantOwner
            )
        );
        settler.createSplit(999, _canonicalPayees(), 0);
    }

    function test_createRevertsOnEmptyPayees() public {
        ISplitSettler.Payee[] memory p = new ISplitSettler.Payee[](0);
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(ISplitSettler.SplitSettler__BadPayeeCount.selector, 0, 64)
        );
        settler.createSplit(merchantId, p, 0);
    }

    function test_createRevertsOnTooManyPayees() public {
        ISplitSettler.Payee[] memory p = new ISplitSettler.Payee[](65);
        for (uint256 i = 0; i < 65; ++i) {
            p[i] = ISplitSettler.Payee({ account: address(uint160(i + 1)), shareBps: 0 });
        }
        p[0].shareBps = 10_000;
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(ISplitSettler.SplitSettler__BadPayeeCount.selector, 65, 64)
        );
        settler.createSplit(merchantId, p, 0);
    }

    function test_createRevertsOnZeroPayeeAddress() public {
        ISplitSettler.Payee[] memory p = new ISplitSettler.Payee[](2);
        p[0] = ISplitSettler.Payee({ account: address(0), shareBps: 5000 });
        p[1] = ISplitSettler.Payee({ account: seller, shareBps: 5000 });
        vm.prank(merchantOwner);
        vm.expectRevert(ISplitSettler.SplitSettler__ZeroAddress.selector);
        settler.createSplit(merchantId, p, 0);
    }

    function test_createRevertsOnSharesUnderTotal() public {
        ISplitSettler.Payee[] memory p = new ISplitSettler.Payee[](2);
        p[0] = ISplitSettler.Payee({ account: seller, shareBps: 5000 });
        p[1] = ISplitSettler.Payee({ account: creator, shareBps: 4000 }); // sums to 9000
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISplitSettler.SplitSettler__SharesNotExact.selector, 9000, 10_000
            )
        );
        settler.createSplit(merchantId, p, 0);
    }

    function test_createRevertsOnSharesOverTotal() public {
        ISplitSettler.Payee[] memory p = new ISplitSettler.Payee[](2);
        p[0] = ISplitSettler.Payee({ account: seller, shareBps: 6000 });
        p[1] = ISplitSettler.Payee({ account: creator, shareBps: 5000 }); // sums to 11000
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISplitSettler.SplitSettler__SharesNotExact.selector, 11_000, 10_000
            )
        );
        settler.createSplit(merchantId, p, 0);
    }

    function test_createRevertsOnPrimaryIndexOutOfRange() public {
        ISplitSettler.Payee[] memory p = _canonicalPayees();
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(ISplitSettler.SplitSettler__BadPrimaryIndex.selector, 5, 5)
        );
        settler.createSplit(merchantId, p, 5); // valid indices are 0..4
    }

    function test_createAllowsSinglePayee() public {
        ISplitSettler.Payee[] memory p = new ISplitSettler.Payee[](1);
        p[0] = ISplitSettler.Payee({ account: seller, shareBps: 10_000 });
        vm.prank(merchantOwner);
        uint256 id = settler.createSplit(merchantId, p, 0);
        assertEq(settler.splitOf(id).payees.length, 1);
    }

    /*//////////////////////////////////////////////////////////////
                            SET ACTIVE
    //////////////////////////////////////////////////////////////*/

    function test_setActiveTogglesAndEmits() public {
        vm.expectEmit(true, false, false, true, address(settler));
        emit ISplitSettler.SplitActiveSet(splitId, false);
        vm.prank(merchantOwner);
        settler.setSplitActive(splitId, false);
        assertFalse(settler.isActive(splitId));

        vm.prank(merchantOwner);
        settler.setSplitActive(splitId, true);
        assertTrue(settler.isActive(splitId));
    }

    function test_setActiveRevertsWhenNotMerchantOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISplitSettler.SplitSettler__NotMerchantOwner.selector, merchantId, stranger
            )
        );
        settler.setSplitActive(splitId, false);
    }

    function test_setActiveRevertsForUnknownSplit() public {
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(ISplitSettler.SplitSettler__SplitUnknown.selector, 999)
        );
        settler.setSplitActive(999, false);
    }

    /*//////////////////////////////////////////////////////////////
                            SETTLE TOKEN
    //////////////////////////////////////////////////////////////*/

    function test_settleTokenRoutesThroughFeeSplitThenFansOut() public {
        uint256 gross = router.quote(merchantId, address(usdc), USD);
        (uint256 fee, uint256 net) = _routerSplit(gross);
        uint256[5] memory legs = _legs(net);

        usdc.mint(payer, gross);
        vm.startPrank(payer);
        usdc.approve(address(settler), gross);
        vm.expectEmit(true, true, true, true, address(settler));
        emit ISplitSettler.SplitSettled(splitId, payer, address(usdc), gross, net, keccak256("o"));
        settler.settleToken(splitId, address(usdc), USD, keccak256("o"));
        vm.stopPrank();

        // Platform fee taken ONCE at the router → treasury.
        assertEq(usdc.balanceOf(treasury), fee);
        // The settler holds exactly the net (== Σ unclaimed legs); no custody leak.
        assertEq(usdc.balanceOf(address(settler)), net);

        // Every leg is credited (pull-claimable), summing to net exactly.
        assertEq(settler.withdrawable(seller, address(usdc)), legs[0]);
        assertEq(settler.withdrawable(platform, address(usdc)), legs[1]);
        assertEq(settler.withdrawable(affiliate, address(usdc)), legs[2]);
        assertEq(settler.withdrawable(creator, address(usdc)), legs[3]);
        assertEq(settler.withdrawable(tax, address(usdc)), legs[4]);
        assertEq(legs[0] + legs[1] + legs[2] + legs[3] + legs[4], net);
    }

    function test_settleTokenEmitsShareCreditedPerLeg() public {
        uint256 gross = router.quote(merchantId, address(usdc), USD);
        (, uint256 net) = _routerSplit(gross);
        uint256[5] memory legs = _legs(net);

        usdc.mint(payer, gross);
        vm.startPrank(payer);
        usdc.approve(address(settler), gross);
        vm.expectEmit(true, true, true, true, address(settler));
        emit ISplitSettler.ShareCredited(splitId, seller, address(usdc), legs[0]);
        settler.settleToken(splitId, address(usdc), USD, keccak256("o"));
        vm.stopPrank();
    }

    function test_settleTokenPayeesCanWithdraw() public {
        uint256 gross = _settleTokenAs(payer, splitId);
        (, uint256 net) = _routerSplit(gross);
        uint256[5] memory legs = _legs(net);

        vm.prank(seller);
        settler.withdraw(address(usdc));
        assertEq(usdc.balanceOf(seller), legs[0]);
        assertEq(settler.withdrawable(seller, address(usdc)), 0);

        vm.prank(tax);
        settler.withdraw(address(usdc));
        assertEq(usdc.balanceOf(tax), legs[4]);

        // The settler still holds the four un-withdrawn legs.
        assertEq(usdc.balanceOf(address(settler)), net - legs[0] - legs[4]);
    }

    function test_settleTokenTwiceAccumulatesCredits() public {
        uint256 gross = _settleTokenAs(payer, splitId);
        _settleTokenAs(payer, splitId);
        (, uint256 net) = _routerSplit(gross);
        uint256[5] memory legs = _legs(net);
        // A split is a reusable target — two settlements double each leg's claimable credit.
        assertEq(settler.withdrawable(seller, address(usdc)), legs[0] * 2);
        assertEq(usdc.balanceOf(address(settler)), net * 2);
    }

    function test_settleTokenRevertsOnInactiveSplit() public {
        vm.prank(merchantOwner);
        settler.setSplitActive(splitId, false);

        uint256 gross = router.quote(merchantId, address(usdc), USD);
        usdc.mint(payer, gross);
        vm.startPrank(payer);
        usdc.approve(address(settler), gross);
        vm.expectRevert(
            abi.encodeWithSelector(ISplitSettler.SplitSettler__SplitInactive.selector, splitId)
        );
        settler.settleToken(splitId, address(usdc), USD, keccak256("o"));
        vm.stopPrank();
    }

    function test_settleTokenRevertsOnUnknownSplit() public {
        vm.expectRevert(
            abi.encodeWithSelector(ISplitSettler.SplitSettler__SplitUnknown.selector, 999)
        );
        vm.prank(payer);
        settler.settleToken(999, address(usdc), USD, keccak256("o"));
    }

    function test_settleTokenRevertsOnNativeWrongPath() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                ISplitSettler.SplitSettler__WrongSettlePath.selector, splitId, address(0)
            )
        );
        vm.prank(payer);
        settler.settleToken(splitId, address(0), USD, keccak256("o"));
    }

    function test_settleTokenRevertsOnFeeOnTransferToken() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        MockV3Aggregator fotFeed = new MockV3Aggregator(8, 1e8);
        vm.startPrank(owner);
        router.setTokenAllowed(address(fot), true);
        router.setPriceFeed(address(fot), address(fotFeed));
        vm.stopPrank();

        uint256 gross = router.quote(merchantId, address(fot), USD);
        fot.mint(payer, gross);
        vm.startPrank(payer);
        fot.approve(address(settler), gross);
        // The pull's balance delta is short by the 1% skim → rejected before any routing.
        vm.expectRevert(
            abi.encodeWithSelector(
                ISplitSettler.SplitSettler__FeeOnTransferToken.selector, gross, gross - gross / 100
            )
        );
        settler.settleToken(splitId, address(fot), USD, keccak256("o"));
        vm.stopPrank();
    }

    function test_settleTokenWorksWithUsdtStyleNoReturnToken() public {
        MockReturnsNothingToken usdt = new MockReturnsNothingToken();
        MockV3Aggregator usdtFeed = new MockV3Aggregator(8, 1e8);
        vm.startPrank(owner);
        router.setTokenAllowed(address(usdt), true);
        router.setPriceFeed(address(usdt), address(usdtFeed));
        vm.stopPrank();

        uint256 gross = router.quote(merchantId, address(usdt), USD);
        (, uint256 net) = _routerSplit(gross);
        usdt.mint(payer, gross);
        vm.startPrank(payer);
        usdt.approve(address(settler), gross);
        settler.settleToken(splitId, address(usdt), USD, keccak256("o"));
        vm.stopPrank();
        assertEq(usdt.balanceOf(address(settler)), net);
        assertEq(settler.withdrawable(seller, address(usdt)), net * 7000 / 10_000);
    }

    /*//////////////////////////////////////////////////////////////
                            SETTLE NATIVE
    //////////////////////////////////////////////////////////////*/

    function test_settleNativeRoutesThroughFeeSplitThenFansOut() public {
        uint256 gross = router.quote(merchantId, address(0), USD);
        (uint256 fee, uint256 net) = _routerSplit(gross);
        uint256[5] memory legs = _legs(net);

        vm.deal(payer, gross);
        vm.expectEmit(true, true, true, true, address(settler));
        emit ISplitSettler.SplitSettled(splitId, payer, address(0), gross, net, keccak256("o"));
        vm.prank(payer);
        settler.settleNative{ value: gross }(splitId, USD, keccak256("o"));

        assertEq(treasury.balance, fee); // platform fee once, at the router
        assertEq(address(settler).balance, net); // settler holds exactly the net
        assertEq(settler.withdrawable(seller, address(0)), legs[0]);
        assertEq(settler.withdrawable(tax, address(0)), legs[4]);
        assertEq(legs[0] + legs[1] + legs[2] + legs[3] + legs[4], net);
    }

    function test_settleNativeRefundsExcess() public {
        uint256 gross = router.quote(merchantId, address(0), USD);
        uint256 sent = gross + 0.3 ether;
        vm.deal(payer, sent);
        vm.prank(payer);
        settler.settleNative{ value: sent }(splitId, USD, keccak256("o"));

        (, uint256 net) = _routerSplit(gross);
        // The excess returned to the payer; the settler holds exactly the net (the excess never leaked
        // into the fan-out — it cancels in the net delta).
        assertEq(payer.balance, 0.3 ether);
        assertEq(address(settler).balance, net);
    }

    function test_settleNativeRevertsUnderpaid() public {
        uint256 gross = router.quote(merchantId, address(0), USD);
        vm.deal(payer, gross - 1);
        vm.expectRevert(
            abi.encodeWithSelector(ISplitSettler.SplitSettler__Underpaid.selector, gross, gross - 1)
        );
        vm.prank(payer);
        settler.settleNative{ value: gross - 1 }(splitId, USD, keccak256("o"));
    }

    function test_settleNativeRevertsWhenRefundFails() public {
        RevertingReceiver rr = new RevertingReceiver();
        uint256 gross = router.quote(merchantId, address(0), USD);
        uint256 sent = gross + 1 ether;
        vm.deal(address(rr), sent);
        // The reverting contract pays with excess; its refund push fails → the whole settle reverts
        // (the buyer is present and must not silently lose the excess).
        vm.prank(address(rr));
        vm.expectRevert(
            abi.encodeWithSelector(
                ISplitSettler.SplitSettler__NativeRefundFailed.selector, address(rr), 1 ether
            )
        );
        settler.settleNative{ value: sent }(splitId, USD, keccak256("o"));
    }

    function test_settleNativeRevertsOnInactiveSplit() public {
        vm.prank(merchantOwner);
        settler.setSplitActive(splitId, false);
        uint256 gross = router.quote(merchantId, address(0), USD);
        vm.deal(payer, gross);
        vm.expectRevert(
            abi.encodeWithSelector(ISplitSettler.SplitSettler__SplitInactive.selector, splitId)
        );
        vm.prank(payer);
        settler.settleNative{ value: gross }(splitId, USD, keccak256("o"));
    }

    /*//////////////////////////////////////////////////////////////
                        NEVER-BLOCKABLE / WITHDRAW
    //////////////////////////////////////////////////////////////*/

    function test_hostileNativePayeeNeverBlocksTheOthers() public {
        // Build a split where one leg is a contract that reverts on receive: the fan-out CREDITS it
        // (pull, never push), so the other legs settle and withdraw normally; the hostile leg's credit
        // sits claimable, never blocking the split.
        ToggleableReceiver hostile = new ToggleableReceiver();
        ISplitSettler.Payee[] memory p = new ISplitSettler.Payee[](2);
        p[0] = ISplitSettler.Payee({ account: seller, shareBps: 6000 });
        p[1] = ISplitSettler.Payee({ account: address(hostile), shareBps: 4000 });
        vm.prank(merchantOwner);
        uint256 id = settler.createSplit(merchantId, p, 0);

        uint256 gross = router.quote(merchantId, address(0), USD);
        (, uint256 net) = _routerSplit(gross);
        vm.deal(payer, gross);
        vm.prank(payer);
        settler.settleNative{ value: gross }(id, USD, keccak256("o")); // does NOT revert

        uint256 sellerLeg = net * 6000 / 10_000;
        uint256 hostileLeg = net - sellerLeg;
        assertEq(settler.withdrawable(seller, address(0)), sellerLeg);
        assertEq(settler.withdrawable(address(hostile), address(0)), hostileLeg);

        // The good payee withdraws now; the hostile payee's withdraw reverts while it blocks…
        vm.prank(seller);
        settler.withdraw(address(0));
        assertEq(seller.balance, sellerLeg);

        vm.prank(address(hostile));
        vm.expectRevert(
            abi.encodeWithSelector(
                ISplitSettler.SplitSettler__WithdrawFailed.selector, address(hostile), hostileLeg
            )
        );
        settler.withdraw(address(0));
        // …its credit is intact, claimable once it can receive.
        assertEq(settler.withdrawable(address(hostile), address(0)), hostileLeg);

        // It unblocks and pulls its parked credit — nothing was lost.
        hostile.setBlocking(false);
        vm.prank(address(hostile));
        settler.withdraw(address(0));
        assertEq(address(hostile).balance, hostileLeg);
        assertEq(settler.withdrawable(address(hostile), address(0)), 0);
    }

    function test_withdrawToRedirectsOwnCredit() public {
        ToggleableReceiver hostile = new ToggleableReceiver();
        ISplitSettler.Payee[] memory p = new ISplitSettler.Payee[](2);
        p[0] = ISplitSettler.Payee({ account: seller, shareBps: 6000 });
        p[1] = ISplitSettler.Payee({ account: address(hostile), shareBps: 4000 });
        vm.prank(merchantOwner);
        uint256 id = settler.createSplit(merchantId, p, 0);

        uint256 gross = router.quote(merchantId, address(0), USD);
        (, uint256 net) = _routerSplit(gross);
        vm.deal(payer, gross);
        vm.prank(payer);
        settler.settleNative{ value: gross }(id, USD, keccak256("o"));

        uint256 hostileLeg = net - net * 6000 / 10_000;
        // The hostile payee can never receive at its own address, so it redirects to a fresh EOA.
        address rescue = makeAddr("rescue");
        vm.prank(address(hostile));
        settler.withdrawTo(address(0), rescue);
        assertEq(rescue.balance, hostileLeg);
        assertEq(settler.withdrawable(address(hostile), address(0)), 0);
    }

    function test_withdrawRevertsOnNothingOwed() public {
        vm.prank(seller);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISplitSettler.SplitSettler__NothingToWithdraw.selector, address(usdc)
            )
        );
        settler.withdraw(address(usdc));
    }

    function test_withdrawToRevertsOnZeroAddress() public {
        _settleTokenAs(payer, splitId);
        vm.prank(seller);
        vm.expectRevert(ISplitSettler.SplitSettler__ZeroAddress.selector);
        settler.withdrawTo(address(usdc), address(0));
    }

    function test_withdrawToRevertsOnNothingOwed() public {
        vm.prank(seller);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISplitSettler.SplitSettler__NothingToWithdraw.selector, address(usdc)
            )
        );
        settler.withdrawTo(address(usdc), stranger);
    }

    function test_withdrawToRevertsWhenRedirectFails() public {
        // Token redirect to a blocklisted address fails → the whole withdrawTo reverts, credit restored.
        BlocklistToken bl = new BlocklistToken();
        MockV3Aggregator blFeed = new MockV3Aggregator(8, 1e8);
        vm.startPrank(owner);
        router.setTokenAllowed(address(bl), true);
        router.setPriceFeed(address(bl), address(blFeed));
        vm.stopPrank();

        uint256 gross = router.quote(merchantId, address(bl), USD);
        bl.mint(payer, gross);
        vm.startPrank(payer);
        bl.approve(address(settler), gross);
        settler.settleToken(splitId, address(bl), USD, keccak256("o"));
        vm.stopPrank();

        uint256 sellerCredit = settler.withdrawable(seller, address(bl));
        bl.setBlocked(stranger, true);
        vm.prank(seller);
        vm.expectRevert(); // SafeERC20 bubbles the BlocklistToken recipient-blocked revert
        settler.withdrawTo(address(bl), stranger);
        // Credit untouched by the reverted redirect.
        assertEq(settler.withdrawable(seller, address(bl)), sellerCredit);
    }

    /*//////////////////////////////////////////////////////////////
                            PREVIEW / ERC-2981
    //////////////////////////////////////////////////////////////*/

    function test_previewSplitMatchesFanOut() public view {
        uint256 net = 99e6 + 7; // an awkward net so flooring + remainder is exercised
        uint256[] memory amounts = settler.previewSplit(splitId, net);
        uint256[5] memory legs = _legs(net);
        assertEq(amounts.length, 5);
        uint256 sum;
        for (uint256 i = 0; i < 5; ++i) {
            assertEq(amounts[i], legs[i]);
            sum += amounts[i];
        }
        assertEq(sum, net); // Σ == net exactly (no dust)
    }

    function test_previewSplitRevertsOnUnknownSplit() public {
        vm.expectRevert(
            abi.encodeWithSelector(ISplitSettler.SplitSettler__SplitUnknown.selector, 999)
        );
        settler.previewSplit(999, 100);
    }

    function test_royaltyInfoReportsPrimaryPayee() public {
        // Primary = seller (idx 0), 70% share. royaltyInfo(splitId, salePrice).
        (address receiver, uint256 amount) = settler.royaltyInfo(splitId, 1000e6);
        assertEq(receiver, seller);
        assertEq(amount, 1000e6 * 7000 / 10_000);
    }

    function test_royaltyInfoHonoursPrimaryIndex() public {
        // Create a split whose primary is the creator (idx 3, 10%).
        vm.prank(merchantOwner);
        uint256 id = settler.createSplit(merchantId, _canonicalPayees(), 3);
        (address receiver, uint256 amount) = settler.royaltyInfo(id, 1000e6);
        assertEq(receiver, creator);
        assertEq(amount, 1000e6 * 1000 / 10_000);
    }

    function test_royaltyInfoUnknownSplitIsNoRoyalty() public view {
        (address receiver, uint256 amount) = settler.royaltyInfo(999, 1000e6);
        assertEq(receiver, address(0));
        assertEq(amount, 0);
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    function test_supportsInterface() public view {
        assertTrue(settler.supportsInterface(type(ISplitSettler).interfaceId));
        assertTrue(settler.supportsInterface(type(IERC2981).interfaceId));
        assertTrue(settler.supportsInterface(type(IERC165).interfaceId));
        assertFalse(settler.supportsInterface(0xffffffff));
        assertFalse(settler.supportsInterface(bytes4(0xdeadbeef)));
    }

    /*//////////////////////////////////////////////////////////////
                            UPGRADE / FREEZE
    //////////////////////////////////////////////////////////////*/

    function test_upgradePreservesStateAndIsOwnerGated() public {
        // Settle once so there is state to preserve across the swap.
        uint256 gross = _settleTokenAs(payer, splitId);
        (, uint256 net) = _routerSplit(gross);
        uint256 sellerCredit = settler.withdrawable(seller, address(usdc));

        address v2 = address(new SplitSettlerV2());
        vm.prank(admin);
        UUPSUpgradeable(address(settler)).upgradeToAndCall(v2, "");

        assertEq(SplitSettlerV2(payable(address(settler))).version2Marker(), "v2");
        // All prior state survives.
        assertEq(settler.withdrawable(seller, address(usdc)), sellerCredit);
        assertEq(settler.splitOf(splitId).payees.length, 5);
        assertEq(usdc.balanceOf(address(settler)), net);
    }

    function test_upgradeRevertsForNonOwner() public {
        address v2 = address(new SplitSettlerV2());
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger)
        );
        UUPSUpgradeable(address(settler)).upgradeToAndCall(v2, "");
    }

    function test_renounceFreezesUpgrades() public {
        vm.prank(admin);
        OwnableUpgradeable(address(settler)).renounceOwnership();
        address v2 = address(new SplitSettlerV2());
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, admin)
        );
        UUPSUpgradeable(address(settler)).upgradeToAndCall(v2, "");
    }
}
