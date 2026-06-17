// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { DeployUsdMockFeed } from "../../script/DeployUsdMockFeed.s.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";

/// @notice Unit suite for the any-chain `$1.00` USDC/USD mock-feed deploy script (the generalized
///         {DeployArcUsdFeed} used on testnets that have real Circle USDC but no Chainlink USDC/USD
///         feed). Proves the default peg and the env-overridable decimals/answer.
/// @dev    ENV-KEY OWNERSHIP (the repo-wide race-safety convention, see DeployAll.t.sol): a single
///         function owns `MOCK_FEED_DECIMALS` + `MOCK_FEED_ANSWER`, and the unset/default assertions run
///         BEFORE its first `vm.setEnv`, so the shared-process env is never read after another writer.
///         No other test function in the repo touches these keys.
contract DeployUsdMockFeedTest is Test {
    function test_deploysDollarPeggedFeed_thenEnvOverrides() public {
        // Default: $1.00 at the 8-decimal Chainlink scale (no MOCK_FEED_* set).
        address feed = new DeployUsdMockFeed().run();
        assertGt(feed.code.length, 0, "feed has no code");
        assertEq(MockV3Aggregator(feed).decimals(), 8, "default decimals != 8");
        (, int256 answer,,,) = MockV3Aggregator(feed).latestRoundData();
        assertEq(answer, 1e8, "default answer != $1.00");

        // Env override: a different stablecoin scale (6 decimals, answer 1e6) flows through.
        vm.setEnv("MOCK_FEED_DECIMALS", "6");
        vm.setEnv("MOCK_FEED_ANSWER", "1000000");
        address feed2 = new DeployUsdMockFeed().run();
        assertEq(MockV3Aggregator(feed2).decimals(), 6, "override decimals not read");
        (, int256 answer2,,,) = MockV3Aggregator(feed2).latestRoundData();
        assertEq(answer2, 1e6, "override answer not read");
    }
}
