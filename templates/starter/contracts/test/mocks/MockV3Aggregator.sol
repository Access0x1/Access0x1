// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @title MockV3Aggregator
/// @notice Test-only Chainlink feed with a FULLY settable round (the shipped Chainlink mock
///         hardcodes `answeredInRound == roundId`, so it cannot exercise the carried-over-round
///         guard). `setRoundData` gives every branch of the router's oracle guards — stale,
///         zero `updatedAt`, negative/zero answer, and `answeredInRound < roundId`.
contract MockV3Aggregator is AggregatorV3Interface {
    uint8 private immutable i_decimals;
    uint80 private s_roundId;
    int256 private s_answer;
    uint256 private s_startedAt;
    uint256 private s_updatedAt;
    uint80 private s_answeredInRound;

    constructor(uint8 decimals_, int256 initialAnswer_) {
        i_decimals = decimals_;
        updateAnswer(initialAnswer_);
    }

    /// @notice Post a fresh answer (updatedAt = now, answeredInRound = roundId) — the happy path.
    function updateAnswer(int256 answer_) public {
        s_roundId += 1;
        s_answer = answer_;
        s_startedAt = block.timestamp;
        s_updatedAt = block.timestamp;
        s_answeredInRound = s_roundId;
    }

    /// @notice Set the full 5-tuple verbatim — used to forge stale / invalid rounds in tests.
    function setRoundData(
        uint80 roundId_,
        int256 answer_,
        uint256 startedAt_,
        uint256 updatedAt_,
        uint80 answeredInRound_
    ) external {
        s_roundId = roundId_;
        s_answer = answer_;
        s_startedAt = startedAt_;
        s_updatedAt = updatedAt_;
        s_answeredInRound = answeredInRound_;
    }

    function decimals() external view override returns (uint8) {
        return i_decimals;
    }

    function description() external pure override returns (string memory) {
        return "MockV3Aggregator";
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
        return (s_roundId, s_answer, s_startedAt, s_updatedAt, s_answeredInRound);
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (s_roundId, s_answer, s_startedAt, s_updatedAt, s_answeredInRound);
    }
}
