// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @title OracleLib
/// @author Access0x1 — staleness guard adapted from the Cyfrin / Patrick Collins
///         `foundry-defi-stablecoin` pattern (MIT).
/// @notice Wraps a Chainlink feed's `latestRoundData()` with a freshness + completed-round
///         check, so the router never prices a payment against a stale or never-finished round;
///         and a Chainlink L2 Sequencer Uptime check, so it never prices while an L2 sequencer is
///         down or freshly restarted.
/// @dev    Deliberately `internal`: the body inlines into the router, so there is NO separate
///         library deployment and NO link step (which zkSync's zksolc is hostile to). It is
///         single-responsibility — staleness ONLY; the caller (`quote()`) owns the `answer > 0`
///         validity check, because that needs `InvalidPrice` semantics and div-by-zero context.
library OracleLib {
    /// @notice The feed's latest round is stale or was never completed.
    error OracleLib__StalePrice();

    /// @notice The L2 sequencer is reported DOWN by Chainlink's L2 Sequencer Uptime feed.
    error OracleLib__SequencerDown();

    /// @notice The L2 sequencer restarted within the grace window; its feeds are not yet trusted.
    error OracleLib__SequencerGracePeriodNotOver();

    /// @notice Max age of a feed answer before it is treated as stale (1 hour).
    /// @dev    Matches the router's `MAX_FEED_STALENESS`. Stricter than the 3h Cyfrin canonical:
    ///         a payments router must settle against a fresh round, not a 3-hour-old one.
    uint256 private constant TIMEOUT = 3600;

    /// @notice Grace period after an L2 sequencer restart before its price feeds are trusted (1 hour).
    /// @dev    Chainlink's recommended pattern: a price reported right after the sequencer comes back
    ///         can be stale or manipulated, so reject quotes until the sequencer has been up that long.
    uint256 private constant SEQUENCER_GRACE_PERIOD = 3600;

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
        // Comparing against block.timestamp IS the staleness guard — the canonical Chainlink
        // pattern; minute-scale miner drift cannot defeat a 1-hour window (Slither timestamp ack).
        // slither-disable-next-line timestamp
        if (block.timestamp - updatedAt > TIMEOUT) revert OracleLib__StalePrice();
    }

    /// @notice Revert when an L2 sequencer is down or restarted less than `SEQUENCER_GRACE_PERIOD` ago,
    ///         so a payment never prices against a feed the sequencer cannot be trusted to have updated.
    /// @dev    Chainlink L2 Sequencer Uptime feed semantics: `answer == 0` ⇒ up, `answer == 1` ⇒ down;
    ///         `startedAt` is when the current up/down status began (`0` ⇒ the feed has posted no round
    ///         yet ⇒ not ready). The caller invokes this ONLY when a sequencer feed is configured (the
    ///         L2 deployments); L1, Arc, and any chain with no sequencer feed pass `address(0)` and skip
    ///         the check entirely, leaving their behaviour unchanged.
    /// @param sequencerFeed The Chainlink L2 Sequencer Uptime aggregator.
    function checkSequencerUp(AggregatorV3Interface sequencerFeed) internal view {
        // slither-disable-next-line unused-return
        (, int256 answer, uint256 startedAt,,) = sequencerFeed.latestRoundData();
        // answer == 0 ⇒ sequencer up; anything else (1 = down) ⇒ reject. startedAt == 0 ⇒ the uptime
        // feed has never posted a round (uninitialized) ⇒ also not trustworthy.
        if (answer != 0 || startedAt == 0) revert OracleLib__SequencerDown();
        // Reject quotes until the sequencer has been continuously up for the grace window.
        // slither-disable-next-line timestamp
        if (block.timestamp - startedAt <= SEQUENCER_GRACE_PERIOD) {
            revert OracleLib__SequencerGracePeriodNotOver();
        }
    }
}
