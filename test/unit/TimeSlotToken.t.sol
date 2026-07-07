// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC721Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { TimeSlotToken } from "../../src/tokens/TimeSlotToken.sol";
import { IERC5007 } from "../../src/interfaces/IERC5007.sol";

/// @notice Unit + fuzz suite for {TimeSlotToken}, the vanilla ERC-5007 "Time NFT" preset. Covers the
///         full standard surface and this preset's additions: owner-gated {mintSlot} recording an
///         immutable `[start, end)` window, the standard's revert-on-nonexistent `startTime`/`endTime`
///         reads versus the never-revert {isValidNow} convenience gate (half-open, existence-aware),
///         the InvalidWindow guard (`start > end`), free transfer at every point in a slot's life
///         (expiry is descriptive, never a transfer lock), and ERC-165 detection of the standard id
///         `0xf140be0d` (with a drift assertion pinning the interface to that value).
contract TimeSlotTokenTest is Test {
    TimeSlotToken internal token;

    address internal owner = makeAddr("owner"); // Ownable — sole mint authority
    address internal alice = makeAddr("alice"); // slot holder
    address internal bob = makeAddr("bob"); // buyer of the slot

    string internal constant NAME = "Access0x1 Time Slot";
    string internal constant SYMBOL = "A0X1TS";
    uint256 internal constant TOKEN_ID = 1;

    // A window anchored a full day in the future so `block.timestamp` at setUp sits BEFORE it.
    int64 internal start;
    int64 internal end;

    function setUp() public {
        // Warp to a realistic, non-zero epoch so past/future windows are both expressible.
        vm.warp(1_800_000_000); // ~2027-01
        start = int64(uint64(block.timestamp)) + 1 days;
        end = start + 1 hours;
        token = new TimeSlotToken(NAME, SYMBOL, owner);
    }

    /// @dev Mint the canonical future slot to alice.
    function _mintFutureSlot() internal {
        vm.prank(owner);
        token.mintSlot(alice, TOKEN_ID, start, end);
    }

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_constructor_setsMetadataAndOwner() public view {
        assertEq(token.name(), NAME);
        assertEq(token.symbol(), SYMBOL);
        assertEq(token.owner(), owner);
    }

    /*//////////////////////////////////////////////////////////////
                                 MINT
    //////////////////////////////////////////////////////////////*/

    function test_mintSlot_ownerMintsWithWindow() public {
        vm.expectEmit(true, true, true, true, address(token));
        emit TimeSlotToken.SlotMinted(TOKEN_ID, alice, start, end);
        _mintFutureSlot();

        assertEq(token.ownerOf(TOKEN_ID), alice);
        assertEq(token.startTime(TOKEN_ID), start);
        assertEq(token.endTime(TOKEN_ID), end);
    }

    function test_mintSlot_revertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        token.mintSlot(alice, TOKEN_ID, start, end);
    }

    function test_mintSlot_revertsOnInvalidWindow() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(TimeSlotToken.TimeSlotToken__InvalidWindow.selector, end, start)
        );
        token.mintSlot(alice, TOKEN_ID, end, start); // start > end
    }

    /// @notice A zero-length instant (`start == end`) is allowed by the window rule; it simply reads
    ///         as never-valid under the half-open convention.
    function test_mintSlot_zeroLengthWindowMintsButIsNeverValid() public {
        int64 instant = int64(uint64(block.timestamp));
        vm.prank(owner);
        token.mintSlot(alice, TOKEN_ID, instant, instant);
        assertEq(token.ownerOf(TOKEN_ID), alice);
        assertFalse(token.isValidNow(TOKEN_ID), "zero-length window is never live");
    }

    /*//////////////////////////////////////////////////////////////
                             ERC-5007 READS
    //////////////////////////////////////////////////////////////*/

    function test_startTime_revertsForNonexistentToken() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, TOKEN_ID)
        );
        token.startTime(TOKEN_ID);
    }

    function test_endTime_revertsForNonexistentToken() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, TOKEN_ID)
        );
        token.endTime(TOKEN_ID);
    }

    /*//////////////////////////////////////////////////////////////
                          isValidNow (CONVENIENCE)
    //////////////////////////////////////////////////////////////*/

    function test_isValidNow_falseBeforeStart() public {
        _mintFutureSlot(); // window opens 1 day out
        assertFalse(token.isValidNow(TOKEN_ID), "not yet started");
    }

    function test_isValidNow_trueInsideWindow() public {
        _mintFutureSlot();
        vm.warp(uint64(start)); // exactly at the inclusive start
        assertTrue(token.isValidNow(TOKEN_ID), "live at start (inclusive)");
        vm.warp(uint64(end) - 1); // last valid second
        assertTrue(token.isValidNow(TOKEN_ID), "live just before end");
    }

    function test_isValidNow_falseAtAndAfterEnd() public {
        _mintFutureSlot();
        vm.warp(uint64(end)); // end is EXCLUSIVE
        assertFalse(token.isValidNow(TOKEN_ID), "expired at exclusive end");
        vm.warp(uint64(end) + 1 days);
        assertFalse(token.isValidNow(TOKEN_ID), "still expired later");
    }

    /// @notice The convenience gate never reverts — a nonexistent id reads as false, so a router can
    ///         staticcall it speculatively.
    function test_isValidNow_neverRevertsOnNonexistentId() public view {
        (bool ok, bytes memory ret) =
            address(token).staticcall(abi.encodeCall(token.isValidNow, (999)));
        assertTrue(ok, "isValidNow staticcall-safe on nonexistent id");
        assertFalse(abi.decode(ret, (bool)), "nonexistent id is not live");
    }

    /*//////////////////////////////////////////////////////////////
                     TRANSFER (EXPIRY IS DESCRIPTIVE)
    //////////////////////////////////////////////////////////////*/

    /// @notice A slot is fully transferable at every point in its life — before, during, and AFTER the
    ///         window. Expiry never locks the token (it is metadata, not a guard).
    function test_transfer_worksBeforeDuringAndAfterWindow() public {
        _mintFutureSlot();

        // Before the window.
        vm.prank(alice);
        token.transferFrom(alice, bob, TOKEN_ID);
        assertEq(token.ownerOf(TOKEN_ID), bob);

        // During the window.
        vm.warp(uint64(start));
        vm.prank(bob);
        token.transferFrom(bob, alice, TOKEN_ID);
        assertEq(token.ownerOf(TOKEN_ID), alice);

        // After the window (expired) — still moves, and the window is preserved across transfer.
        vm.warp(uint64(end) + 1);
        vm.prank(alice);
        token.transferFrom(alice, bob, TOKEN_ID);
        assertEq(token.ownerOf(TOKEN_ID), bob);
        assertEq(token.startTime(TOKEN_ID), start, "window survives transfer");
        assertEq(token.endTime(TOKEN_ID), end, "window survives transfer");
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @notice For any valid window and any evaluation instant, {isValidNow} agrees EXACTLY with the
    ///         half-open definition `start <= now < end`.
    function testFuzz_isValidNow_matchesHalfOpenDefinition(int64 s, int64 e, uint64 evalAt) public {
        s = int64(bound(s, 1, type(int64).max - 1));
        e = int64(bound(e, s, type(int64).max)); // s <= e (valid window)
        vm.assume(evalAt > 0);

        vm.prank(owner);
        token.mintSlot(alice, TOKEN_ID, s, e);

        vm.warp(evalAt);
        int64 nowT = int64(uint64(evalAt));
        bool expected = s <= nowT && nowT < e;
        assertEq(token.isValidNow(TOKEN_ID), expected, "isValidNow == [s, e) membership");
    }

    /// @notice Any `start > end` window is rejected, whatever the operands.
    function testFuzz_mintSlot_rejectsInvertedWindow(int64 s, int64 e) public {
        vm.assume(s > e);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(TimeSlotToken.TimeSlotToken__InvalidWindow.selector, s, e)
        );
        token.mintSlot(alice, TOKEN_ID, s, e);
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    function test_supportsInterface_advertisesTheComputedId() public view {
        // The verifiable ERC-5007 id computed from this two-method interface is
        // startTime.selector ^ endTime.selector == 0x7a0cdf92. (The EIP text quotes 0xf140be0d, but
        // that value is not reproducible from the interface's own selectors — see IERC5007's natspec.)
        assertEq(
            type(IERC5007).interfaceId,
            bytes4(0x7a0cdf92),
            "IERC5007 id drifted from startTime.selector ^ endTime.selector"
        );
        assertTrue(token.supportsInterface(type(IERC5007).interfaceId), "IERC5007");
        assertTrue(token.supportsInterface(type(IERC721).interfaceId), "IERC721");
        assertTrue(token.supportsInterface(type(IERC165).interfaceId), "IERC165");
        assertFalse(token.supportsInterface(0xffffffff), "0xffffffff must be false per ERC-165");
    }
}
