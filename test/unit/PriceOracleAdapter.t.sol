// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

import { PriceOracleAdapter } from "../../src/PriceOracleAdapter.sol";
import { IPriceOracleAdapter, IERC7726Lite } from "../../src/interfaces/IPriceOracleAdapter.sol";
import { OracleLib } from "../../src/libraries/OracleLib.sol";

import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @notice A trivial v2 implementation for the upgrade test: adds one view, changes no storage, so an
///         upgrade to it must preserve every prior slot (the per-pair feed + staleness maps).
contract PriceOracleAdapterV2 is PriceOracleAdapter {
    /// @notice A marker the original implementation does not expose — proves the new logic is live.
    function version2Marker() external pure returns (string memory) {
        return "v2";
    }
}

/// @notice An 18-decimal ERC-20-shaped token used as the `base` side of a `<token>/USD` pair.
contract MockWETH {
    function decimals() external pure returns (uint8) {
        return 18;
    }
}

/// @notice A token whose `decimals()` REVERTS — exercises the adapter's try/catch fallback that maps a
///         broken token to the typed {PriceOracleAdapter__FeedNotSet} instead of an opaque bubble-up.
contract RevertingDecimalsToken {
    function decimals() external pure returns (uint8) {
        revert("no decimals");
    }
}

/// @notice A Chainlink-shaped feed whose `decimals()` REVERTS but whose `latestRoundData()` is valid —
///         exercises the adapter's feed-decimals try/catch fallback.
contract RevertingDecimalsFeed is AggregatorV3Interface {
    function decimals() external pure override returns (uint8) {
        revert("no decimals");
    }

    function description() external pure override returns (string memory) {
        return "RevertingDecimalsFeed";
    }

    function version() external pure override returns (uint256) {
        return 0;
    }

    function getRoundData(uint80)
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, 2000e8, block.timestamp, block.timestamp, 1);
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, 2000e8, block.timestamp, block.timestamp, 1);
    }
}

