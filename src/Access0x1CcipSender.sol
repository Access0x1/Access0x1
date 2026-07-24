// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// ┌──────────────────────────────────────────────────────────────────────────────┐
// │   .---.     \ /    |                                                         │
// │  ( o o )     X     |     A C C E S S 0 x 1                                   │
// │   `-o-'     / \    |     wire web2 to web3 — zero custody, testnet only      │
// │     0        x     1                                                         │
// ├──────────────────────────────────────────────────────────────────────────────┤
// │  Access0x1CcipSender                                                         │
// │  The source half: pay a merchant on a chain this one has never heard of.     │
// └──────────────────────────────────────────────────────────────────────────────┘

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {
    ReentrancyGuardTransient
} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import { ICcipReceiver } from "./interfaces/ICcipReceiver.sol";
import { ICcipRouterClient } from "./interfaces/ICcipRouterClient.sol";

/// @title Access0x1CcipSender — send a payment to a merchant on another chain
/// @author Access0x1
/// @notice The source half of cross-chain pay-in, deployed on chains where the Access0x1 rail may
///         not exist at all. A buyer approves a token, names a destination and a merchant, and this
///         contract packs the payment intent + tokens into one CCIP message to the
///         {Access0x1CcipReceiver} on the destination chain, where it settles through the ordinary
///         router. The CCIP fee is paid BY THE BUYER per message (native or LINK) — nobody funds a
///         standing balance, here or at the destination.
///
/// @dev    ZERO CUSTODY, ONE TRANSACTION. Tokens move buyer → this contract → CCIP Router inside a
///         single tx; steady-state balance is zero. There is nothing to withdraw and no owner sweep,
///         because there is never anything held.
///
///         WHAT THE OWNER CONTROLS — and the deliberate limit of it. `setDestination` maps a chain
///         selector to the receiver contract trusted on that chain, mirroring the receiver's own
///         source-lane allowlist from the other side. The owner cannot touch funds, pause sends
///         mid-flight, or redirect an in-flight message; repointing a destination affects FUTURE
///         sends only.
///
///         FEE QUOTING: callers should `quoteFee` first. Chainlink's Router accepts overpayment
///         WITHOUT refund, so for native fees this contract forwards exactly the quoted fee and
///         returns any excess `msg.value` to the buyer itself — the one transfer this contract ever
///         pushes, and it goes back to `msg.sender`.
///
///         NO ADDRESS OR SELECTOR IS HARDCODED (law #3). The CCIP Router is constructor-set; every
///         (selector → receiver) pair is owner-set and must be CONFIRMED from
///         docs.chain.link/ccip/directory plus your own broadcast record on the destination.
///
/// @custom:security-contact security@access0x1.dev
contract Access0x1CcipSender is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Immutables + storage
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice The CCIP Router on THIS chain — the only contract sends go through.
    ICcipRouterClient public immutable i_ccipRouter;

    /// @notice LINK on this chain, for buyers who pay the CCIP fee in LINK. Zero ⇒ native-fee only.
    address public immutable i_link;

    /// @notice Destination chain selector ⇒ the Access0x1CcipReceiver trusted there.
    /// @dev    The mirror image of the receiver's `allowedSenderFor`: both sides must name each
    ///         other before a payment can flow. `address(0)` = destination closed.
    mapping(uint64 destChainSelector => address receiver) public receiverFor;

    /// @notice Default gas limit for the destination-side `ccipReceive` execution.
    /// @dev    Owner-tunable because the receiver's settle path (quote + payToken + events) costs
    ///         real gas that varies by destination; too low and every message lands as a failed
    ///         execution needing manual retry. Encoded via Chainlink's `EVMExtraArgsV1` tag.
    uint256 public destGasLimit = 400_000;

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice A cross-chain payment left this chain.
    /// @param messageId        The CCIP message id — track it on the destination and in CCIP's explorer.
    /// @param destChainSelector The destination chain's CCIP selector.
    /// @param merchantId       The merchant to credit over there.
    /// @param token            The token sent (source-chain address).
    /// @param amount           The token amount sent.
    /// @param feeToken         What the CCIP fee was paid in (`address(0)` = native).
    /// @param fee              The CCIP fee paid.
    event CrossChainPaymentSent(
        bytes32 indexed messageId,
        uint64 indexed destChainSelector,
        uint256 indexed merchantId,
        address token,
        uint256 amount,
        address feeToken,
        uint256 fee
    );

    /// @notice A destination was opened, repointed, or closed.
    event DestinationSet(uint64 indexed destChainSelector, address indexed receiver);

    /// @notice The destination gas limit changed.
    event DestGasLimitSet(uint256 gasLimit);

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice A required address argument was zero.
    error Access0x1CcipSender__ZeroAddress();

    /// @notice A required amount argument was zero.
    error Access0x1CcipSender__ZeroAmount();

    /// @notice No receiver is configured for this destination selector.
    error Access0x1CcipSender__DestinationNotSet(uint64 destChainSelector);

    /// @notice Fee was requested in LINK but this deployment has no LINK configured.
    error Access0x1CcipSender__LinkNotConfigured();

    /// @notice `msg.value` does not cover the quoted native CCIP fee.
    /// @param quoted The fee the Router quoted.
    /// @param sent   The native value provided.
    error Access0x1CcipSender__InsufficientNativeFee(uint256 quoted, uint256 sent);

    /// @notice Returning excess native to the buyer failed.
    /// @dev    Surfaced as its own error (not swallowed) because silently keeping the buyer's
    ///         change would violate zero custody.
    error Access0x1CcipSender__RefundFailed();

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Construction + admin
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @param ccipRouter The CCIP Router on THIS chain — CONFIRM from docs.chain.link/ccip/directory.
    /// @param link       LINK on this chain, or `address(0)` for a native-fee-only deployment.
    /// @param owner_     The address that may set destinations and the gas limit.
    constructor(address ccipRouter, address link, address owner_) Ownable(owner_) {
        if (ccipRouter == address(0) || owner_ == address(0)) {
            revert Access0x1CcipSender__ZeroAddress();
        }
        i_ccipRouter = ICcipRouterClient(ccipRouter);
        i_link = link;
    }

    /// @notice Open, repoint, or close (zero) a destination.
    /// @dev    Both halves of the pair are trust statements: the selector must come from
    ///         Chainlink's directory and the receiver from your own broadcast record on that
    ///         chain. Affects FUTURE sends only — an in-flight message keeps its original target.
    function setDestination(uint64 destChainSelector, address receiver) external onlyOwner {
        receiverFor[destChainSelector] = receiver;
        emit DestinationSet(destChainSelector, receiver);
    }

    /// @notice Tune the destination-side execution gas limit.
    function setDestGasLimit(uint256 gasLimit) external onlyOwner {
        destGasLimit = gasLimit;
        emit DestGasLimitSet(gasLimit);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Quoting + sending
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice The CCIP fee to send `amount` of `token` to `destChainSelector`, in `feeToken`
    ///         (`address(0)` = native). Call this before {payCrossChain} and supply exactly it.
    function quoteFee(
        uint64 destChainSelector,
        uint256 merchantId,
        uint256 usdAmount8,
        bytes32 orderId,
        address token,
        uint256 amount,
        address refundTo,
        address feeToken
    ) external view returns (uint256 fee) {
        ICcipRouterClient.EVM2AnyMessage memory message =
            _buildMessage(
                destChainSelector,
                merchantId,
                usdAmount8,
                orderId,
                token,
                amount,
                refundTo,
                feeToken
            );
        return i_ccipRouter.getFee(destChainSelector, message);
    }

    /// @notice Pay `merchantId` on the destination chain: `usdAmount8` (USD, 8 decimals) settled
    ///         from `amount` of `token`, with any surplus claimable by `refundTo` over there.
    /// @dev    Fee in NATIVE: send the quoted fee as `msg.value`; excess is returned. Fee in LINK:
    ///         `msg.value` must be zero and this contract pulls exactly the quoted LINK.
    ///
    ///         `amount` should be the {quoteFee}-time destination quote PLUS slack for price
    ///         movement in flight — a short arrival does not settle; it becomes claimable by
    ///         `refundTo` on the destination (see the receiver's SHORT_AMOUNT path).
    /// @return messageId The CCIP message id, also indexed in {CrossChainPaymentSent}.
    function payCrossChain(
        uint64 destChainSelector,
        uint256 merchantId,
        uint256 usdAmount8,
        bytes32 orderId,
        address token,
        uint256 amount,
        address refundTo,
        bool payFeeInLink
    ) external payable nonReentrant returns (bytes32 messageId) {
        if (token == address(0)) revert Access0x1CcipSender__ZeroAddress();
        if (amount == 0) revert Access0x1CcipSender__ZeroAmount();
        // A zero refundTo would burn the destination-side fallback credit; the buyer is the
        // natural default.
        if (refundTo == address(0)) refundTo = msg.sender;

        address feeToken = payFeeInLink ? i_link : address(0);
        if (payFeeInLink && i_link == address(0)) revert Access0x1CcipSender__LinkNotConfigured();

        ICcipRouterClient.EVM2AnyMessage memory message =
            _buildMessage(
                destChainSelector,
                merchantId,
                usdAmount8,
                orderId,
                token,
                amount,
                refundTo,
                feeToken
            );

        uint256 fee = i_ccipRouter.getFee(destChainSelector, message);

        // Pull the payment tokens and approve the Router for exactly this send. `forceApprove`
        // handles non-standard ERC-20s (USDT-style) that require a zero-first approval.
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(token).forceApprove(address(i_ccipRouter), amount);

        if (payFeeInLink) {
            // LINK fee: pull exactly the quote, approve exactly the quote. msg.value must be 0 —
            // accepting stray native alongside a LINK fee would strand it here (zero custody).
            if (msg.value != 0) revert Access0x1CcipSender__InsufficientNativeFee(0, msg.value);
            IERC20(i_link).safeTransferFrom(msg.sender, address(this), fee);
            IERC20(i_link).forceApprove(address(i_ccipRouter), fee);
            messageId = i_ccipRouter.ccipSend(destChainSelector, message);
        } else {
            // Native fee: forward EXACTLY the quote (the Router keeps overpayment without refund)
            // and return the buyer's change ourselves.
            if (msg.value < fee) {
                revert Access0x1CcipSender__InsufficientNativeFee(fee, msg.value);
            }
            messageId = i_ccipRouter.ccipSend{ value: fee }(destChainSelector, message);
            uint256 excess = msg.value - fee;
            if (excess != 0) {
                (bool ok,) = msg.sender.call{ value: excess }("");
                if (!ok) revert Access0x1CcipSender__RefundFailed();
            }
        }

        emit CrossChainPaymentSent(
            messageId, destChainSelector, merchantId, token, amount, feeToken, fee
        );
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @dev Chainlink's `EVM_EXTRA_ARGS_V1_TAG`, DERIVED rather than pasted. Chainlink defines it as
    ///      `bytes4(keccak256("CCIP EVMExtraArgsV1"))`; computing it here means the source string is
    ///      the source of truth and the magic number cannot be mistyped. It evaluates to 0x97a657c9
    ///      (verified against chainlink-ccip's Client.sol, 2026-07-24) and is asserted in the tests.
    ///      The V1 args carry only the destination gas limit, which is all this sender needs.
    bytes4 private constant EVM_EXTRA_ARGS_V1_TAG = bytes4(keccak256("CCIP EVMExtraArgsV1"));

    /// @dev Build the CCIP message: the abi-encoded payment intent the receiver decodes, plus the
    ///      single token amount. Reverts when the destination is not configured — quoting against
    ///      a closed destination would return a fee for a message that can never be trusted.
    function _buildMessage(
        uint64 destChainSelector,
        uint256 merchantId,
        uint256 usdAmount8,
        bytes32 orderId,
        address token,
        uint256 amount,
        address refundTo,
        address feeToken
    ) private view returns (ICcipRouterClient.EVM2AnyMessage memory message) {
        address receiver = receiverFor[destChainSelector];
        if (receiver == address(0)) {
            revert Access0x1CcipSender__DestinationNotSet(destChainSelector);
        }

        ICcipReceiver.EVMTokenAmount[] memory tokenAmounts = new ICcipReceiver.EVMTokenAmount[](1);
        tokenAmounts[0] = ICcipReceiver.EVMTokenAmount({ token: token, amount: amount });

        message = ICcipRouterClient.EVM2AnyMessage({
            receiver: abi.encode(receiver),
            // Must match the receiver's decode exactly: (merchantId, usdAmount8, orderId, refundTo).
            data: abi.encode(merchantId, usdAmount8, orderId, refundTo),
            tokenAmounts: tokenAmounts,
            feeToken: feeToken,
            extraArgs: abi.encodeWithSelector(EVM_EXTRA_ARGS_V1_TAG, destGasLimit)
        });
    }
}
