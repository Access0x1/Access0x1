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

    /// @dev Reserved storage slots so future versions can APPEND new state without shifting the layout
    ///      above (UUPS storage-collision safety). Each new variable added in a later version consumes
    ///      one slot from the head of this gap; shrink `__gap` by exactly the number of slots added so
    ///      the total stays 50. NEVER reorder or insert a variable above this gap — only append.
    uint256[50] private __gap;

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

        // Deploy the token. Its constructor assigns ownership + the full supply to `owner` — the
        // factory is `msg.sender` to the token but receives NO authority and NO balance.
        HouseToken deployed = new HouseToken(owner, name, symbol, decimals, initialSupply);
        token = address(deployed);

        // Record provenance only. Effects before the event; no external call follows, so ordering is
        // CEI-clean and re-entrancy-irrelevant (the only external "call" is the `new` deploy above,
        // whose constructor cannot call back into a factory function that mutates shared state in a
        // harmful order — state below is independent per-token).
        _isHouseToken[token] = true;
        unchecked {
            // deployedCount is bounded by the gas needed to deploy a full ERC-20 each call; it can
            // never realistically approach 2^256, so the increment cannot overflow.
            ++deployedCount;
        }

        emit Deployed(owner, token, msg.sender, name, symbol, initialSupply);
    }

    /// @inheritdoc IHouseTokenFactory
    function isHouseToken(address token) external view returns (bool) {
        return _isHouseToken[token];
    }

    /// @notice Authorize a UUPS upgrade. Restricted to the contract `owner` (the upgrade admin) — the
    ///         single gate {upgradeToAndCall} consults before swapping the implementation.
    /// @dev    Empty body: the `onlyOwner` modifier IS the policy. Once `renounceOwnership()` sets the
    ///         owner to address(0), every call here reverts, so the implementation becomes permanently
    ///         immutable (the on-chain "freeze"). `newImplementation` is intentionally unnamed — no
    ///         per-target allow-listing; the owner is fully trusted to vet the target off-chain.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }
}
