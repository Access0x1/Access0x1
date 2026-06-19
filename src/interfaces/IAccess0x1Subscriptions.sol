// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IAccess0x1Router (consumed surface)
/// @author Access0x1
/// @notice The minimal Access0x1Router surface Access0x1Subscriptions calls into — the USD->token
///         quote, the ERC-20 fee-split settlement, and the merchant-owner lookup. Declared here (not
///         imported from the concrete router) so the subscriptions contract depends on a NARROW
///         seam, never the whole router type, and so a build agent can read exactly what it composes.
/// @dev    The full router additionally exposes `payNative`, `platformFeeBps`, `MAX_FEE_BPS`, etc.;
///         only the three members the subscriptions money path needs are surfaced.
interface IAccess0x1Router {
    /// @notice The Chainlink feed answered with a non-positive (zero/negative) price — a feed
    ///         malfunction. Surfaced here so the subscriptions {renew} catch can recognize it as a
    ///         SYSTEM-side failure (re-revert for a keeper retry, never dun the subscriber).
    error Access0x1__InvalidPrice(int256 answer);

    /// @notice Convert a USD amount (8 decimals) into the token amount required, via the token's
    ///         Chainlink <token>/USD feed read THROUGH the staleness guard, in-tx.
    /// @param merchantId Reserved for future per-merchant pricing (ignored by the current router).
    /// @param token      The pay-in token (`address(0)` = native).
    /// @param usdAmount8 The price in USD with 8 decimals.
    /// @return tokenAmount The amount of `token`, in its own decimals, worth `usdAmount8`.
    function quote(uint256 merchantId, address token, uint256 usdAmount8)
        external
        view
        returns (uint256 tokenAmount);

    /// @notice Pay a merchant in an allowlisted ERC-20, priced in USD. Pulls `gross` from `msg.sender`,
    ///         splits the fee exactly once (net -> merchant, fee -> treasury), and holds ~zero after.
    /// @param merchantId The merchant to pay (the fee-split + payout target).
    /// @param token      The allowlisted pay-in ERC-20.
    /// @param usdAmount8 The price in USD (8 decimals).
    /// @param orderId    An opaque order reference echoed in the router's receipt event.
    function payToken(uint256 merchantId, address token, uint256 usdAmount8, bytes32 orderId)
        external;

    /// @notice Read a merchant record. The 2nd return member is the merchant `owner` (the only address
    ///         that may administer the merchant — used here for `onlyMerchantOwner`).
    /// @param id The merchant id.
    function merchants(uint256 id)
        external
        view
        returns (
            address payout,
            address owner,
            address feeRecipient,
            uint16 feeBps,
            bool active,
            bytes32 nameHash
        );
}

/// @title  IAccess0x1Subscriptions
/// @author Access0x1
/// @notice Surface for Access0x1Subscriptions — recurring, USD-priced, tiered billing built as a
///         COMPOSITION of SessionGrant (the sign-once, budget-scoped, time-bounded recurring
///         authorization — a subscription IS a SessionGrant), Access0x1Router (the fee-split applied
///         on every renewal pull), and OracleLib (the in-tx USD->token quote, via the router).
/// @dev    ZERO CUSTODY. The contract holds no subscriber funds: each {renew} debits the SessionGrant
///         budget (the never-negative meter — a HARD revert past budget), pulls the quoted token from
///         the subscriber, and forwards it through the router's fee-split in the SAME tx. Tier
///         entitlement ({effectiveTier}) is a PURE VIEW of stored state, never written by a money path.
interface IAccess0x1Subscriptions {
    // ──────────────────────── types ────────────────────────

    /// @notice The lifecycle status of a subscription.
    /// @dev    TRIALING -> ACTIVE on first paid renewal; ACTIVE -> PAST_DUE on a failed renewal within
    ///         grace; PAST_DUE -> UNPAID once `failCount >= graceFailThreshold`; any -> CANCELED on
    ///         {cancel}. UNPAID and CANCELED are terminal for entitlement (tier demotes).
    enum SubStatus {
        NONE,
        TRIALING,
        ACTIVE,
        PAST_DUE,
        UNPAID,
        CANCELED
    }

