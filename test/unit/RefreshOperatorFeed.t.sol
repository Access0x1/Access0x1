// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { RefreshOperatorFeed } from "../../script/RefreshOperatorFeed.s.sol";
import { OperatorFeed } from "../../src/OperatorFeed.sol";

/// @notice Unit suite for THE KEEPER — the cron that holds the Arc {OperatorFeed} fresh.
///
///         The behaviour under test is a money-path guarantee, not a convenience: a keeper that
///         re-posts a number nobody measured refreshes `updatedAt` on every tick, so the answer stays
///         forever fresh in TIME while drifting arbitrarily far in SUBSTANCE. The staleness guard —
///         the single mechanism Path A leans on — is exactly what such a keeper defeats, and every
///         payment then settles at the unmeasured number with the merchant absorbing the difference.
///         So the script carries NO default answer, and these tests pin that down.
///
/// @dev    ENV-KEY OWNERSHIP (the repo-wide race-safety convention, see DeployAll.t.sol): this ONE
///         function owns every `OPERATOR_FEED*` key, and no other test in the repo touches them.
///         Ordering inside it is load-bearing — `vm.setEnv` has no inverse, so the "no source
///         configured" refusal is asserted BEFORE `OPERATOR_FEED_ANSWER` is ever set.
contract RefreshOperatorFeedTest is Test {
    /// @dev The Arc deployment's shape: 8 dp, $1.00, ±5% band, 1800s heartbeat.
    uint8 internal constant DECIMALS = 8;
    int256 internal constant PEG = 1e8;
    uint256 internal constant BAND_MIN = 0.95e8;
    uint256 internal constant BAND_MAX = 1.05e8;
    uint256 internal constant HEARTBEAT = 1800;

    /// @dev A fixed epoch every warp is measured from, matching `PriceRelay.t.sol`. Absolute warps
    ///      only: this toolchain (forge 1.3.5-foundry-zksync-v0.1.9) silently ignores a
    ///      `vm.warp(block.timestamp + n)` issued after a contract has read `block.timestamp`, so a
    ///      relative warp would leave the clock parked and quietly weaken every age assertion below.
    uint256 internal constant T0 = 1_700_000_000;

    function test_keeperRefusesToInventAPrice_thenPostsAnExplicitOne() public {
        vm.warp(T0);
        RefreshOperatorFeed keeper = new RefreshOperatorFeed();
        OperatorFeed feed = new OperatorFeed(
            DECIMALS,
            "USDC/USD (Access0x1 operator feed, not Chainlink)",
            PEG,
            BAND_MIN,
            BAND_MAX,
            HEARTBEAT,
            address(this)
        );
        // The script broadcasts as forge's default sender, so that address is the keeper's hot key.
        feed.setOperator(DEFAULT_SENDER);
        vm.setEnv("OPERATOR_FEED", vm.toString(address(feed)));

        // NOT DUE: a fresh answer is a pure read. No transaction, no revert, and — the point — no
        // price source needed, so an over-scheduled cron stays cheap and silent.
        (bool posted, uint256 ageSecs) = keeper.run();
        assertFalse(posted, "posted while the answer was still fresh");
        assertEq(ageSecs, 0, "age of a just-deployed feed is not zero");

        // DUE, with nothing configured: the run REVERTS rather than re-posting an unmeasured peg.
        // This assertion is the whole fix — a silent `1e8` here is the merchant-underpaying hole.
        vm.warp(T0 + HEARTBEAT);
        vm.expectRevert(bytes(keeper.NO_SOURCE_CONFIGURED()));
        keeper.run();

        // DUE, with the keys SET BUT EMPTY — what an owner gets from copying `.env.example`
        // verbatim. Same refusal, not a cryptic parse error from a typed `envOr` reading "".
        vm.setEnv("OPERATOR_FEED_SOURCE_RPC", "");
        vm.setEnv("OPERATOR_FEED_SOURCE", "");
        vm.setEnv("OPERATOR_FEED_SOURCE_MAX_AGE", "");
        vm.setEnv("OPERATOR_FEED_ANSWER", "");
        vm.expectRevert(bytes(keeper.NO_SOURCE_CONFIGURED()));
        keeper.run();

        // MANUAL mode: one explicit answer posts, and it is the answer that lands on-chain.
        vm.setEnv("OPERATOR_FEED_ANSWER", "101000000"); // $1.01
        (posted, ageSecs) = keeper.run();
        assertTrue(posted, "an explicit answer did not post");
        assertEq(ageSecs, HEARTBEAT, "reported age does not match the warp");
        (, int256 onChain,, uint256 updatedAt,) = feed.latestRoundData();
        assertEq(onChain, 1.01e8, "posted answer is not the explicit one");
        assertEq(updatedAt, block.timestamp, "updatedAt is not the posting time");

        // OUT OF BAND: the keeper refuses before spending gas, and the feed keeps its last answer.
        vm.setEnv("OPERATOR_FEED_ANSWER", "120000000"); // $1.20, outside 0.95..1.05
        vm.warp(T0 + 2 * HEARTBEAT);
        vm.expectRevert(bytes(keeper.ANSWER_OUT_OF_BAND()));
        keeper.run();
        (, int256 stillOnChain,,,) = feed.latestRoundData();
        assertEq(stillOnChain, 1.01e8, "a rejected answer reached the feed");
    }

    function test_rescaleMovesAnAnswerBetweenDecimalConventions() public {
        RefreshOperatorFeed keeper = new RefreshOperatorFeed();

        // Same scale — the Sepolia USDC/USD source and the Arc feed are both 8 dp, the live case.
        assertEq(
            keeper.rescale(99_995_000, 8, 8), 99_995_000, "identity rescale changed the answer"
        );

        // Up-scale is exact.
        assertEq(keeper.rescale(1e6, 6, 8), 1e8, "6 -> 8 up-scale is wrong");

        // Down-scale truncates DOWNWARD, never upward into an overstated price.
        assertEq(keeper.rescale(999_999_999_999_999_999, 18, 8), 99_999_999, "18 -> 8 rounds up");
    }
}
