// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";

import { Access0x1Subscriptions } from "../../src/Access0x1Subscriptions.sol";
import {
    IAccess0x1Subscriptions,
    IAccess0x1Router
} from "../../src/interfaces/IAccess0x1Subscriptions.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";
import { SessionGrant } from "../../src/SessionGrant.sol";
import { ISessionGrant } from "../../src/interfaces/ISessionGrant.sol";

import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @title  Access0x1SubscriptionsIntegration
/// @author Access0x1
/// @notice The Cyfrin INTEGRATION layer for {Access0x1Subscriptions} — proves the recurring-billing
///         primitive COMPOSES correctly with the REAL money spine end-to-end: a subscriber opens a
///         budget-scoped {SessionGrant}, subscribes (period 1 charged through the {Access0x1Router}
///         fee-split, optionally landing the merchant net into {PaymentLanes}), renews twice in-budget,
///         and the third renewal — which would pull PAST the SessionGrant budget cap — is rejected at
///         the never-negative meter (it duns instead of overspending), leaving the budget at zero and
///         never negative. Every leg flows through the genuine quote + fee-split + lane settlement, so a
///         green run is proof the four contracts work as a single composition, not in isolation.
///
/// @dev    RACE-FREE BY CONSTRUCTION. This suite deploys {Access0x1Router}, {SessionGrant},
///         {PaymentLanes}, and {Access0x1Subscriptions} DIRECTLY with `new` in {setUp} and wires them by
///         hand — it does NOT drive the {DeployAll} script and NEVER touches the process-global
///         `vm.setEnv`. Parallel test suites race on that shared env (which is what broke the combined
///         suite before); deploying the real contracts inline keeps this suite fully deterministic and
///         isolated while still exercising the real cross-contract composition. The {DeployAll} script
///         itself is covered separately by `test/unit/DeployAll.t.sol`.
contract Access0x1SubscriptionsIntegrationTest is Test, ProxyDeployer {
    Access0x1Subscriptions internal subsC;
    Access0x1Router internal router;
    SessionGrant internal grant;
    PaymentLanes internal lanes;

    MockUSDC internal usdc;
    MockV3Aggregator internal usdcFeed;

    address internal admin = makeAddr("subi_admin");
    address internal treasury = makeAddr("subi_treasury");
    address internal merchantOwner = makeAddr("subi_merchantOwner");
    address internal payout = makeAddr("subi_payout");
    address internal feeRecipient = makeAddr("subi_feeRecipient");
    address internal keeper = makeAddr("subi_keeper");

    uint256 internal subscriberPk;
    address internal subscriber;

    uint256 internal merchantId;

    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5%
    uint16 internal constant GRACE = 3;

    uint8 internal constant PLAN_KEY = 2;
    uint256 internal constant PRICE_USD8 = 29e8; // $29 / period
    uint32 internal constant PERIOD = 30 days;
    // EXACTLY 3 periods of budget: subscribe (period 1) + 2 in-budget renews. The 3rd renew is over-cap.
    uint256 internal constant FUNDED_PERIODS = 3;
    uint256 internal constant BUDGET = PRICE_USD8 * FUNDED_PERIODS;
    uint64 internal expiry;

    /// @notice Wire the FULL real composition by hand (no DeployAll, no vm.setEnv) — deterministic.
    function setUp() public {
        vm.warp(1_700_000_000); // fresh, stable time for the staleness guard

        (subscriber, subscriberPk) = makeAddrAndKey("subi_subscriber");

        // 1. Mocks: a 6-dp USDC + a $1.00 Chainlink-style feed.
        usdc = new MockUSDC();
        usdcFeed = new MockV3Aggregator(8, 1e8);

        // 2. The real spine + authorization ledger + lane settlement, deployed directly.
        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (admin, treasury, PLATFORM_FEE_BPS))
            )
        );
        grant = SessionGrant(
            deployProxy(
                address(new SessionGrant()),
                abi.encodeCall(SessionGrant.initialize, ("Access0x1 SessionGrant", "1", admin))
            )
        );
        lanes = PaymentLanes(
            deployProxy(
                address(new PaymentLanes()), abi.encodeCall(PaymentLanes.initialize, (admin))
            )
        );
        subsC = Access0x1Subscriptions(
            deployProxy(
                address(new Access0x1Subscriptions()),
                abi.encodeCall(
                    Access0x1Subscriptions.initialize,
                    (admin, IAccess0x1Router(address(router)), ISessionGrant(address(grant)), GRACE)
                )
            )
        );

        // 3. Wire: allow + price USDC on the router, authorize the router on PaymentLanes, and route the
        //    merchant net into PaymentLanes (the "receive in any coin" seam) — the real production wiring.
        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        lanes.setRouter(address(router), true);
        router.setPaymentLanes(address(lanes));
        vm.stopPrank();

        // 4. A merchant on the router + a live plan defined by its owner.
        vm.prank(merchantOwner);
        merchantId =
            router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, keccak256("subi-acme"));
        vm.prank(merchantOwner);
        subsC.setPlan(merchantId, PLAN_KEY, PRICE_USD8, PERIOD, true);

        expiry = uint64(block.timestamp + 365 days);

        // 5. Fund + approve the subscriber so every renewal can pull.
        usdc.mint(subscriber, 1_000_000e6);
        vm.prank(subscriber);
        usdc.approve(address(subsC), type(uint256).max);
    }

    /// @dev Warp to `ts` AND re-stamp the feed there — a keeper renewing weeks later reads a live round.
    function _warpAndRefresh(uint256 ts) internal {
        vm.warp(ts);
        usdcFeed.updateAnswer(1e8);
    }

    /// @notice The composition is wired as deployed: the Subscriptions contract points at the EXACT
    ///         SessionGrant + Router instances this setUp deployed, and the router routes net into the
    ///         same PaymentLanes — no re-derived or coincidental instances.
    function test_integration_compositionIsWired() public view {
        assertEq(address(subsC.router()), address(router), "subs wired to the deployed router");
        assertEq(
            address(subsC.sessionGrant()), address(grant), "subs wired to the deployed SessionGrant"
        );
        assertEq(router.paymentLanes(), address(lanes), "router net routed into the deployed lanes");
        assertTrue(lanes.isRouter(address(router)), "router authorized on PaymentLanes");
    }

    /// @notice END-TO-END: subscribe → two in-budget renews → a third over-budget renew is rejected at
    ///         the never-negative meter. The session funds EXACTLY 3 periods. Period 1 (subscribe) and
    ///         the two renews each pull one period through the genuine router fee-split, landing the
    ///         merchant net as a PaymentLanes receipt; the budget decrements by exactly one period each
    ///         time. The third renewal would push the budget below zero, so {SessionGrant.spend} hard-
    ///         reverts inside the charge, the renewal's try/catch rolls the whole leg back (no token
    ///         moved, no budget consumed) and duns the subscription — the keeper's tx does not revert,
    ///         the cap is never breached, and the meter is left at zero, never negative.
    function test_integration_subscribeTwoRenewsThirdOverBudgetRejected() public {
        // --- Open the recurring authorization (a subscription IS a SessionGrant). ---
        vm.prank(subscriber);
        bytes32 sessionId = grant.openSession(address(subsC), BUDGET, expiry);
        assertEq(grant.remaining(sessionId), BUDGET, "full 3-period budget live after open");

        // --- Period 1: subscribe charges immediately through the router fee-split. ---
        uint256 gross = router.quote(merchantId, address(usdc), PRICE_USD8);
        uint256 platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        uint256 merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        uint256 net = gross - platformFee - merchantFee;

        uint256 subBalStart = usdc.balanceOf(subscriber);

        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        assertEq(
            uint8(subsC.subs(subId).status),
            uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE),
            "ACTIVE after paid period 1"
        );
        assertEq(grant.remaining(sessionId), BUDGET - PRICE_USD8, "one period debited by subscribe");
        // Fee-split landed exactly once: platform + merchant surcharge paid, net held as a lane receipt.
        assertEq(usdc.balanceOf(treasury), platformFee, "platform fee -> treasury");
        assertEq(usdc.balanceOf(feeRecipient), merchantFee, "merchant surcharge -> feeRecipient");
        assertEq(usdc.balanceOf(address(lanes)), net, "merchant net held as a PaymentLanes receipt");
        assertEq(
            lanes.balanceOf(payout, lanes.laneId(block.chainid, address(usdc), payout)),
            net,
            "merchant lane receipt credited the net"
        );
        assertEq(usdc.balanceOf(address(subsC)), 0, "zero custody after subscribe");

        // --- Renew #1 (in budget): period 2. ---
        _warpAndRefresh(subsC.subs(subId).periodEnd);
        vm.prank(keeper);
        uint256 charged1 = subsC.renew(subId);
        assertEq(charged1, gross, "renew #1 charged the quoted gross");
        assertEq(grant.remaining(sessionId), BUDGET - 2 * PRICE_USD8, "two periods debited");
        assertEq(
            uint8(subsC.subs(subId).status),
            uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE),
            "ACTIVE after renew #1"
        );

        // --- Renew #2 (in budget): period 3, exhausting the funded budget exactly. ---
        _warpAndRefresh(subsC.subs(subId).periodEnd);
        vm.prank(keeper);
        uint256 charged2 = subsC.renew(subId);
        assertEq(charged2, gross, "renew #2 charged the quoted gross");
        assertEq(grant.remaining(sessionId), 0, "budget exactly exhausted after 3 periods");
        assertEq(
            uint8(subsC.subs(subId).status),
            uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE),
            "ACTIVE after renew #2"
        );

        // Through 3 paid periods the subscriber paid exactly 3 * gross and the contract kept nothing.
        assertEq(
            subBalStart - usdc.balanceOf(subscriber), 3 * gross, "subscriber paid exactly 3 gross"
        );
        assertEq(usdc.balanceOf(address(subsC)), 0, "zero custody across all three periods");
        assertEq(usdc.balanceOf(treasury), 3 * platformFee, "platform fee taken once per period");
        assertEq(
            usdc.balanceOf(address(lanes)), 3 * net, "three periods of net held as lane receipts"
        );

        // --- Renew #3 (OVER budget): the never-negative meter rejects the pull. ---
        _warpAndRefresh(subsC.subs(subId).periodEnd);
        uint256 subBalBeforeOverpull = usdc.balanceOf(subscriber);
        uint256 lanesBeforeOverpull = usdc.balanceOf(address(lanes));

        vm.prank(keeper);
        uint256 charged3 = subsC.renew(subId);

        // The third renewal could not pull past the budget cap: it charged NOTHING and moved no token.
        assertEq(charged3, 0, "over-budget renewal pulls zero (rejected at the cap)");
        assertEq(
            usdc.balanceOf(subscriber),
            subBalBeforeOverpull,
            "no token moved on the over-budget renew"
        );
        assertEq(
            usdc.balanceOf(address(lanes)), lanesBeforeOverpull, "no extra net settled past the cap"
        );
        assertEq(grant.remaining(sessionId), 0, "budget left at zero, NEVER negative");
        assertEq(usdc.balanceOf(address(subsC)), 0, "zero custody even on the rejected renew");
        // The subscription dunned to PAST_DUE (first failure, within grace) — keeper tx did not revert.
        assertEq(
            uint8(subsC.subs(subId).status),
            uint8(IAccess0x1Subscriptions.SubStatus.PAST_DUE),
            "over-budget renewal duns to PAST_DUE within grace"
        );
        assertEq(subsC.subs(subId).failCount, 1, "one consecutive dunning failure recorded");
        // Tier survives PAST_DUE (the grace window) — the read-time entitlement is unchanged.
        assertEq(subsC.effectiveTier(subId), uint8(PLAN_KEY) + 1, "tier survives PAST_DUE");
    }

    /// @notice The over-budget renewal HARD-REVERTS at the SessionGrant if its self-call charge is
    ///         re-run directly (proving the dunning above is a CAUGHT revert, not a silent skip): once
    ///         the budget is exhausted, {SessionGrant.spend} reverts {BudgetExceeded} for the next
    ///         period — the never-negative meter is the contract that says no, exercised in composition.
    function test_integration_exhaustedBudgetSpendHardReverts() public {
        vm.prank(subscriber);
        bytes32 sessionId = grant.openSession(address(subsC), BUDGET, expiry);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        // Drain the remaining two funded periods via in-budget renews.
        for (uint256 i = 1; i < FUNDED_PERIODS; i++) {
            _warpAndRefresh(subsC.subs(subId).periodEnd);
            vm.prank(keeper);
            subsC.renew(subId);
        }
        assertEq(grant.remaining(sessionId), 0, "budget exhausted");

        // The next period's spend would breach the cap: SessionGrant reverts it (delegate == subsC).
        vm.prank(address(subsC));
        vm.expectRevert(
            abi.encodeWithSelector(
                ISessionGrant.SessionGrant__BudgetExceeded.selector, sessionId, 0, PRICE_USD8
            )
        );
        grant.spend(sessionId, PRICE_USD8);
    }
}
