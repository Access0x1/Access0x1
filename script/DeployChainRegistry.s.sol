// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { ChainRegistry } from "../src/ChainRegistry.sol";

/// @title  DeployChainRegistry
/// @author Access0x1
/// @notice Deploys the `ChainRegistry` sidecar and seeds the three event chains (Arc testnet, Base
///         Sepolia, zkSync Sepolia). Every USDC address and CCIP selector is read from the
///         ENVIRONMENT, defaulting to `address(0)` / `0` when unset — so a value that has not been
///         confirmed at the sponsor booth or in the official docs (law #4) ships as a zero
///         placeholder, never a guess. The operator fills the env vars once confirmed and re-seeds.
/// @dev    Keystore-only signing: `vm.startBroadcast()` uses the `--account`/`--sender` (or
///         `--private-key`) passed on the CLI — NO key is read from source (security.md). Run:
///           forge script script/DeployChainRegistry.s.sol \
///             --rpc-url $ARC_TESTNET_RPC_URL --account deployer --broadcast
///         TESTNET ONLY for the seeded ids; mainnet entries are an owner-run, post-event step.
contract DeployChainRegistry is Script {
    /// @notice Flag bits, mirrored from `ChainRegistry` (its copies are internal). Kept in sync by
    ///         the suite; values are asserted in `ChainRegistry.t.sol::test_constants_flagValues`.
    uint16 internal constant FLAG_CIRCLE_USDC = 0x0002;
    uint16 internal constant FLAG_CCIP_LANE = 0x0004;
    uint16 internal constant FLAG_TESTNET = 0x0008;

    /// @notice Arc testnet — USDC is the native 18-decimal gas token; Circle-native; no Arc CCIP
    ///         lane confirmed (selector 0). TESTNET ONLY.
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5_042_002;

    /// @notice Base Sepolia — standard 6-decimal ERC-20 USDC; a CCIP lane exists (selector from
    ///         docs.chain.link/ccip/directory/testnet, supplied via env). TESTNET ONLY.
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84_532;

    /// @notice zkSync Sepolia — no CCIP lane, no App Kit Bridge (classic swap rail off-router).
    ///         TESTNET ONLY.
    uint256 internal constant ZKSYNC_SEPOLIA_CHAIN_ID = 300;

    /// @notice Deploy the registry and seed the three testnet chains from env, then (optionally) hand
    ///         ownership to `REGISTRY_OWNER`. Returns the live registry.
    /// @dev    The registry is deployed owned by the BROADCASTER so the owner-only seed `addChain`
    ///         calls succeed in the same tx. If `REGISTRY_OWNER` is set and differs, ownership is
    ///         then `transferOwnership`'d to it; that target must `acceptOwnership` (Ownable2Step) as
    ///         a deliberate, owner-signed follow-up — exactly like the router's deploy/configure
    ///         split, so the seeding key never has to equal the final admin.
    /// @return registry The deployed `ChainRegistry`.
    function run() external returns (ChainRegistry registry) {
        // Booth/docs-confirmed values, env-sourced; unset ⇒ zero placeholder (NEVER invented).
        address arcUsdc = vm.envOr("ARC_USDC", address(0));
        address baseUsdc = vm.envOr("BASE_SEPOLIA_USDC", address(0));
        address zksyncUsdc = vm.envOr("ZKSYNC_SEPOLIA_USDC", address(0));
        uint64 baseCcipSelector = uint64(vm.envOr("BASE_SEPOLIA_CCIP_SELECTOR", uint256(0)));
        address finalOwner = vm.envOr("REGISTRY_OWNER", address(0));

        vm.startBroadcast();
        // Owned by the broadcaster so it can seed; tx.origin is the broadcast signer under both a
        // live `--account` run and a `forge script` / test broadcast.
        address seeder = tx.origin;
        registry = new ChainRegistry(seeder);

        // Arc testnet: Circle-native USDC (native gas), testnet. No router/CCIP yet (zeros).
        registry.addChain(
            ARC_TESTNET_CHAIN_ID,
            ChainRegistry.ChainConfig({
                usdc: arcUsdc,
                router: address(0),
                ccipSelector: 0,
                flags: FLAG_CIRCLE_USDC | FLAG_TESTNET
            })
        );

        // Base Sepolia: standard USDC + CCIP lane flagged only when a selector is supplied.
        registry.addChain(
            BASE_SEPOLIA_CHAIN_ID,
            ChainRegistry.ChainConfig({
                usdc: baseUsdc,
                router: address(0),
                ccipSelector: baseCcipSelector,
                flags: baseCcipSelector != 0 ? (FLAG_CCIP_LANE | FLAG_TESTNET) : FLAG_TESTNET
            })
        );

        // zkSync Sepolia: no CCIP lane, no bridge — testnet flag only.
        registry.addChain(
            ZKSYNC_SEPOLIA_CHAIN_ID,
            ChainRegistry.ChainConfig({
                usdc: zksyncUsdc, router: address(0), ccipSelector: 0, flags: FLAG_TESTNET
            })
        );

        // Hand off to the intended admin (a multisig in production) if one was named and it differs
        // from the seeder. Two-step: the target must `acceptOwnership` afterwards.
        if (finalOwner != address(0) && finalOwner != seeder) {
            registry.transferOwnership(finalOwner);
        }
        vm.stopBroadcast();

        console2.log("ChainRegistry deployed:", address(registry));
        console2.log("  seeder/owner:    ", seeder);
        console2.log("  pending owner:   ", registry.pendingOwner());
        console2.log("  arc usdc:        ", arcUsdc);
        console2.log("  base usdc:       ", baseUsdc);
        console2.log("  base ccip sel:   ", baseCcipSelector);
        console2.log("  zksync usdc:     ", zksyncUsdc);

        return registry;
    }
}
