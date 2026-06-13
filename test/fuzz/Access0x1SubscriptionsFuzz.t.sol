// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

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

/// @title  Access0x1SubscriptionsFuzz
/// @author Access0x1
/// @notice STATELESS (per-call) fuzz suite for {Access0x1Subscriptions} — the Cyfrin "fuzz each
///         external function with `bound()`-constrained inputs, then assert the local invariants hold
///         for THIS call" tier. Where the unit suite pins hand-picked values and the invariant suite
///         drives long handler sequences, this layer fires ONE money path per run over a wide, bounded
///         input space and proves the per-call laws that must hold for EVERY input:
///
///           - {setPlan}: any (priceUsd8, periodSecs, active) is stored VERBATIM, for any merchant-owned
///                        plan key — the merchant's tier definition round-trips exactly.
///           - {subscribe} (paid): for any plan price within a covering budget, period 1 is charged
///                        EXACTLY ONCE through the router — `net + platformFee + merchantFee == gross`
///                        (the fee-split is proven by the router, never re-derived here), the
///                        SessionGrant budget decrements by EXACTLY `priceUsd8` and NEVER past the cap
///                        (the never-negative meter), and the contract holds ZERO token + ZERO residual
///                        router allowance after (zero custody) — over the whole price/budget domain.
///           - {subscribe} (trial): for any price, a trial takes NO charge and leaves the budget at the
///                        full cap — the meter is untouched until the first paid period.
///           - {renew}: for any number of in-budget periods, each renewal debits EXACTLY one period of
///                        budget and never drives `remaining` negative; once the budget cannot cover the
///                        next period, the renewal DUNS (never reverts the keeper, never moves a wei,
///                        never consumes budget) — the cap is the hard ceiling on what a renewal can pull.
///           - {renew} (over-budget single): a session funded for exactly K periods permits exactly K
///                        paid periods (subscribe + K-1 renews) and the (K+1)-th renew duns at the cap —
///                        a renewal can NEVER pull past the SessionGrant budget, for any K.
///           - {cancel}: from any renewable state, cancel is terminal and zeroes the entitlement — for
///                        any subscription the subscriber owns.
///           - {effectiveTier}: an unknown subId is always tier 0, for any id in the unset domain.
///
///         Every test bounds amounts with `bound()` so the fuzzer spends its budget on meaningful values,
///         never on reverts it cannot satisfy. A green run is the proof the per-call money laws hold
///         across the whole input domain, not just the unit suite's hand-picked points.
/// @dev    Composes the REAL {Access0x1Router} + {SessionGrant} + a {MockV3Aggregator}-fed {MockUSDC},
///         so each charge exercises the genuine fee-split + in-tx USD->token quote — never a stub. No new
///         mocks are introduced (the canonical {MockUSDC} 6-dp asset + {MockV3Aggregator} feed).
contract Access0x1SubscriptionsFuzzTest is Test {
    Access0x1Subscriptions internal subsC;
    Access0x1Router internal router;
    SessionGrant internal grant;

    MockUSDC internal usdc;
    MockV3Aggregator internal usdcFeed;

    address internal admin = makeAddr("subf_admin");
    address internal treasury = makeAddr("subf_treasury");
    address internal merchantOwner = makeAddr("subf_merchantOwner");
    address internal payout = makeAddr("subf_payout");
    address internal feeRecipient = makeAddr("subf_feeRecipient");
    address internal keeper = makeAddr("subf_keeper");

    uint256 internal subscriber;
    uint256 internal merchantId;

    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5%
    uint16 internal constant GRACE = 3;

    uint8 internal constant PLAN_KEY = 2;
    uint32 internal constant PERIOD = 30 days;
    uint64 internal expiry;

    /// @notice Bound for a per-period USD price (8-dp): $0.01 → $1,000,000. Staying off the integer
    ///         floor keeps `quote` from rounding a sub-cent price to zero token, and the ceiling keeps
    ///         the subscriber + the fuzzed multi-period budget solvent against a real pull.
    uint256 internal constant MIN_PRICE_USD8 = 1e6; // $0.01
    uint256 internal constant MAX_PRICE_USD8 = 1_000_000e8; // $1,000,000

    function setUp() public {
        vm.warp(1_700_000_000); // fresh, stable time for the staleness guard

        usdc = new MockUSDC();
        usdcFeed = new MockV3Aggregator(8, 1e8); // $1.00/USDC

        router = new Access0x1Router(admin, treasury, PLATFORM_FEE_BPS);
        grant = new SessionGrant("Access0x1 SessionGrant", "1");
        subsC = new Access0x1Subscriptions(
            admin, IAccess0x1Router(address(router)), ISessionGrant(address(grant)), GRACE
        );

        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        vm.prank(merchantOwner);
        merchantId =
            router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, keccak256("subf-acme"));

        expiry = uint64(block.timestamp + 3650 days); // far enough out for any fuzzed period count

        // A funded + approving subscriber so any charge can pull. The fuzz never spends near this cap.
        subscriber = uint256(uint160(makeAddr("subf_subscriber")));
        usdc.mint(_subscriber(), type(uint128).max);
        vm.prank(_subscriber());
        usdc.approve(address(subsC), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _subscriber() internal view returns (address) {
        return address(uint160(subscriber));
    }

    /// @dev Open a SessionGrant owned by the subscriber, with this Subscriptions contract as delegate.
    function _openSession(uint256 budget) internal returns (bytes32 id) {
        vm.prank(_subscriber());
        id = grant.openSession(address(subsC), budget, expiry);
    }

    /// @dev Set the fuzzed plan price on the live plan and return it.
    function _setPlanPrice(uint256 priceUsd8) internal {
        vm.prank(merchantOwner);
        subsC.setPlan(merchantId, PLAN_KEY, priceUsd8, PERIOD, true);
    }

    /// @dev Warp to `ts` AND re-stamp the feed there — a keeper renewing periods later reads a live
    ///      round, so the test must refresh the feed past the staleness window.
    function _warpAndRefresh(uint256 ts) internal {
        vm.warp(ts);
        usdcFeed.updateAnswer(1e8); // re-stamp updatedAt = now, $1.00/USDC
    }

    /// @dev Snapshot of the fee-split balances the router pays out, for the `net + fee == gross` proof.
    struct Bals {
        uint256 sub;
        uint256 treasury;
        uint256 feeRecipient;
        uint256 payout;
        uint256 subsCustody;
    }

    function _snap() internal view returns (Bals memory b) {
        b.sub = usdc.balanceOf(_subscriber());
        b.treasury = usdc.balanceOf(treasury);
        b.feeRecipient = usdc.balanceOf(feeRecipient);
        b.payout = usdc.balanceOf(payout);
        b.subsCustody = usdc.balanceOf(address(subsC));
    }

    /// @dev Assert ONE period of `gross` settled through the router fee-split exactly once AND the
    ///      subscriptions contract kept zero custody — the per-charge money law, reused by every test.
    function _assertOneChargeSettled(Bals memory before, Bals memory afterB, uint256 gross)
        internal
        view
    {
        // The subscriber paid exactly `gross`.
        assertEq(before.sub - afterB.sub, gross, "subscriber debited exactly gross");
        // net + platformFee + merchantFee == gross: the three fee-split legs reconstruct the gross to
        // the wei. The router owns the split derivation; here we only prove conservation across it.
        uint256 platformDelta = afterB.treasury - before.treasury;
        uint256 merchantDelta = afterB.feeRecipient - before.feeRecipient;
        uint256 netDelta = afterB.payout - before.payout;
        assertEq(
            netDelta + platformDelta + merchantDelta, gross, "net + fee == gross via the router"
        );
        // Zero custody: the subscriptions contract holds no token and leaves no router allowance.
        assertEq(afterB.subsCustody, 0, "subscriptions holds zero token after the charge");
        assertEq(usdc.allowance(address(subsC), address(router)), 0, "no residual router allowance");
    }

    /*//////////////////////////////////////////////////////////////
                                setPlan
    //////////////////////////////////////////////////////////////*/

    /// @notice {setPlan} stores any (priceUsd8>0, periodSecs>0, active) VERBATIM for any plan key the
    ///         merchant owner writes — the tier definition round-trips exactly across the whole domain.
    function testFuzz_setPlan_storesVerbatim(
        uint8 planKey,
        uint256 priceUsd8,
        uint32 periodSecs,
        bool active
    ) public {
        priceUsd8 = bound(priceUsd8, 1, type(uint256).max);
        periodSecs = uint32(bound(periodSecs, 1, type(uint32).max));

        vm.prank(merchantOwner);
        subsC.setPlan(merchantId, planKey, priceUsd8, periodSecs, active);

        IAccess0x1Subscriptions.Plan memory p = subsC.plans(merchantId, planKey);
        assertEq(p.priceUsd8, priceUsd8, "price stored verbatim");
        assertEq(p.periodSecs, periodSecs, "period stored verbatim");
        assertEq(p.active, active, "active flag stored verbatim");
    }

    /// @notice {setPlan} reverts for ANY non-merchant-owner caller, for any plan parameters — only the
    ///         merchant owner can define a tier.
    function testFuzz_setPlan_revertsForNonOwner(address caller, uint256 priceUsd8) public {
        vm.assume(caller != merchantOwner);
        priceUsd8 = bound(priceUsd8, 1, type(uint256).max);
        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__NotMerchantOwner.selector, merchantId, caller
            )
        );
        subsC.setPlan(merchantId, PLAN_KEY, priceUsd8, PERIOD, true);
    }

    /*//////////////////////////////////////////////////////////////
                          subscribe (paid)
    //////////////////////////////////////////////////////////////*/

    /// @notice For ANY plan price within a covering budget, a paid {subscribe} charges period 1 EXACTLY
    ///         ONCE through the router (`net + fee == gross`), debits the SessionGrant budget by EXACTLY
    ///         `priceUsd8` (never past the cap), and leaves the contract with ZERO custody — the
    ///         per-call form of every money law, proven across the whole price domain.
    function testFuzz_subscribe_paid_chargesOnceConservesAndZeroCustody(
        uint256 priceUsd8,
        uint256 extraPeriods
    ) public {
        priceUsd8 = bound(priceUsd8, MIN_PRICE_USD8, MAX_PRICE_USD8);
        // Budget = (1 + extraPeriods) periods, so it always covers period 1 with headroom to spare.
        extraPeriods = bound(extraPeriods, 0, 36);
        uint256 budget = priceUsd8 * (1 + extraPeriods);

        _setPlanPrice(priceUsd8);
        bytes32 sessionId = _openSession(budget);

        uint256 gross = router.quote(merchantId, address(usdc), priceUsd8);
        Bals memory before = _snap();

        vm.prank(_subscriber());
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        Bals memory afterB = _snap();
        _assertOneChargeSettled(before, afterB, gross);

        // The never-negative meter debited EXACTLY one period and stayed within the cap.
        assertEq(
            grant.remaining(sessionId), budget - priceUsd8, "budget debited exactly one period"
        );
        assertLe(budget - priceUsd8, budget, "remaining never exceeds the cap");

        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        assertEq(uint8(s.status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE), "ACTIVE on paid");
        assertEq(subsC.effectiveTier(subId), uint8(PLAN_KEY) + 1, "entitled after paid period 1");
    }

    /// @notice A {subscribe} whose session budget cannot cover even one period at the plan price reverts
    ///         {BudgetTooLow} — for ANY price and ANY shortfall. The cap is enforced AT OPEN: you cannot
    ///         start a subscription you could never pay the first period of.
    function testFuzz_subscribe_revertsWhenBudgetUnderOnePeriod(
        uint256 priceUsd8,
        uint256 shortfall
    ) public {
        priceUsd8 = bound(priceUsd8, MIN_PRICE_USD8, MAX_PRICE_USD8);
        // Budget in [1, priceUsd8 - 1]: a NON-ZERO session (SessionGrant rejects a zero budget at open)
        // that still cannot cover one full period, so {BudgetTooLow} — not {ZeroBudget} — is what fires.
        shortfall = bound(shortfall, 1, priceUsd8 - 1);
        uint256 budget = priceUsd8 - shortfall;

        _setPlanPrice(priceUsd8);
        bytes32 sessionId = _openSession(budget);

        vm.prank(_subscriber());
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__BudgetTooLow.selector,
                sessionId,
                budget,
                priceUsd8
            )
        );
        subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);
    }

    /*//////////////////////////////////////////////////////////////
                          subscribe (trial)
    //////////////////////////////////////////////////////////////*/

    /// @notice A trial {subscribe} takes NO charge for ANY price: the subscriber's balance is untouched
    ///         and the SessionGrant budget stays at the FULL cap — the meter is never debited until the
    ///         first paid period. Proven across the whole price domain.
    function testFuzz_subscribe_trial_noChargeBudgetUntouched(
        uint256 priceUsd8,
        uint256 extraPeriods
    ) public {
        priceUsd8 = bound(priceUsd8, MIN_PRICE_USD8, MAX_PRICE_USD8);
        extraPeriods = bound(extraPeriods, 0, 36);
        uint256 budget = priceUsd8 * (1 + extraPeriods);

        _setPlanPrice(priceUsd8);
        bytes32 sessionId = _openSession(budget);

        uint256 subBefore = usdc.balanceOf(_subscriber());

        vm.prank(_subscriber());
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, true);

        assertEq(usdc.balanceOf(_subscriber()), subBefore, "no charge during a trial");
        assertEq(grant.remaining(sessionId), budget, "budget untouched (full cap) during a trial");
        assertEq(usdc.balanceOf(address(subsC)), 0, "zero custody after a trial subscribe");
        assertEq(
            uint8(subsC.subs(subId).status),
            uint8(IAccess0x1Subscriptions.SubStatus.TRIALING),
            "TRIALING after a trial subscribe"
        );
    }

    /*//////////////////////////////////////////////////////////////
                                 renew
    //////////////////////////////////////////////////////////////*/

    /// @notice For a session funded for K periods, the subscription supports EXACTLY K paid periods
    ///         (subscribe = period 1, then K-1 in-budget renews), each debiting EXACTLY one period and
    ///         keeping `remaining` monotonically decreasing but NEVER negative — then the (K+1)-th renew
    ///         duns AT THE CAP (zero charge, zero budget moved). A renewal can NEVER pull past the
    ///         SessionGrant budget, for any K — the headline never-negative law, fuzzed over K and price.
    function testFuzz_renew_neverPullsPastBudgetCap(uint256 priceUsd8, uint256 periods) public {
        priceUsd8 = bound(priceUsd8, MIN_PRICE_USD8, MAX_PRICE_USD8);
        uint256 k = bound(periods, 1, 24); // K fully-funded periods
        uint256 budget = priceUsd8 * k; // budget covers EXACTLY K periods, no slack

        _setPlanPrice(priceUsd8);
        bytes32 sessionId = _openSession(budget);

        // Period 1 (subscribe) consumes the first period of budget.
        vm.prank(_subscriber());
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);
        assertEq(grant.remaining(sessionId), budget - priceUsd8, "period 1 debited one period");

        // Periods 2..K: each in-budget renew debits exactly one more period; remaining never negative.
        for (uint256 i = 1; i < k; i++) {
            _warpAndRefresh(subsC.subs(subId).periodEnd);
            uint256 remBefore = grant.remaining(sessionId);
            uint256 gross = router.quote(merchantId, address(usdc), priceUsd8);
            Bals memory before = _snap();

            vm.prank(keeper);
            uint256 charged = subsC.renew(subId);

            Bals memory afterB = _snap();
            assertEq(charged, gross, "renew charged the quoted gross");
            _assertOneChargeSettled(before, afterB, gross);
            assertEq(
                grant.remaining(sessionId), remBefore - priceUsd8, "each renew debits one period"
            );
            assertLe(
                grant.remaining(sessionId), remBefore, "remaining is monotonically non-increasing"
            );
            assertEq(
                uint8(subsC.subs(subId).status),
                uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE),
                "ACTIVE after an in-budget renew"
            );
        }

        // The cap is now hit: the (K+1)-th renew CANNOT pull — it duns at the cap, moving nothing.
        assertEq(grant.remaining(sessionId), 0, "budget exactly exhausted after K periods");
        _warpAndRefresh(subsC.subs(subId).periodEnd);
        Bals memory beforeDun = _snap();

        vm.prank(keeper);
        uint256 chargedAtCap = subsC.renew(subId);

        Bals memory afterDun = _snap();
        assertEq(chargedAtCap, 0, "a renewal past the budget cap pulls ZERO");
        assertEq(afterDun.sub, beforeDun.sub, "no token moved when over the cap");
        assertEq(afterDun.payout, beforeDun.payout, "merchant got nothing past the cap");
        assertEq(grant.remaining(sessionId), 0, "budget never went negative (never-negative meter)");
        assertEq(afterDun.subsCustody, 0, "zero custody even on a dunned renew");
        assertEq(
            uint8(subsC.subs(subId).status),
            uint8(IAccess0x1Subscriptions.SubStatus.PAST_DUE),
            "first over-cap failure duns to PAST_DUE within grace"
        );
    }

    /// @notice {renew} reverts {NotDue} for ANY pre-due timestamp on a fresh paid subscription — a
    ///         keeper can never pull a period early, for any price and any time strictly before due.
    function testFuzz_renew_revertsBeforeDue(uint256 priceUsd8, uint256 warpBy) public {
        priceUsd8 = bound(priceUsd8, MIN_PRICE_USD8, MAX_PRICE_USD8);

        _setPlanPrice(priceUsd8);
        bytes32 sessionId = _openSession(priceUsd8 * 4);
        vm.prank(_subscriber());
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        uint64 due = subsC.subs(subId).periodEnd;
        warpBy = bound(warpBy, 0, uint256(PERIOD) - 1); // strictly before due
        _warpAndRefresh(block.timestamp + warpBy);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__NotDue.selector, subId, due, block.timestamp
            )
        );
        subsC.renew(subId);
    }

    /// @notice {renew} reverts {SubUnknown} for ANY id that was never subscribed — a keeper cannot
    ///         conjure a charge against an unset slot, for any id outside the live range.
    function testFuzz_renew_revertsForUnknownSub(uint256 subId) public {
        subId = bound(subId, subsC.nextSubId(), type(uint256).max); // never been assigned
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__SubUnknown.selector, subId
            )
        );
        subsC.renew(subId);
    }

    /*//////////////////////////////////////////////////////////////
                                 cancel
    //////////////////////////////////////////////////////////////*/

    /// @notice From a paid ACTIVE state, {cancel} by the subscriber is terminal and zeroes the
    ///         entitlement for ANY price — and a subsequent renew is blocked {NotRenewable}. Proven
    ///         across the price domain.
    function testFuzz_cancel_terminalAndBlocksRenew(uint256 priceUsd8) public {
        priceUsd8 = bound(priceUsd8, MIN_PRICE_USD8, MAX_PRICE_USD8);

        _setPlanPrice(priceUsd8);
        bytes32 sessionId = _openSession(priceUsd8 * 4);
        vm.prank(_subscriber());
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        vm.prank(_subscriber());
        subsC.cancel(subId);

        assertEq(
            uint8(subsC.subs(subId).status),
            uint8(IAccess0x1Subscriptions.SubStatus.CANCELED),
            "CANCELED is terminal"
        );
        assertEq(subsC.effectiveTier(subId), 0, "canceled loses entitlement");

        _warpAndRefresh(subsC.subs(subId).periodEnd);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__NotRenewable.selector,
                subId,
                IAccess0x1Subscriptions.SubStatus.CANCELED
            )
        );
        subsC.renew(subId);
    }

    /// @notice {cancel} reverts {NotSubscriber} for ANY non-subscriber caller — only the session owner
    ///         can stop their own subscription, for any price.
    function testFuzz_cancel_revertsForNonSubscriber(uint256 priceUsd8, address caller) public {
        priceUsd8 = bound(priceUsd8, MIN_PRICE_USD8, MAX_PRICE_USD8);
        vm.assume(caller != _subscriber());

        _setPlanPrice(priceUsd8);
        bytes32 sessionId = _openSession(priceUsd8 * 2);
        vm.prank(_subscriber());
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__NotSubscriber.selector, subId, caller
            )
        );
        subsC.cancel(subId);
    }

    /*//////////////////////////////////////////////////////////////
                            effectiveTier
    //////////////////////////////////////////////////////////////*/

    /// @notice {effectiveTier} of ANY id that was never subscribed is 0 (the STARTER / no-entitlement
    ///         tier) — a read against an unset slot can never materialize an entitlement, for any id.
    function testFuzz_effectiveTier_unknownIsZero(uint256 subId) public view {
        subId = bound(subId, subsC.nextSubId(), type(uint256).max);
        assertEq(subsC.effectiveTier(subId), 0, "unknown subscription is unentitled");
    }

    /*//////////////////////////////////////////////////////////////
                                 admin
    //////////////////////////////////////////////////////////////*/

    /// @notice {setGraceFailThreshold} stores any non-zero threshold VERBATIM for the owner, and reverts
    ///         {OwnableUnauthorizedAccount} for ANY non-owner — the one admin knob over the whole domain.
    function testFuzz_setGraceFailThreshold_ownerOnlyStoresVerbatim(
        uint16 threshold,
        address caller
    ) public {
        threshold = uint16(bound(threshold, 1, type(uint16).max));

        // Owner path: stored verbatim.
        vm.prank(admin);
        subsC.setGraceFailThreshold(threshold);
        assertEq(subsC.graceFailThreshold(), threshold, "owner-set threshold stored verbatim");

        // Non-owner path: always rejected.
        vm.assume(caller != admin);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        subsC.setGraceFailThreshold(threshold);
    }
}
