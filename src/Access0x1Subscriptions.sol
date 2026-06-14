// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ISessionGrant } from "./interfaces/ISessionGrant.sol";
import {
    IAccess0x1Router,
    IAccess0x1Subscriptions
} from "./interfaces/IAccess0x1Subscriptions.sol";

/// @title  Access0x1Subscriptions
/// @author Access0x1
/// @notice Recurring, USD-priced, tiered billing — the on-chain expression of a mature commerce app's
///         SUBSCRIPTIONS / TIERS primitive (the never-negative AI spend meter), built ENTIRELY as a
///         COMPOSITION of the audited Access0x1 quartet:
///
///           - {SessionGrant} is the recurring authorization. A subscription IS a SessionGrant: the
///             subscriber signs ONCE to open a budget-scoped (`periods x priceUsd8`), time-bounded
///             session that names THIS contract as its delegate. Every {renew} debits that budget via
///             {SessionGrant.spend}, which HARD-REVERTS past the cap — the never-negative meter. This
///             contract never re-implements the budget check; it can only spend, never bypass.
///           - {Access0x1Router} is the money spine. Every renewal pull is routed through
///             {Access0x1Router.payToken}, so the platform fee is taken EXACTLY ONCE and
///             `net + fee == gross` is proven by the router's own fuzz invariants — never re-derived
///             here. This contract owns lifecycle/eligibility only.
///           - {OracleLib} (reached through {Access0x1Router.quote}) prices the USD period charge into
///             the settlement token IN-TX, with the staleness guard.
///
///         TIER ENTITLEMENT is a read-time VIEW ({effectiveTier}) derived purely from stored state —
///         no money path ever writes a tier (re-subscribe re-unlocks with no cron).
/// @dev    ZERO CUSTODY. There is no escrow. The SessionGrant holds NO funds (it is a pure accounting
///         budget); each {renew} pulls the quoted token from the subscriber and forwards it through the
///         router's fee-split in the SAME tx, leaving this contract ~zero token balance. CEI +
///         `nonReentrant` + `SafeERC20` on every value path; `Ownable2Step` for the one admin knob.
contract Access0x1Subscriptions is IAccess0x1Subscriptions, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The Access0x1Router this contract routes every renewal pull through (immutable spine).
    IAccess0x1Router public immutable router;

    /// @notice The SessionGrant that holds the recurring authorizations this contract spends against.
    ISessionGrant public immutable sessionGrant;

    /// @notice merchantId => planKey => the operator-defined, USD-priced plan.
    mapping(uint256 merchantId => mapping(uint8 planKey => Plan plan)) private _plans;

    /// @notice subId => the subscription record.
    mapping(uint256 subId => Subscription sub) private _subs;

    /// @notice subscriber => merchantId => planKey => the subscriber has already consumed a trial on
    ///         this plan. The trial-once guard: a subscriber cannot re-open a fresh subscription with a
    ///         new trial on the same plan to dodge paying (write-once true the first time a trial is
    ///         granted). Keyed per (subscriber, merchant, plan) so a different plan/merchant is unaffected.
    mapping(
        address subscriber => mapping(uint256 merchantId => mapping(uint8 planKey => bool used))
    ) public hasUsedTrial;

    /// @notice The id assigned to the next {subscribe}. Starts at 1, so 0 is an unset sentinel.
    uint256 public nextSubId;

    /// @notice Dunning grace: a PAST_DUE subscription demotes to UNPAID once `failCount` reaches this.
    ///         Mirrors a typical grace window (tier survives PAST_DUE, demotes only at UNPAID).
    uint16 public graceFailThreshold;

    /// @notice Restrict a function to the current owner of `merchantId` on the router.
    /// @param merchantId The merchant whose owner is authorized.
    modifier onlyMerchantOwner(uint256 merchantId) {
        (, address mOwner,,,,) = router.merchants(merchantId);
        if (mOwner == address(0)) revert Access0x1Subs__MerchantNotFound(merchantId);
        if (msg.sender != mOwner) revert Access0x1Subs__NotMerchantOwner(merchantId, msg.sender);
        _;
    }

    /// @param initialOwner       The admin (Ownable2Step) — burner at the event, multisig in prod.
    /// @param router_            The deployed Access0x1Router (the fee-split + quote spine).
    /// @param sessionGrant_      The deployed SessionGrant (the recurring authorization ledger).
    /// @param graceFailThreshold_ The initial dunning threshold (non-zero).
    constructor(
        address initialOwner,
        IAccess0x1Router router_,
        ISessionGrant sessionGrant_,
        uint16 graceFailThreshold_
    ) Ownable(initialOwner) {
        if (address(router_) == address(0) || address(sessionGrant_) == address(0)) {
            revert Access0x1Subs__ZeroAddress();
        }
        if (graceFailThreshold_ == 0) revert Access0x1Subs__ZeroValue();
        router = router_;
        sessionGrant = sessionGrant_;
        nextSubId = 1;
        graceFailThreshold = graceFailThreshold_;
        emit GraceFailThresholdSet(0, graceFailThreshold_);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Subscriptions
    function plans(uint256 merchantId, uint8 planKey) external view returns (Plan memory) {
        return _plans[merchantId][planKey];
    }

    /// @inheritdoc IAccess0x1Subscriptions
    function subs(uint256 subId) external view returns (Subscription memory) {
        return _subs[subId];
    }

    /// @inheritdoc IAccess0x1Subscriptions
    /// @dev PURE read of stored state — this function is `view` and writes NOTHING, so no money path
    ///      can ever materialize or revoke a tier as a side effect (the read-time entitlement law).
    ///      A TRIALING subscription whose trial has lapsed (without a paid renewal flipping it to
    ///      ACTIVE) is treated as un-entitled; otherwise the tier is `planKey + 1` so an entitled
    ///      subscription is always strictly positive (0 is reserved for "no entitlement / STARTER").
    function effectiveTier(uint256 subId) external view returns (uint8 tier) {
        Subscription storage s = _subs[subId];
        SubStatus status = s.status;

        // Unknown or terminal: no entitlement.
        if (status == SubStatus.NONE || status == SubStatus.UNPAID || status == SubStatus.CANCELED)
        {
            return 0;
        }
        // A trial that has lapsed without converting to a paid period is no longer entitled.
        if (
            status == SubStatus.TRIALING && s.trialExpiresAt != 0
                && block.timestamp > s.trialExpiresAt
        ) {
            return 0;
        }
        // TRIALING (still within trial), ACTIVE, and PAST_DUE (within grace) all keep the tier.
        return uint8(s.planKey) + 1;
    }

    /*//////////////////////////////////////////////////////////////
                                  PLANS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Subscriptions
    /// @dev The merchant owner defines USD-priced tiers. Writing a plan never touches any subscription
    ///      (tenant isolation) and never retroactively re-prices an in-flight charge — {renew} reads
    ///      the live price at charge time, so a price change applies from the NEXT period onward.
    function setPlan(
        uint256 merchantId,
        uint8 planKey,
        uint256 priceUsd8,
        uint32 periodSecs,
        bool active
    ) external nonReentrant onlyMerchantOwner(merchantId) {
        if (priceUsd8 == 0 || periodSecs == 0) revert Access0x1Subs__ZeroValue();
        _plans[merchantId][planKey] =
            Plan({ priceUsd8: priceUsd8, periodSecs: periodSecs, active: active });
        emit PlanSet(merchantId, planKey, priceUsd8, periodSecs, active);
    }

    /*//////////////////////////////////////////////////////////////
                                SUBSCRIBE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Subscriptions
    function subscribe(
        uint256 merchantId,
        uint8 planKey,
        address token,
        bytes32 sessionId,
        bool withTrial
    ) external nonReentrant returns (uint256 subId) {
        return _subscribe(merchantId, planKey, token, sessionId, msg.sender, withTrial);
    }

    /// @inheritdoc IAccess0x1Subscriptions
    /// @dev Relayed path: open the SessionGrant from the signed grant (the delegate MUST be this
    ///      contract), then subscribe for the signing owner. ERC-6492 lets a counterfactual smart
    ///      account subscribe in one tx. The session id is the deterministic
    ///      `keccak256(subscriber, this, nonce)` at the owner's current nonce.
    function subscribeFor(
        uint256 merchantId,
        uint8 planKey,
        address token,
        address subscriber,
        uint256 budgetCap,
        uint64 expiry,
        bool withTrial,
        bytes calldata grantSig
    ) external nonReentrant returns (uint256 subId) {
        if (subscriber == address(0)) revert Access0x1Subs__ZeroAddress();
        // Open the session with THIS contract as the delegate; SessionGrant validates the signature
        // (EOA / ERC-1271 / ERC-6492) against `subscriber` and consumes its nonce. A relayer cannot
        // alter any grant field — the digest pins delegate=this, budgetCap, and expiry.
        bytes32 sessionId =
            sessionGrant.openSessionFor(subscriber, address(this), budgetCap, expiry, grantSig);
        return _subscribe(merchantId, planKey, token, sessionId, subscriber, withTrial);
    }

    /// @dev The shared subscribe core. Validates the plan + the session (delegate == this, budget
    ///      covers >= 1 period), writes the immutable subscription record, and either stamps a trial
    ///      (no charge) or charges period 1 immediately through the router fee-split.
    function _subscribe(
        uint256 merchantId,
        uint8 planKey,
        address token,
        bytes32 sessionId,
        address subscriber,
        bool withTrial
    ) private returns (uint256 subId) {
        Plan memory plan = _plans[merchantId][planKey];
        if (!plan.active || plan.periodSecs == 0) {
            revert Access0x1Subs__PlanInactive(merchantId, planKey);
        }
        // The merchant must exist on the router (its owner backs the fee-split + plan authority).
        (, address mOwner,,,,) = router.merchants(merchantId);
        if (mOwner == address(0)) revert Access0x1Subs__MerchantNotFound(merchantId);

        // The session must name THIS contract as its delegate (only then can we {spend}) and authorize
        // at least one period at the plan price (the never-negative budget covers >= 1 charge).
        ISessionGrant.Session memory sess = sessionGrant.sessionOf(sessionId);
        if (sess.delegate != address(this)) {
            revert Access0x1Subs__SessionDelegateMismatch(sessionId, sess.delegate);
        }
        uint256 live = sessionGrant.remaining(sessionId);
        if (live < plan.priceUsd8) {
            revert Access0x1Subs__BudgetTooLow(sessionId, live, plan.priceUsd8);
        }

        subId = nextSubId++;

        // Trial-once: only grant a trial if the subscriber has never trialed THIS plan before. A
        // re-request after a prior trial silently degrades to a paid (non-trial) start — never an
        // error, but never a second free period (the on-chain expression of "trial used once").
        bool trialing = withTrial && !hasUsedTrial[subscriber][merchantId][planKey];
        uint40 trialExpiresAt = 0;
        uint64 periodEnd;
        SubStatus status;

        if (trialing) {
            // Stamp a trial: no period-1 charge, tier entitled until the trial lapses.
            hasUsedTrial[subscriber][merchantId][planKey] = true; // write-once
            trialExpiresAt = uint40(block.timestamp + plan.periodSecs);
            periodEnd = uint64(trialExpiresAt);
            status = SubStatus.TRIALING;
        } else {
            periodEnd = uint64(block.timestamp + plan.periodSecs);
            status = SubStatus.ACTIVE;
        }

        _subs[subId] = Subscription({
            merchantId: merchantId,
            subscriber: subscriber,
            sessionId: sessionId,
            token: token,
            planKey: planKey,
            periodEnd: periodEnd,
            trialExpiresAt: trialExpiresAt,
            failCount: 0,
            status: status,
            hasUsedTrial: trialing
        });

        emit Subscribed(
            subId, merchantId, subscriber, planKey, sessionId, token, trialing, periodEnd
        );

        // Non-trial: charge period 1 NOW. The subscriber is present, so a failure here REVERTS the
        // whole subscribe (they must fund/approve) — there is nothing to dun yet.
        if (!trialing) {
            _charge(subId, merchantId, sessionId, token, plan.priceUsd8);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 RENEW
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Subscriptions
    /// @dev PERMISSIONLESS / keeper-callable. Hard programmer errors (unknown sub, not due, terminal
    ///      status) revert. The actual charge runs behind a try/catch on a self-call: if the budget is
    ///      exhausted, the session is dead, or the pull fails, the charge reverts and rolls back
    ///      ENTIRELY (no budget consumed, no token moved — the never-negative meter is preserved), and
    ///      the catch applies dunning instead of reverting the keeper's tx. On success the period
    ///      advances and the subscription is ACTIVE.
    function renew(uint256 subId) external nonReentrant returns (uint256 chargedToken) {
        Subscription storage s = _subs[subId];
        SubStatus status = s.status;
        if (status == SubStatus.NONE) revert Access0x1Subs__SubUnknown(subId);
        // ACTIVE, TRIALING, and PAST_DUE are renewable; UNPAID and CANCELED are terminal.
        if (status == SubStatus.UNPAID || status == SubStatus.CANCELED) {
            revert Access0x1Subs__NotRenewable(subId, status);
        }
        uint64 due = s.periodEnd;
        if (block.timestamp < due) revert Access0x1Subs__NotDue(subId, due, block.timestamp);

        uint256 merchantId = s.merchantId;
        bytes32 sessionId = s.sessionId;
        address token = s.token;
        uint8 planKey = s.planKey;
        // Snapshot the plan terms into stack locals BEFORE any external call. `chargeViaSelf` routes
        // through a merchant-controlled ERC-20 (and the router's fee-split); a malicious token callback
        // inside that call could shrink the plan (smaller periodSecs / different priceUsd8) mid-renew.
        // Pinning both up front means the period advances by EXACTLY one period at the price charged,
        // never a re-read post-call that a callback could have mutated to drain the session budget.
        // (Live read here = a merchant re-price applies from this period on, never retroactively.)
        Plan memory plan = _plans[merchantId][planKey];
        uint256 priceUsd8 = plan.priceUsd8;
        uint32 periodSecs = plan.periodSecs;

        // Charge behind a self-call boundary so a failed charge rolls back without reverting the
        // keeper — the only place dunning is applied. `chargeViaSelf` re-asserts caller == this.
        try this.chargeViaSelf(subId, merchantId, sessionId, token, priceUsd8) returns (
            uint256 tokenPulled
        ) {
            chargedToken = tokenPulled;
            // Effects: advance the period by the snapshotted periodSecs (not a post-call re-read),
            // clear dunning, mark ACTIVE.
            unchecked {
                s.periodEnd = due + uint64(periodSecs);
            }
            s.failCount = 0;
            s.status = SubStatus.ACTIVE;
            emit Renewed(subId, priceUsd8, chargedToken, s.periodEnd);
        } catch {
            _markRenewalFailed(s, subId);
            chargedToken = 0;
        }
    }

    /// @notice Internal charge wrapped as an external self-call so {renew} can try/catch it. Reverts
    ///         (rolling back the whole leg) on any failure; callable ONLY by this contract.
    /// @dev    Re-entrancy: this is invoked from inside {renew}'s `nonReentrant` body via an external
    ///         self-call. {SessionGrant.spend} and {Access0x1Router.payToken} are the only external
    ///         calls; CEI holds within {_charge}. The self-call cannot be entered by anyone but this
    ///         contract (the `msg.sender == address(this)` gate).
    function chargeViaSelf(
        uint256 subId,
        uint256 merchantId,
        bytes32 sessionId,
        address token,
        uint256 priceUsd8
    ) external returns (uint256 tokenPulled) {
        if (msg.sender != address(this)) {
            revert Access0x1Subs__NotSubscriber(subId, msg.sender);
        }
        return _charge(subId, merchantId, sessionId, token, priceUsd8);
    }

    /// @dev The single charge primitive shared by {subscribe} (period 1) and {renew}.
    ///      ORDER (CEI + never-negative + zero-custody):
    ///        1. Debit the SessionGrant budget by `priceUsd8` — {SessionGrant.spend} HARD-REVERTS if
    ///           this would exceed the authorized cap. This is the never-negative meter; this contract
    ///           never bypasses it. If it reverts, nothing below runs.
    ///        2. Quote `priceUsd8 -> token` via the router (OracleLib staleness, in-tx).
    ///        3. Pull exactly `gross` token from the SUBSCRIBER into this contract (they approved this
    ///           contract), approve the router, and route through {Access0x1Router.payToken} — the
    ///           fee-split runs there exactly once. The router pulls `gross` back out, so this contract
    ///           holds ~zero token after (zero custody). The router re-quotes in the same block/tx, so
    ///           the amount it pulls equals the `gross` pulled in.
    /// @return gross The token amount pulled from the subscriber and routed through the fee-split.
    function _charge(
        uint256 subId,
        uint256 merchantId,
        bytes32 sessionId,
        address token,
        uint256 priceUsd8
    ) private returns (uint256 gross) {
        // 1. Never-negative budget meter (reverts past cap — we never re-implement or skip it).
        sessionGrant.spend(sessionId, priceUsd8);

        // 2. In-tx USD->token quote via the router (Chainlink staleness guard inside).
        gross = router.quote(merchantId, token, priceUsd8);

        Subscription storage s = _subs[subId];
        address subscriber = s.subscriber;

        // 3. Pull gross from the subscriber, then route it through the router's fee-split. The
        //    balance-delta is implicitly enforced by the router's own fee-on-transfer rejection when it
        //    pulls `gross` back from this contract; we forward exactly what we pulled in.
        IERC20(token).safeTransferFrom(subscriber, address(this), gross);
        IERC20(token).forceApprove(address(router), gross);
        // orderId binds the receipt to this subscription + period for off-chain reconciliation.
        router.payToken(merchantId, token, priceUsd8, _orderId(subId, s.periodEnd));

        // Defensive: drop any residual approval so no allowance lingers on this contract (zero trust).
        IERC20(token).forceApprove(address(router), 0);
    }

    /// @dev Apply dunning to a failed renewal: bump the consecutive-failure count and demote to UNPAID
    ///      once it reaches the grace threshold, else PAST_DUE (tier survives PAST_DUE). Never reverts.
    function _markRenewalFailed(Subscription storage s, uint256 subId) private {
        uint16 fails;
        unchecked {
            fails = s.failCount + 1; // a uint16 of consecutive failures cannot realistically overflow
        }
        s.failCount = fails;
        SubStatus newStatus = fails >= graceFailThreshold ? SubStatus.UNPAID : SubStatus.PAST_DUE;
        s.status = newStatus;
        emit RenewalFailed(subId, fails, newStatus);
    }

    /*//////////////////////////////////////////////////////////////
                                 CANCEL
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Subscriptions
    /// @dev Immediate, no proration (the standard downgrade rule). Setting CANCELED is the on-chain
    ///      stop: {renew} reverts {NotRenewable} on a CANCELED subscription, so no further pull can ever
    ///      run through this contract. The underlying SessionGrant is owner-gated, so the subscriber
    ///      (who IS the session owner) revokes it directly on SessionGrant for a belt-and-suspenders
    ///      kill of the authorization itself — this contract is only the delegate and cannot revoke.
    ///      Only the subscriber may cancel.
    function cancel(uint256 subId) external nonReentrant {
        Subscription storage s = _subs[subId];
        if (s.status == SubStatus.NONE) revert Access0x1Subs__SubUnknown(subId);
        if (msg.sender != s.subscriber) revert Access0x1Subs__NotSubscriber(subId, msg.sender);
        if (s.status == SubStatus.CANCELED) revert Access0x1Subs__NotRenewable(subId, s.status);

        s.status = SubStatus.CANCELED;
        emit Canceled(subId);
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Subscriptions
    function setGraceFailThreshold(uint16 newThreshold) external onlyOwner {
        if (newThreshold == 0) revert Access0x1Subs__ZeroValue();
        emit GraceFailThresholdSet(graceFailThreshold, newThreshold);
        graceFailThreshold = newThreshold;
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev The opaque order reference echoed into the router receipt: binds (subId, periodEnd) so an
    ///      indexer can reconcile each renewal to its exact period without storing PII on-chain.
    function _orderId(uint256 subId, uint64 periodEnd) private pure returns (bytes32) {
        return keccak256(abi.encode("Access0x1Subscriptions", subId, periodEnd));
    }
}
