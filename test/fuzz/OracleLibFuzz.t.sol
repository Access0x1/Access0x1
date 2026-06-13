// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { stdError } from "forge-std/StdError.sol";
import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import { OracleLib } from "../../src/libraries/OracleLib.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";

/// @title  OracleLibFuzz — STATELESS fuzz of the Chainlink staleness guard
/// @author Access0x1
/// @notice The Cyfrin stateless-fuzz layer for {OracleLib}: every run forges a fresh, fully-settable
///         round on {MockV3Aggregator} with `bound()`-constrained inputs and asserts the guard's three
///         decision invariants hold PER CALL, for any round the network could ever serve:
///
///           (1) PASS-THROUGH IS LOSSLESS — when the round is accepted, the tuple returned by
///               `staleCheckLatestRoundData` is byte-for-byte the feed's `latestRoundData`. The guard
///               only gates; it must never rewrite, clamp, or sanitize a value (the caller's `quote()`
///               math depends on the raw answer + decimals).
///           (2) THE ACCEPT PREDICATE IS EXACTLY THE SPEC — a round is accepted IFF
///               `updatedAt != 0 && answeredInRound >= roundId && block.timestamp - updatedAt <= TIMEOUT`.
///               Anything else MUST revert with `OracleLib__StalePrice` and nothing else.
///           (3) ANSWER-SIGN IS NOT THE GUARD'S BUSINESS — the guard accepts/reverts identically for a
///               positive, zero, or NEGATIVE answer. Validity (`answer > 0`) is documented as the
///               caller's job; this proves the library never silently absorbs that responsibility.
///
/// @dev    {OracleLib} is `internal` (it inlines into the router, no standalone address), so it is
///         exercised through the same one-line {OracleLibHarness} the unit suite uses — the library is
///         used exactly as `quote()` uses it. There is NO money math in {OracleLib} itself (it is a pure
///         read-guard), so the "net + fee == gross / no negative balance / zero residual custody"
///         money-invariants do not apply at this layer — they are proven where the money moves (the
///         Router fuzz/invariant suites). The invariant that DOES belong here is the guard's accept/revert
///         decision, fuzzed across the full round space; that is what this file pins down.
contract OracleLibFuzzHarness {
    using OracleLib for AggregatorV3Interface;

    /// @dev The router's exact call shape: take the guarded answer, drop the rest.
    function check(AggregatorV3Interface feed) external view returns (int256 answer) {
        (, answer,,,) = feed.staleCheckLatestRoundData();
    }

    /// @dev The full guarded tuple, so a test can prove pass-through is byte-for-byte lossless.
    function checkFull(AggregatorV3Interface feed)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 air)
    {
        return feed.staleCheckLatestRoundData();
    }
}