    /// @notice An operator-defined, USD-priced plan/tier. Written by {setPlan}; the live values are read
    ///         at {subscribe}/{renew} time (a plan price change applies to the NEXT renewal, never
    ///         retroactively to an in-flight charge, because the charge reads the price at renew time).
    /// @param priceUsd8  The per-period price in USD with 8 decimals (e.g. $29.00 = 29e8).
    /// @param periodSecs The length of one billing period in seconds (non-zero while active).
    /// @param active     Whether new subscriptions may be opened against this plan (renewals of an
    ///                   existing subscription are unaffected — a merchant cannot strand a subscriber).
    struct Plan {
        uint256 priceUsd8;
        uint32 periodSecs;
        bool active;
    }

    /// @notice One subscription. `merchantId`, `subscriber`, `sessionId`, `token`, `planKey` are
    ///         write-once at {subscribe} (immutable for the subscription's life — tenant isolation +
    ///         policy-snapshot law); the lifecycle fields advance on {renew}/{cancel}.
    /// @param merchantId     The Router merchant each renewal pays (fee-split target) — immutable.
    /// @param subscriber     The session owner; the only address that may {cancel} — immutable.
    /// @param sessionId      The SessionGrant authorizing the recurring pulls (delegate == this) — immutable.
    /// @param token          The settlement token (USDC default) — immutable.
    /// @param planKey        The plan index on the merchant this subscription tracks — immutable.
    /// @param periodEnd      The unix second the next renewal becomes due (monotonic non-decreasing).
    /// @param trialExpiresAt The unix second a trial ends (0 = no trial).
    /// @param failCount      The dunning counter (consecutive failed renewals).
    /// @param status         The lifecycle status.
    /// @param hasUsedTrial   Write-once true the first time a trial is granted (trial-once).
    struct Subscription {
        uint256 merchantId;
        address subscriber;
        bytes32 sessionId;
        address token;
        uint8 planKey;
        uint64 periodEnd;
        uint40 trialExpiresAt;
        uint16 failCount;
        SubStatus status;
        bool hasUsedTrial;
    }

    // ──────────────────────── events ────────────────────────

    /// @notice A merchant defined or updated a USD-priced plan/tier.
    event PlanSet(
        uint256 indexed merchantId,
        uint8 indexed planKey,
        uint256 priceUsd8,
        uint32 periodSecs,
        bool active
    );

    /// @notice A subscription was opened.
    /// @param subId       The new subscription id.
    /// @param merchantId  The merchant billed.
    /// @param subscriber  The session owner.
    /// @param planKey     The plan subscribed to.
    /// @param sessionId   The SessionGrant authorizing the pulls.
    /// @param token       The settlement token.
    /// @param trialing    True if opened in a trial (no period-1 charge yet).
    /// @param periodEnd   The first renewal-due timestamp.
    event Subscribed(
        uint256 indexed subId,
        uint256 indexed merchantId,
        address indexed subscriber,
        uint8 planKey,
        bytes32 sessionId,
        address token,
        bool trialing,
        uint64 periodEnd
    );

    /// @notice A renewal charged successfully.
    /// @param subId        The renewed subscription.
    /// @param chargedUsd8  The USD-8dp amount debited from the session budget this period.
    /// @param chargedToken The token amount pulled + routed through the fee-split this period.
    /// @param periodEnd    The new renewal-due timestamp (advanced by one period).
    event Renewed(
        uint256 indexed subId, uint256 chargedUsd8, uint256 chargedToken, uint64 periodEnd
    );

    /// @notice A renewal could not be charged (budget exhausted / session dead / pull failed).
    /// @param subId     The subscription.
    /// @param failCount The new consecutive-failure count.
    /// @param status    The status after applying dunning.
    event RenewalFailed(uint256 indexed subId, uint16 failCount, SubStatus status);

    /// @notice A subscription was canceled by its subscriber. {cancel} also makes a BEST-EFFORT attempt
    ///         to revoke the underlying SessionGrant; the {SessionRevokeOnCancel} event records whether
    ///         that succeeded. A failed revoke never blocks the cancel.
    event Canceled(uint256 indexed subId);

