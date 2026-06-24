// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Vm } from "forge-std/Vm.sol";

/// @title  CreateXEtch
/// @author Access0x1
/// @notice Makes the canonical CreateX factory available inside a LOCAL test EVM, so a test that runs
///         the production `DeployAll` (which deploys every contract via CreateX CREATE3) works without
///         forking a real chain. On a real chain — or a fork of one — CreateX already exists, so
///         {enable} is a no-op there (it only etches when the address is empty).
/// @dev    Test-only helper (lives under `test/`). The runtime bytecode is read from the committed
///         fixture `test/fixtures/createx.hex` (the exact bytecode `cast code` returns for CreateX on a
///         live chain) and etched at CreateX's canonical address. Call `CreateXEtch.enable(vm)` as the
///         first line of any test's `setUp` that stands the estate up through `DeployAll.run()`.
library CreateXEtch {
    /// @notice CreateX's canonical, cross-chain-constant address (pcaversaccio/createx).
    address internal constant CREATEX = 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed;

    /// @notice Etch CreateX's runtime bytecode at {CREATEX} when it is absent (a local EVM); a no-op on
    ///         a chain/fork where CreateX is already deployed.
    /// @param  vm The forge cheatcode handle (pass the test's `vm`).
    function enable(Vm vm) internal {
        if (CREATEX.code.length == 0) {
            vm.etch(CREATEX, vm.parseBytes(vm.readFile("test/fixtures/createx.hex")));
        }
    }
}
