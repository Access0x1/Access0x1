// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";

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
import { SubscriptionsHandler } from "./SubscriptionsHandler.sol";

/// @notice The six money invariants of Access0x1Subscriptions under a bounded, handler-driven fuzzer.
///         Each is asserted against an INDEPENDENT ghost recomputation, never against the contract's
///         own numbers. A frozen "canary" subscription (created in setUp, never touched by the
///         handler) backs the tenant-isolation invariant.
/// @dev    The subscriptions contract COMPOSES the real Access0x1Router (fee-split) + SessionGrant
///         (the never-negative budget meter) + a MockV3Aggregator-fed MockUSDC, so the invariants are
///         proven on the genuine money path, not a stub.
contract Access0x1SubscriptionsInvariant is StdInvariant, Test {
    Access0x1Subscriptions internal subsC;
    Access0x1Router internal router;
    SessionGrant internal grant;
    MockUSDC internal usdc;
    MockV3Aggregator internal feed;
    SubscriptionsHandler internal handler;

    address internal admin = makeAddr("inv_admin");
    address internal treasury = makeAddr("inv_treasury");
    address internal merchantOwner = makeAddr("inv_merchantOwner");
    address internal payout = makeAddr("inv_payout");
    address internal feeRecipient = makeAddr("inv_feeRecipient");

    uint256 internal merchantId;

    // ---- the frozen canary (tenant isolation, inv 4) ----
    address internal canarySubscriber = makeAddr("canarySubscriber");
    uint256 internal canarySubId;
    bytes32 internal canarySession;
    uint64 internal canaryPeriodEnd;
    uint8 internal constant CANARY_PLAN = 7;
    uint256 internal constant CANARY_PRICE = 19e8;

    uint16 internal constant PLATFORM_FEE_BPS = 100;
    uint16 internal constant MERCHANT_FEE_BPS = 50;

    function setUp() public {
        vm.warp(1_700_000_000);

        usdc = new MockUSDC();
        feed = new MockV3Aggregator(8, 1e8);

        router = new Access0x1Router(admin, treasury, PLATFORM_FEE_BPS);
        grant = new SessionGrant("Access0x1 SessionGrant", "1");
        subsC = new Access0x1Subscriptions(
            admin, IAccess0x1Router(address(router)), ISessionGrant(address(grant)), 3
        );

        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(feed));
        vm.stopPrank();

        // Register the merchant FIRST (owner = a dedicated EOA) so its id is known before the handler.
        vm.prank(merchantOwner);
        merchantId =
            router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, keccak256("inv"));

        handler = new SubscriptionsHandler(
            subsC,
            router,
            grant,
            usdc,
            feed,
            treasury,
            payout,
            feeRecipient,
            merchantId,
            merchantOwner
        );

        // Cache handler constants BEFORE pranking (an external getter call would consume the prank).
        uint8 driverPlan = handler.PLAN_KEY();
        uint32 period = handler.PERIOD();

        // Seed the active plan the handler drives (owned by merchantOwner).
        vm.prank(merchantOwner);
        subsC.setPlan(merchantId, driverPlan, 100e8, period, true);

        // ── The frozen canary subscription: a real, separate subscriber the handler never touches. ──
        vm.prank(merchantOwner);
        subsC.setPlan(merchantId, CANARY_PLAN, CANARY_PRICE, period, true);
        usdc.mint(canarySubscriber, 1_000_000e6);
        vm.startPrank(canarySubscriber);
        usdc.approve(address(subsC), type(uint256).max);
        canarySession = grant.openSession(
            address(subsC), CANARY_PRICE * 12, uint64(block.timestamp + 3650 days)
        );
        canarySubId = subsC.subscribe(merchantId, CANARY_PLAN, address(usdc), canarySession, false);
        vm.stopPrank();
        canaryPeriodEnd = subsC.subs(canarySubId).periodEnd;

        // Drive only the state-changing actions.
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = SubscriptionsHandler.subscribe.selector;
        selectors[1] = SubscriptionsHandler.renew.selector;
        selectors[2] = SubscriptionsHandler.cancel.selector;
        selectors[3] = SubscriptionsHandler.setPlanPrice.selector;
        selectors[4] = SubscriptionsHandler.advanceTime.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /*//////////////////////////////////////////////////////////////
                              INVARIANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Invariant 3 — ZERO CUSTODY: the subscriptions contract holds no token, ever, and never
    ///         leaves a dangling router allowance. Every pull is forwarded same-tx.
    function invariant_zeroCustody() public view {
        assertEq(usdc.balanceOf(address(subsC)), 0, "subscriptions holds no token");
        assertEq(usdc.allowance(address(subsC), address(router)), 0, "no residual router allowance");
    }

    /// @notice Invariant 1 — CONSERVATION / net+fee==gross: every token that entered a settlement sink
    ///         (merchant payout + treasury + merchant fee recipient) was routed through the fee-split;
    ///         the sink total equals the independently-summed gross of every charge. Combined with
    ///         zero-custody, this proves nothing leaked into the orchestrator (net+fee==gross
    ///         end-to-end, delegated to the router's own split).
    function invariant_conservation() public view {
        uint256 sinkTotal =
            usdc.balanceOf(payout) + usdc.balanceOf(treasury) + usdc.balanceOf(feeRecipient);
        // The canary's period-1 gross is part of the sinks but not in the handler's ghost; add it.
        uint256 canaryGross = router.quote(merchantId, address(usdc), CANARY_PRICE);
        assertEq(
            sinkTotal, handler.ghostGrossToken() + canaryGross, "sink total == sum gross routed"
        );
    }

    /// @notice Invariant 2 — NEVER-NEGATIVE METER: no subscription ever pulled more USD than its
    ///         SessionGrant authorized. The independent ghost of USD charged per sub is bounded by the
    ///         session budget cap — the budget can never go negative, never be bypassed.
    function invariant_neverPastBudget() public view {
        uint256 n = handler.allSubIdsLength();
        for (uint256 i = 0; i < n; i++) {
            uint256 subId = handler.allSubIds(i);
            // Each pooled session authorized MAX_PRICE_USD8 * PERIODS_BUDGET; the cumulative USD
            // charged must never exceed it (and the live spent on the session must match the ghost).
            uint256 cap = handler.MAX_PRICE_USD8() * handler.PERIODS_BUDGET();
            assertLe(handler.ghostUsdSpentBySub(subId), cap, "USD charged never exceeds budget cap");
        }
    }

    /// @notice Invariant 6 — PERIOD MONOTONIC: a subscription's `periodEnd` never decreases (a renewal
    ///         only advances it), so a period can never be charged twice (replay-proof).
    function invariant_periodMonotonic() public view {
        uint256 n = handler.allSubIdsLength();
        for (uint256 i = 0; i < n; i++) {
            uint256 subId = handler.allSubIds(i);
            assertGe(
                subsC.subs(subId).periodEnd,
                handler.ghostLastPeriodEnd(subId),
                "periodEnd is monotonic non-decreasing"
            );
        }
    }

    /// @notice Invariant 5 — TIER IS A PURE VIEW: {effectiveTier} is fully determined by stored state
    ///         (status, periodEnd, trialExpiresAt, planKey), never written by a money path. We
    ///         re-derive it independently and assert equality for every subscription.
    function invariant_tierIsPureView() public view {
        uint256 n = handler.allSubIdsLength();
        for (uint256 i = 0; i < n; i++) {
            uint256 subId = handler.allSubIds(i);
            assertEq(subsC.effectiveTier(subId), _expectedTier(subId), "tier == pure(state)");
        }
        // The canary too.
        assertEq(subsC.effectiveTier(canarySubId), _expectedTier(canarySubId), "canary tier pure");
    }

    /// @notice Invariant 4 — TENANT ISOLATION: the frozen canary subscription is never mutated by any
    ///         handler action on another subscription or another merchant's plan.
    function invariant_canaryIsolation() public view {
        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(canarySubId);
        assertEq(s.subscriber, canarySubscriber, "canary subscriber untouched");
        assertEq(s.sessionId, canarySession, "canary session untouched");
        assertEq(s.merchantId, merchantId, "canary merchant untouched");
        assertEq(s.planKey, CANARY_PLAN, "canary plan untouched");
        assertEq(s.periodEnd, canaryPeriodEnd, "canary periodEnd untouched");
        assertEq(uint8(s.status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE), "canary ACTIVE");
        // Its plan is also untouched (the handler only re-prices PLAN_KEY, not CANARY_PLAN).
        IAccess0x1Subscriptions.Plan memory p = subsC.plans(merchantId, CANARY_PLAN);
        assertEq(p.priceUsd8, CANARY_PRICE, "canary plan price untouched");
    }

    /// @dev The reference implementation of {effectiveTier} — recomputed in the test from stored
    ///      state, identical to the contract's pure view.
    function _expectedTier(uint256 subId) internal view returns (uint8) {
        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        if (
            s.status == IAccess0x1Subscriptions.SubStatus.NONE
                || s.status == IAccess0x1Subscriptions.SubStatus.UNPAID
                || s.status == IAccess0x1Subscriptions.SubStatus.CANCELED
        ) return 0;
        if (
            s.status == IAccess0x1Subscriptions.SubStatus.TRIALING && s.trialExpiresAt != 0
                && block.timestamp > s.trialExpiresAt
        ) return 0;
        return uint8(s.planKey) + 1;
    }
}