    /// @notice Emitted on every {cancel} to LOUDLY record the fate of the underlying SessionGrant budget
    ///         authorization. SessionGrant.revoke is OWNER-only and this contract is only the session's
    ///         DELEGATE, so the on-chain attempt almost always fails — when `revoked == false` the
    ///         subscriber's budget authorization REMAINS LIVE until the session's own expiry, and the
    ///         subscriber should call `SessionGrant.revoke(sessionId)` themselves to kill it immediately.
    ///         When `revoked == true` the authorization was successfully torn down in this tx.
    /// @param subId     The canceled subscription.
    /// @param sessionId The underlying SessionGrant session id.
    /// @param revoked   True if the best-effort revoke succeeded; false if the budget remains live to expiry.
    event SessionRevokeOnCancel(uint256 indexed subId, bytes32 indexed sessionId, bool revoked);

    /// @notice A terminally-UNPAID subscription was cured back to PAST_DUE by the owner or merchant.
    /// @param subId   The reactivated subscription.
    /// @param caller  The platform owner or merchant owner that cured it.
    event Reactivated(uint256 indexed subId, address indexed caller);

    /// @notice The dunning grace threshold changed.
    event GraceFailThresholdSet(uint16 oldThreshold, uint16 newThreshold);

    // ──────────────────────── errors ────────────────────────

    /// @notice A zero address was supplied where a non-zero one is required.
    error Access0x1Subs__ZeroAddress();

    /// @notice A zero value was supplied where a positive one is required (price/period).
    error Access0x1Subs__ZeroValue();

    /// @notice Caller is not the owner of merchant `id`.
    error Access0x1Subs__NotMerchantOwner(uint256 id, address caller);

    /// @notice Merchant `id` was never registered on the router.
    error Access0x1Subs__MerchantNotFound(uint256 id);

    /// @notice The referenced plan does not exist or is not active for new subscriptions.
    error Access0x1Subs__PlanInactive(uint256 merchantId, uint8 planKey);

    /// @notice The referenced subscription does not exist.
    error Access0x1Subs__SubUnknown(uint256 subId);

    /// @notice Caller is not the subscriber of subscription `subId`.
    error Access0x1Subs__NotSubscriber(uint256 subId, address caller);

    /// @notice The supplied SessionGrant does not authorize THIS contract as its delegate.
    error Access0x1Subs__SessionDelegateMismatch(bytes32 sessionId, address delegate);

    /// @notice The subscriber is not the OWNER of the supplied SessionGrant. Without this bind, a
    ///         stranger could pass a victim's public session id and drain the victim's budget (the
    ///         delegate is this contract, so {SessionGrant.spend} would otherwise pass for anyone).
    error Access0x1Subs__NotSessionOwner(bytes32 sessionId, address caller);

    /// @notice The SessionGrant's remaining budget cannot cover even one period at the plan price.
    error Access0x1Subs__BudgetTooLow(bytes32 sessionId, uint256 remaining, uint256 needed);

    /// @notice The subscription is in a terminal state (UNPAID/CANCELED) and cannot be renewed.
    error Access0x1Subs__NotRenewable(uint256 subId, SubStatus status);

    /// @notice The renewal is not yet due (`block.timestamp < periodEnd`).
    error Access0x1Subs__NotDue(uint256 subId, uint64 periodEnd, uint256 nowTs);

    /// @notice {reactivate} was called on a subscription that is not in the curable UNPAID state.
    error Access0x1Subs__NotReactivatable(uint256 subId, SubStatus status);

    /// @notice Caller is neither the platform owner nor the merchant owner of subscription `subId`.
    error Access0x1Subs__NotAuthorizedToCure(uint256 subId, address caller);

    // ──────────────────────── admin ────────────────────────

    /// @notice Define or update a USD-priced plan/tier on a merchant. Only the merchant owner may call.
    /// @param merchantId The merchant the plan belongs to (caller must own it on the router).
    /// @param planKey    The plan index to write.
    /// @param priceUsd8  The per-period price in USD (8 decimals, non-zero).
    /// @param periodSecs The period length in seconds (non-zero).
    /// @param active     Whether new subscriptions may open against this plan.
    function setPlan(
        uint256 merchantId,
        uint8 planKey,
        uint256 priceUsd8,
        uint32 periodSecs,
        bool active
    ) external;

