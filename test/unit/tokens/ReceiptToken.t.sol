// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { ReceiptToken } from "../../../src/tokens/ReceiptToken.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC1155 } from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import { IERC1155Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title  ReceiptTokenTest
/// @author Access0x1
/// @notice Coverage for the commerce-receipts + loyalty-points ERC-1155 preset: soulbound-optional
///         receipt mint (unique per order), fungible point accrual, one-shot redemption (replay guard),
///         the points/receipt id disjointness, transfer enforcement (soulbound receipts + optional
///         soulbound points), and that a redemption can only burn the holder's own balance.
contract ReceiptTokenTest is Test {
    ReceiptToken internal receipts;

    address internal admin = makeAddr("admin");
    address internal issuer = makeAddr("issuer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    bytes32 internal constant ORDER_A = keccak256("order-A");
    bytes32 internal constant ORDER_B = keccak256("order-B");

    function setUp() public {
        receipts = new ReceiptToken("ipfs://base/{id}", admin, false);
        // Note: resolve the role selector BEFORE the prank — `receipts.ISSUER_ROLE()` is itself an
        // external call that would otherwise consume a single `vm.prank`, so `grantRole` would then run
        // as the test contract and revert. `startPrank` spans both calls.
        vm.startPrank(admin);
        receipts.grantRole(receipts.ISSUER_ROLE(), issuer);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_constructor_setsAdmin() public view {
        assertTrue(receipts.hasRole(receipts.DEFAULT_ADMIN_ROLE(), admin));
        assertFalse(receipts.pointsSoulbound());
    }

    function test_constructor_revertsZeroAdmin() public {
        vm.expectRevert(ReceiptToken.ReceiptToken__ZeroAddress.selector);
        new ReceiptToken("u", address(0), false);
    }

    /*//////////////////////////////////////////////////////////////
                                 RECEIPTS
    //////////////////////////////////////////////////////////////*/

    function test_mintReceipt_happy() public {
        vm.prank(issuer);
        uint256 id = receipts.mintReceipt(alice, ORDER_A, true, "ipfs://r");
        assertEq(id, receipts.receiptId(ORDER_A));
        assertEq(receipts.balanceOf(alice, id), 1);
        assertTrue(receipts.isReceiptSoulbound(id));
        assertTrue(receipts.receiptExists(ORDER_A));
        assertEq(receipts.uri(id), "ipfs://r");
    }

    function test_mintReceipt_onlyIssuer() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                receipts.ISSUER_ROLE()
            )
        );
        vm.prank(alice);
        receipts.mintReceipt(alice, ORDER_A, true, "");
    }

    function test_mintReceipt_uniquePerOrder() public {
        vm.startPrank(issuer);
        receipts.mintReceipt(alice, ORDER_A, false, "");
        vm.expectRevert(
            abi.encodeWithSelector(
                ReceiptToken.ReceiptToken__ReceiptExists.selector, receipts.receiptId(ORDER_A)
            )
        );
        receipts.mintReceipt(bob, ORDER_A, false, "");
        vm.stopPrank();
    }

    function test_mintReceipt_rejectsReservedId() public {
        // An order whose id maps to POINTS_ID (type(uint256).max) is rejected.
        bytes32 maxOrder = bytes32(type(uint256).max);
        vm.expectRevert(ReceiptToken.ReceiptToken__ReservedId.selector);
        vm.prank(issuer);
        receipts.mintReceipt(alice, maxOrder, false, "");
    }

    function test_receipt_soulboundBlocksTransfer() public {
        vm.prank(issuer);
        uint256 id = receipts.mintReceipt(alice, ORDER_A, true, "");
        vm.expectRevert(abi.encodeWithSelector(ReceiptToken.ReceiptToken__Soulbound.selector, id));
        vm.prank(alice);
        receipts.safeTransferFrom(alice, bob, id, 1, "");
    }

    function test_receipt_transferableMoves() public {
        vm.prank(issuer);
        uint256 id = receipts.mintReceipt(alice, ORDER_A, false, "");
        vm.prank(alice);
        receipts.safeTransferFrom(alice, bob, id, 1, "");
        assertEq(receipts.balanceOf(bob, id), 1);
    }

    /*//////////////////////////////////////////////////////////////
                              LOYALTY POINTS
    //////////////////////////////////////////////////////////////*/

    function test_accruePoints_happy() public {
        vm.prank(issuer);
        receipts.accruePoints(alice, 100);
        assertEq(receipts.pointsOf(alice), 100);
    }

    function test_accruePoints_onlyIssuer() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                receipts.ISSUER_ROLE()
            )
        );
        vm.prank(alice);
        receipts.accruePoints(alice, 100);
    }

    function test_accruePoints_revertsZero() public {
        vm.expectRevert(ReceiptToken.ReceiptToken__ZeroAmount.selector);
        vm.prank(issuer);
        receipts.accruePoints(alice, 0);
    }

    function test_points_poolableByDefault() public {
        uint256 pointsId = receipts.POINTS_ID();
        vm.prank(issuer);
        receipts.accruePoints(alice, 100);
        vm.prank(alice);
        receipts.safeTransferFrom(alice, bob, pointsId, 40, "");
        assertEq(receipts.pointsOf(bob), 40);
        assertEq(receipts.pointsOf(alice), 60);
    }

    function test_points_soulboundWhenConfigured() public {
        ReceiptToken sb = new ReceiptToken("u", admin, true);
        uint256 pointsId = sb.POINTS_ID();
        vm.startPrank(admin);
        sb.grantRole(sb.ISSUER_ROLE(), issuer);
        vm.stopPrank();
        vm.prank(issuer);
        sb.accruePoints(alice, 100);
        vm.expectRevert(
            abi.encodeWithSelector(ReceiptToken.ReceiptToken__Soulbound.selector, pointsId)
        );
        vm.prank(alice);
        sb.safeTransferFrom(alice, bob, pointsId, 10, "");
    }

    /*//////////////////////////////////////////////////////////////
                               REDEMPTION
    //////////////////////////////////////////////////////////////*/

    function test_redeemPoints_happy() public {
        vm.prank(issuer);
        receipts.accruePoints(alice, 100);
        vm.prank(alice);
        receipts.redeemPoints(30, keccak256("redeem-1"));
        assertEq(receipts.pointsOf(alice), 70);
        assertTrue(receipts.redemptionUsed(keccak256("redeem-1")));
    }

    function test_redeemPoints_replayGuard() public {
        vm.prank(issuer);
        receipts.accruePoints(alice, 100);
        bytes32 rid = keccak256("redeem-1");
        vm.startPrank(alice);
        receipts.redeemPoints(30, rid);
        vm.expectRevert(
            abi.encodeWithSelector(ReceiptToken.ReceiptToken__RedemptionReplay.selector, rid)
        );
        receipts.redeemPoints(10, rid);
        vm.stopPrank();
    }

    function test_redeemPoints_revertsZero() public {
        vm.expectRevert(ReceiptToken.ReceiptToken__ZeroAmount.selector);
        vm.prank(alice);
        receipts.redeemPoints(0, keccak256("r"));
    }

    function test_redeemPoints_cannotOverBurn() public {
        vm.prank(issuer);
        receipts.accruePoints(alice, 10);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC1155Errors.ERC1155InsufficientBalance.selector,
                alice,
                10,
                50,
                receipts.POINTS_ID()
            )
        );
        vm.prank(alice);
        receipts.redeemPoints(50, keccak256("r"));
    }

    function test_redeemPoints_onlyBurnsOwnBalance() public {
        // alice has points; bob (no points) redeeming reverts on his own zero balance — he cannot
        // touch alice's points.
        vm.prank(issuer);
        receipts.accruePoints(alice, 100);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC1155Errors.ERC1155InsufficientBalance.selector, bob, 0, 10, receipts.POINTS_ID()
            )
        );
        vm.prank(bob);
        receipts.redeemPoints(10, keccak256("r"));
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    function test_supportsInterface() public view {
        assertTrue(receipts.supportsInterface(type(IERC1155).interfaceId));
        assertTrue(receipts.supportsInterface(type(IAccessControl).interfaceId));
        assertTrue(receipts.supportsInterface(type(IERC165).interfaceId));
    }

    /// @dev Point balance conservation across accrue + redeem for any amounts.
    function testFuzz_pointsConservation(uint128 accrue, uint128 redeem) public {
        vm.assume(accrue > 0);
        redeem = uint128(bound(redeem, 0, accrue));
        vm.prank(issuer);
        receipts.accruePoints(alice, accrue);
        if (redeem > 0) {
            vm.prank(alice);
            receipts.redeemPoints(redeem, keccak256(abi.encode(accrue, redeem)));
        }
        assertEq(receipts.pointsOf(alice), uint256(accrue) - redeem);
    }
}
