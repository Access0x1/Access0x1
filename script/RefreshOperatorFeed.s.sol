// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import { OperatorFeed } from "../src/OperatorFeed.sol";

/// @title  RefreshOperatorFeed
/// @author Access0x1
/// @notice THE KEEPER. Posts a fresh answer to an {OperatorFeed} whenever the current one has aged
///         past the refresh threshold, and does nothing at all otherwise. Built to be run by a cron
///         at a cadence several times finer than the feed's heartbeat: most runs are a pure read that
///         broadcasts nothing, and the occasional run that finds the answer due posts one transaction.
///
/// @dev    ⚠ THE DANGER THIS SCRIPT EXISTS TO AVOID — READ THIS FIRST.
///
///         The whole Path A design leans on ONE mechanism: staleness. An UNATTENDED feed refuses
///         payments, because `updatedAt` stops advancing, {OracleLib} reverts `OracleLib__StalePrice()`
///         and `quote()` aborts the payment before value moves. That sentence is scoped to the
///         UNATTENDED case and it is the only case it covers.
///
///         An ATTENDED feed has the opposite exposure, and a keeper is exactly what makes a feed
///         attended. A keeper that re-posts a number it did not measure refreshes `updatedAt` on every
///         tick, so the answer is forever fresh in TIME and arbitrarily wrong in SUBSTANCE — and the
///         staleness guard, the single mechanism the design leans on, is precisely what such a keeper
///         defeats. Nothing downstream catches it: the router's band bounds a MALICIOUS operator, and
///         a constant poster stays inside any band containing the peg. Every payment then settles at
///         the posted number, and the merchant absorbs the whole divergence, silently, forever.
///
///         So this script REFUSES to invent a number. It has NO default answer. It runs in exactly two
///         modes, and an unconfigured run reverts rather than posting a peg assumption:
///
///           • SOURCE mode (the one the cron should use). Set `OPERATOR_FEED_SOURCE_RPC` +
///             `OPERATOR_FEED_SOURCE` and the keeper forks the source chain, reads a REAL Chainlink
///             aggregator's `latestRoundData()`, rescales it to the destination feed's decimals, and
///             posts THAT. The number tracks the market because a decentralized oracle network
///             measured it.
///           • MANUAL mode (attended operation only). `OPERATOR_FEED_ANSWER` supplies one explicit
///             number for one deliberate post. Every run prints a loud banner naming the exposure.
///             A cron running MANUAL mode is the failure described above — never install one.
///
///         WHAT `updatedAt` ATTESTS, EXACTLY. The {OperatorFeed} timestamp is the POSTING time on the
///         destination chain, never the measurement time on the source chain. SOURCE mode therefore
///         bounds the source's own age separately, against `OPERATOR_FEED_SOURCE_MAX_AGE`, and prints
///         it on every run. A source answer older than that limit is REFUSED — the keeper posts
///         nothing, the destination feed ages out, and the rail closes. Fail-closed on both legs.
///
///         PICKING `OPERATOR_FEED_SOURCE_MAX_AGE`. Use the SOURCE feed's published heartbeat plus a
///         grace margin, never {OracleLib}'s 3600s default. Chainlink's own reference data directory
///         gives Ethereum Sepolia USDC/USD (`0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E`) a heartbeat
///         of 86400s and a 1% deviation threshold, and the last six rounds read on-chain 2026-08-23
///         landed 86412–86436s apart — running slightly PAST the nominal heartbeat, so the bare
///         86400 leaves a daily gap in which the source is refused. 90000s (86400 + 1h grace) is
///         the honest limit for that source, and the default here. {OracleLib}'s 3600s in this slot
///         would close the rail roughly 23 hours a day.
///
///         WHAT MAKES THIS SAFE TO LEAVE UNATTENDED — the failure mode is a REFUSED payment, never a
///         payment settled at a wrong price. Three layers, in order:
///
///           • The keeper stops → `updatedAt` stops advancing. Nothing freezes the old answer into
///             place as "still valid"; the timestamp simply ages.
///           • The age crosses the router's window for that token → {OracleLib} reverts
///             `OracleLib__StalePrice()` inside `quote()`.
///           • `quote()` reverting aborts `payNative` / `payToken` before any value moves, because the
///             router reads the feed IN the settlement transaction rather than from a cached preview.
///
///         So an outage closes the rail on that chain. Loud, visible, and correct — the alternative,
///         settling against an hours-old peg assumption, is the outcome this whole design refuses.
///
///         CADENCE, and where each number comes from. The feed publishes its own `heartbeat()`, so
///         this script never hardcodes one. The default refresh threshold is HALF the heartbeat, which
///         with the Arc deployment's 1800s heartbeat means a post roughly every 15 minutes of elapsed
///         staleness against a router window of 3600s. That is a 4× margin: three consecutive missed
///         cron runs still leave the feed inside the router's window.
///
///         RECOMMENDED CRON: every 5 minutes. Finer than the threshold on purpose — a run that finds
///         the answer fresh costs one `eth_call` and exits, so over-scheduling is nearly free while
///         under-scheduling is what walks the rail into the cliff.
///
///         THE KEY IT WANTS. Broadcast with the OPERATOR key, never the owner key. {OperatorFeed}
///         separates the two precisely so a cron can hold a hot key that can post an answer inside the
///         immutable band and can do nothing else — no authority rotation, no band change, no funds.
///
///         ENV:
///           OPERATOR_FEED                (address, REQUIRED) the feed to refresh
///           OPERATOR_FEED_SOURCE_RPC     (string)  source-chain RPC URL      ─┐ SOURCE mode
///           OPERATOR_FEED_SOURCE         (address) source Chainlink feed     ─┘ set BOTH
///           OPERATOR_FEED_SOURCE_MAX_AGE (uint, default 90000) source heartbeat + grace
///           OPERATOR_FEED_ANSWER         (int, NO DEFAULT) MANUAL mode, one explicit answer
///           OPERATOR_FEED_REFRESH_AT     (uint, default heartbeat/2) age in seconds that triggers a post
///
///         USAGE (read-only preview, no key, no broadcast — run this first):
///           make refresh-operator-feed-dry RPC=$ARC_TESTNET_RPC_URL FEED=<addr>
///         USAGE (the cron):
///           make refresh-operator-feed-arc FEED=<addr>
contract RefreshOperatorFeed is Script {
    /// @dev The source-age limit used when `OPERATOR_FEED_SOURCE_MAX_AGE` is unset: Ethereum Sepolia
    ///      USDC/USD's 86400s published heartbeat plus a 3600s grace margin. Deliberately NOT
    ///      {OracleLib}'s 3600s, which no 24h-heartbeat feed can ever satisfy.
    uint256 internal constant DEFAULT_SOURCE_MAX_AGE = 90_000;

    /// @notice The refusal a keeper sees when it is due to post and no price source is configured.
    /// @dev    `public` so the unit suite asserts against THIS string rather than a copy that can
    ///         drift. The refusal itself is the fix for the constant-poster exposure: no default
    ///         answer exists, so an unconfigured cron stops instead of quietly re-posting a peg.
    string public constant NO_SOURCE_CONFIGURED = "RefreshOperatorFeed: no price source. Set OPERATOR_FEED_SOURCE_RPC + OPERATOR_FEED_SOURCE"
        " for SOURCE mode, or OPERATOR_FEED_ANSWER for one attended MANUAL post - this script posts"
        " no default, because a cron re-posting an unmeasured peg underpays the merchant every time.";

    /// @notice The refusal for an answer the destination feed's immutable band would reject.
    string public constant ANSWER_OUT_OF_BAND =
        "RefreshOperatorFeed: answer outside the feed's immutable band";

    /// @notice Read the feed's age and post a fresh answer once it has passed the threshold.
    /// @dev    Returns the decision rather than reverting on "not due", so a cron treats a no-op run
    ///         as success and only a genuine failure as a failure. A `--broadcast` run that finds the
    ///         answer fresh sends no transaction and spends no gas. A run that finds the answer DUE
    ///         and has no configured price source REVERTS — refusing to post beats posting a guess.
    /// @return posted  True once a new answer was broadcast.
    /// @return ageSecs The age of the answer at the moment of the read.
    function run() external returns (bool posted, uint256 ageSecs) {
        OperatorFeed feed = OperatorFeed(vm.envAddress("OPERATOR_FEED"));

        uint256 heartbeat = feed.heartbeat();
        string memory refreshAtRaw = _env("OPERATOR_FEED_REFRESH_AT");
        uint256 refreshAt =
            bytes(refreshAtRaw).length == 0 ? heartbeat / 2 : vm.parseUint(refreshAtRaw);
        ageSecs = feed.secondsSinceUpdate();

        console2.log("==> OperatorFeed  :", address(feed));
        console2.log("    heartbeat     :", heartbeat, "s");
        console2.log("    refresh after :", refreshAt, "s");
        console2.log("    current age   :", ageSecs, "s");

        if (ageSecs < refreshAt) {
            console2.log("    decision      : FRESH - no transaction sent.");
            return (false, ageSecs);
        }

        int256 answer = _resolveAnswer(feed.decimals());
        _requireInBand(feed, answer);

        vm.startBroadcast();
        uint80 roundId = feed.updateAnswer(answer);
        vm.stopBroadcast();

        posted = true;
        console2.log("    decision      : REFRESHED");
        console2.log("    new round     :", roundId);
        console2.log("    posted answer :", vm.toString(answer));
    }

    /// @notice Rescale a price answer between two decimal conventions.
    /// @dev    `public` so the unit suite exercises it directly. A down-scale truncates, which costs at
    ///         most one unit of the destination scale (1e-8 of a dollar at the Chainlink USD
    ///         convention) — orders of magnitude inside any sane band, and always downward, never
    ///         upward into a merchant-underpaying overstatement.
    /// @param answer        The answer at `fromDecimals` scale.
    /// @param fromDecimals  The source scale.
    /// @param toDecimals    The destination scale.
    /// @return The same value expressed at `toDecimals` scale.
    function rescale(int256 answer, uint8 fromDecimals, uint8 toDecimals)
        public
        pure
        returns (int256)
    {
        if (fromDecimals == toDecimals) return answer;
        if (fromDecimals < toDecimals) {
            return answer * int256(10 ** uint256(toDecimals - fromDecimals));
        }
        return answer / int256(10 ** uint256(fromDecimals - toDecimals));
    }

    /// @notice Produce the answer to post, from a real source feed or from one explicit override.
    /// @dev    THE REFUSAL LIVES HERE. No default answer exists anywhere in this script, so a cron
    ///         installed without a source cannot quietly re-post a peg assumption — it reverts on the
    ///         first run that finds the answer due, which is loud, immediate, and fixable.
    /// @param destDecimals The destination feed's scale, read on-chain.
    /// @return The answer at `destDecimals` scale.
    function _resolveAnswer(uint8 destDecimals) private returns (int256) {
        string memory sourceRpc = _env("OPERATOR_FEED_SOURCE_RPC");
        string memory sourceRaw = _env("OPERATOR_FEED_SOURCE");

        if (bytes(sourceRpc).length != 0 && bytes(sourceRaw).length != 0) {
            return _readSource(sourceRpc, vm.parseAddress(sourceRaw), destDecimals);
        }

        string memory manualRaw = _env("OPERATOR_FEED_ANSWER");
        require(bytes(manualRaw).length != 0, NO_SOURCE_CONFIGURED);

        int256 manual = vm.parseInt(manualRaw);
        console2.log(
            "    !! MANUAL MODE - this answer tracks NO market and was measured by nobody."
        );
        console2.log(
            "    !! Correct for one attended post. A CRON in this mode silently mis-settles."
        );
        console2.log("    manual answer :", vm.toString(manual));
        return manual;
    }

    /// @notice Fork the source chain, read a real Chainlink aggregator, and rescale its answer.
    /// @dev    Every guard here fails CLOSED by reverting, so a bad or dark source produces NO post,
    ///         the destination feed ages out, and the rail closes. The fork is selected back to the
    ///         destination before returning, so the caller's broadcast lands on the right chain.
    /// @param sourceRpc    RPC URL of the chain carrying the source feed.
    /// @param source       The source `AggregatorV3Interface`.
    /// @param destDecimals The destination feed's scale.
    /// @return The source answer, rescaled to `destDecimals`.
    function _readSource(string memory sourceRpc, address source, uint8 destDecimals)
        private
        returns (int256)
    {
        string memory maxAgeRaw = _env("OPERATOR_FEED_SOURCE_MAX_AGE");
        uint256 maxSourceAge =
            bytes(maxAgeRaw).length == 0 ? DEFAULT_SOURCE_MAX_AGE : vm.parseUint(maxAgeRaw);

        uint256 destFork = vm.activeFork();
        vm.createSelectFork(sourceRpc);

        AggregatorV3Interface src = AggregatorV3Interface(source);
        uint8 srcDecimals = src.decimals();
        string memory srcDescription = src.description();
        (uint80 roundId, int256 srcAnswer,, uint256 srcUpdatedAt, uint80 answeredInRound) =
            src.latestRoundData();
        uint256 srcAge = block.timestamp > srcUpdatedAt ? block.timestamp - srcUpdatedAt : 0;

        vm.selectFork(destFork);

        console2.log("    source feed   :", source);
        console2.log("    source desc   :", srcDescription);
        console2.log("    source answer :", vm.toString(srcAnswer));
        console2.log("    source age    :", srcAge, "s");

        require(
            srcUpdatedAt != 0 && answeredInRound >= roundId,
            "RefreshOperatorFeed: source round incomplete"
        );
        require(srcAnswer > 0, "RefreshOperatorFeed: source answer is not positive");
        require(
            srcAge <= maxSourceAge,
            "RefreshOperatorFeed: source answer older than the configured limit"
        );

        return rescale(srcAnswer, srcDecimals, destDecimals);
    }

    /// @notice Read an env var as a string, treating UNSET and SET-BUT-EMPTY as the same thing.
    /// @dev    Every optional key here goes through this. `.env.example` ships each one as a bare
    ///         `KEY=`, so an owner who copies the template has them all SET to the empty string:
    ///         `vm.envExists` then answers true and the typed `vm.envOr` overloads try to parse `""`
    ///         and blow up on a cryptic decode error. Collapsing both cases to "absent" makes the
    ///         template safe to copy and keeps the ONE refusal the operator needs to read —
    ///         {NO_SOURCE_CONFIGURED} — the message they actually get.
    /// @param key The environment variable name.
    /// @return Its value, or the empty string when unset or empty.
    function _env(string memory key) private view returns (string memory) {
        return vm.envOr(key, string(""));
    }

    /// @notice Refuse an answer the destination feed would reject anyway, with a readable reason.
    /// @dev    {OperatorFeed} enforces its immutable band on-chain regardless; this pre-check turns a
    ///         raw `OperatorFeed__AnswerOutOfBand` inside a broadcast into a named refusal before any
    ///         gas is spent. Fail-closed either way — the band is never widened here.
    /// @param feed   The destination feed.
    /// @param answer The answer about to be posted.
    function _requireInBand(OperatorFeed feed, int256 answer) private view {
        (uint256 minAnswer, uint256 maxAnswer) = feed.answerBand();
        require(answer > 0, "RefreshOperatorFeed: answer is not positive");
        require(uint256(answer) >= minAnswer && uint256(answer) <= maxAnswer, ANSWER_OUT_OF_BAND);
    }
}
