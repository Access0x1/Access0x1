// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IAccess0x1GiftCards
/// @author Access0x1
/// @notice The external surface of Access0x1GiftCards — a USD-priced prepaid-balance primitive
///         (gift cards / credit packs) plus a minimal merchant-scoped coupon registry. A card is a
///         non-custodial ERC-6909-style RECEIPT: its balance is denominated in USD (8 decimals, the
///         estate's `usdAmount8` unit), the holder controls it, and the issuing merchant holds NO
///         admin key over a holder's balance once issued. A `cardId` is deterministically derived
///         from `(merchantId, code)` so any party can recompute it off-chain.
/// @dev    Card id = `keccak256(abi.encode(merchantId, code))`; coupon records are namespaced under
///         the merchant id so a coupon op against merchant A can never mutate merchant B's registry.
///         All money-shaped values are USD with 8 decimals; the redemption never holds a token —
///         settlement of any chargeable remainder is the caller's job through the Router (see the
///         contract NatSpec). Every balance change emits an event and uses custom errors.
interface IAccess0x1GiftCards {
    /// @notice The kind of discount a coupon applies.
    /// @dev    `PERCENT` ⇒ `value` is basis points of 100 (value/100 percent) — i.e. `value` is a
    ///         whole-percent figure in `[0, 100]`; `AMOUNT` ⇒ `value` is a flat USD (8-dec) discount.
    ///         Any other (impossible) variant is treated as a zero discount by `applyCoupon`, never a
    ///         revert (the "unknown type ⇒ no discount" rule).
    enum DiscountType {
        PERCENT,
        AMOUNT
    }

    /// @notice A merchant-scoped coupon. Written by the merchant owner, consumed atomically.
    /// @param dType            Whether `value` is a percent or a flat USD amount.
    /// @param value            The percent (whole percent, `[0,100]`) or flat USD (8-dec) discount.
    /// @param validUntil       Unix time after which the coupon is dead (0 ⇒ never expires).
    /// @param maxRedemptions   The cap on total consumptions (0 ⇒ unlimited).
    /// @param redemptionsCount How many times it has been consumed (atomically incremented).
    /// @param active           False ⇒ the coupon is disabled (a soft kill the merchant can flip).
    struct Coupon {
        DiscountType dType;
        uint256 value;
        uint64 validUntil;
        uint32 maxRedemptions;
        uint32 redemptionsCount;
        bool active;
    }

    // ──────────────────────── events ────────────────────────

    /// @notice A gift card / credit pack was issued (minted) to a recipient.
    /// @param merchantId The Router merchant the card draws against (immutable per card).
    /// @param cardId     The deterministic card id `keccak256(merchantId, code)`.
    /// @param recipient  The holder credited the face value.
    /// @param faceUsd8   The USD (8-dec) face value minted.
    event CardIssued(
        uint256 indexed merchantId,
        uint256 indexed cardId,
        address indexed recipient,
        uint256 faceUsd8
    );

    /// @notice A holder redeemed (debited) part or all of a card balance against a sale.
    /// @param cardId       The card debited.
    /// @param holder       The holder whose balance was debited.
    /// @param redemptionId The caller-supplied idempotency key for this redemption (replay-guarded).
    /// @param applied      The USD (8-dec) amount actually applied (`min(balance, amountUsd8)`).
    event Redeemed(
        uint256 indexed cardId,
        address indexed holder,
        bytes32 indexed redemptionId,
        uint256 applied
    );

    /// @notice A prior redemption was reversed (credited back). Idempotent — fires at most once per id.
    /// @param cardId       The card credited back.
    /// @param holder       The holder whose balance was restored.
    /// @param redemptionId The redemption being reversed.
    /// @param amount       The USD (8-dec) amount credited back.
    event RedemptionReversed(
        uint256 indexed cardId, address indexed holder, bytes32 indexed redemptionId, uint256 amount
    );

