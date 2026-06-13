// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @title OracleLib
/// @author Access0x1 — staleness guard adapted from the Cyfrin / Patrick Collins
///         `foundry-defi-stablecoin` pattern (MIT).
/// @notice Wraps a Chainlink feed's `latestRoundData()` with a freshness + completed-round
///         check, so the router never prices a payment against a stale or never-finished round.
/// @dev    Deliberately `internal`: the body inlines into the router, so there is NO separate
///         library deployment and NO link step (which zkSync's zksolc is hostile to). It is
///         single-responsibility — staleness ONLY; the caller (`quote()`) owns the `answer > 0`
///         validity check, because that needs `InvalidPrice` semantics and div-by-zero context.
library OracleLib {
    /// @notice The feed's latest round is stale or was never completed.
    error OracleLib__StalePrice();

    /// @notice Max age of a feed answer before it is treated as stale (1 hour).
    /// @dev    Matches the router's `MAX_FEED_STALENESS`. Stricter than the 3h Cyfrin canonical:
    ///         a payments router must settle against a fresh round, not a 3-hour-old one.
    uint256 private constant TIMEOUT = 3600;

    /// @notice `latestRoundData()` guarded by a staleness + completed-round check.
    /// @param feed The Chainlink aggregator to read.
    /// @return roundId         The round the answer was computed in.
    /// @return answer          The raw feed answer (validity, e.g. `answer > 0`, is the caller's job).
    /// @return startedAt       When the round started.
    /// @return updatedAt       When the round was last updated (0 ⇒ never completed ⇒ revert).
    /// @return answeredInRound The round the answer was carried from; `< roundId` ⇒ carried-over ⇒ revert.
    function staleCheckLatestRoundData(AggregatorV3Interface feed)
        internal
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        (roundId, answer, startedAt, updatedAt, answeredInRound) = feed.latestRoundData();
        if (updatedAt == 0 || answeredInRound < roundId) revert OracleLib__StalePrice();
        if (block.timestamp - updatedAt > TIMEOUT) revert OracleLib__StalePrice();
    }
}
