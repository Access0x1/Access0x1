// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { DeployAll } from "../../script/DeployAll.s.sol";
import { DeployAccess0x1Router } from "../../script/DeployAccess0x1Router.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";

/// @notice deploy-multichain unit suite. Two halves:
///         (1) HelperConfig per-chain branch selection — `vm.chainId` forces each branch and proves
///             it reads its OWN prefixed env (never another chain's values), with the local + generic
///             catch-all preserved; and
///         (2) the DeployAll orchestrator on local Anvil — router deployed + configured in one run,
///             optional lanes wiring gated on `DEPLOY_PAYMENT_LANES`, address(0) feeds skipped, and
///             the constructor revert paths (zero treasury, fee-too-high) surfacing loudly.
/// @dev    The script reads env at HelperConfig CONSTRUCTION, and Foundry runs a contract's tests in
///         PARALLEL while `vm.setEnv` mutates the shared OS process env (no per-test rollback). To stay
///         deterministic under any thread schedule, each FIXED env key is owned by exactly ONE test
///         function — statements inside a function are sequential, so set→read is race-free, and no two
///         functions ever write the same key. (Splitting one assertion per function would re-introduce
///         the race on the shared key; grouping per chain is the safe shape, not test-bundling for its
///         own sake.)
///
///         Owner-default invariant: in a real `forge script --sender $DEPLOYER` run, `msg.sender`
///         inside `run()` equals the broadcaster, so `owner` (defaulting to `msg.sender`) can sign the
///         `onlyOwner` configure calls. Under a unit-test `vm.startBroadcast()` the broadcaster is the
///         default sender while `run()`'s `msg.sender` is the test contract — so the tests pin
///         `ROUTER_OWNER` to the broadcaster to reproduce the real-run match.
contract DeployAllTest is Test {
    // Chain ids mirrored from HelperConfig (those constants are `internal`).
    uint256 internal constant ARC = 5_042_002;
    uint256 internal constant BASE_SEPOLIA = 84_532;
    uint256 internal constant ZKSYNC_SEPOLIA = 300;
    uint256 internal constant LOCAL = 31_337;

    /// @dev Foundry's broadcast default sender — the address `vm.startBroadcast()` (no arg) pranks as.
    address internal constant BROADCASTER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    address internal treasury = makeAddr("treasury");
    address internal nativeFeed = makeAddr("nativeFeed");
    address internal usdc = makeAddr("usdc");
    address internal usdcFeed = makeAddr("usdcFeed");

    /// @dev Pin the router owner to the broadcaster so the in-broadcast configure calls are authorized
    ///      (reproduces the `--sender $DEPLOYER` real-run match where owner defaults to the signer).
    function _ownerIsBroadcaster() internal {
        vm.setEnv("ROUTER_OWNER", vm.toString(BROADCASTER));
    }

    /*//////////////////////////////////////////////////////////////
        HELPERCONFIG BRANCH SELECTION — one fn per chain (env owner)
    //////////////////////////////////////////////////////////////*/

    /// @dev Owns every `ARC_*` env key. Selection (all fields) + the zero-feeds-allowed case.
    function test_helperConfig_arcTestnet_branch() public {
        vm.chainId(ARC);
        vm.setEnv("ARC_PLATFORM_TREASURY", vm.toString(treasury));
        vm.setEnv("ARC_PLATFORM_FEE_BPS", "250");
        vm.setEnv("ARC_NATIVE_USD_FEED", vm.toString(nativeFeed));
        vm.setEnv("ARC_USDC_ADDRESS", vm.toString(usdc));
        vm.setEnv("ARC_USDC_USD_FEED", vm.toString(usdcFeed));

        HelperConfig.NetworkConfig memory cfg = new HelperConfig().getConfig();
        assertEq(cfg.treasury, treasury);
        assertEq(cfg.platformFeeBps, 250); // reads ARC_, not the default
        assertEq(cfg.nativeUsdFeed, nativeFeed);
        assertEq(cfg.usdc, usdc);
        assertEq(cfg.usdcUsdFeed, usdcFeed);

        // Zero-feeds-allowed: blank optional addresses resolve to address(0) with no revert.
        vm.setEnv("ARC_NATIVE_USD_FEED", vm.toString(address(0)));
        vm.setEnv("ARC_USDC_ADDRESS", vm.toString(address(0)));
        vm.setEnv("ARC_USDC_USD_FEED", vm.toString(address(0)));
        HelperConfig.NetworkConfig memory cfgZero = new HelperConfig().getConfig();
        assertEq(cfgZero.nativeUsdFeed, address(0));
        assertEq(cfgZero.usdc, address(0));
        assertEq(cfgZero.usdcUsdFeed, address(0));
    }

    /// @dev Owns every `ZKSYNC_SEPOLIA_*` env key. Selection + the fail-loud missing-treasury revert.
    function test_helperConfig_zkSyncSepolia_branch() public {
        vm.chainId(ZKSYNC_SEPOLIA);
        vm.setEnv("ZKSYNC_SEPOLIA_PLATFORM_TREASURY", vm.toString(treasury));
        vm.setEnv("ZKSYNC_SEPOLIA_PLATFORM_FEE_BPS", "100");

        HelperConfig.NetworkConfig memory cfg = new HelperConfig().getConfig();
        assertEq(cfg.treasury, treasury);
        assertEq(cfg.platformFeeBps, 100);

        // Required treasury blank → vm.envAddress fails loud (no silent placeholder).
        vm.setEnv("ZKSYNC_SEPOLIA_PLATFORM_TREASURY", "");
        vm.expectRevert();
        new HelperConfig();
    }

    /// @dev Owns the generic `PLATFORM_TREASURY` fallback key. An unmatched chainId falls through.
    function test_helperConfig_unknownChain_fallsThrough() public {
        vm.chainId(424_242);
        vm.setEnv("PLATFORM_TREASURY", vm.toString(treasury));

        HelperConfig.NetworkConfig memory cfg = new HelperConfig().getConfig();
        assertEq(cfg.treasury, treasury); // catch-all reads PLATFORM_TREASURY, not a prefixed var
    }

    /*//////////////////////////////////////////////////////////////
        DEPLOYALL — LOCAL (owns DEPLOY_PAYMENT_LANES + ROUTER_OWNER)
    //////////////////////////////////////////////////////////////*/

    /// @dev Owns `DEPLOY_PAYMENT_LANES` + `ROUTER_OWNER`. Full local flow: deploy → configure feeds +
    ///      USDC allowlist → lanes ON (router authorized as minter) → lanes OFF (no lanes deployed).
    function test_deployAll_local_deployConfigureAndLanes() public {
        vm.chainId(LOCAL);
        _ownerIsBroadcaster();

        // Lanes ON: router + lanes deployed, feeds + USDC wired, router authorized + wired on the ledger.
        vm.setEnv("DEPLOY_PAYMENT_LANES", "true");
        (Access0x1Router router, PaymentLanes lanes, HelperConfig hc) = new DeployAll().run();
        HelperConfig.NetworkConfig memory cfg = hc.getConfig();

        assertTrue(address(router) != address(0));
        assertEq(router.owner(), BROADCASTER);
        assertEq(router.platformTreasury(), cfg.treasury);
        assertEq(router.platformFeeBps(), cfg.platformFeeBps);
        assertEq(router.nextMerchantId(), 1);

        // Local HelperConfig deploys live mocks, so the configure step wired (not skipped) them.
        assertTrue(cfg.nativeUsdFeed != address(0));
        assertEq(router.priceFeedOf(address(0)), cfg.nativeUsdFeed); // native feed at sentinel slot
        assertTrue(router.tokenAllowed(cfg.usdc));
        assertEq(router.priceFeedOf(cfg.usdc), cfg.usdcUsdFeed);

        assertTrue(address(lanes) != address(0));
        assertTrue(lanes.isRouter(address(router))); // zero-custody router authorized to credit lanes
        assertEq(router.paymentLanes(), address(lanes)); // and wired into the router's pay path

        // Lanes OFF: the optional ledger is not deployed; router stays in direct-push mode.
        vm.setEnv("DEPLOY_PAYMENT_LANES", "false");
        (, PaymentLanes lanesOff,) = new DeployAll().run();
        assertEq(address(lanesOff), address(0));
    }

    /*//////////////////////////////////////////////////////////////
        DEPLOYALL — BASE SEPOLIA (owns every BASE_SEPOLIA_* key)
    //////////////////////////////////////////////////////////////*/

    /// @dev Owns every `BASE_SEPOLIA_*` env key. Branch selection, the address(0) configure-skip, and
    ///      both constructor revert paths (zero treasury, fee-too-high) — sequential, so the shared
    ///      keys never race a sibling test.
    function test_deployAll_baseSepolia_branchSkipAndReverts() public {
        vm.chainId(BASE_SEPOLIA);
        _ownerIsBroadcaster();

        // 1. Branch selection: reads BASE_SEPOLIA_*; fee defaults to 100 when unset-but-set-here.
        vm.setEnv("BASE_SEPOLIA_PLATFORM_TREASURY", vm.toString(treasury));
        vm.setEnv("BASE_SEPOLIA_PLATFORM_FEE_BPS", "100");
        vm.setEnv("BASE_SEPOLIA_USDC_ADDRESS", vm.toString(usdc));
        vm.setEnv("BASE_SEPOLIA_NATIVE_USD_FEED", vm.toString(address(0)));
        vm.setEnv("BASE_SEPOLIA_USDC_USD_FEED", vm.toString(address(0)));
        HelperConfig.NetworkConfig memory cfg = new HelperConfig().getConfig();
        assertEq(cfg.treasury, treasury);
        assertEq(cfg.platformFeeBps, 100);
        assertEq(cfg.usdc, usdc);

        // 2. address(0) feeds → configure calls skipped; no revert, no guessed address wired. Clear
        //    USDC too so the whole configure step is a no-op (a not-yet-confirmed chain).
        vm.setEnv("BASE_SEPOLIA_USDC_ADDRESS", vm.toString(address(0)));
        (Access0x1Router router,,) = new DeployAll().run();
        assertEq(router.platformTreasury(), treasury);
        assertEq(router.priceFeedOf(address(0)), address(0)); // native feed left unset (skipped)
        assertFalse(router.tokenAllowed(usdc));

        // 3. Zero treasury → router constructor reverts Access0x1__ZeroAddress (bad config can't deploy).
        //    The revert fires after run()'s vm.startBroadcast() but before its stopBroadcast(); the
        //    broadcast flag is a cheatcode flag (not EVM state), so it does NOT roll back on revert —
        //    clear it explicitly before the next run() or the second startBroadcast() would throw.
        vm.setEnv("BASE_SEPOLIA_PLATFORM_TREASURY", vm.toString(address(0)));
        DeployAll d1 = new DeployAll();
        vm.expectRevert(Access0x1Router.Access0x1__ZeroAddress.selector);
        d1.run();
        vm.stopBroadcast();

        // 4. Fee 1001 > MAX_FEE_BPS (1000) → router constructor reverts Access0x1__FeeTooHigh.
        vm.setEnv("BASE_SEPOLIA_PLATFORM_TREASURY", vm.toString(treasury));
        vm.setEnv("BASE_SEPOLIA_PLATFORM_FEE_BPS", "1001");
        DeployAll d2 = new DeployAll();
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__FeeTooHigh.selector, 1001, 1000)
        );
        d2.run();
        vm.stopBroadcast();
    }

    /*//////////////////////////////////////////////////////////////
                  EXISTING BASELINE NOT REGRESSED
    //////////////////////////////////////////////////////////////*/

    /// @dev The HelperConfig edit must not break the Arc-only baseline deploy script on local. This
    ///      reads no env keys owned by another test, so it is race-free.
    function test_deployAll_existingDeployScriptStillGreen() public {
        vm.chainId(LOCAL);
        (Access0x1Router router, HelperConfig hc) = new DeployAccess0x1Router().run();
        HelperConfig.NetworkConfig memory cfg = hc.getConfig();

        assertTrue(address(router) != address(0));
        assertEq(router.platformTreasury(), cfg.treasury);
        assertEq(router.platformFeeBps(), cfg.platformFeeBps);
    }
}
