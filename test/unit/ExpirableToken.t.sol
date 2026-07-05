// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC721Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ExpirableToken } from "../../src/tokens/ExpirableToken.sol";
import { IERC7858 } from "../../src/interfaces/IERC7858.sol";

/// @notice Unit + fuzz suite for {ExpirableToken}, the vanilla ERC-7858 "expirable NFT" preset. Covers
///         the full standard surface and this preset's rules: owner-gated {mintExpirable} recording an
///         immutable `[start, end)` window and emitting BOTH the standard {TokenExpiryUpdated} and the
///         preset {ExpirableMinted}, the strict-positive-length window guard (`start >= end` reverts),
///         `TIME_BASED` {expiryType}, the never-revert {isTokenValid} lifecycle gate (half-open,
///         existence-aware) versus the revert-on-nonexistent raw `startTime`/`endTime` reads, free
///         transfer of an expired token (still owned, still transferable), and ERC-165 detection of
///         `type(IERC7858).interfaceId` (computed from this repo's interface, not a copied constant).
contract ExpirableTokenTest is Test {
    ExpirableToken internal token;

    address internal owner = makeAddr("owner"); // Ownable — sole mint authority
    address internal alice = makeAddr("alice"); // pass holder
    address internal bob = makeAddr("bob"); // transferee

    string internal constant NAME = "Access0x1 Expirable";
    string internal constant SYMBOL = "A0X1EXP";
    uint256 internal constant TOKEN_ID = 1;

    uint256 internal start;
    uint256 internal end;

    function setUp() public {
        vm.warp(1_800_000_000);
        start = block.timestamp; // valid from now
        end = start + 30 days; // a 30-day pass
        token = new ExpirableToken(NAME, SYMBOL, owner);
    }

    /// @dev Mint the canonical 30-day pass to alice, valid from now.
    function _mintPass() internal {
        vm.prank(owner);
        token.mintExpirable(alice, TOKEN_ID, start, end);
    }

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_constructor_setsMetadataAndOwner() public view {
        assertEq(token.name(), NAME);
        assertEq(token.symbol(), SYMBOL);
        assertEq(token.owner(), owner);
    }

    function test_expiryType_isTimeBased() public view {
        assertEq(uint256(token.expiryType()), uint256(IERC7858.EXPIRY_TYPE.TIME_BASED));
    }

    /*//////////////////////////////////////////////////////////////
                                 MINT
    //////////////////////////////////////////////////////////////*/

    function test_mintExpirable_ownerMintsWithWindowAndEmitsBothEvents() public {
        // The standard window event fires first, then the preset mint event.
        vm.expectEmit(true, true, true, true, address(token));
        emit IERC7858.TokenExpiryUpdated(TOKEN_ID, start, end);
        vm.expectEmit(true, true, true, true, address(token));
        emit ExpirableToken.ExpirableMinted(TOKEN_ID, alice, start, end);
        _mintPass();

        assertEq(token.ownerOf(TOKEN_ID), alice);
        assertEq(token.startTime(TOKEN_ID), start);
        assertEq(token.endTime(TOKEN_ID), end);
        assertTrue(token.isTokenValid(TOKEN_ID), "valid right after mint");
    }

    function test_mintExpirable_revertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        token.mintExpirable(alice, TOKEN_ID, start, end);
    }

    /// @notice A zero-or-negative-length window (`start >= end`) is refused — it would mint an
    ///         already-dead pass.
    function test_mintExpirable_revertsOnZeroLengthWindow() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ExpirableToken.ExpirableToken__InvalidWindow.selector, start, start
            )
        );
        token.mintExpirable(alice, TOKEN_ID, start, start); // start == end
    }

    function test_mintExpirable_revertsOnInvertedWindow() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ExpirableToken.ExpirableToken__InvalidWindow.selector, end, start)
        );
        token.mintExpirable(alice, TOKEN_ID, end, start); // start > end
    }

    /*//////////////////////////////////////////////////////////////
                          isTokenValid LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    function test_isTokenValid_falseBeforeStart() public {
        uint256 futureStart = block.timestamp + 1 days;
        vm.prank(owner);
        token.mintExpirable(alice, TOKEN_ID, futureStart, futureStart + 1 days);
        assertFalse(token.isTokenValid(TOKEN_ID), "not yet started");
    }

    function test_isTokenValid_trueInsideWindowFalseAtAndAfterEnd() public {
        _mintPass();
        assertTrue(token.isTokenValid(TOKEN_ID), "valid at inclusive start");

        vm.warp(end - 1);
        assertTrue(token.isTokenValid(TOKEN_ID), "valid just before end");

        vm.warp(end); // end is EXCLUSIVE
        assertFalse(token.isTokenValid(TOKEN_ID), "expired at exclusive end");

        vm.warp(end + 365 days);
        assertFalse(token.isTokenValid(TOKEN_ID), "still expired much later");
    }

    /// @notice The lifecycle gate never reverts — a nonexistent id reads as false, staticcall-safe.
    function test_isTokenValid_neverRevertsOnNonexistentId() public view {
        (bool ok, bytes memory ret) =
            address(token).staticcall(abi.encodeCall(token.isTokenValid, (999)));
        assertTrue(ok, "isTokenValid staticcall-safe on nonexistent id");
        assertFalse(abi.decode(ret, (bool)), "nonexistent id is not valid");
    }

    /*//////////////////////////////////////////////////////////////
                          RAW READS (DISPLAY)
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
                     TRANSFER (EXPIRY IS SEMANTIC ONLY)
    //////////////////////////////////////////////////////////////*/

    /// @notice An expired pass is still fully transferable — expiry is a semantic status, not a lock.
    function test_transfer_expiredTokenStillMoves() public {
        _mintPass();
        vm.warp(end + 1); // expired
        assertFalse(token.isTokenValid(TOKEN_ID));

        vm.prank(alice);
        token.transferFrom(alice, bob, TOKEN_ID);
        assertEq(token.ownerOf(TOKEN_ID), bob);
        // Window survives the transfer.
        assertEq(token.startTime(TOKEN_ID), start);
        assertEq(token.endTime(TOKEN_ID), end);
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @notice For any positive-length window and any evaluation instant, {isTokenValid} agrees with
    ///         the half-open definition `start <= now < end`.
    function testFuzz_isTokenValid_matchesHalfOpenDefinition(uint256 s, uint256 e, uint256 evalAt)
        public
    {
        s = bound(s, 0, type(uint256).max - 1);
        e = bound(e, s + 1, type(uint256).max); // s < e (positive length)

        vm.prank(owner);
        token.mintExpirable(alice, TOKEN_ID, s, e);

        vm.warp(evalAt);
        bool expected = s <= evalAt && evalAt < e;
        assertEq(token.isTokenValid(TOKEN_ID), expected, "isTokenValid == [s, e) membership");
    }

    /// @notice Any `start >= end` window is rejected.
    function testFuzz_mintExpirable_rejectsNonPositiveWindow(uint256 s, uint256 e) public {
        vm.assume(s >= e);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ExpirableToken.ExpirableToken__InvalidWindow.selector, s, e)
        );
        token.mintExpirable(alice, TOKEN_ID, s, e);
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    function test_supportsInterface_advertisesTheInterfaceId() public view {
        // ERC-7858's id is computed from this repo's interface (not a copied magic constant).
        assertTrue(token.supportsInterface(type(IERC7858).interfaceId), "IERC7858");
        assertTrue(token.supportsInterface(type(IERC721).interfaceId), "IERC721");
        assertTrue(token.supportsInterface(type(IERC165).interfaceId), "IERC165");
        assertFalse(token.supportsInterface(0xffffffff), "0xffffffff must be false per ERC-165");
    }
}
