// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Access0x1GiftCards } from "../../src/Access0x1GiftCards.sol";
import { IAccess0x1GiftCards } from "../../src/interfaces/IAccess0x1GiftCards.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";

/// @notice The Access0x1GiftCards unit suite — the full prepaid-balance surface (issue / redeem /
///         reverse / transfer) plus the merchant-scoped coupon registry, all authorized through the
///         live Router merchant registry it composes (no duplicated owner store). USD amounts are
///         8-decimal (the estate's `usdAmount8`); $1 == 1e8.
contract Access0x1GiftCardsTest is Test {
    Access0x1GiftCards internal cards;
    Access0x1Router internal router;

    address internal admin = makeAddr("gc_admin");
    address internal treasury = makeAddr("gc_treasury");
    address internal merchantOwner = makeAddr("gc_merchantOwner");
    address internal alice = makeAddr("gc_alice");
    address internal bob = makeAddr("gc_bob");

    uint256 internal merchantId;
    bytes32 internal constant CODE = keccak256("CARD-001");
    uint256 internal constant FACE = 100e8; // $100 face value

    function setUp() public {
        router = new Access0x1Router(admin, treasury, 100); // 1% platform fee (unused here)
        cards = new Access0x1GiftCards(admin, router);

        // Register a merchant; the caller becomes its owner — the only address that may issue cards
        // / write coupons for it.
        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(
            makeAddr("gc_payout"), address(0), 0, keccak256("gc_merchant")
        );
    }

    /// @dev Issue `face` to `recipient` on the default merchant + code as the merchant owner.
    function _issue(address recipient, uint256 face) internal returns (uint256 id) {
        vm.prank(merchantOwner);
        id = cards.issueCard(merchantId, CODE, recipient, face);
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_constructor_setsRouterAndOwner() public view {
        assertEq(address(cards.router()), address(router));
        assertEq(cards.owner(), admin);
    }

    function test_constructor_revertsOnZeroRouter() public {
        vm.expectRevert(IAccess0x1GiftCards.GiftCards__ZeroAddress.selector);
        new Access0x1GiftCards(admin, Access0x1Router(payable(address(0))));
    }

    function test_constructor_revertsOnZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new Access0x1GiftCards(address(0), router);
    }

    /*//////////////////////////////////////////////////////////////
                                ISSUE
    //////////////////////////////////////////////////////////////*/

    function test_issue_success() public {
        uint256 expectedId = cards.cardId(merchantId, CODE);
        assertEq(expectedId, uint256(keccak256(abi.encode(merchantId, CODE))));

        vm.expectEmit(true, true, true, true, address(cards));
        emit IAccess0x1GiftCards.CardIssued(merchantId, expectedId, alice, FACE);
        uint256 id = _issue(alice, FACE);

        assertEq(id, expectedId);
        assertEq(cards.balanceOf(alice, id), FACE);
        assertEq(cards.cardMerchant(id), merchantId);
    }

    function test_issue_accumulatesOnSameCard() public {
        uint256 id = _issue(alice, FACE);
        _issue(alice, 50e8);
        assertEq(cards.balanceOf(alice, id), FACE + 50e8);
        assertEq(cards.cardMerchant(id), merchantId); // binding stable
    }

    function test_issue_revertsOnNonOwner() public {
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__NotMerchantOwner.selector, merchantId, bob
            )
        );
        cards.issueCard(merchantId, CODE, alice, FACE);
    }

    function test_issue_revertsOnUnknownMerchant() public {
        uint256 ghostMerchant = 999;
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__MerchantNotFound.selector, ghostMerchant
            )
        );
        cards.issueCard(ghostMerchant, CODE, alice, FACE);
    }

    function test_issue_revertsOnZeroRecipient() public {
        vm.prank(merchantOwner);
        vm.expectRevert(IAccess0x1GiftCards.GiftCards__ZeroAddress.selector);
        cards.issueCard(merchantId, CODE, address(0), FACE);
    }

    function test_issue_revertsOnZeroFace() public {
        vm.prank(merchantOwner);
        vm.expectRevert(IAccess0x1GiftCards.GiftCards__ZeroAmount.selector);
        cards.issueCard(merchantId, CODE, alice, 0);
    }

    /*//////////////////////////////////////////////////////////////
                                REDEEM
    //////////////////////////////////////////////////////////////*/

    function test_redeem_fullCover() public {
        uint256 id = _issue(alice, FACE);
        bytes32 rid = keccak256("r1");

        vm.expectEmit(true, true, true, true, address(cards));
        emit IAccess0x1GiftCards.Redeemed(id, alice, rid, 40e8);
        vm.prank(alice);
        uint256 applied = cards.redeem(id, 40e8, rid);

        assertEq(applied, 40e8);
        assertEq(cards.balanceOf(alice, id), FACE - 40e8);
    }

    function test_redeem_clampsToBalance() public {
        uint256 id = _issue(alice, FACE);
        // Ask for more than the balance: applied == balance, balance goes to zero, remainder is the
        // caller's to settle through the Router.
        vm.prank(alice);
        uint256 applied = cards.redeem(id, 150e8, keccak256("r1"));
        assertEq(applied, FACE);
        assertEq(cards.balanceOf(alice, id), 0);
    }

    function test_redeem_onEmptyCardAppliesZero() public {
        uint256 id = cards.cardId(merchantId, CODE); // never issued to alice
        vm.prank(alice);
        uint256 applied = cards.redeem(id, 10e8, keccak256("r1"));
        assertEq(applied, 0); // nothing to apply, no revert (it is a valid recorded no-op)
        assertEq(cards.balanceOf(alice, id), 0);
    }

    function test_redeem_revertsOnReplay() public {
        uint256 id = _issue(alice, FACE);
        bytes32 rid = keccak256("r1");
        vm.startPrank(alice);
        cards.redeem(id, 10e8, rid);
        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1GiftCards.GiftCards__RedemptionUsed.selector, rid)
        );
        cards.redeem(id, 10e8, rid);
        vm.stopPrank();
        assertEq(cards.balanceOf(alice, id), FACE - 10e8); // only debited once
    }

    function test_redeem_revertsOnZeroAmount() public {
        uint256 id = _issue(alice, FACE);
        vm.prank(alice);
        vm.expectRevert(IAccess0x1GiftCards.GiftCards__ZeroAmount.selector);
        cards.redeem(id, 0, keccak256("r1"));
    }

    function test_redeem_revertsOnZeroRedemptionId() public {
        uint256 id = _issue(alice, FACE);
        vm.prank(alice);
        vm.expectRevert(IAccess0x1GiftCards.GiftCards__ZeroAmount.selector);
        cards.redeem(id, 10e8, bytes32(0));
    }

    function test_redeem_multiplePartial() public {
        uint256 id = _issue(alice, FACE);
        vm.startPrank(alice);
        cards.redeem(id, 30e8, keccak256("r1"));
        cards.redeem(id, 30e8, keccak256("r2"));
        cards.redeem(id, 30e8, keccak256("r3"));
        vm.stopPrank();
        assertEq(cards.balanceOf(alice, id), FACE - 90e8);
    }

    /*//////////////////////////////////////////////////////////////
                          REVERSE REDEMPTION
    //////////////////////////////////////////////////////////////*/

    function test_reverse_creditsHolderBack() public {
        uint256 id = _issue(alice, FACE);
        bytes32 rid = keccak256("r1");
        vm.prank(alice);
        cards.redeem(id, 40e8, rid);
        assertEq(cards.balanceOf(alice, id), FACE - 40e8);

        vm.expectEmit(true, true, true, true, address(cards));
        emit IAccess0x1GiftCards.RedemptionReversed(id, alice, rid, 40e8);
        vm.prank(merchantOwner); // only the card's merchant owner may re-credit a spent balance
        cards.reverseRedemption(rid);

        assertEq(cards.balanceOf(alice, id), FACE); // fully restored
    }

    /// @notice Only the owner of the card's merchant may reverse a (value-bearing) redemption — a
    ///         stranger re-crediting spent value is the H-1 double-spend, now gated.
    function test_reverse_revertsOnNonMerchantOwner() public {
        uint256 id = _issue(alice, FACE);
        bytes32 rid = keccak256("r1");
        vm.prank(alice);
        cards.redeem(id, 40e8, rid);

        // Neither the holder nor a random caller can reverse; only the merchant owner.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__NotMerchantOwner.selector, merchantId, alice
            )
        );
        cards.reverseRedemption(rid);
        assertEq(
            cards.balanceOf(alice, id), FACE - 40e8, "balance unchanged by the rejected reverse"
        );
    }

    function test_reverse_isIdempotent() public {
        uint256 id = _issue(alice, FACE);
        bytes32 rid = keccak256("r1");
        vm.prank(alice);
        cards.redeem(id, 40e8, rid);

        vm.startPrank(merchantOwner);
        cards.reverseRedemption(rid);
        cards.reverseRedemption(rid); // second is a clean no-op, never a double-credit
        cards.reverseRedemption(rid);
        vm.stopPrank();

        assertEq(cards.balanceOf(alice, id), FACE); // credited back exactly once
    }

    function test_reverse_revertsOnUnknown() public {
        bytes32 rid = keccak256("never");
        // The unknown-id revert fires BEFORE the owner gate — even the merchant owner cannot reverse a
        // redemption that never happened.
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1GiftCards.GiftCards__RedemptionUnknown.selector, rid)
        );
        cards.reverseRedemption(rid);
    }

    function test_reverse_relivesFullySpentCard() public {
        uint256 id = _issue(alice, FACE);
        bytes32 rid = keccak256("r1");
        vm.prank(alice);
        cards.redeem(id, FACE, rid); // fully spend
        assertEq(cards.balanceOf(alice, id), 0);

        vm.prank(merchantOwner);
        cards.reverseRedemption(rid);
        assertEq(cards.balanceOf(alice, id), FACE); // alive again
    }

    /*//////////////////////////////////////////////////////////////
                               TRANSFER
    //////////////////////////////////////////////////////////////*/

    function test_transfer_success() public {
        uint256 id = _issue(alice, FACE);
        vm.expectEmit(true, true, true, true, address(cards));
        emit IAccess0x1GiftCards.CardTransferred(id, alice, bob, 30e8);
        vm.prank(alice);
        bool ok = cards.transfer(bob, id, 30e8);

        assertTrue(ok);
        assertEq(cards.balanceOf(alice, id), FACE - 30e8);
        assertEq(cards.balanceOf(bob, id), 30e8);
    }

    function test_transfer_revertsOnInsufficient() public {
        uint256 id = _issue(alice, FACE);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__TransferExceedsBalance.selector,
                id,
                alice,
                FACE,
                FACE + 1
            )
        );
        cards.transfer(bob, id, FACE + 1);
    }

    function test_transfer_revertsOnZeroTo() public {
        uint256 id = _issue(alice, FACE);
        vm.prank(alice);
        vm.expectRevert(IAccess0x1GiftCards.GiftCards__ZeroAddress.selector);
        cards.transfer(address(0), id, 1);
    }

    function test_transfer_recipientCanRedeem() public {
        uint256 id = _issue(alice, FACE);
        vm.prank(alice);
        cards.transfer(bob, id, 30e8);

        vm.prank(bob);
        uint256 applied = cards.redeem(id, 25e8, keccak256("r1"));
        assertEq(applied, 25e8);
        assertEq(cards.balanceOf(bob, id), 5e8);
    }

    /*//////////////////////////////////////////////////////////////
                                COUPON
    //////////////////////////////////////////////////////////////*/

    function test_setCoupon_success() public {
        bytes32 cid = keccak256("SAVE10");
        vm.expectEmit(true, true, false, true, address(cards));
        emit IAccess0x1GiftCards.CouponSet(
            merchantId, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 10, 0, 5
        );
        vm.prank(merchantOwner);
        cards.setCoupon(merchantId, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 10, 0, 5);

        IAccess0x1GiftCards.Coupon memory c = cards.coupons(merchantId, cid);
        assertEq(uint8(c.dType), uint8(IAccess0x1GiftCards.DiscountType.PERCENT));
        assertEq(c.value, 10);
        assertEq(c.maxRedemptions, 5);
        assertEq(c.redemptionsCount, 0);
        assertTrue(c.active);
    }

    function test_setCoupon_revertsOnNonOwner() public {
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__NotMerchantOwner.selector, merchantId, bob
            )
        );
        cards.setCoupon(
            merchantId, keccak256("x"), IAccess0x1GiftCards.DiscountType.AMOUNT, 1e8, 0, 0
        );
    }

    function test_applyCoupon_percent() public {
        bytes32 cid = keccak256("SAVE10");
        vm.startPrank(merchantOwner);
        cards.setCoupon(merchantId, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 10, 0, 0);

        uint256 discount = cards.applyCoupon(merchantId, cid, 200e8);
        vm.stopPrank();
        assertEq(discount, 20e8); // 10% of $200
        assertEq(cards.coupons(merchantId, cid).redemptionsCount, 1);
    }

    function test_applyCoupon_amount() public {
        bytes32 cid = keccak256("FLAT5");
        vm.startPrank(merchantOwner);
        cards.setCoupon(merchantId, cid, IAccess0x1GiftCards.DiscountType.AMOUNT, 5e8, 0, 0);

        uint256 discount = cards.applyCoupon(merchantId, cid, 200e8);
        vm.stopPrank();
        assertEq(discount, 5e8); // flat $5
    }

    /// @notice Consuming a coupon is now merchant-owner only (L-4): a non-owner is rejected by the gate
    ///         BEFORE any cap is touched, so it cannot grief a finite-cap promotion.
    function test_applyCoupon_revertsOnNonMerchantOwner() public {
        bytes32 cid = keccak256("SAVE10");
        vm.prank(merchantOwner);
        cards.setCoupon(merchantId, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 10, 0, 5);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__NotMerchantOwner.selector, merchantId, bob
            )
        );
        cards.applyCoupon(merchantId, cid, 100e8);
        assertEq(
            cards.coupons(merchantId, cid).redemptionsCount, 0, "cap untouched by the rejected call"
        );
    }

    function test_applyCoupon_clampsPercentOver100() public {
        bytes32 cid = keccak256("MEGA");
        vm.startPrank(merchantOwner);
        cards.setCoupon(merchantId, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 250, 0, 0);
        // 250% would be $250 on a $100 sale — clamped to the sale amount.
        assertEq(cards.applyCoupon(merchantId, cid, 100e8), 100e8);
        vm.stopPrank();
    }

    function test_applyCoupon_clampsAmountOverSale() public {
        bytes32 cid = keccak256("BIG");
        vm.startPrank(merchantOwner);
        cards.setCoupon(merchantId, cid, IAccess0x1GiftCards.DiscountType.AMOUNT, 500e8, 0, 0);
        assertEq(cards.applyCoupon(merchantId, cid, 100e8), 100e8); // clamped to $100
        vm.stopPrank();
    }

    function test_applyCoupon_revertsWhenInactive() public {
        bytes32 cid = keccak256("X");
        // Never set ⇒ active == false (default). The owner gate passes (merchant exists), then the
        // inactive check bites.
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__CouponInactive.selector, merchantId, cid
            )
        );
        cards.applyCoupon(merchantId, cid, 100e8);
    }

    function test_applyCoupon_revertsWhenExpired() public {
        bytes32 cid = keccak256("OLD");
        vm.warp(1_000_000);
        vm.startPrank(merchantOwner);
        cards.setCoupon(
            merchantId, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 10, uint64(500_000), 0
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__CouponExpired.selector, merchantId, cid
            )
        );
        cards.applyCoupon(merchantId, cid, 100e8);
        vm.stopPrank();
    }

    function test_applyCoupon_capEnforced() public {
        bytes32 cid = keccak256("TWICE");
        vm.startPrank(merchantOwner);
        cards.setCoupon(merchantId, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 10, 0, 2);

        cards.applyCoupon(merchantId, cid, 100e8);
        cards.applyCoupon(merchantId, cid, 100e8);
        assertEq(cards.coupons(merchantId, cid).redemptionsCount, 2);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__CouponExhausted.selector, merchantId, cid
            )
        );
        cards.applyCoupon(merchantId, cid, 100e8);
        vm.stopPrank();
    }

    /// @notice {quoteCoupon} is the permissionless, non-consuming preview (L-4): any caller previews the
    ///         clamped discount and the cap NEVER moves, so a storefront cannot exhaust a promotion.
    function test_quoteCoupon_previewsWithoutConsuming() public {
        bytes32 cid = keccak256("PREVIEW");
        vm.prank(merchantOwner);
        cards.setCoupon(merchantId, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 10, 0, 2);

        // A random caller previews repeatedly — the discount is correct and the count stays at zero.
        vm.startPrank(bob);
        assertEq(cards.quoteCoupon(merchantId, cid, 200e8), 20e8, "preview: 10% of $200");
        assertEq(cards.quoteCoupon(merchantId, cid, 200e8), 20e8, "preview is repeatable");
        vm.stopPrank();
        assertEq(
            cards.coupons(merchantId, cid).redemptionsCount, 0, "preview never consumes the cap"
        );
    }

    /// @notice {quoteCoupon} runs the SAME disqualifying checks as {applyCoupon}: an exhausted cap, an
    ///         inactive coupon, and an expired coupon each revert so a preview matches a consume.
    function test_quoteCoupon_revertsOnDisqualifyingState() public {
        bytes32 cid = keccak256("PREVIEW_DQ");
        vm.startPrank(merchantOwner);
        cards.setCoupon(merchantId, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 10, 0, 1);
        cards.applyCoupon(merchantId, cid, 100e8); // burn the only consumption
        vm.stopPrank();

        // Exhausted cap.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__CouponExhausted.selector, merchantId, cid
            )
        );
        cards.quoteCoupon(merchantId, cid, 100e8);

        // Inactive (never-set) coupon.
        bytes32 unset = keccak256("UNSET");
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__CouponInactive.selector, merchantId, unset
            )
        );
        cards.quoteCoupon(merchantId, unset, 100e8);
    }

    function test_releaseCoupon_decrements() public {
        bytes32 cid = keccak256("REL");
        vm.startPrank(merchantOwner);
        cards.setCoupon(merchantId, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 10, 0, 2);

        cards.applyCoupon(merchantId, cid, 100e8);
        assertEq(cards.coupons(merchantId, cid).redemptionsCount, 1);

        vm.expectEmit(true, true, false, false, address(cards));
        emit IAccess0x1GiftCards.CouponReleased(merchantId, cid);
        cards.releaseCoupon(merchantId, cid);
        vm.stopPrank();
        assertEq(cards.coupons(merchantId, cid).redemptionsCount, 0);
    }

    function test_releaseCoupon_floorsAtZero() public {
        bytes32 cid = keccak256("REL0");
        vm.prank(merchantOwner);
        cards.setCoupon(merchantId, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 10, 0, 0);

        vm.prank(merchantOwner);
        cards.releaseCoupon(merchantId, cid); // never consumed — stays 0, no underflow
        assertEq(cards.coupons(merchantId, cid).redemptionsCount, 0);
    }

    function test_releaseCoupon_revertsOnNonOwner() public {
        bytes32 cid = keccak256("REL");
        vm.prank(merchantOwner);
        cards.setCoupon(merchantId, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 10, 0, 0);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__NotMerchantOwner.selector, merchantId, bob
            )
        );
        cards.releaseCoupon(merchantId, cid);
    }

    function test_setCoupon_resetsCountOnRedefine() public {
        bytes32 cid = keccak256("RESET");
        vm.startPrank(merchantOwner);
        cards.setCoupon(merchantId, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 10, 0, 5);
        cards.applyCoupon(merchantId, cid, 100e8);
        cards.applyCoupon(merchantId, cid, 100e8);
        assertEq(cards.coupons(merchantId, cid).redemptionsCount, 2);

        // Redefining resets the count.
        cards.setCoupon(merchantId, cid, IAccess0x1GiftCards.DiscountType.AMOUNT, 1e8, 0, 5);
        vm.stopPrank();
        assertEq(cards.coupons(merchantId, cid).redemptionsCount, 0);
    }

    /*//////////////////////////////////////////////////////////////
                                 CARD ID
    //////////////////////////////////////////////////////////////*/

    function testFuzz_cardId_deterministic(uint256 mid, bytes32 code) public view {
        uint256 a = cards.cardId(mid, code);
        uint256 b = cards.cardId(mid, code);
        assertEq(a, b);
        assertEq(a, uint256(keccak256(abi.encode(mid, code))));
    }

    function testFuzz_cardId_distinctInputsDistinctIds(
        uint256 m1,
        bytes32 c1,
        uint256 m2,
        bytes32 c2
    ) public view {
        vm.assume(m1 != m2 || c1 != c2);
        assertTrue(cards.cardId(m1, c1) != cards.cardId(m2, c2));
    }
}
