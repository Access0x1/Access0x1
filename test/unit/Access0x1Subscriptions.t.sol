// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

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
import { WalletFactory } from "../mocks/SmartWallet1271.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    OwnableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @notice A trivial v2 implementation used by the upgrade test: a subclass that adds one view function
///         and changes nothing else, so an upgrade to it must preserve all prior state. It carries no new
///         storage (it would consume from `__gap` if it did), proving the proxy keeps every slot across
///         the implementation swap.
contract Access0x1SubscriptionsV2 is Access0x1Subscriptions {
    /// @notice A marker the original implementation does not expose — lets the test prove the new logic is
    ///         live after {upgradeToAndCall}.
    /// @return The constant string identifying this as the v2 implementation.
    function version2Marker() external pure returns (string memory) {
        return "v2";
    }
}

/// @notice The Access0x1Subscriptions unit suite — the full setPlan/subscribe/subscribeFor/renew/
///         cancel lifecycle, the trial-once + dunning rules, the read-time {effectiveTier} entitlement,
///         and every external revert path. Composes the REAL Access0x1Router + SessionGrant + a
///         MockV3Aggregator-fed MockUSDC, so each renewal exercises the genuine fee-split + in-tx
///         USD->token quote, never a stub. The contract is deployed BEHIND a UUPS proxy (deploy impl →
///         `ERC1967Proxy` with `initialize(...)` calldata → cast the proxy to the type) via the shared
///         {ProxyDeployer}, so every behavioural test exercises the production proxy↔impl shape. Tail
///         tests cover the UUPS upgrade + the permanent freeze via `renounceOwnership`.
contract Access0x1SubscriptionsTest is Test, ProxyDeployer {
    Access0x1Subscriptions internal subsC;
    /// @dev The shared Subscriptions implementation, deployed ONCE in setUp. The revert tests reuse it
    ///      so the only call inside the `vm.expectRevert` window is the proxy's `initialize` (the call
    ///      that must revert) — never an impl `new` (a non-reverting CREATE that would consume the cheat).
    address internal subsImpl;
    Access0x1Router internal router;
    SessionGrant internal grant;
    WalletFactory internal factory;

    MockUSDC internal usdc;
    MockV3Aggregator internal usdcFeed;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");

    uint256 internal subscriberPk;
    address internal subscriber;

    uint256 internal merchantId;

    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5%
    uint16 internal constant GRACE = 3;

    uint8 internal constant PLAN_KEY = 2;
    uint256 internal constant PRICE_USD8 = 29e8; // $29 / period
    uint32 internal constant PERIOD = 30 days;
    uint256 internal constant PERIODS = 12;
    uint256 internal constant BUDGET = PRICE_USD8 * PERIODS; // 12 periods authorized
    uint64 internal expiry;

    function setUp() public {
        vm.warp(1_700_000_000); // fresh, stable time for the staleness guard

        (subscriber, subscriberPk) = makeAddrAndKey("subscriber");

        usdc = new MockUSDC();
        usdcFeed = new MockV3Aggregator(8, 1e8); // $1.00/USDC

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
        factory = new WalletFactory();
        subsImpl = address(new Access0x1Subscriptions());
        subsC = Access0x1Subscriptions(
            deployProxy(
                subsImpl,
                abi.encodeCall(
                    Access0x1Subscriptions.initialize,
                    (admin, IAccess0x1Router(address(router)), ISessionGrant(address(grant)), GRACE)
                )
            )
        );

        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        vm.prank(merchantOwner);
        merchantId =
            router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, keccak256("acme"));

        // A live plan the subscriber can subscribe to.
        vm.prank(merchantOwner);
        subsC.setPlan(merchantId, PLAN_KEY, PRICE_USD8, PERIOD, true);

        expiry = uint64(block.timestamp + 365 days);

        // Fund + approve the subscriber so renewals can pull.
        usdc.mint(subscriber, 1_000_000e6);
        vm.prank(subscriber);
        usdc.approve(address(subsC), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Open a SessionGrant owned by the subscriber, with this Subscriptions contract as delegate.
    function _openSession(uint256 budget) internal returns (bytes32 id) {
        vm.prank(subscriber);
        id = grant.openSession(address(subsC), budget, expiry);
    }

    /// @dev Warp to a timestamp AND post a fresh feed answer there — a keeper renewing weeks later
    ///      reads a live Chainlink round, so the test must refresh the feed past the staleness window.
    function _warpAndRefresh(uint256 ts) internal {
        vm.warp(ts);
        usdcFeed.updateAnswer(1e8); // re-stamp updatedAt = now, $1.00/USDC
    }

    /// @dev Subscribe (no trial) using a fresh session that covers `PERIODS`.
    function _subscribeNoTrial() internal returns (uint256 subId, bytes32 sessionId) {
        sessionId = _openSession(BUDGET);
        vm.prank(subscriber);
        subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);
    }

    function _grantSig(address owner_, uint256 pk, uint256 budget, uint64 exp, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = grant.grantDigest(owner_, address(subsC), budget, exp, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev The subscriber's SubscribeIntent signature binding the exact target to `pk`, at `nonce`.
    ///      Params must equal the subscribeFor call (merchant/plan/token/subscriber/budget/expiry/trial).
    function _intentSig(
        address subscriber_,
        uint256 pk,
        uint256 mId,
        uint8 planKey,
        address token,
        uint256 budget,
        uint64 exp,
        bool withTrial,
        uint256 nonce
    ) internal view returns (bytes memory) {
        bytes32 digest = subsC.subscribeIntentDigest(
            mId, planKey, token, subscriber_, budget, exp, withTrial, nonce
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Wrap an inner signature in an ERC-6492 envelope for a counterfactual wallet (the same
    ///      factory the grant uses), so the predeploy-aware validator deploys + verifies it.
    function _wrap6492(bytes memory innerSig) internal view returns (bytes memory) {
        bytes32 magic = 0x6492649264926492649264926492649264926492649264926492649264926492;
        return abi.encodePacked(
            abi.encode(
                address(factory), abi.encodeCall(WalletFactory.deploy, (subscriber)), innerSig
            ),
            magic
        );
    }

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @dev Deploy a fresh proxy over a fresh impl with the given init args — the revert tests assert the
    ///      validation in {initialize} fires as the proxy runs it.
    function _deployWith(IAccess0x1Router router_, ISessionGrant grant_, uint16 grace_)
        internal
        returns (address)
    {
        // Reuse the impl deployed in setUp: the only call here is the proxy `initialize`, so a preceding
        // `vm.expectRevert` lands on it (not on a non-reverting impl `new`).
        return deployProxy(
            subsImpl,
            abi.encodeCall(Access0x1Subscriptions.initialize, (admin, router_, grant_, grace_))
        );
    }

    function test_constructor_setsState() public view {
        assertEq(address(subsC.router()), address(router));
        assertEq(address(subsC.sessionGrant()), address(grant));
        assertEq(subsC.graceFailThreshold(), GRACE);
        assertEq(subsC.nextSubId(), 1);
        assertEq(subsC.owner(), admin);
    }

    function test_constructor_revertZeroRouter() public {
        vm.expectRevert(IAccess0x1Subscriptions.Access0x1Subs__ZeroAddress.selector);
        _deployWith(IAccess0x1Router(address(0)), ISessionGrant(address(grant)), GRACE);
    }

    function test_constructor_revertZeroSessionGrant() public {
        vm.expectRevert(IAccess0x1Subscriptions.Access0x1Subs__ZeroAddress.selector);
        _deployWith(IAccess0x1Router(address(router)), ISessionGrant(address(0)), GRACE);
    }

    function test_constructor_revertZeroGrace() public {
        vm.expectRevert(IAccess0x1Subscriptions.Access0x1Subs__ZeroValue.selector);
        _deployWith(IAccess0x1Router(address(router)), ISessionGrant(address(grant)), 0);
    }

    /*//////////////////////////////////////////////////////////////
                                SETPLAN
    //////////////////////////////////////////////////////////////*/

    function test_setPlan_success() public {
        vm.expectEmit(true, true, false, true, address(subsC));
        emit IAccess0x1Subscriptions.PlanSet(merchantId, 5, 99e8, 7 days, true);
        vm.prank(merchantOwner);
        subsC.setPlan(merchantId, 5, 99e8, 7 days, true);

        IAccess0x1Subscriptions.Plan memory p = subsC.plans(merchantId, 5);
        assertEq(p.priceUsd8, 99e8);
        assertEq(p.periodSecs, 7 days);
        assertTrue(p.active);
    }

    function test_setPlan_revertNotMerchantOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__NotMerchantOwner.selector,
                merchantId,
                stranger
            )
        );
        subsC.setPlan(merchantId, 1, PRICE_USD8, PERIOD, true);
    }

    function test_setPlan_revertMerchantNotFound() public {
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__MerchantNotFound.selector, 999
            )
        );
        subsC.setPlan(999, 1, PRICE_USD8, PERIOD, true);
    }

    function test_setPlan_revertZeroPrice() public {
        vm.prank(merchantOwner);
        vm.expectRevert(IAccess0x1Subscriptions.Access0x1Subs__ZeroValue.selector);
        subsC.setPlan(merchantId, 1, 0, PERIOD, true);
    }

    function test_setPlan_revertZeroPeriod() public {
        vm.prank(merchantOwner);
        vm.expectRevert(IAccess0x1Subscriptions.Access0x1Subs__ZeroValue.selector);
        subsC.setPlan(merchantId, 1, PRICE_USD8, 0, true);
    }

    /*//////////////////////////////////////////////////////////////
                          SUBSCRIBE (NO TRIAL)
    //////////////////////////////////////////////////////////////*/

    function test_subscribe_noTrial_chargesPeriodOne() public {
        bytes32 sessionId = _openSession(BUDGET);

        uint256 gross = router.quote(merchantId, address(usdc), PRICE_USD8); // 29e6
        uint256 platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        uint256 merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        uint256 net = gross - platformFee - merchantFee;

        uint256 subBalBefore = usdc.balanceOf(subscriber);

        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        assertEq(subId, 1);
        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        assertEq(uint8(s.status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE));
        assertEq(s.merchantId, merchantId);
        assertEq(s.subscriber, subscriber);
        assertEq(s.sessionId, sessionId);
        assertEq(s.token, address(usdc));
        assertEq(s.planKey, PLAN_KEY);
        assertEq(s.periodEnd, uint64(block.timestamp + PERIOD));
        assertEq(s.trialExpiresAt, 0);
        assertFalse(s.hasUsedTrial);

        // Money moved: subscriber paid gross; the fee-split landed; the session budget decremented.
        assertEq(usdc.balanceOf(subscriber), subBalBefore - gross, "subscriber debited gross");
        assertEq(usdc.balanceOf(treasury), platformFee, "platform fee -> treasury");
        assertEq(usdc.balanceOf(feeRecipient), merchantFee, "merchant surcharge -> feeRecipient");
        assertEq(usdc.balanceOf(payout), net, "net -> merchant payout");
        assertEq(grant.remaining(sessionId), BUDGET - PRICE_USD8, "budget meter debited one period");

        // Zero custody: the subscriptions contract holds nothing.
        assertEq(usdc.balanceOf(address(subsC)), 0, "subscriptions holds no token");
        assertEq(usdc.allowance(address(subsC), address(router)), 0, "no residual router allowance");

        // Read-time entitlement = planKey + 1.
        assertEq(subsC.effectiveTier(subId), PLAN_KEY + 1);
    }

    function test_subscribe_emitsSubscribed() public {
        bytes32 sessionId = _openSession(BUDGET);
        vm.expectEmit(true, true, true, true, address(subsC));
        emit IAccess0x1Subscriptions.Subscribed(
            1,
            merchantId,
            subscriber,
            PLAN_KEY,
            sessionId,
            address(usdc),
            false,
            uint64(block.timestamp + PERIOD)
        );
        vm.prank(subscriber);
        subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);
    }

    function test_subscribe_revertPlanInactive() public {
        bytes32 sessionId = _openSession(BUDGET);
        vm.prank(subscriber);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__PlanInactive.selector, merchantId, 9
            )
        );
        subsC.subscribe(merchantId, 9, address(usdc), sessionId, false);
    }

    function test_subscribe_revertPlanDeactivated() public {
        vm.prank(merchantOwner);
        subsC.setPlan(merchantId, PLAN_KEY, PRICE_USD8, PERIOD, false); // deactivate
        bytes32 sessionId = _openSession(BUDGET);
        vm.prank(subscriber);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__PlanInactive.selector, merchantId, PLAN_KEY
            )
        );
        subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);
    }

    function test_subscribe_revertSessionDelegateMismatch() public {
        // Session whose delegate is NOT the subscriptions contract.
        vm.prank(subscriber);
        bytes32 badSession = grant.openSession(stranger, BUDGET, expiry);
        vm.prank(subscriber);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__SessionDelegateMismatch.selector,
                badSession,
                stranger
            )
        );
        subsC.subscribe(merchantId, PLAN_KEY, address(usdc), badSession, false);
    }

    function test_subscribe_revertBudgetTooLow() public {
        bytes32 sessionId = _openSession(PRICE_USD8 - 1); // can't cover even one period
        vm.prank(subscriber);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__BudgetTooLow.selector,
                sessionId,
                PRICE_USD8 - 1,
                PRICE_USD8
            )
        );
        subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);
    }

    function test_subscribe_revertOnUnfundedSubscriber() public {
        // A brand-new subscriber with a valid session but no token balance: the period-1 charge
        // reverts the whole subscribe (no dunning at subscribe time).
        (address poor, uint256 poorPk) = makeAddrAndKey("poor");
        vm.prank(poor);
        bytes32 sessionId = grant.openSession(address(subsC), BUDGET, expiry);
        vm.prank(poor);
        usdc.approve(address(subsC), type(uint256).max);

        vm.prank(poor);
        vm.expectRevert(); // SafeERC20 transferFrom fails (no balance)
        subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);
        poorPk; // silence unused
    }

    /*//////////////////////////////////////////////////////////////
                          SUBSCRIBE (TRIAL)
    //////////////////////////////////////////////////////////////*/

    function test_subscribe_withTrial_noChargeStampsTrial() public {
        bytes32 sessionId = _openSession(BUDGET);
        uint256 subBalBefore = usdc.balanceOf(subscriber);

        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, true);

        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        assertEq(uint8(s.status), uint8(IAccess0x1Subscriptions.SubStatus.TRIALING));
        assertTrue(s.hasUsedTrial);
        assertEq(s.trialExpiresAt, uint40(block.timestamp + PERIOD));
        assertEq(s.periodEnd, uint64(block.timestamp + PERIOD));

        // No charge during the trial; budget untouched.
        assertEq(usdc.balanceOf(subscriber), subBalBefore, "no charge during trial");
        assertEq(grant.remaining(sessionId), BUDGET, "budget untouched during trial");
        assertEq(subsC.effectiveTier(subId), PLAN_KEY + 1, "entitled during trial");
    }

    function test_trial_lapsed_losesEntitlementUntilRenew() public {
        bytes32 sessionId = _openSession(BUDGET);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, true);

        // Past the trial, still TRIALING (no renewal yet) => no entitlement.
        _warpAndRefresh(block.timestamp + PERIOD + 1);
        assertEq(subsC.effectiveTier(subId), 0, "lapsed trial loses entitlement");

        // A renewal converts to ACTIVE and re-entitles (the read-time gate, no cron).
        subsC.renew(subId);
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE));
        assertEq(subsC.effectiveTier(subId), PLAN_KEY + 1, "re-entitled after paid renewal");
    }

    function test_trial_once_secondTrialDegradesToPaid() public {
        // First subscription with a trial.
        bytes32 s1 = _openSession(BUDGET);
        vm.prank(subscriber);
        uint256 sub1 = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), s1, true);
        assertEq(uint8(subsC.subs(sub1).status), uint8(IAccess0x1Subscriptions.SubStatus.TRIALING));
        assertTrue(subsC.hasUsedTrial(subscriber, merchantId, PLAN_KEY));

        // A SECOND subscribe with `withTrial=true` on the same plan must NOT grant another trial —
        // it degrades to a paid (ACTIVE) start and charges period 1.
        bytes32 s2 = _openSession(BUDGET);
        uint256 balBefore = usdc.balanceOf(subscriber);
        vm.prank(subscriber);
        uint256 sub2 = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), s2, true);

        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(sub2);
        assertEq(
            uint8(s.status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE), "no second trial"
        );
        assertEq(s.trialExpiresAt, 0, "no trial stamp on the second");
        uint256 gross = router.quote(merchantId, address(usdc), PRICE_USD8);
        assertEq(usdc.balanceOf(subscriber), balBefore - gross, "second start is paid");
    }

    function test_trial_differentPlan_stillEligible() public {
        bytes32 s1 = _openSession(BUDGET);
        vm.prank(subscriber);
        subsC.subscribe(merchantId, PLAN_KEY, address(usdc), s1, true);

        // A DIFFERENT plan key is still trial-eligible.
        vm.prank(merchantOwner);
        subsC.setPlan(merchantId, PLAN_KEY + 1, PRICE_USD8, PERIOD, true);
        bytes32 s2 = _openSession(BUDGET);
        vm.prank(subscriber);
        uint256 sub2 = subsC.subscribe(merchantId, PLAN_KEY + 1, address(usdc), s2, true);
        assertEq(
            uint8(subsC.subs(sub2).status),
            uint8(IAccess0x1Subscriptions.SubStatus.TRIALING),
            "different plan trial-eligible"
        );
    }

    /*//////////////////////////////////////////////////////////////
                            SUBSCRIBE FOR
    //////////////////////////////////////////////////////////////*/

    function test_subscribeFor_eoaRelayed_success() public {
        bytes memory sig = _grantSig(subscriber, subscriberPk, BUDGET, expiry, 0);
        bytes memory intent = _intentSig(
            subscriber, subscriberPk, merchantId, PLAN_KEY, address(usdc), BUDGET, expiry, false, 0
        );

        vm.prank(keeper); // permissionless relayer
        uint256 subId = subsC.subscribeFor(
            merchantId, PLAN_KEY, address(usdc), subscriber, BUDGET, expiry, false, sig, intent
        );

        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        assertEq(uint8(s.status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE));
        assertEq(s.subscriber, subscriber);
        // The session was opened with this contract as delegate at nonce 0.
        assertEq(s.sessionId, grant.computeSessionId(subscriber, address(subsC), 0));
        // Period-1 charged via the relayed path.
        assertEq(grant.remaining(s.sessionId), BUDGET - PRICE_USD8);
    }

    function test_subscribeFor_6492_counterfactualWallet() public {
        // A counterfactual smart account subscribes before it has code.
        address w = factory.addressOf(subscriber); // wallet's signer == subscriber EOA
        // Fund + approve from the wallet address (it will exist after the 6492 prepare).
        usdc.mint(w, 1_000e6);

        bytes memory wrapped = _wrap6492(_grantSig(w, subscriberPk, BUDGET, expiry, 0));
        // The intent is ALSO 6492-wrapped: it is verified BEFORE the session opens (CEI), while the
        // wallet is still counterfactual, so its predeploy-aware check must be able to deploy + verify.
        bytes memory wrappedIntent = _wrap6492(
            _intentSig(
                w, subscriberPk, merchantId, PLAN_KEY, address(usdc), BUDGET, expiry, true, 0
            )
        );

        // The wallet must approve the subscriptions contract; since it's counterfactual we subscribe
        // WITH a trial (no period-1 charge) so no pull is needed at subscribe time.
        vm.prank(keeper);
        uint256 subId = subsC.subscribeFor(
            merchantId, PLAN_KEY, address(usdc), w, BUDGET, expiry, true, wrapped, wrappedIntent
        );

        assertGt(w.code.length, 0, "6492 prepare deployed the wallet");
        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        assertEq(uint8(s.status), uint8(IAccess0x1Subscriptions.SubStatus.TRIALING));
        assertEq(s.subscriber, w);
    }

    function test_subscribeFor_revertZeroSubscriber() public {
        // Zero subscriber reverts up front, before any signature is looked at.
        vm.expectRevert(IAccess0x1Subscriptions.Access0x1Subs__ZeroAddress.selector);
        subsC.subscribeFor(
            merchantId, PLAN_KEY, address(usdc), address(0), BUDGET, expiry, false, hex"00", hex"00"
        );
    }

    function test_subscribeFor_revertBadSignature() public {
        // A VALID intent (so we get past the target-binding check) but a grant signed by the WRONG key
        // ⇒ the failure surfaces from the SessionGrant open, not the intent gate.
        (, uint256 wrongPk) = makeAddrAndKey("wrong");
        bytes memory sig = _grantSig(subscriber, wrongPk, BUDGET, expiry, 0);
        bytes memory intent = _intentSig(
            subscriber, subscriberPk, merchantId, PLAN_KEY, address(usdc), BUDGET, expiry, false, 0
        );
        vm.expectRevert(ISessionGrant.SessionGrant__BadSignature.selector);
        subsC.subscribeFor(
            merchantId, PLAN_KEY, address(usdc), subscriber, BUDGET, expiry, false, sig, intent
        );
    }

    /*//////////////////////////////////////////////////////////////
                                 RENEW
    //////////////////////////////////////////////////////////////*/

    function test_renew_success_advancesPeriodAndCharges() public {
        (uint256 subId, bytes32 sessionId) = _subscribeNoTrial();
        uint64 firstEnd = subsC.subs(subId).periodEnd;

        _warpAndRefresh(firstEnd); // exactly due, fresh feed
        uint256 gross = router.quote(merchantId, address(usdc), PRICE_USD8);

        vm.expectEmit(true, false, false, true, address(subsC));
        emit IAccess0x1Subscriptions.Renewed(subId, PRICE_USD8, gross, firstEnd + PERIOD);

        vm.prank(keeper); // permissionless
        uint256 charged = subsC.renew(subId);

        assertEq(charged, gross);
        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        assertEq(s.periodEnd, firstEnd + PERIOD, "period advanced by exactly one period");
        assertEq(s.failCount, 0);
        assertEq(uint8(s.status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE));
        // Two periods now charged (subscribe + renew).
        assertEq(grant.remaining(sessionId), BUDGET - 2 * PRICE_USD8);
        assertEq(usdc.balanceOf(address(subsC)), 0, "zero custody after renew");
    }

    function test_renew_revertNotDue() public {
        (uint256 subId,) = _subscribeNoTrial();
        uint64 end = subsC.subs(subId).periodEnd;
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__NotDue.selector, subId, end, block.timestamp
            )
        );
        subsC.renew(subId);
    }

    function test_renew_revertUnknown() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1Subscriptions.Access0x1Subs__SubUnknown.selector, 42)
        );
        subsC.renew(42);
    }

    function test_renew_budgetExhausted_dunsToPastDue() public {
        // A session that covers exactly one period: subscribe charges it, renew has no budget left.
        bytes32 sessionId = _openSession(PRICE_USD8);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);
        assertEq(grant.remaining(sessionId), 0, "budget exactly exhausted by period 1");

        vm.warp(subsC.subs(subId).periodEnd);

        vm.expectEmit(true, false, false, true, address(subsC));
        emit IAccess0x1Subscriptions.RenewalFailed(
            subId, 1, IAccess0x1Subscriptions.SubStatus.PAST_DUE
        );
        // Keeper's tx does NOT revert — dunning is applied instead.
        vm.prank(keeper);
        uint256 charged = subsC.renew(subId);
        assertEq(charged, 0, "no charge when budget exhausted");

        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        assertEq(s.failCount, 1);
        assertEq(uint8(s.status), uint8(IAccess0x1Subscriptions.SubStatus.PAST_DUE));
        assertEq(grant.remaining(sessionId), 0, "budget never went negative");
        // Tier survives PAST_DUE (the grace window).
        assertEq(subsC.effectiveTier(subId), PLAN_KEY + 1, "tier survives PAST_DUE");
    }

    function test_renew_dunningReachesUnpaidAfterGrace() public {
        bytes32 sessionId = _openSession(PRICE_USD8);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        // Fail GRACE times -> UNPAID.
        for (uint256 i = 0; i < GRACE; i++) {
            vm.warp(block.timestamp + PERIOD);
            vm.prank(keeper);
            subsC.renew(subId);
        }
        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        assertEq(s.failCount, GRACE);
        assertEq(uint8(s.status), uint8(IAccess0x1Subscriptions.SubStatus.UNPAID));
        assertEq(subsC.effectiveTier(subId), 0, "UNPAID demotes the tier");

        // UNPAID is terminal for renew.
        vm.warp(block.timestamp + PERIOD);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__NotRenewable.selector,
                subId,
                IAccess0x1Subscriptions.SubStatus.UNPAID
            )
        );
        subsC.renew(subId);
    }

    function test_renew_pastDue_recoversToActiveOnSuccess() public {
        // Budget for 2 periods, but the subscriber un-approves to force a fail, then re-approves.
        bytes32 sessionId = _openSession(PRICE_USD8 * 3);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        // Force a pull failure: drop the allowance.
        vm.prank(subscriber);
        usdc.approve(address(subsC), 0);
        _warpAndRefresh(subsC.subs(subId).periodEnd);
        vm.prank(keeper);
        subsC.renew(subId);
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.PAST_DUE));
        // The failed charge consumed NO budget (rolled back).
        assertEq(grant.remaining(sessionId), PRICE_USD8 * 2, "failed renew spent no budget");

        // Re-approve and renew again at the same due time -> ACTIVE, failCount reset.
        vm.prank(subscriber);
        usdc.approve(address(subsC), type(uint256).max);
        vm.prank(keeper);
        subsC.renew(subId);
        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        assertEq(uint8(s.status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE));
        assertEq(s.failCount, 0, "dunning cleared on recovery");
    }

    /*//////////////////////////////////////////////////////////////
                                 CANCEL
    //////////////////////////////////////////////////////////////*/

    function test_cancel_success_blocksRenew() public {
        (uint256 subId,) = _subscribeNoTrial();

        vm.expectEmit(true, false, false, false, address(subsC));
        emit IAccess0x1Subscriptions.Canceled(subId);
        vm.prank(subscriber);
        subsC.cancel(subId);

        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.CANCELED));
        assertEq(subsC.effectiveTier(subId), 0, "canceled loses entitlement");

        // Renew is blocked on a canceled sub.
        vm.warp(block.timestamp + PERIOD);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__NotRenewable.selector,
                subId,
                IAccess0x1Subscriptions.SubStatus.CANCELED
            )
        );
        subsC.renew(subId);
    }

    /// @notice O-5: {cancel} makes a BEST-EFFORT revoke of the underlying SessionGrant. Because
    ///         SessionGrant.revoke is OWNER-gated and this contract is only the session DELEGATE, the
    ///         attempt fails — but it is caught, so the cancel STILL succeeds, and the loud
    ///         {SessionRevokeOnCancel} event records `revoked == false`. The session budget remains live.
    function test_cancel_bestEffortRevoke_emitsFalseAndDoesNotBlock() public {
        (uint256 subId, bytes32 sessionId) = _subscribeNoTrial();

        // The session is live (owned by the subscriber, delegate = this contract) before cancel.
        assertGt(grant.remaining(sessionId), 0, "session live before cancel");

        // Expect both the Canceled event and the loud loud revoke-outcome event (revoked == false).
        vm.expectEmit(true, false, false, false, address(subsC));
        emit IAccess0x1Subscriptions.Canceled(subId);
        vm.expectEmit(true, true, false, true, address(subsC));
        emit IAccess0x1Subscriptions.SessionRevokeOnCancel(subId, sessionId, false);
        vm.prank(subscriber);
        subsC.cancel(subId); // MUST NOT revert despite the failed best-effort revoke

        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.CANCELED));
        // The on-chain authorization is NOT torn down by the delegate's failed revoke: it stays live.
        assertFalse(
            grant.sessionOf(sessionId).revoked, "delegate cannot revoke; session stays live"
        );
        assertGt(grant.remaining(sessionId), 0, "budget authorization remains until expiry");
    }

    /// @notice O-5: after a cancel, the SUBSCRIBER (the session OWNER) can still kill the residual budget
    ///         authorization directly on SessionGrant — the documented belt-and-suspenders path the loud
    ///         event points them to.
    function test_cancel_subscriberCanSelfRevokeResidualSession() public {
        (uint256 subId, bytes32 sessionId) = _subscribeNoTrial();
        vm.prank(subscriber);
        subsC.cancel(subId);

        // The owner-driven revoke succeeds and zeroes the remaining budget.
        vm.prank(subscriber);
        grant.revoke(sessionId);
        assertTrue(
            grant.sessionOf(sessionId).revoked, "owner self-revoke tears down the authorization"
        );
        assertEq(grant.remaining(sessionId), 0, "no budget remains after self-revoke");
    }

    function test_cancel_revertNotSubscriber() public {
        (uint256 subId,) = _subscribeNoTrial();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__NotSubscriber.selector, subId, stranger
            )
        );
        subsC.cancel(subId);
    }

    function test_cancel_revertUnknown() public {
        vm.prank(subscriber);
        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1Subscriptions.Access0x1Subs__SubUnknown.selector, 7)
        );
        subsC.cancel(7);
    }

    function test_cancel_revertAlreadyCanceled() public {
        (uint256 subId,) = _subscribeNoTrial();
        vm.startPrank(subscriber);
        subsC.cancel(subId);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__NotRenewable.selector,
                subId,
                IAccess0x1Subscriptions.SubStatus.CANCELED
            )
        );
        subsC.cancel(subId);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    function test_setGraceFailThreshold_success() public {
        vm.expectEmit(false, false, false, true, address(subsC));
        emit IAccess0x1Subscriptions.GraceFailThresholdSet(GRACE, 5);
        vm.prank(admin);
        subsC.setGraceFailThreshold(5);
        assertEq(subsC.graceFailThreshold(), 5);
    }

    function test_setGraceFailThreshold_revertNotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        subsC.setGraceFailThreshold(5);
    }

    function test_setGraceFailThreshold_revertZero() public {
        vm.prank(admin);
        vm.expectRevert(IAccess0x1Subscriptions.Access0x1Subs__ZeroValue.selector);
        subsC.setGraceFailThreshold(0);
    }

    /*//////////////////////////////////////////////////////////////
                          CHARGE-VIA-SELF GUARD
    //////////////////////////////////////////////////////////////*/

    function test_chargeViaSelf_revertExternalCaller() public {
        (uint256 subId, bytes32 sessionId) = _subscribeNoTrial();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__NotSubscriber.selector, subId, stranger
            )
        );
        subsC.chargeViaSelf(subId, merchantId, sessionId, address(usdc), PRICE_USD8);
    }

    /*//////////////////////////////////////////////////////////////
                            EFFECTIVE TIER
    //////////////////////////////////////////////////////////////*/

    function test_effectiveTier_unknownIsZero() public view {
        assertEq(subsC.effectiveTier(123), 0);
    }

    /*//////////////////////////////////////////////////////////////
              M-1 · SESSION-OWNER BIND (no stranger drain)
    //////////////////////////////////////////////////////////////*/

    /// @dev M-1 regression: a stranger cannot pass a VICTIM's (public) session id to subscribe and drain
    ///      the victim's budget. The subscriber must OWN the session — keyed on `subscriber == msg.sender`
    ///      on the direct path, so a stranger reverts {NotSessionOwner} before any spend can run.
    function test_subscribe_revertNotSessionOwner_strangerCannotUseVictimSession() public {
        // The victim opens a budget-scoped session delegating to the subscriptions contract.
        bytes32 victimSession = _openSession(BUDGET);

        // A stranger funds + approves their OWN wallet and tries to subscribe USING the victim's session
        // (pointing the merchant at one they control would let them recover the gross while DRAINING the
        // victim's budget). The owner bind rejects it: subscriber (== stranger) != ownerOf(session).
        usdc.mint(stranger, 1_000_000e6);
        vm.prank(stranger);
        usdc.approve(address(subsC), type(uint256).max);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__NotSessionOwner.selector,
                victimSession,
                stranger
            )
        );
        subsC.subscribe(merchantId, PLAN_KEY, address(usdc), victimSession, false);

        // The victim's budget is completely untouched — nothing was spent.
        assertEq(
            grant.remaining(victimSession), BUDGET, "victim budget untouched by the failed drain"
        );
    }

    /// @dev M-1: the CORRECT owner still subscribes successfully on the DIRECT path (the bind passes when
    ///      `subscriber == msg.sender == ownerOf(session)`).
    function test_subscribe_correctOwner_stillSucceeds() public {
        bytes32 sessionId = _openSession(BUDGET);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE));
        assertEq(subsC.subs(subId).subscriber, subscriber);
        assertEq(grant.remaining(sessionId), BUDGET - PRICE_USD8, "owner's own period 1 charged");
    }

    /// @dev M-1: the RELAYED path still succeeds — the session is opened in-tx bound to the signature-
    ///      verified owner, so `subscriber == ownerOf(session)` holds and the bind passes.
    function test_subscribeFor_correctOwner_stillSucceeds() public {
        bytes memory sig = _grantSig(subscriber, subscriberPk, BUDGET, expiry, 0);
        bytes memory intent = _intentSig(
            subscriber, subscriberPk, merchantId, PLAN_KEY, address(usdc), BUDGET, expiry, false, 0
        );
        vm.prank(keeper); // permissionless relayer
        uint256 subId = subsC.subscribeFor(
            merchantId, PLAN_KEY, address(usdc), subscriber, BUDGET, expiry, false, sig, intent
        );
        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        assertEq(uint8(s.status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE));
        assertEq(s.subscriber, subscriber);
        assertEq(s.sessionId, grant.computeSessionId(subscriber, address(subsC), 0));
        assertEq(grant.remaining(s.sessionId), BUDGET - PRICE_USD8, "owner's own period 1 charged");
    }

    /*//////////////////////////////////////////////////////////////
              L-1 · RENEW CATCH NARROWING + REACTIVATE
    //////////////////////////////////////////////////////////////*/

    /// @dev L-1 regression: a renewal attempted while the ROUTER is paused must NOT dun a blameless,
    ///      fully-funded, in-budget subscriber. The pause (`EnforcedPause`) is a SYSTEM-side failure:
    ///      {renew} re-reverts it so the keeper retries once unpaused — it does not advance dunning.
    function test_renew_duringRouterPause_doesNotDun() public {
        (uint256 subId, bytes32 sessionId) = _subscribeNoTrial();
        uint256 remAfterP1 = grant.remaining(sessionId);

        _warpAndRefresh(subsC.subs(subId).periodEnd); // exactly due, fresh feed

        // The admin pauses the router (a temporary operational halt).
        vm.prank(admin);
        router.pause();

        // The pay-in reverts `EnforcedPause` inside the charge; {renew} bubbles it (system-side).
        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        subsC.renew(subId);

        // The subscriber is NOT penalized: still ACTIVE, no dunning, no budget spent.
        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        assertEq(
            uint8(s.status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE), "no dun on pause"
        );
        assertEq(s.failCount, 0, "no dunning bump while the router was paused");
        assertEq(grant.remaining(sessionId), remAfterP1, "no budget consumed during the pause");

        // Once unpaused, the honest keeper retries and the renewal SUCCEEDS.
        vm.prank(admin);
        router.unpause();
        vm.prank(keeper);
        uint256 charged = subsC.renew(subId);
        assertEq(
            charged, router.quote(merchantId, address(usdc), PRICE_USD8), "retry charges in full"
        );
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE));
    }

    /// @dev L-1: the per-period fail throttle blocks a permissionless griefer from amplifying repeated
    ///      SAME-window failures into terminal UNPAID. With the budget exhausted, the first renew duns
    ///      to PAST_DUE; every further renew in the SAME due window is a no-op (failCount stays 1).
    function test_renew_samePeriodFailures_throttledToOneDun() public {
        bytes32 sessionId = _openSession(PRICE_USD8); // exactly one period
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        _warpAndRefresh(subsC.subs(subId).periodEnd); // due; budget now exhausted

        // First failure: dun to PAST_DUE (attributable — the never-negative meter rejects the spend).
        vm.prank(keeper);
        subsC.renew(subId);
        assertEq(subsC.subs(subId).failCount, 1, "first same-window failure duns once");

        // Hammer renew in the SAME window (GRACE+5 times): the throttle caps it at one bump per period.
        for (uint256 i = 0; i < GRACE + 5; i++) {
            vm.prank(keeper);
            subsC.renew(subId);
        }
        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        assertEq(s.failCount, 1, "same-window repeats never amplify the dunning count");
        assertEq(
            uint8(s.status),
            uint8(IAccess0x1Subscriptions.SubStatus.PAST_DUE),
            "throttle blocks the amplification to terminal UNPAID"
        );
    }

    /// @dev L-1: `reactivate` cures a terminally-UNPAID subscription back to PAST_DUE so a renewal can
    ///      be retried — both the platform owner and the merchant owner are authorized; a stranger is
    ///      not; only UNPAID is curable.
    function test_reactivate_curesUnpaid_byOwnerAndMerchant() public {
        // Drive a subscription to UNPAID across DISTINCT periods (budget exhausted after period 1).
        bytes32 sessionId = _openSession(PRICE_USD8);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);
        for (uint256 i = 0; i < GRACE; i++) {
            _warpAndRefresh(block.timestamp + PERIOD); // a genuinely new period each iteration
            vm.prank(keeper);
            subsC.renew(subId);
        }
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.UNPAID));
        assertEq(subsC.effectiveTier(subId), 0, "UNPAID has no entitlement");

        // A stranger cannot cure it.
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__NotAuthorizedToCure.selector, subId, stranger
            )
        );
        subsC.reactivate(subId);

        // The merchant owner cures it -> PAST_DUE, dunning reset.
        vm.expectEmit(true, true, false, false, address(subsC));
        emit IAccess0x1Subscriptions.Reactivated(subId, merchantOwner);
        vm.prank(merchantOwner);
        subsC.reactivate(subId);

        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        assertEq(
            uint8(s.status), uint8(IAccess0x1Subscriptions.SubStatus.PAST_DUE), "cured to PAST_DUE"
        );
        assertEq(s.failCount, 0, "dunning reset on cure");
        // Tier is restored to the grace window (PAST_DUE keeps the tier) — entitlement only truly
        // returns once a renewal actually charges, but the sub is renewable again.
        assertEq(subsC.effectiveTier(subId), PLAN_KEY + 1, "PAST_DUE keeps the tier in grace");

        // Re-demote to UNPAID, then the PLATFORM OWNER cures it (the other authorized path).
        for (uint256 i = 0; i < GRACE; i++) {
            _warpAndRefresh(block.timestamp + PERIOD);
            vm.prank(keeper);
            subsC.renew(subId);
        }
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.UNPAID));
        vm.prank(admin); // the platform owner
        subsC.reactivate(subId);
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.PAST_DUE));
    }

    /// @dev L-1: `reactivate` only cures UNPAID — an ACTIVE (or any non-UNPAID) subscription reverts
    ///      {NotReactivatable}, and a CANCELED one stays terminal.
    function test_reactivate_revertNotReactivatable() public {
        (uint256 subId,) = _subscribeNoTrial(); // ACTIVE
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__NotReactivatable.selector,
                subId,
                IAccess0x1Subscriptions.SubStatus.ACTIVE
            )
        );
        subsC.reactivate(subId);
    }

    /// @dev L-1: `reactivate` reverts {SubUnknown} for an id that was never subscribed.
    function test_reactivate_revertUnknown() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1Subscriptions.Access0x1Subs__SubUnknown.selector, 99)
        );
        subsC.reactivate(99);
    }

    /// @dev HIGH regression: a renewal attempted while the MERCHANT has DEACTIVATED itself on the router
    ///      must NOT dun a blameless, fully-funded, in-budget subscriber. `router.payToken` reverts
    ///      {Access0x1__MerchantInactive} — a SYSTEM-side failure: {renew} re-reverts it so the keeper
    ///      retries once the merchant reactivates, never advancing dunning.
    function test_renew_whileMerchantInactive_doesNotDun() public {
        (uint256 subId, bytes32 sessionId) = _subscribeNoTrial();
        uint256 remAfterP1 = grant.remaining(sessionId);

        _warpAndRefresh(subsC.subs(subId).periodEnd); // exactly due, fresh feed

        // The merchant deactivates its own billing on the router (a temporary operational halt).
        vm.prank(merchantOwner);
        router.updateMerchant(merchantId, payout, feeRecipient, MERCHANT_FEE_BPS, false);

        // The pay-in reverts {MerchantInactive} inside payToken; {renew} bubbles it (system-side).
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Router.Access0x1__MerchantInactive.selector, merchantId
            )
        );
        subsC.renew(subId);

        // The subscriber is NOT penalized: still ACTIVE, no dunning, no budget spent.
        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        assertEq(
            uint8(s.status),
            uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE),
            "no dun while merchant inactive"
        );
        assertEq(s.failCount, 0, "no dunning bump while the merchant was inactive");
        assertEq(
            grant.remaining(sessionId), remAfterP1, "no budget consumed during the deactivation"
        );

        // Once the merchant reactivates, the honest keeper retries and the renewal SUCCEEDS.
        vm.prank(merchantOwner);
        router.updateMerchant(merchantId, payout, feeRecipient, MERCHANT_FEE_BPS, true);
        vm.prank(keeper);
        uint256 charged = subsC.renew(subId);
        assertEq(
            charged, router.quote(merchantId, address(usdc), PRICE_USD8), "retry charges in full"
        );
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE));
    }

    /// @dev HIGH regression: a renewal attempted while the PLATFORM has DE-ALLOWLISTED the settlement
    ///      token must NOT dun a blameless, fully-funded, in-budget subscriber. `router.quote` reverts
    ///      {Access0x1__TokenNotAllowed} — a SYSTEM-side (platform-side) failure: {renew} re-reverts it
    ///      so the keeper retries once the token is re-allowlisted, never advancing dunning.
    function test_renew_whileTokenDeAllowlisted_doesNotDun() public {
        (uint256 subId, bytes32 sessionId) = _subscribeNoTrial();
        uint256 remAfterP1 = grant.remaining(sessionId);

        _warpAndRefresh(subsC.subs(subId).periodEnd); // exactly due, fresh feed

        // The platform de-allowlists the settlement token (a platform-side action, not the subscriber's).
        vm.prank(admin);
        router.setTokenAllowed(address(usdc), false);

        // The quote reverts {TokenNotAllowed} inside the charge; {renew} bubbles it (system-side).
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Router.Access0x1__TokenNotAllowed.selector, address(usdc)
            )
        );
        subsC.renew(subId);

        // The subscriber is NOT penalized: still ACTIVE, no dunning, no budget spent.
        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        assertEq(
            uint8(s.status),
            uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE),
            "no dun while token de-allowlisted"
        );
        assertEq(s.failCount, 0, "no dunning bump while the token was de-allowlisted");
        assertEq(
            grant.remaining(sessionId), remAfterP1, "no budget consumed during the de-allowlisting"
        );

        // Once re-allowlisted, the honest keeper retries and the renewal SUCCEEDS.
        vm.prank(admin);
        router.setTokenAllowed(address(usdc), true);
        vm.prank(keeper);
        uint256 charged = subsC.renew(subId);
        assertEq(
            charged, router.quote(merchantId, address(usdc), PRICE_USD8), "retry charges in full"
        );
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE));
    }

    /// @dev MED regression: a freshly REACTIVATED (cured) subscription must NOT be re-dunned by a
    ///      permissionless {renew} in the SAME due window. The period is intentionally not advanced on
    ///      cure, so the sub sits in the same elapsed-period bucket it was last dunned in; reactivate
    ///      re-arms the throttle on THAT bucket so a same-window retry is a no-op (the sub stays
    ///      PAST_DUE), while real time passing into a NEW period still advances dunning normally.
    function test_reactivate_notImmediatelyReDunnedInSameWindow() public {
        // Drive a subscription to UNPAID across DISTINCT periods (budget exhausted after period 1).
        bytes32 sessionId = _openSession(PRICE_USD8);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);
        for (uint256 i = 0; i < GRACE; i++) {
            _warpAndRefresh(block.timestamp + PERIOD); // a genuinely new period each iteration
            vm.prank(keeper);
            subsC.renew(subId);
        }
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.UNPAID));

        // Cure it. The period is NOT advanced, so we remain in the current due window.
        vm.prank(admin);
        subsC.reactivate(subId);
        assertEq(
            uint8(subsC.subs(subId).status),
            uint8(IAccess0x1Subscriptions.SubStatus.PAST_DUE),
            "cured to PAST_DUE"
        );
        assertEq(subsC.subs(subId).failCount, 0, "dunning reset on cure");

        // A permissionless keeper hammers {renew} in the SAME window (still budget-exhausted): the
        // throttle was re-armed on this bucket, so each call is a no-op — the sub is NOT re-dunned.
        for (uint256 i = 0; i < GRACE + 5; i++) {
            vm.prank(keeper);
            subsC.renew(subId);
        }
        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        assertEq(s.failCount, 0, "cured sub not re-dunned by same-window renews");
        assertEq(
            uint8(s.status),
            uint8(IAccess0x1Subscriptions.SubStatus.PAST_DUE),
            "cure survives the same-window renew storm (no bounce back to UNPAID)"
        );
        assertEq(subsC.effectiveTier(subId), PLAN_KEY + 1, "tier survives in the grace window");

        // A genuinely NEW period (a new bucket as real time passes) STILL advances dunning, exactly once.
        _warpAndRefresh(block.timestamp + PERIOD);
        vm.prank(keeper);
        subsC.renew(subId);
        assertEq(
            subsC.subs(subId).failCount, 1, "a real next period still duns the cured sub (one bump)"
        );
    }

    /*//////////////////////////////////////////////////////////////
                          UUPS UPGRADE / FREEZE
    //////////////////////////////////////////////////////////////*/

    function test_initialize_revertOnSecondCall() public {
        // The proxy was already initialized in setUp; a second call must revert (one-time initializer).
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        subsC.initialize(
            admin, IAccess0x1Router(address(router)), ISessionGrant(address(grant)), GRACE
        );
    }

    function test_upgrade_preservesStateAndAddsFn() public {
        // Seed state under the v1 implementation: an active subscription + a tuned grace threshold.
        (uint256 subId,) = _subscribeNoTrial();
        vm.prank(admin);
        subsC.setGraceFailThreshold(5);

        // The admin (contract owner / upgrade admin) upgrades the proxy to v2.
        address v2 = address(new Access0x1SubscriptionsV2());
        vm.prank(admin);
        UUPSUpgradeable(address(subsC)).upgradeToAndCall(v2, "");

        // The new logic is live...
        assertEq(Access0x1SubscriptionsV2(address(subsC)).version2Marker(), "v2");

        // ...and ALL prior state survived the implementation swap (storage lives in the proxy).
        assertEq(address(subsC.router()), address(router));
        assertEq(address(subsC.sessionGrant()), address(grant));
        assertEq(subsC.graceFailThreshold(), 5);
        assertEq(subsC.nextSubId(), 2); // one subscribe consumed id 1
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE));
        assertEq(subsC.subs(subId).subscriber, subscriber);
        assertEq(subsC.owner(), admin); // upgrade admin unchanged
    }

    function test_upgrade_revertNonOwner() public {
        address v2 = address(new Access0x1SubscriptionsV2());
        // A non-admin cannot upgrade — _authorizeUpgrade is onlyOwner.
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger)
        );
        UUPSUpgradeable(address(subsC)).upgradeToAndCall(v2, "");
    }

    function test_freeze_renounceOwnershipBlocksUpgradeForever() public {
        // The admin renounces ownership: the upgrade admin becomes address(0).
        vm.prank(admin);
        subsC.renounceOwnership();
        assertEq(subsC.owner(), address(0));

        // With no owner, _authorizeUpgrade reverts for EVERYONE — the implementation is frozen forever.
        address v2 = address(new Access0x1SubscriptionsV2());
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, admin)
        );
        UUPSUpgradeable(address(subsC)).upgradeToAndCall(v2, "");
    }
}
