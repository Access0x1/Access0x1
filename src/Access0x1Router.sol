// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import { OracleLib } from "./libraries/OracleLib.sol";

/// @title  Access0x1Router
/// @author Access0x1
/// @notice One shared, multi-tenant, ZERO-custody payments router. A business registers once
///         (`registerMerchant` → `merchantId`) and accepts USD-priced crypto with one link and
///         no contract code. Each payment prices USD→token via a Chainlink feed read INSIDE the
///         settlement tx, splits an exact fee, and pushes net→merchant + fee→treasury in the same
///         tx — the contract never holds merchant funds.
/// @dev    `Ownable2Step` (fat-finger-safe admin) + `Pausable` (gate new pay-ins only, never an
///         in-flight settlement) + `ReentrancyGuard` (belt-and-suspenders with CEI on the pay
///         paths). Native token is the zero-address sentinel; its feed lives at `priceFeedOf[0]`.
contract Access0x1Router is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using OracleLib for AggregatorV3Interface;

    /// @notice A registered business. `nameHash` is write-only (the readable name/brand lives in a
    ///         separate sidecar) so the hot pay path never touches brand storage.
    /// @dev    Field order packs `feeRecipient`+`feeBps`+`active` into one slot (23 bytes).
    struct Merchant {
        address payout; // where the net payment lands
        address owner; // the only address that may update this merchant
        address feeRecipient; // where this merchant's fee leg lands (0 ⇒ falls back to payout)
        uint16 feeBps; // the merchant's optional surcharge, on top of the platform fee
        bool active; // false ⇒ new payments to this merchant revert
        bytes32 nameHash; // identity commitment (no preimage on-chain)
    }

    /// @notice The native-token sentinel: `address(0)` as a "token" means the chain's native coin.
    address private constant NATIVE = address(0);

    /// @notice Basis-point denominator (10_000 = 100%).
    uint256 private constant FEE_DENOMINATOR = 10_000;

    /// @notice Hard ceiling on the combined (platform + merchant) fee: 10%. Enforced at register,
    ///         update, and platform-fee changes, so no configuration can ever exceed it.
    uint16 public constant MAX_FEE_BPS = 1000;

    /// @notice merchantId ⇒ the merchant record. Public getter for the frontend/SDK.
    mapping(uint256 => Merchant) public merchants;

    /// @notice The id assigned to the next `registerMerchant`. Starts at 1, so 0 is an unset sentinel.
    uint256 public nextMerchantId;

    /// @notice Where the platform's fee leg is sent.
    address public platformTreasury;

    /// @notice The platform fee in basis points (100 = 1.00%), charged on every payment.
    uint16 public platformFeeBps;

    /// @notice token ⇒ accepted as a pay-in currency. Native (address(0)) is implicitly accepted.
    mapping(address => bool) public tokenAllowed;

    /// @notice token ⇒ its Chainlink <token>/USD feed. `priceFeedOf[NATIVE]` is the native/USD feed.
    mapping(address => address) public priceFeedOf;

    /// @notice Pull-map for native pushes that failed (e.g. a contract payee that reverts on receive).
    ///         Credited instead of reverting a settled payment; the owed party calls `claimRescue`.
    mapping(address => uint256) public rescue;

    /// @notice A new business registered.
    event MerchantRegistered(
        uint256 indexed id,
        address indexed owner,
        address payout,
        address feeRecipient,
        uint16 feeBps,
        bytes32 nameHash
    );

    /// @notice A merchant's mutable config changed (owner + nameHash are immutable post-registration).
    event MerchantUpdated(
        uint256 indexed id, address payout, address feeRecipient, uint16 feeBps, bool active
    );

    /// @notice A payment settled. `srcChainSelector == 0` for a same-chain payment. This is the
    ///         event CRE / indexers key on.
    event PaymentReceived(
        uint256 indexed merchantId,
        address indexed buyer,
        address indexed token,
        uint256 grossAmount,
        uint256 feeAmount,
        uint256 netAmount,
        uint256 usdAmount8,
        bytes32 orderId,
        uint64 srcChainSelector
    );

    /// @notice The platform fee changed.
    event PlatformFeeUpdated(uint16 oldBps, uint16 newBps);

    /// @notice The platform treasury changed.
    event TreasuryUpdated(address oldTreasury, address newTreasury);

    /// @notice A token was added to / removed from the pay-in allowlist.
    event TokenAllowedSet(address indexed token, bool allowed);

    /// @notice A token's price feed was set or cleared.
    event PriceFeedSet(address indexed token, address feed);

    /// @notice A queued native push was claimed.
    event Rescued(address indexed to, uint256 amount);

    /// @notice A zero address was supplied where a non-zero one is required.
    error Access0x1__ZeroAddress();

    /// @notice The requested fee (merchant + platform) exceeds `MAX_FEE_BPS`.
    error Access0x1__FeeTooHigh(uint256 requested, uint256 max);

    /// @notice Caller is not the owner of merchant `id`.
    error Access0x1__NotMerchantOwner(uint256 id, address caller);

    /// @notice Merchant `id` exists but is not accepting payments.
    error Access0x1__MerchantInactive(uint256 id);

    /// @notice Merchant `id` was never registered.
    error Access0x1__MerchantNotFound(uint256 id);

    /// @notice `token` is not on the pay-in allowlist (or has no price feed).
    error Access0x1__TokenNotAllowed(address token);

    /// @notice The feed returned a non-positive price.
    error Access0x1__InvalidPrice(int256 answer);

    /// @notice `msg.value` (or the amount) was below the quoted requirement.
    error Access0x1__Underpaid(uint256 required, uint256 provided);

    /// @notice A token took a fee on transfer: the balance delta did not match the requested gross.
    error Access0x1__FeeOnTransferToken(uint256 expected, uint256 received);

    /// @notice A native push to the buyer (refund) failed.
    error Access0x1__NativePushFailed(address to, uint256 amount);

    /// @notice `claimRescue` was called with nothing owed.
    error Access0x1__NothingToRescue();

    /// @notice A zero amount was supplied where a positive one is required.
    error Access0x1__ZeroAmount();

    /// @param initialOwner   The admin (Ownable2Step) — burner at the event, multisig in prod.
    /// @param treasury       Where the platform fee leg settles.
    /// @param platformFeeBps_ The initial platform fee in bps (≤ `MAX_FEE_BPS`).
    constructor(address initialOwner, address treasury, uint16 platformFeeBps_)
        Ownable(initialOwner)
    {
        if (treasury == address(0)) revert Access0x1__ZeroAddress();
        if (platformFeeBps_ > MAX_FEE_BPS) {
            revert Access0x1__FeeTooHigh(platformFeeBps_, MAX_FEE_BPS);
        }
        platformTreasury = treasury;
        platformFeeBps = platformFeeBps_;
        nextMerchantId = 1;
        emit TreasuryUpdated(address(0), treasury);
        emit PlatformFeeUpdated(0, platformFeeBps_);
    }

    /*//////////////////////////////////////////////////////////////
                            MERCHANT REGISTRY
    //////////////////////////////////////////////////////////////*/

    /// @notice Register a business. Permissionless — anyone onboards with a single tx, no per-merchant
    ///         contract. The caller becomes the merchant `owner` (the only address that may update it).
    /// @param payout       Where this merchant's net payments land (must be non-zero).
    /// @param feeRecipient Where this merchant's fee leg lands; `address(0)` ⇒ falls back to `payout`
    ///                     at pay time (allowed, not an error).
    /// @param feeBps       The merchant's optional surcharge in bps; `feeBps + platformFeeBps` must
    ///                     not exceed `MAX_FEE_BPS`.
    /// @param nameHash     An identity commitment (no preimage stored on-chain).
    /// @return id          The newly assigned merchantId (≥ 1).
    function registerMerchant(address payout, address feeRecipient, uint16 feeBps, bytes32 nameHash)
        external
        returns (uint256 id)
    {
        if (payout == address(0)) revert Access0x1__ZeroAddress();
        uint256 combinedFeeBps = uint256(feeBps) + platformFeeBps;
        if (combinedFeeBps > MAX_FEE_BPS) {
            revert Access0x1__FeeTooHigh(combinedFeeBps, MAX_FEE_BPS);
        }

        id = nextMerchantId++;
        merchants[id] = Merchant({
            payout: payout,
            owner: msg.sender,
            feeRecipient: feeRecipient,
            feeBps: feeBps,
            active: true,
            nameHash: nameHash
        });
        emit MerchantRegistered(id, msg.sender, payout, feeRecipient, feeBps, nameHash);
    }

    /// @notice Update a merchant's mutable config. Only the merchant `owner` may call.
    /// @dev    `owner` and `nameHash` are deliberately immutable post-registration — this is what
    ///         lets the fuzzer prove a payment to merchant A never mutates merchant B.
    /// @param id           The merchant to update (must exist).
    /// @param payout       New payout address (must be non-zero).
    /// @param feeRecipient New fee recipient (`address(0)` ⇒ falls back to `payout` at pay time).
    /// @param feeBps       New merchant surcharge; `feeBps + platformFeeBps` must not exceed `MAX_FEE_BPS`.
    /// @param active       Whether the merchant accepts new payments.
    function updateMerchant(
        uint256 id,
        address payout,
        address feeRecipient,
        uint16 feeBps,
        bool active
    ) external {
        Merchant storage m = merchants[id];
        if (m.owner == address(0)) revert Access0x1__MerchantNotFound(id);
        if (msg.sender != m.owner) revert Access0x1__NotMerchantOwner(id, msg.sender);
        if (payout == address(0)) revert Access0x1__ZeroAddress();
        uint256 combinedFeeBps = uint256(feeBps) + platformFeeBps;
        if (combinedFeeBps > MAX_FEE_BPS) {
            revert Access0x1__FeeTooHigh(combinedFeeBps, MAX_FEE_BPS);
        }

        m.payout = payout;
        m.feeRecipient = feeRecipient;
        m.feeBps = feeBps;
        m.active = active;
        emit MerchantUpdated(id, payout, feeRecipient, feeBps, active);
    }

    /*//////////////////////////////////////////////////////////////
                          TOKEN / FEED CONFIG (admin)
    //////////////////////////////////////////////////////////////*/

    /// @notice Add or remove a token from the pay-in allowlist. Native (address(0)) is implicit.
    /// @param token   The ERC-20 to (dis)allow as a pay-in currency.
    /// @param allowed Whether `payToken` will accept it.
    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        tokenAllowed[token] = allowed;
        emit TokenAllowedSet(token, allowed);
    }

    /// @notice Set (or clear) the Chainlink <token>/USD feed used to price a token. `priceFeedOf[0]`
    ///         is the native/USD feed. Passing `feed == address(0)` clears the mapping.
    /// @param token The token (address(0) = native) whose feed is being set.
    /// @param feed  The Chainlink aggregator, or address(0) to clear.
    function setPriceFeed(address token, address feed) external onlyOwner {
        priceFeedOf[token] = feed;
        emit PriceFeedSet(token, feed);
    }

    /*//////////////////////////////////////////////////////////////
                            PLATFORM ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Change the platform fee. Bounded by `MAX_FEE_BPS`, so the platform can never set a
    ///         confiscatory rate. A merchant whose `feeBps + newBps` would now exceed the cap is
    ///         protected at pay time: `_splitFee` trims that merchant's surcharge, never the buyer's
    ///         total and never the platform cut. Takes effect on the next payment.
    /// @param newBps The new platform fee in basis points (≤ `MAX_FEE_BPS`).
    function setPlatformFee(uint16 newBps) external onlyOwner {
        if (newBps > MAX_FEE_BPS) revert Access0x1__FeeTooHigh(newBps, MAX_FEE_BPS);
        emit PlatformFeeUpdated(platformFeeBps, newBps);
        platformFeeBps = newBps;
    }

    /// @notice Change where the platform fee leg settles. Must be non-zero — a zero treasury would
    ///         silently burn every platform fee (the `_pushNativeOrQueue` to address(0) would fail
    ///         and queue, or the ERC-20 transfer would revert the whole payment).
    /// @param newTreasury The new platform treasury (non-zero).
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert Access0x1__ZeroAddress();
        emit TreasuryUpdated(platformTreasury, newTreasury);
        platformTreasury = newTreasury;
    }

    /// @notice Halt new pay-ins: `payNative` and `payToken` revert `EnforcedPause` while paused.
    ///         A circuit breaker for a feed/token incident. Deliberately does NOT gate `claimRescue`
    ///         — funds already owed must remain withdrawable even during a pause (no hostage funds).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume pay-ins after a `pause`.
    function unpause() external onlyOwner {
        _unpause();
    }

    /*//////////////////////////////////////////////////////////////
                                PRICING
    //////////////////////////////////////////////////////////////*/

    /// @notice Convert a USD amount (8 decimals) into the token amount required, via the token's
    ///         Chainlink <token>/USD feed read THROUGH the staleness guard.
    /// @dev    Reading the feed here — and therefore inside `payNative`/`payToken`'s settlement tx —
    ///         is the Chainlink "Connect the World" qualification: a feed read that drives an
    ///         on-chain state change, not a frontend preview. The first parameter is the merchantId
    ///         (kept in the public signature for the SDK + pay paths, reserved for future
    ///         per-merchant pricing); the conversion itself is purely token-based. Decimals are
    ///         read live (`feed.decimals()`, token `decimals()`), never hardcoded — this is what
    ///         makes the Arc trap (native USDC = 18 dec, ERC-20 USDC = 6 dec, feed = 8 dec) safe.
    ///         `mulDiv` keeps full 512-bit precision and rounds UP, so the merchant is never paid
    ///         less than the quoted USD value (dust ≤ 1 wei of token).
    /// @param token       The pay-in token (`address(0)` = native).
    /// @param usdAmount8  The price in USD with 8 decimals (e.g. $29.00 = 29e8).
    /// @return tokenAmount The amount of `token`, in its own decimals, worth `usdAmount8`.
    function quote(uint256, address token, uint256 usdAmount8)
        public
        view
        returns (uint256 tokenAmount)
    {
        if (usdAmount8 == 0) revert Access0x1__ZeroAmount();
        if (token != NATIVE && !tokenAllowed[token]) revert Access0x1__TokenNotAllowed(token);

        address feedAddr = priceFeedOf[token];
        if (feedAddr == address(0)) revert Access0x1__TokenNotAllowed(token);

        (, int256 answer,,,) = AggregatorV3Interface(feedAddr).staleCheckLatestRoundData();
        if (answer <= 0) revert Access0x1__InvalidPrice(answer);
        // answer > 0 is enforced by the guard above, so this int256→uint256 cast cannot wrap.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 price = uint256(answer);

        uint256 feedDecimals = AggregatorV3Interface(feedAddr).decimals();
        uint256 tokenDecimals = token == NATIVE ? 18 : IERC20Metadata(token).decimals();

        // tokenAmount = usdAmount8 · 10^(feedDecimals + tokenDecimals) / (10^8 · price)
        tokenAmount = Math.mulDiv(
            usdAmount8, 10 ** (feedDecimals + tokenDecimals), 10 ** 8 * price, Math.Rounding.Ceil
        );
    }

    /*//////////////////////////////////////////////////////////////
                              SETTLEMENT
    //////////////////////////////////////////////////////////////*/

    /// @dev The one fee-split core both pay paths share. The single total fee splits two ways: the
    ///      PLATFORM portion (`platformFeeBps`) always settles to `platformTreasury` — a merchant
    ///      can never redirect Access0x1's cut — and the MERCHANT surcharge (`feeBps`) settles to
    ///      `merchantFeeDest` (the merchant's `feeRecipient`, or its `payout` if unset). Each leg
    ///      floors, so `net = gross - platformFee - merchantFee` and `net + platformFee +
    ///      merchantFee == gross` holds exactly (the event records `platformFee + merchantFee`).
    /// @return platformFee     The platform's cut → `platformTreasury`.
    /// @return merchantFee     The merchant's surcharge → `merchantFeeDest`.
    /// @return net             What the merchant nets → `payout`.
    /// @return merchantFeeDest Where the merchant surcharge lands.
    function _splitFee(Merchant memory m, uint256 gross)
        private
        view
        returns (uint256 platformFee, uint256 merchantFee, uint256 net, address merchantFeeDest)
    {
        uint256 pBps = platformFeeBps;
        uint256 mBps = m.feeBps;
        // Hard buyer-protection cap: even if a later platform-fee change pushed the sum past
        // MAX_FEE_BPS, the buyer is never charged more than the cap — squeeze the MERCHANT surcharge,
        // never the buyer and never the platform cut. Makes "effective fee ≤ MAX_FEE_BPS" hold
        // unconditionally (invariant 5). `pBps` is itself capped at MAX_FEE_BPS by `setPlatformFee`.
        if (pBps + mBps > MAX_FEE_BPS) mBps = pBps >= MAX_FEE_BPS ? 0 : MAX_FEE_BPS - pBps;
        platformFee = Math.mulDiv(gross, pBps, FEE_DENOMINATOR);
        merchantFee = Math.mulDiv(gross, mBps, FEE_DENOMINATOR);
        net = gross - platformFee - merchantFee;
        merchantFeeDest = m.feeRecipient == address(0) ? m.payout : m.feeRecipient;
    }

    /// @dev Push native value, or credit the pull-map on failure. A settled receipt must never be
    ///      reverted by a payee that rejects ETH (no custody, no stuck funds) — they pull instead.
    function _pushNativeOrQueue(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{ value: amount }("");
        if (!ok) rescue[to] += amount;
    }

    /// @dev Pull exactly `amount` of an ERC-20 in, verifying via the balance delta that the token
    ///      did not skim (fee-on-transfer / rebasing) — those are rejected. Kept as a helper so the
    ///      pay path's stack stays shallow.
    function _pullExact(address token, address from, uint256 amount) private {
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(from, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        if (received != amount) revert Access0x1__FeeOnTransferToken(amount, received);
    }

    /// @notice Pay a merchant in the chain's native token, priced in USD. Refunds any excess.
    /// @dev    CEI: checks (active merchant, fresh quote, sufficient value) → effects (split + emit)
    ///         → interactions (push net, push fee, refund). net/fee pushes that fail are queued to
    ///         `rescue` (the receipt still stands); a failed refund DOES revert, because the buyer
    ///         is present and must not silently lose the excess. `nonReentrant` + `whenNotPaused`.
    /// @param merchantId The merchant to pay.
    /// @param usdAmount8 The price in USD (8 decimals).
    /// @param orderId    An opaque order reference echoed in the receipt event.
    function payNative(uint256 merchantId, uint256 usdAmount8, bytes32 orderId)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        Merchant memory m = merchants[merchantId];
        if (m.owner == address(0)) revert Access0x1__MerchantNotFound(merchantId);
        if (!m.active) revert Access0x1__MerchantInactive(merchantId);

        uint256 gross = quote(merchantId, NATIVE, usdAmount8); // reads the feed IN-TX
        if (msg.value < gross) revert Access0x1__Underpaid(gross, msg.value);

        (uint256 platformFee, uint256 merchantFee, uint256 net, address merchantFeeDest) =
            _splitFee(m, gross);
        emit PaymentReceived(
            merchantId,
            msg.sender,
            NATIVE,
            gross,
            platformFee + merchantFee,
            net,
            usdAmount8,
            orderId,
            0
        );

        _pushNativeOrQueue(m.payout, net);
        _pushNativeOrQueue(platformTreasury, platformFee);
        _pushNativeOrQueue(merchantFeeDest, merchantFee);

        uint256 refundAmount = msg.value - gross;
        if (refundAmount > 0) {
            (bool ok,) = msg.sender.call{ value: refundAmount }("");
            if (!ok) revert Access0x1__NativePushFailed(msg.sender, refundAmount);
        }
    }

    /// @notice Pay a merchant in an allowlisted ERC-20, priced in USD.
    /// @dev    CEI with pull-then-verify: `safeTransferFrom` the gross in, then assert the balance
    ///         delta equals `gross` (rejecting fee-on-transfer / rebasing tokens) BEFORE splitting
    ///         and pushing net→payout + fee→feeDest with `SafeERC20`. An ERC-20 push that fails
    ///         reverts the whole tx (nothing has settled yet — correct), so there is no rescue map
    ///         here. `nonReentrant` + `whenNotPaused`; the allowlist + feed are checked in `quote`.
    ///         Router holds ~zero token balance afterwards (no custody).
    /// @param merchantId The merchant to pay.
    /// @param token      The allowlisted pay-in ERC-20 (native is rejected — use `payNative`).
    /// @param usdAmount8 The price in USD (8 decimals).
    /// @param orderId    An opaque order reference echoed in the receipt event.
    function payToken(uint256 merchantId, address token, uint256 usdAmount8, bytes32 orderId)
        external
        nonReentrant
        whenNotPaused
    {
        Merchant memory m = merchants[merchantId];
        if (m.owner == address(0)) revert Access0x1__MerchantNotFound(merchantId);
        if (!m.active) revert Access0x1__MerchantInactive(merchantId);
        if (token == NATIVE) revert Access0x1__TokenNotAllowed(token); // native goes through payNative

        uint256 gross = quote(merchantId, token, usdAmount8); // allowlist + feed + staleness, IN-TX
        _pullExact(token, msg.sender, gross); // pull + reject fee-on-transfer via the balance delta

        (uint256 platformFee, uint256 merchantFee, uint256 net, address merchantFeeDest) =
            _splitFee(m, gross);
        emit PaymentReceived(
            merchantId,
            msg.sender,
            token,
            gross,
            platformFee + merchantFee,
            net,
            usdAmount8,
            orderId,
            0
        );

        IERC20(token).safeTransfer(m.payout, net);
        if (platformFee > 0) IERC20(token).safeTransfer(platformTreasury, platformFee);
        if (merchantFee > 0) IERC20(token).safeTransfer(merchantFeeDest, merchantFee);
    }

    /*//////////////////////////////////////////////////////////////
                                RESCUE
    //////////////////////////////////////////////////////////////*/

    /// @notice Withdraw native value that was queued to you when a push failed during settlement
    ///         (e.g. your payout contract reverted on receive, so the receipt stood but the transfer
    ///         was parked here). Pure pull-pattern: the router never decides when you are paid — you
    ///         claim. Open even while the router is paused.
    /// @dev    CEI + `nonReentrant`: zero the credit BEFORE the call, so a re-entrant claimer finds
    ///         nothing owed. A failed send reverts the whole claim (the credit is restored by the
    ///         revert), so a claimant can never zero their balance without receiving the funds.
    function claimRescue() external nonReentrant {
        uint256 amount = rescue[msg.sender];
        if (amount == 0) revert Access0x1__NothingToRescue();
        rescue[msg.sender] = 0; // effect before interaction
        emit Rescued(msg.sender, amount);
        (bool ok,) = msg.sender.call{ value: amount }("");
        if (!ok) revert Access0x1__NativePushFailed(msg.sender, amount);
    }
}
