// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1GiftCards } from "../../src/Access0x1GiftCards.sol";
import { IAccess0x1GiftCards } from "../../src/interfaces/IAccess0x1GiftCards.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @title  Access0x1GiftCardsFuzz
/// @author Access0x1
/// @notice STATELESS (per-call) fuzz suite for {Access0x1GiftCards} — the Cyfrin "fuzz each public
///         money-mutating function with `bound()`-constrained inputs, then assert the local invariants
///         hold for THIS call" tier. Where the unit suite pins specific values, this layer fires ONE
///         operation per run over a wide, bounded input space and proves the per-call accounting laws
///         that must hold for EVERY input — the on-chain expression of a mature commerce app's prepaid-balance
///         money invariant:
///
///           - NEVER NEGATIVE (HARD REVERT): a debit (redeem / transfer) can never drive a holder's
///             balance below zero — the post-state balance is always `>= 0` (a uint, so the real proof
///             is "the requested debit beyond balance reverts, and the applied debit never exceeds the
///             balance"), for any (face, amount) pair.
///           - CONSERVATION: across a card's whole lifecycle the live balance never exceeds what was
///             issued minus what was net-redeemed — `sum(balances) <= issued - redeemed` — and a
///             transfer conserves the per-card supply exactly (sender loses what recipient gains).
///           - IDEMPOTENT REVERSAL: a reverse credits the original holder back EXACTLY once for any
///             amount; repeated reverses are clean no-ops that never double-credit — so
///             `balance == issued` after redeem→reverse, for any redeemed amount.
///
///         Every test bounds amounts to a sane 8-decimal USD range (the estate's `usdAmount8`) with
///         `bound()` so the fuzzer spends its budget on meaningful values, never on inputs it cannot
///         satisfy. A green run is the proof the per-call laws hold across the whole input domain, not
///         just the unit suite's hand-picked points.
/// @dev    Reuses the live {Access0x1Router} merchant registry for authorization exactly as the unit
///         suite does (no duplicated owner store, no new mock). USD amounts are 8-decimal; $1 == 1e8.
contract Access0x1GiftCardsFuzzTest is Test, ProxyDeployer {
    Access0x1GiftCards internal cards;
    Access0x1Router internal router;

    address internal admin = makeAddr("gcf_admin");
    address internal treasury = makeAddr("gcf_treasury");
    address internal merchantOwner = makeAddr("gcf_merchantOwner");
    address internal alice = makeAddr("gcf_alice");
    address internal bob = makeAddr("gcf_bob");

    uint256 internal merchantId;
    bytes32 internal constant CODE = keccak256("CARD-FUZZ");

    /// @notice The largest face/amount any single fuzz run uses: $1,000,000,000 in 8-decimal USD.
    ///         Bounding here (rather than at type(uint256).max) keeps the accumulation legs free of any
    ///         contrived overflow while still spanning dust → billions; uint256-boundary overflow is an
    ///         attack-suite concern, not a per-call accounting one.
    uint256 internal constant MAX_USD8 = 1_000_000_000e8;

    function setUp() public {
        // Both contracts run behind UUPS proxies (1% platform fee, unused here).
        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (admin, treasury, 100))
            )
        );
        cards = Access0x1GiftCards(
            deployProxy(
                address(new Access0x1GiftCards()),
                abi.encodeCall(Access0x1GiftCards.initialize, (admin, router))
            )
        );

        // Register a merchant; the caller becomes its owner — the only address that may issue cards.
        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(
            makeAddr("gcf_payout"), address(0), 0, keccak256("gcf_merchant")
        );
    }

    /// @dev Issue `face` to `recipient` on the default merchant + code as the merchant owner.
    function _issue(address recipient, uint256 face) internal returns (uint256 id) {
        vm.prank(merchantOwner);
        id = cards.issueCard(merchantId, CODE, recipient, face);
    }

    /*//////////////////////////////////////////////////////////////
                             NEVER NEGATIVE
    //////////////////////////////////////////////////////////////*/

    /// @notice For ANY (face, ask) a redeem applies `min(balance, ask)` and the post-balance is exactly
    ///         `face - applied` — never underflowed, never negative. The debit can never exceed what the
    ///         holder holds, for any ask (over or under the balance).
    function testFuzz_redeem_neverDrivesBalanceNegative(uint256 face, uint256 ask) public {
        face = bound(face, 1, MAX_USD8);
        ask = bound(ask, 1, MAX_USD8);
        uint256 id = _issue(alice, face);

        vm.prank(alice);
        uint256 applied = cards.redeem(id, ask, keccak256("rid"));

        uint256 expectedApplied = ask < face ? ask : face;
        assertEq(applied, expectedApplied, "applied == min(balance, ask)");
        assertLe(applied, face, "applied never exceeds the balance");
        assertEq(
            cards.balanceOf(alice, id), face - applied, "post == face - applied, never negative"
        );
    }

    /// @notice A debit beyond the balance can NEVER over-spend: even when the ask dwarfs the face, the
    ///         applied amount caps at the face and the balance bottoms out at exactly zero — never below.
    function testFuzz_redeem_overAskBottomsAtZero(uint256 face, uint256 over) public {
        face = bound(face, 1, MAX_USD8);
        over = bound(over, 0, MAX_USD8);
        uint256 id = _issue(alice, face);

        vm.prank(alice);
        uint256 applied = cards.redeem(id, face + over, keccak256("rid"));

        assertEq(applied, face, "an over-ask applies exactly the full face, no more");
        assertEq(cards.balanceOf(alice, id), 0, "balance bottoms out at zero, never negative");
    }

    /// @notice {transfer} HARD-reverts for ANY move strictly greater than the balance — a holder can
    ///         never move more of a card than it holds, so the never-negative law holds on the transfer
    ///         leg too, for any overspend delta.
    function testFuzz_transfer_revertsBeyondBalance(uint256 face, uint256 overBy) public {
        face = bound(face, 1, MAX_USD8);
        overBy = bound(overBy, 1, type(uint128).max);
        uint256 id = _issue(alice, face);
        uint256 want = face + overBy;

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1GiftCards.GiftCards__TransferExceedsBalance.selector,
                id,
                alice,
                face,
                want
            )
        );
        cards.transfer(bob, id, want);
    }

    /*//////////////////////////////////////////////////////////////
                              CONSERVATION
    //////////////////////////////////////////////////////////////*/

    /// @notice CONSERVATION across a partial-redeem lifecycle: after issuing `face` and redeeming
    ///         `applied`, the holder's live balance is EXACTLY `issued - redeemed` for any in-range pair.
    ///         The live balance never exceeds what was issued net of what was spent.
    function testFuzz_redeem_conservesIssuedMinusRedeemed(uint256 face, uint256 ask) public {
        face = bound(face, 1, MAX_USD8);
        ask = bound(ask, 1, MAX_USD8);
        uint256 id = _issue(alice, face);

        vm.prank(alice);
        uint256 redeemed = cards.redeem(id, ask, keccak256("rid"));

        // sum(balances) for this single holder == issued - redeemed, and never above issued.
        assertEq(cards.balanceOf(alice, id), face - redeemed, "balance == issued - redeemed");
        assertLe(cards.balanceOf(alice, id), face, "live balance never exceeds issued");
    }

    /// @notice A {transfer} conserves the per-card supply EXACTLY for any (face, move) within balance:
    ///         the sum of the two holders' balances equals the original face, and neither holder's
    ///         balance can exceed that face — value is moved, never minted or burned.
    function testFuzz_transfer_conservesPerCardSupply(uint256 face, uint256 moved) public {
        face = bound(face, 1, MAX_USD8);
        uint256 id = _issue(alice, face);
        moved = bound(moved, 0, face);

        vm.prank(alice);
        bool ok = cards.transfer(bob, id, moved);

        assertTrue(ok, "transfer returns true");
        assertEq(cards.balanceOf(alice, id), face - moved, "sender debited by exactly moved");
        assertEq(cards.balanceOf(bob, id), moved, "recipient credited by exactly moved");
        assertEq(
            cards.balanceOf(alice, id) + cards.balanceOf(bob, id),
            face,
            "per-card supply conserved across the two legs (sum == issued)"
        );
    }

    /// @notice Repeated issuance to the SAME card accumulates additively and stays bound to its merchant:
    ///         the balance is the running sum for any pair of faces, and the binding never drifts.
    function testFuzz_issue_accumulatesAndStaysBound(uint256 a, uint256 b) public {
        a = bound(a, 1, MAX_USD8);
        b = bound(b, 1, MAX_USD8);

        uint256 id = _issue(alice, a);
        _issue(alice, b);

        assertEq(cards.balanceOf(alice, id), a + b, "second issue accumulates onto the same card");
        assertEq(cards.cardMerchant(id), merchantId, "card stays bound to its merchant");
    }

    /*//////////////////////////////////////////////////////////////
                           IDEMPOTENT REVERSAL
    //////////////////////////////////////////////////////////////*/

    /// @notice A redeem→reverse round-trip restores the holder's balance to EXACTLY the issued face for
    ///         any redeemed amount — the reversal credits back precisely what was debited, no more.
    function testFuzz_reverse_restoresExactBalance(uint256 face, uint256 ask) public {
        face = bound(face, 1, MAX_USD8);
        ask = bound(ask, 1, MAX_USD8);
        uint256 id = _issue(alice, face);
        bytes32 rid = keccak256("rid");

        vm.prank(alice);
        cards.redeem(id, ask, rid);

        vm.prank(merchantOwner); // only the merchant owner may reverse a value-bearing redemption
        cards.reverseRedemption(rid);
        assertEq(cards.balanceOf(alice, id), face, "reverse restores the balance to exactly issued");
    }

    /// @notice The reversal is IDEMPOTENT for ANY number of repeated calls: the holder is credited back
    ///         exactly once, never multiplied. A keeper retrying `k` times can never double-credit.
    function testFuzz_reverse_isIdempotentUnderRepeats(uint256 face, uint256 ask, uint8 repeats)
        public
    {
        face = bound(face, 1, MAX_USD8);
        ask = bound(ask, 1, MAX_USD8);
        uint256 extraReverses = bound(repeats, 1, 16);
        uint256 id = _issue(alice, face);
        bytes32 rid = keccak256("rid");

        vm.prank(alice);
        cards.redeem(id, ask, rid);

        // First reverse credits back (merchant-owner gated); every subsequent one is a clean no-op.
        for (uint256 i = 0; i < extraReverses; ++i) {
            vm.prank(merchantOwner);
            cards.reverseRedemption(rid);
        }
        assertEq(
            cards.balanceOf(alice, id),
            face,
            "balance credited back exactly once despite k reverses"
        );
    }

    /// @notice The reversal credits the ORIGINAL holder recorded at redeem time, NOT whoever holds the
    ///         card now — a transfer of the remaining balance between redeem and reverse does not
    ///         redirect the credit. Conservation across the whole flow: the two holders' summed balance
    ///         equals the issued face for any (face, ask, move) triple.
    function testFuzz_reverse_creditsOriginalHolderRegardlessOfTransfer(
        uint256 face,
        uint256 ask,
        uint256 moved
    ) public {
        face = bound(face, 2, MAX_USD8);
        ask = bound(ask, 1, face - 1); // leave a remainder alice can transfer
        uint256 id = _issue(alice, face);
        bytes32 rid = keccak256("rid");

        // Alice redeems, then transfers her remaining balance to bob before the reverse fires.
        vm.startPrank(alice);
        uint256 applied = cards.redeem(id, ask, rid);
        uint256 remainder = cards.balanceOf(alice, id);
        moved = bound(moved, 0, remainder);
        cards.transfer(bob, id, moved);
        vm.stopPrank();

        // The merchant owner reverses; the credit lands on the ORIGINAL holder (alice) recorded at
        // redeem time, regardless of who triggered the reverse or who holds the card now.
        vm.prank(merchantOwner);
        cards.reverseRedemption(rid); // credits `applied` back to alice (the recorded holder)

        // Alice = (remainder - moved) + applied ; Bob = moved ; sum == issued face (conservation).
        assertEq(
            cards.balanceOf(alice, id),
            (remainder - moved) + applied,
            "credit lands on alice (original)"
        );
        assertEq(cards.balanceOf(bob, id), moved, "bob keeps exactly the transferred amount");
        assertEq(
            cards.balanceOf(alice, id) + cards.balanceOf(bob, id),
            face,
            "whole flow conserves the issued face"
        );
    }
}