    /// @notice A card balance was transferred between holders (ERC-6909-style).
    /// @param cardId The card id moved.
    /// @param from   The sender.
    /// @param to     The recipient.
    /// @param amount The USD (8-dec) amount moved.
    event CardTransferred(
        uint256 indexed cardId, address indexed from, address indexed to, uint256 amount
    );

    /// @notice A coupon was created or updated by its merchant owner.
    /// @param merchantId The merchant the coupon belongs to.
    /// @param couponId   The coupon key.
    /// @param dType      Percent or flat amount.
    /// @param value      The discount value.
    /// @param validUntil Expiry (0 ⇒ none).
    /// @param maxRedemptions The cap (0 ⇒ unlimited).
    event CouponSet(
        uint256 indexed merchantId,
        bytes32 indexed couponId,
        DiscountType dType,
        uint256 value,
        uint64 validUntil,
        uint32 maxRedemptions
    );

    /// @notice A coupon was consumed (its `redemptionsCount` incremented by one).
    /// @param merchantId The merchant the coupon belongs to.
    /// @param couponId   The coupon consumed.
    /// @param amountUsd8 The pre-discount sale amount the coupon was applied to.
    /// @param discount   The USD (8-dec) discount granted (clamped to `[0, amountUsd8]`).
    event CouponConsumed(
        uint256 indexed merchantId, bytes32 indexed couponId, uint256 amountUsd8, uint256 discount
    );

    /// @notice A coupon consumption was released (its `redemptionsCount` decremented, floored at 0).
    /// @param merchantId The merchant the coupon belongs to.
    /// @param couponId   The coupon released.
    event CouponReleased(uint256 indexed merchantId, bytes32 indexed couponId);

    // ──────────────────────── errors ────────────────────────

    /// @notice Caller is not the owner of merchant `merchantId` (per the Router registry).
    error GiftCards__NotMerchantOwner(uint256 merchantId, address caller);

    /// @notice Merchant `merchantId` was never registered on the Router.
    error GiftCards__MerchantNotFound(uint256 merchantId);

    /// @notice A zero address was supplied where a non-zero one is required.
    error GiftCards__ZeroAddress();

    /// @notice A zero amount was supplied where a positive one is required.
    error GiftCards__ZeroAmount();

    /// @notice A redemption would drive a card balance negative — the hard never-negative guard.
    error GiftCards__InsufficientBalance(
        uint256 cardId, address holder, uint256 balance, uint256 applied
    );

    /// @notice A transfer/redeem amount exceeds the holder's balance on a card.
    error GiftCards__TransferExceedsBalance(
        uint256 cardId, address holder, uint256 balance, uint256 amount
    );

    /// @notice The supplied `redemptionId` was already used (redeem replay guard).
    error GiftCards__RedemptionUsed(bytes32 redemptionId);

    /// @notice A `reverseRedemption` referenced an unknown redemption id (never redeemed).
    error GiftCards__RedemptionUnknown(bytes32 redemptionId);

    /// @notice `applyCoupon` was called on a coupon that is disabled (`active == false`).
    error GiftCards__CouponInactive(uint256 merchantId, bytes32 couponId);

    /// @notice `applyCoupon` was called after the coupon's `validUntil`.
    error GiftCards__CouponExpired(uint256 merchantId, bytes32 couponId);

    /// @notice `applyCoupon` was called on a coupon that has hit its `maxRedemptions` cap.
    error GiftCards__CouponExhausted(uint256 merchantId, bytes32 couponId);

    // ──────────────────────── prepaid balance ────────────────────────

    /// @notice The USD (8-dec) prepaid balance of `holder` on card `cardId`.
    /// @param holder The card holder.
    /// @param cardId The card id.
    /// @return The balance in USD with 8 decimals.
    function balanceOf(address holder, uint256 cardId) external view returns (uint256);

    /// @notice The Router merchant a card is bound to (immutable once the card is first issued).
    /// @param cardId The card id.
    /// @return The merchant id (0 ⇒ never issued).
    function cardMerchant(uint256 cardId) external view returns (uint256);

