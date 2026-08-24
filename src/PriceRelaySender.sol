// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// ┌──────────────────────────────────────────────────────────────────────────────┐
// │   .---.     \ /    |                                                         │
// │  ( o o )     X     |     A C C E S S 0 x 1                                   │
// │   `-o-'     / \    |     wire web2 to web3 — zero custody, testnet only      │
// │     0        x     1                                                         │
// ├──────────────────────────────────────────────────────────────────────────────┤
// │  PriceRelaySender                                                            │
// │  Carry a REAL Chainlink feed to a chain Chainlink does not serve.            │
// └──────────────────────────────────────────────────────────────────────────────┘

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {
    ReentrancyGuardTransient
} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

import { ICcipReceiver } from "./interfaces/ICcipReceiver.sol";
import { ICcipRouterClient } from "./interfaces/ICcipRouterClient.sol";
import { OracleLib } from "./libraries/OracleLib.sol";

/// @title PriceRelaySender — publish a real Chainlink price to a chain that has none
/// @author Access0x1
/// @notice The SOURCE half of the price relay. It lives on a chain where Chainlink DOES publish the
///         feed the rail needs (Ethereum Sepolia has a real USDC/USD aggregator), reads that feed
///         through the same {OracleLib} guard the router uses, and forwards the answer as a
///         DATA-ONLY Chainlink CCIP message to a {PriceRelayReceiver} on a chain where Chainlink
///         publishes nothing (Arc testnet, 5042002). No tokens ride along; the payload is the price.
///
///         WHAT THIS EARNS, STATED EXACTLY. The number that ends up pricing a payment on the
///         destination is a real Chainlink Data Feed answer, carried over real Chainlink CCIP
///         infrastructure. It is NOT a Chainlink Data Feed ON the destination chain, and no claim
///         here should ever say otherwise: Chainlink's registry lists no feed and no Data Streams
///         verifier for Arc (checked 2026-08-23). The destination's trust therefore rests on three
///         separable things — the source feed's DON, CCIP's authenticated delivery, and the
///         receiver's own guards. The receiver's NatSpec enumerates what CCIP does and does NOT
///         promise about the number it carries.
///
/// @dev    ZERO CUSTODY, ZERO STANDING BALANCE. The only value that touches this contract is the CCIP
///         fee for one message, forwarded in the same transaction. Native overpayment is returned to
///         the caller, because Chainlink's Router accepts overpayment WITHOUT refund.
///
///         PERMISSIONLESS TO CALL, DELIBERATELY. {relay} has no access control. The value it sends is
///         read from an IMMUTABLE Chainlink aggregator inside the call, so a caller chooses only the
///         MOMENT of a refresh, never the number. Making liveness anyone's business — rather than one
///         keeper's — is the point: a stalled keeper cannot hold the destination hostage, since
///         anybody willing to pay the CCIP fee can push the current price. The owner's authority is
///         confined to naming the destination and tuning the destination gas limit.
///
///         THE STALENESS GUARD IS ON THE SEND SIDE TOO. A source answer that is already stale never
///         becomes a cross-chain message: {relay} reads through
///         `OracleLib.staleCheckLatestRoundData` and reverts before spending a fee. Relaying a stale
///         answer would launder its age — it would arrive looking freshly delivered — so it is
///         refused at the source. The receiver independently re-checks the age on arrival; neither
///         side trusts the other to have done it.
///
///         NO ADDRESS OR SELECTOR IS HARDCODED (law #3). The CCIP Router, the source feed, and every
///         destination pair are constructor- or owner-set, and every selector must be CONFIRMED from
///         `docs.chain.link/ccip/directory` before use.
///
///         UNCONFIRMED — the one soft spot, stated rather than buried. Arc Network Testnet is a live
///         CCIP chain with a Router, a chain selector, and a bidirectional lane to Ethereum Sepolia
///         (onRamp and offRamp addresses confirmed in Chainlink's directory, 2026-08-23). That lane
///         carries ZERO registered token pools, which is irrelevant here because this message carries
///         no tokens. Chainlink documents Data / Tokens / Data+Tokens as three independently
///         configured message modes; the availability of the DATA-ONLY mode on this specific lane is
///         INFERRED from the live ramp infrastructure plus that taxonomy, and not from a page
///         asserting it for this lane by name. Confirm with one `getFee` call against the live Router
///         before treating the relay as operational — {quoteFee} is exactly that call.
///
/// @custom:security-contact security@access0x1.dev
contract PriceRelaySender is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using OracleLib for AggregatorV3Interface;

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Immutables
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice The CCIP Router on THIS chain — the only contract messages go through.
    ICcipRouterClient public immutable i_ccipRouter;

    /// @notice The REAL Chainlink aggregator this relay republishes.
    /// @dev    Immutable, and that is the whole security story of the payload: a swappable source
    ///         feed would make a permissionless {relay} a permissionless price oracle. Because the
    ///         source cannot change, an unauthorized caller controls the timing of a refresh and
    ///         nothing else.
    AggregatorV3Interface public immutable i_sourceFeed;

    /// @notice LINK on this chain, for callers paying the CCIP fee in LINK. Zero ⇒ native-fee only.
    address public immutable i_link;

    /// @notice Max age of a source answer that may be relayed, in seconds.
    /// @dev    Immutable and set per source feed at deployment — Chainlink's USDC/USD feeds run a slow
    ///         heartbeat (a day, with a deviation trigger), so a flat 1h window would reject perfectly
    ///         valid answers. It is passed straight to {OracleLib}'s `maxStaleness` overload.
    uint256 public immutable i_maxSourceAge;

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice Destination chain selector ⇒ the {PriceRelayReceiver} trusted there.
    /// @dev    The mirror of the receiver's own source-lane allowlist: both sides name each other
    ///         before a price can flow. `address(0)` = destination closed.
    mapping(uint64 destChainSelector => address receiver) public receiverFor;

    /// @notice Gas limit for the destination-side `ccipReceive` execution.
    /// @dev    The receiver's work is a decode, four guards, and one storage write — far cheaper than
    ///         the settlement receiver's path, hence the lower default. Owner-tunable because a limit
    ///         set too low lands every message as a failed execution needing manual retry.
    uint256 public destGasLimit = 200_000;

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice A price left this chain for a destination.
    /// @param messageId        The CCIP message id — track it in CCIP's explorer and on the destination.
    /// @param destChainSelector The destination chain's CCIP selector.
    /// @param answer           The source feed's answer, at `sourceDecimals` scale.
    /// @param sourceUpdatedAt  When the SOURCE feed posted that answer (not when this relay ran).
    /// @param feeToken         What the CCIP fee was paid in (`address(0)` = native).
    /// @param fee              The CCIP fee paid.
    event PriceRelayed(
        bytes32 indexed messageId,
        uint64 indexed destChainSelector,
        int256 answer,
        uint256 sourceUpdatedAt,
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
    error PriceRelaySender__ZeroAddress();

    /// @notice A required duration argument was zero.
    error PriceRelaySender__ZeroDuration();

    /// @notice No receiver is configured for this destination selector.
    error PriceRelaySender__DestinationNotSet(uint64 destChainSelector);

    /// @notice The source feed returned a non-positive answer.
    /// @dev    {OracleLib} owns staleness only; answer VALIDITY is the caller's job, exactly as in the
    ///         router's `quote()`. A non-positive price is never relayed.
    /// @param answer The rejected answer.
    error PriceRelaySender__InvalidSourceAnswer(int256 answer);

    /// @notice Fee was requested in LINK but this deployment has no LINK configured.
    error PriceRelaySender__LinkNotConfigured();

    /// @notice `msg.value` does not cover the quoted native CCIP fee.
    /// @param quoted The fee the Router quoted.
    /// @param sent   The native value provided.
    error PriceRelaySender__InsufficientNativeFee(uint256 quoted, uint256 sent);

    /// @notice Returning excess native to the caller failed.
    error PriceRelaySender__RefundFailed();

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Construction + admin
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @param ccipRouter   The CCIP Router on THIS chain — CONFIRM from docs.chain.link/ccip/directory.
    /// @param sourceFeed   The REAL Chainlink aggregator to republish — CONFIRM from
    ///                     docs.chain.link/data-feeds/price-feeds/addresses for THIS chain.
    /// @param link         LINK on this chain, or `address(0)` for a native-fee-only deployment.
    /// @param maxSourceAge Max age (seconds) of a source answer this relay will forward.
    /// @param owner_       The address that may set destinations and the gas limit.
    constructor(
        address ccipRouter,
        address sourceFeed,
        address link,
        uint256 maxSourceAge,
        address owner_
    ) Ownable(owner_) {
        if (ccipRouter == address(0) || sourceFeed == address(0)) {
            revert PriceRelaySender__ZeroAddress();
        }
        if (maxSourceAge == 0) revert PriceRelaySender__ZeroDuration();

        i_ccipRouter = ICcipRouterClient(ccipRouter);
        i_sourceFeed = AggregatorV3Interface(sourceFeed);
        i_link = link;
        i_maxSourceAge = maxSourceAge;
    }

    /// @notice Open, repoint, or close (zero) a destination.
    /// @dev    Both halves of the pair are trust statements: the selector comes from Chainlink's
    ///         directory and the receiver from your own broadcast record on that chain. Affects
    ///         FUTURE sends only — an in-flight message keeps its original target.
    /// @param destChainSelector The destination chain's CCIP selector.
    /// @param receiver          The {PriceRelayReceiver} there (`address(0)` closes the destination).
    function setDestination(uint64 destChainSelector, address receiver) external onlyOwner {
        receiverFor[destChainSelector] = receiver;
        emit DestinationSet(destChainSelector, receiver);
    }

    /// @notice Tune the destination-side execution gas limit.
    /// @param gasLimit The new limit, encoded into every subsequent message's `EVMExtraArgsV1`.
    function setDestGasLimit(uint256 gasLimit) external onlyOwner {
        destGasLimit = gasLimit;
        emit DestGasLimitSet(gasLimit);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Reads
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice The current source answer and its age, guarded exactly as {relay} guards it.
    /// @dev    A keeper's pre-flight read: this reverts under the same conditions {relay} would, so a
    ///         cron discovers a stale or invalid source WITHOUT spending a CCIP fee to find out.
    /// @return answer          The source feed's latest answer.
    /// @return sourceUpdatedAt When the source feed posted it.
    /// @return sourceDecimals  The source feed's scale.
    function readSource()
        public
        view
        returns (int256 answer, uint256 sourceUpdatedAt, uint8 sourceDecimals)
    {
        // slither-disable-next-line unused-return
        (, answer,, sourceUpdatedAt,) = i_sourceFeed.staleCheckLatestRoundData(i_maxSourceAge);
        if (answer <= 0) revert PriceRelaySender__InvalidSourceAnswer(answer);
        sourceDecimals = i_sourceFeed.decimals();
    }

    /// @notice The CCIP fee to deliver the current price to `destChainSelector`, in `feeToken`
    ///         (`address(0)` = native). Call this before {relay} and supply exactly it.
    /// @dev    Also the CONFIRMATION CALL for the data-only-lane question flagged in the contract
    ///         NatSpec: a Router that quotes this message is a Router that accepts it.
    /// @param destChainSelector The destination chain's CCIP selector.
    /// @param feeToken          `address(0)` for a native fee, or LINK.
    /// @return fee The quoted fee.
    function quoteFee(uint64 destChainSelector, address feeToken)
        external
        view
        returns (uint256 fee)
    {
        (int256 answer, uint256 sourceUpdatedAt, uint8 sourceDecimals) = readSource();
        ICcipRouterClient.EVM2AnyMessage memory message =
            _buildMessage(destChainSelector, answer, sourceUpdatedAt, sourceDecimals, feeToken);
        return i_ccipRouter.getFee(destChainSelector, message);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Relaying
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice Read the source feed and publish its answer to the destination chain.
    /// @dev    Permissionless — see the contract NatSpec for why. Fee in NATIVE: send the quoted fee
    ///         as `msg.value`; any excess is returned. Fee in LINK: `msg.value` must be zero and this
    ///         contract pulls exactly the quoted LINK from the caller.
    /// @param destChainSelector The destination chain's CCIP selector.
    /// @param payFeeInLink      True to pay the CCIP fee in LINK instead of native.
    /// @return messageId The CCIP message id, also indexed in {PriceRelayed}.
    function relay(uint64 destChainSelector, bool payFeeInLink)
        external
        payable
        nonReentrant
        returns (bytes32 messageId)
    {
        if (payFeeInLink && i_link == address(0)) {
            revert PriceRelaySender__LinkNotConfigured();
        }

        (int256 answer, uint256 sourceUpdatedAt, uint8 sourceDecimals) = readSource();

        address feeToken = payFeeInLink ? i_link : address(0);
        ICcipRouterClient.EVM2AnyMessage memory message =
            _buildMessage(destChainSelector, answer, sourceUpdatedAt, sourceDecimals, feeToken);

        uint256 fee = i_ccipRouter.getFee(destChainSelector, message);

        if (payFeeInLink) {
            // LINK fee: pull exactly the quote and approve exactly the quote. `msg.value` must be 0 —
            // stray native alongside a LINK fee would strand here, breaking zero custody.
            if (msg.value != 0) revert PriceRelaySender__InsufficientNativeFee(0, msg.value);
            IERC20(i_link).safeTransferFrom(msg.sender, address(this), fee);
            IERC20(i_link).forceApprove(address(i_ccipRouter), fee);
            messageId = i_ccipRouter.ccipSend(destChainSelector, message);
        } else {
            // Native fee: forward EXACTLY the quote (the Router keeps overpayment without refund)
            // and return the caller's change ourselves.
            if (msg.value < fee) {
                revert PriceRelaySender__InsufficientNativeFee(fee, msg.value);
            }
            messageId = i_ccipRouter.ccipSend{ value: fee }(destChainSelector, message);
            uint256 excess = msg.value - fee;
            if (excess != 0) {
                (bool ok,) = msg.sender.call{ value: excess }("");
                if (!ok) revert PriceRelaySender__RefundFailed();
            }
        }

        emit PriceRelayed(messageId, destChainSelector, answer, sourceUpdatedAt, feeToken, fee);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @dev Chainlink's `EVM_EXTRA_ARGS_V1_TAG`, DERIVED rather than pasted — the same treatment
    ///      {Access0x1CcipSender} gives it, for the same reason: the source string stays the source of
    ///      truth and the magic number cannot be mistyped. `bytes4(keccak256("CCIP EVMExtraArgsV1"))`
    ///      evaluates to 0x97a657c9 and is asserted in the tests.
    bytes4 private constant EVM_EXTRA_ARGS_V1_TAG = bytes4(keccak256("CCIP EVMExtraArgsV1"));

    /// @dev Build the DATA-ONLY CCIP message. `tokenAmounts` is a zero-length array — that emptiness
    ///      is what makes this the "Data" message mode rather than "Data and Tokens". The payload
    ///      layout must match {PriceRelayReceiver}'s decode exactly.
    /// @param destChainSelector The destination chain's CCIP selector.
    /// @param answer            The source answer.
    /// @param sourceUpdatedAt   When the source feed posted it.
    /// @param sourceDecimals    The source feed's scale.
    /// @param feeToken          `address(0)` for a native fee, or LINK.
    /// @return message The message to quote or send.
    function _buildMessage(
        uint64 destChainSelector,
        int256 answer,
        uint256 sourceUpdatedAt,
        uint8 sourceDecimals,
        address feeToken
    ) private view returns (ICcipRouterClient.EVM2AnyMessage memory message) {
        address receiver = receiverFor[destChainSelector];
        if (receiver == address(0)) {
            revert PriceRelaySender__DestinationNotSet(destChainSelector);
        }

        message = ICcipRouterClient.EVM2AnyMessage({
            receiver: abi.encode(receiver),
            // Must match the receiver's decode exactly: (answer, sourceUpdatedAt, sourceDecimals).
            data: abi.encode(answer, sourceUpdatedAt, sourceDecimals),
            // Empty by design: this is a data-only message, no token transfer.
            tokenAmounts: new ICcipReceiver.EVMTokenAmount[](0),
            feeToken: feeToken,
            extraArgs: abi.encodeWithSelector(EVM_EXTRA_ARGS_V1_TAG, destGasLimit)
        });
    }
}
