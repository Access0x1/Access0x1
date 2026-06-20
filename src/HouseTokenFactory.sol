// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    Ownable2StepUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { HouseToken } from "./HouseToken.sol";
import { IHouseTokenFactory } from "./interfaces/IHouseTokenFactory.sol";

/// @title  HouseTokenFactory
/// @author Access0x1
/// @notice Non-custodial factory: a business deploys its OWN ERC-20 THROUGH Access0x1 and OWNS it in
///         its own wallet (loyalty / credit / closed-loop payments, settleable through the router) —
///         "their access onchain". The factory's whole job is to deploy a {HouseToken} whose ownership
///         AND full initial supply are assigned to a business-chosen address in the SAME tx. After
///         {deployHouseToken} returns, the factory has: no admin role on the token, no minter role, no
///         balance, no key. It only RECORDS provenance (a count + an `isHouseToken` flag) so the router
///         can trust where a house token came from.
/// @dev    ZERO CUSTODY over DEPLOYED TOKENS by construction, not by convention. {HouseToken}'s
///         constructor sets the owner to the caller's chosen `owner` (not `msg.sender`) and mints the
///         entire supply to that owner, so there is no window in which the factory holds either authority
///         or tokens over a token it deploys — the non-custody property is enforced inside the deployed
///         {HouseToken} (left IMMUTABLE — NOT upgradeable), which the factory cannot alter.
///
///         UPGRADEABILITY (the Access0x1 UUPS TEMPLATE — every system contract follows this exact shape):
///         the factory itself is deployed behind an `ERC1967Proxy`; its storage (the provenance ledger)
///         lives in the proxy, its logic in this implementation. The provenance counter + flag map are
///         the ONLY mutable state, so an upgrade can extend the factory's onboarding logic WITHOUT
///         re-deploying it or losing the record of every house token ever minted. The one new authority
///         this introduces is a single `Ownable2StepUpgradeable` owner — the UPGRADE ADMIN, whose sole
///         power is authorizing {upgradeToAndCall} via {_authorizeUpgrade}. That admin has NO power over
///         any deployed {HouseToken} (those remain owned by their businesses) and NO power inside
///         {deployHouseToken} (deploying stays permissionless — anyone may call it). State is set once via
///         {initialize} (the constructor-replacement, `initializer`-guarded); the implementation's own
///         constructor calls `_disableInitializers()` so the logic contract can never be initialized or
///         hijacked directly. Calling `renounceOwnership()` permanently freezes the implementation (no
///         owner ⇒ no authorized upgrade ⇒ immutable forever), restoring the original "nothing to
///         compromise" property. A trailing `__gap` reserves slots for safe future storage appends.
contract HouseTokenFactory is
    IHouseTokenFactory,
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable
{
    /// @inheritdoc IHouseTokenFactory
    uint256 public deployedCount;

    /// @notice token address ⇒ deployed-by-this-factory flag. Write-once on deploy, never cleared:
    ///         provenance is permanent. The factory cannot gain authority over a token by flipping it.
    mapping(address token => bool deployed) private _isHouseToken;

    // ─── DISCOVERABILITY INDEX (appended after the original layout; see the `__gap` shrink below) ───
    // Three on-chain indexes so a house token is fully discoverable without log-scraping: who owns it,
    // the global set, and a packed per-token record. All are written ONCE per token inside
    // {deployHouseToken}, alongside the original provenance writes, and never mutated afterwards.

    /// @notice owner ⇒ the house tokens it has deployed, in deploy order. Answers "which tokens does
    ///         business X own?" in one call — the index the bare `_isHouseToken` boolean could not.
    mapping(address owner => address[] tokens) private _tokensOf;

    /// @notice Global, deploy-ordered enumeration of every house token the factory has minted. Paged via
    ///         {allTokensLength} + {tokenAt}; its length tracks {deployedCount} exactly.
    address[] private _allTokens;

    /// @notice token ⇒ its {TokenRecord} (owner-at-deploy, deploy timestamp, deploy chain id). The
    ///         single-read provenance answer; a zeroed record means the token was never deployed here.
    mapping(address token => TokenRecord record) private _records;

    /// @dev Reserved storage slots so future versions can APPEND new state without shifting the layout
    ///      above (UUPS storage-collision safety). Each new variable added in a later version consumes
    ///      one slot from the head of this gap; shrink `__gap` by exactly the number of slots added so
    ///      the total stays 50. NEVER reorder or insert a variable above this gap — only append. SHRUNK
    ///      from 50 → 47: the three discoverability indexes above each consume one declaration slot
    ///      (`_tokensOf`, `_allTokens`, `_records` — a mapping/dynamic-array head is one slot; their
    ///      contents live in hashed/array regions outside this contiguous range), so 47 + 3 == 50.
    uint256[47] private __gap;

    /// @dev The implementation is the logic half of a UUPS pair; its OWN storage is never used in
    ///      production (the proxy holds state). `_disableInitializers()` burns the implementation's
    ///      initializer so it can never be initialized — and therefore never owned or upgraded — directly,
    ///      closing the classic uninitialized-implementation takeover. Runs at implementation-deploy time.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time initializer — the constructor-replacement for the proxy. Sets the contract
    ///         (upgrade-admin) owner. Guarded by `initializer`, so it runs exactly once per proxy; the
    ///         typical deploy is `new ERC1967Proxy(impl, abi.encodeCall(initialize, (initialOwner)))`.
    /// @dev    Wires the UUPS machinery via the OZ upgradeable bases: `Ownable` + its 2-step extension.
    ///         `initialOwner` becomes the UPGRADE ADMIN (the `Ownable2Step` owner) — its only power is
    ///         authorizing upgrades; it controls NOTHING about a deployed {HouseToken} and gates NOTHING
    ///         in {deployHouseToken} (deploying remains permissionless). Must be non-zero (`__Ownable_init`
    ///         reverts on the zero address). There is no other constructor-set state to migrate: the
    ///         provenance ledger (`deployedCount`, `_isHouseToken`) starts empty exactly as before.
    /// @param initialOwner The contract owner / upgrade admin (non-zero).
    function initialize(address initialOwner) external initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        // No `__UUPSUpgradeable_init()`: in OZ 5.x `UUPSUpgradeable` re-exports the non-upgradeable
        // contract (it holds no initializable storage), so there is no such initializer to call.
    }

    /// @inheritdoc IHouseTokenFactory
    function deployHouseToken(
        address owner,
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        uint256 initialSupply
    ) external returns (address token) {
        if (owner == address(0)) revert HouseTokenFactory__ZeroOwner();
        if (bytes(name).length == 0 || bytes(symbol).length == 0) {
            revert HouseTokenFactory__EmptyMetadata();
        }
        // Reject >18-decimal tokens: the router's USD quote() scales by the token's decimals, and a
        // token above 18 breaks that scaling (a money-path footgun). Refuse to mint one at the source.
        if (decimals > 18) revert HouseTokenFactory__BadDecimals(decimals);

        // Deploy the token. Its constructor assigns ownership + the full supply to `owner` — the
        // factory is `msg.sender` to the token but receives NO authority and NO balance.
        HouseToken deployed = new HouseToken(owner, name, symbol, decimals, initialSupply);
        token = address(deployed);

        // Record provenance + discoverability indexes. Effects before the event; no external call
        // follows, so ordering is CEI-clean and re-entrancy-irrelevant (the only external "call" is the
        // `new` deploy above, whose constructor cannot call back into a factory function that mutates
        // shared state in a harmful order — state below is independent per-token).
        _isHouseToken[token] = true;
        _tokensOf[owner].push(token); // owner ⇒ tokens (answers "which tokens does X own?")
        _allTokens.push(token); // global enumeration
        _records[token] = TokenRecord({
            owner: owner, deployedAt: uint64(block.timestamp), chainId: uint64(block.chainid)
        });
        unchecked {
            // deployedCount is bounded by the gas needed to deploy a full ERC-20 each call; it can
            // never realistically approach 2^256, so the increment cannot overflow.
            ++deployedCount;
        }

        emit Deployed(
            owner, token, msg.sender, name, symbol, decimals, initialSupply, block.chainid
        );
    }

    /// @inheritdoc IHouseTokenFactory
    function isHouseToken(address token) external view returns (bool) {
        return _isHouseToken[token];
    }

    /// @inheritdoc IHouseTokenFactory
    function tokensOf(address owner) external view returns (address[] memory tokens) {
        return _tokensOf[owner];
    }

    /// @inheritdoc IHouseTokenFactory
    function allTokensLength() external view returns (uint256) {
        return _allTokens.length;
    }

    /// @inheritdoc IHouseTokenFactory
    /// @dev Reverts on out-of-bounds via the array's own index check (no custom error needed — callers
    ///      bound `i` with {allTokensLength}).
    function tokenAt(uint256 i) external view returns (address) {
        return _allTokens[i];
    }

    /// @inheritdoc IHouseTokenFactory
    function tokenRecord(address token) external view returns (TokenRecord memory) {
        return _records[token];
    }

    /// @notice Authorize a UUPS upgrade. Restricted to the contract `owner` (the upgrade admin) — the
    ///         single gate {upgradeToAndCall} consults before swapping the implementation.
    /// @dev    Empty body: the `onlyOwner` modifier IS the policy. Once `renounceOwnership()` sets the
    ///         owner to address(0), every call here reverts, so the implementation becomes permanently
    ///         immutable (the on-chain "freeze"). `newImplementation` is intentionally unnamed — no
    ///         per-target allow-listing; the owner is fully trusted to vet the target off-chain.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }
}
