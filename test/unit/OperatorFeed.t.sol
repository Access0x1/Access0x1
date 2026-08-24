// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

import { OperatorFeed } from "../../src/OperatorFeed.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { OracleLib } from "../../src/libraries/OracleLib.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @notice Unit suite for {OperatorFeed} — the guarded replacement for the unguarded
///         `MockV3Aggregator` that was serving live USDC/USD pricing on Arc.
///
///         The suite is organized around the defect it closes. The ACCESS section proves the hole is
///         shut from every direction (stranger, revoked operator, rotated operator). The BAND section
///         proves a compromised writer's blast radius stops at the immutable deploy-time range. The
///         STALENESS section proves the feed ages honestly rather than presenting a frozen answer as
///         fresh. The ROUTER section is the one that matters most: it drives the real
///         {Access0x1Router} against this feed and shows `quote()` succeeding on a fresh answer and
///         REVERTING — never settling — once the keeper has been absent past the router's window.
/// @dev    Uses `vm.warp` to age the feed rather than a `setRoundData`-style forgery hook, which
///         {OperatorFeed} deliberately does not have. Forging arbitrary rounds stays the test mock's
///         job; a production feed that can be handed a fabricated `updatedAt` is the original bug.
contract OperatorFeedTest is Test, ProxyDeployer {
    OperatorFeed internal feed;

    address internal owner = makeAddr("feedOwner");
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");

    uint8 internal constant DECIMALS = 8;
    string internal constant DESCRIPTION = "USDC/USD (Access0x1 operator feed, not Chainlink)";
    int256 internal constant PEG = 1e8;
    uint256 internal constant BAND_MIN = 0.95e8;
    uint256 internal constant BAND_MAX = 1.05e8;
    uint256 internal constant HEARTBEAT = 1800;

    /// @dev A realistic wall-clock start, so `block.timestamp - updatedAt` arithmetic is never
    ///      exercised against the genesis timestamp of 1.
    uint256 internal constant T0 = 1_700_000_000;

    function setUp() public {
        vm.warp(T0);
        feed = new OperatorFeed(DECIMALS, DESCRIPTION, PEG, BAND_MIN, BAND_MAX, HEARTBEAT, owner);
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_constructorPostsOpeningRoundAndDescribesItself() public view {
        assertEq(feed.owner(), owner, "owner not set");
        assertEq(feed.operator(), address(0), "operator should start unset");
        assertEq(feed.decimals(), DECIMALS, "decimals");
        assertEq(feed.description(), DESCRIPTION, "description");
        assertEq(feed.heartbeat(), HEARTBEAT, "heartbeat");
        assertEq(feed.latestRound(), 1, "opening round should be 1");

        (uint256 min, uint256 max) = feed.answerBand();
        assertEq(min, BAND_MIN, "band floor");
        assertEq(max, BAND_MAX, "band ceiling");

        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredIn) =
            feed.latestRoundData();
        assertEq(roundId, 1, "roundId");
        assertEq(answer, PEG, "opening answer");
        assertEq(startedAt, T0, "startedAt");
        assertEq(updatedAt, T0, "updatedAt");
        assertEq(answeredIn, 1, "answeredInRound must equal roundId - never carried over");
    }

    /// @dev `version()` returning 0 is a deliberate honesty choice: a consumer gating on a real
    ///      Chainlink aggregator version SHOULD reject this contract.
    function test_versionIsZeroSoItCannotPassAsAChainlinkAggregator() public view {
        assertEq(feed.version(), 0, "version must not impersonate a Chainlink aggregator");
    }

    function test_constructorRevertsOnZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new OperatorFeed(DECIMALS, DESCRIPTION, PEG, BAND_MIN, BAND_MAX, HEARTBEAT, address(0));
    }

    function test_constructorRevertsOnZeroFloorBand() public {
        // A zero floor would admit posting 0, which the router rejects as InvalidPrice - a feed that
        // can be driven into a permanently un-quotable state is refused at construction.
        vm.expectRevert(
            abi.encodeWithSelector(OperatorFeed.OperatorFeed__InvalidBand.selector, 0, BAND_MAX)
        );
        new OperatorFeed(DECIMALS, DESCRIPTION, PEG, 0, BAND_MAX, HEARTBEAT, owner);
    }

    function test_constructorRevertsOnInvertedBand() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                OperatorFeed.OperatorFeed__InvalidBand.selector, BAND_MAX, BAND_MIN
            )
        );
        new OperatorFeed(DECIMALS, DESCRIPTION, PEG, BAND_MAX, BAND_MIN, HEARTBEAT, owner);
    }

    function test_constructorRevertsOnZeroHeartbeat() public {
        vm.expectRevert(OperatorFeed.OperatorFeed__ZeroHeartbeat.selector);
        new OperatorFeed(DECIMALS, DESCRIPTION, PEG, BAND_MIN, BAND_MAX, 0, owner);
    }

    function test_constructorRevertsWhenOpeningAnswerIsOutsideTheBand() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                OperatorFeed.OperatorFeed__AnswerOutOfBand.selector, int256(2e8), BAND_MIN, BAND_MAX
            )
        );
        new OperatorFeed(DECIMALS, DESCRIPTION, 2e8, BAND_MIN, BAND_MAX, HEARTBEAT, owner);
    }

    /*//////////////////////////////////////////////////////////////
                                 ACCESS
    //////////////////////////////////////////////////////////////*/

    function test_ownerCanUpdateAnswer() public {
        vm.warp(T0 + 600);
        vm.prank(owner);
        uint80 roundId = feed.updateAnswer(1.01e8);

        assertEq(roundId, 2, "round should advance");
        (uint80 id, int256 answer,,, uint256 updatedAt) = _latest();
        assertEq(id, 2, "latest roundId");
        assertEq(answer, 1.01e8, "answer");
        assertEq(updatedAt, T0 + 600, "updatedAt must be the post time");
    }

    /// @dev THE DEFECT THIS CONTRACT EXISTS TO CLOSE. On the predecessor mock this exact call
    ///      succeeded, because `updateAnswer` was `public` with no guard — anyone could set the
    ///      price the router settles against.
    function test_strangerCannotUpdateAnswer() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(OperatorFeed.OperatorFeed__NotAuthorized.selector, stranger)
        );
        feed.updateAnswer(1.01e8);
    }

    /// @dev The price is unchanged after the refused write - a rejected post never degrades the feed.
    function test_refusedWriteLeavesThePreviousAnswerIntact() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(OperatorFeed.OperatorFeed__NotAuthorized.selector, stranger)
        );
        feed.updateAnswer(0.99e8);

        (, int256 answer,,,) = feed.latestRoundData();
        assertEq(answer, PEG, "answer must be untouched by a refused write");
        assertEq(feed.latestRound(), 1, "round must not advance on a refused write");
    }

    function test_namedOperatorCanUpdateAnswer() public {
        vm.prank(owner);
        feed.setOperator(keeper);
        assertEq(feed.operator(), keeper, "operator not set");

        vm.warp(T0 + 900);
        vm.prank(keeper);
        feed.updateAnswer(1.002e8);

        (, int256 answer,,,) = feed.latestRoundData();
        assertEq(answer, 1.002e8, "operator write did not land");
    }

    function test_revokedOperatorCannotUpdateAnswer() public {
        vm.startPrank(owner);
        feed.setOperator(keeper);
        feed.setOperator(address(0));
        vm.stopPrank();

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(OperatorFeed.OperatorFeed__NotAuthorized.selector, keeper)
        );
        feed.updateAnswer(1.01e8);
    }

    /// @dev Rotation takes effect in the same block for BOTH sides: the new key writes, the old key
    ///      stops. This is the response to a suspected keeper compromise.
    function test_rotatingTheOperatorLocksOutThePreviousOne() public {
        address keeper2 = makeAddr("keeper2");

        vm.prank(owner);
        feed.setOperator(keeper);
        vm.prank(owner);
        feed.setOperator(keeper2);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(OperatorFeed.OperatorFeed__NotAuthorized.selector, keeper)
        );
        feed.updateAnswer(1.01e8);

        vm.prank(keeper2);
        feed.updateAnswer(1.01e8);
        (, int256 answer,,,) = feed.latestRoundData();
        assertEq(answer, 1.01e8, "rotated operator must be able to write");
    }

    function test_strangerCannotSetTheOperator() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        feed.setOperator(stranger);
    }

    function test_setOperatorEmitsTheRotation() public {
        vm.expectEmit(true, true, false, false, address(feed));
        emit OperatorFeed.OperatorSet(address(0), keeper);
        vm.prank(owner);
        feed.setOperator(keeper);
    }

    function test_updateAnswerEmitsChainlinkShapedEvents() public {
        vm.warp(T0 + 60);

        vm.expectEmit(true, true, false, true, address(feed));
        emit OperatorFeed.NewRound(2, owner, T0 + 60);
        vm.expectEmit(true, true, false, true, address(feed));
        emit OperatorFeed.AnswerUpdated(1.01e8, 2, T0 + 60);

        vm.prank(owner);
        feed.updateAnswer(1.01e8);
    }

    /*//////////////////////////////////////////////////////////////
                                  BAND
    //////////////////////////////////////////////////////////////*/

    /// @dev The blast radius of a stolen operator key. The writer is authorized and STILL cannot move
    ///      the settlement price to an arbitrary value - the band is immutable.
    function test_authorizedWriterCannotPostAboveTheBand() public {
        vm.prank(owner);
        feed.setOperator(keeper);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                OperatorFeed.OperatorFeed__AnswerOutOfBand.selector,
                int256(1000e8),
                BAND_MIN,
                BAND_MAX
            )
        );
        feed.updateAnswer(1000e8);
    }

    function test_authorizedWriterCannotPostBelowTheBand() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                OperatorFeed.OperatorFeed__AnswerOutOfBand.selector, int256(1), BAND_MIN, BAND_MAX
            )
        );
        feed.updateAnswer(1);
    }

    function test_authorizedWriterCannotPostZeroOrNegative() public {
        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                OperatorFeed.OperatorFeed__AnswerOutOfBand.selector, int256(0), BAND_MIN, BAND_MAX
            )
        );
        feed.updateAnswer(0);

        vm.expectRevert(
            abi.encodeWithSelector(
                OperatorFeed.OperatorFeed__AnswerOutOfBand.selector,
                int256(-1e8),
                BAND_MIN,
                BAND_MAX
            )
        );
        feed.updateAnswer(-1e8);
        vm.stopPrank();
    }

    function test_bandEdgesAreInclusive() public {
        vm.startPrank(owner);
        feed.updateAnswer(int256(BAND_MIN));
        (, int256 low,,,) = feed.latestRoundData();
        assertEq(low, int256(BAND_MIN), "floor must be accepted");

        feed.updateAnswer(int256(BAND_MAX));
        (, int256 high,,,) = feed.latestRoundData();
        assertEq(high, int256(BAND_MAX), "ceiling must be accepted");
        vm.stopPrank();
    }

    /// @dev Any authorized answer inside the band lands; anything outside it reverts. Stated as a
    ///      fuzz so the property is checked across the range rather than at three chosen points.
    function testFuzz_bandIsTheOnlyThingAnAuthorizedWriterCanMoveWithin(int256 answer) public {
        answer = bound(answer, -2e8, 5000e8);
        vm.prank(owner);

        bool inBand = answer > 0 && uint256(answer) >= BAND_MIN && uint256(answer) <= BAND_MAX;
        if (!inBand) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    OperatorFeed.OperatorFeed__AnswerOutOfBand.selector, answer, BAND_MIN, BAND_MAX
                )
            );
        }
        feed.updateAnswer(answer);

        (, int256 stored,,,) = feed.latestRoundData();
        assertEq(stored, inBand ? answer : PEG, "stored answer");
    }

    /*//////////////////////////////////////////////////////////////
                               STALENESS
    //////////////////////////////////////////////////////////////*/

    function test_ageAdvancesAndIsStaleFlipsAtTheHeartbeat() public {
        assertEq(feed.secondsSinceUpdate(), 0, "fresh at deploy");
        assertFalse(feed.isStale(), "must not be stale at deploy");

        vm.warp(T0 + HEARTBEAT);
        assertEq(feed.secondsSinceUpdate(), HEARTBEAT, "age at exactly the heartbeat");
        assertFalse(feed.isStale(), "exactly-at-heartbeat is not yet late");

        vm.warp(T0 + HEARTBEAT + 1);
        assertTrue(feed.isStale(), "one second past the heartbeat is late");
    }

    function test_aRefreshResetsTheAge() public {
        vm.warp(T0 + HEARTBEAT + 5000);
        assertTrue(feed.isStale(), "should be late before the refresh");

        vm.prank(owner);
        feed.updateAnswer(PEG);

        assertEq(feed.secondsSinceUpdate(), 0, "age must reset");
        assertFalse(feed.isStale(), "must be fresh again");
    }

    /*//////////////////////////////////////////////////////////////
                             ROUND HISTORY
    //////////////////////////////////////////////////////////////*/

    function test_getRoundDataAnswersHistoricalRoundsTruthfully() public {
        vm.warp(T0 + 100);
        vm.prank(owner);
        feed.updateAnswer(1.01e8);

        // Round 1 must still report its ORIGINAL answer and timestamp, not the latest ones - the
        // predecessor mock echoed the latest round for every query, which is a lie about history.
        (uint80 id1, int256 a1,, uint256 u1, uint80 air1) = feed.getRoundData(1);
        assertEq(id1, 1, "roundId");
        assertEq(a1, PEG, "round 1 answer");
        assertEq(u1, T0, "round 1 updatedAt");
        assertEq(air1, 1, "answeredInRound");

        (, int256 a2,, uint256 u2,) = feed.getRoundData(2);
        assertEq(a2, 1.01e8, "round 2 answer");
        assertEq(u2, T0 + 100, "round 2 updatedAt");
    }

    function test_getRoundDataRevertsOnAnUnknownRound() public {
        vm.expectRevert(
            abi.encodeWithSelector(OperatorFeed.OperatorFeed__NoRound.selector, uint80(99))
        );
        feed.getRoundData(99);
    }

    /*//////////////////////////////////////////////////////////////
                        ROUTER INTEGRATION - THE POINT
    //////////////////////////////////////////////////////////////*/

    /// @dev Builds the real router behind its production proxy, points it at this feed for a real
    ///      6-decimal USDC, and walks the whole staleness lifecycle:
    ///        fresh  -> quote() returns the right token amount
    ///        keeper stops, one hour passes -> quote() REVERTS OracleLib__StalePrice
    ///        keeper returns -> quote() works again
    ///      The middle step is the fail-closed guarantee: an unattended feed refuses payments rather
    ///      than settling them against an aged answer.
    function test_routerQuoteSucceedsFreshAndRevertsStale() public {
        address routerOwner = makeAddr("routerOwner");
        address treasury = makeAddr("treasury");

        address impl = address(new Access0x1Router());
        Access0x1Router router = Access0x1Router(
            deployProxy(
                impl, abi.encodeCall(Access0x1Router.initialize, (routerOwner, treasury, 100))
            )
        );

        MockUSDC usdc = new MockUSDC();
        vm.startPrank(routerOwner);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(feed));
        vm.stopPrank();

        // FRESH: $29.00 at a $1.00 peg against 6-decimal USDC is 29_000_000 base units.
        assertEq(router.quote(0, address(usdc), 29e8), 29_000_000, "fresh quote");

        // THE KEEPER STOPS. `setPriceFeed` leaves stalenessOf unset, so the router falls back to
        // OracleLib.TIMEOUT (3600s). One second past it, pricing refuses.
        vm.warp(T0 + OracleLib.TIMEOUT + 1);
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        router.quote(0, address(usdc), 29e8);

        // THE KEEPER RETURNS. One post restores pricing with no router-side action at all.
        vm.prank(owner);
        feed.updateAnswer(PEG);
        assertEq(router.quote(0, address(usdc), 29e8), 29_000_000, "quote after refresh");
    }

    /// @dev The stale revert must reach the SETTLEMENT path, not just the view. A payment attempted
    ///      against an unattended feed reverts before any value moves - it never settles at the old
    ///      price. This is the money-path half of the fail-closed claim.
    function test_payTokenRevertsRatherThanSettlingAgainstAStaleFeed() public {
        address routerOwner = makeAddr("routerOwner");
        address treasury = makeAddr("treasury");
        address merchantOwner = makeAddr("merchantOwner");
        address payout = makeAddr("payout");
        address buyer = makeAddr("buyer");

        address impl = address(new Access0x1Router());
        Access0x1Router router = Access0x1Router(
            deployProxy(
                impl, abi.encodeCall(Access0x1Router.initialize, (routerOwner, treasury, 100))
            )
        );

        MockUSDC usdc = new MockUSDC();
        vm.startPrank(routerOwner);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(feed));
        vm.stopPrank();

        vm.prank(merchantOwner);
        uint256 merchantId = router.registerMerchant(payout, payout, 50, keccak256("acme"));

        usdc.mint(buyer, 1000e6);
        vm.prank(buyer);
        usdc.approve(address(router), type(uint256).max);

        // The keeper has been gone for over an hour.
        vm.warp(T0 + OracleLib.TIMEOUT + 1);

        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 payoutBefore = usdc.balanceOf(payout);

        vm.prank(buyer);
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        router.payToken(merchantId, address(usdc), 29e8, keccak256("order-1"));

        assertEq(usdc.balanceOf(buyer), buyerBefore, "buyer must be untouched");
        assertEq(usdc.balanceOf(payout), payoutBefore, "merchant must receive nothing");
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Re-orders `latestRoundData` into the shape these tests assert on, so each case reads as
    ///      one line instead of a five-slot destructure it mostly ignores.
    function _latest()
        private
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint80 answeredIn, uint256 at)
    {
        (roundId, answer, startedAt, at, answeredIn) = feed.latestRoundData();
    }
}
