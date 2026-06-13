// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
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
}
