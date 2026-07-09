// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { BookingToken } from "../../../src/tokens/BookingToken.sol";
import { Access0x1Router } from "../../../src/Access0x1Router.sol";
import { MockV3Aggregator } from "../../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../../mocks/MockUSDC.sol";
import { BlocklistToken } from "../../mocks/BlocklistToken.sol";
import { ProxyDeployer } from "../../utils/ProxyDeployer.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC721Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

/// @title  BookingTokenTest
/// @author Access0x1
/// @notice Coverage for the tokenized reservation preset: USD-priced deposit escrow on mint, the
///         confirm RELEASE through the router fee-split, holder cancel + expiry refunds, the
///         refund-NEVER-blocked invariant (a blocklisted holder's refund lands in the pull-map, never
///         reverts), escrow conservation, slot occupancy, and access control (only the merchant owner
///         confirms; only the holder cancels). The router is deployed behind its production UUPS proxy.
contract BookingTokenTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    BookingToken internal booking;
    MockV3Aggregator internal usdcFeed;
    MockUSDC internal usdc;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal merchantPayout = makeAddr("merchantPayout");
    address internal operator = makeAddr("operator"); // the router merchant owner
    address internal buyer = makeAddr("buyer");
    address internal reseller = makeAddr("reseller");

    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%
    uint256 internal constant DEPOSIT_USD8 = 50e8; // $50.00
    uint64 internal constant HOLD = 1 days;

    uint256 internal merchantId;

    function setUp() public {
        vm.warp(1_700_000_000);
        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (admin, treasury, PLATFORM_FEE_BPS))
            )
        );
        booking = new BookingToken("Access Bookings", "BOOK", address(router));

        usdc = new MockUSDC();
        usdcFeed = new MockV3Aggregator(8, 1e8); // $1

        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        vm.prank(operator);
        merchantId = router.registerMerchant(merchantPayout, address(0), 0, keccak256("m"));

        usdc.mint(buyer, 1_000e6);
        vm.prank(buyer);
        usdc.approve(address(booking), type(uint256).max);
    }

    function _mint(bytes32 slotKey, bytes32 nonce) internal returns (uint256 id) {
        vm.prank(buyer);
        id = booking.mintBooking(
            buyer, merchantId, slotKey, DEPOSIT_USD8, address(usdc), HOLD, nonce
        );
    }

    /*//////////////////////////////////////////////////////////////
                                  MINT
    //////////////////////////////////////////////////////////////*/

    function test_mint_escrowsAndMints() public {
        uint256 id = _mint(keccak256("slot-1"), keccak256("n1"));
        assertEq(booking.ownerOf(id), buyer);
        // $50 at $1/USDC = 50e6 (6 decimals)
        assertEq(booking.escrowedOf(address(usdc)), 50e6);
        assertEq(usdc.balanceOf(address(booking)), 50e6);
        assertFalse(booking.isSlotFree(keccak256("slot-1")));
    }

    function test_mint_revertsUnknownMerchant() public {
        vm.expectRevert(
            abi.encodeWithSelector(BookingToken.BookingToken__MerchantNotFound.selector, 999)
        );
        vm.prank(buyer);
        booking.mintBooking(
            buyer, 999, keccak256("s"), DEPOSIT_USD8, address(usdc), HOLD, keccak256("n")
        );
    }

    function test_mint_revertsHoldTooShort() public {
        vm.expectRevert(
            abi.encodeWithSelector(BookingToken.BookingToken__HoldTooShort.selector, 30, 60)
        );
        vm.prank(buyer);
        booking.mintBooking(
            buyer, merchantId, keccak256("s"), DEPOSIT_USD8, address(usdc), 30, keccak256("n")
        );
    }

    function test_mint_revertsSlotTaken() public {
        _mint(keccak256("slot-1"), keccak256("n1"));
        vm.expectRevert(
            abi.encodeWithSelector(
                BookingToken.BookingToken__SlotTaken.selector, keccak256("slot-1"), 1
            )
        );
        vm.prank(buyer);
        booking.mintBooking(
            buyer,
            merchantId,
            keccak256("slot-1"),
            DEPOSIT_USD8,
            address(usdc),
            HOLD,
            keccak256("n2")
        );
    }

    function test_mint_revertsReplayNonce() public {
        _mint(keccak256("slot-1"), keccak256("n1"));
        vm.expectRevert(
            abi.encodeWithSelector(BookingToken.BookingToken__NonceUsed.selector, keccak256("n1"))
        );
        vm.prank(buyer);
        booking.mintBooking(
            buyer,
            merchantId,
            keccak256("slot-2"),
            DEPOSIT_USD8,
            address(usdc),
            HOLD,
            keccak256("n1")
        );
    }

    /*//////////////////////////////////////////////////////////////
                                 CONFIRM
    //////////////////////////////////////////////////////////////*/

    function test_confirm_releasesThroughRouter() public {
        uint256 id = _mint(keccak256("slot-1"), keccak256("n1"));
        vm.prank(operator);
        booking.confirm(id);
        // $50 released: 1% platform fee = 0.5 USDC to treasury, 49.5 to merchant payout
        assertEq(usdc.balanceOf(treasury), 5e5); // 0.5 USDC
        assertEq(usdc.balanceOf(merchantPayout), 495e5); // 49.5 USDC
        assertEq(booking.escrowedOf(address(usdc)), 0);
        // NFT burned
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        booking.ownerOf(id);
    }

    function test_confirm_onlyMerchantOwner() public {
        uint256 id = _mint(keccak256("slot-1"), keccak256("n1"));
        vm.expectRevert(
            abi.encodeWithSelector(
                BookingToken.BookingToken__NotMerchantOwner.selector, merchantId, buyer
            )
        );
        vm.prank(buyer);
        booking.confirm(id);
    }

    function test_confirm_revertsWrongStatus() public {
        uint256 id = _mint(keccak256("slot-1"), keccak256("n1"));
        vm.prank(buyer);
        booking.cancel(id); // now CANCELLED
        vm.expectRevert(
            abi.encodeWithSelector(
                BookingToken.BookingToken__WrongStatus.selector,
                id,
                BookingToken.BStatus.CANCELLED,
                BookingToken.BStatus.HELD
            )
        );
        vm.prank(operator);
        booking.confirm(id);
    }

    /*//////////////////////////////////////////////////////////////
                              CANCEL / EXPIRE
    //////////////////////////////////////////////////////////////*/

    function test_cancel_refundsHolder() public {
        uint256 id = _mint(keccak256("slot-1"), keccak256("n1"));
        uint256 balBefore = usdc.balanceOf(buyer);
        vm.prank(buyer);
        booking.cancel(id);
        assertEq(usdc.balanceOf(buyer), balBefore + 50e6);
        assertEq(booking.escrowedOf(address(usdc)), 0);
        assertTrue(booking.isSlotFree(keccak256("slot-1")));
    }

    function test_cancel_onlyHolder() public {
        uint256 id = _mint(keccak256("slot-1"), keccak256("n1"));
        vm.expectRevert(
            abi.encodeWithSelector(BookingToken.BookingToken__NotHolder.selector, id, operator)
        );
        vm.prank(operator);
        booking.cancel(id);
    }

    function test_cancel_merchantCannotBlockRefund() public {
        // The merchant has NO cancel path — proven by the onlyHolder guard above. Here we also prove
        // the merchant cannot confirm-away a booking the holder wants cancelled once the holder acts.
        uint256 id = _mint(keccak256("slot-1"), keccak256("n1"));
        vm.prank(buyer);
        booking.cancel(id); // holder refunds themselves
        // merchant's later confirm reverts (already terminal) — deposit is already back with the holder
        vm.expectRevert();
        vm.prank(operator);
        booking.confirm(id);
    }

    function test_resell_thenNewHolderCancels() public {
        // A reservation NFT is transferable; the deposit follows the holder.
        uint256 id = _mint(keccak256("slot-1"), keccak256("n1"));
        vm.prank(buyer);
        booking.transferFrom(buyer, reseller, id);
        assertEq(booking.ownerOf(id), reseller);
        uint256 balBefore = usdc.balanceOf(reseller);
        vm.prank(reseller);
        booking.cancel(id);
        assertEq(usdc.balanceOf(reseller), balBefore + 50e6); // refund goes to the NEW holder
    }

    function test_expire_afterDeadline() public {
        uint256 id = _mint(keccak256("slot-1"), keccak256("n1"));
        vm.warp(block.timestamp + HOLD);
        uint256 balBefore = usdc.balanceOf(buyer);
        vm.prank(buyer);
        booking.expire(id);
        assertEq(usdc.balanceOf(buyer), balBefore + 50e6);
    }

    function test_expire_revertsBeforeDeadline() public {
        uint256 id = _mint(keccak256("slot-1"), keccak256("n1"));
        vm.expectRevert(
            abi.encodeWithSelector(
                BookingToken.BookingToken__NotExpired.selector,
                id,
                block.timestamp + HOLD,
                block.timestamp
            )
        );
        vm.prank(buyer);
        booking.expire(id);
    }

    function test_expire_merchantOwnerMayExpire() public {
        uint256 id = _mint(keccak256("slot-1"), keccak256("n1"));
        vm.warp(block.timestamp + HOLD);
        vm.prank(operator);
        booking.expire(id);
        // refund still goes to the holder (buyer), not the operator
        assertEq(booking.escrowedOf(address(usdc)), 0);
    }

    function test_expire_thirdPartyCannot() public {
        uint256 id = _mint(keccak256("slot-1"), keccak256("n1"));
        vm.warp(block.timestamp + HOLD);
        vm.expectRevert(
            abi.encodeWithSelector(BookingToken.BookingToken__NotHolder.selector, id, reseller)
        );
        vm.prank(reseller);
        booking.expire(id);
    }

    /*//////////////////////////////////////////////////////////////
                          REFUND NEVER BLOCKED (law #5)
    //////////////////////////////////////////////////////////////*/

    function test_refundNeverBlocked_queuesOnBlocklist() public {
        // Use a blocklist token as the deposit currency; block the holder from RECEIVING it, then cancel.
        BlocklistToken bt = new BlocklistToken();
        MockV3Aggregator btFeed = new MockV3Aggregator(8, 1e8);
        vm.startPrank(admin);
        router.setTokenAllowed(address(bt), true);
        router.setPriceFeed(address(bt), address(btFeed));
        vm.stopPrank();

        bt.mint(buyer, 1_000e6);
        vm.prank(buyer);
        bt.approve(address(booking), type(uint256).max);

        vm.prank(buyer);
        uint256 id = booking.mintBooking(
            buyer, merchantId, keccak256("bslot"), DEPOSIT_USD8, address(bt), HOLD, keccak256("bn")
        );

        // Block the buyer from receiving the token; the cancel refund must NOT revert — it queues.
        bt.setBlocked(buyer, true);
        vm.prank(buyer);
        booking.cancel(id); // does not revert
        assertEq(booking.refundRescueOf(buyer, address(bt)), 50e6);

        // Unblock and claim the queued refund.
        bt.setBlocked(buyer, false);
        uint256 balBefore = bt.balanceOf(buyer);
        vm.prank(buyer);
        booking.claimRefund(address(bt));
        assertEq(bt.balanceOf(buyer), balBefore + 50e6);
        assertEq(booking.refundRescueOf(buyer, address(bt)), 0);
    }

    function test_claimRefund_revertsNothingToClaim() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                BookingToken.BookingToken__NothingToClaim.selector, address(usdc)
            )
        );
        vm.prank(buyer);
        booking.claimRefund(address(usdc));
    }

    /*//////////////////////////////////////////////////////////////
                              CONSERVATION FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev After any single-booking lifecycle, escrow returns to zero and the contract holds ~zero.
    function testFuzz_escrowConservation(uint256 depositUsd8, bool confirmIt) public {
        depositUsd8 = bound(depositUsd8, 1e8, 500e8); // $1..$500
        usdc.mint(buyer, 10_000e6);
        vm.prank(buyer);
        uint256 id = booking.mintBooking(
            buyer, merchantId, keccak256("fslot"), depositUsd8, address(usdc), HOLD, keccak256("fn")
        );
        uint256 escrowed = booking.escrowedOf(address(usdc));
        assertGt(escrowed, 0);
        assertEq(usdc.balanceOf(address(booking)), escrowed);
        if (confirmIt) {
            vm.prank(operator);
            booking.confirm(id);
        } else {
            vm.prank(buyer);
            booking.cancel(id);
        }
        assertEq(booking.escrowedOf(address(usdc)), 0);
        assertEq(usdc.balanceOf(address(booking)), 0); // zero custody
    }
}
