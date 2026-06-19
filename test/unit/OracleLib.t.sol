// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import { OracleLib } from "../../src/libraries/OracleLib.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";

/// @dev OracleLib's guard is `internal` (inlined), so it cannot be called externally. This thin
///      harness uses the library exactly as the router does and exposes one external entrypoint.
contract OracleLibHarness {
    using OracleLib for AggregatorV3Interface;

    function check(AggregatorV3Interface feed) external view returns (int256 answer) {
        (, answer,,,) = feed.staleCheckLatestRoundData();
    }

    /// @dev The per-feed `maxStaleness` overload, used by the router for slow-heartbeat feeds.
    function checkWindow(AggregatorV3Interface feed, uint256 maxStaleness)
        external
        view
        returns (int256 answer)
    {
        (, answer,,,) = feed.staleCheckLatestRoundData(maxStaleness);
    }
}

contract OracleLibTest is Test {
    MockV3Aggregator internal feed;
    OracleLibHarness internal harness;

    uint8 internal constant DECIMALS = 8;
    int256 internal constant PRICE = 2000e8;

    function setUp() public {
        vm.warp(1_700_000_000); // a realistic, non-zero "now" so the freshness window is meaningful
        feed = new MockV3Aggregator(DECIMALS, PRICE);
        harness = new OracleLibHarness();
    }

    function _feed() internal view returns (AggregatorV3Interface) {
        return AggregatorV3Interface(address(feed));
    }

    function test_freshRoundReturnsAnswer() public view {
        assertEq(harness.check(_feed()), PRICE);
    }

    function test_revertsWhenUpdatedAtZero() public {
        feed.setRoundData(1, PRICE, block.timestamp, 0, 1); // round never completed
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        harness.check(_feed());
    }

    function test_revertsWhenAnsweredInRoundBehind() public {
        feed.setRoundData(5, PRICE, block.timestamp, block.timestamp, 4); // carried-over answer
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        harness.check(_feed());
    }

    function test_revertsWhenStale() public {
        feed.setRoundData(1, PRICE, block.timestamp - 3601, block.timestamp - 3601, 1); // 1s past the 1h window
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        harness.check(_feed());
    }

    function test_passesAtExactlyTimeout() public {
        // boundary: age == TIMEOUT is NOT stale (the guard is strictly `>`)
        feed.setRoundData(1, PRICE, block.timestamp - 3600, block.timestamp - 3600, 1);
        assertEq(harness.check(_feed()), PRICE);
    }

    /// @dev The `maxStaleness` overload: an answer ~24h old (stale under the 1h default) is fresh
    ///      under an 86400+margin window — the per-feed fix for slow-heartbeat feeds (USDC/USD).
    function test_windowOverloadAcceptsWiderStaleness() public {
        uint256 window = 86_400 + 3600;
        feed.setRoundData(1, PRICE, block.timestamp - 86_400, block.timestamp - 86_400, 1);
        assertEq(harness.checkWindow(_feed(), window), PRICE);
    }

    /// @dev The `maxStaleness` overload still reverts a genuinely stale answer (older than the window).
    function test_windowOverloadRevertsBeyondWindow() public {
        uint256 window = 86_400 + 3600;
        feed.setRoundData(1, PRICE, block.timestamp - window - 1, block.timestamp - window - 1, 1);
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        harness.checkWindow(_feed(), window);
    }

    /// @dev The overload boundary: age == maxStaleness is NOT stale (strictly `>`), matching the
    ///      no-arg overload's `test_passesAtExactlyTimeout`.
    function test_windowOverloadPassesAtExactlyWindow() public {
        uint256 window = 86_400 + 3600;
        feed.setRoundData(1, PRICE, block.timestamp - window, block.timestamp - window, 1);
        assertEq(harness.checkWindow(_feed(), window), PRICE);
    }
}
