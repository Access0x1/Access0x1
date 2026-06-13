// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Subscriptions } from "../../src/Access0x1Subscriptions.sol";
import {
    IAccess0x1Subscriptions,
    IAccess0x1Router
} from "../../src/interfaces/IAccess0x1Subscriptions.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { SessionGrant } from "../../src/SessionGrant.sol";
import { ISessionGrant } from "../../src/interfaces/ISessionGrant.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";

contract GasKeeper {
    Access0x1Subscriptions public immutable subs;

    constructor(Access0x1Subscriptions s) {
        subs = s;
    }

    function renewWithGas(uint256 subId, uint256 g) external returns (bool ok, bytes memory ret) {
        (ok, ret) = address(subs).call{ gas: g }(abi.encodeWithSelector(subs.renew.selector, subId));
    }
}

/// @notice PROBE: sweep the gas forwarded to {renew} to find any window where the INNER charge OOGs
///         (caught -> dun) while the OUTER renew tx SUCCEEDS (returns ok=true), which would let a
///         griefer demote a funded, in-budget subscriber to PAST_DUE/UNPAID at will. We assert the
///         money safety net holds in EVERY outcome: a successful-but-dunned outer call must have spent
///         NO budget and delivered NOTHING (retriable), and the honest keeper always completes.
contract GasGriefProbeTest is Test {
    Access0x1Subscriptions internal subsC;
    Access0x1Router internal router;
    SessionGrant internal grant;
    MockUSDC internal usdc;
    MockV3Aggregator internal feed;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal subscriber;
    uint256 internal merchantId;

    uint8 internal constant PLAN_KEY = 1;
    uint256 internal constant PRICE_USD8 = 50e8;
    uint32 internal constant PERIOD = 30 days;

    function setUp() public {
        vm.warp(1_700_000_000);
        subscriber = makeAddr("subscriber");
        usdc = new MockUSDC();
        feed = new MockV3Aggregator(8, 1e8);
        router = new Access0x1Router(admin, treasury, 100);
        grant = new SessionGrant("Access0x1 SessionGrant", "1");
        subsC = new Access0x1Subscriptions(
            admin, IAccess0x1Router(address(router)), ISessionGrant(address(grant)), 3
        );
        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(feed));
        vm.stopPrank();
        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, address(0), 0, keccak256("m"));
        vm.prank(merchantOwner);
        subsC.setPlan(merchantId, PLAN_KEY, PRICE_USD8, PERIOD, true);
        usdc.mint(subscriber, 1_000_000e6);
        vm.prank(subscriber);
        usdc.approve(address(subsC), type(uint256).max);
    }

    /// @dev Sweep forwarded gas; for any outcome where the OUTER call succeeded but the sub DUNNED,
    ///      assert no budget was spent and nothing delivered (a clean retriable no-op). Then confirm
    ///      the honest keeper can always complete the charge with full gas.
    function test_gasGriefSweep_dunIsAlwaysCleanNoOp() public {
        vm.prank(subscriber);
        bytes32 sessionId =
            grant.openSession(address(subsC), PRICE_USD8 * 50, uint64(block.timestamp + 3650 days));
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        GasKeeper k = new GasKeeper(subsC);

        uint256 forcedDunWithOuterSuccess;
        // Sweep a band of gas values around the realistic renew cost (~120k-520k).
        for (uint256 g = 40_000; g <= 520_000; g += 5_000) {
            // Fresh state each iteration: re-fund/re-warp so the sub is due + payable.
            uint256 snap = vm.snapshotState();
            vm.warp(block.timestamp + PERIOD);
            feed.updateAnswer(1e8);

            uint256 remBefore = grant.remaining(sessionId);
            uint256 paidBefore = usdc.balanceOf(payout) + usdc.balanceOf(treasury);

            (bool ok,) = k.renewWithGas{ gas: g + 80_000 }(subId, g);

            IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
            bool dunned = s.status == IAccess0x1Subscriptions.SubStatus.PAST_DUE
                || s.status == IAccess0x1Subscriptions.SubStatus.UNPAID;

            if (ok && dunned) {
                forcedDunWithOuterSuccess++;
                // The money safety net: a dunned-but-successful outer call spent NO budget and
                // delivered NOTHING — it is a clean, retriable no-op, never a half-charge.
                assertEq(grant.remaining(sessionId), remBefore, "forced-dun spent no budget");
                assertEq(
                    usdc.balanceOf(payout) + usdc.balanceOf(treasury),
                    paidBefore,
                    "forced-dun delivered nothing"
                );
            }
            // No custody EVER, regardless of outcome.
            assertEq(usdc.balanceOf(address(subsC)), 0, "no custody during gas sweep");
            vm.revertToState(snap);
        }

        // Whatever the griefer managed, the honest keeper with full gas always completes the charge.
        vm.warp(block.timestamp + PERIOD);
        feed.updateAnswer(1e8);
        uint256 charged = subsC.renew(subId);
        assertGt(charged, 0, "honest keeper always completes");
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE));

        emit log_named_uint(
            "gas values that forced a dun with outer success", forcedDunWithOuterSuccess
        );
    }
}