contract OracleLibFuzzTest is Test {
    /// @notice Mirrors the library's private `TIMEOUT` (1 hour) — the only literal the guard branches on.
    uint256 internal constant TIMEOUT = 3600;

    /// @notice A realistic, non-zero "now" so subtracting a fuzzed `updatedAt` is meaningful and never
    ///         underflows the test's own arithmetic; `setUp` warps here before every run.
    uint256 internal constant NOW = 1_700_000_000;

    uint8 internal constant DECIMALS = 8;

    MockV3Aggregator internal feed;
    OracleLibFuzzHarness internal harness;

    function setUp() public {
        vm.warp(NOW);
        feed = new MockV3Aggregator(DECIMALS, 2000e8);
        harness = new OracleLibFuzzHarness();
    }

    /// @dev The single source of truth for "should this round be accepted?", computed the same way the
    ///      library does — used by every fuzz body to decide whether to expect a value or a revert.
    function _accepts(uint80 roundId, uint256 updatedAt, uint80 answeredInRound)
        internal
        view
        returns (bool)
    {
        if (updatedAt == 0) return false;
        if (answeredInRound < roundId) return false;
        if (block.timestamp - updatedAt > TIMEOUT) return false;
        return true;
    }

    /*//////////////////////////////////////////////////////////////
            (2) THE ACCEPT PREDICATE IS EXACTLY THE SPEC
    //////////////////////////////////////////////////////////////*/

    /// @notice Fuzz the WHOLE round 5-tuple across its full meaningful space and assert the guard's
    ///         decision matches the spec predicate on EVERY input: a round is accepted iff it is
    ///         completed (`updatedAt != 0`), not carried-over (`answeredInRound >= roundId`), and fresh
    ///         (`age <= TIMEOUT`); otherwise it reverts with exactly `OracleLib__StalePrice`. This is the
    ///         master stateless invariant — it subsumes the hand-written unit cases as fuzzed corners.
    function testFuzz_guardDecisionMatchesSpec(
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) public {
        // Bound updatedAt to [0, NOW + 2*TIMEOUT] so we span: never-completed (0), fresh, exactly-at-
        // timeout, just-past-timeout, and future timestamps — without underflowing the guard's
        // `block.timestamp - updatedAt` (which would itself revert on a future updatedAt under 0.8.x).
        // We keep updatedAt <= block.timestamp for the arithmetic path the library actually takes, then
        // cover the future-timestamp corner in its own dedicated test below.
        updatedAt = bound(updatedAt, 0, NOW);
        feed.setRoundData(roundId, answer, startedAt, updatedAt, answeredInRound);

        bool shouldPass = _accepts(roundId, updatedAt, answeredInRound);
        if (shouldPass) {
            // Accepted: returns the feed's raw answer, untouched.
            assertEq(
                harness.check(_feed()), answer, "accepted round must return the raw feed answer"
            );
        } else {
            // Rejected: exactly OracleLib__StalePrice, never an opaque/other revert.
            vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
            harness.check(_feed());
        }
    }

    /// @notice Among FRESH, COMPLETED rounds, the carried-over guard is exactly `answeredInRound >=
    ///         roundId`: fuzz the two round ids independently (answer fresh + completed) and assert
    ///         accept iff `answeredInRound >= roundId`. Isolates branch (answeredInRound < roundId) from
    ///         the staleness branch so a regression in either can't hide behind the other.
    function testFuzz_carriedOverGuardIsExact(uint80 roundId, uint80 answeredInRound) public {
        feed.setRoundData(roundId, 2000e8, block.timestamp, block.timestamp, answeredInRound);

        if (answeredInRound >= roundId) {
            assertEq(harness.check(_feed()), 2000e8, "non-carried fresh round must pass");
        } else {
            vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
            harness.check(_feed());
        }
    }

    /// @notice The staleness boundary, fuzzed: with a completed, non-carried round, accept iff the age
    ///         is `<= TIMEOUT`. `age == TIMEOUT` passes, `age == TIMEOUT + 1` reverts — the `>` in the
    ///         guard is strict, so the boundary is inclusive on the accept side. Bounds the age so both
    ///         sides of the threshold are hit with high probability across runs.
    function testFuzz_stalenessBoundaryIsExact(uint256 age) public {
        age = bound(age, 0, 2 * TIMEOUT);
        uint256 updatedAt = block.timestamp - age; // NOW is large, so this never underflows
        feed.setRoundData(7, 2000e8, updatedAt, updatedAt, 7);

        if (age <= TIMEOUT) {
            assertEq(harness.check(_feed()), 2000e8, "round at or under the 1h window must pass");
        } else {
            vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
            harness.check(_feed());
        }
    }

    /*//////////////////////////////////////////////////////////////
            (1) PASS-THROUGH IS LOSSLESS
    //////////////////////////////////////////////////////////////*/

    /// @notice For ANY accepted round, the guard returns the feed's 5-tuple byte-for-byte — it gates
    ///         entry but must never mutate a field (the router's decimals/answer math depends on raw
    ///         values). Fuzz an arbitrary completed, non-carried, fresh round and assert all five
    ///         returned fields equal the inputs we set.
    function testFuzz_acceptedRoundIsReturnedUnmodified(
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 age
    ) public {
        roundId = uint80(bound(roundId, 1, type(uint80).max)); // any valid round
        age = bound(age, 0, TIMEOUT); // guaranteed fresh
        uint256 updatedAt = block.timestamp - age;
        // answeredInRound == roundId keeps it non-carried; the accepted path is what we assert on.
        feed.setRoundData(roundId, answer, startedAt, updatedAt, roundId);

        (uint80 rRound, int256 rAnswer, uint256 rStarted, uint256 rUpdated, uint80 rAir) =
            harness.checkFull(_feed());

        assertEq(rRound, roundId, "roundId must pass through unmodified");
        assertEq(rAnswer, answer, "answer must pass through unmodified");
        assertEq(rStarted, startedAt, "startedAt must pass through unmodified");
        assertEq(rUpdated, updatedAt, "updatedAt must pass through unmodified");
        assertEq(rAir, roundId, "answeredInRound must pass through unmodified");
    }

    /*//////////////////////////////////////////////////////////////
            (3) ANSWER-SIGN IS NOT THE GUARD'S BUSINESS
    //////////////////////////////////////////////////////////////*/

    /// @notice The guard's accept/revert decision is INDEPENDENT of the answer's sign: with a fresh,
    ///         completed, non-carried round, a positive, zero, OR negative fuzzed answer is accepted and
    ///         returned verbatim. This pins the single-responsibility contract in the NatSpec — OracleLib
    ///         does staleness ONLY; it must never start filtering on `answer <= 0` (that is `quote()`'s
    ///         `Access0x1__InvalidPrice` job, and proven there). A regression that "helpfully" rejected a
    ///         non-positive answer here would silently change the router's error semantics.
    function testFuzz_answerSignIsIgnoredByGuard(int256 answer) public {
        feed.setRoundData(3, answer, block.timestamp, block.timestamp, 3); // fresh + completed + non-carried
        assertEq(harness.check(_feed()), answer, "guard must return any-sign answer untouched");
    }

    /// @notice A round whose `updatedAt` is in the FUTURE (clock skew / a misbehaving feed) makes
    ///         `block.timestamp - updatedAt` underflow; under Solidity 0.8.x that is a panic (0x11),
    ///         NOT `OracleLib__StalePrice`. This documents the guard's real behavior at that corner —
    ///         the library does not pre-check for a future timestamp, so the subtraction is what fires.
    ///         Pinning it here means a future change that DID add a future-timestamp branch would have to
    ///         update this test consciously, rather than silently altering the revert class quote() sees.
    function testFuzz_futureUpdatedAtPanicsNotStale(uint256 ahead) public {
        ahead = bound(ahead, 1, 10_000);
        uint256 updatedAt = block.timestamp + ahead; // strictly in the future
        feed.setRoundData(9, 2000e8, block.timestamp, updatedAt, 9);

        vm.expectRevert(stdError.arithmeticError); // 0x11 underflow, not the typed stale error
        harness.check(_feed());
    }

    function _feed() internal view returns (AggregatorV3Interface) {
        return AggregatorV3Interface(address(feed));
    }
}
