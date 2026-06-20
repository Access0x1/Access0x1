// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    Ownable2StepUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {
    AutomationCompatibleInterface
} from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import { IAccess0x1Subscriptions } from "./interfaces/IAccess0x1Subscriptions.sol";
import { IAutomationGateway } from "./interfaces/IAutomationGateway.sol";

/// @title  AutomationGateway
/// @author Access0x1
/// @notice The permissionless Chainlink Automation FRONT-DOOR for {Access0x1Subscriptions} — the
///         self-driving keeper that makes recurring billing run itself with NO centralized cron. The
///         Subscriptions money path already settles each period through the PERMISSIONLESS
///         {Access0x1Subscriptions.renew} (anyone may poke a due subscription; the pull comes from the
///         subscriber through the router fee-split, the gateway never custodies). This contract turns
///         that property into a registered Chainlink upkeep: a watch registry of subscription ids plus
///         the two `AutomationCompatibleInterface` methods — {checkUpkeep} (off-chain: which ids are
///         due?) and {performUpkeep} (on-chain: renew them) — so a Chainlink Automation upkeep, or any
///         caller, drives every due renewal with no operator and no trusted scheduler.
/// @dev    ZERO CUSTODY, ZERO PRIVILEGE. The ONLY external call this contract ever makes on the money
///         path is {IAccess0x1Subscriptions.renew}, which is itself permissionless and fully
///         self-guarding: it debits the never-negative SessionGrant meter, pulls the quoted token from
///         the SUBSCRIBER, and routes it through the router's fee-split, all in one tx — leaving BOTH
///         the Subscriptions contract and THIS gateway at ~zero token balance. The gateway holds no
///         tokens, no approvals, and no authority a subscriber has not already granted. It is a pure
///         POKE: it can cause a due renewal to happen sooner, never a charge that {renew} would not
///         already permit any caller to make.
///
///         PERMISSIONLESS REGISTRATION is safe by construction. {register} accepts ANY id from ANYONE
///         (a third party may sponsor a subscription for automation). Registering a non-existent,
///         foreign, or terminal id is harmless: {performUpkeep} re-validates due-ness on-chain and then
///         calls only the self-guarding {renew}, wrapped in try/catch — a bad id never charges and never
///         blocks the batch. The registry is a convenience index for the off-chain scan, not a grant.
///
///         BOUNDED LOOPS. Both {checkUpkeep} and {performUpkeep} are bounded: the off-chain scan reads
///         at most {MAX_SCAN} watched ids and returns at most {MAX_BATCH}; {performUpkeep} renews at
///         most the {MAX_BATCH} ids it decodes. No unbounded iteration over a growable set can ever brick
///         an upkeep regardless of how many ids are registered (money-safety invariant: no unbounded loops).
///
///         RE-VALIDATION. {checkUpkeep} runs OFF-CHAIN and its result is STALE by the time
///         {performUpkeep} lands (periods advance, subscriptions get renewed by other callers, statuses
///         change). Per Chainlink's own guidance the perform input is UNTRUSTED, so {performUpkeep}
///         re-checks {isDue} against live state for every decoded id and skips any that is no longer due
///         — never relying on the off-chain snapshot.
///
///         UPGRADEABILITY (the Access0x1 UUPS TEMPLATE — every system contract follows this exact
///         shape): deployed behind an `ERC1967Proxy`; storage in the proxy, logic in this implementation.
///         State is set once via {initialize} (`initializer`-guarded); the implementation's own
///         constructor calls `_disableInitializers()` so the logic contract can never be initialized or
///         hijacked directly. Upgrades route through {upgradeToAndCall}, authorized by {_authorizeUpgrade}
///         (`Ownable2Step` owner-only — the upgrade admin, which holds NO authority over any renewal:
///         the owner cannot force, block, or redirect a charge). `renounceOwnership()` permanently
///         freezes the implementation. A trailing `__gap` reserves slots for safe future storage appends.
contract AutomationGateway is
    IAutomationGateway,
    AutomationCompatibleInterface,
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable
{
    using EnumerableSet for EnumerableSet.UintSet;

    /// @notice The maximum number of watched ids the off-chain {checkUpkeep} scan reads in one pass.
    ///         Caps the simulation's work so it stays gas-sane even with a large registry; ids beyond
    ///         this index are simply checked on a later round (the set order rotates as ids are removed).
    uint256 public constant MAX_SCAN = 50;

    /// @notice The maximum number of due ids {checkUpkeep} returns and {performUpkeep} renews in one
    ///         upkeep. Bounds the on-chain perform gas to a constant ceiling regardless of registry size.
    uint256 public constant MAX_BATCH = 50;

    /// @notice The Access0x1Subscriptions contract every renewal is poked through. Bound ONCE in
    ///         {initialize} and never repointed (no setter) — the gateway is permanently tied to one
    ///         Subscriptions deployment, so a registered upkeep can never be silently redirected.
    /// @dev    Plain storage, not `immutable`: an upgradeable contract reads state from the proxy, while
    ///         an `immutable` lives in the implementation bytecode. Effectively immutable per proxy.
    IAccess0x1Subscriptions public subscriptionsContract;

    /// @notice The enumerable set of subscription ids watched for automated renewal. An `EnumerableSet`
    ///         gives O(1) add/remove/contains plus the indexed enumeration {checkUpkeep} pages over.
    EnumerableSet.UintSet private _watched;

    /// @dev The implementation is the logic half of a UUPS pair; its OWN storage is never used in
    ///      production (the proxy holds state). `_disableInitializers()` burns the implementation's
    ///      initializer so it can never be initialized — and therefore never owned or upgraded —
    ///      directly, closing the classic uninitialized-implementation takeover. Runs at
    ///      implementation-deploy time.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time initializer — the constructor-replacement for the proxy. Wires the upgrade-admin
    ///         owner + the two-step machinery, then binds the Subscriptions contract this gateway pokes.
    ///         Guarded by `initializer`, so it runs exactly once per proxy; the typical deploy is
    ///         `new ERC1967Proxy(impl, abi.encodeCall(initialize, (owner, subs)))`.
    /// @dev    No `__UUPSUpgradeable_init()` / `__ReentrancyGuard_init()` — in OZ 5.x those bases hold no
    ///         initializable storage. No reentrancy guard is needed: the gateway holds no funds and makes
    ///         no value transfer of its own; {renew} carries its OWN `nonReentrant` + CEI on the money
    ///         path, and the registry writes here are pure set ops with no external call between them.
    /// @param initialOwner    The contract owner / upgrade admin (non-zero; `__Ownable_init` reverts on
    ///                        zero). Holds NO authority over any renewal — only the upgrade gate.
    /// @param subscriptions_  The deployed {Access0x1Subscriptions} to renew against (non-zero).
    function initialize(address initialOwner, IAccess0x1Subscriptions subscriptions_)
        external
        initializer
    {
        if (address(subscriptions_) == address(0)) revert AutomationGateway__ZeroAddress();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        subscriptionsContract = subscriptions_;
    }

    /*//////////////////////////////////////////////////////////////
                                REGISTRY
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAutomationGateway
    /// @dev PERMISSIONLESS. `EnumerableSet.add` returns false (and we skip the event) when the id is
    ///      already watched, so a re-register is a clean no-op. No validation of the id against the
    ///      Subscriptions record is needed or wanted: an invalid/foreign/terminal id can only ever be
    ///      poked via the self-guarding {renew}, which simply never charges it — gating registration
    ///      would add a trust seam (and an external call) for zero safety benefit.
    function register(uint256 subId) external {
        if (_watched.add(subId)) {
            emit Registered(subId, msg.sender);
        }
    }

    /// @inheritdoc IAutomationGateway
    /// @dev PERMISSIONLESS + idempotent. `EnumerableSet.remove` returns false (and we skip the event)
    ///      when the id was not watched. Permissionless removal is safe: the registry confers no
    ///      authority, so dropping an id only removes it from the convenience index — the subscription
    ///      is untouched and can still be renewed directly or re-registered by anyone.
    function deregister(uint256 subId) external {
        if (_watched.remove(subId)) {
            emit Deregistered(subId, msg.sender);
        }
    }

    /*//////////////////////////////////////////////////////////////
                               AUTOMATION
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAutomationGateway
    /// @dev Off-chain simulation. Scans at most {MAX_SCAN} watched ids, collects the DUE ones (capped at
    ///      {MAX_BATCH}) into a right-sized array, and abi-encodes it into `performData`. Bounded on both
    ///      the scan and the batch so the simulation never grows unbounded with the registry. `checkData`
    ///      is ignored — this gateway watches one shared registry, not per-upkeep slices.
    ///      `AutomationCompatibleInterface.checkUpkeep` is non-`view` by spec (keepers simulate it), but
    ///      this implementation only reads state.
    function checkUpkeep(
        bytes calldata /* checkData */
    )
        external
        view
        override(IAutomationGateway, AutomationCompatibleInterface)
        returns (bool upkeepNeeded, bytes memory performData)
    {
        uint256 total = _watched.length();
        uint256 scan = total < MAX_SCAN ? total : MAX_SCAN;

        // First pass: count the due ids within the scan window (capped at MAX_BATCH) so the result
        // array is allocated EXACTLY the right length — a Chainlink registry rejects trailing zero
        // padding as extra ids, and an oversized array wastes perform gas.
        uint256 dueCount;
        for (uint256 i = 0; i < scan; ++i) {
            if (isDue(_watched.at(i))) {
                unchecked {
                    ++dueCount;
                }
                if (dueCount == MAX_BATCH) break;
            }
        }

        uint256[] memory dueIds = new uint256[](dueCount);
        // Second pass: fill the array with the same ids (identical predicate + scan window in the same
        // simulation, so the two passes see the same state and agree exactly).
        uint256 w;
        for (uint256 i = 0; i < scan && w < dueCount; ++i) {
            uint256 id = _watched.at(i);
            if (isDue(id)) {
                dueIds[w] = id;
                unchecked {
                    ++w;
                }
            }
        }

        upkeepNeeded = dueCount > 0;
        performData = abi.encode(dueIds);
    }

    /// @inheritdoc IAutomationGateway
    /// @dev On-chain execution. PERMISSIONLESS + input-UNTRUSTED (Chainlink guarantees nothing about the
    ///      `performData`, so it is re-validated, never trusted). For each decoded id: re-check {isDue}
    ///      against LIVE state (the off-chain {checkUpkeep} is stale by now — periods advance, other
    ///      callers renew, statuses change) and skip any that is no longer due; then call the
    ///      permissionless {renew} inside a try/catch so a SYSTEM-side revert (router paused / oracle
    ///      stale / sequencer down — which {Access0x1Subscriptions.renew} deliberately re-reverts) on one
    ///      id can never block the rest of the batch. A subscriber-attributable failure does NOT revert
    ///      {renew} (it duns and returns 0), so that path lands in the success branch with `chargedToken
    ///      == 0`. The decoded length is capped at {MAX_BATCH} so a malicious caller cannot pass an
    ///      oversized array to grief the perform gas.
    function performUpkeep(bytes calldata performData)
        external
        override(IAutomationGateway, AutomationCompatibleInterface)
    {
        uint256[] memory ids = abi.decode(performData, (uint256[]));
        uint256 n = ids.length < MAX_BATCH ? ids.length : MAX_BATCH;

        IAccess0x1Subscriptions subs = subscriptionsContract;
        for (uint256 i = 0; i < n; ++i) {
            uint256 subId = ids[i];
            // Re-validate against live state: the off-chain snapshot is stale, so skip anything not
            // currently due (already renewed, became terminal, or never was due). This also makes
            // {renew}'s hard reverts (NotDue / NotRenewable / SubUnknown) unreachable for in-set ids,
            // leaving only genuine system-side reverts to land in the catch.
            if (!isDue(subId)) continue;

            try subs.renew(subId) returns (uint256 chargedToken) {
                emit Renewed(subId, chargedToken);
            } catch (bytes memory err) {
                // System-side failure (router paused / oracle stale / sequencer down) that {renew}
                // re-reverts for a later retry. Isolate it so the batch continues; the upkeep retries
                // this id next round once the infrastructure recovers.
                emit RenewFailed(subId, err);
            }
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAutomationGateway
    function subscriptions() external view returns (address) {
        return address(subscriptionsContract);
    }

    /// @inheritdoc IAutomationGateway
    function isWatched(uint256 subId) external view returns (bool) {
        return _watched.contains(subId);
    }

    /// @inheritdoc IAutomationGateway
    function watchedCount() external view returns (uint256) {
        return _watched.length();
    }

    /// @inheritdoc IAutomationGateway
    function watchedAt(uint256 index) external view returns (uint256 subId) {
        return _watched.at(index);
    }

    /// @inheritdoc IAutomationGateway
    /// @dev The single due-ness predicate {checkUpkeep} collects on and {performUpkeep} re-validates
    ///      against — mirrors {Access0x1Subscriptions.renew}'s own gate EXACTLY so a {performUpkeep}
    ///      that passes this check cannot then hit {renew}'s NotDue / NotRenewable / SubUnknown reverts:
    ///        - status NONE       → the id was never a subscription (SubUnknown) → NOT due.
    ///        - status UNPAID/CANCELED → terminal, {renew} reverts NotRenewable → NOT due.
    ///        - status TRIALING/ACTIVE/PAST_DUE → renewable; due iff the period has ended.
    ///      Reading the full {subs} struct is one external view; the predicate is pure on its result.
    function isDue(uint256 subId) public view returns (bool due) {
        IAccess0x1Subscriptions.Subscription memory s = subscriptionsContract.subs(subId);
        IAccess0x1Subscriptions.SubStatus status = s.status;

        // Not renewable: unknown (never opened) or terminal (UNPAID / CANCELED).
        if (
            status == IAccess0x1Subscriptions.SubStatus.NONE
                || status == IAccess0x1Subscriptions.SubStatus.UNPAID
                || status == IAccess0x1Subscriptions.SubStatus.CANCELED
        ) {
            return false;
        }
        // Renewable (TRIALING / ACTIVE / PAST_DUE): due once the current period has ended. Mirrors
        // {renew}'s `block.timestamp < periodEnd` revert — due at the exact `periodEnd` second.
        return block.timestamp >= s.periodEnd;
    }

    /// @notice ERC-165 introspection: advertises the gateway interface, the Chainlink
    ///         `AutomationCompatibleInterface`, and ERC-165 itself, so an integrator (or a Chainlink
    ///         registry tool) can discover the contract's surface without an ABI probe.
    /// @param interfaceId The 4-byte interface identifier being queried.
    /// @return True iff `interfaceId` is {IAutomationGateway}, {AutomationCompatibleInterface}, or
    ///         {IERC165}.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IAutomationGateway).interfaceId
            || interfaceId == type(AutomationCompatibleInterface).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    /// @notice Authorize a UUPS upgrade. Restricted to the contract `owner` (the upgrade admin) — the
    ///         single gate {upgradeToAndCall} consults before swapping the implementation.
    /// @dev    Empty body: the `onlyOwner` modifier IS the policy. Once `renounceOwnership()` sets the
    ///         owner to address(0), every call here reverts, so the implementation becomes permanently
    ///         immutable. `newImplementation` is intentionally unnamed — the owner is trusted to vet the
    ///         target off-chain; the gateway holds no funds, so an upgrade risks no custody.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }

    /// @dev Reserved storage slots so future versions can APPEND new state without shifting the layout
    ///      above (UUPS storage-collision safety). Each new variable added in a later version consumes one
    ///      slot from the head of this gap; shrink `__gap` by exactly the number of slots added so the
    ///      total stays 50. NEVER reorder or insert a variable above this gap — only append.
    uint256[50] private __gap;
}
