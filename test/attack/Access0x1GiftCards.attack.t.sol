// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1GiftCards } from "../../src/Access0x1GiftCards.sol";
import { IAccess0x1GiftCards } from "../../src/interfaces/IAccess0x1GiftCards.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";

/// @notice FABLE RED-TEAM adversarial suite for Access0x1GiftCards. Every test here is an EXPLOIT
///         ATTEMPT, not happy-path coverage. The unit MUST resist:
///           - a card balance going NEGATIVE (over-redeem / over-transfer)
///           - redeem replay (double-debit) and reversal replay (double-credit)
///           - balance materializing from nowhere (cross-card / cross-merchant leakage)
///           - coupon cap bypass + discount overflow past the sale amount
///           - issuing / writing coupons for a merchant you do not own (authz bypass)
///           - card-id / coupon-id collision / forgery
/// @dev    A green run is the proof the unit holds. A FAILING assertion documenting a real loss is a
///         BREAK that proc-contracts must fix in src/ (red-team never edits src/).
contract Access0x1GiftCardsAttackTest is Test {
    Access0x1GiftCards internal cards;
    Access0x1Router internal router;

    address internal admin = makeAddr("gca_admin");
    address internal treasury = makeAddr("gca_treasury");
    address internal ownerA = makeAddr("gca_ownerA"); // owns merchantA
    address internal ownerB = makeAddr("gca_ownerB"); // owns merchantB
    address internal attacker = makeAddr("gca_attacker");
    address internal victim = makeAddr("gca_victim");

    uint256 internal merchantA;
    uint256 internal merchantB;
    bytes32 internal constant CODE = keccak256("CARD");
    uint256 internal constant FACE = 100e8;

    function setUp() public {
        router = new Access0x1Router(admin, treasury, 100);
        cards = new Access0x1GiftCards(admin, router);

        vm.prank(ownerA);
        merchantA = router.registerMerchant(makeAddr("payoutA"), address(0), 0, keccak256("A"));
        vm.prank(ownerB);
        merchantB = router.registerMerchant(makeAddr("payoutB"), address(0), 0, keccak256("B"));
    }

    function _issueA(address recipient, uint256 face) internal returns (uint256 id) {
        vm.prank(ownerA);
        id = cards.issueCard(merchantA, CODE, recipient, face);
    }

    /*//////////////////////////////////////////////////////////////
            ATTACK 1 — NEVER-NEGATIVE BALANCE (the canonical CR invariant)
    //////////////////////////////////////////////////////////////*/

    /// @notice HEADLINE INVARIANT. A redeem can never drive a balance negative: asking for more than
    ///         the balance clamps to the balance (applied == balance), and a SECOND redeem on the
    ///         emptied card applies zero — it can never wrap to a huge number or owe the merchant.
    function test_attack_redeemCannotGoNegative() public {
        uint256 id = _issueA(victim, FACE);

        vm.startPrank(victim);
        uint256 applied1 = cards.redeem(id, FACE + 1e8, keccak256("r1")); // over-ask
        assertEq(applied1, FACE, "applied clamps to balance");
        assertEq(cards.balanceOf(victim, id), 0, "balance floored at zero");

        // A second redeem on the empty card applies nothing — never a negative/underflow.
        uint256 applied2 = cards.redeem(id, 50e8, keccak256("r2"));
        assertEq(applied2, 0);
        assertEq(cards.balanceOf(victim, id), 0);
        vm.stopPrank();
    }

    /// @notice Fuzz the never-negative guard: across ANY issue + redeem amounts, the applied amount is
    ///         always `min(balance, ask)` and the post-balance is always `oldBalance - applied >= 0`.
    function testFuzz_attack_redeemNeverNegative(uint256 face, uint256 ask) public {
        face = bound(face, 1, 1_000_000e8);
        ask = bound(ask, 1, 2_000_000e8);
        uint256 id = _issueA(victim, face);

        vm.prank(victim);
        uint256 applied = cards.redeem(id, ask, keccak256("r1"));

        assertLe(applied, face, "applied never exceeds the balance");
        assertEq(applied, ask < face ? ask : face, "applied == min(balance, ask)");
        assertEq(cards.balanceOf(victim, id), face - applied, "balance = old - applied, never < 0");
    }

    /// @notice A transfer cannot create balance: moving the whole balance leaves zero and a further
    ///         1-unit move reverts (the never-negative guard for transfers).
    function test_attack_transferCannotUnderflow() public {
        uint256 id = _issueA(victim, FACE);
        vm.startPrank(victim);
        cards.transfer(attacker, id, FACE);
        assertEq(cards.balanceOf(victim, id), 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__TransferExceedsBalance.selector, id, victim, 0, 1
            )
        );
        cards.transfer(attacker, id, 1);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
            ATTACK 2 — REPLAY (double-debit) / REVERSAL (double-credit)
    //////////////////////////////////////////////////////////////*/

    /// @notice The attacker cannot replay a redemptionId to debit a victim card twice (or, on a
    ///         self-card, cannot reuse a successful redemption to game an off-chain settlement twice).
    function test_attack_redeemReplayBlocked() public {
        uint256 id = _issueA(victim, FACE);
        bytes32 rid = keccak256("dup");
        vm.startPrank(victim);
        cards.redeem(id, 40e8, rid);
        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1GiftCards.GiftCards__RedemptionUsed.selector, rid)
        );
        cards.redeem(id, 40e8, rid);
        vm.stopPrank();
        assertEq(cards.balanceOf(victim, id), FACE - 40e8, "debited exactly once");
    }

    /// @notice A reversal cannot be replayed to credit a card balance up out of thin air. The merchant
    ///         owner calling reverse N times credits the applied amount back exactly ONCE.
    function test_attack_reversalCannotDoubleCredit() public {
        uint256 id = _issueA(victim, FACE);
        bytes32 rid = keccak256("rev");
        vm.prank(victim);
        cards.redeem(id, 60e8, rid);

        // Hammer the reverse (as the merchant owner — the only authorized reverser) — only the first
        // credits back.
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(ownerA);
            cards.reverseRedemption(rid);
        }
        assertEq(cards.balanceOf(victim, id), FACE, "credited back exactly once, no inflation");
    }

    /// @notice A reversal of an unknown id reverts — an attacker cannot conjure a credit by reversing
    ///         a redemption that never happened.
    function test_attack_reverseUnknownReverts() public {
        bytes32 rid = keccak256("ghost");
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1GiftCards.GiftCards__RedemptionUnknown.selector, rid)
        );
        cards.reverseRedemption(rid);
        assertEq(cards.balanceOf(attacker, cards.cardId(merchantA, CODE)), 0);
    }

    /// @notice Fuzz the redeem/reverse conservation: after a redeem of `applied` and a (possibly
    ///         repeated) reverse, the balance is exactly the original face — value is conserved.
    function testFuzz_attack_redeemThenReverseConserves(uint256 face, uint256 ask, uint8 reverses)
        public
    {
        face = bound(face, 1, 1_000_000e8);
        ask = bound(ask, 1, 1_000_000e8);
        uint256 id = _issueA(victim, face);

        bytes32 rid = keccak256("c1");
        vm.prank(victim);
        uint256 applied = cards.redeem(id, ask, rid);
        assertEq(cards.balanceOf(victim, id), face - applied);

        // The merchant owner is the only party that can reverse (a value-bearing reverse is owner-gated;
        // a zero-applied one is a permissionless no-op — pranking the owner covers both safely).
        uint256 n = uint256(reverses) % 4;
        for (uint256 i = 0; i < n; i++) {
            vm.prank(ownerA);
            cards.reverseRedemption(rid);
        }
        // If reversed at all, full face is back; otherwise the debit stands. Never more than face.
        uint256 expected = n == 0 ? face - applied : face;
        assertEq(cards.balanceOf(victim, id), expected);
        assertLe(cards.balanceOf(victim, id), face, "balance never exceeds issued face");
    }

    /*//////////////////////////////////////////////////////////////
            ATTACK 3 — CROSS-CARD / CROSS-MERCHANT LEAKAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Redeeming the attacker's own card never touches the victim's card balance (a balance is
    ///         keyed to (holder, cardId); the attacker holds nothing on the victim's card).
    function test_attack_redeemCannotDrainAnotherHolder() public {
        uint256 id = _issueA(victim, FACE);
        // Attacker holds zero on this card id. Any redeem applies zero and cannot move victim funds.
        vm.prank(attacker);
        uint256 applied = cards.redeem(id, FACE, keccak256("r1"));
        assertEq(applied, 0, "attacker had no balance to apply");
        assertEq(cards.balanceOf(victim, id), FACE, "victim untouched");
    }

    /// @notice A merchant owner cannot issue (mint) cards for a merchant it does not own — so it
    ///         cannot inflate a different merchant's card liabilities or grief their books.
    function test_attack_cannotIssueForForeignMerchant() public {
        // ownerA tries to issue against merchantB.
        vm.prank(ownerA);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__NotMerchantOwner.selector, merchantB, ownerA
            )
        );
        cards.issueCard(merchantB, CODE, attacker, FACE);
    }

    /// @notice A merchant owner cannot write coupons into another merchant's namespace.
    function test_attack_cannotSetForeignCoupon() public {
        vm.prank(ownerA);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__NotMerchantOwner.selector, merchantB, ownerA
            )
        );
        cards.setCoupon(
            merchantB, keccak256("x"), IAccess0x1GiftCards.DiscountType.AMOUNT, 1e8, 0, 0
        );
    }

    /// @notice Coupons are namespaced per merchant: the SAME couponId under merchantA and merchantB are
    ///         independent records — consuming one never affects the other.
    function test_attack_couponNamespaceIsolation() public {
        bytes32 cid = keccak256("SHARED");
        vm.prank(ownerA);
        cards.setCoupon(merchantA, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 10, 0, 1);
        vm.prank(ownerB);
        cards.setCoupon(merchantB, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 20, 0, 1);

        vm.prank(ownerA);
        cards.applyCoupon(merchantA, cid, 100e8); // exhaust A's (consumed by A's owner)
        // B's identical-id coupon is untouched and still usable by B's owner.
        vm.prank(ownerB);
        uint256 dB = cards.applyCoupon(merchantB, cid, 100e8);
        assertEq(dB, 20e8);
        assertEq(cards.coupons(merchantA, cid).redemptionsCount, 1);
        assertEq(cards.coupons(merchantB, cid).redemptionsCount, 1);
    }

    /*//////////////////////////////////////////////////////////////
            ATTACK 4 — COUPON CAP BYPASS / DISCOUNT OVERFLOW
    //////////////////////////////////////////////////////////////*/

    /// @notice The atomic cap can never be exceeded: after `maxRedemptions` consumptions, every
    ///         further apply reverts — there is no interleaving that lets `count` pass `max`.
    function test_attack_couponCapCannotBeExceeded() public {
        bytes32 cid = keccak256("CAP3");
        vm.startPrank(ownerA);
        cards.setCoupon(merchantA, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 10, 0, 3);

        for (uint256 i = 0; i < 3; i++) {
            cards.applyCoupon(merchantA, cid, 100e8);
        }
        assertEq(cards.coupons(merchantA, cid).redemptionsCount, 3);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__CouponExhausted.selector, merchantA, cid
            )
        );
        cards.applyCoupon(merchantA, cid, 100e8);
        vm.stopPrank();
    }

    /// @notice Fuzz: the discount returned is ALWAYS within `[0, amount]` — a coupon can never discount
    ///         more than the sale it is applied to (no negative price, no over-credit).
    function testFuzz_attack_discountBoundedBySale(bool isPercent, uint256 value, uint256 amount)
        public
    {
        amount = bound(amount, 0, 1_000_000e8);
        value = bound(value, 0, type(uint128).max);
        bytes32 cid = keccak256("FZ");
        IAccess0x1GiftCards.DiscountType dt = isPercent
            ? IAccess0x1GiftCards.DiscountType.PERCENT
            : IAccess0x1GiftCards.DiscountType.AMOUNT;
        vm.startPrank(ownerA);
        cards.setCoupon(merchantA, cid, dt, value, 0, 0);

        uint256 discount = cards.applyCoupon(merchantA, cid, amount);
        vm.stopPrank();
        assertLe(discount, amount, "discount never exceeds the sale amount");
    }

    /// @notice Fuzz: no sequence of applies + releases drives `redemptionsCount` above `maxRedemptions`
    ///         or below zero (the count is always in `[0, max]`).
    function testFuzz_attack_couponCountWithinBounds(uint32 maxR, uint8 ops, uint256 seed) public {
        maxR = uint32(bound(maxR, 1, 50));
        bytes32 cid = keccak256("CNT");
        vm.prank(ownerA);
        cards.setCoupon(merchantA, cid, IAccess0x1GiftCards.DiscountType.PERCENT, 5, 0, maxR);

        uint256 n = uint256(ops) % 40;
        for (uint256 i = 0; i < n; i++) {
            // Pseudo-randomly apply or release (both merchant-owner only); both must keep the count
            // in-bounds and never revert for the wrong reason (apply reverts only when truly at cap —
            // caught and skipped).
            if (uint256(keccak256(abi.encode(seed, i))) % 2 == 0) {
                vm.prank(ownerA);
                try cards.applyCoupon(merchantA, cid, 100e8) { } catch { }
            } else {
                vm.prank(ownerA);
                cards.releaseCoupon(merchantA, cid);
            }
            uint32 count = cards.coupons(merchantA, cid).redemptionsCount;
            assertLe(count, maxR, "count never exceeds the cap");
        }
    }

    /*//////////////////////////////////////////////////////////////
            ATTACK 5 — CARD-ID / COUPON-ID COLLISION / FORGERY
    //////////////////////////////////////////////////////////////*/

    /// @notice The card id is keccak256(abi.encode(merchantId, code)). No OTHER (merchantId', code')
    ///         pair can forge the victim's card id, so a credit can never land on the victim's card.
    function testFuzz_attack_cannotForgeVictimCardId(uint256 mid, bytes32 code) public view {
        uint256 victimId = cards.cardId(merchantA, CODE);
        vm.assume(mid != merchantA || code != CODE);
        assertTrue(
            cards.cardId(mid, code) != victimId,
            "BREAK: card-id collision - a different pair forged the victim card id"
        );
    }

    /// @notice abi.encode (not encodePacked) means no boundary aliasing between the merchantId word and
    ///         the code word — a classic packed-collision shape stays distinct.
    function test_attack_noEncodePackedAliasing() public view {
        // Under encodePacked, (mid=0xAA.., code=0x..) split shifts could alias; under encode each is
        // its own 32-byte word.
        uint256 id1 = cards.cardId(0xAA, bytes32(uint256(0xBB)));
        uint256 id2 = cards.cardId(0xAABB, bytes32(0));
        assertTrue(id1 != id2, "BREAK: encodePacked-style aliasing collision");
    }

    /*//////////////////////////////////////////////////////////////
            ATTACK 6 — ZERO / DUST EDGE CASES
    //////////////////////////////////////////////////////////////*/

    /// @notice A zero-amount redeem is rejected — no empty replay-guard record that could confuse
    ///         off-chain settlement, and no zero-value event spoofing.
    function test_attack_zeroRedeemRejected() public {
        uint256 id = _issueA(victim, FACE);
        vm.prank(victim);
        vm.expectRevert(IAccess0x1GiftCards.GiftCards__ZeroAmount.selector);
        cards.redeem(id, 0, keccak256("r1"));
    }

    /// @notice A zero redemptionId is rejected — the zero key is reserved as "no redemption", so it can
    ///         never be recorded (which would make reverse(0) spuriously succeed).
    function test_attack_zeroRedemptionIdRejected() public {
        uint256 id = _issueA(victim, FACE);
        vm.prank(victim);
        vm.expectRevert(IAccess0x1GiftCards.GiftCards__ZeroAmount.selector);
        cards.redeem(id, 10e8, bytes32(0));
    }

    /// @notice A 1-unit dust card round-trips exactly: issue 1, redeem 1, balance to 0; reverse, back
    ///         to 1. No rounding creates or destroys value.
    function test_attack_dustRoundTripExact() public {
        uint256 id = _issueA(victim, 1);
        bytes32 rid = keccak256("dust");
        vm.prank(victim);
        assertEq(cards.redeem(id, 1, rid), 1);
        assertEq(cards.balanceOf(victim, id), 0);
        vm.prank(ownerA);
        cards.reverseRedemption(rid);
        assertEq(cards.balanceOf(victim, id), 1);
    }
}
