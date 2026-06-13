// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

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
/// @dev    ZERO CUSTODY by construction, not by convention. {HouseToken}'s constructor sets the owner
///         to the caller's chosen `owner` (not `msg.sender`) and mints the entire supply to that owner,
///         so there is no window in which the factory holds either authority or tokens — the
///         non-custody property is enforced inside the deployed token, which the factory cannot alter.
///         The factory has no owner, no admin functions, no upgradeability: nothing to compromise.
contract HouseTokenFactory is IHouseTokenFactory {
    /// @inheritdoc IHouseTokenFactory
    uint256 public deployedCount;

    /// @notice token address ⇒ deployed-by-this-factory flag. Write-once on deploy, never cleared:
    ///         provenance is permanent. The factory cannot gain authority over a token by flipping it.
    mapping(address token => bool deployed) private _isHouseToken;

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
}
