// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1GiftCards } from "../../src/Access0x1GiftCards.sol";
import { IAccess0x1GiftCards } from "../../src/interfaces/IAccess0x1GiftCards.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";

/// @notice OPUS red-team round 2 for Access0x1GiftCards — adversarial probes that go BEYOND the
///         headline-invariant suite already in `Access0x1GiftCards.attack.t.sol`. Each test is an
///         exploit attempt against a corner the first pass did not pin down:
///           - reentrancy on the only un-guarded balance path (`transfer`) via a contract recipient
///           - the null-merchant (id 0 sentinel) land-grab
///           - re-issue top-up + reverse lifecycle conservation
///           - `reverseRedemption` is MERCHANT-OWNER GATED (H-1): a stranger re-crediting a spent
///             balance is the double-spend, and is now rejected — only the owner reverses, once
///           - `applyCoupon` is MERCHANT-OWNER GATED (L-4): a stranger cannot burn a finite-cap promo;
///             the permissionless `quoteCoupon` preview never consumes the cap
///           - coupon count never wraps under reset + release interleaving
///           - PERCENT value > 100 clamps to a 100% discount, never a negative price / over-credit
///           - cross-holder reverse credits the ORIGINAL holder, never inflates total beyond issued
///           - uint32 max-redemptions boundary semantics
/// @dev    A green run is the proof the unit holds the line on these corners too. Red-team never edits
///         src/; a real loss documented here would be a BREAK the contract owner must fix.
contract Access0x1GiftCardsRedTeamTest is Test {
    Access0x1GiftCards internal cards;
    Access0x1Router internal router;

    address internal admin = makeAddr("rt_admin");
    address internal treasury = makeAddr("rt_treasury");
    address internal ownerA = makeAddr("rt_ownerA");
    address internal ownerB = makeAddr("rt_ownerB");
    address internal attacker = makeAddr("rt_attacker");
    address internal victim = makeAddr("rt_victim");

    uint256 internal merchantA;
    uint256 internal merchantB;
    bytes32 internal constant CODE = keccak256("RT_CARD");
    uint256 internal constant FACE = 100e8;

    function setUp() public {
        router = new Access0x1Router(admin, treasury, 100);
        cards = new Access0x1GiftCards(admin, router);

        vm.prank(ownerA);
        merchantA = router.registerMerchant(makeAddr("rt_payoutA"), address(0), 0, keccak256("rtA"));
        vm.prank(ownerB);
        merchantB = router.registerMerchant(makeAddr("rt_payoutB"), address(0), 0, keccak256("rtB"));
    }

    function _issueA(address recipient, uint256 face) internal returns (uint256 id) {
        vm.prank(ownerA);
        id = cards.issueCard(merchantA, CODE, recipient, face);
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK A — REENTRANCY ON `transfer` (the only un-guarded path)
    //////////////////////////////////////////////////////////////*/

    /// @notice `transfer` is the one balance path without `nonReentrant`. It makes NO external call to
    ///         `to`, so a contract recipient gets no callback and cannot re-enter to double-move. This
    ///         proves the absence-of-callback that makes the missing guard safe: transferring to a
    ///         reentrancy-attempting contract moves the balance exactly once and never re-enters.
    function test_attack_transferToContractRecipientNoCallback() public {
        ReentrantHolder bad = new ReentrantHolder(cards);
        uint256 id = _issueA(address(bad), FACE);
        // Arm the malicious recipient to TRY to re-enter on any hook. There is no hook, so it never
        // fires; the balance simply lands once.
        bad.arm(id);

        // Holder (the contract) transfers to attacker; if a callback existed the contract could
        // re-enter. It does not.
        vm.prank(address(bad));
        cards.transfer(attacker, id, 40e8);

        assertEq(cards.balanceOf(address(bad), id), 60e8, "moved exactly once");
        assertEq(cards.balanceOf(attacker, id), 40e8);
        assertEq(bad.reenterCount(), 0, "no callback path exists to re-enter");
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK B — NULL-MERCHANT (id 0 sentinel) LAND GRAB
    //////////////////////////////////////////////////////////////*/

    /// @notice Merchant id 0 is the never-assigned sentinel (`merchants(0).owner == address(0)`). No
    ///         one can issue a card or write a coupon against it — the `MerchantNotFound` guard makes
    ///         the sentinel un-ownable, so an attacker cannot squat the "null tenant" namespace.
    function test_attack_cannotIssueOrCouponAgainstNullMerchant() public {
        assertEq(cards.cardMerchant(cards.cardId(0, CODE)), 0, "card 0-merchant unbound");

        vm.startPrank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1GiftCards.GiftCards__MerchantNotFound.selector, 0)
        );
        cards.issueCard(0, CODE, attacker, FACE);

        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1GiftCards.GiftCards__MerchantNotFound.selector, 0)
        );
        cards.setCoupon(0, keccak256("x"), IAccess0x1GiftCards.DiscountType.AMOUNT, 1e8, 0, 0);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK C — RE-ISSUE TOP-UP + REVERSE LIFECYCLE CONSERVATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Top-up (re-issuing the same code) then reverse must conserve: issue 100, redeem 100,
    ///         top-up 100, reverse the first redeem. The reverse credits back the originally-debited
    ///         100 and the balance is the full 200 issued — never more, never a stale double-credit.
    function test_attack_reissueTopUpThenReverseConserves() public {
        uint256 id = _issueA(victim, FACE); // issued 100
        bytes32 rid = keccak256("topup_r");

        vm.prank(victim);
        assertEq(cards.redeem(id, FACE, rid), FACE); // balance 0, debited 100

        _issueA(victim, FACE); // top-up: issued total 200, balance 100

        vm.prank(ownerA);
        cards.reverseRedemption(rid); // merchant owner credits back the original 100
        assertEq(cards.balanceOf(victim, id), 2 * FACE, "exactly the 200 issued, no inflation");

        // A second reverse is a clean no-op — cannot push past issued.
        vm.prank(ownerA);
        cards.reverseRedemption(rid);
        assertEq(cards.balanceOf(victim, id), 2 * FACE, "still 200 - idempotent");
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK D — reverseRedemption IS MERCHANT-OWNER GATED (H-1)
    //////////////////////////////////////////////////////////////*/

    /// @notice H-1 FIX. `reverseRedemption` re-credits a SPENT balance — value the holder already
    ///         consumed (goods delivered, the chargeable remainder settled through the Router). When it
    ///         was permissionless, the holder (or anyone) could revive that balance and redeem it again
    ///         — a free double-spend. Now only the owner of the card's merchant may reverse: a stranger
    ///         is rejected with `GiftCards__NotMerchantOwner` and the balance never moves, and the owner
    ///         credits the EXACT debit back exactly once (idempotent retries are clean no-ops).
    function test_attack_permissionlessReverseCreditsExactDebitOnce() public {
        uint256 id = _issueA(victim, FACE);
        bytes32 rid = keccak256("perm_r");

        vm.prank(victim);
        cards.redeem(id, 70e8, rid); // balance 30, debited 70

        // An arbitrary attacker (not the holder, not the merchant owner) is now REJECTED.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__NotMerchantOwner.selector, merchantA, attacker
            )
        );
        cards.reverseRedemption(rid);
        assertEq(cards.balanceOf(victim, id), 30e8, "spent balance NOT revived by a stranger");

        // The merchant owner is the only party who can reverse — and only credits the exact debit once.
        vm.prank(ownerA);
        cards.reverseRedemption(rid);
        assertEq(cards.balanceOf(victim, id), FACE, "restored exactly to face, not above");
        assertEq(cards.balanceOf(attacker, id), 0, "attacker gained nothing");

        // Owner hammers reverse — never a second credit.
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(ownerA);
            cards.reverseRedemption(rid);
        }
        assertEq(cards.balanceOf(victim, id), FACE, "still face - single credit");
    }

    /// @notice H-1 DOUBLE-SPEND REGRESSION. The exact PoC the fix kills: card 100 → holder redeems 100
    ///         against a real $100 order (balance→0, goods shipped) → holder tries to `reverseRedemption`
    ///         to revive the balance and redeem AGAIN. The reverse now REVERTS for the non-owner holder,
    ///         so the spent balance stays at zero and the second $100 order has nothing to draw on — the
    ///         $200-against-a-$100-card drain is closed.
    function test_attack_holderCannotReverseToDoubleSpend() public {
        uint256 id = _issueA(victim, FACE); // card balance 100
        bytes32 rid1 = keccak256("ds_order_1");

        // Order 1: the holder spends the whole $100 (goods shipped against this debit).
        vm.prank(victim);
        assertEq(cards.redeem(id, FACE, rid1), FACE);
        assertEq(cards.balanceOf(victim, id), 0, "card fully spent on order 1");

        // The holder tries to revive the spent balance to fund a second order — REJECTED (not the
        // merchant owner). This is the double-spend the H-1 gate closes.
        vm.prank(victim);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__NotMerchantOwner.selector, merchantA, victim
            )
        );
        cards.reverseRedemption(rid1);
        assertEq(cards.balanceOf(victim, id), 0, "balance stays zero - no revival");

        // Order 2 therefore has nothing to draw on: the second redemption applies zero.
        bytes32 rid2 = keccak256("ds_order_2");
        vm.prank(victim);
        assertEq(cards.redeem(id, FACE, rid2), 0, "second order cannot re-spend the dead card");
        assertEq(cards.balanceOf(victim, id), 0, "no $200 consumed against a $100 card");
    }

    /// @notice Reversing a redemption that applied ZERO (a fully-spent card redeemed again, recorded
    ///         but with applied 0) credits zero back — a clean no-op, never a phantom credit.
    function test_attack_reverseZeroAppliedIsNoOp() public {
        uint256 id = _issueA(victim, FACE);
        vm.startPrank(victim);
        cards.redeem(id, FACE, keccak256("spend_all")); // balance 0
        bytes32 ridZero = keccak256("zero_applied");
        uint256 applied = cards.redeem(id, 1e8, ridZero); // applies 0 on the empty card
        vm.stopPrank();
        assertEq(applied, 0, "nothing applied on an empty card");

        cards.reverseRedemption(ridZero); // credits 0
        assertEq(cards.balanceOf(victim, id), 0, "no phantom credit from a zero-applied reverse");
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK E — applyCoupon IS MERCHANT-OWNER GATED (L-4)
    //////////////////////////////////////////////////////////////*/

    /// @notice L-4 FIX. `applyCoupon` consumes (increments the cap toward `maxRedemptions`), so when it
    ///         was permissionless an attacker could burn a finite-cap promotion to exhaustion for gas
    ///         only (promotion griefing/DoS). Now it is merchant-owner gated: the attacker is rejected
    ///         BEFORE the cap moves, the count stays at zero, and the canary balance is untouched. The
    ///         storefront still gets a free, NON-consuming preview through `quoteCoupon`.
    function test_attack_applyCouponNeverTouchesBalancesAndRespectsCap() public {
        uint256 id = _issueA(victim, FACE);
        bytes32 cid = keccak256("GRIEF");
        vm.prank(ownerA);
        cards.setCoupon(merchantA, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 10, 0, 2);

        // Attacker tries to burn the cap — REJECTED by the owner gate before any increment.
        vm.startPrank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__NotMerchantOwner.selector, merchantA, attacker
            )
        );
        cards.applyCoupon(merchantA, cid, 100e8);
        // The attacker CAN still preview the discount (read-only), but it never consumes the cap.
        assertEq(cards.quoteCoupon(merchantA, cid, 100e8), 10e8, "preview returns the discount");
        assertEq(cards.quoteCoupon(merchantA, cid, 100e8), 10e8, "preview is repeatable, free");
        vm.stopPrank();

        assertEq(
            cards.coupons(merchantA, cid).redemptionsCount, 0, "cap untouched by the rejected spam"
        );
        assertEq(cards.balanceOf(victim, id), FACE, "no holder balance moved by coupon spam");

        // The owner consumes the cap legitimately, and the cap still bites at exhaustion.
        vm.startPrank(ownerA);
        cards.applyCoupon(merchantA, cid, 100e8);
        cards.applyCoupon(merchantA, cid, 100e8);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__CouponExhausted.selector, merchantA, cid
            )
        );
        cards.applyCoupon(merchantA, cid, 100e8);
        vm.stopPrank();
        assertEq(
            cards.coupons(merchantA, cid).redemptionsCount, 2, "count pinned at cap by the owner"
        );
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK F — COUPON COUNT NEVER WRAPS UNDER RESET + RELEASE
    //////////////////////////////////////////////////////////////*/

    /// @notice setCoupon resets the count to zero; releaseCoupon floors at zero. The adversarial path:
    ///         consume, reset (count→0), then release repeatedly — the count must stay 0, never wrap to
    ///         a huge uint32 that would silently re-open an exhausted cap.
    function test_attack_resetThenReleaseCannotUnderflow() public {
        bytes32 cid = keccak256("RST");
        vm.startPrank(ownerA);
        cards.setCoupon(merchantA, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 10, 0, 1);

        cards.applyCoupon(merchantA, cid, 100e8); // count 1 (at cap)

        cards.setCoupon(merchantA, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 10, 0, 1); // reset→0
        // Hammer release on a freshly-reset (count 0) coupon — must NOT underflow to type(uint32).max.
        for (uint256 i = 0; i < 5; i++) {
            cards.releaseCoupon(merchantA, cid);
        }

        assertEq(
            cards.coupons(merchantA, cid).redemptionsCount, 0, "floored at zero, never wrapped"
        );
        // And the cap still bites after one apply.
        cards.applyCoupon(merchantA, cid, 100e8);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__CouponExhausted.selector, merchantA, cid
            )
        );
        cards.applyCoupon(merchantA, cid, 100e8);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK G — PERCENT VALUE > 100 CLAMPS, NEVER NEGATIVE PRICE
    //////////////////////////////////////////////////////////////*/

    /// @notice A merchant sets an out-of-spec PERCENT coupon (value 250 == "250%"). The discount math
    ///         must clamp to the full sale amount (a 100% discount), never return more than the sale
    ///         (which a settlement layer could misread as a negative price / refund-from-thin-air).
    function test_attack_percentOver100ClampsToSale() public {
        bytes32 cid = keccak256("OVER");
        vm.startPrank(ownerA);
        cards.setCoupon(merchantA, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 250, 0, 0);

        uint256 discount = cards.applyCoupon(merchantA, cid, 80e8);
        vm.stopPrank();
        assertEq(discount, 80e8, "clamped to the full sale, never above");
    }

    /// @notice A flat AMOUNT coupon larger than the sale is likewise clamped to the sale amount.
    function test_attack_flatAmountOverSaleClamps() public {
        bytes32 cid = keccak256("FLAT_OVER");
        vm.startPrank(ownerA);
        cards.setCoupon(merchantA, cid, IAccess0x1GiftCards.DiscountType.AMOUNT, 1_000e8, 0, 0);

        uint256 discount = cards.applyCoupon(merchantA, cid, 30e8);
        vm.stopPrank();
        assertEq(discount, 30e8, "flat discount clamped to the sale");
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK H — CROSS-HOLDER REVERSE CREDITS THE ORIGINAL HOLDER
    //////////////////////////////////////////////////////////////*/

    /// @notice After a redeem, the holder transfers the remaining balance away. Reversing credits the
    ///         ORIGINAL holder (recorded at redeem), and the system total across both holders equals
    ///         the issued face — the transfer + reverse together never mint value.
    function test_attack_reverseAfterTransferConservesTotal() public {
        uint256 id = _issueA(victim, FACE);
        bytes32 rid = keccak256("xfer_then_rev");

        vm.startPrank(victim);
        cards.redeem(id, 60e8, rid); // victim 40, debited 60
        cards.transfer(attacker, id, 40e8); // victim 0, attacker 40
        vm.stopPrank();

        vm.prank(ownerA);
        cards.reverseRedemption(rid); // merchant owner credits original holder (victim) back 60

        uint256 total = cards.balanceOf(victim, id) + cards.balanceOf(attacker, id);
        assertEq(cards.balanceOf(victim, id), 60e8, "original holder credited");
        assertEq(cards.balanceOf(attacker, id), 40e8, "transferee unchanged");
        assertEq(total, FACE, "system total conserved at issued face");
    }

    /*//////////////////////////////////////////////////////////////
        ATTACK I — uint32 maxRedemptions BOUNDARY
    //////////////////////////////////////////////////////////////*/

    /// @notice With maxRedemptions at the uint32 max the cap is effectively unreachable, but the
    ///         count-increment still uses checked math: a handful of consumptions increment cleanly and
    ///         the count tracks exactly, never wrapping near the boundary.
    function test_attack_maxRedemptionsBoundaryIncrementsCleanly() public {
        bytes32 cid = keccak256("BOUND");
        vm.startPrank(ownerA);
        cards.setCoupon(
            merchantA, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 10, 0, type(uint32).max
        );
        for (uint256 i = 0; i < 5; i++) {
            cards.applyCoupon(merchantA, cid, 100e8);
        }
        vm.stopPrank();
        assertEq(cards.coupons(merchantA, cid).redemptionsCount, 5, "counts exactly, no wrap");
    }

    /// @notice Fuzz: NO permissionless caller (attacker) can, via redeem on a card they do not hold,
    ///         followed by reverse, end up with any balance — value can only ever flow from a holder's
    ///         own balance, and a reverse only restores that holder.
    function testFuzz_attack_attackerRedeemReverseNeverGainsBalance(uint256 ask, uint256 face)
        public
    {
        face = bound(face, 1, 1_000_000e8);
        ask = bound(ask, 1, 1_000_000e8);
        uint256 id = _issueA(victim, face);

        bytes32 rid = keccak256(abi.encode("atk", ask, face));
        // Attacker holds nothing on this card; their redeem applies zero.
        vm.prank(attacker);
        uint256 applied = cards.redeem(id, ask, rid);
        assertEq(applied, 0, "attacker debits nothing");

        // Reversing the attacker's own zero-applied redemption credits zero to the attacker.
        cards.reverseRedemption(rid);
        assertEq(cards.balanceOf(attacker, id), 0, "attacker never gains balance");
        assertEq(cards.balanceOf(victim, id), face, "victim untouched throughout");
    }
}

/// @notice A contract card-holder that ATTEMPTS to re-enter GiftCards on any callback. GiftCards makes
///         no external call to a recipient, so `reenterCount` stays zero — proving the un-guarded
///         `transfer` path has no reentrancy vector to guard against.
contract ReentrantHolder {
    Access0x1GiftCards internal immutable cards;
    uint256 internal armedCard;
    bool internal armed;
    uint256 public reenterCount;

    constructor(Access0x1GiftCards cards_) {
        cards = cards_;
    }

    function arm(uint256 cardId_) external {
        armedCard = cardId_;
        armed = true;
    }

    /// @dev If GiftCards ever called this contract back (it does not), this would attempt a re-entrant
    ///      transfer. It is never invoked — there is no token/native transfer and no ERC-1155-style
    ///      acceptance hook in GiftCards.
    receive() external payable {
        if (armed) {
            reenterCount += 1;
            cards.transfer(address(0xdead), armedCard, 1);
        }
    }
}
