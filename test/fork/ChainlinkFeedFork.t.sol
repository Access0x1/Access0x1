// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @title ChainlinkFeedFork
/// @notice The only test that exercises `quote()` against a REAL Chainlink feed (not
///         `MockV3Aggregator`). Everything else in the suite rests on the mock, so the
///         "Connect the World" claim — a feed read that drives on-chain state — is otherwise
///         proven only against mock behavior. This proves it against a live Base-Sepolia feed:
///         the round is fresh + positive, `quote()` returns a plausible token amount through the
///         real `feed.decimals()`, and the `OracleLib` staleness guard fires once the round ages
///         past the 1-hour timeout.
/// @dev    GATE-SAFE: every body short-circuits when `BASE_SEPOLIA_RPC_URL` is unset, so the
///         default `forge test` (CI + local, no fork URL) stays green. Run live with
///         `forge test --match-path test/fork/ChainlinkFeedFork.t.sol` after exporting
///         `BASE_SEPOLIA_RPC_URL` (the fork is created INSIDE each test, not in `setUp`, so an
///         unset URL never even attempts a fork).
contract ChainlinkFeedForkTest is Test, ProxyDeployer {
    /// @dev Canonical Chainlink ETH/USD feed on Base Sepolia (chainId 84532). Overridable via
    ///      `BASE_SEPOLIA_NATIVE_USD_FEED` so a different/updated feed can be pinned without an edit.
    ///      Source: docs.chain.link/data-feeds (Base Sepolia ETH/USD).
    address internal constant DEFAULT_ETH_USD_FEED = 0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%

    /// @dev True only when a Base-Sepolia RPC is configured. When false, every test returns early so
    ///      the suite is a no-op (green) on a machine/CI without a fork URL.
    function _forkOrSkip() internal returns (bool active) {
        string memory rpc = vm.envOr("BASE_SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return false;
        vm.createSelectFork(rpc);
        return true;
    }

    function _feed() internal view returns (AggregatorV3Interface) {
        return AggregatorV3Interface(vm.envOr("BASE_SEPOLIA_NATIVE_USD_FEED", DEFAULT_ETH_USD_FEED));
    }

    /// @dev Deploy a fresh router behind a UUPS proxy: deploy the impl, then an `ERC1967Proxy` that runs
    ///      `initialize(owner, treasury, fee)` in the same tx (the impl ran `_disableInitializers()` in
    ///      its constructor). The proxy is the router every test drives — state in the proxy, logic in
    ///      the impl — matching the production shape.
    function _deployRouter() internal returns (Access0x1Router) {
        address impl = address(new Access0x1Router());
        return Access0x1Router(
            deployProxy(
                impl,
                abi.encodeCall(Access0x1Router.initialize, (owner, treasury, PLATFORM_FEE_BPS))
            )
        );
    }

    /// @dev The live feed answers a positive, recently-updated round (sanity on the real oracle).
    function test_fork_realFeedIsFreshAndPositive() public {
        if (!_forkOrSkip()) return;

        AggregatorV3Interface feed = _feed();
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
            feed.latestRoundData();

        assertGt(answer, 0, "real feed answer must be positive");
        assertGt(updatedAt, 0, "real feed round must be completed");
        assertGe(answeredInRound, roundId, "real feed answer must not be carried over");
        // Fresh: within the OracleLib 1-hour window (allow generous slack for testnet update cadence).
        assertLt(block.timestamp - updatedAt, 1 hours, "real feed round must be fresh");
    }

    /// @dev A fresh router wired to the REAL feed prices $20.00 into a plausible amount of native
    ///      (ETH at testnet ~ hundreds-to-thousands of USD ⇒ $20 buys well under 1 ETH and far more
    ///      than a single wei). Proves the in-tx feed read + live-decimals math against production.
    function test_fork_quoteAgainstRealFeedIsPlausible() public {
        if (!_forkOrSkip()) return;

        Access0x1Router router = _deployRouter();
        vm.prank(owner);
        router.setPriceFeed(address(0), address(_feed()));

        uint256 amount = router.quote(1, address(0), 20e8); // $20.00, 8-dec USD
        assertGt(amount, 0, "quote must be non-zero");
        assertLt(amount, 1 ether, "$20 of ETH must be well under 1 ETH at any realistic price");
        assertGt(amount, 1_000_000, "quote must be more than dust");
    }

    /// @dev The `OracleLib` staleness guard must fire against the REAL feed once the round ages past
    ///      the 1-hour timeout — `quote()` reverts rather than pricing on a stale round.
    function test_fork_staleGuardTriggersAfterWarp() public {
        if (!_forkOrSkip()) return;

        Access0x1Router router = _deployRouter();
        vm.prank(owner);
        router.setPriceFeed(address(0), address(_feed()));

        // Sanity: it prices fine BEFORE the warp.
        assertGt(router.quote(1, address(0), 20e8), 0);

        // Age the chain past the 1-hour staleness window; the real round's `updatedAt` is now stale.
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(); // OracleLib__StalePrice, surfaced through the inlined guard
        router.quote(1, address(0), 20e8);
    }
}
