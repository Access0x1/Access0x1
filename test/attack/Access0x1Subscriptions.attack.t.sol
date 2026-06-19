// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

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

/// @notice A malicious 6-decimal token that re-enters {Access0x1Subscriptions.renew} during its
///         inbound pull (`transferFrom` -> `_update`). The contract's `nonReentrant` guard must
///         reject the re-entrant call, which bubbles up and reverts the whole charge — proving no
///         double-pull off one renewal.
contract ReentrantSubToken is ERC20 {
    Access0x1Subscriptions public subs;
    uint256 public reenterSubId;
    bool public armed;

    constructor() ERC20("Reentrant Sub USDC", "rsUSDC") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(Access0x1Subscriptions subs_, uint256 subId) external {
        subs = subs_;
        reenterSubId = subId;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (armed && to == address(subs)) {
            armed = false;
            subs.renew(reenterSubId); // must revert via nonReentrant
        }
        super._update(from, to, value);
    }
}

/// @notice Adversarial suite for Access0x1Subscriptions. Each test is an ATTACK the contract must
///         defeat: pulling past the SessionGrant budget (the never-negative meter), bypassing
///         SessionGrant.spend with a foreign-delegate session, double-charging one period, griefing
///         another subscriber's subscription / a foreign merchant's plan (tenant isolation),
///         reentrancy on the pull path, and a non-subscriber cancel. A passing test = the attack is
///         REJECTED (a revert or a no-op), never that it succeeds.
contract Access0x1SubscriptionsAttackTest is Test {
    Access0x1Subscriptions internal subsC;
    Access0x1Router internal router;
    SessionGrant internal grant;

    MockUSDC internal usdc;
    MockV3Aggregator internal usdcFeed;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal attacker = makeAddr("attacker");

    address internal subscriber;
    uint256 internal subscriberPk;

    uint256 internal merchantId;

    uint8 internal constant PLAN_KEY = 1;
    uint256 internal constant PRICE_USD8 = 50e8; // $50 / period
    uint32 internal constant PERIOD = 30 days;
    uint64 internal expiry;

    function setUp() public {
        vm.warp(1_700_000_000);
        (subscriber, subscriberPk) = makeAddrAndKey("subscriber");

        usdc = new MockUSDC();
        usdcFeed = new MockV3Aggregator(8, 1e8);

        router = new Access0x1Router(admin, treasury, 100); // 1%
        grant = new SessionGrant("Access0x1 SessionGrant", "1");
        subsC = new Access0x1Subscriptions(
            admin, IAccess0x1Router(address(router)), ISessionGrant(address(grant)), 3
        );

        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, 50, keccak256("m"));
        vm.prank(merchantOwner);
        subsC.setPlan(merchantId, PLAN_KEY, PRICE_USD8, PERIOD, true);

        expiry = uint64(block.timestamp + 365 days);

        usdc.mint(subscriber, 1_000_000e6);
        vm.prank(subscriber);
        usdc.approve(address(subsC), type(uint256).max);
    }

    function _warpAndRefresh(uint256 ts) internal {
        vm.warp(ts);
        usdcFeed.updateAnswer(1e8);
    }

    function _openSession(uint256 budget) internal returns (bytes32 id) {
        vm.prank(subscriber);
        id = grant.openSession(address(subsC), budget, expiry);
    }

    /*//////////////////////////////////////////////////////////////
              ATTACK: PULL PAST THE BUDGET (NEVER-NEGATIVE)
    //////////////////////////////////////////////////////////////*/

    /// @dev A subscription whose session covers EXACTLY one period cannot pull a second — the renewal
    ///      duns to PAST_DUE (the SessionGrant budget reverted the spend), it never pulls past the cap.
    function test_attack_renewPastBudget_isHardStopped() public {
        bytes32 sessionId = _openSession(PRICE_USD8); // exactly one period
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        uint256 paidPeriod1 = usdc.balanceOf(payout);
        assertGt(paidPeriod1, 0, "period 1 settled");

        // Each renewal attempt duns (budget exhausted) and pulls NOTHING, until the grace threshold
        // demotes the sub to UNPAID (terminal). At no point can a second period be pulled.
        for (uint256 i = 0; i < 3; i++) {
            _warpAndRefresh(block.timestamp + PERIOD);
            uint256 charged = subsC.renew(subId);
            assertEq(charged, 0, "no charge past budget");
        }
        // After GRACE fails the sub is UNPAID; a further renew is a terminal-state revert (not a pull).
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.UNPAID));
        // Total ever pulled stays pinned at exactly one period's net.
        assertEq(usdc.balanceOf(payout), paidPeriod1, "merchant never paid beyond the budget");
        assertEq(grant.remaining(sessionId), 0, "budget never went negative");
        assertEq(usdc.balanceOf(address(subsC)), 0, "no custody accreted");
    }

    /// @dev The budget is the absolute ceiling regardless of how many periods elapse: a session for
    ///      N periods settles AT MOST N charges, never N+1.
    function test_attack_budgetCeiling_exactlyNcharges() public {
        uint256 n = 3;
        bytes32 sessionId = _openSession(PRICE_USD8 * n);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false); // charge 1

        // Renew n-1 more times (success), then any further renew duns and pulls nothing.
        for (uint256 i = 1; i < n; i++) {
            _warpAndRefresh(block.timestamp + PERIOD);
            assertGt(subsC.renew(subId), 0, "within budget renews charge");
        }
        _warpAndRefresh(block.timestamp + PERIOD);
        assertEq(subsC.renew(subId), 0, "the (n+1)th charge is rejected");
        assertEq(grant.remaining(sessionId), 0, "exactly the budget spent, never more");
    }

    /*//////////////////////////////////////////////////////////////
              ATTACK: BYPASS SessionGrant.spend
    //////////////////////////////////////////////////////////////*/

    /// @dev A session whose delegate is NOT this contract cannot back a subscription — there is no way
    ///      to subscribe (and therefore renew/pull) without a session that authorizes THIS contract.
    function test_attack_foreignDelegateSession_cannotSubscribe() public {
        vm.prank(subscriber);
        bytes32 foreign = grant.openSession(attacker, PRICE_USD8 * 10, expiry); // delegate = attacker
        vm.prank(subscriber);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__SessionDelegateMismatch.selector,
                foreign,
                attacker
            )
        );
        subsC.subscribe(merchantId, PLAN_KEY, address(usdc), foreign, false);
    }

    /// @dev Revoking the session (subscriber, the owner) hard-stops all future pulls: the next renew
    ///      duns because {SessionGrant.spend} reverts on a revoked session — no bypass.
    function test_attack_revokedSession_cannotRenew() public {
        bytes32 sessionId = _openSession(PRICE_USD8 * 10);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        // Subscriber revokes the underlying authorization directly on SessionGrant.
        vm.prank(subscriber);
        grant.revoke(sessionId);

        _warpAndRefresh(block.timestamp + PERIOD);
        uint256 before = usdc.balanceOf(payout);
        uint256 charged = subsC.renew(subId);
        assertEq(charged, 0, "revoked session pulls nothing");
        assertEq(usdc.balanceOf(payout), before, "no pull after revoke");
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.PAST_DUE));
    }

    /*//////////////////////////////////////////////////////////////
              ATTACK: DOUBLE-CHARGE ONE PERIOD (REPLAY)
    //////////////////////////////////////////////////////////////*/

    /// @dev Two renews inside one period: the first advances `periodEnd`, the second reverts NotDue —
    ///      a period can be charged at most once (the on-chain idempotency / monotonic-period guard).
    function test_attack_doubleRenewSamePeriod_reverts() public {
        bytes32 sessionId = _openSession(PRICE_USD8 * 10);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        uint64 end = subsC.subs(subId).periodEnd;
        _warpAndRefresh(end);
        subsC.renew(subId); // legitimate
        uint64 newEnd = subsC.subs(subId).periodEnd;

        // Immediately renew again: not due (periodEnd advanced past now).
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__NotDue.selector,
                subId,
                newEnd,
                block.timestamp
            )
        );
        subsC.renew(subId);
        // Exactly two periods spent (subscribe + one renew), not three.
        assertEq(grant.remaining(sessionId), PRICE_USD8 * 10 - 2 * PRICE_USD8);
    }

    /*//////////////////////////////////////////////////////////////
              ATTACK: TENANT ISOLATION
    //////////////////////////////////////////////////////////////*/

    /// @dev A renew on subId X never mutates subId Y (a different subscriber's subscription).
    function test_attack_renewX_doesNotMutateY() public {
        // X: the attacker's own sub.
        (address other, uint256 otherPk) = makeAddrAndKey("other");
        usdc.mint(other, 1_000e6);
        vm.prank(other);
        usdc.approve(address(subsC), type(uint256).max);
        vm.prank(other);
        bytes32 sX = grant.openSession(address(subsC), PRICE_USD8 * 10, expiry);
        vm.prank(other);
        uint256 subX = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sX, false);
        otherPk;

        // Y: the victim's sub.
        bytes32 sY = _openSession(PRICE_USD8 * 10);
        vm.prank(subscriber);
        uint256 subY = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sY, false);
        IAccess0x1Subscriptions.Subscription memory yBefore = subsC.subs(subY);

        // Renew X.
        _warpAndRefresh(block.timestamp + PERIOD);
        subsC.renew(subX);

        // Y is byte-for-byte unchanged.
        IAccess0x1Subscriptions.Subscription memory yAfter = subsC.subs(subY);
        assertEq(yAfter.periodEnd, yBefore.periodEnd, "Y periodEnd untouched");
        assertEq(uint8(yAfter.status), uint8(yBefore.status), "Y status untouched");
        assertEq(yAfter.sessionId, yBefore.sessionId, "Y session untouched");
        assertEq(
            grant.remaining(sY), PRICE_USD8 * 10 - PRICE_USD8, "Y budget only its own period 1"
        );
    }

    /// @dev A merchant owner cannot edit ANOTHER merchant's plan (foreign-plan tenant isolation).
    function test_attack_foreignMerchantPlan_cannotEdit() public {
        // A second merchant owned by the attacker.
        vm.prank(attacker);
        uint256 m2 = router.registerMerchant(attacker, address(0), 0, keccak256("m2"));

        // merchantOwner (owner of merchantId, not m2) cannot set a plan on m2.
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__NotMerchantOwner.selector, m2, merchantOwner
            )
        );
        subsC.setPlan(m2, PLAN_KEY, PRICE_USD8, PERIOD, true);
    }

    /*//////////////////////////////////////////////////////////////
              ATTACK: REENTRANCY ON THE PULL PATH
    //////////////////////////////////////////////////////////////*/

    /// @dev A malicious settlement token re-enters {renew} during its inbound pull. The re-entrant
    ///      call hits `nonReentrant`, reverts, and bubbles up — the OUTER renew's charge fails and
    ///      duns; no double-pull, no custody. (The token is allowlisted + fed so the router accepts it.)
    function test_attack_reentrantTokenOnPull_isBlocked() public {
        ReentrantSubToken evil = new ReentrantSubToken();
        MockV3Aggregator evilFeed = new MockV3Aggregator(8, 1e8);
        vm.startPrank(admin);
        router.setTokenAllowed(address(evil), true);
        router.setPriceFeed(address(evil), address(evilFeed));
        vm.stopPrank();

        evil.mint(subscriber, 1_000e6);
        vm.prank(subscriber);
        evil.approve(address(subsC), type(uint256).max);

        bytes32 sessionId = _openSession(PRICE_USD8 * 10);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(evil), sessionId, true); // trial: no charge

        // Arm the re-entrancy for the first paid renewal.
        evil.arm(subsC, subId);
        _warpAndRefresh(block.timestamp + PERIOD);
        evilFeed.updateAnswer(1e8); // refresh the LOCAL evil feed too — the helper only refreshes usdcFeed,
        // so without this quote(evil) goes stale and (correctly) re-reverts before the pull is reached.
        // The outer renew's charge re-enters, hits the guard, reverts, and is caught -> dun (no charge).
        uint256 charged = subsC.renew(subId);
        assertEq(charged, 0, "reentrant pull blocked, charge failed");
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.PAST_DUE));
        assertEq(evil.balanceOf(address(subsC)), 0, "no custody after blocked reentrancy");
        // The session budget was NOT consumed by the failed charge.
        assertEq(
            grant.remaining(sessionId), PRICE_USD8 * 10, "no budget spent on the blocked renew"
        );
    }

    /*//////////////////////////////////////////////////////////////
              ATTACK: CANCEL GRIEF
    //////////////////////////////////////////////////////////////*/

    /// @dev An attacker cannot cancel a subscription they do not own (grief).
    function test_attack_cancelByNonSubscriber() public {
        bytes32 sessionId = _openSession(PRICE_USD8 * 10);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__NotSubscriber.selector, subId, attacker
            )
        );
        subsC.cancel(subId);
    }

    /// @dev An attacker cannot drive a renew that pulls from the subscriber's wallet to a DIFFERENT
    ///      destination: the merchant + payout are pinned at subscribe and the fee-split target is the
    ///      router merchant — renew takes no destination argument, so there is nothing to redirect.
    function test_attack_renewIsPermissionlessButCannotRedirect() public {
        bytes32 sessionId = _openSession(PRICE_USD8 * 10);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        uint256 payoutBefore = usdc.balanceOf(payout);
        _warpAndRefresh(block.timestamp + PERIOD);
        // The attacker calls renew (permissionless) — but the net still lands at the merchant payout.
        vm.prank(attacker);
        subsC.renew(subId);
        assertGt(
            usdc.balanceOf(payout), payoutBefore, "net still lands at the pinned merchant payout"
        );
        assertEq(usdc.balanceOf(attacker), 0, "attacker gains nothing");
    }
}
