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
import { FeeOnTransferToken } from "../mocks/FeeOnTransferToken.sol";

/// @notice A settlement token whose `transferFrom` re-enters {Access0x1Subscriptions.setPlan} to
///         mutate the plan's `periodSecs` MID-CHARGE. `setPlan` is NOT `nonReentrant`, so the
///         re-entry is not blocked by the guard on {renew}; the attack probes whether a merchant who
///         controls both the merchant AND the settlement token can corrupt the period accounting
///         (drive a double-charge / a non-monotonic periodEnd) from inside the pull.
contract SetPlanReenterToken is ERC20 {
    Access0x1Subscriptions public subs;
    uint256 public merchantId;
    uint8 public planKey;
    uint256 public priceUsd8;
    uint32 public newPeriodSecs;
    address public merchantOwner;
    bool public armed;

    constructor() ERC20("SetPlan Reenter", "SPR") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(
        Access0x1Subscriptions subs_,
        uint256 merchantId_,
        uint8 planKey_,
        uint256 priceUsd8_,
        uint32 newPeriodSecs_,
        address merchantOwner_
    ) external {
        subs = subs_;
        merchantId = merchantId_;
        planKey = planKey_;
        priceUsd8 = priceUsd8_;
        newPeriodSecs = newPeriodSecs_;
        merchantOwner = merchantOwner_;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (armed && to == address(subs)) {
            armed = false;
            // Re-enter setPlan as the merchant owner mid-charge, shrinking periodSecs to 1 second.
            // (msg.sender of this _update is the token; we forge the merchant-owner prank off-chain
            // in the test via vm — here we simply attempt the call and ignore failure so the pull
            // still proceeds and the test can assert on the resulting accounting.)
            try subs.setPlan(merchantId, planKey, priceUsd8, newPeriodSecs, true) { } catch { }
        }
        super._update(from, to, value);
    }
}

/// @notice A keeper contract that calls {renew} forwarding a CAPPED amount of gas, to test whether a
///         griefer can force the try/catch to swallow an out-of-gas in the charge (demoting a funded,
///         in-budget subscriber to PAST_DUE/UNPAID) while the outer keeper tx still succeeds.
contract GasGriefKeeper {
    Access0x1Subscriptions public immutable subs;

    constructor(Access0x1Subscriptions subs_) {
        subs = subs_;
    }

    /// @dev Call renew forwarding exactly `gasForCall` gas to the renew call.
    function renewWithGas(uint256 subId, uint256 gasForCall) external returns (bool ok) {
        // solhint-disable-next-line avoid-low-level-calls
        (ok,) = address(subs).call{ gas: gasForCall }(
            abi.encodeWithSelector(Access0x1Subscriptions.renew.selector, subId)
        );
    }
}

