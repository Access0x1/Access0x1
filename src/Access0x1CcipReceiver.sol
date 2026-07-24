// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// ┌──────────────────────────────────────────────────────────────────────────────┐
// │   .---.     \ /    |                                                         │
// │  ( o o )     X     |     A C C E S S 0 x 1                                   │
// │   `-o-'     / \    |     wire web2 to web3 — zero custody, testnet only      │
// │     0        x     1                                                         │
// ├──────────────────────────────────────────────────────────────────────────────┤
// │  Access0x1CcipReceiver                                                       │
// │  Pay from a chain we never deployed to. Settles here, or stays claimable.    │
// └──────────────────────────────────────────────────────────────────────────────┘

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import { ICcipReceiver } from "./interfaces/ICcipReceiver.sol";
// The router-facing surface (quote / payToken / merchants) is declared as
// `IAccess0x1Router` inside the subscriptions interface file — the same
// declaration every other conduit in this repo settles through.
import { IAccess0x1Router as IRouter } from "./interfaces/IAccess0x1Subscriptions.sol";

/// @title Access0x1CcipReceiver — settle a payment that arrived from another chain
/// @author Access0x1
/// @notice The destination half of cross-chain pay-in. A buyer on a chain where Access0x1 is NOT
///         deployed sends tokens + a payment intent over Chainlink CCIP; this contract receives
///         them here and settles through the ordinary {Access0x1Router}, so the merchant's payout,
///         fee split, and receipt event are byte-for-byte the same as a local payment. The rail
///         gains reach without gaining a second settlement path to audit.
///
/// @dev    WHY THIS IS ON THE MONEY PATH, DELIBERATELY. Every other seam in this repo is off it —
///         identity, swaps, AI, storage — because a failure there must never block a payment. This
///         one credits a payment, so it cannot be off it. The compensating rule is that it never
///         *invents* settlement: it holds the tokens, approves the router, and calls `payToken`.
///         Pricing, the fee split, and the receipt stay the router's job.
///
///         THE THREE THINGS THAT CAN GO WRONG, AND WHAT EACH DOES:
///
///         1. Untrusted delivery — `ccipReceive` reverts. Only the configured CCIP Router may call
///            it, and only for an allowlisted (sourceChainSelector, sender) pair. This is the one
///            case that MUST revert: accepting an unverified message would let anyone mint a
///            settlement out of nothing.
///         2. The delivered amount cannot cover the destination quote (price moved in flight, or
///            the token is fee-on-transfer) — does NOT revert. Reverting would strand real money in
///            a failed-message state pending manual re-execution. The full delivered amount is
///            credited to the refund recipient named in the message, claimable via {claim}.
///         3. The router refuses the settlement (merchant inactive, token de-allowlisted, feed
///            stale, contract paused) — does NOT revert, same reasoning. Credited and claimable.
///
///         So the invariant a reader should hold onto: **money that arrives is always either
///         settled to the merchant or claimable by the refund recipient — never stuck, never
///         silently kept.** This contract's steady-state balance is whatever is owed and unclaimed,
///         and nothing else.
///
///         NO ADDRESS IS HARDCODED (law #3). The CCIP Router, the Access0x1 Router, and every chain
///         selector are constructor/owner-set, and every selector must be CONFIRMED from
///         `docs.chain.link/ccip/directory` for the deployed chain before it is allowlisted.
///
/// @custom:security-contact security@access0x1.dev
contract Access0x1CcipReceiver is ICcipReceiver, IERC165, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @dev Restricts a call to the configured CCIP Router. Named to match Chainlink's own
    ///      `CCIPReceiver.onlyRouter`, so the trust boundary reads the same to anyone who has seen
    ///      their base contract.
    modifier onlyCcipRouter() {
        if (msg.sender != i_ccipRouter) revert Access0x1CcipReceiver__NotCcipRouter(msg.sender);
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Immutables
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice The CCIP Router for THIS chain — the only address allowed to call {ccipReceive}.
    /// @dev    Immutable by design: a swappable message source is a swappable mint authority.
    address public immutable i_ccipRouter;

    /// @notice The Access0x1 router every cross-chain payment settles through.
    /// @dev    Immutable so this contract can never be repointed at a router with a different fee
    ///         split or payout target while holding in-flight funds.
    IRouter public immutable i_router;

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice Allowlisted source lane: CCIP chain selector ⇒ the sender contract on that chain.
    /// @dev    Keyed BY SELECTOR so the same sender address on a different chain is a different
    ///         lane — CREATE2/CREATE3 make identical addresses across chains normal, so checking
    ///         the sender alone would let any chain we ever deployed to impersonate any other.
    ///         `address(0)` = the lane is closed.
    mapping(uint64 sourceChainSelector => address sender) public allowedSenderFor;

    /// @notice Refund recipient ⇒ token ⇒ amount owed and unclaimed (the pull-map).
    /// @dev    The house pattern: a push that cannot succeed becomes a pull, so a payee that cannot
    ///         receive (a reverting contract, a blocklist) can never brick the transition.
    mapping(address recipient => mapping(address token => uint256 amount)) public claimable;

    /// @notice CCIP message id ⇒ already processed. Replay guard.
    /// @dev    CCIP is itself exactly-once, so this is defence in depth rather than the primary
    ///         guard — cheap insurance against a mis-configured or upgraded Router double-calling.
    mapping(bytes32 messageId => bool seen) public processed;

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice A cross-chain payment settled through the router exactly as a local payment would.
    /// @param messageId  The CCIP message id (the cross-chain idempotency key).
    /// @param srcChainSelector The CCIP selector of the chain the payment came from.
    /// @param merchantId The merchant credited.
    /// @param token      The destination-chain token settled in.
    /// @param settled    The token amount routed through the fee split.
    /// @param surplus    Delivered minus settled, credited to `refundTo` (0 when exact).
    event CrossChainPaymentSettled(
        bytes32 indexed messageId,
        uint64 indexed srcChainSelector,
        uint256 indexed merchantId,
        address token,
        uint256 settled,
        uint256 surplus
    );

    /// @notice A delivery could not settle; the FULL delivered amount is claimable.
    /// @dev    Not an error path in the "something is broken" sense — it is the designed outcome
    ///         whenever settling would be wrong (short amount, router refusal). The money is safe
    ///         and named; `reason` says which.
    /// @param messageId The CCIP message id.
    /// @param refundTo  Who may {claim} it.
    /// @param token     The delivered token.
    /// @param amount    The full delivered amount, now claimable.
    /// @param reason    Machine-readable cause: `SHORT_AMOUNT` or `ROUTER_REFUSED`.
    event CrossChainPaymentCredited(
        bytes32 indexed messageId, address indexed refundTo, address token, uint256 amount, bytes32 reason
    );

    /// @notice A claimable balance was withdrawn in full.
    /// @param recipient The claimant.
    /// @param token     The token withdrawn.
    /// @param amount    The full outstanding credit — claims are never partial.
    event Claimed(address indexed recipient, address indexed token, uint256 amount);

    /// @notice A source lane was opened or closed.
    /// @param srcChainSelector The CCIP chain selector.
    /// @param sender           The sender contract on that chain (`address(0)` closes the lane).
    event SourceLaneSet(uint64 indexed srcChainSelector, address indexed sender);

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice A required address argument was zero.
    error Access0x1CcipReceiver__ZeroAddress();

    /// @notice {ccipReceive} was called by something other than the configured CCIP Router.
    /// @param caller The address that tried.
    error Access0x1CcipReceiver__NotCcipRouter(address caller);

    /// @notice The message came from a closed lane, or from a sender that is not the allowlisted
    ///         one for that lane. THE authorization check — see the contract-level note on why
    ///         this reverts rather than crediting.
    /// @param srcChainSelector The source chain selector as delivered.
    /// @param sender           The decoded source sender.
    error Access0x1CcipReceiver__LaneNotAllowed(uint64 srcChainSelector, address sender);

    /// @notice The message carried something other than exactly one token amount.
    /// @dev    One token per payment is the whole model: the router settles a single ERC-20 against
    ///         a single USD price. A zero- or multi-token delivery is malformed for this receiver.
    /// @param count The number of token amounts delivered.
    error Access0x1CcipReceiver__ExpectedOneToken(uint256 count);

    /// @notice This CCIP message id was already processed.
    /// @param messageId The duplicate id.
    error Access0x1CcipReceiver__AlreadyProcessed(bytes32 messageId);

    /// @notice {claim} was called with nothing owed.
    error Access0x1CcipReceiver__NothingToClaim();

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Construction
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @param ccipRouter The CCIP Router on THIS chain — CONFIRM from docs.chain.link/ccip/directory.
    /// @param router     The Access0x1 router every settlement goes through.
    /// @param owner_     The address that may open/close lanes.
    constructor(address ccipRouter, address router, address owner_) Ownable(owner_) {
        if (ccipRouter == address(0) || router == address(0) || owner_ == address(0)) {
            revert Access0x1CcipReceiver__ZeroAddress();
        }
        i_ccipRouter = ccipRouter;
        i_router = IRouter(router);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice Open a source lane, or close it by passing `address(0)`.
    /// @dev    CONFIRM the selector from docs.chain.link/ccip/directory before opening a lane — an
    ///         allowlisted lane is an authorization to credit merchants, so a wrong selector is a
    ///         wrong trust grant, not a typo.
    /// @param srcChainSelector The CCIP chain selector of the source chain.
    /// @param sender           The sender contract on that chain (`address(0)` closes the lane).
    function setSourceLane(uint64 srcChainSelector, address sender) external onlyOwner {
        allowedSenderFor[srcChainSelector] = sender;
        emit SourceLaneSet(srcChainSelector, sender);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // CCIP delivery
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc ICcipReceiver
    /// @dev    `message.data` is `abi.encode(uint256 merchantId, uint256 usdAmount8, bytes32 orderId,
    ///         address refundTo)`. It is decoded ONLY after the lane check, because until the sender
    ///         is proven allowlisted the payload is attacker-controlled.
    ///
    ///         CEI: the replay flag and the pull-map credit are written BEFORE any external call, so
    ///         a token with a transfer hook re-entering here finds the message already processed.
    ///         `nonReentrant` backs that up.
    function ccipReceive(Any2EVMMessage calldata message) external override onlyCcipRouter nonReentrant {
        address sender = abi.decode(message.sender, (address));
        address allowed = allowedSenderFor[message.sourceChainSelector];
        if (allowed == address(0) || sender != allowed) {
            revert Access0x1CcipReceiver__LaneNotAllowed(message.sourceChainSelector, sender);
        }

        if (message.destTokenAmounts.length != 1) {
            revert Access0x1CcipReceiver__ExpectedOneToken(message.destTokenAmounts.length);
        }
        if (processed[message.messageId]) revert Access0x1CcipReceiver__AlreadyProcessed(message.messageId);
        processed[message.messageId] = true; // Effect before any external call.

        (uint256 merchantId, uint256 usdAmount8, bytes32 orderId, address refundTo) =
            abi.decode(message.data, (uint256, uint256, bytes32, address));

        address token = message.destTokenAmounts[0].token;
        uint256 delivered = message.destTokenAmounts[0].amount;
        // A zero refundTo would burn the fallback credit, so fall back to the source sender —
        // which is a contract we allowlisted, i.e. one we know can be made whole off-chain.
        if (refundTo == address(0)) refundTo = sender;

        _settleOrCredit(message.messageId, message.sourceChainSelector, merchantId, usdAmount8, orderId, token, delivered, refundTo);
    }

    /// @dev Try to settle through the router; on any refusal, credit the full delivered amount.
    ///      Split out of {ccipReceive} purely to keep the stack under the EVM's 16-slot limit.
    function _settleOrCredit(
        bytes32 messageId,
        uint64 srcChainSelector,
        uint256 merchantId,
        uint256 usdAmount8,
        bytes32 orderId,
        address token,
        uint256 delivered,
        address refundTo
    ) private {
        // Price the USD amount at DESTINATION time. `quote` is a view; a stale/removed feed makes it
        // revert, which is a router refusal like any other — caught, not propagated.
        uint256 gross;
        try i_router.quote(merchantId, token, usdAmount8) returns (uint256 q) {
            gross = q;
        } catch {
            _credit(messageId, refundTo, token, delivered, "ROUTER_REFUSED");
            return;
        }

        // Short delivery: the price moved in flight, or the token takes a transfer fee. Settling a
        // partial amount would under-pay the merchant against a receipt claiming the full USD
        // price, so we do not settle at all — the buyer's money stays whole and claimable.
        if (delivered < gross) {
            _credit(messageId, refundTo, token, delivered, "SHORT_AMOUNT");
            return;
        }

        // Approve exactly `gross`, never the balance: an approval larger than the settlement would
        // let a compromised router drain the surplus other messages are holding for their payees.
        IERC20(token).forceApprove(address(i_router), gross);
        try i_router.payToken(merchantId, token, usdAmount8, orderId) {
            uint256 surplus = delivered - gross;
            if (surplus != 0) _credit(messageId, refundTo, token, surplus, "SURPLUS");
            emit CrossChainPaymentSettled(messageId, srcChainSelector, merchantId, token, gross, surplus);
        } catch {
            // Merchant inactive, token de-allowlisted, router paused: not the buyer's fault and not
            // ours to resolve on-chain. Clear the dangling approval before crediting so a later
            // router compromise cannot spend it.
            IERC20(token).forceApprove(address(i_router), 0);
            _credit(messageId, refundTo, token, delivered, "ROUTER_REFUSED");
        }
    }

    /// @dev Record an amount as claimable. Never transfers — that is {claim}'s job, so a payee that
    ///      cannot receive a push can never block delivery.
    function _credit(bytes32 messageId, address to, address token, uint256 amount, bytes32 reason) private {
        if (amount == 0) return;
        claimable[to][token] += amount;
        emit CrossChainPaymentCredited(messageId, to, token, amount, reason);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Claims
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice Withdraw everything owed to the caller in `token`.
    /// @dev    Full-balance only; partial claims would add accounting surface for no benefit. CEI:
    ///         the balance is zeroed before the transfer.
    /// @param token The token to withdraw.
    /// @return amount The amount paid out.
    function claim(address token) external nonReentrant returns (uint256 amount) {
        amount = claimable[msg.sender][token];
        if (amount == 0) revert Access0x1CcipReceiver__NothingToClaim();
        claimable[msg.sender][token] = 0; // Effect before interaction.
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, token, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IERC165
    /// @dev    NOT optional. CCIP probes ERC-165 to confirm a destination can receive messages
    ///         BEFORE invoking {ccipReceive} — a contract that fails this check is not treated as a
    ///         receiver, so omitting it would make deliveries fail for a reason nothing on-chain
    ///         explains. Chainlink's own `CCIPReceiver` advertises the same ids.
    ///
    ///         `type(ICcipReceiver).interfaceId` equals Chainlink's `IAny2EVMMessageReceiver` id:
    ///         both declare exactly one function with an identical signature, and an interface id is
    ///         the XOR of its selectors. This is also why {ICcipReceiver} deliberately does NOT
    ///         extend IERC165 — inheriting it would fold `supportsInterface` into the XOR and yield
    ///         a DIFFERENT id than the one CCIP looks for.
    ///
    ///         `IAny2EVMMessageReceiverV2` is intentionally NOT advertised: it is a distinct
    ///         signature this contract does not implement, and claiming it would be a lie the router
    ///         acts on.
    function supportsInterface(bytes4 interfaceId) public pure override returns (bool) {
        return interfaceId == type(ICcipReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// @notice Whether a lane is open and, if so, the sender it trusts.
    /// @param srcChainSelector The CCIP chain selector.
    /// @return open   True when the lane accepts messages.
    /// @return sender The allowlisted sender (`address(0)` when closed).
    function laneStatus(uint64 srcChainSelector) external view returns (bool open, address sender) {
        sender = allowedSenderFor[srcChainSelector];
        open = sender != address(0);
    }
}