/// @notice The PriceOracleAdapter unit suite — the swappable ERC-7726 (draft) price oracle that
///         normalizes a Chainlink feed behind {OracleLib}'s staleness guard. INFRA only: no funds move,
///         so there is no invariant suite — but every revert path (zero/stale/zero-price/no-feed/
///         broken-decimals/non-owner) and the full decimal-trap quote math are covered here.
contract PriceOracleAdapterTest is Test, ProxyDeployer {
    /// @dev Mirror of the events under test so `vm.expectEmit` can match them exactly.
    event FeedSet(
        address indexed base, address indexed quote, address indexed feed, uint256 maxStaleness
    );

    PriceOracleAdapter internal adapter;

    MockV3Aggregator internal ethUsdFeed; // 8-dec feed, $2000/ETH
    MockV3Aggregator internal usdcUsdFeed; // 8-dec feed, $1/USDC
    MockWETH internal weth; // 18-dec base token
    MockUSDC internal usdc; // 6-dec quote token

    address internal constant NATIVE = address(0);
    // The ISO-4217 numeric code for USD (840 = 0x348) as the ERC-7726 "USD currency" address sentinel.
    address internal constant USD = address(uint160(0x0000000000000000000000000000000000000348));

    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");

    int256 internal constant ETH_PRICE = 2000e8; // $2000.00, 8 decimals
    int256 internal constant USDC_PRICE = 1e8; // $1.00, 8 decimals

    function setUp() public {
        ethUsdFeed = new MockV3Aggregator(8, ETH_PRICE);
        usdcUsdFeed = new MockV3Aggregator(8, USDC_PRICE);
        weth = new MockWETH();
        usdc = new MockUSDC();

        address impl = address(new PriceOracleAdapter());
        address proxy = deployProxy(impl, abi.encodeCall(PriceOracleAdapter.initialize, (admin)));
        adapter = PriceOracleAdapter(proxy);
    }

    /*//////////////////////////////////////////////////////////////
                                INIT
    //////////////////////////////////////////////////////////////*/

    function test_Initialize_SetsOwner() public view {
        assertEq(adapter.owner(), admin);
    }

    function test_Initialize_RevertsOnZeroOwner() public {
        address impl = address(new PriceOracleAdapter());
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        deployProxy(impl, abi.encodeCall(PriceOracleAdapter.initialize, (address(0))));
    }

    function test_Initialize_CannotReinitialize() public {
        vm.expectRevert();
        adapter.initialize(stranger);
    }

    function test_Implementation_InitializersDisabled() public {
        PriceOracleAdapter impl = new PriceOracleAdapter();
        vm.expectRevert();
        impl.initialize(admin);
    }

    /*//////////////////////////////////////////////////////////////
                               SET FEED
    //////////////////////////////////////////////////////////////*/

    function test_SetFeed_StoresFeedAndDefaultWindow() public {
        vm.expectEmit(true, true, true, true);
        emit FeedSet(NATIVE, USD, address(ethUsdFeed), 0);
        vm.prank(admin);
        adapter.setFeed(NATIVE, USD, ethUsdFeed);

        assertEq(address(adapter.feedOf(NATIVE, USD)), address(ethUsdFeed));
        assertEq(adapter.stalenessOf(NATIVE, USD), 0);
    }

    function test_SetFeed_WithWindow_StoresBoth() public {
        uint256 window = 1 days;
        vm.expectEmit(true, true, true, true);
        emit FeedSet(address(usdc), USD, address(usdcUsdFeed), window);
        vm.prank(admin);
        adapter.setFeed(address(usdc), USD, usdcUsdFeed, window);

        assertEq(address(adapter.feedOf(address(usdc), USD)), address(usdcUsdFeed));
        assertEq(adapter.stalenessOf(address(usdc), USD), window);
    }

    function test_SetFeed_Clears_ResetsWindowToDefault() public {
        // Configure with a wide window, then clear via the 2-arg overload.
        vm.startPrank(admin);
        adapter.setFeed(address(usdc), USD, usdcUsdFeed, 1 days);
        adapter.setFeed(address(usdc), USD, AggregatorV3Interface(address(0)));
        vm.stopPrank();

        assertEq(address(adapter.feedOf(address(usdc), USD)), address(0));
        assertEq(adapter.stalenessOf(address(usdc), USD), 0);
    }

    function test_SetFeed_Rebind_OverwritesPair() public {
        vm.startPrank(admin);
        adapter.setFeed(NATIVE, USD, ethUsdFeed);
        adapter.setFeed(NATIVE, USD, usdcUsdFeed); // rebind same pair
        vm.stopPrank();
        assertEq(address(adapter.feedOf(NATIVE, USD)), address(usdcUsdFeed));
    }

    function test_SetFeed_RevertsForNonOwner() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        vm.prank(stranger);
        adapter.setFeed(NATIVE, USD, ethUsdFeed);
    }

    function test_SetFeedWithWindow_RevertsForNonOwner() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        vm.prank(stranger);
        adapter.setFeed(NATIVE, USD, ethUsdFeed, 1 days);
    }

    function test_SetFeedWithWindow_RevertsOnZeroFeed() public {
        vm.expectRevert(IPriceOracleAdapter.PriceOracleAdapter__ZeroAddress.selector);
        vm.prank(admin);
        adapter.setFeed(NATIVE, USD, AggregatorV3Interface(address(0)), 1 days);
    }

    function test_SetFeedWithWindow_RevertsOnZeroStaleness() public {
        vm.expectRevert(IPriceOracleAdapter.PriceOracleAdapter__ZeroAmount.selector);
        vm.prank(admin);
        adapter.setFeed(NATIVE, USD, ethUsdFeed, 0);
    }

    /*//////////////////////////////////////////////////////////////
                              GET QUOTE
    //////////////////////////////////////////////////////////////*/

    function test_GetQuote_NativeToUsd() public {
        // base = native ETH (18 dec), quote = "USD" sentinel priced at 8 dec via the feed's own scale.
        // $2000 worth at $2000/ETH = 1 ETH = 1e18. Here USD side decimals come from the USD sentinel,
        // which is a normal address with no decimals() — so we price USD/USD pairs token-side instead.
        // Use a concrete quote token to keep decimals well-defined: quote in USDC (6 dec).
        vm.prank(admin);
        adapter.setFeed(NATIVE, address(usdc), ethUsdFeed); // ETH priced in USDC, feed = ETH/USD @ 8dec

        // 1 ETH (1e18) at $2000, quote token USDC (6 dec):
        //   quoteAmount = 1e18 · 2000e8 · 10^6 / (10^8 · 10^18) = 2000e6 = $2000 in USDC units.
        uint256 q = adapter.getQuote(1e18, NATIVE, address(usdc));
        assertEq(q, 2000e6);
    }

    function test_GetQuote_TokenBaseToTokenQuote() public {
        // base = WETH (18 dec), quote = USDC (6 dec), feed ETH/USD @ 8 dec.
        vm.prank(admin);
        adapter.setFeed(address(weth), address(usdc), ethUsdFeed);

        // 0.5 WETH (5e17) at $2000 ⇒ $1000 ⇒ 1000e6 USDC.
        uint256 q = adapter.getQuote(5e17, address(weth), address(usdc));
        assertEq(q, 1000e6);
    }

    function test_GetQuote_UsdcToNative() public {
        // base = USDC (6 dec), quote = native (18 dec). Feed USDC/USD @ 8 dec, $1/USDC.
        // 2000 USDC (2000e6) at $1 ⇒ $2000 ⇒ at... feed is USDC/USD so 1 USDC = $1 = 1e18 wei-of-"USD".
        // quoteAmount = 2000e6 · 1e8 · 10^18 / (10^8 · 10^6) = 2000e18.
        vm.prank(admin);
        adapter.setFeed(address(usdc), NATIVE, usdcUsdFeed);
        uint256 q = adapter.getQuote(2000e6, address(usdc), NATIVE);
        assertEq(q, 2000e18);
    }

    function test_GetQuote_RoundsUp() public {
        // A price that does not divide evenly must round UP (never underpay the value).
        // Feed = 3 (an odd price at 8 dec → effectively $3e-8), base=WETH(18), quote=USDC(6).
        MockV3Aggregator oddFeed = new MockV3Aggregator(8, 3);
        vm.prank(admin);
        adapter.setFeed(address(weth), address(usdc), oddFeed);

        // baseAmount = 1 wei: 1 · 3 · 10^6 / (10^8 · 10^18) = 3e6/1e26 → 0 exact, ceil ⇒ 1.
        uint256 q = adapter.getQuote(1, address(weth), address(usdc));
        assertEq(q, 1);
    }

    function test_GetQuote_RevertsOnZeroAmount() public {
        vm.prank(admin);
        adapter.setFeed(address(weth), address(usdc), ethUsdFeed);
        vm.expectRevert(IPriceOracleAdapter.PriceOracleAdapter__ZeroAmount.selector);
        adapter.getQuote(0, address(weth), address(usdc));
    }

    function test_GetQuote_RevertsWhenFeedNotSet() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IPriceOracleAdapter.PriceOracleAdapter__FeedNotSet.selector,
                address(weth),
                address(usdc)
            )
        );
        adapter.getQuote(1e18, address(weth), address(usdc));
    }

    function test_GetQuote_RevertsOnZeroPrice() public {
        MockV3Aggregator zeroFeed = new MockV3Aggregator(8, 0);
        vm.prank(admin);
        adapter.setFeed(address(weth), address(usdc), zeroFeed);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPriceOracleAdapter.PriceOracleAdapter__InvalidPrice.selector, int256(0)
            )
        );
        adapter.getQuote(1e18, address(weth), address(usdc));
    }

    function test_GetQuote_RevertsOnNegativePrice() public {
        MockV3Aggregator negFeed = new MockV3Aggregator(8, 100);
        // Force a fully-formed but negative round (fresh timestamp, completed round, negative answer).
        negFeed.setRoundData(2, -5, block.timestamp, block.timestamp, 2);
        vm.prank(admin);
        adapter.setFeed(address(weth), address(usdc), negFeed);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPriceOracleAdapter.PriceOracleAdapter__InvalidPrice.selector, int256(-5)
            )
        );
        adapter.getQuote(1e18, address(weth), address(usdc));
    }

    /*//////////////////////////////////////////////////////////////
                          STALENESS REVERTS
    //////////////////////////////////////////////////////////////*/

    function test_GetQuote_RevertsOnStaleRound() public {
        vm.prank(admin);
        adapter.setFeed(address(weth), address(usdc), ethUsdFeed);

        // Move time forward past the 1h default window with no fresh update ⇒ stale.
        vm.warp(block.timestamp + OracleLib.TIMEOUT + 1);
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        adapter.getQuote(1e18, address(weth), address(usdc));
    }

    function test_GetQuote_FreshWithinWindow_Succeeds() public {
        vm.prank(admin);
        adapter.setFeed(address(weth), address(usdc), ethUsdFeed);
        // Exactly at the edge of the window (delta == TIMEOUT) is still fresh (guard is strictly `>`).
        vm.warp(block.timestamp + OracleLib.TIMEOUT);
        uint256 q = adapter.getQuote(1e18, address(weth), address(usdc));
        assertEq(q, 2000e6);
    }

    function test_GetQuote_WiderWindow_KeepsStaleFeedFresh() public {
        // A slow feed configured with a 1-day window is still fresh well past the 1h default.
        vm.prank(admin);
        adapter.setFeed(address(weth), address(usdc), ethUsdFeed, 1 days);
        vm.warp(block.timestamp + OracleLib.TIMEOUT + 1); // past the default, within the 1-day window
        uint256 q = adapter.getQuote(1e18, address(weth), address(usdc));
        assertEq(q, 2000e6);
    }

    function test_GetQuote_WiderWindow_StillGoesStaleEventually() public {
        vm.prank(admin);
        adapter.setFeed(address(weth), address(usdc), ethUsdFeed, 1 days);
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        adapter.getQuote(1e18, address(weth), address(usdc));
    }

    function test_GetQuote_RevertsOnNeverCompletedRound() public {
        MockV3Aggregator feed = new MockV3Aggregator(8, ETH_PRICE);
        // updatedAt == 0 ⇒ a round that never completed ⇒ stale.
        feed.setRoundData(1, ETH_PRICE, block.timestamp, 0, 1);
        vm.prank(admin);
        adapter.setFeed(address(weth), address(usdc), feed);
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        adapter.getQuote(1e18, address(weth), address(usdc));
    }

    function test_GetQuote_RevertsOnCarriedOverRound() public {
        MockV3Aggregator feed = new MockV3Aggregator(8, ETH_PRICE);
        // answeredInRound (1) < roundId (2) ⇒ the answer was carried over ⇒ stale.
        feed.setRoundData(2, ETH_PRICE, block.timestamp, block.timestamp, 1);
        vm.prank(admin);
        adapter.setFeed(address(weth), address(usdc), feed);
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        adapter.getQuote(1e18, address(weth), address(usdc));
    }

    /*//////////////////////////////////////////////////////////////
                       BROKEN-DECIMALS FALLBACKS
    //////////////////////////////////////////////////////////////*/

    function test_GetQuote_RevertsOnFeedWithBrokenDecimals() public {
        RevertingDecimalsFeed brokenFeed = new RevertingDecimalsFeed();
        vm.prank(admin);
        adapter.setFeed(address(weth), address(usdc), AggregatorV3Interface(address(brokenFeed)));
        vm.expectRevert(
            abi.encodeWithSelector(
                IPriceOracleAdapter.PriceOracleAdapter__FeedNotSet.selector,
                address(weth),
                address(usdc)
            )
        );
        adapter.getQuote(1e18, address(weth), address(usdc));
    }

    function test_GetQuote_RevertsOnBaseTokenWithBrokenDecimals() public {
        RevertingDecimalsToken brokenBase = new RevertingDecimalsToken();
        vm.prank(admin);
        adapter.setFeed(address(brokenBase), address(usdc), ethUsdFeed);
        // _tokenDecimals(base) reverts ⇒ pair named (base, quote).
        vm.expectRevert(
            abi.encodeWithSelector(
                IPriceOracleAdapter.PriceOracleAdapter__FeedNotSet.selector,
                address(brokenBase),
                address(usdc)
            )
        );
        adapter.getQuote(1e18, address(brokenBase), address(usdc));
    }

    function test_GetQuote_RevertsOnQuoteTokenWithBrokenDecimals() public {
        RevertingDecimalsToken brokenQuote = new RevertingDecimalsToken();
        vm.prank(admin);
        adapter.setFeed(address(weth), address(brokenQuote), ethUsdFeed);
        // _tokenDecimals(quote) reverts; otherSide is base ⇒ error names (quote, base) by construction.
        vm.expectRevert(
            abi.encodeWithSelector(
                IPriceOracleAdapter.PriceOracleAdapter__FeedNotSet.selector,
                address(brokenQuote),
                address(weth)
            )
        );
        adapter.getQuote(1e18, address(weth), address(brokenQuote));
    }

    /*//////////////////////////////////////////////////////////////
                              ERC-165
    //////////////////////////////////////////////////////////////*/

    function test_SupportsInterface_AdapterAndQuoteAndErc165() public view {
        assertTrue(adapter.supportsInterface(type(IPriceOracleAdapter).interfaceId));
        assertTrue(adapter.supportsInterface(type(IERC7726Lite).interfaceId));
        assertTrue(adapter.supportsInterface(type(IERC165).interfaceId));
    }

    function test_SupportsInterface_UnknownIsFalse() public view {
        assertFalse(adapter.supportsInterface(0xffffffff));
        assertFalse(adapter.supportsInterface(0xdeadbeef));
    }

    /*//////////////////////////////////////////////////////////////
                              UPGRADE
    //////////////////////////////////////////////////////////////*/

    function test_Upgrade_OwnerCanUpgrade() public {
        // Seed state, upgrade, prove the state survived and the new logic is live.
        vm.prank(admin);
        adapter.setFeed(address(weth), address(usdc), ethUsdFeed, 1 days);

        address v2 = address(new PriceOracleAdapterV2());
        vm.prank(admin);
        UUPSUpgradeable(address(adapter)).upgradeToAndCall(v2, "");

        assertEq(PriceOracleAdapterV2(address(adapter)).version2Marker(), "v2");
        assertEq(address(adapter.feedOf(address(weth), address(usdc))), address(ethUsdFeed));
        assertEq(adapter.stalenessOf(address(weth), address(usdc)), 1 days);
    }

    function test_Upgrade_RevertsForNonOwner() public {
        address v2 = address(new PriceOracleAdapterV2());
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        vm.prank(stranger);
        UUPSUpgradeable(address(adapter)).upgradeToAndCall(v2, "");
    }

    function test_Upgrade_FrozenAfterRenounce() public {
        vm.prank(admin);
        adapter.renounceOwnership();
        address v2 = address(new PriceOracleAdapterV2());
        // No owner ⇒ _authorizeUpgrade reverts for everyone ⇒ permanently frozen.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        vm.prank(admin);
        UUPSUpgradeable(address(adapter)).upgradeToAndCall(v2, "");
    }

    /*//////////////////////////////////////////////////////////////
                                FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev The quote is monotonic + linear in baseAmount: doubling base doubles the quote (within the
    ///      ceil dust). Confirms no overflow/precision break across a wide amount range.
    function testFuzz_GetQuote_LinearInBaseAmount(uint96 amount) public {
        amount = uint96(bound(amount, 1, type(uint96).max));
        vm.prank(admin);
        adapter.setFeed(address(weth), address(usdc), ethUsdFeed); // ETH/USD @ 8 dec, 18→6 dec pair

        uint256 q1 = adapter.getQuote(amount, address(weth), address(usdc));
        uint256 q2 = adapter.getQuote(uint256(amount) * 2, address(weth), address(usdc));
        // q2 is ~2·q1; ceil rounding lets it differ by at most 1 wei from exactly 2·q1.
        assertApproxEqAbs(q2, q1 * 2, 1);
    }

    /// @dev A configured feed at any positive price + valid decimals never returns 0 for a non-zero
    ///      base amount (ceil rounding guarantees ≥ 1 wei of quote for any positive value).
    function testFuzz_GetQuote_NeverZeroForPositiveBase(uint64 amount, uint64 price) public {
        amount = uint64(bound(amount, 1, type(uint64).max));
        price = uint64(bound(price, 1, type(uint64).max));
        MockV3Aggregator feed = new MockV3Aggregator(8, int256(uint256(price)));
        vm.prank(admin);
        adapter.setFeed(address(weth), address(usdc), feed);
        assertGt(adapter.getQuote(amount, address(weth), address(usdc)), 0);
    }
}
