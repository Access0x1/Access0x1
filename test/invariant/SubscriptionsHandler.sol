// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Access0x1Subscriptions } from "../../src/Access0x1Subscriptions.sol";
import { IAccess0x1Subscriptions } from "../../src/interfaces/IAccess0x1Subscriptions.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { SessionGrant } from "../../src/SessionGrant.sol";
import { ISessionGrant } from "../../src/interfaces/ISessionGrant.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";

/// @notice The actor that drives the Access0x1Subscriptions invariant fuzzer through subscribe /
///         renew / cancel / setPlan / time-advance, while keeping the GHOST accounting the suite
///         checks the contract against. Every action is written to NEVER revert (the suite runs
///         `fail_on_revert = true`): inputs are `bound`ed and preconditions early-return.
/// @dev    The handler is BOTH the merchant owner (so it can move plan prices) and the orchestrator of
///         a fixed pool of subscribers (it opens each subscriber's SessionGrant naming the
///         subscriptions contract as delegate, funds + approves them, and pranks as them). It always
///         refreshes the Chainlink feed when it warps so renewals never hit the staleness guard. The
///         fee/treasury sinks are disjoint addresses so the conservation check is exact.
contract SubscriptionsHandler is Test {
    Access0x1Subscriptions public immutable subsC;
    Access0x1Router public immutable router;
    SessionGrant public immutable grant;
    MockUSDC public immutable usdc;
    MockV3Aggregator public immutable feed;

    address public immutable treasury;
    address public immutable payout;
    address public immutable feeRecipient;
    uint256 public immutable merchantId;
    address public immutable merchantOwner;

    uint8 public constant PLAN_KEY = 0;
    uint32 public constant PERIOD = 30 days;
    uint256 public constant MAX_PRICE_USD8 = 1000e8; // <= $1000 / period
    uint256 public constant PERIODS_BUDGET = 24; // each session authorizes up to 24 periods

    // The pool of subscribers (each with a live session naming subsC as delegate).
    address[5] public subscribers;
    bytes32[5] public sessionIds;
    uint256[5] public subIds; // 0 = not yet subscribed
    uint256[5] public budgetOf; // the session budgetCap (USD-8dp) for inv 2

    // ---- ghost accounting ----
    /// @notice subId => cumulative USD-8dp ever charged on it (inv 2: <= its session budgetCap).
    mapping(uint256 => uint256) public ghostUsdSpentBySub;
    /// @notice subId => last observed periodEnd (inv 6: monotonic non-decreasing).
    mapping(uint256 => uint64) public ghostLastPeriodEnd;
    /// @notice The set of subIds the handler has created (for the suite to iterate).
    uint256[] public allSubIds;

    uint256 public ghostGrossToken; // Σ token gross pulled+routed across all renewals (inv 1)

    constructor(
        Access0x1Subscriptions subsC_,
        Access0x1Router router_,
        SessionGrant grant_,
        MockUSDC usdc_,
        MockV3Aggregator feed_,
        address treasury_,
        address payout_,
        address feeRecipient_,
        uint256 merchantId_,
        address merchantOwner_
    ) {
        subsC = subsC_;
        router = router_;
        grant = grant_;
        usdc = usdc_;
        feed = feed_;
        treasury = treasury_;
        payout = payout_;
        feeRecipient = feeRecipient_;
        merchantId = merchantId_;
        merchantOwner = merchantOwner_;

        // Stand up the subscriber pool: fund, approve, and open a delegate session for each.
        uint64 expiry = uint64(block.timestamp + 3650 days);
        for (uint256 i = 0; i < subscribers.length; i++) {
            address sub = makeAddr(string(abi.encodePacked("sub", vm.toString(i))));
            subscribers[i] = sub;
            usdc.mint(sub, type(uint128).max); // effectively unlimited funds
            uint256 budget = MAX_PRICE_USD8 * PERIODS_BUDGET;
            budgetOf[i] = budget;
            vm.startPrank(sub);
            usdc.approve(address(subsC), type(uint256).max);
            sessionIds[i] = grant.openSession(address(subsC), budget, expiry);
            vm.stopPrank();
        }
    }

    /*//////////////////////////////////////////////////////////////
                               HELPERS
    //////////////////////////////////////////////////////////////*/

    function allSubIdsLength() external view returns (uint256) {
        return allSubIds.length;
    }

    /// @dev Keep the feed fresh whenever time moves, so a renewal never hits OracleLib staleness.
    function _refreshFeed() internal {
        feed.updateAnswer(1e8); // $1.00/USDC
    }

    /// @dev Record a subscription's post-op state into the ghosts (inv 2 + inv 6 anchors).
    function _record(uint256 idx, uint256 usdCharged) internal {
        uint256 subId = subIds[idx];
        ghostUsdSpentBySub[subId] += usdCharged;
        uint64 pe = subsC.subs(subId).periodEnd;
        ghostLastPeriodEnd[subId] = pe;
    }

    /*//////////////////////////////////////////////////////////////
                                ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice The merchant owner re-prices the plan within a sane band (proves a re-price is isolated
    ///         and applies only from the next period — never breaks conservation or the budget cap).
    function setPlanPrice(uint256 priceSeed) external {
        uint256 price = bound(priceSeed, 1e8, MAX_PRICE_USD8);
        vm.prank(merchantOwner);
        subsC.setPlan(merchantId, PLAN_KEY, price, PERIOD, true);
    }

    /// @notice A pooled subscriber opens a subscription (if it has none yet). With/without trial.
    function subscribe(uint256 subSeed, bool withTrial) external {
        uint256 idx = subSeed % subscribers.length;
        if (subIds[idx] != 0) return; // already subscribed — one sub per pooled subscriber

        // Need an active plan whose price the session budget can cover at least once.
        IAccess0x1Subscriptions.Plan memory p = subsC.plans(merchantId, PLAN_KEY);
        if (!p.active || p.periodSecs == 0) return;
        if (grant.remaining(sessionIds[idx]) < p.priceUsd8) return;

        _refreshFeed();
        address sub = subscribers[idx];
        uint256 grossBefore =
            usdc.balanceOf(payout) + usdc.balanceOf(treasury) + usdc.balanceOf(feeRecipient);

        vm.prank(sub);
        uint256 subId =
            subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionIds[idx], withTrial);

        subIds[idx] = subId;
        allSubIds.push(subId);

        // A non-trial subscribe charges period 1: fold its gross into the ghosts.
        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        if (s.status == IAccess0x1Subscriptions.SubStatus.ACTIVE) {
            uint256 delivered =
                (usdc.balanceOf(payout) + usdc.balanceOf(treasury) + usdc.balanceOf(feeRecipient))
                    - grossBefore;
            ghostGrossToken += delivered;
            _record(idx, p.priceUsd8);
        } else {
            ghostLastPeriodEnd[subId] = s.periodEnd;
        }
    }

    /// @notice Renew a pooled subscriber's subscription if it is due + renewable. A dunned renew (no
    ///         budget / dead session) pulls nothing — folded as a zero-gross, status-only step.
    function renew(uint256 subSeed) external {
        uint256 idx = subSeed % subscribers.length;
        uint256 subId = subIds[idx];
        if (subId == 0) return;

        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        if (
            s.status == IAccess0x1Subscriptions.SubStatus.UNPAID
                || s.status == IAccess0x1Subscriptions.SubStatus.CANCELED
                || s.status == IAccess0x1Subscriptions.SubStatus.NONE
        ) return;
        if (block.timestamp < s.periodEnd) return; // not due — early return, never revert

        _refreshFeed();
        IAccess0x1Subscriptions.Plan memory p = subsC.plans(merchantId, PLAN_KEY);
        uint256 priceUsd8 = p.priceUsd8;

        uint256 grossBefore =
            usdc.balanceOf(payout) + usdc.balanceOf(treasury) + usdc.balanceOf(feeRecipient);

        uint256 charged = subsC.renew(subId);

        if (charged > 0) {
            uint256 delivered =
                (usdc.balanceOf(payout) + usdc.balanceOf(treasury) + usdc.balanceOf(feeRecipient))
                    - grossBefore;
            ghostGrossToken += delivered;
            ghostUsdSpentBySub[subId] += priceUsd8;
        }
        ghostLastPeriodEnd[subId] = subsC.subs(subId).periodEnd;
    }

    /// @notice Cancel a pooled subscriber's subscription (immediate, no proration).
    function cancel(uint256 subSeed) external {
        uint256 idx = subSeed % subscribers.length;
        uint256 subId = subIds[idx];
        if (subId == 0) return;
        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        if (s.status == IAccess0x1Subscriptions.SubStatus.CANCELED) return;

        vm.prank(subscribers[idx]);
        subsC.cancel(subId);
    }

    /// @notice Advance time so renewals become due (and refresh the feed so they stay priceable).
    function advanceTime(uint256 secs) external {
        secs = bound(secs, 1 days, 45 days);
        vm.warp(block.timestamp + secs);
        _refreshFeed();
    }
}
