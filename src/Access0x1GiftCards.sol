// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Access0x1Router } from "./Access0x1Router.sol";
import { IAccess0x1GiftCards } from "./interfaces/IAccess0x1GiftCards.sol";

/// @title  Access0x1GiftCards
/// @author Access0x1
/// @notice A USD-priced PREPAID-BALANCE primitive (gift cards / credit packs) plus a minimal,
///         merchant-scoped COUPON registry — the on-chain expression of a mature commerce app's strongest
///         money invariant: a prepaid balance debit that can NEVER drive the balance negative
///         (`balance >= applied`), here a HARD revert. A card balance is a non-custodial,
///         ERC-6909-style RECEIPT denominated in USD (8 decimals, the estate's `usdAmount8`): the
///         holder controls it, the issuing merchant has no admin key over it, and a `cardId` is
///         deterministically derived from `(merchantId, code)` so any party can recompute it.
/// @dev    COMPOSES — never duplicates — the audited quartet:
///           - {Access0x1Router}: the merchant registry is the single source of truth for
///             owner-authorization (`onlyMerchantOwner` reads `Router.merchants(id).owner`); the
///             Router also owns the fee-split, so the CHARGEABLE REMAINDER of a sale (the part the
///             card balance does not cover) is settled by the caller straight through the Router's
///             `payToken`/`payNative` in the SAME tx — this contract never re-derives the split and
///             never holds a token.
///         CUSTODY MODEL — ZERO CUSTODY / NON-CUSTODIAL USD RECEIPT. The prepaid balance is pure USD
///         accounting (the same shape PaymentLanes proves for asset receipts): the merchant issues a
///         face value AFTER it has settled the card purchase off this ledger, the holder owns the
///         balance, and a redemption is a debit-only bookkeeping entry — no ERC-20 ever enters or
///         leaves this contract, so there is nothing to custody and the never-negative invariant is
///         the whole security surface. The chargeable remainder is settled by the caller through the
///         Router (a separate, audited money path), keeping this contract a thin sibling ledger.
///         CEI + `nonReentrant` guard every balance-mutating path even though no external call is
///         made on them, as belt-and-suspenders against any future asset-bearing extension; coupon
///         consumption is an atomic read-modify-write that can never let the count exceed the cap.
contract Access0x1GiftCards is IAccess0x1GiftCards, Ownable2Step, ReentrancyGuard {
    using Math for uint256;

    /// @notice Basis for percent discounts: `value` is a whole-percent figure, so 100% == `value 100`.
    uint256 private constant PERCENT_DENOMINATOR = 100;

    /// @notice The Access0x1 Router whose merchant registry authorizes card issuance + coupon writes.
    ///         Immutable: the authorization source can never be swapped out from under live cards.
    Access0x1Router public immutable router;

    /// @notice holder ⇒ cardId ⇒ USD (8-dec) prepaid balance. The whole prepaid accounting state.
    mapping(address holder => mapping(uint256 cardId => uint256 balanceUsd8)) private _balanceOf;

    /// @notice cardId ⇒ the Router merchant it draws against. Bound on the FIRST {issueCard} of a card
    ///         and immutable thereafter (a card id IS `keccak256(merchantId, code)`, so a given id
    ///         deterministically maps to exactly one merchant). 0 ⇒ never issued.
    mapping(uint256 cardId => uint256 merchantId) private _cardMerchant;

    /// @notice A recorded redemption: the holder it debited and the amount applied. Written once by
    ///         {redeem} (its id is the replay guard) and read by {reverseRedemption}.
    /// @param holder  The holder whose balance was debited.
    /// @param cardId  The card debited.
    /// @param applied The USD (8-dec) amount debited.
    /// @param exists  True once {redeem} recorded this id (replay guard for {redeem}).
    /// @param reversed True once {reverseRedemption} credited it back (idempotency guard).
    struct Redemption {
        address holder;
        uint256 cardId;
        uint256 applied;
        bool exists;
        bool reversed;
    }

    /// @notice redemptionId ⇒ its recorded redemption. The idempotency anchor for redeem + reverse.
    mapping(bytes32 redemptionId => Redemption) private _redemptions;

    /// @notice merchantId ⇒ couponId ⇒ coupon record. Namespaced under the merchant so a coupon op
    ///         against merchant A can never mutate merchant B's registry (tenant isolation).
    mapping(uint256 merchantId => mapping(bytes32 couponId => Coupon)) private _coupons;

    /// @param initialOwner The admin (Ownable2Step) — holds NO authority over any holder's card
    ///                     balance or any merchant's coupons; reserved for future global config only.
    /// @param router_      The Access0x1 Router whose merchant registry authorizes issuance.
    constructor(address initialOwner, Access0x1Router router_) Ownable(initialOwner) {
        if (address(router_) == address(0)) revert GiftCards__ZeroAddress();
        router = router_;
    }

    /// @dev Revert unless `msg.sender` is the registered owner of `merchantId` per the Router. The
    ///      Router is the single source of truth for merchant ownership (no duplicated registry).
    /// @param merchantId The merchant whose owner must be the caller.
    modifier onlyMerchantOwner(uint256 merchantId) {
        (, address mOwner,,,,) = router.merchants(merchantId);
        if (mOwner == address(0)) revert GiftCards__MerchantNotFound(merchantId);
        if (msg.sender != mOwner) revert GiftCards__NotMerchantOwner(merchantId, msg.sender);
        _;
    }

    /*//////////////////////////////////////////////////////////////
                              PREPAID READ
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1GiftCards
    function balanceOf(address holder, uint256 cardId_) external view returns (uint256) {
        return _balanceOf[holder][cardId_];
    }

    /// @inheritdoc IAccess0x1GiftCards
    function cardMerchant(uint256 cardId_) external view returns (uint256) {
        return _cardMerchant[cardId_];
    }

    /// @inheritdoc IAccess0x1GiftCards
    function cardId(uint256 merchantId, bytes32 code) external pure returns (uint256) {
        return _cardId(merchantId, code);
    }

    /*//////////////////////////////////////////////////////////////
                              PREPAID WRITE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1GiftCards
    /// @dev `onlyMerchantOwner` + CEI + `nonReentrant`. The card id is bound to its merchant on first
    ///      issue (idempotent — a given id always maps to the same merchant because the id IS
    ///      `keccak256(merchantId, code)`), then the face value is minted to the recipient's balance.
    ///      Issuance is the merchant's assertion that it has ALREADY settled the card purchase off
    ///      this ledger — the prepaid balance is a fully-backed USD receipt, never minted on credit.
    function issueCard(uint256 merchantId, bytes32 code, address recipient, uint256 faceUsd8)
        external
        nonReentrant
        onlyMerchantOwner(merchantId)
        returns (uint256 id)
    {
        if (recipient == address(0)) revert GiftCards__ZeroAddress();
        if (faceUsd8 == 0) revert GiftCards__ZeroAmount();

        id = _cardId(merchantId, code);
        // Effect: bind the card to its merchant (idempotent) and mint the face value.
        _cardMerchant[id] = merchantId;
        _balanceOf[recipient][id] += faceUsd8;
        emit CardIssued(merchantId, id, recipient, faceUsd8);
    }

    /// @inheritdoc IAccess0x1GiftCards
    /// @dev CEI + `nonReentrant`. `applied = min(balance, amountUsd8)`; the HARD never-negative guard
    ///      `require(balance >= applied)` is the canonical never-negative invariant as a revert (it can
    ///      only ever trip on a corrupted `min`, so it is a defense-in-depth assertion, not a UX
    ///      path). `redemptionId` is recorded BEFORE the debit and replays revert — a redeem applies
    ///      at most once. The debit is the only state change; any chargeable remainder
    ///      (`amountUsd8 - applied`) is settled by the caller through the Router in the same tx.
    function redeem(uint256 cardId_, uint256 amountUsd8, bytes32 redemptionId)
        external
        nonReentrant
        returns (uint256 applied)
    {
        if (amountUsd8 == 0) revert GiftCards__ZeroAmount();
        if (redemptionId == bytes32(0)) revert GiftCards__ZeroAmount();

        Redemption storage r = _redemptions[redemptionId];
        if (r.exists) revert GiftCards__RedemptionUsed(redemptionId);

        uint256 balance = _balanceOf[msg.sender][cardId_];
        applied = balance < amountUsd8 ? balance : amountUsd8;
        // HARD never-negative guard: a debit can NEVER exceed the balance. `applied <= balance` holds
        // by the `min` above; this require is the strictly-stronger invariant a mature commerce app expresses
        // as a soft check, here a revert no path can bypass.
        if (balance < applied) {
            revert GiftCards__InsufficientBalance(cardId_, msg.sender, balance, applied);
        }

        // Effect: record the redemption (replay guard) BEFORE the debit, then debit. `applied` may be
        // zero (a fully-spent card) — still a valid, replay-guarded no-op debit, recorded so a later
        // reverse is a clean idempotent no-op.
        r.holder = msg.sender;
        r.cardId = cardId_;
        r.applied = applied;
        r.exists = true;
        unchecked {
            // `applied <= balance` proven above, so the subtraction cannot underflow.
            _balanceOf[msg.sender][cardId_] = balance - applied;
        }
        emit Redeemed(cardId_, msg.sender, redemptionId, applied);
    }

    /// @inheritdoc IAccess0x1GiftCards
    /// @dev CEI + `nonReentrant`. MERCHANT-OWNER ONLY: a reversal RE-CREDITS spent value (the holder
    ///      already consumed goods against the debit), so only the owner of the card's merchant may
    ///      authorize it — anyone else re-crediting a spent balance is a double-spend. The check is
    ///      inline (not the modifier) so the unknown-id revert fires FIRST and `r` is read once: the
    ///      card's merchant is looked up via its immutable binding (`_cardMerchant[r.cardId]`) and the
    ///      caller must be that merchant's Router-registered owner. A zero-applied redemption (a
    ///      phantom no-op) early-returns BEFORE the owner gate so a keeper can retry any id safely.
    ///      Idempotent: the `reversed` flag gates a second call to a clean no-op return (flipped BEFORE
    ///      crediting); the applied amount is credited back to the ORIGINAL holder (recorded at redeem
    ///      time), reviving a fully-spent card — a mature commerce app's expire/cancel reversal.
    function reverseRedemption(bytes32 redemptionId) external nonReentrant {
        Redemption storage r = _redemptions[redemptionId];
        if (!r.exists) revert GiftCards__RedemptionUnknown(redemptionId);
        // Idempotent: a redemptionId reverses AT MOST once. A second call is a clean no-op return,
        // never a double-credit and never a revert (so a keeper can retry safely).
        if (r.reversed) return;

        // A zero-applied redemption (a fully-spent card redeemed again) re-credits nothing, so it is a
        // pure no-op: settle it BEFORE the owner gate to preserve keeper-retry semantics on phantom ids
        // (there is no value to re-credit, so no double-spend surface to gate).
        uint256 amount = r.applied;
        if (amount == 0) {
            r.reversed = true;
            emit RedemptionReversed(r.cardId, r.holder, redemptionId, 0);
            return;
        }

        // Authorize: only the owner of the card's merchant may re-credit a SPENT balance. A redemption
        // is value the holder already consumed (goods delivered, the chargeable remainder settled
        // through the Router); re-crediting it is the double-spend vector, so it carries the same
        // owner gate as {issueCard}/{releaseCoupon}. Inline (not the modifier) so the unknown-id revert
        // fires first and `r` is read once; the card's merchant is its immutable {issueCard} binding.
        uint256 merchantId = _cardMerchant[r.cardId];
        (, address mOwner,,,,) = router.merchants(merchantId);
        if (msg.sender != mOwner) revert GiftCards__NotMerchantOwner(merchantId, msg.sender);

        // Effect: flip the idempotency flag first (CEI), then credit the original holder back.
        r.reversed = true;
        _balanceOf[r.holder][r.cardId] += amount;
        emit RedemptionReversed(r.cardId, r.holder, redemptionId, amount);
    }

    /// @inheritdoc IAccess0x1GiftCards
    /// @dev CEI + `nonReentrant`: both balance legs are written before the event; the caller can never
    ///      move more than it holds (`balance >= amount`, the never-negative guard for transfers). The
    ///      guard upholds the file invariant — EVERY balance-mutating path is `nonReentrant` — so a
    ///      future asset-bearing extension cannot reorder a mid-transfer callback (Y-2; no external call
    ///      today).
    function transfer(address to, uint256 cardId_, uint256 amount)
        external
        nonReentrant
        returns (bool)
    {
        if (to == address(0)) revert GiftCards__ZeroAddress();
        uint256 balance = _balanceOf[msg.sender][cardId_];
        if (balance < amount) {
            revert GiftCards__TransferExceedsBalance(cardId_, msg.sender, balance, amount);
        }
        unchecked {
            // `amount <= balance` checked above; the credit cannot overflow because the debit
            // conserves the total issued for this card (a card balance never exceeds what was issued).
            _balanceOf[msg.sender][cardId_] = balance - amount;
            _balanceOf[to][cardId_] += amount;
        }
        emit CardTransferred(cardId_, msg.sender, to, amount);
        return true;
    }

    /*//////////////////////////////////////////////////////////////
                            COUPON REGISTRY
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1GiftCards
    function coupons(uint256 merchantId, bytes32 couponId) external view returns (Coupon memory) {
        return _coupons[merchantId][couponId];
    }

    /// @inheritdoc IAccess0x1GiftCards
    /// @dev `onlyMerchantOwner`. (Re)defining a coupon resets its consumption count to zero — a fresh
    ///      definition starts a fresh cap window. The record is namespaced under the merchant id, so
    ///      this can never touch another merchant's coupons (tenant isolation).
    function setCoupon(
        uint256 merchantId,
        bytes32 couponId,
        DiscountType dType,
        uint256 value,
        uint64 validUntil,
        uint32 maxRedemptions
    ) external onlyMerchantOwner(merchantId) {
        _coupons[merchantId][couponId] = Coupon({
            dType: dType,
            value: value,
            validUntil: validUntil,
            maxRedemptions: maxRedemptions,
            redemptionsCount: 0,
            active: true
        });
        emit CouponSet(merchantId, couponId, dType, value, validUntil, maxRedemptions);
    }

    /// @inheritdoc IAccess0x1GiftCards
    /// @dev Permissionless READ. Performs the SAME active/expired/cap qualification as {applyCoupon} and
    ///      returns the clamped discount WITHOUT incrementing `redemptionsCount` — a storefront preview
    ///      any party may call for free. Because it never consumes the cap it cannot grief a finite-cap
    ///      promotion (the L-4 split: read is public, consume is owner-gated). A disqualifying state
    ///      (inactive, expired, cap reached) reverts so a preview matches what a consume would do.
    function quoteCoupon(uint256 merchantId, bytes32 couponId, uint256 amountUsd8)
        external
        view
        returns (uint256 discount)
    {
        Coupon storage c = _coupons[merchantId][couponId];
        if (!c.active) revert GiftCards__CouponInactive(merchantId, couponId);
        // slither-disable-next-line timestamp
        if (c.validUntil != 0 && block.timestamp > c.validUntil) {
            revert GiftCards__CouponExpired(merchantId, couponId);
        }
        if (c.maxRedemptions != 0 && c.redemptionsCount >= c.maxRedemptions) {
            revert GiftCards__CouponExhausted(merchantId, couponId);
        }
        return _discountFor(c.dType, c.value, amountUsd8);
    }

    /// @inheritdoc IAccess0x1GiftCards
    /// @dev `nonReentrant` + `onlyMerchantOwner` + atomic read-modify-write. The `nonReentrant` guard
    ///      upholds the file invariant that every balance/count-mutating path carries it (Y-1; no
    ///      external call today). MERCHANT-OWNER ONLY: consuming a coupon
    ///      increments `redemptionsCount` toward `maxRedemptions`, so a permissionless caller could
    ///      burn a finite-cap promotion to exhaustion (the L-4 griefing/DoS) — gating it to the owner
    ///      (mirroring {setCoupon}/{releaseCoupon}) closes that, while {quoteCoupon} gives storefronts a
    ///      free, non-consuming preview. The cap is checked and the count incremented in the SAME state
    ///      transition, so `redemptionsCount` can never exceed `maxRedemptions` even under concurrent
    ///      sales (each is its own tx; the EVM serializes them). A disqualifying state (inactive,
    ///      expired, cap reached) reverts; the discount math itself NEVER throws — an unknown discount
    ///      type yields a zero discount (the "unknown ⇒ no discount" rule), and the result
    ///      is clamped to `[0, amountUsd8]` so a coupon can never exceed the sale it discounts.
    function applyCoupon(uint256 merchantId, bytes32 couponId, uint256 amountUsd8)
        external
        nonReentrant
        onlyMerchantOwner(merchantId)
        returns (uint256 discount)
    {
        Coupon storage c = _coupons[merchantId][couponId];
        if (!c.active) revert GiftCards__CouponInactive(merchantId, couponId);
        // slither-disable-next-line timestamp
        if (c.validUntil != 0 && block.timestamp > c.validUntil) {
            revert GiftCards__CouponExpired(merchantId, couponId);
        }
        uint32 count = c.redemptionsCount;
        if (c.maxRedemptions != 0 && count >= c.maxRedemptions) {
            revert GiftCards__CouponExhausted(merchantId, couponId);
        }

        discount = _discountFor(c.dType, c.value, amountUsd8);

        // Effect: increment the consumption count atomically (cap proven not-yet-reached above). The
        // ++ is bounded by `maxRedemptions` (or, when unlimited, by the practical tx count) and uses
        // checked math, so it can never wrap past the cap.
        c.redemptionsCount = count + 1;
        emit CouponConsumed(merchantId, couponId, amountUsd8, discount);
    }

    /// @inheritdoc IAccess0x1GiftCards
    /// @dev `onlyMerchantOwner`. Floors at zero — releasing an unconsumed coupon is a clean no-op, so
    ///      a keeper reconciling cancellations can never drive the count negative.
    function releaseCoupon(uint256 merchantId, bytes32 couponId)
        external
        onlyMerchantOwner(merchantId)
    {
        Coupon storage c = _coupons[merchantId][couponId];
        uint32 count = c.redemptionsCount;
        if (count != 0) {
            unchecked {
                // count != 0 checked above, so the decrement cannot underflow.
                c.redemptionsCount = count - 1;
            }
        }
        emit CouponReleased(merchantId, couponId);
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev The clamped discount for a sale. PERCENT ⇒ `amount * value / 100`; AMOUNT ⇒ flat `value`.
    ///      Both are clamped to `[0, amount]` so a discount can never exceed the sale. An unrecognized
    ///      type returns zero (never reverts) — the "unknown discount ⇒ no discount" rule;
    ///      because `DiscountType` has exactly two variants this is unreachable today, but it keeps the
    ///      math total for any future variant.
    /// @param dType  The discount kind.
    /// @param value  The percent (whole percent) or flat USD (8-dec) value.
    /// @param amount The pre-discount sale amount (USD 8-dec).
    /// @return The clamped discount.
    function _discountFor(DiscountType dType, uint256 value, uint256 amount)
        private
        pure
        returns (uint256)
    {
        uint256 raw;
        if (dType == DiscountType.PERCENT) {
            // mulDiv floors; a percent over 100 is clamped below, so this never exceeds `amount` by
            // more than the clamp catches.
            raw = Math.mulDiv(amount, value, PERCENT_DENOMINATOR);
        } else if (dType == DiscountType.AMOUNT) {
            raw = value;
        } else {
            return 0;
        }
        return raw > amount ? amount : raw;
    }

    /// @dev The deterministic card key. `keccak256(abi.encode(merchantId, code))` over the full
    ///      uint256/bytes32 pair — `abi.encode` (not `encodePacked`) so each leg sits in its own
    ///      32-byte word and no two distinct pairs can collide via boundary aliasing. Pure — no SLOAD
    ///      — so off-chain callers recompute card ids for free.
    /// @param merchantId The merchant leg.
    /// @param code       The code leg.
    /// @return The card id.
    function _cardId(uint256 merchantId, bytes32 code) private pure returns (uint256) {
        return uint256(keccak256(abi.encode(merchantId, code)));
    }
}
