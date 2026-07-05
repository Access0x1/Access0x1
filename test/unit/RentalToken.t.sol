// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Vm } from "forge-std/Vm.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC721Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { RentalToken } from "../../src/tokens/RentalToken.sol";
import { IERC4907 } from "../../src/interfaces/IERC4907.sol";

/// @notice Unit + fuzz suite for {RentalToken}, the vanilla ERC-4907 "rentable NFT" preset. Covers the
///         full standard surface and this preset's rules: owner-gated mint, {setUser} authorized by
///         the OZ spend gate (owner OR approved operator, NOT an arbitrary caller), the past-expiry
///         guard on a non-zero grant, lazy expiry (a lapsed tenancy reads back zero from {userOf} with
///         no tx while {userExpires} keeps the raw stored value), the clear-on-transfer rule enforced
///         in `_update` for plain AND operator paths (with an {UpdateUser} clear event only when a user
///         was actually set), and ERC-165 detection of the standard id `0xad092b5c`.
contract RentalTokenTest is Test {
    RentalToken internal token;

    address internal owner = makeAddr("owner"); // Ownable — sole mint authority
    address internal alice = makeAddr("alice"); // token (title) holder
    address internal bob = makeAddr("bob"); // buyer of the asset
    address internal tenant = makeAddr("tenant"); // the rented user
    address internal operator = makeAddr("operator"); // approved spender

    string internal constant NAME = "Access0x1 Rental";
    string internal constant SYMBOL = "A0X1RENT";
    uint256 internal constant TOKEN_ID = 1;

    uint64 internal expires; // a future expiry, set in setUp

    function setUp() public {
        vm.warp(1_800_000_000);
        expires = uint64(block.timestamp) + 7 days;
        token = new RentalToken(NAME, SYMBOL, owner);
    }

    /// @dev Mint the canonical asset to alice.
    function _mintToAlice() internal {
        vm.prank(owner);
        token.mint(alice, TOKEN_ID);
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

    function test_mint_ownerMintsWithNoTenant() public {
        _mintToAlice();
        assertEq(token.ownerOf(TOKEN_ID), alice);
        assertEq(token.userOf(TOKEN_ID), address(0), "fresh mint has no tenant");
        assertEq(token.userExpires(TOKEN_ID), 0);
    }

    function test_mint_revertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        token.mint(alice, TOKEN_ID);
    }

    /*//////////////////////////////////////////////////////////////
                             setUser / userOf
    //////////////////////////////////////////////////////////////*/

    function test_setUser_ownerGrantsTenancy() public {
        _mintToAlice();
        vm.expectEmit(true, true, true, true, address(token));
        emit IERC4907.UpdateUser(TOKEN_ID, tenant, expires);
        vm.prank(alice);
        token.setUser(TOKEN_ID, tenant, expires);

        assertEq(token.userOf(TOKEN_ID), tenant, "tenancy is live");
        assertEq(token.userExpires(TOKEN_ID), expires);
        // Ownership (title) is unchanged — usage and title are separate.
        assertEq(token.ownerOf(TOKEN_ID), alice);
    }

    /// @notice The setUser gate is the OZ spend authority: an approved operator may set the tenant.
    function test_setUser_approvedOperatorMayGrant() public {
        _mintToAlice();
        vm.prank(alice);
        token.approve(operator, TOKEN_ID);

        vm.prank(operator);
        token.setUser(TOKEN_ID, tenant, expires);
        assertEq(token.userOf(TOKEN_ID), tenant);
    }

    /// @notice An unrelated caller (not owner, not approved) cannot set the tenant — the same bar as
    ///         transferring the token.
    function test_setUser_revertsForUnauthorizedCaller() public {
        _mintToAlice();
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, bob, TOKEN_ID)
        );
        token.setUser(TOKEN_ID, tenant, expires);
    }

    function test_setUser_revertsForNonexistentToken() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, TOKEN_ID)
        );
        token.setUser(TOKEN_ID, tenant, expires);
    }

    /// @notice A non-zero grant with an expiry already in the past is refused: {userOf} could never
    ///         agree with the emitted {UpdateUser}.
    function test_setUser_revertsOnPastExpiryForNonZeroUser() public {
        _mintToAlice();
        uint64 past = uint64(block.timestamp); // expires <= now
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                RentalToken.RentalToken__ExpiryInPast.selector, past, block.timestamp
            )
        );
        token.setUser(TOKEN_ID, tenant, past);
    }

    /// @notice Clearing a tenancy (`user == 0`) is always allowed regardless of the expiry value — the
    ///         past-expiry guard only applies to a non-zero grant.
    function test_setUser_clearingAllowedWithAnyExpiry() public {
        _mintToAlice();
        vm.startPrank(alice);
        token.setUser(TOKEN_ID, tenant, expires);
        token.setUser(TOKEN_ID, address(0), 0); // clear
        vm.stopPrank();
        assertEq(token.userOf(TOKEN_ID), address(0), "tenancy cleared");
    }

    /*//////////////////////////////////////////////////////////////
                              LAZY EXPIRY
    //////////////////////////////////////////////////////////////*/

    /// @notice After the expiry instant, {userOf} reads zero with NO transaction, while {userExpires}
    ///         keeps the raw stored value (the record persists until overwritten).
    function test_lazyExpiry_userOfZeroesButExpiresRemains() public {
        _mintToAlice();
        vm.prank(alice);
        token.setUser(TOKEN_ID, tenant, expires);

        vm.warp(expires); // exactly at expiry — still valid (userOf uses `expires >= now`)
        assertEq(token.userOf(TOKEN_ID), tenant, "still the tenant at the expiry instant");

        vm.warp(uint256(expires) + 1); // one second past
        assertEq(token.userOf(TOKEN_ID), address(0), "tenancy lapsed, no tx needed");
        assertEq(token.userExpires(TOKEN_ID), expires, "raw stored expiry persists");
    }

    /*//////////////////////////////////////////////////////////////
                          CLEAR ON TRANSFER
    //////////////////////////////////////////////////////////////*/

    /// @notice A sale of the underlying asset ends the tenancy: {_update} clears the record and emits a
    ///         `user == 0` {UpdateUser}. Enforced on the plain transfer path.
    function test_transfer_clearsTenancyAndEmits() public {
        _mintToAlice();
        vm.prank(alice);
        token.setUser(TOKEN_ID, tenant, expires);

        vm.expectEmit(true, true, true, true, address(token));
        emit IERC4907.UpdateUser(TOKEN_ID, address(0), 0);
        vm.prank(alice);
        token.transferFrom(alice, bob, TOKEN_ID);

        assertEq(token.ownerOf(TOKEN_ID), bob);
        assertEq(token.userOf(TOKEN_ID), address(0), "lease ended by the sale");
        assertEq(token.userExpires(TOKEN_ID), 0, "record wiped");
    }

    /// @notice The clear also fires on the approved-operator transfer path — the rule lives in
    ///         `_update`, so it cannot be routed around.
    function test_transfer_operatorPathClearsTenancy() public {
        _mintToAlice();
        vm.startPrank(alice);
        token.setUser(TOKEN_ID, tenant, expires);
        token.approve(operator, TOKEN_ID);
        vm.stopPrank();

        vm.expectEmit(true, true, true, true, address(token));
        emit IERC4907.UpdateUser(TOKEN_ID, address(0), 0);
        vm.prank(operator);
        token.transferFrom(alice, bob, TOKEN_ID);
        assertEq(token.userOf(TOKEN_ID), address(0));
    }

    /// @notice No spurious clear event on a mint or on transferring an UNRENTED token — the clear is
    ///         skipped when no user was set. (Recording all logs, we assert the count of UpdateUser.)
    function test_transfer_unrentedTokenEmitsNoUpdateUser() public {
        _mintToAlice(); // no tenant set

        vm.recordLogs();
        vm.prank(alice);
        token.transferFrom(alice, bob, TOKEN_ID);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = IERC4907.UpdateUser.selector;
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != sig, "no UpdateUser on an unrented transfer");
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @notice For any future expiry and any evaluation instant, {userOf} returns the tenant iff
    ///         `now <= expires` (lazy expiry), else zero.
    function testFuzz_userOf_lazyExpiryBoundary(uint64 e, uint64 evalAt) public {
        e = uint64(bound(e, block.timestamp + 1, type(uint64).max));
        _mintToAlice();
        vm.prank(alice);
        token.setUser(TOKEN_ID, tenant, e);

        vm.assume(evalAt > 0);
        vm.warp(evalAt);
        address expected = evalAt <= e ? tenant : address(0);
        assertEq(token.userOf(TOKEN_ID), expected, "userOf follows the lazy-expiry boundary");
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    function test_supportsInterface_advertisesTheStandardId() public view {
        // ERC-4907 pins the id to 0xad092b5c.
        assertEq(
            type(IERC4907).interfaceId,
            bytes4(0xad092b5c),
            "interface drifted from the ERC-4907 id"
        );
        assertTrue(token.supportsInterface(type(IERC4907).interfaceId), "IERC4907");
        assertTrue(token.supportsInterface(type(IERC721).interfaceId), "IERC721");
        assertTrue(token.supportsInterface(type(IERC165).interfaceId), "IERC165");
        assertFalse(token.supportsInterface(0xffffffff), "0xffffffff must be false per ERC-165");
    }
}
