// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";

import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1GiftCards } from "../../src/Access0x1GiftCards.sol";
import { IAccess0x1GiftCards } from "../../src/interfaces/IAccess0x1GiftCards.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @title  GiftCardNeverNegative — a prepaid balance that can be spent down but NEVER overdrawn
/// @author Access0x1
/// @notice SCENARIO: a bakery sells a $50 gift card. The recipient spends it across a few visits.
///         The single invariant the whole contract exists to protect: a redemption can spend AT MOST
///         the remaining balance, and the balance can NEVER go negative. Over-redeeming simply applies
///         what's left (and the next redemption applies zero) — it never underflows, never reverts the
///         customer's checkout, and never mints value out of thin air.
///
///         This primitive holds NO tokens — it is a pure USD-denominated accounting receipt (the
///         ERC-6909-style "gift card"). So the security surface IS the never-negative balance, and
///         that is exactly what these scenarios pin down.
///
///         What an auditor is checking:
///           1. Issuance is gated to the merchant owner; the face value mints to the recipient.
///           2. A redemption debits `min(balance, requested)` — spending past the balance applies only
///              what remains, leaving the balance at exactly zero, never negative.
///           3. Replay guard: the same redemptionId can be used at most once.
///           4. CONSERVATION across transfer + reverse: value moves between holders or is credited
///              back, but the total tied to a card is conserved.
contract GiftCardNeverNegativeScenarioTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    Access0x1GiftCards internal cards;

    address internal platformAdmin = makeAddr("access0x1-platform-admin");
    address internal treasury = makeAddr("access0x1-treasury");
    address internal bakeryOwner = makeAddr("rise-bakery-owner");
    address internal bakeryPayout = makeAddr("rise-bakery-payout");
    address internal recipient = makeAddr("gift-card-recipient"); // who holds + spends the card

    uint256 internal merchantId;

    uint256 internal constant FACE_USD8 = 50e8; // a $50 gift card
    bytes32 internal constant CARD_CODE = keccak256("RISE-BDAY-2026");

    function setUp() public {
        vm.warp(1_700_000_000);

        // Both contracts run behind UUPS proxies (1% platform fee, unused here).
        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (platformAdmin, treasury, 100))
            )
        );
        cards = Access0x1GiftCards(
            deployProxy(
                address(new Access0x1GiftCards()),
                abi.encodeCall(Access0x1GiftCards.initialize, (platformAdmin, router))
            )
        );

        // The bakery onboards on the router (the GiftCards contract reads it for owner-authorization).
        vm.prank(bakeryOwner);
        merchantId = router.registerMerchant(bakeryPayout, address(0), 0, keccak256("rise-bakery"));
    }

    /// @notice Issue $50, spend it down across visits, and prove the balance never goes negative.
    function test_scenario_giftCard_issuedAndRedeemed_neverGoesNegative() public {
        // The bakery issues a $50 card to the recipient (it asserts it already collected the $50
        // off-ledger — the prepaid balance is a fully-backed receipt, never minted on credit).
        vm.prank(bakeryOwner);
        uint256 cardId = cards.issueCard(merchantId, CARD_CODE, recipient, FACE_USD8);
        assertEq(
            cards.balanceOf(recipient, cardId), FACE_USD8, "card minted with the $50 face value"
        );
        assertEq(cards.cardMerchant(cardId), merchantId, "card bound to the issuing bakery");

        // Visit 1: a $20 muffin run. Debit applies $20; $30 remains.
        vm.prank(recipient);
        uint256 applied1 = cards.redeem(cardId, 20e8, keccak256("redeem-visit-1"));
        assertEq(applied1, 20e8, "applied the full $20 (balance covered it)");
        assertEq(cards.balanceOf(recipient, cardId), 30e8, "$30 left after the first visit");

        // Visit 2: a $25 cake. Debit applies $25; $5 remains.
        vm.prank(recipient);
        uint256 applied2 = cards.redeem(cardId, 25e8, keccak256("redeem-visit-2"));
        assertEq(applied2, 25e8, "applied the full $25");
        assertEq(cards.balanceOf(recipient, cardId), 5e8, "$5 left after the second visit");

        // Visit 3: the recipient tries to buy a $40 hamper with only $5 left. The redemption applies
        // ONLY the remaining $5 — it does NOT overdraw, does NOT revert the checkout, does NOT
        // underflow. The customer covers the $35 difference through the router in the real flow.
        vm.prank(recipient);
        uint256 applied3 = cards.redeem(cardId, 40e8, keccak256("redeem-visit-3"));
        assertEq(applied3, 5e8, "over-redeem applied ONLY the $5 remaining (never more)");
        assertEq(
            cards.balanceOf(recipient, cardId), 0, "balance floored at exactly zero, never negative"
        );

        // Visit 4: the card is empty. A redemption applies zero — a clean no-op, never negative.
        vm.prank(recipient);
        uint256 applied4 = cards.redeem(cardId, 10e8, keccak256("redeem-visit-4-empty"));
        assertEq(applied4, 0, "empty card applies zero");
        assertEq(
            cards.balanceOf(recipient, cardId), 0, "still exactly zero (the never-negative wall)"
        );
    }

    /// @notice The replay guard: a redemptionId is one-shot, so a re-submitted redemption reverts.
    function test_scenario_giftCard_redemptionId_isOneShot() public {
        vm.prank(bakeryOwner);
        uint256 cardId = cards.issueCard(merchantId, CARD_CODE, recipient, FACE_USD8);

        bytes32 rid = keccak256("redeem-once");
        vm.prank(recipient);
        cards.redeem(cardId, 10e8, rid);
        assertEq(cards.balanceOf(recipient, cardId), 40e8, "$40 left after a $10 redemption");

        // Re-using the same redemptionId reverts — a replayed redemption can never double-debit.
        vm.prank(recipient);
        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1GiftCards.GiftCards__RedemptionUsed.selector, rid)
        );
        cards.redeem(cardId, 10e8, rid);
        assertEq(cards.balanceOf(recipient, cardId), 40e8, "replay did not debit again");
    }

    /// @notice Transfer + reverse conserve value, and a transfer can never exceed the holder's balance.
    function test_scenario_giftCard_transferAndReverse_conserveValue() public {
        address friend = makeAddr("gift-recipient-friend");

        vm.prank(bakeryOwner);
        uint256 cardId = cards.issueCard(merchantId, CARD_CODE, recipient, FACE_USD8);

        // The recipient gifts $30 of the card balance to a friend. Value moves, total is conserved.
        vm.prank(recipient);
        cards.transfer(friend, cardId, 30e8);
        assertEq(cards.balanceOf(recipient, cardId), 20e8, "recipient keeps $20");
        assertEq(cards.balanceOf(friend, cardId), 30e8, "friend received $30");

        // A transfer cannot exceed the holder's balance (never-negative for transfers too).
        vm.prank(recipient);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__TransferExceedsBalance.selector,
                cardId,
                recipient,
                20e8,
                21e8
            )
        );
        cards.transfer(friend, cardId, 21e8);

        // The friend redeems $30; then the merchant reverses it (a cancelled order) and the friend's
        // balance is credited back — exactly the value that was debited, no more, no less.
        bytes32 rid = keccak256("friend-redeem-then-reverse");
        vm.prank(friend);
        uint256 applied = cards.redeem(cardId, 30e8, rid);
        assertEq(applied, 30e8, "friend redeemed the full $30");
        assertEq(cards.balanceOf(friend, cardId), 0, "friend's card spent to zero");

        // The merchant owner reverses (only it may re-credit a spent balance).
        vm.prank(bakeryOwner);
        cards.reverseRedemption(rid);
        assertEq(cards.balanceOf(friend, cardId), 30e8, "reversal credited the exact $30 back");

        // A second reverse is a clean idempotent no-op — never a double-credit.
        vm.prank(bakeryOwner);
        cards.reverseRedemption(rid);
        assertEq(
            cards.balanceOf(friend, cardId), 30e8, "idempotent: no double-credit on re-reverse"
        );
    }
}
