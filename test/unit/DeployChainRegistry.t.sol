// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { DeployChainRegistry } from "../../script/DeployChainRegistry.s.sol";
import { ChainRegistry } from "../../src/ChainRegistry.sol";

/// @notice Proves `DeployChainRegistry` runs end-to-end (Anvil branch, no env) — it deploys the
///         registry and seeds the three testnet chains. The script is a deliverable, so it is
///         tested like every other unit. Unset env ⇒ zero placeholder addresses (law #4), which is
///         the asserted, expected behaviour here.
contract DeployChainRegistryTest is Test {
    uint256 internal constant ARC_TESTNET = 5_042_002;
    uint256 internal constant BASE_SEPOLIA = 84_532;
    uint256 internal constant ZKSYNC_SEPOLIA = 300;

    uint16 internal constant FLAG_CIRCLE_USDC = 0x0002;
    uint16 internal constant FLAG_TESTNET = 0x0008;
    // The reserved registration marker (bit 15) addChain always ORs into the stored flags word.
    uint16 internal constant FLAG_REGISTERED = 0x8000;

    function test_deployScript_deploysThenSeeds() public {
        DeployChainRegistry deployer = new DeployChainRegistry();
        ChainRegistry registry = deployer.run();

        // The registry is live and owned by the broadcaster (tx.origin under the script's broadcast),
        // which is what lets the in-script seed `addChain` calls succeed.
        assertTrue(address(registry) != address(0));
        assertEq(registry.owner(), tx.origin);
        // No env REGISTRY_OWNER ⇒ no hand-off ⇒ no pending owner.
        assertEq(registry.pendingOwner(), address(0));

        // Arc testnet seeded: Circle-native USDC + testnet flags; usdc is a zero placeholder
        // because ARC_USDC is unset in the test env (never invented).
        // Stored flags carry the registration marker addChain forces on, on top of the seed bits.
        ChainRegistry.ChainConfig memory arc = registry.getChain(ARC_TESTNET);
        assertEq(arc.flags, FLAG_CIRCLE_USDC | FLAG_TESTNET | FLAG_REGISTERED);
        assertEq(arc.usdc, address(0));
        assertEq(arc.router, address(0));

        // Base Sepolia + zkSync Sepolia seeded as testnet entries (readable, no revert).
        assertEq(registry.getChain(BASE_SEPOLIA).flags, FLAG_TESTNET | FLAG_REGISTERED);
        assertEq(registry.getChain(ZKSYNC_SEPOLIA).flags, FLAG_TESTNET | FLAG_REGISTERED);

        // None is live until the operator flips it on.
        assertFalse(registry.isLive(ARC_TESTNET));
        assertFalse(registry.isLive(BASE_SEPOLIA));
        assertFalse(registry.isLive(ZKSYNC_SEPOLIA));
    }
}
