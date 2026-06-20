// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    Ownable2StepUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {
    ReentrancyGuardTransient
} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import { OracleLib } from "./libraries/OracleLib.sol";
import { IPaymentLanes } from "./interfaces/IPaymentLanes.sol";

/// @title  Access0x1Router
/// @author Access0x1
/// @notice One shared, multi-tenant, ZERO-custody payments router. A business registers once
///         (`registerMerchant` → `merchantId`) and accepts USD-priced crypto with one link and
///         no contract code. Each payment prices USD→token via a Chainlink feed read INSIDE the
///         settlement tx, splits an exact fee, and pushes net→merchant + fee→treasury in the same
///         tx — the contract never holds merchant funds.
/// @dev    `Ownable2StepUpgradeable` (fat-finger-safe admin) + `PausableUpgradeable` (gate new
///         pay-ins only, never an in-flight settlement) + `ReentrancyGuardTransient`
///         (belt-and-suspenders with CEI on the pay paths). Native token is the zero-address
///         sentinel; its feed lives at `priceFeedOf[0]`.
///
///         UPGRADEABILITY (the Access0x1 UUPS TEMPLATE — every system contract follows this exact
///         shape): the router is deployed behind an `ERC1967Proxy`; storage lives in the proxy, logic
///         in this implementation. State is set once via {initialize} (the constructor-replacement,
///         `initializer`-guarded); the implementation's own constructor calls `_disableInitializers()`
///         so the logic contract can never be initialized or hijacked directly. Upgrades route through
///         {upgradeToAndCall} and are authorized by {_authorizeUpgrade} (`onlyOwner` — the
///         `Ownable2StepUpgradeable` owner / upgrade admin). Calling `renounceOwnership()` permanently
///         freezes the implementation (no owner ⇒ no authorized upgrade ⇒ immutable forever). A
///         trailing `__gap` reserves slots for safe future storage appends.
contract Access0x1Router is
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardTransient
{
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

    /// @notice Decimals of the USD amounts the SDK passes in, matching Chainlink USD feeds (1e8 = $1).
    uint256 private constant USD_DECIMALS = 8;

    /// @notice Hard ceiling on the combined (platform + merchant) fee: 10%. Enforced at register,
    ///         update, and platform-fee changes, so no configuration can ever exceed it.
    uint16 public constant MAX_FEE_BPS = 1000;

    /// @notice merchantId ⇒ the merchant record. Public getter for the frontend/SDK.
    mapping(uint256 => Merchant) public merchants;

    /// @notice merchantId ⇒ the address the current owner has PROPOSED as the next owner (0 = none).
    ///         The handshake half of the 2-step merchant-ownership transfer: `proposeMerchantOwner`
    ///         writes it, `acceptMerchantOwner` (called by exactly this address) consumes it. A 2-step
    ///         flow (mirroring `Ownable2Step` for the platform admin) prevents transferring control to a
    ///         typo'd or unreachable address — the new owner must actively claim it.
    mapping(uint256 => address) public pendingMerchantOwner;

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

    /// @notice token ⇒ the max age (seconds) its feed answer may reach before `quote()` treats it as
    ///         stale. `0` (unset) means `quote()` falls back to OracleLib's 1h default — so the 2-arg
    ///         `setPriceFeed` keeps the historical 1h window, while the 3-arg overload widens it for
    ///         slow-heartbeat feeds (a 24h USDC/USD needs an 86400s+margin window).
    mapping(address => uint256) public stalenessOf;

    /// @notice Optional Chainlink L2 Sequencer Uptime feed. When set (the L2 deployments), `quote()`
    ///         rejects pricing while the sequencer is down or freshly restarted; `address(0)` — the
    ///         default, and L1/Arc — skips the check, leaving behaviour unchanged.
    address public sequencerUptimeFeed;

    /// @notice Pull-map for native pushes that failed (e.g. a contract payee that reverts on receive).
    ///         Credited instead of reverting a settled payment; the owed party calls `claimRescue`.
    mapping(address => uint256) public rescue;

    /// @notice Optional ERC-6909 PaymentLanes receipt contract. When unset (the default,
    ///         `address(0)`), token settlement is unchanged — net pushes straight to the merchant.
    ///         When set, `payToken` routes the merchant's net into PaymentLanes and mints the merchant
    ///         a non-custodial lane receipt it pulls later via `claim`. The credit is a post-settlement
    ///         leg only; a PaymentLanes failure can never roll back a fee already paid.
    address public paymentLanes;

    /// @notice A new business registered.
    event MerchantRegistered(
        uint256 indexed id,
        address indexed owner,
        address payout,
        address feeRecipient,
        uint16 feeBps,
        bytes32 nameHash
    );

    /// @notice A merchant's mutable config changed. `owner` is NOT changed here — it transfers only
    ///         through the 2-step {proposeMerchantOwner}/{acceptMerchantOwner} flow; `nameHash` is
    ///         immutable post-registration.
    event MerchantUpdated(
        uint256 indexed id, address payout, address feeRecipient, uint16 feeBps, bool active
    );

    /// @notice The current owner of merchant `id` proposed `pendingOwner` as the next owner (step 1 of
    ///         the 2-step transfer). `pendingOwner == address(0)` cancels a pending proposal.
    event MerchantOwnerProposed(
        uint256 indexed id, address indexed currentOwner, address indexed pendingOwner
    );

    /// @notice The proposed owner accepted ownership of merchant `id` (step 2). `previousOwner` lost all
    ///         control of the merchant; `newOwner` now holds it.
    event MerchantOwnerTransferred(
        uint256 indexed id, address indexed previousOwner, address indexed newOwner
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

    /// @notice The platform treasury changed. `newTreasury` is indexed so indexers can key on it.
    event TreasuryUpdated(address oldTreasury, address indexed newTreasury);

    /// @notice A token was added to / removed from the pay-in allowlist.
    event TokenAllowedSet(address indexed token, bool allowed);

    /// @notice A token's price feed was set or cleared.
    event PriceFeedSet(address indexed token, address feed);

    /// @notice A token's per-feed staleness window was set. `maxStaleness == 0` means the token falls
    ///         back to OracleLib's 1h default in `quote()`.
    event FeedStalenessSet(address indexed token, uint256 maxStaleness);

    /// @notice The Chainlink L2 Sequencer Uptime feed used by `quote()` was set or cleared.
    event SequencerUptimeFeedSet(address indexed feed);

    /// @notice A queued native push was claimed.
    event Rescued(address indexed to, uint256 amount);

    /// @notice The optional PaymentLanes receipt contract was set or cleared (`address(0)` disables it).
    event PaymentLanesSet(address indexed oldLanes, address indexed newLanes);

    /// @notice A configured PaymentLanes credit reverted, so settlement fell back to the direct push:
    ///         the merchant was paid `amount` of `asset` straight to its payout (the payment still
    ///         settled — this is pure observability). A burst of these signals a broken or unauthorized
    ///         lanes contract silently disabling the "receive in any coin" seam; indexers/operators key
    ///         on it. `merchantId` and `asset` are indexed so an operator can filter per merchant/token.
    event LanesFallback(uint256 indexed merchantId, address indexed asset, uint256 amount);

    /// @notice A zero address was supplied where a non-zero one is required.
    error Access0x1__ZeroAddress();

    /// @notice The requested fee (merchant + platform) exceeds `MAX_FEE_BPS`.
    error Access0x1__FeeTooHigh(uint256 requested, uint256 max);

    /// @notice Caller is not the owner of merchant `id`.
    error Access0x1__NotMerchantOwner(uint256 id, address caller);

    /// @notice Caller is not the pending (proposed) owner of merchant `id`, so it cannot accept the
    ///         ownership transfer.
    error Access0x1__NotPendingMerchantOwner(uint256 id, address caller);

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

    /// @dev The implementation is the logic half of a UUPS pair; its OWN storage is never used in
    ///      production (the proxy holds state). `_disableInitializers()` burns the implementation's
    ///      initializer so it can never be initialized — and therefore never owned or upgraded —
    ///      directly, closing the classic uninitialized-implementation takeover. Runs at
    ///      implementation-deploy time.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time initializer — the constructor-replacement for the proxy. Wires the upgradeable
    ///         bases (Ownable + its 2-step extension, Pausable, ReentrancyGuard) then sets the platform
    ///         treasury + fee and seeds the merchant-id counter. Guarded by `initializer`, so it runs
    ///         exactly once per proxy; the typical deploy is
    ///         `new ERC1967Proxy(impl, abi.encodeCall(initialize, ...))`.
    /// @dev    No `__UUPSUpgradeable_init()`: in OZ 5.x `UUPSUpgradeable` holds no initializable
    ///         storage, so there is no such initializer to call. `initialOwner` becomes the
    ///         `Ownable2Step` owner / upgrade admin; it must be non-zero (`__Ownable_init` reverts on
    ///         zero). The remaining body is byte-for-byte the old constructor's.
    /// @param initialOwner    The admin (Ownable2Step) — burner at the event, multisig in prod.
    /// @param treasury        Where the platform fee leg settles.
    /// @param platformFeeBps_ The initial platform fee in bps (≤ `MAX_FEE_BPS`).
    function initialize(address initialOwner, address treasury, uint16 platformFeeBps_)
        external
        initializer
    {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __Pausable_init();

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
    /// @dev    `owner` is NOT changeable here — it transfers ONLY through the 2-step
    ///         {proposeMerchantOwner}/{acceptMerchantOwner} handshake, so a config update can never
    ///         hand control to another address (and a compromised key cannot be made permanent via a
    ///         one-step owner swap). `nameHash` is likewise immutable post-registration — together that
    ///         is what lets the fuzzer prove a payment to merchant A never mutates merchant B.
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

    /// @notice Step 1 of a 2-step merchant-ownership transfer: the current owner PROPOSES a new owner.
    ///         The proposal does NOT change control — `newOwner` must call {acceptMerchantOwner} to take
    ///         it. Re-calling overwrites the prior proposal; passing `address(0)` cancels it. This
    ///         handshake (mirroring `Ownable2Step` for the platform admin) prevents a fat-fingered or
    ///         unreachable address from being handed permanent control of a merchant, and gives a
    ///         compromised-but-recoverable merchant a path to migrate to a fresh key under owner intent.
    /// @param id       The merchant whose ownership is being transferred (must exist; only its owner may call).
    /// @param newOwner The address proposed as the next owner (`address(0)` cancels a pending proposal).
    function proposeMerchantOwner(uint256 id, address newOwner) external {
        Merchant storage m = merchants[id];
        if (m.owner == address(0)) revert Access0x1__MerchantNotFound(id);
        if (msg.sender != m.owner) revert Access0x1__NotMerchantOwner(id, msg.sender);

        pendingMerchantOwner[id] = newOwner;
        emit MerchantOwnerProposed(id, m.owner, newOwner);
    }

    /// @notice Step 2 of a 2-step merchant-ownership transfer: the PROPOSED owner accepts and takes
    ///         control. Only the exact `pendingMerchantOwner[id]` may call; on success it becomes the
    ///         merchant `owner`, the pending slot is cleared, and the previous owner loses all authority
    ///         over the merchant (payout/listing/subscription/booking control). A never-proposed merchant
    ///         has a zero pending owner, so this can never be called against it (the zero-caller guard).
    /// @param id The merchant to take ownership of.
    function acceptMerchantOwner(uint256 id) external {
        address pending = pendingMerchantOwner[id];
        // A zero pending owner (never proposed, or already accepted/cancelled) is unclaimable: reject
        // any caller, including address(0), so an unset proposal can never transfer control.
        if (pending == address(0) || msg.sender != pending) {
            revert Access0x1__NotPendingMerchantOwner(id, msg.sender);
        }

        Merchant storage m = merchants[id];
        address previousOwner = m.owner;
        m.owner = pending;
        delete pendingMerchantOwner[id];
        emit MerchantOwnerTransferred(id, previousOwner, pending);
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

    /// @notice Set (or clear) the Chainlink <token>/USD feed used to price a token, keeping the
    ///         historical 1h staleness window. `priceFeedOf[0]` is the native/USD feed. Passing
    ///         `feed == address(0)` clears the mapping.
    /// @dev    Clears any per-feed `stalenessOf[token]` override, so `quote()` falls back to
    ///         OracleLib's 1h default — preserving every existing caller's behaviour exactly. A
    ///         slow-heartbeat feed (e.g. a 24h USDC/USD) must use the 3-arg overload instead.
    /// @param token The token (address(0) = native) whose feed is being set.
    /// @param feed  The Chainlink aggregator, or address(0) to clear.
    function setPriceFeed(address token, address feed) external onlyOwner {
        priceFeedOf[token] = feed;
        stalenessOf[token] = 0; // unset ⇒ quote() uses OracleLib's 1h default
        emit PriceFeedSet(token, feed);
        emit FeedStalenessSet(token, 0);
    }

    /// @notice Set the Chainlink <token>/USD feed AND an explicit per-feed staleness window. Use this
    ///         for slow-heartbeat feeds (e.g. a 24h-heartbeat USDC/USD that only republishes on a
    ///         0.25% deviation): a flat 1h window would falsely revert `quote()` as stale during a
    ///         quiet stretch even though the price is valid.
    /// @dev    `maxStaleness` MUST be `> 0`; to clear a feed (and its window) use the 2-arg overload,
    ///         which resets `stalenessOf` to the 1h default. The deploy runbook must verify the
    ///         configured window is `>=` the feed's published heartbeat (heartbeat is not
    ///         on-chain-queryable). `feed == address(0)` is rejected — a window with no feed is
    ///         meaningless; use the 2-arg overload to clear.
    /// @param token        The token (address(0) = native) whose feed is being set.
    /// @param feed         The Chainlink aggregator (non-zero).
    /// @param maxStaleness Max age (seconds) the feed answer may reach before `quote()` treats it as
    ///                     stale (e.g. 86400 + margin for a 24h-heartbeat feed).
    function setPriceFeed(address token, address feed, uint256 maxStaleness) external onlyOwner {
        if (feed == address(0)) revert Access0x1__ZeroAddress();
        if (maxStaleness == 0) revert Access0x1__ZeroAmount();
        priceFeedOf[token] = feed;
        stalenessOf[token] = maxStaleness;
        emit PriceFeedSet(token, feed);
        emit FeedStalenessSet(token, maxStaleness);
    }

    /// @notice Set (or clear) the Chainlink L2 Sequencer Uptime feed checked by `quote()`. Set it on
    ///         L2 deployments (Arbitrum / Optimism / Base); pass `address(0)` to clear it (L1 / Arc),
    ///         which skips the sequencer check entirely.
    /// @param feed The Chainlink L2 Sequencer Uptime aggregator, or address(0) to clear.
    function setSequencerUptimeFeed(address feed) external onlyOwner {
        sequencerUptimeFeed = feed;
        emit SequencerUptimeFeedSet(feed);
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

    /// @notice Set (or clear, with `address(0)`) the PaymentLanes receipt contract. When set, the
    ///         router must be authorized on that PaymentLanes (`setRouter(this, true)`) for the credit
    ///         leg to succeed; if it is not, `payToken` falls back to paying the merchant directly —
    ///         a misconfiguration can never strand or revert a settled payment.
    /// @param newLanes The PaymentLanes contract, or `address(0)` to disable the lanes leg.
    /// @dev    `address(0)` is a DELIBERATE sentinel ("disable lanes"), so there is no zero-check —
    ///         the Slither missing-zero-address-validation flag is acknowledged by design.
    // slither-disable-next-line missing-zero-check
    function setPaymentLanes(address newLanes) external onlyOwner {
        emit PaymentLanesSet(paymentLanes, newLanes);
        paymentLanes = newLanes;
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

        // L2 sequencer guard: when an L2 Sequencer Uptime feed is configured, reject pricing while the
        // sequencer is down or within its post-restart grace window. address(0) (L1 / Arc) skips this.
        address seqFeed = sequencerUptimeFeed;
        if (seqFeed != address(0)) AggregatorV3Interface(seqFeed).checkSequencerUp();

        address feedAddr = priceFeedOf[token];
        if (feedAddr == address(0)) revert Access0x1__TokenNotAllowed(token);

        // Per-feed staleness window: a slow-heartbeat feed (24h USDC/USD) gets its configured window;
        // an unset (0) window falls back to OracleLib's 1h default, so the historical 1h behaviour
        // (and the 2-arg setPriceFeed path) is unchanged.
        uint256 maxStaleness = stalenessOf[token];
        if (maxStaleness == 0) maxStaleness = OracleLib.TIMEOUT;

        // Only the answer is needed; the staleness guard already reverted a stale/invalid round,
        // so the other tuple fields are intentionally unused (Slither unused-return acknowledged).
        // slither-disable-next-line unused-return
        (, int256 answer,,,) =
            AggregatorV3Interface(feedAddr).staleCheckLatestRoundData(maxStaleness);
        if (answer <= 0) revert Access0x1__InvalidPrice(answer);
        // answer > 0 is enforced by the guard above, so this int256→uint256 cast cannot wrap.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 price = uint256(answer);

        // Read decimals through try/catch so a hostile/broken feed or token that reverts on
        // `decimals()` yields the typed `Access0x1__TokenNotAllowed` (the same revert the
        // allowlist/feed checks above give) instead of an opaque, unattributable bubble-up. A
        // token that cannot answer `decimals()` cannot be priced, so it is simply not allowed.
        uint256 feedDecimals;
        try AggregatorV3Interface(feedAddr).decimals() returns (uint8 fd) {
            feedDecimals = fd;
        } catch {
            revert Access0x1__TokenNotAllowed(token);
        }

        uint256 tokenDecimals;
        if (token == NATIVE) {
            tokenDecimals = 18;
        } else {
            try IERC20Metadata(token).decimals() returns (uint8 td) {
                tokenDecimals = td;
            } catch {
                revert Access0x1__TokenNotAllowed(token);
            }
        }

        // tokenAmount = usdAmount8 · 10^(feedDecimals + tokenDecimals) / (10^USD_DECIMALS · price)
        tokenAmount = Math.mulDiv(
            usdAmount8,
            10 ** (feedDecimals + tokenDecimals),
            10 ** USD_DECIMALS * price,
            Math.Rounding.Ceil
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
    /// @dev `m` is a STORAGE pointer (not a memory copy): the pay paths only ever touch `payout`,
    ///      `owner`, `feeRecipient`, `feeBps`, `active` — slots 0..3 of the record — and never
    ///      `nameHash` (slot 4), so reading the live fields straight from storage skips the one cold
    ///      SLOAD a `Merchant memory` copy would spend loading the unused `nameHash` word. Identical
    ///      values, identical splits — only the unused brand slot is no longer loaded.
    /// @return platformFee     The platform's cut → `platformTreasury`.
    /// @return merchantFee     The merchant's surcharge → `merchantFeeDest`.
    /// @return net             What the merchant nets → `payout`.
    /// @return merchantFeeDest Where the merchant surcharge lands.
    function _splitFee(Merchant storage m, uint256 gross)
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
        // Cache the slot once: `feeRecipient` is otherwise read twice in the fallback ternary. Same
        // value either way — 0 ⇒ fall back to `payout`.
        address feeRecipient = m.feeRecipient;
        merchantFeeDest = feeRecipient == address(0) ? m.payout : feeRecipient;
    }

    /// @dev Push native value, or credit the pull-map on failure. A settled receipt must never be
    ///      reverted by a payee that rejects ETH (no custody, no stuck funds) — they pull instead.
    ///      `to` is a merchant/treasury/fee address the caller configured, never arbitrary; a native
    ///      transfer requires a low-level call (`.transfer` caps gas at 2300 and breaks smart-account
    ///      payees); and the only state write is the failure-path `rescue` credit, reached solely
    ///      from `nonReentrant` callers — `claimRescue` is `nonReentrant` too, so the shared guard
    ///      makes cross-function reentrancy on `rescue` impossible. The Slither flags below
    ///      (arbitrary-send-eth, low-level-calls, reentrancy-benign) are acknowledged by design.
    // slither-disable-next-line arbitrary-send-eth,low-level-calls,reentrancy-benign,reentrancy-events
    function _pushNativeOrQueue(address to, uint256 amount) private {
        if (amount == 0) return;
        // slither-disable-next-line arbitrary-send-eth,low-level-calls
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
    /// @dev    Slither reentrancy-eth is acknowledged: the only post-call state write is the
    ///         failure-path `rescue` credit in `_pushNativeOrQueue`, and the `nonReentrant` guard
    ///         (shared with `payToken`/`claimRescue`) makes re-entry impossible. CEI is preserved.
    // slither-disable-next-line reentrancy-eth,reentrancy-events
    function payNative(uint256 merchantId, uint256 usdAmount8, bytes32 orderId)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        // Storage pointer, not a memory copy: the pay path reads `owner`, `active`, then (in
        // `_splitFee`) `feeBps`/`feeRecipient`/`payout` — never `nameHash`. A `Merchant memory` copy
        // would spend a cold SLOAD loading that unused brand slot; reading live fields skips it.
        Merchant storage m = merchants[merchantId];
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
            // slither-disable-next-line low-level-calls
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
        // Storage pointer, not a memory copy (see `payNative`): the pay path never reads `nameHash`,
        // so this skips the cold SLOAD a `Merchant memory` copy would spend on that unused slot.
        Merchant storage m = merchants[merchantId];
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

        _settleNet(merchantId, token, m.payout, net);
        if (platformFee > 0) IERC20(token).safeTransfer(platformTreasury, platformFee);
        if (merchantFee > 0) IERC20(token).safeTransfer(merchantFeeDest, merchantFee);
    }

    /// @dev Deliver the merchant's net. When no PaymentLanes is configured (the default), this is the
    ///      unchanged direct push `payout ← net`. When one IS configured, the net is routed into
    ///      PaymentLanes as a non-custodial lane RECEIPT the merchant pulls later via `claim` — the
    ///      "receive in any coin" seam. The lane credit is APPEND-ONLY and NON-REVERTING: it runs
    ///      after the receipt event and all router effects, and a PaymentLanes failure (e.g. the
    ///      router was never authorized there) is caught and falls back to the direct push, so a
    ///      lanes problem can never strand or roll back a settled payment (law #5). The router holds
    ///      no token after either branch (zero custody): on the lanes path the approval is consumed by
    ///      PaymentLanes' `safeTransferFrom`; on failure the leftover approval is reset to 0 and net is
    ///      pushed out directly, and a {LanesFallback} event is emitted so a permanently-reverting lanes
    ///      contract surfaces (rather than silently disabling the "receive in any coin" seam).
    function _settleNet(uint256 merchantId, address token, address payout, uint256 net) private {
        address lanes = paymentLanes;
        if (lanes == address(0)) {
            IERC20(token).safeTransfer(payout, net);
            return;
        }
        // Approve PaymentLanes to pull exactly `net`, then credit the merchant's lane. On any revert
        // there, drop the approval and pay the merchant directly — the payment still settles. The
        // returned lane id is intentionally unused (the router never reads lane state); the credit is
        // the LAST interaction after all router effects, so reentrancy-events is benign by design.
        IERC20(token).forceApprove(lanes, net);
        // slither-disable-next-line unused-return,reentrancy-events,reentrancy-benign,uninitialized-local
        try IPaymentLanes(lanes).credit(payout, token, net) {
        // Net is now held by PaymentLanes, backing the merchant's lane receipt. Done.
        }
        catch {
            // Lanes leg failed: reset the dangling approval and fall back to the direct push. Emit so a
            // broken/unauthorized lanes contract is observable instead of silently non-functional.
            IERC20(token).forceApprove(lanes, 0);
            IERC20(token).safeTransfer(payout, net);
            emit LanesFallback(merchantId, token, net);
        }
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
        // slither-disable-next-line low-level-calls
        (bool ok,) = msg.sender.call{ value: amount }("");
        if (!ok) revert Access0x1__NativePushFailed(msg.sender, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                UPGRADE
    //////////////////////////////////////////////////////////////*/

    /// @notice Authorize a UUPS upgrade. Restricted to the contract `owner` (the upgrade admin) — the
    ///         single gate {upgradeToAndCall} consults before swapping the implementation.
    /// @dev    Empty body: the `onlyOwner` modifier IS the policy. Once `renounceOwnership()` sets the
    ///         owner to address(0), every call here reverts, so the implementation becomes permanently
    ///         immutable (the on-chain "freeze"). `newImplementation` is intentionally unnamed — no
    ///         per-target allow-listing; the owner is fully trusted to vet the target off-chain.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }

    /// @dev Reserved storage slots so future versions can APPEND new state without shifting the layout
    ///      above (UUPS storage-collision safety). Each new variable added in a later version consumes
    ///      one slot from the head of this gap; shrink `__gap` by exactly the number of slots added so
    ///      the total stays 50. NEVER reorder or insert a variable above this gap — only append.
    uint256[50] private __gap;
}
