// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// ┌──────────────────────────────────────────────────────────────────────────────┐
// │   .---.     \ /    |                                                         │
// │  ( o o )     X     |     A C C E S S 0 x 1                                   │
// │   `-o-'     / \    |     wire web2 to web3 — zero custody, testnet only      │
// │     0        x     1                                                         │
// ├──────────────────────────────────────────────────────────────────────────────┤
// │  PriceRelayReceiver                                                          │
// │  A feed-shaped landing pad for a price carried in over Chainlink CCIP.       │
// └──────────────────────────────────────────────────────────────────────────────┘

import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

import { ICcipReceiver } from "./interfaces/ICcipReceiver.sol";

/// @title PriceRelayReceiver — the relayed price, shaped as a feed the router already knows how to read
/// @author Access0x1
/// @notice The DESTINATION half of the price relay. It accepts a data-only Chainlink CCIP message from
///         an allowlisted {PriceRelaySender}, and exposes the price it carries as a plain
///         `AggregatorV3Interface`.
///
///         THAT INTERFACE CHOICE IS THE WHOLE DESIGN. Because this contract IS a feed, wiring it up is
///         one existing owner call — `router.setPriceFeed(usdc, thisContract)` — and {Access0x1Router}
///         needs no change at all: no new branch, no new import, no money-path re-audit. {OracleLib}
///         guards this exactly as it guards a real aggregator, and every consumer that already reads a
///         feed (the router, {PriceOracleAdapter}, the SDK, a dashboard) reads this with no special
///         case. A relay that required its own call site would have bought reach at the cost of a
///         second pricing path; this one does not.
///
/// @dev    WHAT CCIP GUARANTEES, AND WHAT IT DOES NOT. CCIP delivers authenticated, exactly-once
///         messages: only the real Router can call {ccipReceive}, and only an allowlisted
///         (sourceChainSelector, sender) pair is honored. CCIP says NOTHING about whether the number
///         inside is a correct price — that is entirely the sending contract's responsibility, and the
///         reason {PriceRelaySender} reads an IMMUTABLE Chainlink aggregator through {OracleLib}
///         rather than accepting a caller-supplied value. This receiver adds four independent guards
///         on top, on the principle that neither side trusts the other to have done its job:
///
///           1. LANE. A message from a closed lane, or from anything other than the allowlisted sender
///              for that lane, is refused. Keyed BY SELECTOR, because CREATE2/CREATE3 make identical
///              addresses across chains ordinary — checking the sender alone would let any chain
///              impersonate any other.
///           2. SCALE. `sourceDecimals` must equal the scale pinned at deployment. The router divides
///              by `10 ** feed.decimals()`, so an unnoticed scale change is a silent 100× mispricing.
///           3. MONOTONICITY. The source timestamp must strictly advance. A re-delivered or reordered
///              report can never walk the price backwards to an older observation.
///           4. AGE + BAND. A report already older than `i_maxSourceAge` on arrival never becomes the
///              live price, and an answer outside the immutable deploy-time band is refused outright.
///
///         WHY THIS ONE REVERTS WHERE {Access0x1CcipReceiver} CREDITS. That receiver deliberately
///         avoids reverting, because reverting would strand real money in a failed-message state. This
///         message carries NO TOKENS — the `tokenAmounts` array is empty by construction — so a revert
///         strands nothing whatsoever. Refusing a bad report is therefore strictly correct: the
///         previous good answer stays in place and simply keeps aging, and CCIP records the message as
///         failed for manual inspection.
///
///         FAIL-CLOSED, IDENTICALLY TO EVERY OTHER FEED. A relay outage does not freeze the last price
///         as valid. `updatedAt` stops advancing; {OracleLib} measures it against the router's window
///         and reverts `OracleLib__StalePrice()`; `quote()` aborts `payNative`/`payToken` before value
///         moves. A broken relay closes the rail rather than mispricing it.
///
///         THE TIMESTAMP THIS FEED REPORTS is the SOURCE feed's `updatedAt`, not the arrival time.
///         Reporting arrival would launder relay latency into apparent freshness, hiding exactly the
///         failure a staleness guard exists to catch. It is clamped to the arrival timestamp so a
///         source clock running ahead of the destination's can never underflow {OracleLib}'s
///         subtraction; {sourceUpdatedAt} exposes the unclamped value for anyone auditing the skew.
///
///         NO ADDRESS OR SELECTOR IS HARDCODED (law #3). The CCIP Router is constructor-set and every
///         lane is owner-set from `docs.chain.link/ccip/directory`.
///
///         HOLDS NOTHING. No payable function, no token surface, no funds — a price landing pad and a
///         `view` read. Every money invariant stays in {Access0x1Router}, which this only prices for.
///
/// @custom:security-contact security@access0x1.dev
contract PriceRelayReceiver is ICcipReceiver, IERC165, AggregatorV3Interface, Ownable2Step {
    /// @dev Restricts a call to the configured CCIP Router. Named to match Chainlink's own
    ///      `CCIPReceiver.onlyRouter`, so the trust boundary reads the same to anyone who has seen
    ///      their base contract.
    modifier onlyCcipRouter() {
        if (msg.sender != i_ccipRouter) revert PriceRelayReceiver__NotCcipRouter(msg.sender);
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice One relayed observation.
    /// @param answer          The price as the source feed reported it.
    /// @param sourceUpdatedAt When the SOURCE feed posted it, unclamped.
    /// @param arrivedAt       When this chain received it. Used only to clamp the reported timestamp.
    struct Observation {
        int256 answer;
        uint256 sourceUpdatedAt;
        uint256 arrivedAt;
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Immutables
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice The CCIP Router for THIS chain — the only address allowed to call {ccipReceive}.
    /// @dev    Immutable by design: a swappable message source is a swappable price authority.
    address public immutable i_ccipRouter;

    /// @notice The scale every relayed answer must arrive at, and the scale this feed reports.
    /// @dev    Pinned at deployment and enforced on every delivery (guard 2). The router reads
    ///         `decimals()` live and divides by it, so a scale that could drift is a mispricing.
    uint8 private immutable i_decimals;

    /// @notice The lowest answer this receiver accepts.
    uint256 private immutable i_minAnswer;

    /// @notice The highest answer this receiver accepts.
    uint256 private immutable i_maxAnswer;

    /// @notice Max age, in seconds, a source observation may have ON ARRIVAL.
    /// @dev    Distinct from the router's staleness window, which governs how long an ACCEPTED
    ///         observation stays usable. This one governs admission: a report that spent too long in
    ///         flight, or that was already old when it left, never becomes the live price at all.
    uint256 public immutable i_maxSourceAge;

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice Human-readable pair label, mirroring `AggregatorV3Interface.description()`.
    string private s_description;

    /// @notice The local round id, incremented once per accepted delivery.
    /// @dev    Local and monotonic. The SOURCE round id is deliberately not mirrored: two chains'
    ///         round numbering is not one sequence, and pretending otherwise would misreport history.
    uint80 private s_latestRoundId;

    /// @notice local round id ⇒ the observation accepted under it.
    mapping(uint80 roundId => Observation observation) private s_rounds;

    /// @notice Allowlisted source lane: CCIP chain selector ⇒ the sender contract on that chain.
    /// @dev    `address(0)` = the lane is closed.
    mapping(uint64 sourceChainSelector => address sender) public allowedSenderFor;

    /// @notice CCIP message id ⇒ already processed. Replay guard.
    /// @dev    CCIP is itself exactly-once, so this is defence in depth against a mis-configured or
    ///         upgraded Router double-calling. The monotonic-timestamp guard would already reject a
    ///         duplicate; this rejects it with a clearer error and no ambiguity.
    mapping(bytes32 messageId => bool seen) public processed;

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice A relayed price was accepted and is now this feed's answer.
    /// @dev    Signature matches Chainlink's `AggregatorInterface.AnswerUpdated`, so an indexer
    ///         already watching feeds ingests this with no special case. Matching the SHAPE states
    ///         nothing about provenance — {description} and this NatSpec carry that.
    /// @param current   The accepted answer.
    /// @param roundId   The LOCAL round it was recorded under.
    /// @param updatedAt The SOURCE timestamp reported for it.
    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    /// @notice A delivery was accepted, with the provenance a plain {AnswerUpdated} cannot carry.
    /// @param messageId       The CCIP message id.
    /// @param srcChainSelector The CCIP selector of the chain the price came from.
    /// @param roundId         The local round id assigned.
    /// @param answer          The accepted answer.
    /// @param sourceUpdatedAt When the source feed posted it.
    /// @param latencySecs     Arrival time minus source time — the relay's observed latency.
    event PriceRelayAccepted(
        bytes32 indexed messageId,
        uint64 indexed srcChainSelector,
        uint80 indexed roundId,
        int256 answer,
        uint256 sourceUpdatedAt,
        uint256 latencySecs
    );

    /// @notice A source lane was opened or closed.
    event SourceLaneSet(uint64 indexed srcChainSelector, address indexed sender);

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice A required address argument was zero.
    error PriceRelayReceiver__ZeroAddress();

    /// @notice A required duration argument was zero.
    error PriceRelayReceiver__ZeroDuration();

    /// @notice The constructor received a band that is empty, inverted, or admits a non-positive answer.
    /// @param min The proposed floor.
    /// @param max The proposed ceiling.
    error PriceRelayReceiver__InvalidBand(uint256 min, uint256 max);

    /// @notice {ccipReceive} was called by something other than the configured CCIP Router.
    /// @param caller The address that tried.
    error PriceRelayReceiver__NotCcipRouter(address caller);

    /// @notice The message came from a closed lane, or from a sender that is not the allowlisted one
    ///         for that lane. Guard 1 — THE authorization check.
    /// @param srcChainSelector The source chain selector as delivered.
    /// @param sender           The decoded source sender.
    error PriceRelayReceiver__LaneNotAllowed(uint64 srcChainSelector, address sender);

    /// @notice This CCIP message id was already processed.
    /// @param messageId The duplicate id.
    error PriceRelayReceiver__AlreadyProcessed(bytes32 messageId);

    /// @notice The relayed answer arrived at a scale other than the pinned one. Guard 2.
    /// @param expected The pinned scale.
    /// @param received The delivered scale.
    error PriceRelayReceiver__DecimalsMismatch(uint8 expected, uint8 received);

    /// @notice The relayed observation is not newer than the one already stored. Guard 3.
    /// @param stored    The stored source timestamp.
    /// @param delivered The delivered source timestamp.
    error PriceRelayReceiver__NotNewer(uint256 stored, uint256 delivered);

    /// @notice The relayed observation was already too old on arrival. Guard 4a.
    /// @param ageSecs The age at arrival.
    /// @param maxAge  The admission limit.
    error PriceRelayReceiver__SourceTooOld(uint256 ageSecs, uint256 maxAge);

    /// @notice The relayed answer falls outside the immutable deploy-time band. Guard 4b.
    /// @param answer The rejected answer.
    /// @param min    The lowest accepted answer.
    /// @param max    The highest accepted answer.
    error PriceRelayReceiver__AnswerOutOfBand(int256 answer, uint256 min, uint256 max);

    /// @notice A read was attempted before any price has ever been relayed.
    /// @dev    Explicit rather than returning a zero tuple, which {OracleLib} would read as
    ///         `updatedAt == 0` and reject anyway — the typed error names the real situation.
    error PriceRelayReceiver__NoPriceYet();

    /// @notice {getRoundData} was asked for a round this receiver has never recorded.
    /// @param roundId The unknown round id.
    error PriceRelayReceiver__NoRound(uint80 roundId);

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Construction
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @param ccipRouter   The CCIP Router on THIS chain — CONFIRM from docs.chain.link/ccip/directory.
    /// @param description_ The pair label; state the provenance in it.
    /// @param decimals_    The scale every relayed answer must arrive at (8 for the USD convention).
    /// @param minAnswer_   The immutable floor for every accepted answer, strictly positive.
    /// @param maxAnswer_   The immutable ceiling, at or above the floor.
    /// @param maxSourceAge The admission limit on a report's age at arrival, in seconds.
    /// @param owner_       The address that may open and close lanes.
    constructor(
        address ccipRouter,
        string memory description_,
        uint8 decimals_,
        uint256 minAnswer_,
        uint256 maxAnswer_,
        uint256 maxSourceAge,
        address owner_
    ) Ownable(owner_) {
        if (ccipRouter == address(0)) revert PriceRelayReceiver__ZeroAddress();
        if (minAnswer_ == 0 || maxAnswer_ < minAnswer_) {
            revert PriceRelayReceiver__InvalidBand(minAnswer_, maxAnswer_);
        }
        if (maxSourceAge == 0) revert PriceRelayReceiver__ZeroDuration();

        i_ccipRouter = ccipRouter;
        i_decimals = decimals_;
        i_minAnswer = minAnswer_;
        i_maxAnswer = maxAnswer_;
        i_maxSourceAge = maxSourceAge;
        s_description = description_;
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice Open a source lane, or close it by passing `address(0)`.
    /// @dev    CONFIRM the selector from docs.chain.link/ccip/directory before opening a lane — an
    ///         allowlisted lane is an authorization to set the price this rail settles against, so a
    ///         wrong selector is a wrong trust grant, not a typo. Closing a lane is the immediate
    ///         response to a suspected compromise: deliveries stop, the last good answer keeps aging,
    ///         and the rail closes itself within the router's staleness window.
    /// @param srcChainSelector The CCIP chain selector of the source chain.
    /// @param sender           The sender contract there (`address(0)` closes the lane).
    function setSourceLane(uint64 srcChainSelector, address sender) external onlyOwner {
        allowedSenderFor[srcChainSelector] = sender;
        emit SourceLaneSet(srcChainSelector, sender);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // CCIP delivery
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc ICcipReceiver
    /// @dev `message.data` is `abi.encode(int256 answer, uint256 sourceUpdatedAt, uint8 sourceDecimals)`.
    ///      It is decoded ONLY after the lane check, because until the sender is proven allowlisted the
    ///      payload is attacker-controlled. No external call is made anywhere in this function — the
    ///      whole body is a decode, four guards, and two storage writes — so there is no reentrancy
    ///      surface to guard and no CEI ordering question to answer.
    function ccipReceive(Any2EVMMessage calldata message) external override onlyCcipRouter {
        // Guard 1 — LANE. First, and before the payload is read at all.
        address sender = abi.decode(message.sender, (address));
        address allowed = allowedSenderFor[message.sourceChainSelector];
        if (allowed == address(0) || sender != allowed) {
            revert PriceRelayReceiver__LaneNotAllowed(message.sourceChainSelector, sender);
        }
        if (processed[message.messageId]) {
            revert PriceRelayReceiver__AlreadyProcessed(message.messageId);
        }

        // Named `srcUpdatedAt` rather than `sourceUpdatedAt` so it does not shadow the getter of
        // the same name; the shadow compiled fine and read as a trap for the next editor.
        (int256 answer, uint256 srcUpdatedAt, uint8 sourceDecimals) =
            abi.decode(message.data, (int256, uint256, uint8));

        // Guard 2 — SCALE.
        if (sourceDecimals != i_decimals) {
            revert PriceRelayReceiver__DecimalsMismatch(i_decimals, sourceDecimals);
        }

        // Guard 3 — MONOTONICITY. Strictly newer, so a replayed or reordered report cannot walk the
        // price backwards. The very first delivery passes trivially against a stored zero.
        uint256 storedAt = s_rounds[s_latestRoundId].sourceUpdatedAt;
        if (srcUpdatedAt <= storedAt) {
            revert PriceRelayReceiver__NotNewer(storedAt, srcUpdatedAt);
        }

        // Guard 4a — AGE ON ARRIVAL. A source clock ahead of this chain's yields an age of zero rather
        // than an underflow; the clamp below handles the reported timestamp for the same reason.
        // slither-disable-next-line timestamp
        uint256 arrivedAt = block.timestamp;
        uint256 ageSecs = srcUpdatedAt >= arrivedAt ? 0 : arrivedAt - srcUpdatedAt;
        if (ageSecs > i_maxSourceAge) {
            revert PriceRelayReceiver__SourceTooOld(ageSecs, i_maxSourceAge);
        }

        // Guard 4b — BAND.
        if (answer <= 0) {
            revert PriceRelayReceiver__AnswerOutOfBand(answer, i_minAnswer, i_maxAnswer);
        }
        // `answer > 0` is enforced on the line above, so this int256 -> uint256 cast cannot wrap.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 scaled = uint256(answer);
        if (scaled < i_minAnswer || scaled > i_maxAnswer) {
            revert PriceRelayReceiver__AnswerOutOfBand(answer, i_minAnswer, i_maxAnswer);
        }

        processed[message.messageId] = true;
        uint80 roundId = s_latestRoundId + 1;
        s_latestRoundId = roundId;
        s_rounds[roundId] =
            Observation({ answer: answer, sourceUpdatedAt: srcUpdatedAt, arrivedAt: arrivedAt });

        emit PriceRelayAccepted(
            message.messageId, message.sourceChainSelector, roundId, answer, srcUpdatedAt, ageSecs
        );
        emit AnswerUpdated(answer, roundId, srcUpdatedAt);
    }

    /// @notice ERC-165 support, so the CCIP Router and any tooling can detect what this contract is.
    /// @param interfaceId The queried interface id.
    /// @return True for {ICcipReceiver}, {AggregatorV3Interface}, and {IERC165}.
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(ICcipReceiver).interfaceId
            || interfaceId == type(AggregatorV3Interface).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // AggregatorV3Interface
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc AggregatorV3Interface
    /// @dev Pinned at deployment and enforced on every delivery, so what this returns and what the
    ///      source publishes can never silently diverge.
    function decimals() external view override returns (uint8) {
        return i_decimals;
    }

    /// @inheritdoc AggregatorV3Interface
    /// @dev The provenance label. Deployments name the source chain and the relay here, so the
    ///      cross-chain origin is visible from a block explorer's read tab.
    function description() external view override returns (string memory) {
        return s_description;
    }

    /// @inheritdoc AggregatorV3Interface
    /// @dev Deliberately `0`. This contract is a relay landing pad, not a Chainlink aggregator, and a
    ///      consumer gating on a real aggregator version SHOULD reject it.
    function version() external pure override returns (uint256) {
        return 0;
    }

    /// @inheritdoc AggregatorV3Interface
    /// @dev Historical rounds are answered from storage. `answeredInRound` equals `roundId` for every
    ///      round: an answer is never carried forward from an earlier one.
    function getRoundData(uint80 roundId_)
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        Observation memory round = s_rounds[roundId_];
        if (round.arrivedAt == 0) revert PriceRelayReceiver__NoRound(roundId_);
        uint256 reportedAt = _reportedTimestamp(round);
        return (roundId_, round.answer, reportedAt, reportedAt, roundId_);
    }

    /// @inheritdoc AggregatorV3Interface
    /// @dev The read {OracleLib} guards on the router's behalf. The timestamp is the SOURCE feed's,
    ///      clamped to arrival — see the contract NatSpec for why arrival time would be the wrong
    ///      answer. Reverts before any price has been relayed rather than returning an empty tuple.
    function latestRoundData()
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        uint80 roundId = s_latestRoundId;
        if (roundId == 0) revert PriceRelayReceiver__NoPriceYet();
        Observation memory round = s_rounds[roundId];
        uint256 reportedAt = _reportedTimestamp(round);
        return (roundId, round.answer, reportedAt, reportedAt, roundId);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Monitoring reads
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice The UNCLAMPED source timestamp of the latest accepted observation.
    /// @dev    Paired with {latestArrivedAt}, this is how an operator audits cross-chain clock skew
    ///         and relay latency without inferring either from the clamped feed read.
    /// @return The source feed's `updatedAt`, exactly as relayed.
    function sourceUpdatedAt() external view returns (uint256) {
        return s_rounds[s_latestRoundId].sourceUpdatedAt;
    }

    /// @notice When the latest accepted observation arrived on this chain.
    /// @return The arrival block timestamp.
    function latestArrivedAt() external view returns (uint256) {
        return s_rounds[s_latestRoundId].arrivedAt;
    }

    /// @notice The accepted answer band, for a monitor stating the blast radius of the lane.
    /// @return min The immutable floor.
    /// @return max The immutable ceiling.
    function answerBand() external view returns (uint256 min, uint256 max) {
        return (i_minAnswer, i_maxAnswer);
    }

    /// @notice The latest local round id. `0` means no price has ever been relayed.
    /// @return The current round id.
    function latestRound() external view returns (uint80) {
        return s_latestRoundId;
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @dev The timestamp this feed reports: the source's, clamped to arrival. The clamp exists purely
    ///      to keep {OracleLib}'s `block.timestamp - updatedAt` from underflowing when the source chain
    ///      runs a few seconds ahead of this one. Clamping DOWNWARD is the safe direction — it can only
    ///      ever make the price look older, never fresher.
    /// @param round The observation to report on.
    /// @return The timestamp to report as both `startedAt` and `updatedAt`.
    function _reportedTimestamp(Observation memory round) private pure returns (uint256) {
        return round.sourceUpdatedAt > round.arrivedAt ? round.arrivedAt : round.sourceUpdatedAt;
    }
}
