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

    // Added faucet-list testnet ids (mirrored from HelperConfig). WORLDCHAIN_SEPOLIA pins the corrected
    // id 4801 (NOT Optimism's 11155420) so a regression to the wrong id is caught by selection.
    uint256 internal constant ZORA_SEPOLIA = 999_999_999;
    uint256 internal constant WORLDCHAIN_SEPOLIA = 4_801;
    uint256 internal constant CELO_SEPOLIA = 11_142_220;
    uint256 internal constant ZIRCUIT_GARFIELD = 48_898;
    // Robinhood Chain testnet (Arbitrum Orbit L2). CCIP-lane endpoint; no Chainlink Data Feed live yet.
    uint256 internal constant ROBINHOOD_TESTNET = 46_630;

    // The three promoted-to-first-class EVM Sepolias (real Circle USDC + Chainlink feeds).
    uint256 internal constant ETHEREUM_SEPOLIA = 11_155_111;
    uint256 internal constant ARBITRUM_SEPOLIA = 421_614;
    uint256 internal constant OPTIMISM_SEPOLIA = 11_155_420;

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

    /// @dev Owns every `ZORA_SEPOLIA_*`, `WORLDCHAIN_SEPOLIA_*` and `CELO_SEPOLIA_*` key. Proves each
    ///      added faucet-list testnet selects its OWN branch and reads its OWN prefix (never another
    ///      chain's values), with the zero-feeds-allowed case. WORLDCHAIN_SEPOLIA = 4801 specifically
    ///      guards the earlier wrong-id (Optimism's 11155420) regression.
    function test_helperConfig_addedTestnets_branchesReadOwnPrefix() public {
        // Zora Sepolia — full-field selection.
        vm.chainId(ZORA_SEPOLIA);
        vm.setEnv("ZORA_SEPOLIA_PLATFORM_TREASURY", vm.toString(treasury));
        vm.setEnv("ZORA_SEPOLIA_PLATFORM_FEE_BPS", "200");
        vm.setEnv("ZORA_SEPOLIA_NATIVE_USD_FEED", vm.toString(nativeFeed));
        vm.setEnv("ZORA_SEPOLIA_USDC_ADDRESS", vm.toString(usdc));
        vm.setEnv("ZORA_SEPOLIA_USDC_USD_FEED", vm.toString(usdcFeed));
        HelperConfig.NetworkConfig memory zora = new HelperConfig().getConfig();
        assertEq(zora.treasury, treasury);
        assertEq(zora.platformFeeBps, 200); // reads ZORA_SEPOLIA_, not the default
        assertEq(zora.nativeUsdFeed, nativeFeed);
        assertEq(zora.usdc, usdc);
        assertEq(zora.usdcUsdFeed, usdcFeed);

        // World Chain Sepolia — selection on the CORRECTED id 4801; fee falls back to the 100 default.
        vm.chainId(WORLDCHAIN_SEPOLIA);
        vm.setEnv("WORLDCHAIN_SEPOLIA_PLATFORM_TREASURY", vm.toString(treasury));
        HelperConfig.NetworkConfig memory world = new HelperConfig().getConfig();
        assertEq(world.treasury, treasury);
        assertEq(world.platformFeeBps, 100); // default 1.00% when *_PLATFORM_FEE_BPS unset
        // Blank optional addresses resolve to address(0) with no revert (skipped at deploy).
        assertEq(world.nativeUsdFeed, address(0));
        assertEq(world.usdc, address(0));

        // Celo Sepolia — selection reads CELO_SEPOLIA_, isolated from the two chains above.
        vm.chainId(CELO_SEPOLIA);
        vm.setEnv("CELO_SEPOLIA_PLATFORM_TREASURY", vm.toString(treasury));
        vm.setEnv("CELO_SEPOLIA_PLATFORM_FEE_BPS", "300");
        HelperConfig.NetworkConfig memory celo = new HelperConfig().getConfig();
        assertEq(celo.treasury, treasury);
        assertEq(celo.platformFeeBps, 300);
    }

    /// @dev Owns every `ROBINHOOD_TESTNET_*` key. Robinhood Chain (46630) is the CCIP-LANE-ENDPOINT
    ///      shape: it selects its OWN branch and reads its OWN prefix, but because Chainlink Data Feeds
    ///      are NOT live there yet, the feeds + USDC resolve to address(0) with NO revert — DeployAll
    ///      skips wiring them, and same-chain USD quote() is intentionally unavailable until a feed
    ///      lands. This pins the honest no-feed default so a future "RH feed exists" change is deliberate.
    function test_helperConfig_robinhoodTestnet_branch_isLaneEndpointNoFeed() public {
        vm.chainId(ROBINHOOD_TESTNET);
        vm.setEnv("ROBINHOOD_TESTNET_PLATFORM_TREASURY", vm.toString(treasury));

        HelperConfig.NetworkConfig memory cfg = new HelperConfig().getConfig();
        assertEq(cfg.treasury, treasury); // reads ROBINHOOD_TESTNET_, isolated from other prefixes
        assertEq(cfg.platformFeeBps, 100); // default 1.00% when *_PLATFORM_FEE_BPS unset
        // No Chainlink feed / ERC-20 USDC on RH Chain yet: optional addresses resolve to address(0).
        assertEq(cfg.nativeUsdFeed, address(0));
        assertEq(cfg.usdc, address(0));
        assertEq(cfg.usdcUsdFeed, address(0));
    }

    /// @dev Owns every `SEPOLIA_*`, `ARBITRUM_SEPOLIA_*` and `OPTIMISM_SEPOLIA_*` key. Proves the three
    ///      promoted-to-first-class EVM Sepolias each select their OWN branch and read their OWN prefix
    ///      (never another chain's values). Optimism Sepolia is the no-USDC/USD-feed real-chain shape:
    ///      USDC set, `usdcUsdFeed` left blank ⇒ address(0), allowlisted-but-unpriced (no revert).
    function test_helperConfig_ethArbOpSepolia_branchesReadOwnPrefix() public {
        // Ethereum Sepolia — full-field selection, custom fee proves it reads SEPOLIA_ not the default.
        vm.chainId(ETHEREUM_SEPOLIA);
        vm.setEnv("SEPOLIA_PLATFORM_TREASURY", vm.toString(treasury));
        vm.setEnv("SEPOLIA_PLATFORM_FEE_BPS", "150");
        vm.setEnv("SEPOLIA_NATIVE_USD_FEED", vm.toString(nativeFeed));
        vm.setEnv("SEPOLIA_USDC_ADDRESS", vm.toString(usdc));
        vm.setEnv("SEPOLIA_USDC_USD_FEED", vm.toString(usdcFeed));
        HelperConfig.NetworkConfig memory eth = new HelperConfig().getConfig();
        assertEq(eth.treasury, treasury);
        assertEq(eth.platformFeeBps, 150);
        assertEq(eth.nativeUsdFeed, nativeFeed);
        assertEq(eth.usdc, usdc);
        assertEq(eth.usdcUsdFeed, usdcFeed);

        // Arbitrum Sepolia — reads ARBITRUM_SEPOLIA_, isolated from the Ethereum keys set above.
        vm.chainId(ARBITRUM_SEPOLIA);
        vm.setEnv("ARBITRUM_SEPOLIA_PLATFORM_TREASURY", vm.toString(treasury));
        vm.setEnv("ARBITRUM_SEPOLIA_USDC_ADDRESS", vm.toString(usdc));
        HelperConfig.NetworkConfig memory arb = new HelperConfig().getConfig();
        assertEq(arb.treasury, treasury);
        assertEq(arb.platformFeeBps, 100); // default 1.00% when *_PLATFORM_FEE_BPS unset
        assertEq(arb.usdc, usdc);

        // Optimism Sepolia — full set: Chainlink DOES publish ETH/USD + USDC/USD on OP Sepolia
        // (verified against the Chainlink RDD + on-chain 2026-06-17), so every field reads its prefix.
        vm.chainId(OPTIMISM_SEPOLIA);
        vm.setEnv("OPTIMISM_SEPOLIA_PLATFORM_TREASURY", vm.toString(treasury));
        vm.setEnv("OPTIMISM_SEPOLIA_USDC_ADDRESS", vm.toString(usdc));
        vm.setEnv("OPTIMISM_SEPOLIA_NATIVE_USD_FEED", vm.toString(nativeFeed));
        vm.setEnv("OPTIMISM_SEPOLIA_USDC_USD_FEED", vm.toString(usdcFeed));
        HelperConfig.NetworkConfig memory op = new HelperConfig().getConfig();
        assertEq(op.treasury, treasury);
        assertEq(op.usdc, usdc);
        assertEq(op.nativeUsdFeed, nativeFeed);
        assertEq(op.usdcUsdFeed, usdcFeed); // OP Sepolia reads its own USDC/USD feed
    }

    /// @dev Owns every `ZIRCUIT_GARFIELD_*` key. Selection + the fail-loud missing-treasury revert
    ///      (an added testnet requires its treasury exactly like the original branches).
    function test_helperConfig_addedTestnet_failsLoudOnMissingTreasury() public {
        vm.chainId(ZIRCUIT_GARFIELD);
        vm.setEnv("ZIRCUIT_GARFIELD_PLATFORM_TREASURY", vm.toString(treasury));

        HelperConfig.NetworkConfig memory cfg = new HelperConfig().getConfig();
        assertEq(cfg.treasury, treasury);
        assertEq(cfg.platformFeeBps, 100); // default 1.00% when *_PLATFORM_FEE_BPS unset

        // Required treasury blank → vm.envAddress fails loud (no silent placeholder).
        vm.setEnv("ZIRCUIT_GARFIELD_PLATFORM_TREASURY", "");
        vm.expectRevert();
        new HelperConfig();
    }

    /*//////////////////////////////////////////////////////////////
        HELPERCONFIG — MAINNET branches (AUDIT-GATED, NOT DEPLOYED)
        Each mainnet branch reads its OWN `<CHAIN>_MAINNET_*` env and is
        env-driven (default address(0)) exactly like the testnet twins.
        These prove BRANCH SELECTION + the address(0)-default truth rule;
        they deploy NOTHING. Each fn owns its `<CHAIN>_MAINNET_*` keys.
    //////////////////////////////////////////////////////////////*/

    // Mainnet ids mirrored from HelperConfig (the constants there are `internal`).
    uint256 internal constant BASE_MAINNET = 8_453;
    uint256 internal constant POLYGON_MAINNET = 137;
    // Added faucet-list mainnet ids (AUDIT-GATED profiles, mirrored from HelperConfig).
    uint256 internal constant ZORA_MAINNET = 7_777_777;
    uint256 internal constant GNOSIS_MAINNET = 100;

    /// @dev Owns every `BASE_MAINNET_*` key. Selection reads BASE_MAINNET_* (not the testnet prefix),
    ///      and every unconfirmed/blank address resolves to address(0) — the DeployAll skip semantics —
    ///      so a pre-audit mainnet profile never carries a guessed address.
    function test_helperConfig_baseMainnet_branch_isEnvDrivenAddressZeroDefault() public {
        vm.chainId(BASE_MAINNET);
        vm.setEnv("BASE_MAINNET_PLATFORM_TREASURY", vm.toString(treasury));
        vm.setEnv("BASE_MAINNET_PLATFORM_FEE_BPS", "150");

        HelperConfig.NetworkConfig memory cfg = new HelperConfig().getConfig();
        assertEq(cfg.treasury, treasury);
        assertEq(cfg.platformFeeBps, 150); // reads BASE_MAINNET_, not the default
        // Truth rule: with NO address env set, every money/feed address defaults to address(0)
        // (skipped at deploy) — never a hardcoded mainnet USDC/feed.
        assertEq(cfg.nativeUsdFeed, address(0));
        assertEq(cfg.usdc, address(0));
        assertEq(cfg.usdcUsdFeed, address(0));
        assertEq(cfg.chainRegistry, address(0));
        assertEq(cfg.creForwarder, address(0));
    }

    /// @dev Owns every `POLYGON_MAINNET_*` key. Selection + the fail-loud missing-treasury revert
    ///      (mainnet requires the treasury exactly like the testnet branches).
    function test_helperConfig_polygonMainnet_branch_failsLoudOnMissingTreasury() public {
        vm.chainId(POLYGON_MAINNET);
        vm.setEnv("POLYGON_MAINNET_PLATFORM_TREASURY", vm.toString(treasury));

        HelperConfig.NetworkConfig memory cfg = new HelperConfig().getConfig();
        assertEq(cfg.treasury, treasury);
        assertEq(cfg.platformFeeBps, 100); // default 1.00% when *_PLATFORM_FEE_BPS unset

        // Required treasury blank → vm.envAddress fails loud (no silent placeholder).
        vm.setEnv("POLYGON_MAINNET_PLATFORM_TREASURY", "");
        vm.expectRevert();
        new HelperConfig();
    }

    /// @dev Owns every `ZORA_MAINNET_*` and `GNOSIS_MAINNET_*` key. Proves the added mainnet PROFILES
    ///      select their own branch and stay env-driven with address(0) defaults — a pre-audit profile
    ///      never carries a guessed USDC/feed address (law #4), exactly like the original mainnet twins.
    function test_helperConfig_addedMainnets_branchesAreEnvDrivenAddressZeroDefault() public {
        // Zora mainnet (chainId 7777777).
        vm.chainId(ZORA_MAINNET);
        vm.setEnv("ZORA_MAINNET_PLATFORM_TREASURY", vm.toString(treasury));
        vm.setEnv("ZORA_MAINNET_PLATFORM_FEE_BPS", "175");
        HelperConfig.NetworkConfig memory zora = new HelperConfig().getConfig();
        assertEq(zora.treasury, treasury);
        assertEq(zora.platformFeeBps, 175); // reads ZORA_MAINNET_, not the default
        assertEq(zora.nativeUsdFeed, address(0)); // no hardcoded mainnet feed
        assertEq(zora.usdc, address(0));
        assertEq(zora.usdcUsdFeed, address(0));

        // Gnosis mainnet (chainId 100) — fee falls back to the 100 default; addresses still address(0).
        vm.chainId(GNOSIS_MAINNET);
        vm.setEnv("GNOSIS_MAINNET_PLATFORM_TREASURY", vm.toString(treasury));
        HelperConfig.NetworkConfig memory gnosis = new HelperConfig().getConfig();
        assertEq(gnosis.treasury, treasury);
        assertEq(gnosis.platformFeeBps, 100);
        assertEq(gnosis.usdc, address(0));
    }

    /// @dev Owns `ARC_MAINNET_CHAIN_ID` + every `ARC_MAINNET_*` key. Arc mainnet id is TBD (not
    ///      launched), so its branch is reachable ONLY when the operator sets a NON-ZERO
    ///      `ARC_MAINNET_CHAIN_ID` that matches the live chain. Race-safe: both legs touch ONLY
    ///      Arc-mainnet-owned keys (and the LOCAL branch, which reads no env) — no shared/fallback key.
    function test_helperConfig_arcMainnet_isDormantUntilChainIdEnvIsSet() public {
        vm.setEnv("ARC_MAINNET_PLATFORM_TREASURY", vm.toString(treasury));

        // (a) DORMANT (the zero guard): with the id env zero, `_isArcMainnet()` can never match — not
        //     even if `block.chainid` were 0. We pin the LOCAL chain (31337), whose branch reads NO env
        //     and deploys mocks: the returned treasury is the in-broadcast sender, NOT the Arc-mainnet
        //     treasury we set — proving the Arc branch was NOT selected off its set treasury.
        vm.setEnv("ARC_MAINNET_CHAIN_ID", "0");
        vm.chainId(LOCAL);
        HelperConfig.NetworkConfig memory dormant = new HelperConfig().getConfig();
        assertTrue(dormant.treasury != treasury, "Arc-mainnet branch leaked while dormant");
        assertGt(dormant.usdc.code.length, 0, "local branch (mocks) not taken while Arc is dormant");

        // (b) DORMANT on a mismatching live id: id env set to a value that does NOT equal the live
        //     chain ⇒ still dormant. Pinning LOCAL again, the Arc treasury is still ignored.
        vm.setEnv("ARC_MAINNET_CHAIN_ID", vm.toString(uint256(987_654)));
        vm.chainId(LOCAL);
        HelperConfig.NetworkConfig memory mismatch = new HelperConfig().getConfig();
        assertTrue(mismatch.treasury != treasury, "Arc-mainnet branch selected on a mismatching id");

        // (c) ACTIVE: point the id env at the live chain ⇒ the Arc-mainnet branch is selected (the
        //     Arc-mainnet treasury resolves), env-driven with address(0) defaults for every
        //     unconfirmed address — never a hardcoded mainnet USDC/feed.
        uint256 arcMainnetId = 987_654; // stand-in for the real id the operator sets at launch
        vm.chainId(arcMainnetId);
        HelperConfig.NetworkConfig memory cfg = new HelperConfig().getConfig();
        assertEq(cfg.treasury, treasury); // proves the Arc-mainnet branch was taken
        assertEq(cfg.platformFeeBps, 100); // default fee
        assertEq(cfg.nativeUsdFeed, address(0)); // env-driven, never hardcoded
        assertEq(cfg.usdc, address(0));
        assertEq(cfg.usdcUsdFeed, address(0));

        // Cleanup the id env so no sibling run inherits a non-zero Arc-mainnet id.
        vm.setEnv("ARC_MAINNET_CHAIN_ID", "0");
    }

    /*//////////////////////////////////////////////////////////////
        DEPLOYALL — LOCAL (owns DEPLOY_PAYMENT_LANES + ROUTER_OWNER)
    //////////////////////////////////////////////////////////////*/

    /// @dev Owns `DEPLOY_PAYMENT_LANES` + `ROUTER_OWNER` + every `TOKEN_*_ADDR`/`TOKEN_*_USD_FEED` key.
    ///      Full local flow: deploy → configure feeds + USDC allowlist → MULTI-TOKEN allowlist + feeds
    ///      (a fully-configured token, an allowlisted-but-unfed token, and an unset/skipped token) →
    ///      lanes ON (router authorized as minter) → lanes OFF (no lanes deployed). All TOKEN_* keys are
    ///      set HERE (and cleared before the lanes-OFF re-run) so no sibling test ever reads them.
    function test_deployAll_local_deployConfigureAndLanes() public {
        vm.chainId(LOCAL);
        _ownerIsBroadcaster();

        // Multi-token env: LINK fully configured (addr + feed), DAI allowlisted-but-unfed (addr only),
        // WBTC + the rest left UNSET so the deploy SKIPS them (never a guessed address).
        address link = makeAddr("link");
        address linkFeed = makeAddr("linkFeed");
        address dai = makeAddr("dai");
        vm.setEnv("TOKEN_LINK_ADDR", vm.toString(link));
        vm.setEnv("TOKEN_LINK_USD_FEED", vm.toString(linkFeed));
        vm.setEnv("TOKEN_DAI_ADDR", vm.toString(dai)); // no DAI feed → allowlisted, no priceFeed

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

        // MULTI-TOKEN: LINK is allowlisted AND priced; DAI is allowlisted but has NO feed (a half-config
        // surfaces loudly at quote(), never a silent misprice); WBTC was unset → never allowlisted.
        assertTrue(router.tokenAllowed(link));
        assertEq(router.priceFeedOf(link), linkFeed);
        assertTrue(router.tokenAllowed(dai));
        assertEq(router.priceFeedOf(dai), address(0)); // unfed by design (env had no DAI feed)
        assertFalse(router.tokenAllowed(makeAddr("wbtc"))); // unset symbol → skipped, not guessed

        assertTrue(address(lanes) != address(0));
        assertTrue(lanes.isRouter(address(router))); // zero-custody router authorized to credit lanes
        assertEq(router.paymentLanes(), address(lanes)); // and wired into the router's pay path

        // Clear the TOKEN_* keys so the lanes-OFF re-run (and any sibling) sees them unset (skip path).
        vm.setEnv("TOKEN_LINK_ADDR", "");
        vm.setEnv("TOKEN_LINK_USD_FEED", "");
        vm.setEnv("TOKEN_DAI_ADDR", "");

        // Lanes OFF: the optional ledger is not deployed; router stays in direct-push mode.
        vm.setEnv("DEPLOY_PAYMENT_LANES", "false");
        (Access0x1Router routerOff, PaymentLanes lanesOff,) = new DeployAll().run();
        assertEq(address(lanesOff), address(0));
        // With the TOKEN_* env cleared, the extra-token loop is a clean no-op (nothing allowlisted).
        assertFalse(routerOff.tokenAllowed(link));
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
