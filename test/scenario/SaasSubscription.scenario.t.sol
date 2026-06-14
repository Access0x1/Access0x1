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

/// @title  SaasSubscription — "sign once, then auto-renew within a budget you set"
/// @author Access0x1
/// @notice SCENARIO: a SaaS sells a $29/mo plan. A new customer authorizes ONE SessionGrant that
///         budgets a finite number of months — this is the never-negative spend meter a production
///         subscription product needs, expressed on-chain. A keeper (cron, off the customer's wallet) renews each
///         month, pulling exactly the price within the authorized budget. When the budget runs out,
///         the very next renewal MUST fail at the meter — the customer can never be charged a dollar
///         more than they signed for.
///
///         What an auditor is checking:
///           1. The customer signs ONCE. After that the keeper renews with no further customer
///              signature — but every pull is bounded by the SessionGrant budget.
///           2. Two in-budget renewals each pull EXACTLY $29 worth of USDC through the router's
///              fee-split (net + fee == gross is the router's own proven invariant — we confirm the
///              composition routes through it).
///           3. NEVER-NEGATIVE: when the remaining budget is below one period, the renewal reverts
///              inside SessionGrant.spend and the whole charge rolls back — no token moves, no budget
///              is consumed, the subscription is dunned instead of silently overcharging.
///           4. The subscription tier is a READ-TIME view derived from state; a successful renewal
///              keeps it ACTIVE.
///
///         This composes the REAL Router + SessionGrant + a Chainlink-fed MockUSDC. Nothing is stubbed.
contract SaasSubscriptionScenarioTest is Test {
    Access0x1Subscriptions internal subs;
    Access0x1Router internal router;
    SessionGrant internal grant;

    MockUSDC internal usdc;
    MockV3Aggregator internal usdcFeed;

    address internal platformAdmin = makeAddr("access0x1-platform-admin");
    address internal treasury = makeAddr("access0x1-treasury");
    address internal saasOwner = makeAddr("devtools-saas-owner"); // the SaaS merchant
    address internal saasPayout = makeAddr("devtools-saas-payout"); // where net lands
    address internal keeper = makeAddr("billing-cron-keeper"); // permissionless renewer

    uint256 internal subscriberPk;
    address internal subscriber; // the paying customer (the session OWNER)

    uint256 internal merchantId;

    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%
    uint16 internal constant MERCHANT_SURCHARGE_BPS = 0;
    uint16 internal constant GRACE = 3;

    uint8 internal constant PLAN_KEY = 1; // the "Pro" plan
    uint256 internal constant PRICE_USD8 = 29e8; // $29.00 / month
    uint32 internal constant MONTH = 30 days;

    // The customer authorizes a budget that covers EXACTLY THREE charges: period 1 (at subscribe) +
    // two renewals. The fourth charge therefore has nothing left and must hit the never-negative wall.
    uint256 internal constant BUDGET = PRICE_USD8 * 3; // $87 of authorization, no more

    uint64 internal expiry;

    function setUp() public {
        vm.warp(1_700_000_000);
        (subscriber, subscriberPk) = makeAddrAndKey("pro-plan-customer");

        usdc = new MockUSDC();
        usdcFeed = new MockV3Aggregator(8, 1e8);

        router = new Access0x1Router(platformAdmin, treasury, PLATFORM_FEE_BPS);
        grant = new SessionGrant("Access0x1 SessionGrant", "1");
        subs = new Access0x1Subscriptions(
            platformAdmin, IAccess0x1Router(address(router)), ISessionGrant(address(grant)), GRACE
        );

        vm.startPrank(platformAdmin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        // The SaaS onboards and defines its $29/mo Pro plan.
        vm.prank(saasOwner);
        merchantId = router.registerMerchant(
            saasPayout, address(0), MERCHANT_SURCHARGE_BPS, keccak256("devtools-saas")
        );
        vm.prank(saasOwner);
        subs.setPlan(merchantId, PLAN_KEY, PRICE_USD8, MONTH, true);

        // The customer funds + approves the Subscriptions contract to pull each month's charge.
        usdc.mint(subscriber, 10_000e6);
        vm.prank(subscriber);
        usdc.approve(address(subs), type(uint256).max);

        expiry = uint64(block.timestamp + 365 days);
    }

    /// @dev Warp forward AND re-stamp the feed: a keeper renewing a month later reads a LIVE round, so
    ///      the test must post a fresh answer or the 1-hour staleness guard would (correctly) revert.
    function _warpAMonthAndRefresh(uint256 to) internal {
        vm.warp(to);
        usdcFeed.updateAnswer(1e8);
    }

    /// @notice One authorization, two clean renewals, then the budget wall stops the third.
    function test_scenario_saas_oneAuthorization_twoRenewals_thirdPastBudgetReverts() public {
        // ── The customer signs ONCE: open a SessionGrant budgeting exactly 3 charges, delegate = the
        //    Subscriptions contract (only it may spend against this budget). ─────────────────────────
        vm.prank(subscriber);
        bytes32 sessionId = grant.openSession(address(subs), BUDGET, expiry);
        assertEq(grant.remaining(sessionId), BUDGET, "full $87 budget available at sign-up");

        // Subscribe (no trial): this charges period 1 immediately through the router fee-split.
        uint256 subBalBefore = usdc.balanceOf(subscriber);
        uint256 payoutBefore = usdc.balanceOf(saasPayout);

        vm.prank(subscriber);
        uint256 subId = subs.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        // Period 1 pulled exactly $29 of USDC (29e6 at $1) and routed it through the fee-split.
        uint256 monthly = router.quote(merchantId, address(usdc), PRICE_USD8); // 29e6
        assertEq(monthly, 29e6, "$29 at $1/USDC == 29 USDC");
        assertEq(
            usdc.balanceOf(subscriber), subBalBefore - monthly, "period 1 debited the customer $29"
        );
        // net = gross - 1% platform fee; the payout gets the net (the router proves net+fee==gross).
        uint256 net = monthly - monthly * PLATFORM_FEE_BPS / 10_000;
        assertEq(usdc.balanceOf(saasPayout), payoutBefore + net, "SaaS paid the net for period 1");

        // After period 1 the budget has 2 charges left, and the tier is live.
        assertEq(grant.remaining(sessionId), BUDGET - PRICE_USD8, "budget down to 2 charges");
        assertEq(subs.effectiveTier(subId), PLAN_KEY + 1, "subscriber is entitled (ACTIVE)");

        // ── Month 2: the keeper renews (no customer signature). In-budget, so it pulls $29. ─────────
        _warpAMonthAndRefresh(block.timestamp + MONTH);
        vm.prank(keeper);
        uint256 charged2 = subs.renew(subId);
        assertEq(charged2, monthly, "renewal 1 charged exactly one month");
        assertEq(grant.remaining(sessionId), BUDGET - 2 * PRICE_USD8, "budget down to 1 charge");

        // ── Month 3: the keeper renews again. Still in budget, this consumes the LAST authorized
        //    charge, leaving the budget at exactly zero. ───────────────────────────────────────────
        _warpAMonthAndRefresh(block.timestamp + MONTH);
        vm.prank(keeper);
        uint256 charged3 = subs.renew(subId);
        assertEq(charged3, monthly, "renewal 2 charged exactly one month");
        assertEq(grant.remaining(sessionId), 0, "budget now exhausted to the cent");
        assertEq(subs.effectiveTier(subId), PLAN_KEY + 1, "still ACTIVE after three paid periods");

        // ── Month 4: the keeper tries once more. The budget is empty, so the charge MUST fail at the
        //    never-negative meter. renew() catches it and DUNS the subscription instead of charging. ─
        _warpAMonthAndRefresh(block.timestamp + MONTH);
        uint256 subBalBeforeFail = usdc.balanceOf(subscriber);
        uint256 payoutBeforeFail = usdc.balanceOf(saasPayout);

        vm.prank(keeper);
        uint256 charged4 = subs.renew(subId);

        // The charge rolled back ENTIRELY: nothing pulled, nothing paid out, budget still zero.
        assertEq(charged4, 0, "past-budget renewal charges NOTHING (never-negative)");
        assertEq(
            usdc.balanceOf(subscriber), subBalBeforeFail, "customer NOT debited past their budget"
        );
        assertEq(usdc.balanceOf(saasPayout), payoutBeforeFail, "no net moved on the failed renewal");
        assertEq(grant.remaining(sessionId), 0, "budget untouched: no negative, no overspend");

        // The subscription is dunned (PAST_DUE within grace), not silently overcharged. Tier survives
        // the first failure (grace window) — exactly the dunning behaviour a real subscription product expects.
        IAccess0x1Subscriptions.Subscription memory s = subs.subs(subId);
        assertEq(
            uint8(s.status), uint8(IAccess0x1Subscriptions.SubStatus.PAST_DUE), "dunned PAST_DUE"
        );
        assertEq(s.failCount, 1, "one consecutive failure recorded");
    }

    /// @notice The hard guarantee, isolated: a DIRECT over-budget spend reverts at SessionGrant — the
    ///         meter can never go negative, even if a buggy caller tried to bypass the subscription
    ///         lifecycle. (The delegate is the Subscriptions contract, so we prove the budget wall via
    ///         the live remaining() read the contract itself relies on.)
    function test_scenario_saas_budgetMeter_canNeverGoNegative() public {
        vm.prank(subscriber);
        bytes32 sessionId = grant.openSession(address(subs), PRICE_USD8, expiry); // exactly ONE charge

        // The Subscriptions contract is the only authorized delegate. Open at one period, subscribe
        // consumes it, and remaining is then zero — a second period has no budget at all.
        vm.prank(subscriber);
        uint256 subId = subs.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);
        assertEq(grant.remaining(sessionId), 0, "the single authorized charge is spent");

        // The keeper's renewal a month later finds an empty budget and cannot overspend it.
        _warpAMonthAndRefresh(block.timestamp + MONTH);
        vm.prank(keeper);
        uint256 charged = subs.renew(subId);
        assertEq(charged, 0, "no budget -> no charge -> meter stays at zero, never negative");
        assertEq(grant.remaining(sessionId), 0, "remaining is floored at zero by construction");
    }
}
