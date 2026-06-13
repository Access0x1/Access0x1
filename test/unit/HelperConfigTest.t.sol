// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { ChainRegistry } from "../../src/ChainRegistry.sol";

/// @notice The standalone `HelperConfig` unit suite (fund-me's `HelperConfigTest` port), focused on
///         the LOCAL (Anvil, chainId 31337) config path and its mock-redeploy semantics — the one gap
///         the branch-selection coverage in `DeployAll.t.sol` does not assert.
/// @dev    ENV-KEY OWNERSHIP (the race-safety convention documented in `DeployAll.t.sol`): Foundry
///         runs test contracts in PARALLEL while `vm.setEnv` mutates the shared OS process env with no
///         per-test rollback, so every FIXED env key must be owned by exactly ONE test FUNCTION across
///         the whole repo. `DeployAll.t.sol` already owns every `ARC_*`, `BASE_SEPOLIA_*`,
///         `ZKSYNC_SEPOLIA_*`, the generic `PLATFORM_TREASURY`, `DEPLOY_PAYMENT_LANES` and
///         `ROUTER_OWNER` key. This file therefore deliberately exercises ONLY the local branch, which
///         reads NO env at all (it deploys fresh mocks in-broadcast) — so it is provably race-free and
///         collides with no other suite. The live/testnet branch selection + the fail-loud
///         missing-treasury revert are owned by `DeployAll.t.sol` and are not duplicated here.
contract HelperConfigTest is Test {
    /// @notice The chain id of a local Anvil/Foundry node (mirrors HelperConfig's internal constant).
    uint256 internal constant LOCAL_CHAIN_ID = 31_337;

    /// @notice Default platform fee when no `*_PLATFORM_FEE_BPS` is set (mirrors HelperConfig).
    uint16 internal constant DEFAULT_PLATFORM_FEE_BPS = 100;

    function setUp() public {
        vm.chainId(LOCAL_CHAIN_ID); // pin the local branch for every test in this suite
    }

    /// @notice SELECTION: on chainId 31337 the constructor takes the local branch and deploys live
    ///         mock feeds + a mock USDC + a ChainRegistry, so every config field is a real, non-zero,
    ///         wired address — never a placeholder zero, never read from env.
    function test_localConfig_deploysFullyWiredMocks() public {
        HelperConfig.NetworkConfig memory cfg = new HelperConfig().getConfig();

        assertTrue(cfg.treasury != address(0), "treasury unset");
        assertEq(cfg.platformFeeBps, DEFAULT_PLATFORM_FEE_BPS, "fee not the local default");
        assertTrue(cfg.nativeUsdFeed != address(0), "native feed unset");
        assertTrue(cfg.usdc != address(0), "usdc unset");
        assertTrue(cfg.usdcUsdFeed != address(0), "usdc feed unset");
        assertTrue(cfg.chainRegistry != address(0), "chainRegistry unset");

        // The deployed addresses are real contracts (have code), not EOAs / dead placeholders.
        assertGt(cfg.nativeUsdFeed.code.length, 0, "native feed has no code");
        assertGt(cfg.usdc.code.length, 0, "usdc has no code");
        assertGt(cfg.usdcUsdFeed.code.length, 0, "usdc feed has no code");
        assertGt(cfg.chainRegistry.code.length, 0, "chainRegistry has no code");
    }

    /// @notice SEMANTICS: the local mock path is NOT cached — each `new HelperConfig()` deploys a
    ///         FRESH set of mocks at DIFFERENT addresses. This documents the redeploy behaviour (gap
    ///         #7): a test that wants a STABLE mock must reuse ONE HelperConfig instance, never
    ///         construct a second and assume the same mock. Asserting this pins the contract so a
    ///         future "add caching" change is a deliberate, test-visible decision rather than silent
    ///         drift. Both feeds, the USDC, and the registry are independently re-deployed.
    function test_localConfig_isNotCached_eachConstructionRedeploysMocks() public {
        HelperConfig.NetworkConfig memory first = new HelperConfig().getConfig();
        HelperConfig.NetworkConfig memory second = new HelperConfig().getConfig();

        assertTrue(first.usdc != second.usdc, "usdc unexpectedly cached");
        assertTrue(first.nativeUsdFeed != second.nativeUsdFeed, "native feed unexpectedly cached");
        assertTrue(first.usdcUsdFeed != second.usdcUsdFeed, "usdc feed unexpectedly cached");
        assertTrue(first.chainRegistry != second.chainRegistry, "chainRegistry unexpectedly cached");

        // Both generations are nonetheless fully valid configs (so neither leaks a stale half-wire).
        assertGt(first.usdc.code.length, 0);
        assertGt(second.usdc.code.length, 0);
    }

    /// @notice CACHING WITHIN ONE INSTANCE: `getConfig()` reads the stored `activeConfig` resolved at
    ///         construction, so calling it repeatedly on the SAME instance returns identical addresses
    ///         and never re-runs the mock deploy. This is the idempotent read the deploy script + the
    ///         frontend rely on (one source of truth per HelperConfig).
    function test_localConfig_getConfigIsStableOnOneInstance() public {
        HelperConfig hc = new HelperConfig();
        HelperConfig.NetworkConfig memory a = hc.getConfig();
        HelperConfig.NetworkConfig memory b = hc.getConfig();

        assertEq(a.treasury, b.treasury);
        assertEq(a.platformFeeBps, b.platformFeeBps);
        assertEq(a.nativeUsdFeed, b.nativeUsdFeed);
        assertEq(a.usdc, b.usdc);
        assertEq(a.usdcUsdFeed, b.usdcUsdFeed);
        assertEq(a.chainRegistry, b.chainRegistry);
    }

    /// @notice The local ChainRegistry mock is a usable, owned contract (owner = the deploy sender),
    ///         not a bare placeholder — so the local flow can drive the SDK/cross-chain read path
    ///         end-to-end with no RPC. Proves the local branch wires a REAL registry, not address(0).
    function test_localConfig_chainRegistryIsOwnedContract() public {
        HelperConfig.NetworkConfig memory cfg = new HelperConfig().getConfig();
        ChainRegistry registry = ChainRegistry(cfg.chainRegistry);
        // owner() must not revert and must be a real address (the in-broadcast sender).
        assertTrue(registry.owner() != address(0), "registry has no owner");
    }
}
