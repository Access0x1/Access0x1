// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1GiftCards } from "../../src/Access0x1GiftCards.sol";
import { IAccess0x1GiftCards } from "../../src/interfaces/IAccess0x1GiftCards.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";

/// @notice Drives the GiftCards invariant fuzzer through issue / redeem / reverse / transfer plus the
///         coupon apply / release surface, across a fixed set of holders + cards + coupons, while
///         tracking ghost totals the suite checks the contract against. Every action is written to
///         NEVER revert (the suite runs `fail_on_revert = true`): inputs are `bound`ed and
///         preconditions early-return.
/// @dev    The handler owns merchantA (so it can issue + write coupons) and tracks, per card:
///           ghostIssued   — Σ face values ever minted to that card
///           ghostRedeemed  — Σ amounts currently debited (net of reversals)
///         The conservation invariant is: Σ holder balances on a card == ghostIssued - ghostRedeemed.
///         A FROZEN CANARY card (held by `canaryHolder`) is issued ONCE in the constructor and never
///         touched by any action — the isolation invariant asserts its balance never moves.
contract GiftCardsHandler is Test {
    Access0x1GiftCards public immutable cards;
    Access0x1Router public immutable router;
    address public immutable merchantOwner;
    uint256 public immutable merchantId;

    /// @notice The holders the fuzzer issues/redeems/transfers among (canary excluded).
    address[3] public holders;

    /// @notice The card ids in play (a small fixed set so balances actually accumulate).
    uint256[2] public cardIds;
    bytes32[2] internal codes;

    /// @notice A coupon under merchantId the fuzzer applies/releases.
    bytes32 public constant COUPON = keccak256("HANDLER_COUPON");
    uint32 public constant COUPON_MAX = 100;

    // ---- frozen canary (isolation invariant) ----
    address public canaryHolder;
    uint256 public canaryCardId;
    uint256 public canaryBalance;

    // ---- ghost accounting (conservation invariant), per card id ----
    mapping(uint256 cardId => uint256 issued) public ghostIssued;
    mapping(uint256 cardId => uint256 redeemed) public ghostRedeemed;

    // ---- redemption bookkeeping so reverses are real (not no-ops on unknown ids) ----
    bytes32[] internal liveRedemptions; // redemptionIds that have been redeemed (may be reversed)
    mapping(bytes32 => bool) internal usedRedemptionId;
    mapping(bytes32 => bool) internal reversedRedemptionId;
    mapping(bytes32 => uint256) internal redemptionCard;
    mapping(bytes32 => uint256) internal redemptionAmount;
    uint256 internal nonce;

    constructor(
        Access0x1GiftCards cards_,
        Access0x1Router router_,
        address merchantOwner_,
        uint256 merchantId_
    ) {
        cards = cards_;
        router = router_;
        merchantOwner = merchantOwner_;
        merchantId = merchantId_;

        holders[0] = makeAddr("gc_h0");
        holders[1] = makeAddr("gc_h1");
        holders[2] = makeAddr("gc_h2");

        codes[0] = keccak256("HANDLER_CARD_0");
        codes[1] = keccak256("HANDLER_CARD_1");
        cardIds[0] = cards_.cardId(merchantId_, codes[0]);
        cardIds[1] = cards_.cardId(merchantId_, codes[1]);

        // Define the coupon used by the apply/release actions.
        vm.prank(merchantOwner_);
        cards_.setCoupon(
            merchantId_, COUPON, IAccess0x1GiftCards.DiscountType.PERCENT, 10, 0, COUPON_MAX
        );
    }

    /// @notice Seed the frozen canary card — called once by the test. Never touched again by any
    ///         fuzzed action, so the isolation invariant can assert its balance is immutable.
    function seedCanary() external {
        canaryHolder = makeAddr("gc_canary");
        canaryBalance = 4242e8;
        bytes32 canaryCode = keccak256("CANARY_CARD");
        canaryCardId = cards.cardId(merchantId, canaryCode);
        vm.prank(merchantOwner);
        cards.issueCard(merchantId, canaryCode, canaryHolder, canaryBalance);
    }

    function _holder(uint256 seed) internal view returns (address) {
        return holders[seed % holders.length];
    }

    function _cardIndex(uint256 seed)
        internal
        view
        returns (uint256 idx, uint256 id, bytes32 code)
    {
        idx = seed % cardIds.length;
        id = cardIds[idx];
        code = codes[idx];
    }

    /*//////////////////////////////////////////////////////////////
                                ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Issue a (bounded) face value to a chosen holder + card.
    function issue(uint256 hSeed, uint256 cSeed, uint256 face) external {
        address h = _holder(hSeed);
        (, uint256 id, bytes32 code) = _cardIndex(cSeed);
        face = bound(face, 1, 1_000_000e8);
        vm.prank(merchantOwner);
        cards.issueCard(merchantId, code, h, face);
        ghostIssued[id] += face;
    }

    /// @notice A holder redeems a (bounded) amount of a card it holds. Records the redemption so it can
    ///         be reversed later.
    function redeem(uint256 hSeed, uint256 cSeed, uint256 amount) external {
        address h = _holder(hSeed);
        (, uint256 id,) = _cardIndex(cSeed);
        uint256 bal = cards.balanceOf(h, id);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);

        bytes32 rid = keccak256(abi.encode("rid", nonce++));
        vm.prank(h);
        uint256 applied = cards.redeem(id, amount, rid);

        ghostRedeemed[id] += applied;
        usedRedemptionId[rid] = true;
        redemptionCard[rid] = id;
        redemptionAmount[rid] = applied;
        liveRedemptions.push(rid);
    }

    /// @notice Reverse a previously recorded redemption (the first reverse credits back; later ones are
    ///         clean no-ops the contract guards). A value-bearing reverse is merchant-owner gated (H-1),
    ///         so the handler reverses AS the merchant owner — the only party authorized to re-credit a
    ///         spent balance.
    function reverse(uint256 rSeed) external {
        uint256 len = liveRedemptions.length;
        if (len == 0) return;
        bytes32 rid = liveRedemptions[rSeed % len];
        if (!usedRedemptionId[rid]) return;
        bool already = reversedRedemptionId[rid];
        vm.prank(merchantOwner);
        cards.reverseRedemption(rid);
        if (!already) {
            // Only the first effective reverse moves balance + ghost accounting.
            reversedRedemptionId[rid] = true;
            ghostRedeemed[redemptionCard[rid]] -= redemptionAmount[rid];
        }
    }

    /// @notice Move part of one holder's card balance to another (transfers conserve issued/redeemed).
    function transfer(uint256 fromSeed, uint256 toSeed, uint256 cSeed, uint256 amount) external {
        address from = _holder(fromSeed);
        address to = _holder(toSeed);
        if (to == address(0)) return;
        (, uint256 id,) = _cardIndex(cSeed);
        uint256 bal = cards.balanceOf(from, id);
        if (bal == 0) return;
        amount = bound(amount, 0, bal);
        vm.prank(from);
        cards.transfer(to, id, amount);
        // ghost accounting unchanged: a transfer moves a receipt between holders, not in/out of issued.
    }

    /// @notice Apply the handler's coupon (no-op-guarded: skip when at cap so fail_on_revert holds).
    ///         Consumption is merchant-owner gated (L-4), so the handler applies AS the merchant owner.
    function applyCoupon(uint256 amount) external {
        IAccess0x1GiftCards.Coupon memory c = cards.coupons(merchantId, COUPON);
        if (c.redemptionsCount >= COUPON_MAX) return;
        amount = bound(amount, 0, 1_000_000e8);
        vm.prank(merchantOwner);
        cards.applyCoupon(merchantId, COUPON, amount);
    }

    /// @notice Release one coupon consumption (floored at zero by the contract).
    function releaseCoupon() external {
        vm.prank(merchantOwner);
        cards.releaseCoupon(merchantId, COUPON);
    }

    /*//////////////////////////////////////////////////////////////
                              GHOST VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice The independently-tracked outstanding balance for a card == Σ holder balances expected.
    function ghostOutstanding(uint256 id) external view returns (uint256) {
        return ghostIssued[id] - ghostRedeemed[id];
    }

    /// @notice The live sum of all (fuzzed) holders' balances on a card.
    function sumHolderBalances(uint256 id) external view returns (uint256 total) {
        total += cards.balanceOf(holders[0], id);
        total += cards.balanceOf(holders[1], id);
        total += cards.balanceOf(holders[2], id);
    }

    function cardIdAt(uint256 i) external view returns (uint256) {
        return cardIds[i];
    }
}
