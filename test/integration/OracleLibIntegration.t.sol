// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";

import { DeployAll } from "../../script/DeployAll.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";
import { OracleLib } from "../../src/libraries/OracleLib.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";

/// @title  OracleLibIntegration — the staleness guard proven through the REAL deploy + the live router
/// @author Access0x1
/// @notice The Cyfrin integration layer for {OracleLib}. Every other OracleLib test stands the library
///         up by hand (a one-line harness, or a router `new`'d directly in the test). This file instead
///         deploys the WHOLE estate through the REAL {DeployAll} / {HelperConfig} script — the same
///         `run()` the operator invokes per chain — so the deploy path itself is under test, and then
///         exercises {OracleLib} exactly where it lives in production: inlined into `Access0x1Router.quote()`.
///
///         What this proves that the unit / fuzz / fork tests do not:
///           1. The script-deployed router is wired with a Chainlink feed (`priceFeedOf`) by the real
///              configure step — i.e. OracleLib has a real feed to guard, sourced the way prod sources it.
///           2. A FRESH feed flows through the guard into a real, plausible `quote()` (the guard is on
///              the happy path, not just the revert path).
///           3. Ageing the chain past the 1-hour `TIMEOUT` makes the SAME deployed router revert — the
///              guard fires end-to-end through the public `quote()` selector, not just the inlined harness.
///           4. A carried-over round (`answeredInRound < roundId`) on the script-deployed feed reverts
///              through `quote()` — the second guard branch, proven on the composed system.
///           5. The native feed and the USDC feed (two independent `priceFeedOf` slots wired by the
///              script) are EACH guarded independently — staling one does not affect the other.
///
/// @dev    Runs on the local chain id (31337) so {HelperConfig} deploys fresh {MockV3Aggregator} feeds
///         in-broadcast (no RPC, no env) — the integration is fully offline + deterministic, the Cyfrin
///         local-mock pattern. `ROUTER_OWNER` is pinned to the broadcast default sender so the script's
///         own `onlyOwner` configure calls (`setPriceFeed`, `setTokenAllowed`) are authorized inside the
///         single broadcast, exactly as a real `--sender $DEPLOYER` run behaves. The feed mocks created
///         by the script have `updatedAt == block.timestamp` at deploy, so they start FRESH; the tests
///         that need staleness `vm.warp` forward, and the carried-over test re-posts a round via the
///         mock's `setRoundData` (reachable because the script records the feed address in the config).
contract OracleLibIntegrationTest is Test {
    /// @notice The local Anvil chain id — selects {HelperConfig}'s fresh-mock branch.
    uint256 internal constant LOCAL_CHAIN_ID = 31_337;

    /// @notice Foundry's default broadcast sender (the address an arg-less `vm.startBroadcast()` pranks
    ///         as). Pinning `ROUTER_OWNER` to it lets the in-broadcast configure calls authorize.
    address internal constant BROADCASTER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    /// @notice The native-token sentinel — the router keys its native/USD feed at `priceFeedOf[0]`.
    address internal constant NATIVE = address(0);

    /// @notice The library's 1-hour staleness window, mirrored for the warp tests.
    uint256 internal constant TIMEOUT = 3600;

    /// @notice A $20.00 order in 8-decimal USD — the price we route through the guarded feed.
    uint256 internal constant USD_20 = 20e8;

    Access0x1Router internal router;
    HelperConfig.NetworkConfig internal cfg;

    /// @notice Deploy the whole suite via the REAL script, then capture the script-deployed router +
    ///         its resolved config (which carries the freshly-deployed mock feed addresses).
    function setUp() public {
        // A realistic, stable "now" so the in-broadcast mock feeds (updatedAt = block.timestamp) start
        // comfortably inside the 1-hour window, and warping forward is meaningful.
        vm.warp(1_700_000_000);
        vm.chainId(LOCAL_CHAIN_ID);

        // Authorize the script's in-broadcast onlyOwner configure calls (real `--sender $DEPLOYER` match).
        vm.setEnv("ROUTER_OWNER", vm.toString(BROADCASTER));

        // THE REAL DEPLOY: one replayable `run()` — router + spine + commerce quartet + feed wiring.
        HelperConfig hc;
        (router,, hc) = new DeployAll().run();
        cfg = hc.getConfig();

        // Sanity that the script actually wired the feeds OracleLib is meant to guard (else the
        // integration would be vacuous). These mirror DeployAll's local-run assertions.
        assertTrue(cfg.nativeUsdFeed != address(0), "script must deploy a native/USD feed");
        assertEq(
            router.priceFeedOf(NATIVE), cfg.nativeUsdFeed, "native feed wired at sentinel slot"
        );
        assertTrue(router.tokenAllowed(cfg.usdc), "script must allowlist USDC");
        assertEq(router.priceFeedOf(cfg.usdc), cfg.usdcUsdFeed, "USDC feed wired by the script");
    }

    /*//////////////////////////////////////////////////////////////
                          HAPPY PATH (GUARD ACCEPTS)
    //////////////////////////////////////////////////////////////*/

    /// @notice (2) A FRESH feed flows through the OracleLib guard into a real quote. The script-deployed
    ///         native feed is $2000.00 (8-dec) and was just posted, so the guard accepts it and `quote()`
    ///         prices $20 of native into a plausible amount (well under 1 ETH, far more than dust). Proves
    ///         the guard sits on the happy path of the composed, script-deployed system — not only its
    ///         revert path.
    function test_integration_freshFeedQuotesThroughGuard() public view {
        uint256 amount = router.quote(1, NATIVE, USD_20);
        assertGt(amount, 0, "fresh-feed quote must be non-zero");
        // $20 / $2000 = 0.01 native = 1e16 wei. Allow a wide plausibility band, not an exact match.
        assertLt(amount, 1 ether, "$20 of a ~$2000 asset is well under 1 ETH");
        assertGt(amount, 1e12, "quote must be far more than dust");
    }

    /// @notice The USDC feed slot is guarded + priced independently: the script wired a $1.00 (8-dec)
    ///         USDC/USD feed, so $20 quotes to ~20 USDC in 6-dec units through the same guard. Confirms
    ///         OracleLib guards EACH `priceFeedOf` slot, not just the native one.
    function test_integration_freshUsdcFeedQuotesThroughGuard() public view {
        uint256 amount = router.quote(1, cfg.usdc, USD_20);
        assertGt(amount, 0, "fresh USDC-feed quote must be non-zero");
        // $20 at $1.00, 6-dec USDC = 20e6; mulDiv rounds UP so allow the exact value or one dust wei.
        assertGe(amount, 20e6, "~$20 of $1 USDC is at least 20e6 (rounds up)");
        assertLe(amount, 20e6 + 1, "and no more than a single rounding wei above");
    }

    /*//////////////////////////////////////////////////////////////
                        REVERT PATH (GUARD BLOCKS)
    //////////////////////////////////////////////////////////////*/

    /// @notice (3) Ageing the chain past the 1-hour window makes the SAME script-deployed router revert
    ///         through `quote()`. The native feed's `updatedAt` was set at deploy; warping `TIMEOUT + 1`
    ///         forward makes that round stale, and the inlined OracleLib guard reverts with
    ///         `OracleLib__StalePrice` — surfaced through the public `quote()` selector on the live router.
    function test_integration_staleGuardRevertsQuoteAfterWarp() public {
        // Prices fine BEFORE the warp (the feed is fresh from the deploy).
        assertGt(router.quote(1, NATIVE, USD_20), 0, "must quote before the feed ages");

        // Age past the staleness window — the deploy-time round is now > 1h old.
        vm.warp(block.timestamp + TIMEOUT + 1);

        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        router.quote(1, NATIVE, USD_20);
    }

    /// @notice (4) A CARRIED-OVER round on the script-deployed feed reverts through `quote()`. We reach
    ///         the live mock feed via the address the script recorded in `cfg.nativeUsdFeed` and post a
    ///         fresh-but-carried round (`answeredInRound < roundId`); OracleLib's second guard branch
    ///         fires, and `quote()` reverts with `OracleLib__StalePrice`. Proves the completed-round
    ///         guard, not just the staleness guard, holds end-to-end on the composed system.
    function test_integration_carriedOverRoundRevertsQuote() public {
        MockV3Aggregator nativeFeed = MockV3Aggregator(cfg.nativeUsdFeed);
        // roundId 5, answeredInRound 4 ⇒ carried over; timestamps fresh so ONLY the carried-over branch
        // can be the cause of the revert.
        nativeFeed.setRoundData(5, 2000e8, block.timestamp, block.timestamp, 4);

        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        router.quote(1, NATIVE, USD_20);
    }

    /// @notice (5) The two feed slots are guarded INDEPENDENTLY: staling ONLY the native feed must not
    ///         break the USDC quote, and vice-versa. We post a stale native round, then assert the native
    ///         quote reverts while the (untouched, still-fresh) USDC quote still prices. This is the
    ///         per-feed isolation OracleLib gives a multi-token router — one bad oracle cannot wedge an
    ///         unrelated token's pricing.
    function test_integration_stalingOneFeedDoesNotAffectTheOther() public {
        MockV3Aggregator nativeFeed = MockV3Aggregator(cfg.nativeUsdFeed);
        // Stale the native feed only: updatedAt is > 1h in the past, USDC feed left fresh.
        nativeFeed.setRoundData(
            2, 2000e8, block.timestamp - TIMEOUT - 1, block.timestamp - TIMEOUT - 1, 2
        );

        // Native quote reverts through its now-stale feed.
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        router.quote(1, NATIVE, USD_20);

        // The USDC feed was never touched — its quote must still succeed (per-feed isolation).
        assertGt(router.quote(1, cfg.usdc, USD_20), 0, "untouched USDC feed must still price");
    }
}
