// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IAutomationGateway
/// @author Access0x1
/// @notice The external surface of {AutomationGateway} — the permissionless Chainlink Automation
///         front-door for {Access0x1Subscriptions}. Recurring billing on Access0x1 is settled by the
///         PERMISSIONLESS {Access0x1Subscriptions.renew}: anyone (a keeper, a cron, a rival team's
///         script) may poke a due subscription and the renewal pulls from the subscriber through the
///         router fee-split, with the gateway holding NO funds at any point. This contract turns that
///         "anyone can poke" property into a SELF-DRIVING service: a watch registry of subscription
///         ids + the two Chainlink Automation methods ({checkUpkeep} off-chain, {performUpkeep}
///         on-chain) so a registered Chainlink upkeep auto-renews every due subscription with NO
///         centralized cron and NO custom keeper to run.
/// @dev    ZERO CUSTODY. The gateway only ever calls the permissionless {Access0x1Subscriptions.renew},
///         which self-guards (debits the never-negative SessionGrant meter, pulls the quoted token from
///         the subscriber, routes it through the router fee-split — all in the SAME tx, leaving this
///         contract ~zero balance). It never touches a subscriber's tokens, never holds an approval,
///         and never has any authority a subscriber has not already granted to the Subscriptions
///         contract via their SessionGrant.
///
///         PERMISSIONLESS REGISTRATION is SAFE by construction. {register} is open to anyone — a
///         third party may sponsor a subscription for automation. Registering a non-existent id, an
///         id owned by someone else, or a terminal subscription is HARMLESS: {performUpkeep} only ever
///         calls the permissionless {renew}, which reverts/no-ops on anything not currently due, and
///         each renew is wrapped in try/catch so one bad id never blocks the batch. The registry is a
///         convenience index for the off-chain {checkUpkeep} scan, never a grant of authority.
interface IAutomationGateway {
    // ──────────────────────── events ────────────────────────

    /// @notice A subscription id was added to the watch registry (idempotent — a re-register of an
    ///         already-watched id is a no-op and emits nothing).
    /// @param subId  The subscription id now watched for automated renewal.
    /// @param caller The address that registered it (anyone — registration is permissionless).
    event Registered(uint256 indexed subId, address indexed caller);

    /// @notice A subscription id was removed from the watch registry (idempotent — a deregister of an
    ///         unwatched id is a no-op and emits nothing).
    /// @param subId  The subscription id no longer watched.
    /// @param caller The address that deregistered it.
    event Deregistered(uint256 indexed subId, address indexed caller);

    /// @notice A watched subscription was successfully renewed by {performUpkeep}.
    /// @param subId        The renewed subscription.
    /// @param chargedToken The token amount {Access0x1Subscriptions.renew} pulled + routed this period
    ///                     (0 when the renewal dunned rather than charged — renew never reverts on a
    ///                     subscriber-attributable failure, it duns and returns 0).
    event Renewed(uint256 indexed subId, uint256 chargedToken);

    /// @notice A watched subscription's renewal reverted inside {performUpkeep} and was isolated by the
    ///         try/catch so the rest of the batch still ran. A revert here is a SYSTEM-side failure
    ///         (router paused, oracle stale, sequencer down) that {Access0x1Subscriptions.renew}
    ///         deliberately re-reverts for a later retry — never a lost renewal, never a blocked batch.
    /// @param subId The subscription whose renewal reverted (skipped this round; retried next round).
    /// @param err   The raw revert returndata from the failed renew (for off-chain diagnosis).
    event RenewFailed(uint256 indexed subId, bytes err);

    // ──────────────────────── errors ────────────────────────

    /// @notice A zero address was supplied where a non-zero one is required (the Subscriptions binding).
    error AutomationGateway__ZeroAddress();

    // ──────────────────────── registry ────────────────────────

    /// @notice Add a subscription id to the watch registry so a Chainlink upkeep auto-renews it when due.
    ///         PERMISSIONLESS — anyone may sponsor any id for automation; safe because {performUpkeep}
    ///         only ever calls the permissionless, self-guarding {renew} (an invalid/foreign/terminal id
    ///         simply never charges). Idempotent: re-registering a watched id is a silent no-op.
    /// @param subId The subscription id to watch.
    function register(uint256 subId) external;

    /// @notice Remove a subscription id from the watch registry. Idempotent: deregistering an unwatched
    ///         id is a silent no-op. Anyone may deregister — the registry holds no authority, so the
    ///         worst a griefer can do is drop an id from the convenience index (the subscription itself
    ///         is unaffected and can still be renewed by a direct {renew} call or re-registered).
    /// @param subId The subscription id to stop watching.
    function deregister(uint256 subId) external;

    // ──────────────────────── automation ────────────────────────

    /// @notice Chainlink Automation simulation entrypoint. Scans up to {MAX_SCAN} watched ids, collects
    ///         those currently DUE for renewal (`block.timestamp >= periodEnd` and the status is
    ///         renewable), caps the batch at {MAX_BATCH}, and abi-encodes them into `performData`.
    ///         Off-chain only — never trust its output on-chain; {performUpkeep} re-validates every id.
    /// @param checkData Registration-time bytes (unused — this gateway watches a single shared registry).
    /// @return upkeepNeeded True iff at least one watched subscription is due.
    /// @return performData  `abi.encode(uint256[] dueIds)` — the due ids to renew (empty when none).
    function checkUpkeep(bytes calldata checkData)
        external
        returns (bool upkeepNeeded, bytes memory performData);

    /// @notice Chainlink Automation execution entrypoint. Decodes the due ids from `performData` and
    ///         calls {Access0x1Subscriptions.renew} on each, RE-VALIDATING due-ness on-chain first
    ///         (checkUpkeep ran off-chain and is stale by now) and wrapping each renew in try/catch so
    ///         one failing renewal never blocks the batch. PERMISSIONLESS + input-untrusted, exactly as
    ///         Chainlink requires: the data is not trusted, every id is re-checked against live state.
    /// @param performData `abi.encode(uint256[] dueIds)` from {checkUpkeep} (untrusted — re-validated).
    function performUpkeep(bytes calldata performData) external;

    // ──────────────────────── views ────────────────────────

    /// @notice The Access0x1Subscriptions contract this gateway renews against (bound once in initialize).
    function subscriptions() external view returns (address);

    /// @notice Whether `subId` is currently in the watch registry.
    /// @param subId The subscription id to query.
    function isWatched(uint256 subId) external view returns (bool);

    /// @notice The number of subscription ids currently watched.
    function watchedCount() external view returns (uint256);

    /// @notice The watched subscription id at `index` in the enumerable set (0-based; order is not
    ///         guaranteed stable across removals). Use with {watchedCount} to page the registry off-chain.
    /// @param index The position in the set.
    function watchedAt(uint256 index) external view returns (uint256 subId);

    /// @notice Whether a watched subscription is DUE for renewal RIGHT NOW — a pure read of the
    ///         Subscriptions record (status renewable AND `block.timestamp >= periodEnd`). The same
    ///         predicate {checkUpkeep} collects on and {performUpkeep} re-validates against.
    /// @param subId The subscription id to test.
    /// @return due  True iff the subscription exists, is renewable (not NONE/UNPAID/CANCELED), and the
    ///              current period has ended.
    function isDue(uint256 subId) external view returns (bool due);
}
