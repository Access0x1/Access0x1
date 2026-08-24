// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// ┌──────────────────────────────────────────────────────────────────────────────┐
// │   .---.     \ /    |                                                         │
// │  ( o o )     X     |     A C C E S S 0 x 1                                   │
// │   `-o-'     / \    |     wire web2 to web3 — zero custody, testnet only      │
// │     0        x     1                                                         │
// ├──────────────────────────────────────────────────────────────────────────────┤
// │  OperatorFeed                                                                │
// │  A named-operator price stand-in for a chain Chainlink does not serve.       │
// └──────────────────────────────────────────────────────────────────────────────┘

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @title  OperatorFeed — an access-controlled, self-describing price stand-in
/// @author Access0x1
/// @notice A minimal `AggregatorV3Interface` whose answer is posted by a NAMED operator, for use on a
///         testnet where Chainlink publishes no feed for the pair the router needs. It is a
///         DEVELOPMENT STAND-IN, never a Chainlink product: there is no decentralized oracle network
///         behind the number, no aggregation across node operators, and no economic security. One key
///         posts the answer, and this contract's job is to make that fact explicit, bounded, and
///         auditable rather than implicit.
///
///         WHY IT EXISTS. Arc testnet (5042002) carries real Circle USDC and is the hosted checkout's
///         default chain, and Chainlink's own address registry lists no USDC/USD feed there (confirmed
///         against docs.chain.link/data-feeds/price-feeds/addresses, 2026-08-23 — zero entries for Arc
///         or 5042002; Data Streams likewise lists no Arc verifier). The router therefore has no
///         DON-backed source to price USDC against on that chain. The predecessor stand-in was
///         `test/mocks/MockV3Aggregator`, whose `updateAnswer` is `public` with NO access control —
///         deploying it as live pricing hands the settlement price to whoever calls it first. This
///         contract is the replacement, and the whole delta is the guard rails below.
///
/// @dev    THE FOUR GUARDS, and what each one refuses.
///
///         1. WRITE ACCESS. {updateAnswer} admits the `owner` and one `operator` address only.
///            Separating the two is operational, not cosmetic: the refresh keeper is a cron holding a
///            hot key, and a hot key must never be the key that can also rotate authority. The owner
///            stays cold and grants/revokes the operator with {setOperator}.
///         2. A DEPLOY-TIME PRICE BAND. `i_minAnswer`/`i_maxAnswer` are immutable, so a compromised
///            operator key — or a fat-fingered keeper — still cannot move the answer outside the range
///            fixed at deployment. For a dollar stablecoin that band is a few percent around $1.00, and
///            the difference between "the operator can set any price" and "the operator can set a price
///            within 5% of the peg" is the difference between a takeover and a nuisance.
///         3. A DECLARED HEARTBEAT. `i_heartbeat` states ON-CHAIN how often this feed expects to be
///            refreshed, so the keeper reads its cadence from the contract rather than from a runbook
///            that drifts. {isStale} and {secondsSinceUpdate} are the keeper's whole decision surface.
///         4. NO ARBITRARY ROUND FORGERY. The test mock's `setRoundData`, which writes any 5-tuple
///            including a forged-fresh `updatedAt`, has NO counterpart here. `updatedAt` is always
///            `block.timestamp` and `answeredInRound` is always the round just written. Exercising the
///            router's stale/invalid-round branches stays the test mock's job, in `test/`.
///
///         FAIL-CLOSED, BY CONSTRUCTION. A keeper that stops running does NOT freeze the price at its
///         last value and let payments settle against it. `updatedAt` simply stops advancing;
///         {OracleLib} measures it against the router's staleness window and reverts
///         `OracleLib__StalePrice()`, which propagates out of `quote()` and aborts `payNative` /
///         `payToken` before any value moves. The failure mode of an unattended feed is a refused
///         payment, never a payment settled at a wrong price. Choose `heartbeat` comfortably INSIDE
///         the router's window for that token (the router's default is `OracleLib.TIMEOUT`, 3600s) so
///         ordinary keeper jitter never reaches the cliff.
///
///         ⚠ THAT GUARANTEE IS SCOPED TO THE UNATTENDED CASE, and the ATTENDED case inverts it. This
///         contract cannot tell a measured answer from an invented one: `updateAnswer` checks the
///         caller and the band, and both admit a keeper re-posting a constant. Such a keeper leaves
///         the answer forever fresh in TIME and arbitrarily wrong in SUBSTANCE, and the staleness
///         guard above — the one mechanism the design leans on — is exactly what it defeats. The band
///         never helps, because any band containing the peg contains the constant. The defence
///         therefore lives OFF-CHAIN, in the keeper: {RefreshOperatorFeed} carries no default answer
///         and refuses to run without a real price source. See `docs/ARC-PRICING.md`, "the attended
///         case". Deploying this feed with a keeper that invents its number is worse than deploying
///         no keeper at all.
///
///         INFRASTRUCTURE, NOT MONEY. This contract holds no funds, has no payable function and no
///         token surface, so there is no CEI or reentrancy concern here — it is owner-configured
///         storage plus a `view` read. Every money invariant lives in {Access0x1Router}, which this
///         only prices for.
///
///         NOT UPGRADEABLE, DELIBERATELY. A price source behind a proxy is a price source whose
///         implementation can be swapped under a live router. This deploys as plain bytecode; replacing
///         it is an explicit `setPriceFeed` call on the router, visible on-chain as its own event.
///
/// @custom:security-contact security@access0x1.dev
contract OperatorFeed is AggregatorV3Interface, Ownable2Step {
    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice One posted round, retained so {getRoundData} answers historical queries truthfully.
    /// @dev    `startedAt` and `updatedAt` are the same value here — this feed posts a complete round
    ///         in one transaction, so a round never exists in a started-but-unfinished state. Both are
    ///         kept so the 5-tuple matches Chainlink's shape exactly for any consumer that reads both.
    /// @param answer    The posted answer, at `i_decimals` scale.
    /// @param updatedAt The block timestamp the round was posted at.
    struct Round {
        int256 answer;
        uint256 updatedAt;
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Immutables
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice The scale of `answer`, mirroring `AggregatorV3Interface.decimals()`.
    /// @dev    Immutable because the router reads it live (`feed.decimals()`) inside `quote()` and
    ///         divides by it; a mutable scale would silently re-denominate every future quote.
    uint8 private immutable i_decimals;

    /// @notice The lowest answer {updateAnswer} accepts, fixed at deployment.
    uint256 private immutable i_minAnswer;

    /// @notice The highest answer {updateAnswer} accepts, fixed at deployment.
    uint256 private immutable i_maxAnswer;

    /// @notice Seconds this feed expects to elapse between refreshes — its self-declared cadence.
    /// @dev    Advisory to READERS and authoritative for the KEEPER; it does not gate {updateAnswer}
    ///         and it does not gate the router. The enforcement that matters is the router's own
    ///         staleness window via {OracleLib}. Publishing it here means the keeper never needs a
    ///         hardcoded number.
    uint256 private immutable i_heartbeat;

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice Human-readable pair label, mirroring `AggregatorV3Interface.description()`.
    /// @dev    Set once at construction and never mutated. Deployments are expected to label the
    ///         provenance in the string itself (see {DeployArcOperatorFeed}), so a block explorer
    ///         reader sees "operator feed" without opening the source.
    string private s_description;

    /// @notice The most recent round id. Starts at 1 with the constructor's opening answer.
    uint80 private s_latestRoundId;

    /// @notice round id ⇒ the round posted under it.
    mapping(uint80 roundId => Round round) private s_rounds;

    /// @notice The single address, besides `owner`, permitted to post an answer.
    /// @dev    `address(0)` means owner-only. Public so the keeper runbook and any monitor can read
    ///         who is authorized without a trace.
    address public operator;

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice A new answer was posted.
    /// @dev    Signature matches Chainlink's `AggregatorInterface.AnswerUpdated` exactly (same name,
    ///         same argument order, same indexing), so an indexer or dashboard already watching
    ///         Chainlink feeds ingests this one with no special case. Matching the SHAPE is a
    ///         compatibility choice and states nothing about provenance — {description} and this
    ///         contract's NatSpec carry that.
    /// @param current   The posted answer.
    /// @param roundId   The round it was posted under.
    /// @param updatedAt The block timestamp of the post.
    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    /// @notice A round was opened. Emitted alongside {AnswerUpdated} — this feed opens and completes
    ///         a round in the same call.
    /// @param roundId   The new round id.
    /// @param startedBy The address that posted it.
    /// @param startedAt The block timestamp of the post.
    event NewRound(uint256 indexed roundId, address indexed startedBy, uint256 startedAt);

    /// @notice The named operator was set, rotated, or revoked.
    /// @param previousOperator The prior operator (`address(0)` when there was none).
    /// @param newOperator      The new operator (`address(0)` revokes, leaving owner-only writes).
    event OperatorSet(address indexed previousOperator, address indexed newOperator);

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice The caller is neither the owner nor the named operator.
    /// @param caller The address that tried to post.
    error OperatorFeed__NotAuthorized(address caller);

    /// @notice The proposed answer falls outside the immutable deploy-time band.
    /// @param answer The rejected answer.
    /// @param min    The lowest accepted answer.
    /// @param max    The highest accepted answer.
    error OperatorFeed__AnswerOutOfBand(int256 answer, uint256 min, uint256 max);

    /// @notice The constructor received a band that is empty, inverted, or admits a non-positive
    ///         answer.
    /// @dev    A band whose floor is zero would permit posting `0`, which `quote()` rejects as
    ///         `Access0x1__InvalidPrice` — deploying a feed that can be driven into a permanently
    ///         un-quotable state is a misconfiguration, so it is refused at construction.
    /// @param min The proposed floor.
    /// @param max The proposed ceiling.
    error OperatorFeed__InvalidBand(uint256 min, uint256 max);

    /// @notice The constructor received a zero heartbeat.
    error OperatorFeed__ZeroHeartbeat();

    /// @notice {getRoundData} was asked for a round this feed has never posted.
    /// @param roundId The unknown round id.
    error OperatorFeed__NoRound(uint80 roundId);

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @dev Admits the owner and the named operator, and nothing else. Written as an explicit
    ///      two-way check rather than a role registry: two writers is the entire authority model, and
    ///      a reader should be able to confirm that in one line.
    modifier onlyWriter() {
        address caller = msg.sender;
        bool authorized = caller == owner() || (operator != address(0) && caller == operator);
        if (!authorized) revert OperatorFeed__NotAuthorized(caller);
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Construction
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice Deploy a feed and post its opening round in the same transaction.
    /// @dev    Posting at construction means the feed is immediately readable, and — because the
    ///         heartbeat clock starts here — immediately subject to the same staleness discipline as
    ///         every later round. The deployer becomes `owner`; grant the keeper's hot key via
    ///         {setOperator} straight after, and never hand the keeper this constructor's owner key.
    /// @param decimals_      The answer scale (8 for the Chainlink USD convention).
    /// @param description_   The pair label; state the provenance in it (see {DeployArcOperatorFeed}).
    /// @param initialAnswer_ The opening answer, which must sit inside the band.
    /// @param minAnswer_     The immutable floor for every answer, strictly positive.
    /// @param maxAnswer_     The immutable ceiling for every answer, at or above the floor.
    /// @param heartbeat_     The declared refresh cadence in seconds, strictly positive.
    /// @param owner_         The cold key that may rotate the operator and post answers.
    constructor(
        uint8 decimals_,
        string memory description_,
        int256 initialAnswer_,
        uint256 minAnswer_,
        uint256 maxAnswer_,
        uint256 heartbeat_,
        address owner_
    ) Ownable(owner_) {
        // A zero `owner_` is already refused by `Ownable`'s own `OwnableInvalidOwner` before this
        // body runs, so a duplicate zero-address check here would be unreachable.
        if (minAnswer_ == 0 || maxAnswer_ < minAnswer_) {
            revert OperatorFeed__InvalidBand(minAnswer_, maxAnswer_);
        }
        if (heartbeat_ == 0) revert OperatorFeed__ZeroHeartbeat();

        i_decimals = decimals_;
        i_minAnswer = minAnswer_;
        i_maxAnswer = maxAnswer_;
        i_heartbeat = heartbeat_;
        s_description = description_;

        _post(initialAnswer_);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice Grant, rotate, or revoke the named operator.
    /// @dev    Owner-only, and the ONLY authority change this contract has. Passing `address(0)`
    ///         revokes, which leaves the owner as the sole writer — the correct move the moment a
    ///         keeper key is suspected, and it takes effect in the same block.
    /// @param newOperator The keeper's hot key, or `address(0)` to revoke.
    function setOperator(address newOperator) external onlyOwner {
        address previous = operator;
        operator = newOperator;
        emit OperatorSet(previous, newOperator);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Posting
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice Post a fresh answer, opening and completing a new round at the current timestamp.
    /// @dev    THE function the keeper calls, and the one the predecessor mock left unguarded. Callable
    ///         by the owner or the named operator; every other caller reverts
    ///         {OperatorFeed__NotAuthorized}. The answer is band-checked before it is written, so a
    ///         rejected post leaves the previous round intact and readable — a refused update never
    ///         degrades the feed, it just lets it age toward the router's staleness cliff.
    /// @param answer The new answer at `decimals()` scale, inside the deploy-time band.
    /// @return roundId The round id the answer was posted under.
    function updateAnswer(int256 answer) external onlyWriter returns (uint80 roundId) {
        return _post(answer);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // AggregatorV3Interface
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc AggregatorV3Interface
    /// @dev The router divides by `10 ** feedDecimals` inside `quote()`, reading this live.
    function decimals() external view override returns (uint8) {
        return i_decimals;
    }

    /// @inheritdoc AggregatorV3Interface
    /// @dev The provenance label. Deployments state "operator feed" here on purpose, so the
    ///      non-Chainlink origin is visible from a block explorer's read tab.
    function description() external view override returns (string memory) {
        return s_description;
    }

    /// @inheritdoc AggregatorV3Interface
    /// @dev Deliberately `0`, matching no Chainlink aggregator version. A consumer that gates on a
    ///      real aggregator version SHOULD reject this contract, and returning a plausible number
    ///      would defeat that. The honest answer is the useful one.
    function version() external pure override returns (uint256) {
        return 0;
    }

    /// @inheritdoc AggregatorV3Interface
    /// @dev Answers historical rounds from storage rather than echoing the latest one. An unknown
    ///      round reverts {OperatorFeed__NoRound} — the same posture as Chainlink's aggregator, which
    ///      reverts rather than returning an empty tuple a caller could mistake for a real round.
    ///      `answeredInRound` equals `roundId` for every round: this feed never carries an answer
    ///      forward from an earlier round.
    function getRoundData(uint80 roundId_)
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        Round memory round = s_rounds[roundId_];
        if (round.updatedAt == 0) revert OperatorFeed__NoRound(roundId_);
        return (roundId_, round.answer, round.updatedAt, round.updatedAt, roundId_);
    }

    /// @inheritdoc AggregatorV3Interface
    /// @dev The read {OracleLib} guards on the router's behalf. `updatedAt` is the honest post time,
    ///      never refreshed by a read, which is precisely what lets an unattended feed fail closed.
    function latestRoundData()
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        uint80 roundId_ = s_latestRoundId;
        Round memory round = s_rounds[roundId_];
        return (roundId_, round.answer, round.updatedAt, round.updatedAt, roundId_);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Keeper reads
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice The declared refresh cadence in seconds.
    /// @return The immutable heartbeat set at deployment.
    function heartbeat() external view returns (uint256) {
        return i_heartbeat;
    }

    /// @notice The accepted answer band, for a monitor that wants to state the blast radius of the
    ///         operator key.
    /// @return min The immutable floor.
    /// @return max The immutable ceiling.
    function answerBand() external view returns (uint256 min, uint256 max) {
        return (i_minAnswer, i_maxAnswer);
    }

    /// @notice Seconds elapsed since the latest round was posted.
    /// @dev    The keeper's primary read. Compare it against {heartbeat} to decide whether a refresh
    ///         is due, instead of tracking cadence off-chain.
    /// @return The age of the latest answer in seconds.
    function secondsSinceUpdate() public view returns (uint256) {
        // Comparing against block.timestamp IS the age measurement; minute-scale validator drift is
        // immaterial against an hour-scale heartbeat (Slither timestamp ack).
        // slither-disable-next-line timestamp
        return block.timestamp - s_rounds[s_latestRoundId].updatedAt;
    }

    /// @notice Whether the latest answer has aged past the declared heartbeat.
    /// @dev    Advisory. The binding staleness decision belongs to the router's window via
    ///         {OracleLib}; this crossing to `true` means the keeper is LATE, not that the router has
    ///         already begun refusing quotes — the point of a heartbeat shorter than the router's
    ///         window is exactly that gap.
    /// @return True once the latest answer is older than {heartbeat}.
    function isStale() external view returns (bool) {
        return secondsSinceUpdate() > i_heartbeat;
    }

    /// @notice The latest round id.
    /// @return The id the most recent answer was posted under.
    function latestRound() external view returns (uint80) {
        return s_latestRoundId;
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @dev The single write path, shared by the constructor and {updateAnswer} so the band check and
    ///      the event pair can never diverge between the opening round and every later one. The cast
    ///      to `uint256` is reached only after `answer > 0` is proven, so it can never wrap.
    /// @param answer The answer to post.
    /// @return roundId The id assigned to the new round.
    function _post(int256 answer) private returns (uint80 roundId) {
        if (answer <= 0) revert OperatorFeed__AnswerOutOfBand(answer, i_minAnswer, i_maxAnswer);
        // `answer > 0` is enforced on the line above, so this int256 -> uint256 cast cannot wrap.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 scaled = uint256(answer);
        if (scaled < i_minAnswer || scaled > i_maxAnswer) {
            revert OperatorFeed__AnswerOutOfBand(answer, i_minAnswer, i_maxAnswer);
        }

        roundId = s_latestRoundId + 1;
        s_latestRoundId = roundId;
        s_rounds[roundId] = Round({ answer: answer, updatedAt: block.timestamp });

        emit NewRound(roundId, msg.sender, block.timestamp);
        emit AnswerUpdated(answer, roundId, block.timestamp);
    }
}
