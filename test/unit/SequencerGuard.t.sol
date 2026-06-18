// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { OracleLib } from "../../src/libraries/OracleLib.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";

/// @notice Audit finding M-1 — the L2 Sequencer Uptime guard. `quote()` rejects pricing while an L2
///         sequencer is down or within its post-restart grace window. With NO sequencer feed
///         configured (the default, and L1 / Arc), the check is skipped and behaviour is unchanged.
contract SequencerGuardTest is Test {
    Access0x1Router internal router;
    MockV3Aggregator internal nativeFeed; // ETH/USD, 8 dec
    MockV3Aggregator internal seqFeed; // L2 Sequencer Uptime feed (answer 0 = up, 1 = down)

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    uint16 internal constant PLATFORM_FEE_BPS = 100;
    uint256 internal constant GRACE = 3600;

    function setUp() public {
        vm.warp(100_000); // well past the grace window, so a far-past startedAt reads as "up long enough"
        router = new Access0x1Router(owner, treasury, PLATFORM_FEE_BPS);
        nativeFeed = new MockV3Aggregator(8, 2000e8); // ETH = $2000
        seqFeed = new MockV3Aggregator(0, 0);
        // Default the sequencer feed to healthy: up (answer 0), started well before the grace window.
        seqFeed.setRoundData(1, 0, block.timestamp - GRACE - 1, block.timestamp, 1);
        vm.startPrank(owner);
        router.setPriceFeed(address(0), address(nativeFeed));
        router.setSequencerUptimeFeed(address(seqFeed));
        vm.stopPrank();
    }

    /// @dev Set the sequencer feed's (answer, startedAt); updatedAt/answeredInRound are unused by the guard.
    function _seq(int256 answer, uint256 startedAt) internal {
        seqFeed.setRoundData(1, answer, startedAt, block.timestamp, 1);
    }

    function test_quote_ok_whenSequencerUpPastGrace() public view {
        // sequencer up (answer 0), started long enough ago
        assertEq(router.quote(1, address(0), 20e8), 0.01 ether);
    }

    function test_quote_okAfterExplicitUpPastGrace() public {
        _seq(0, block.timestamp - GRACE - 1);
        assertEq(router.quote(1, address(0), 20e8), 0.01 ether);
    }

    function test_quote_revertsWhenSequencerDown() public {
        _seq(1, block.timestamp - GRACE - 1); // answer == 1 ⇒ down
        vm.expectRevert(OracleLib.OracleLib__SequencerDown.selector);
        router.quote(1, address(0), 20e8);
    }

    function test_quote_revertsWithinGracePeriod() public {
        _seq(0, block.timestamp); // up, but just restarted (startedAt == now)
        vm.expectRevert(OracleLib.OracleLib__SequencerGracePeriodNotOver.selector);
        router.quote(1, address(0), 20e8);
    }

    function test_quote_revertsExactlyAtGraceBoundary() public {
        _seq(0, block.timestamp - GRACE); // diff == GRACE ⇒ still within grace (<=)
        vm.expectRevert(OracleLib.OracleLib__SequencerGracePeriodNotOver.selector);
        router.quote(1, address(0), 20e8);
    }

    function test_quote_revertsWhenUptimeFeedUninitialized() public {
        _seq(0, 0); // startedAt == 0 ⇒ the uptime feed has posted no round
        vm.expectRevert(OracleLib.OracleLib__SequencerDown.selector);
        router.quote(1, address(0), 20e8);
    }

    function test_quote_skipsCheckWhenFeedUnset() public {
        vm.prank(owner);
        router.setSequencerUptimeFeed(address(0)); // clear ⇒ L1 / Arc behaviour, no sequencer check
        _seq(1, block.timestamp); // "down" is now irrelevant
        assertEq(router.quote(1, address(0), 20e8), 0.01 ether);
    }

    function test_setSequencerUptimeFeed_onlyOwner() public {
        vm.expectRevert();
        vm.prank(makeAddr("stranger"));
        router.setSequencerUptimeFeed(address(seqFeed));
    }

    function test_setSequencerUptimeFeed_setsAndClears() public {
        vm.startPrank(owner);
        router.setSequencerUptimeFeed(address(seqFeed));
        assertEq(router.sequencerUptimeFeed(), address(seqFeed));
        router.setSequencerUptimeFeed(address(0));
        assertEq(router.sequencerUptimeFeed(), address(0));
        vm.stopPrank();
    }
}
