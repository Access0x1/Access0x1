// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title  ProxyDeployer
/// @author Access0x1
/// @notice The ONE reusable UUPS proxy-deploy helper every Access0x1 contract's test suite uses. Deploys
///         an `ERC1967Proxy` in front of an already-deployed implementation and runs its initializer in
///         the same transaction, returning the proxy address. The caller casts that address to the
///         contract type and drives the proxy from then on — exactly how the contract is used in
///         production (storage in the proxy, logic in the impl).
/// @dev    Inherit this in a test (`contract FooTest is Test, ProxyDeployer`) and call:
///           address impl  = address(new Foo());                       // the logic contract
///           address proxy = deployProxy(impl, abi.encodeCall(Foo.initialize, (..args..)));
///           Foo foo       = Foo(proxy);                               // cast + drive the proxy
///         `initCalldata` is the ABI-encoded `initialize(...)` call (use `abi.encodeCall` for type
///         safety); pass `""` only for an implementation with no initializer. The deployed implementation
///         must have run `_disableInitializers()` in its constructor so it cannot be initialized directly.
abstract contract ProxyDeployer {
    /// @notice Deploy an `ERC1967Proxy` pointing at `impl` and atomically run `initCalldata` against it.
    /// @param impl         The already-deployed implementation (logic) contract address.
    /// @param initCalldata The ABI-encoded initializer call to run on the proxy (e.g.
    ///                     `abi.encodeCall(C.initialize, (..))`); `""` to skip initialization.
    /// @return proxy The deployed `ERC1967Proxy` address — cast it to the contract type to use it.
    function deployProxy(address impl, bytes memory initCalldata) internal returns (address proxy) {
        return address(new ERC1967Proxy(impl, initCalldata));
    }
}
