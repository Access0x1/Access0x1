// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import { OracleLib } from "../../src/libraries/OracleLib.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";

/// @dev OracleLib's guard is `internal` (it inlines into the router), so it is exercised through the
///      same thin harness the main unit suite uses — one external entrypoint that calls the library
///      exactly as `quote()` does.
contract OracleLibEdgeHarness {
    using OracleLib for AggregatorV3Interface;

    function check(AggregatorV3Interface feed) external view returns (int256 answer) {
        (, answer,,,) = feed.staleCheckLatestRoundData();
    }

    /// @dev The full guarded tuple — lets an edge test assert pass-through fidelity on a boundary round.
    function checkFull(AggregatorV3Interface feed)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 air)
    {
        return feed.staleCheckLatestRoundData();
    }
}

/// @title  OracleLibEdge — the boundary / single-responsibility cases the main unit suite omits
/// @author Access0x1
/// @notice {OracleLib.t.sol} covers the happy path, the three revert branches, and the `age == TIMEOUT`
///         accept boundary. This file adds the deterministic CORNERS an auditor would still want pinned,
///         each isolating ONE decision so a regression cannot hide behind a second failing condition:
///
///           - `answeredInRound == roundId` (the carried-over boundary on the ACCEPT side).
///           - `age == 0` (updatedAt is exactly `block.timestamp` — the freshest possible round).
///           - `age == TIMEOUT - 1` (one second inside the window — the accept side neighbour of the
///             `age == TIMEOUT` boundary the main suite already pins).
///           - NEGATIVE and ZERO answers pass the guard untouched (OracleLib does staleness ONLY;
///             `answer > 0` is the caller's `quote()` job — the library must never absorb it).
///           - the guard's PASS-THROUGH is byte-for-byte for an accepted round (no field is rewritten).
///           - precedence: when BOTH a completed-round failure (updatedAt == 0) and freshness are at
///             play, the typed `OracleLib__StalePrice` is what surfaces (never an underflow panic).
contract OracleLibEdgeTest is Test {
    MockV3Aggregator internal feed;
    OracleLibEdgeHarness internal harness;

    uint8 internal constant DECIMALS = 8;
    int256 internal constant PRICE = 2000e8;
    uint256 internal constant TIMEOUT = 3600;

    function setUp() public {
        vm.warp(1_700_000_000); // a realistic, non-zero "now" so the freshness window is meaningful
        feed = new MockV3Aggregator(DECIMALS, PRICE);
        harness = new OracleLibEdgeHarness();
    }

    function _feed() internal view returns (AggregatorV3Interface) {
        return AggregatorV3Interface(address(feed));
    }

    /// @notice Carried-over boundary on the ACCEPT side: `answeredInRound == roundId` is NOT carried over
    ///         (the guard reverts only when `answeredInRound < roundId`), so an otherwise-fresh round at
    ///         the boundary passes. Pins the inclusive edge of the completed-round guard.
    function test_answeredInRoundEqualRoundIdPasses() public {
        feed.setRoundData(9, PRICE, block.timestamp, block.timestamp, 9); // air == roundId
        assertEq(harness.check(_feed()), PRICE, "answeredInRound == roundId must be accepted");
    }

    /// @notice The freshest possible round: `updatedAt == block.timestamp` ⇒ age 0 ⇒ accepted. Guards
    ///         against an off-by-one that treated a zero-age round as "not yet valid".
    function test_zeroAgeRoundPasses() public {
        feed.setRoundData(1, PRICE, block.timestamp, block.timestamp, 1); // age == 0
        assertEq(harness.check(_feed()), PRICE, "a round updated this very second must pass");
    }

    /// @notice One second INSIDE the window (`age == TIMEOUT - 1`) is accepted — the accept-side
    ///         neighbour of the `age == TIMEOUT` boundary the main suite pins, so both sides of the
    ///         strict `>` comparison are nailed down across the two files.
    function test_oneSecondInsideWindowPasses() public {
        feed.setRoundData(
            1, PRICE, block.timestamp - (TIMEOUT - 1), block.timestamp - (TIMEOUT - 1), 1
        );
        assertEq(harness.check(_feed()), PRICE, "age == TIMEOUT - 1 must pass");
    }

    /// @notice SINGLE RESPONSIBILITY — a NEGATIVE answer passes the staleness guard untouched. OracleLib
    ///         guards freshness/completeness ONLY; the NatSpec documents that `answer > 0` is the
    ///         caller's (`quote()` → `Access0x1__InvalidPrice`) job. If the library ever "helpfully"
    ///         rejected a negative answer, the router's error semantics would silently change — this
    ///         pins the contract so that regression fails loudly here.
    function test_negativeAnswerPassesGuard() public {
        feed.setRoundData(1, -1, block.timestamp, block.timestamp, 1); // fresh + completed, negative answer
        assertEq(harness.check(_feed()), -1, "guard must return a negative answer untouched");
    }

    /// @notice SINGLE RESPONSIBILITY — a ZERO answer likewise passes the guard. The zero case is the one
    ///         `quote()` would hit a div-by-zero on, which is exactly why validity is the CALLER's check;
    ///         the guard must not pre-empt it.
    function test_zeroAnswerPassesGuard() public {
        feed.setRoundData(1, 0, block.timestamp, block.timestamp, 1); // fresh + completed, zero answer
        assertEq(harness.check(_feed()), 0, "guard must return a zero answer untouched");
    }

    /// @notice An accepted round is returned BYTE-FOR-BYTE: the guard gates entry but must never rewrite
    ///         a field, because the router's decimals/answer math reads the raw tuple. Asserts all five
    ///         returned values equal the exact round we posted.
    function test_acceptedRoundPassesThroughUnmodified() public {
        uint80 roundId = 42;
        int256 answer = 1234e8;
        uint256 startedAt = block.timestamp - 100;
        uint256 updatedAt = block.timestamp - 50; // fresh (< TIMEOUT)
        uint80 air = 42; // non-carried

        feed.setRoundData(roundId, answer, startedAt, updatedAt, air);
        (uint80 rRound, int256 rAnswer, uint256 rStarted, uint256 rUpdated, uint80 rAir) =
            harness.checkFull(_feed());

        assertEq(rRound, roundId, "roundId unmodified");
        assertEq(rAnswer, answer, "answer unmodified");
        assertEq(rStarted, startedAt, "startedAt unmodified");
        assertEq(rUpdated, updatedAt, "updatedAt unmodified");
        assertEq(rAir, air, "answeredInRound unmodified");
    }

    /// @notice Precedence: when a round is BOTH never-completed (`updatedAt == 0`) AND carried-over
    ///         (`answeredInRound < roundId`), the guard still surfaces the typed `OracleLib__StalePrice`
    ///         — the `updatedAt == 0` short-circuit is checked first, so the later `block.timestamp -
    ///         updatedAt` subtraction (which on a zero updatedAt would be a huge-age stale, not a panic)
    ///         is reached through the typed-error path, never an opaque bubble. Proves the guard's error
    ///         class is stable regardless of how many conditions a malformed round trips at once.
    function test_zeroUpdatedAtAndCarriedOverRevertsStale() public {
        feed.setRoundData(5, PRICE, 0, 0, 4); // never completed AND carried over
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        harness.check(_feed());
    }
}
