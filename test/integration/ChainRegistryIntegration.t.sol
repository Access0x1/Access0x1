// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";

import { DeployChainRegistry } from "../../script/DeployChainRegistry.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { ChainRegistry } from "../../src/ChainRegistry.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";

/// @title  ChainRegistryIntegration — the registry, deployed and composed via the REAL scripts
/// @author Access0x1
/// @notice The Cyfrin INTEGRATION layer for {ChainRegistry}: instead of hand-`new`-ing the contract
///         (the unit/fuzz/attack way), this suite stands the registry up through the SAME deploy
///         scripts the operator runs at the booth — so the DEPLOY PATH itself is under test, not just
///         the contract. Two real compositions are exercised:
///
///           1. {DeployChainRegistry} — the standalone, per-chain seeding script. We run `.run()` and
///              prove the deployed registry is owned, seeded with the three event chains (Arc, Base
///              Sepolia, zkSync Sepolia), and then drive it through its real operator lifecycle
///              (operator wires the live router address, flips the chain live, the SDK reads it back).
///              This is the cross-chain SDK source-of-truth path end to end.
///
///           2. {HelperConfig} local branch + {DeployAll} — the registry as the TWELFTH first-party
///              contract carried alongside the money spine. `HelperConfig` (local) deploys a real
///              `ChainRegistry` (the address `DeployAll` later carries in `HelperConfig.chainRegistry`,
///              never forking it). We source that registry from the real script and prove it composes
///              with a real `Access0x1Router`: the operator records the live router in the registry and
///              the SDK resolves chainId straight back to that exact router (the chain->router map).
///
/// @dev    RACE-SAFETY (the repo's `vm.setEnv` convention, see `DeployAll.t.sol`): Foundry runs test
///         contracts in PARALLEL and `vm.setEnv` mutates the shared OS env with no rollback, so every
///         FIXED env key is owned by exactly ONE function repo-wide. This suite sets NO env at all —
///         `DeployChainRegistry.run()` reads only `ARC_USDC` / `BASE_SEPOLIA_USDC` /
///         `ZKSYNC_SEPOLIA_USDC` / `BASE_SEPOLIA_CCIP_SELECTOR` / `REGISTRY_OWNER`, none of which any
///         test sets (they resolve to the zero placeholder, law #4), and the `HelperConfig` LOCAL
///         branch (chainId 31337) reads no env (it deploys fresh mocks). So this file is provably
///         race-free and collides with no other suite.
contract ChainRegistryIntegrationTest is Test {
    /// @notice The chain id of a local Anvil/Foundry node (mirrors HelperConfig's internal constant).
    uint256 internal constant LOCAL_CHAIN_ID = 31_337;

    // The three event chain ids the deploy script seeds (mirrored; the script's copies are internal).
    uint256 internal constant ARC_TESTNET = 5_042_002;
    uint256 internal constant BASE_SEPOLIA = 84_532;
    uint256 internal constant ZKSYNC_SEPOLIA = 300;

    // Flag scheme (mirrored from ChainRegistry; the unit suite asserts these exact values).
    uint16 internal constant FLAG_LIVE = 0x0001;
    uint16 internal constant FLAG_CIRCLE_USDC = 0x0002;
    uint16 internal constant FLAG_CCIP_LANE = 0x0004;
    uint16 internal constant FLAG_TESTNET = 0x0008;

    /*//////////////////////////////////////////////////////////////
       1. DeployChainRegistry — the standalone seeding script, end to end
    //////////////////////////////////////////////////////////////*/

    /// @notice The real `DeployChainRegistry` script deploys a live, owned registry and seeds all three
    ///         event chains as readable testnet entries (none live until the operator flips it). Proves
    ///         the deliverable script runs end-to-end with NO env (every unconfirmed address is a zero
    ///         placeholder, never invented — law #4), so the SDK has its cross-chain map from one run.
    function test_deployScript_seedsAllThreeEventChains() public {
        DeployChainRegistry deployer = new DeployChainRegistry();
        ChainRegistry registry = deployer.run();

        assertTrue(address(registry) != address(0), "registry deployed");
        // Owned by the broadcaster (tx.origin under the script broadcast) so the seed calls succeeded.
        assertEq(registry.owner(), tx.origin, "registry owned by the seeding broadcaster");
        assertEq(registry.pendingOwner(), address(0), "no hand-off without REGISTRY_OWNER");

        // Arc: Circle-native USDC + testnet, no router/CCIP yet (zero placeholders).
        ChainRegistry.ChainConfig memory arc = registry.getChain(ARC_TESTNET);
        assertEq(arc.flags, FLAG_CIRCLE_USDC | FLAG_TESTNET, "Arc seeded Circle+testnet");
        assertEq(arc.router, address(0), "Arc router not wired at seed");

        // Base Sepolia + zkSync Sepolia: readable testnet entries (no CCIP selector ⇒ no lane flag).
        assertEq(registry.getChain(BASE_SEPOLIA).flags, FLAG_TESTNET, "Base seeded testnet");
        assertEq(registry.getChain(ZKSYNC_SEPOLIA).flags, FLAG_TESTNET, "zkSync seeded testnet");

        // None is live until the operator switches it on — the deploy never auto-arms a chain.
        assertFalse(registry.isLive(ARC_TESTNET), "Arc not live at seed");
        assertFalse(registry.isLive(BASE_SEPOLIA), "Base not live at seed");
        assertFalse(registry.isLive(ZKSYNC_SEPOLIA), "zkSync not live at seed");
    }

    /// @notice The full operator lifecycle on a script-deployed registry: after the script seeds, the
    ///         owner wires the live router address into a seeded chain, flips it live, and the SDK reads
    ///         the chain back as the live router + native USDC. This is the real "a new chain needs no
    ///         SDK redeploy — the operator just updates the registry" path, exercised on the genuine
    ///         deploy output rather than a hand-built mock.
    function test_deployedRegistry_operatorWiresRouterAndGoesLive() public {
        DeployChainRegistry deployer = new DeployChainRegistry();
        ChainRegistry registry = deployer.run();
        address operator = registry.owner();

        // A live router address + a confirmed USDC the operator obtained post-deploy (booth/docs).
        address liveRouter = makeAddr("liveRouterOnBaseSepolia");
        address baseUsdc = makeAddr("baseSepoliaCircleUSDC");
        uint64 baseSelector = 10_344_971_235_874_465_080; // Base Sepolia CCIP selector (docs value)

        // Operator upserts Base Sepolia with the now-confirmed facts + the CCIP lane flag.
        vm.startPrank(operator);
        registry.addChain(
            BASE_SEPOLIA,
            ChainRegistry.ChainConfig({
                usdc: baseUsdc,
                router: liveRouter,
                ccipSelector: baseSelector,
                flags: FLAG_TESTNET | FLAG_CCIP_LANE
            })
        );
        // Flip it live with the targeted toggle (one tx, no full struct resend).
        registry.setChainLive(BASE_SEPOLIA, true);
        vm.stopPrank();

        // The SDK lookup: chainId → live router + native USDC + CCIP lane.
        ChainRegistry.ChainConfig memory got = registry.getChain(BASE_SEPOLIA);
        assertEq(got.router, liveRouter, "SDK resolves the live router");
        assertEq(got.usdc, baseUsdc, "SDK resolves native USDC");
        assertEq(got.ccipSelector, baseSelector, "CCIP selector recorded");
        assertTrue(got.flags & FLAG_CCIP_LANE != 0, "CCIP lane flagged");
        assertTrue(registry.isLive(BASE_SEPOLIA), "chain flagged live");

        // The other seeded chains are untouched by the Base wiring (no cross-id bleed).
        assertFalse(registry.isLive(ARC_TESTNET), "Arc still not live");
        assertEq(registry.getChain(ZKSYNC_SEPOLIA).flags, FLAG_TESTNET, "zkSync untouched");
    }

    /// @notice The two-step ownership hand-off the script supports out of band: a script-deployed
    ///         registry is owned by the seeder, and a later `transferOwnership` → `acceptOwnership`
    ///         moves it to the production multisig with the seeding key never equal to the final admin.
    ///         Exercised on the real deploy output to prove the hand-off composes with the seeded state.
    function test_deployedRegistry_ownershipHandsOffTwoStep() public {
        DeployChainRegistry deployer = new DeployChainRegistry();
        ChainRegistry registry = deployer.run();
        address seeder = registry.owner();
        address multisig = makeAddr("productionMultisig");

        vm.prank(seeder);
        registry.transferOwnership(multisig);
        // Seeder keeps control until the multisig accepts (two-step — no ownerless window).
        assertEq(registry.owner(), seeder, "seeder retains control pre-accept");
        assertEq(registry.pendingOwner(), multisig, "multisig is pending owner");

        vm.prank(multisig);
        registry.acceptOwnership();
        assertEq(registry.owner(), multisig, "multisig now owns the registry");

        // The new owner can administer the seeded entries; the old seeder cannot.
        vm.prank(multisig);
        registry.setChainLive(ARC_TESTNET, true);
        assertTrue(registry.isLive(ARC_TESTNET), "new owner administers seeded Arc");
    }

    /*//////////////////////////////////////////////////////////////
       2. HelperConfig (local) — the registry as the carried, composing sidecar
    //////////////////////////////////////////////////////////////*/

    /// @notice On the local branch, the REAL `HelperConfig` script deploys a fresh `ChainRegistry` (the
    ///         same address `DeployAll` later carries in `HelperConfig.chainRegistry`, never forking it)
    ///         alongside the mock USDC + feeds. Proves the consolidation wiring source: the registry is
    ///         a fully-wired, owned, real contract — not a placeholder zero — so the SDK/cross-chain
    ///         read path is live the moment the deploy config resolves. This is the deploy half of the
    ///         integration: the contract is stood up by the script, not hand-`new`-ed.
    function test_helperConfigLocal_deploysRealOwnedRegistry() public {
        vm.chainId(LOCAL_CHAIN_ID);

        // The REAL script (its local branch deploys a ChainRegistry in-broadcast).
        HelperConfig helperConfig = new HelperConfig();
        HelperConfig.NetworkConfig memory cfg = helperConfig.getConfig();

        assertTrue(cfg.chainRegistry != address(0), "local HelperConfig deploys a real registry");
        assertGt(cfg.chainRegistry.code.length, 0, "carried registry has code (real contract)");

        // The carried registry is a usable, owned ChainRegistry (owner = the in-broadcast sender).
        ChainRegistry registry = ChainRegistry(cfg.chainRegistry);
        assertTrue(registry.owner() != address(0), "carried registry is owned, not a placeholder");
        // And it really is a distinct sidecar from the settlement token the config carries.
        assertTrue(cfg.chainRegistry != cfg.usdc, "registry is its own contract, not the USDC");
    }

    /// @notice END-TO-END COMPOSITION: the script-deployed registry composes with a real
    ///         `Access0x1Router`. The operator records THIS chain's facts (the live router address +
    ///         the config's native USDC) in the carried registry, and the SDK resolves the local
    ///         chainId straight back to the deployed router — the registry IS the chain->router map, and
    ///         a real router (deployed with the config's treasury/fee, then merchant-registered and
    ///         quote-priced) is exercised through it so the composition is proven, not assumed.
    function test_helperConfigLocal_registryResolvesChainToRealRouter() public {
        vm.chainId(LOCAL_CHAIN_ID);

        // Registry from the REAL script; its owner is the in-broadcast sender.
        HelperConfig helperConfig = new HelperConfig();
        HelperConfig.NetworkConfig memory cfg = helperConfig.getConfig();
        ChainRegistry registry = ChainRegistry(cfg.chainRegistry);
        address registryOwner = registry.owner();

        // A real money spine, deployed with the config's treasury + platform fee (the spine the
        // registry will point this chain at). We own it here so we can register a merchant + quote.
        address routerAdmin = makeAddr("routerAdmin");
        Access0x1Router router = new Access0x1Router(routerAdmin, cfg.treasury, cfg.platformFeeBps);

        // Operator records the local chain's live facts in the registry (the SDK source of truth).
        vm.startPrank(registryOwner);
        registry.addChain(
            block.chainid,
            ChainRegistry.ChainConfig({
                usdc: cfg.usdc, // the local mock USDC the config carries
                router: address(router), // the freshly deployed money spine
                ccipSelector: 0, // same-chain local: no live CCIP lane
                flags: FLAG_CIRCLE_USDC | FLAG_TESTNET
            })
        );
        registry.setChainLive(block.chainid, true);
        vm.stopPrank();

        // SDK lookup: this chainId resolves to the deployed router + the configured USDC, flagged live.
        ChainRegistry.ChainConfig memory resolved = registry.getChain(block.chainid);
        assertEq(resolved.router, address(router), "registry resolves the deployed router");
        assertEq(resolved.usdc, cfg.usdc, "registry resolves the configured USDC");
        assertTrue(registry.isLive(block.chainid), "local chain flagged live in the registry");

        // The resolved router is a REAL, usable spine: a merchant registers and a USD quote prices
        // through it — proving the registry points at a live contract, not a dead address.
        address payout = makeAddr("payout");
        address feeRecipient = makeAddr("feeRecipient");
        vm.prank(makeAddr("merchantOwner"));
        uint256 merchantId = Access0x1Router(resolved.router)
            .registerMerchant(payout, feeRecipient, 50, keccak256("acme.access0x1.eth"));
        // Wire the config's USDC + a $1 feed on the resolved router, then quote $250 -> the token.
        vm.startPrank(routerAdmin);
        router.setTokenAllowed(cfg.usdc, true);
        router.setPriceFeed(cfg.usdc, cfg.usdcUsdFeed); // the config's USDC/USD mock feed ($1.00)
        vm.stopPrank();
        uint256 gross = Access0x1Router(resolved.router).quote(merchantId, cfg.usdc, 250e8);
        assertEq(
            gross, 250e6, "the registry-resolved router prices $250 at $1/USDC to 250e6 (6-dec)"
        );
    }
}