    /// @notice The deterministic card id for a `(merchantId, code)` pair. Pure — recompute off-chain.
    /// @param merchantId The merchant the card draws against.
    /// @param code       The card code (opaque, e.g. a hashed claim code).
    /// @return The card id.
    function cardId(uint256 merchantId, bytes32 code) external pure returns (uint256);

    /// @notice Issue (mint) a card's face value to a recipient. Only the merchant owner may call.
    /// @param merchantId The merchant the card draws against.
    /// @param code       The card code (`cardId = keccak256(merchantId, code)`).
    /// @param recipient  The holder credited (non-zero).
    /// @param faceUsd8   The USD (8-dec) face value to mint (positive).
    /// @return id        The card id credited.
    function issueCard(uint256 merchantId, bytes32 code, address recipient, uint256 faceUsd8)
        external
        returns (uint256 id);

    /// @notice Redeem (debit) up to `amountUsd8` from the caller's balance on `cardId`. The applied
    ///         amount is `min(balance, amountUsd8)`; the call reverts if it would go negative or if
    ///         `redemptionId` was already used.
    /// @param cardId       The card to debit.
    /// @param amountUsd8   The USD (8-dec) sale amount the holder wants to cover (positive).
    /// @param redemptionId The idempotency key for this redemption (unused, non-zero).
    /// @return applied     The USD (8-dec) amount actually debited.
    function redeem(uint256 cardId, uint256 amountUsd8, bytes32 redemptionId)
        external
        returns (uint256 applied);

    /// @notice Reverse a prior redemption, crediting the applied amount back to the original holder.
    ///         Idempotent: a given `redemptionId` reverses at most once.
    /// @param redemptionId The redemption to reverse (must have been recorded by {redeem}).
    function reverseRedemption(bytes32 redemptionId) external;

    /// @notice Move `amount` of a card balance from the caller to `to` (ERC-6909-style transfer).
    /// @param to     The recipient (non-zero).
    /// @param cardId The card id.
    /// @param amount The USD (8-dec) amount to move.
    /// @return True on success.
    function transfer(address to, uint256 cardId, uint256 amount) external returns (bool);

    // ──────────────────────── coupon registry ────────────────────────

    /// @notice The coupon record for `(merchantId, couponId)`.
    /// @param merchantId The merchant.
    /// @param couponId   The coupon key.
    /// @return The coupon struct.
    function coupons(uint256 merchantId, bytes32 couponId) external view returns (Coupon memory);

    /// @notice Create or overwrite a coupon. Only the merchant owner may call. Resets the consumption
    ///         count to zero on (re)definition.
    /// @param merchantId     The merchant the coupon belongs to.
    /// @param couponId       The coupon key.
    /// @param dType          Percent or flat USD amount.
    /// @param value          The discount value (percent in `[0,100]` or flat USD 8-dec).
    /// @param validUntil     Expiry (0 ⇒ never).
    /// @param maxRedemptions The cap (0 ⇒ unlimited).
    function setCoupon(
        uint256 merchantId,
        bytes32 couponId,
        DiscountType dType,
        uint256 value,
        uint64 validUntil,
        uint32 maxRedemptions
    ) external;

    /// @notice Atomically consume a coupon and return the clamped discount for `amountUsd8`. Reverts
    ///         only on a hard-disqualifying state (inactive, expired, cap reached); the discount math
    ///         never throws (an unknown type yields a zero discount).
    /// @param merchantId The merchant the coupon belongs to.
    /// @param couponId   The coupon to consume.
    /// @param amountUsd8 The pre-discount sale amount.
    /// @return discount  The USD (8-dec) discount, clamped to `[0, amountUsd8]`.
    function applyCoupon(uint256 merchantId, bytes32 couponId, uint256 amountUsd8)
        external
        returns (uint256 discount);

    /// @notice Release one consumption of a coupon (decrement, floored at zero). Only the merchant
    ///         owner may call — the on-chain mirror of a cancelled / expired sale restoring capacity.
    /// @param merchantId The merchant the coupon belongs to.
    /// @param couponId   The coupon to release.
    function releaseCoupon(uint256 merchantId, bytes32 couponId) external;
}