    /// @notice Open a subscription against a merchant's plan, authorized by an EXISTING SessionGrant
    ///         whose delegate is this contract. With a trial, no period-1 charge is taken; without, the
    ///         first period is charged immediately via the router fee-split.
    /// @param merchantId The merchant to bill.
    /// @param planKey    The plan to subscribe to.
    /// @param token      The settlement token (allowlisted + price-fed on the router).
    /// @param sessionId  The SessionGrant authorizing the recurring pulls (delegate == this).
    /// @param withTrial  Request a trial period (granted only if the subscriber has not used one).
    /// @return subId     The new subscription id.
    function subscribe(
        uint256 merchantId,
        uint8 planKey,
        address token,
        bytes32 sessionId,
        bool withTrial
    ) external returns (uint256 subId);

    /// @notice Relayed subscribe: open the SessionGrant from an off-chain grant signature (EOA /
    ///         ERC-1271 / ERC-6492 counterfactual wallet) AND subscribe in ONE tx. The grant must name
    ///         this contract as the delegate and authorize at least one period of budget.
    /// @param merchantId The merchant to bill.
    /// @param planKey    The plan to subscribe to.
    /// @param token      The settlement token.
    /// @param subscriber The session owner the grant was signed by.
    /// @param budgetCap  The total session budget (USD-8dp) — `periods x priceUsd8`.
    /// @param expiry     The session expiry (unix seconds, in the future).
    /// @param withTrial  Request a trial period.
    /// @param grantSig   The subscriber's SessionGrant signature (raw ECDSA / ERC-1271 / ERC-6492).
    /// @return subId     The new subscription id.
    function subscribeFor(
        uint256 merchantId,
        uint8 planKey,
        address token,
        address subscriber,
        uint256 budgetCap,
        uint64 expiry,
        bool withTrial,
        bytes calldata grantSig
    ) external returns (uint256 subId);

    /// @notice Charge the next period of a subscription. PERMISSIONLESS (keeper-callable). Debits the
    ///         SessionGrant budget (hard revert past budget — the never-negative meter), then pulls the
    ///         quoted token and routes it through the router fee-split, all in one tx; advances the
    ///         period and sets ACTIVE. Reverts if not yet due or terminal.
    /// @param subId The subscription to renew.
    /// @return chargedToken The token amount pulled + routed this period.
    function renew(uint256 subId) external returns (uint256 chargedToken);

    /// @notice Cancel a subscription immediately. Only the subscriber may call. Revokes the underlying
    ///         SessionGrant (no further pulls possible) and sets CANCELED. No proration refund.
    /// @param subId The subscription to cancel.
    function cancel(uint256 subId) external;

    /// @notice Cure a terminally-UNPAID subscription back to PAST_DUE so a {renew} can be retried. Only
    ///         the platform owner or the subscription's merchant owner may call. The dunning counter is
    ///         reset so a fresh grace window applies; the period is NOT advanced (a renew still charges
    ///         the outstanding period). Without this, UNPAID is irreversible — a subscriber wrongly
    ///         demoted (e.g. an amplified dunning during a router pause) could only recover by opening a
    ///         brand-new subscription on a new subId. CANCELED stays terminal (not curable).
    /// @param subId The UNPAID subscription to cure.
    function reactivate(uint256 subId) external;

    /// @notice Set the dunning grace threshold: PAST_DUE demotes to UNPAID once `failCount` reaches it.
    /// @param newThreshold The new threshold (non-zero).
    function setGraceFailThreshold(uint16 newThreshold) external;

    // ──────────────────────── views ────────────────────────

    /// @notice Read a plan.
    function plans(uint256 merchantId, uint8 planKey) external view returns (Plan memory);

    /// @notice Read a subscription.
    function subs(uint256 subId) external view returns (Subscription memory);

    /// @notice The entitled tier for a subscription RIGHT NOW — a PURE function of stored state
    ///         (`status`, `periodEnd`, `trialExpiresAt`, `hasUsedTrial`), never written by any path.
    ///         Returns 0 (the STARTER / no-entitlement tier) when the subscription is terminal
    ///         (UNPAID/CANCELED) or its trial has lapsed without converting; otherwise the plan tier
    ///         (`planKey + 1`, so an entitled subscription is always non-zero).
    /// @param subId The subscription id.
    /// @return tier The entitled tier (0 = no entitlement).
    function effectiveTier(uint256 subId) external view returns (uint8 tier);
}