/// @notice An 18-decimal stablecoin — the Arc "native USDC = 18 decimals" trap. The router's quote
///         reads `decimals()` live, so an 18-dec token must price + settle exactly the same USD value
///         as a 6-dec token, with net + fee == gross and no custody, through the subscription path.
contract Token18 is ERC20 {
    constructor() ERC20("Eighteen Dec USDC", "USDC18") { }

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice OPUS red-team suite: a SECOND, independent adversarial pass over Access0x1Subscriptions,
///         attacking the money invariants the first attack suite did not directly cover — fee-on-
///         transfer settlement, oracle staleness / zero / negative price during renew, catch-up
///         billing after a PAST_DUE recovery (no double-charge, no budget overrun), a mid-charge
///         re-entry into the non-guarded {setPlan}, and gas-metered try/catch griefing. A PASS = the
///         attack is DEFEATED (revert, dun, or no-op) and every money invariant still holds.
contract Access0x1SubscriptionsRedTeamTest is Test {
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
    address internal keeper = makeAddr("keeper");

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

        expiry = uint64(block.timestamp + 3650 days);

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

    function _totalDelivered() internal view returns (uint256) {
        return usdc.balanceOf(payout) + usdc.balanceOf(treasury) + usdc.balanceOf(feeRecipient);
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK 1: FEE-ON-TRANSFER SETTLEMENT — no custody, no leak, dun
    //////////////////////////////////////////////////////////////*/

    /// @dev A fee-on-transfer settlement token must NOT let value leak into / stick to the
    ///      subscriptions contract, and must NOT let a charge half-settle. The router's balance-delta
    ///      guard rejects the skim, the whole charge rolls back, the budget is untouched, and the
    ///      renewal duns. Zero custody holds even on the adversarial token.
    function test_attack_feeOnTransferToken_dunsAndKeepsZeroCustody() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        MockV3Aggregator fotFeed = new MockV3Aggregator(8, 1e8);
        vm.startPrank(admin);
        router.setTokenAllowed(address(fot), true);
        router.setPriceFeed(address(fot), address(fotFeed));
        vm.stopPrank();

        fot.mint(subscriber, 1_000_000e6);
        vm.prank(subscriber);
        fot.approve(address(subsC), type(uint256).max);

        // Open with a trial (no period-1 charge) so the FIRST money move is a renewal we control.
        bytes32 sessionId = _openSession(PRICE_USD8 * 10);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(fot), sessionId, true);

        _warpAndRefresh(block.timestamp + PERIOD);
        fotFeed.updateAnswer(1e8);

        uint256 charged = subsC.renew(subId);
        assertEq(charged, 0, "fee-on-transfer charge must fail (router rejects the skim)");
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.PAST_DUE));
        // No funds stuck on the subscriptions contract; no allowance lingering.
        assertEq(fot.balanceOf(address(subsC)), 0, "no custody on FoT failure");
        assertEq(fot.allowance(address(subsC), address(router)), 0, "no dangling allowance");
        // Budget NOT consumed by the failed charge (rolled back through the self-call).
        assertEq(grant.remaining(sessionId), PRICE_USD8 * 10, "budget untouched on FoT dun");
        // Nothing was delivered to the merchant either.
        assertEq(fot.balanceOf(payout), 0, "merchant got nothing");
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK 2: ORACLE — stale / zero / negative price during renew
    //////////////////////////////////////////////////////////////*/

    /// @dev A stale feed at renew time must NOT pull funds. The quote reverts inside the charge, which
    ///      rolls back (no budget spent), and the renewal duns — the keeper tx itself never reverts.
    function test_attack_staleOracleAtRenew_dunsNoPull() public {
        bytes32 sessionId = _openSession(PRICE_USD8 * 10);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);
        uint256 deliveredAfterP1 = _totalDelivered();

        // Advance time WITHOUT refreshing the feed past the staleness window (1h).
        vm.warp(block.timestamp + PERIOD);
        // Feed last updated at subscribe time -> now far older than TIMEOUT.

        uint256 charged = subsC.renew(subId);
        assertEq(charged, 0, "stale oracle pulls nothing");
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.PAST_DUE));
        assertEq(grant.remaining(sessionId), PRICE_USD8 * 10 - PRICE_USD8, "only period-1 spent");
        assertEq(_totalDelivered(), deliveredAfterP1, "no delivery on stale renew");
        assertEq(usdc.balanceOf(address(subsC)), 0, "no custody");
    }

    /// @dev A zero / negative feed answer at renew time must NOT pull funds. quote reverts
    ///      InvalidPrice inside the charge -> rolls back -> dun.
    function test_attack_zeroPriceAtRenew_dunsNoPull() public {
        bytes32 sessionId = _openSession(PRICE_USD8 * 10);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);
        uint256 deliveredAfterP1 = _totalDelivered();

        vm.warp(block.timestamp + PERIOD);
        // Post a FRESH-but-zero round (updatedAt = now, answeredInRound = roundId): passes staleness,
        // fails the answer > 0 validity check inside quote.
        usdcFeed.updateAnswer(0);

        uint256 charged = subsC.renew(subId);
        assertEq(charged, 0, "zero price pulls nothing");
        assertEq(grant.remaining(sessionId), PRICE_USD8 * 10 - PRICE_USD8, "only period-1 spent");
        assertEq(_totalDelivered(), deliveredAfterP1, "no delivery on zero-price renew");

        // Negative answer: same outcome.
        vm.warp(block.timestamp + PERIOD);
        usdcFeed.updateAnswer(-1);
        uint256 charged2 = subsC.renew(subId);
        assertEq(charged2, 0, "negative price pulls nothing");
        assertEq(usdc.balanceOf(address(subsC)), 0, "no custody");
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK 3: CATCH-UP BILLING after PAST_DUE recovery
    //////////////////////////////////////////////////////////////*/

    /// @dev After a long PAST_DUE gap, when the subscriber recovers, the keeper can renew repeatedly
    ///      to "catch up" — but EACH catch-up charge consumes exactly one period of budget and the
    ///      never-negative meter is the absolute ceiling. The attack: try to drain MORE than the
    ///      authorized budget via rapid catch-up renews in one block. It must hard-stop at the cap.
    function test_attack_catchupBilling_cannotExceedBudget() public {
        uint256 n = 3; // budget for exactly 3 periods
        bytes32 sessionId = _openSession(PRICE_USD8 * n);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false); // 1

        // Force a long PAST_DUE gap: drop allowance, advance many periods, renew (duns, no advance).
        vm.prank(subscriber);
        usdc.approve(address(subsC), 0);
        _warpAndRefresh(block.timestamp + PERIOD * 10);
        uint256 c0 = subsC.renew(subId);
        assertEq(c0, 0, "dunned while unfunded");
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.PAST_DUE));

        // Recover: re-approve, then HAMMER renew in the same block (periodEnd is far in the past, so
        // each successful renew leaves the sub immediately due again — a catch-up loop).
        vm.prank(subscriber);
        usdc.approve(address(subsC), type(uint256).max);

        uint256 successfulCharges;
        for (uint256 i = 0; i < 10; i++) {
            IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
            if (
                s.status == IAccess0x1Subscriptions.SubStatus.UNPAID
                    || s.status == IAccess0x1Subscriptions.SubStatus.CANCELED
            ) break;
            if (block.timestamp < s.periodEnd) break; // not due
            uint256 c = subsC.renew(subId);
            if (c > 0) successfulCharges++;
        }

        // Budget is the hard ceiling: at most n periods EVER (period 1 + 2 catch-up = 3), never more.
        assertEq(grant.remaining(sessionId), 0, "exactly the full budget spent, never beyond");
        // Period 1 already consumed 1; the catch-up loop could add at most n-1 more.
        assertLe(successfulCharges, n - 1, "catch-up never charges beyond the remaining budget");
        assertEq(usdc.balanceOf(address(subsC)), 0, "no custody after catch-up");
    }

    /// @dev periodEnd is monotonic non-decreasing across an arbitrary dun/recover sequence — a renewal
    ///      can never move it backwards (no period replay / double-charge of the same period window).
    function test_attack_periodEndMonotonicAcrossDunRecover() public {
        bytes32 sessionId = _openSession(PRICE_USD8 * 5);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        uint64 last = subsC.subs(subId).periodEnd;

        // dun once
        vm.prank(subscriber);
        usdc.approve(address(subsC), 0);
        _warpAndRefresh(block.timestamp + PERIOD);
        subsC.renew(subId);
        assertGe(subsC.subs(subId).periodEnd, last, "periodEnd never decreased on dun");
        last = subsC.subs(subId).periodEnd;

        // recover
        vm.prank(subscriber);
        usdc.approve(address(subsC), type(uint256).max);
        subsC.renew(subId);
        assertGe(subsC.subs(subId).periodEnd, last, "periodEnd never decreased on recover");
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK 4: MID-CHARGE RE-ENTRY into setPlan (not nonReentrant)
    //////////////////////////////////////////////////////////////*/

    /// @dev A merchant who controls BOTH the merchant and the settlement token tries to re-enter
    ///      {setPlan} during the renewal pull to corrupt period accounting. The price is snapshotted at
    ///      the top of {renew}, so a mid-charge re-price cannot retroactively change THIS charge; and
    ///      even if periodSecs is mutated, the budget meter still caps total spend and periodEnd stays
    ///      monotonic. The money invariants must hold; at worst the attacker grieves only themselves.
    function test_attack_setPlanReentryDuringRenew_cannotBreakMoneyInvariants() public {
        SetPlanReenterToken evil = new SetPlanReenterToken();
        MockV3Aggregator evilFeed = new MockV3Aggregator(8, 1e8);

        // The token's _update calls setPlan; that requires the MERCHANT OWNER. Make the EVIL TOKEN the
        // merchant owner so the re-entrant setPlan is authorized — the strongest version of the attack.
        vm.startPrank(admin);
        router.setTokenAllowed(address(evil), true);
        router.setPriceFeed(address(evil), address(evilFeed));
        vm.stopPrank();

        vm.prank(address(evil));
        uint256 m2 = router.registerMerchant(payout, feeRecipient, 0, keccak256("m2"));
        vm.prank(address(evil));
        subsC.setPlan(m2, PLAN_KEY, PRICE_USD8, PERIOD, true);

        evil.mint(subscriber, 1_000_000e6);
        vm.prank(subscriber);
        evil.approve(address(subsC), type(uint256).max);

        bytes32 sessionId = _openSession(PRICE_USD8 * 4);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);
        // Re-point: open a sub on m2 with the evil token.
        bytes32 s2 = _openSession(PRICE_USD8 * 4);
        vm.prank(subscriber);
        uint256 subId2 = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), s2, false);
        subId; // (subId is the usdc control sub)

        // Open the real attacked sub on m2 paying in the evil token.
        bytes32 s3 = _openSession(PRICE_USD8 * 4);
        vm.prank(subscriber);
        uint256 atkSub = subsC.subscribe(m2, PLAN_KEY, address(evil), s3, false);
        subId2;

        // Arm the token to shrink periodSecs to 1s during the next pull.
        evil.arm(subsC, m2, PLAN_KEY, PRICE_USD8, 1, address(evil));

        _warpAndRefresh(block.timestamp + PERIOD);
        evilFeed.updateAnswer(1e8);

        uint64 peBefore = subsC.subs(atkSub).periodEnd;
        uint256 remBefore = grant.remaining(s3);
        subsC.renew(atkSub);
        uint64 peAfter = subsC.subs(atkSub).periodEnd;

        // periodEnd is monotonic and the charge consumed AT MOST one period of budget.
        assertGe(peAfter, peBefore, "periodEnd not moved backwards by the re-entry");
        assertGe(remBefore - grant.remaining(s3), 0, "no negative spend");
        assertLe(remBefore - grant.remaining(s3), PRICE_USD8, "at most one period charged");
        // Zero custody preserved regardless of the re-entry.
        assertEq(evil.balanceOf(address(subsC)), 0, "no custody after setPlan re-entry");
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK 5: GAS-METERED try/catch GRIEF
    //////////////////////////////////////////////////////////////*/

    /// @dev A griefer calls renew with a metered gas budget hoping the charge OOGs (caught -> dun)
    ///      while the outer tx survives, demoting a funded subscriber. The honest keeper can ALWAYS
    ///      succeed with adequate gas, and a failed-charge dun consumes NO budget and pulls nothing —
    ///      so the worst case is a retriable no-op, never a money loss or a stuck charge.
    function test_attack_gasMeteredGrief_isRetriableNoOp() public {
        bytes32 sessionId = _openSession(PRICE_USD8 * 10);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        GasGriefKeeper griefer = new GasGriefKeeper(subsC);
        _warpAndRefresh(block.timestamp + PERIOD);

        uint256 remBefore = grant.remaining(sessionId);
        uint256 deliveredBefore = _totalDelivered();

        // Starve the renew of gas: the outer call either reverts wholesale (OOG bubbles) or duns.
        // Either way: nothing is half-charged, no custody, budget intact.
        griefer.renewWithGas{ gas: 200_000 }(subId, 60_000);

        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        // If it dunned, no budget spent + nothing delivered. If it reverted, state is untouched.
        if (s.status == IAccess0x1Subscriptions.SubStatus.PAST_DUE) {
            assertEq(grant.remaining(sessionId), remBefore, "dun consumed no budget");
            assertEq(_totalDelivered(), deliveredBefore, "dun delivered nothing");
        }
        assertEq(usdc.balanceOf(address(subsC)), 0, "no custody after gas grief");

        // The honest keeper retries with adequate gas and SUCCEEDS (the subscriber was always funded).
        vm.prank(keeper);
        uint256 charged = subsC.renew(subId);
        assertGt(charged, 0, "honest keeper can always complete the charge");
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE));
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK 6: ZERO-CUSTODY conservation across a full happy renewal
    //////////////////////////////////////////////////////////////*/

    /// @dev On a SUCCESSFUL renewal, net + fee == gross EXACTLY (router conservation) and the
    ///      subscriptions contract retains zero token + zero allowance. The subscriber's wallet
    ///      decreases by exactly `gross`; the three sinks increase by exactly `gross`.
    function test_attack_renewalConservation_netPlusFeeEqualsGross_zeroResidual() public {
        bytes32 sessionId = _openSession(PRICE_USD8 * 10);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        _warpAndRefresh(block.timestamp + PERIOD);

        uint256 subWalletBefore = usdc.balanceOf(subscriber);
        uint256 sinksBefore = _totalDelivered();

        uint256 gross = subsC.renew(subId);
        assertGt(gross, 0, "renewal charged");

        uint256 subWalletAfter = usdc.balanceOf(subscriber);
        uint256 sinksAfter = _totalDelivered();

        assertEq(subWalletBefore - subWalletAfter, gross, "subscriber paid exactly gross");
        assertEq(sinksAfter - sinksBefore, gross, "net + fee == gross delivered to sinks");
        assertEq(usdc.balanceOf(address(subsC)), 0, "zero residual token");
        assertEq(usdc.allowance(address(subsC), address(router)), 0, "zero residual allowance");
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK 7: ARC 18-DECIMAL TOKEN TRAP — quote + settle exact
    //////////////////////////////////////////////////////////////*/

    /// @dev An 18-decimal "native USDC" must settle the SAME USD value as 6-dec USDC with net + fee ==
    ///      gross and zero residual. A decimals bug here would over/under-charge the subscriber or
    ///      strand dust in the contract. Probe the full charge through subscribe + renew on 18 dec.
    function test_attack_arc18DecimalToken_quotesAndSettlesExact() public {
        Token18 t18 = new Token18();
        MockV3Aggregator feed18 = new MockV3Aggregator(8, 1e8); // $1.00
        vm.startPrank(admin);
        router.setTokenAllowed(address(t18), true);
        router.setPriceFeed(address(t18), address(feed18));
        vm.stopPrank();

        t18.mint(subscriber, 1_000_000e18);
        vm.prank(subscriber);
        t18.approve(address(subsC), type(uint256).max);

        bytes32 sessionId = _openSession(PRICE_USD8 * 5);
        uint256 subWalletBefore = t18.balanceOf(subscriber);
        uint256 sinksBefore =
            t18.balanceOf(payout) + t18.balanceOf(treasury) + t18.balanceOf(feeRecipient);

        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(t18), sessionId, false);

        // $50 at $1.00/token, 18 decimals => exactly 50e18 tokens pulled.
        uint256 expectGross = 50e18;
        uint256 pulled = subWalletBefore - t18.balanceOf(subscriber);
        assertEq(pulled, expectGross, "18-dec subscribe pulled the exact USD value");
        uint256 sinksAfter =
            t18.balanceOf(payout) + t18.balanceOf(treasury) + t18.balanceOf(feeRecipient);
        assertEq(sinksAfter - sinksBefore, expectGross, "net + fee == gross on 18 dec");
        assertEq(t18.balanceOf(address(subsC)), 0, "no 18-dec residual after subscribe");

        // Renew once: identical exact settlement.
        _warpAndRefresh(block.timestamp + PERIOD);
        feed18.updateAnswer(1e8);
        uint256 charged = subsC.renew(subId);
        assertEq(charged, expectGross, "18-dec renew charged the exact USD value");
        assertEq(t18.balanceOf(address(subsC)), 0, "no 18-dec residual after renew");
        assertEq(t18.allowance(address(subsC), address(router)), 0, "no dangling 18-dec allowance");
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK 8: SHARED SESSION backs two subs — budget cap still global
    //////////////////////////////////////////////////////////////*/

    /// @dev If a subscriber reuses ONE session to back TWO subscriptions, the never-negative budget is
    ///      shared and GLOBAL: the two subs together can never spend past the single session cap. The
    ///      attack tries to get 2x the budget's worth of charges by splitting across two subs.
    function test_attack_sharedSessionTwoSubs_globalBudgetCap() public {
        // One session, budget for exactly 3 periods, naming subsC as delegate.
        bytes32 shared = _openSession(PRICE_USD8 * 3);

        // Two subscriptions on the SAME session (same merchant+plan is fine; the session is the cap).
        vm.prank(subscriber);
        uint256 subA = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), shared, false); // spend 1
        vm.prank(subscriber);
        uint256 subB = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), shared, false); // spend 1

        assertEq(grant.remaining(shared), PRICE_USD8, "two subscribes spent two periods of the cap");

        // Now hammer renews on both across periods: total charges across BOTH can never exceed the
        // shared cap of 3 periods (2 already spent at subscribe => at most 1 more total).
        uint256 extraCharges;
        for (uint256 i = 0; i < 6; i++) {
            _warpAndRefresh(block.timestamp + PERIOD);
            // try A
            IAccess0x1Subscriptions.Subscription memory sa = subsC.subs(subA);
            if (
                sa.status != IAccess0x1Subscriptions.SubStatus.UNPAID
                    && sa.status != IAccess0x1Subscriptions.SubStatus.CANCELED
                    && block.timestamp >= sa.periodEnd
            ) {
                if (subsC.renew(subA) > 0) extraCharges++;
            }
            // try B
            IAccess0x1Subscriptions.Subscription memory sb = subsC.subs(subB);
            if (
                sb.status != IAccess0x1Subscriptions.SubStatus.UNPAID
                    && sb.status != IAccess0x1Subscriptions.SubStatus.CANCELED
                    && block.timestamp >= sb.periodEnd
            ) {
                if (subsC.renew(subB) > 0) extraCharges++;
            }
        }
        assertEq(extraCharges, 1, "only one more period fit in the shared cap, never two");
        assertEq(grant.remaining(shared), 0, "shared budget fully + exactly consumed, never beyond");
        assertEq(usdc.balanceOf(address(subsC)), 0, "no custody");
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK 9: TRIAL — no double free period, renew-before-trial-end blocked
    //////////////////////////////////////////////////////////////*/

    /// @dev A TRIALING sub is NOT due until the trial ends; a renew before then reverts NotDue (no
    ///      early charge). When the trial ends, the FIRST renew charges exactly one period (the free
    ///      trial does not also consume budget) and flips ACTIVE. A second trial cannot be re-acquired.
    function test_attack_trialCannotBeChargedEarlyNorDoubleGranted() public {
        bytes32 sessionId = _openSession(PRICE_USD8 * 5);
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, true);
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.TRIALING));
        // The trial period consumed NO budget.
        assertEq(grant.remaining(sessionId), PRICE_USD8 * 5, "trial is free; no budget spent");

        // Renew before the trial ends: NotDue (no early charge).
        uint64 end = subsC.subs(subId).periodEnd;
        _warpAndRefresh(end - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__NotDue.selector, subId, end, block.timestamp
            )
        );
        subsC.renew(subId);

        // At trial end, the first renew charges exactly one period and goes ACTIVE.
        _warpAndRefresh(end);
        uint256 charged = subsC.renew(subId);
        assertGt(charged, 0, "first paid renewal charges");
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE));
        assertEq(grant.remaining(sessionId), PRICE_USD8 * 4, "exactly one period spent after trial");

        // A second subscribe WITH trial on the same (subscriber,merchant,plan) does NOT grant a 2nd
        // free period — it degrades to a paid start (trial-once).
        bytes32 s2 = _openSession(PRICE_USD8 * 2);
        vm.prank(subscriber);
        uint256 sub2 = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), s2, true);
        assertEq(
            uint8(subsC.subs(sub2).status),
            uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE),
            "second trial degrades to paid"
        );
        assertEq(grant.remaining(s2), PRICE_USD8, "second start was charged, not free");
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK 10: SUBSCRIBE period-1 charge failure reverts atomically
    //////////////////////////////////////////////////////////////*/

    /// @dev A non-trial subscribe whose period-1 charge cannot settle (subscriber unfunded/unapproved)
    ///      must REVERT the whole subscribe — no orphan subscription record, and the SessionGrant
    ///      budget is untouched (atomic). No partial state, no leaked id.
    function test_attack_subscribePeriod1Failure_isAtomic() public {
        // A fresh subscriber with an open session but NO approval => the period-1 pull fails.
        (address poor,) = makeAddrAndKey("poor");
        usdc.mint(poor, 1_000e6);
        vm.prank(poor);
        bytes32 sessionId = grant.openSession(address(subsC), PRICE_USD8 * 5, expiry);
        // deliberately no approve()

        uint256 nextBefore = subsC.nextSubId();

        vm.prank(poor);
        vm.expectRevert(); // SafeERC20 pull reverts; subscribe is NOT behind try/catch -> bubbles
        subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);

        // No subscription materialized, no budget spent, nextSubId not advanced past the failed open.
        assertEq(grant.remaining(sessionId), PRICE_USD8 * 5, "no budget spent on failed subscribe");
        // The id that would have been assigned never persisted a sub.
        assertEq(
            uint8(subsC.subs(nextBefore).status),
            uint8(IAccess0x1Subscriptions.SubStatus.NONE),
            "no orphan subscription record"
        );
        assertEq(usdc.balanceOf(address(subsC)), 0, "no custody");
    }
}
