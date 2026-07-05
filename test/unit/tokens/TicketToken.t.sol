// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { TicketToken } from "../../../src/tokens/TicketToken.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC2981 } from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC721Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title  TicketTokenTest
/// @author Access0x1
/// @notice Happy-path + revert + access-control + policy-enforcement coverage for the event-ticketing
///         NFT preset: mint (MINTER_ROLE), the resale transfer window (non-transferable, freeze cutoff),
///         one-way check-in (flag + burn), per-token URI, the param'd ERC-2981 royalty (ceiling +
///         per-token override), and the refund-of-nothing (this contract holds no funds — it is a pure
///         token artifact). Fee/royalty math is fuzzed for rounding.
contract TicketTokenTest is Test {
    TicketToken internal ticket;

    address internal admin = makeAddr("admin");
    address internal minter = makeAddr("minter");
    address internal gate = makeAddr("gate");
    address internal royaltyReceiver = makeAddr("royaltyReceiver");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint96 internal constant ROYALTY_BPS = 500; // 5%
    uint64 internal constant EVENT_ID = 42;

    function setUp() public {
        vm.warp(1_700_000_000);
        ticket = new TicketToken("Access Passes", "PASS", admin, royaltyReceiver, ROYALTY_BPS);
        vm.startPrank(admin);
        ticket.grantRole(ticket.MINTER_ROLE(), minter);
        ticket.grantRole(ticket.CHECKIN_ROLE(), gate);
        vm.stopPrank();
    }

    function _mint(address to, uint256 id) internal {
        vm.prank(minter);
        ticket.mint(to, id, EVENT_ID, 7, 1, false, 0, "ipfs://seat");
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_constructor_setsAdminAndRoyalty() public view {
        assertTrue(ticket.hasRole(ticket.DEFAULT_ADMIN_ROLE(), admin));
        (address recv, uint256 amount) = ticket.royaltyInfo(1, 10_000);
        assertEq(recv, royaltyReceiver);
        assertEq(amount, 500); // 5% of 10_000
    }

    function test_constructor_revertsZeroAdmin() public {
        vm.expectRevert(TicketToken.TicketToken__ZeroAddress.selector);
        new TicketToken("n", "s", address(0), royaltyReceiver, ROYALTY_BPS);
    }

    function test_constructor_revertsRoyaltyTooHigh() public {
        vm.expectRevert(
            abi.encodeWithSelector(TicketToken.TicketToken__RoyaltyTooHigh.selector, 1001, 1000)
        );
        new TicketToken("n", "s", admin, royaltyReceiver, 1001);
    }

    function test_constructor_revertsNonZeroBpsZeroReceiver() public {
        vm.expectRevert(TicketToken.TicketToken__ZeroAddress.selector);
        new TicketToken("n", "s", admin, address(0), ROYALTY_BPS);
    }

    function test_constructor_zeroRoyaltyAllowed() public {
        TicketToken t = new TicketToken("n", "s", admin, address(0), 0);
        (, uint256 amount) = t.royaltyInfo(1, 10_000);
        assertEq(amount, 0);
    }

    /*//////////////////////////////////////////////////////////////
                                  MINT
    //////////////////////////////////////////////////////////////*/

    function test_mint_happy() public {
        _mint(alice, 1);
        assertEq(ticket.ownerOf(1), alice);
        TicketToken.Ticket memory t = ticket.ticketOf(1);
        assertEq(t.eventId, EVENT_ID);
        assertEq(t.seatId, 7);
        assertEq(t.tier, 1);
        assertFalse(t.checkedIn);
        assertEq(ticket.tokenURI(1), "ipfs://seat");
    }

    function test_mint_onlyMinter() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, ticket.MINTER_ROLE()
            )
        );
        vm.prank(alice);
        ticket.mint(alice, 1, EVENT_ID, 0, 0, false, 0, "");
    }

    function test_mint_emptyUri() public {
        vm.prank(minter);
        ticket.mint(alice, 9, EVENT_ID, 0, 0, false, 0, "");
        assertEq(ticket.tokenURI(9), "");
    }

    /*//////////////////////////////////////////////////////////////
                           RESALE TRANSFER WINDOW
    //////////////////////////////////////////////////////////////*/

    function test_resale_freeByDefault() public {
        _mint(alice, 1);
        vm.prank(alice);
        ticket.transferFrom(alice, bob, 1);
        assertEq(ticket.ownerOf(1), bob);
    }

    function test_resale_nonTransferableBlocks() public {
        vm.prank(minter);
        ticket.mint(alice, 1, EVENT_ID, 0, 0, true, 0, "");
        vm.expectRevert(
            abi.encodeWithSelector(TicketToken.TicketToken__NonTransferable.selector, 1)
        );
        vm.prank(alice);
        ticket.transferFrom(alice, bob, 1);
    }

    function test_resale_frozenAfterCutoff() public {
        uint64 cutoff = uint64(block.timestamp + 1 days);
        vm.prank(minter);
        ticket.mint(alice, 1, EVENT_ID, 0, 0, false, cutoff, "");
        // before cutoff: ok
        vm.prank(alice);
        ticket.transferFrom(alice, bob, 1);
        // after cutoff: blocked
        vm.warp(cutoff);
        vm.expectRevert(
            abi.encodeWithSelector(TicketToken.TicketToken__TransfersFrozen.selector, 1, cutoff)
        );
        vm.prank(bob);
        ticket.transferFrom(bob, alice, 1);
    }

    function test_setTicketPolicy_onlyCheckinRole() public {
        _mint(alice, 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, ticket.CHECKIN_ROLE()
            )
        );
        vm.prank(alice);
        ticket.setTicketPolicy(1, true, 0);
    }

    function test_setTicketPolicy_locksAndReopens() public {
        _mint(alice, 1);
        vm.prank(gate);
        ticket.setTicketPolicy(1, true, 0);
        vm.expectRevert(
            abi.encodeWithSelector(TicketToken.TicketToken__NonTransferable.selector, 1)
        );
        vm.prank(alice);
        ticket.transferFrom(alice, bob, 1);
        // reopen
        vm.prank(gate);
        ticket.setTicketPolicy(1, false, 0);
        vm.prank(alice);
        ticket.transferFrom(alice, bob, 1);
        assertEq(ticket.ownerOf(1), bob);
    }

    function test_setTicketPolicy_revertsAfterCheckIn() public {
        _mint(alice, 1);
        vm.prank(gate);
        ticket.checkIn(1, false);
        vm.expectRevert(
            abi.encodeWithSelector(TicketToken.TicketToken__AlreadyCheckedIn.selector, 1)
        );
        vm.prank(gate);
        ticket.setTicketPolicy(1, false, 0);
    }

    /*//////////////////////////////////////////////////////////////
                                CHECK-IN
    //////////////////////////////////////////////////////////////*/

    function test_checkIn_flag() public {
        _mint(alice, 1);
        vm.prank(gate);
        ticket.checkIn(1, false);
        assertTrue(ticket.isCheckedIn(1));
        assertEq(ticket.ownerOf(1), alice); // kept
    }

    function test_checkIn_burn() public {
        _mint(alice, 1);
        vm.prank(gate);
        ticket.checkIn(1, true);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        ticket.ownerOf(1);
    }

    function test_checkIn_onlyCheckinRole() public {
        _mint(alice, 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, ticket.CHECKIN_ROLE()
            )
        );
        vm.prank(alice);
        ticket.checkIn(1, false);
    }

    function test_checkIn_idempotencyGuard() public {
        _mint(alice, 1);
        vm.prank(gate);
        ticket.checkIn(1, false);
        vm.expectRevert(
            abi.encodeWithSelector(TicketToken.TicketToken__AlreadyCheckedIn.selector, 1)
        );
        vm.prank(gate);
        ticket.checkIn(1, false);
    }

    function test_checkedIn_ticketCannotResell() public {
        _mint(alice, 1);
        vm.prank(gate);
        ticket.checkIn(1, false);
        vm.expectRevert(
            abi.encodeWithSelector(TicketToken.TicketToken__CheckedInNonTransferable.selector, 1)
        );
        vm.prank(alice);
        ticket.transferFrom(alice, bob, 1);
    }

    function test_checkIn_revertsNonexistent() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99));
        vm.prank(gate);
        ticket.checkIn(99, false);
    }

    /*//////////////////////////////////////////////////////////////
                                ROYALTY
    //////////////////////////////////////////////////////////////*/

    function test_setDefaultRoyalty_onlyAdmin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                ticket.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(alice);
        ticket.setDefaultRoyalty(alice, 100);
    }

    function test_setTokenRoyalty_overridesDefault() public {
        _mint(alice, 1);
        vm.prank(admin);
        ticket.setTokenRoyalty(1, bob, 250);
        (address recv, uint256 amount) = ticket.royaltyInfo(1, 10_000);
        assertEq(recv, bob);
        assertEq(amount, 250);
    }

    function test_setDefaultRoyalty_revertsTooHigh() public {
        vm.expectRevert(
            abi.encodeWithSelector(TicketToken.TicketToken__RoyaltyTooHigh.selector, 1001, 1000)
        );
        vm.prank(admin);
        ticket.setDefaultRoyalty(royaltyReceiver, 1001);
    }

    /// @dev Royalty math rounds down (OZ ERC-2981 floor) and never exceeds the fraction of sale price.
    function testFuzz_royaltyMath(uint256 salePrice, uint96 bps) public {
        salePrice = bound(salePrice, 0, 1e30);
        bps = uint96(bound(bps, 0, ticket.MAX_ROYALTY_BPS()));
        // OZ ERC-2981 validates the receiver even for a zero fraction, so always pass a real receiver.
        vm.prank(admin);
        ticket.setDefaultRoyalty(royaltyReceiver, bps);
        (, uint256 amount) = ticket.royaltyInfo(1, salePrice);
        assertEq(amount, (salePrice * bps) / 10_000);
        assertLe(amount, salePrice); // never more than the sale
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    function test_supportsInterface() public view {
        assertTrue(ticket.supportsInterface(type(IERC721).interfaceId));
        assertTrue(ticket.supportsInterface(type(IERC2981).interfaceId));
        assertTrue(ticket.supportsInterface(type(IAccessControl).interfaceId));
        assertTrue(ticket.supportsInterface(type(IERC165).interfaceId));
    }
}
