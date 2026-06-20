// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  ICreateX
/// @author Rensley R. @vyperpilleddev
/// @notice The minimal subset of the canonical CreateX factory
///         (`0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`, by pcaversaccio) that {DeployAll} needs for
///         MIRROR deployment — landing every Access0x1 contract at the SAME address on every chain.
/// @dev    Deploy-only helper (lives under `script/`, never in the contract surface). CreateX is the
///         third-party factory; this interface is our own, written to its public ABI. CREATE3 derives a
///         contract's address from the (guarded) salt and CreateX's own address ALONE — independent of
///         the init code — which is exactly why a chain-specific USDC/feed init (baked into a proxy's
///         constructor) does not move the mirror address. Both the implementation AND the proxy are
///         deployed with `deployCreate3`: the proxy carries its initializer in its constructor (OZ 5.x
///         `ERC1967Proxy` reverts `ERC1967ProxyUninitialized()` on empty data, and CREATE3 keeps the
///         address salt-only regardless), so no separate atomic-init call is needed. Salt-guard semantics
///         that make the address cross-chain-identical AND front-run-protected are documented at
///         {DeployAll-_mirrorSalt}.
interface ICreateX {
    /// @notice CREATE3-deploy `initCode` under `salt`. The deployed address is a function of the guarded
    ///         salt and CreateX's address only — NOT of `initCode` — so identical salts yield identical
    ///         addresses across chains even when the init code (e.g. a proxy's chain-specific init data)
    ///         differs.
    /// @param  salt        The raw (un-guarded) salt; CreateX applies its `_guard` internally.
    /// @param  initCode    The full creation code to deploy (a proxy includes its constructor init data).
    /// @return newContract The deployed contract address.
    function deployCreate3(bytes32 salt, bytes memory initCode)
        external
        payable
        returns (address newContract);

    /// @notice Predict the CREATE3 address for an ALREADY-GUARDED salt (the `deployer` defaults to
    ///         CreateX itself). For a mode-(b) permissioned raw salt, reproduce the guard first:
    ///         `keccak256(abi.encodePacked(bytes32(uint256(uint160(deployer))), rawSalt))`.
    /// @param  guardedSalt The post-guard salt.
    /// @return computedAddress The address the contract would (or did) deploy to.
    function computeCreate3Address(bytes32 guardedSalt)
        external
        view
        returns (address computedAddress);
}
