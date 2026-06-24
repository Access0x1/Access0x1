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
    ReentrancyGuardTransient
} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { Access0x1Router } from "./Access0x1Router.sol";
import { IRefunds } from "./interfaces/IRefunds.sol";

/// @notice The EIP-3009 `receiveWithAuthorization` surface (the Circle/USDC standard) used for the
///         gasless PUSH funding leg. Declared minimally here because OpenZeppelin 5.x ships no 3009
///         interface; the selector + ABI match Circle's FiatTokenV2 exactly, so a real USDC funds a
///         refund with a single signed authorization (no allowance, no separate approval tx).
interface IERC3009Receive {
    /// @notice Receive `value` of the token from `from`, authorized by `from`'s off-chain signature. The
    ///         token verifies the signature binds `(from, to, value, validAfter, validBefore, nonce)` to
    ///         its own domain and that `to == msg.sender`, then transfers `value` from `from` to `to` and
    ///         burns the per-`from` `nonce` (replay protection lives on the token).
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title  Refunds
/// @author Access0x1
/// @notice The estate's first-class REFUND primitive — a time-boxed, merchant-authorized refund of a
///         settled payment, keyed by `orderId`. It UNIFIES the ad-hoc "rescue" pull-maps scattered
///         across the money contracts (the router's `rescue`, the escrow's `withdrawable`) into ONE
///         standalone, never-blockable refund ledger: a merchant FUNDS and AUTHORIZES a refund for an
///         `orderId` (the off-chain settled-payment id) within a claim WINDOW, the buyer CLAIMS it later
///         as a pull that no party can block, and any funds left unclaimed past the window can be
///         RECLAIMED by the merchant — so funds are never created, never stranded, and never locked.
/// @dev    SHAPE — ERC-7540 (asynchronous request → claim). {requestRefund}* is the REQUEST leg: the
///         merchant escrows the refund amount and opens a claimable position for the buyer. {claim} is
///         the CLAIM leg: the buyer redeems the claimable position to the underlying asset. The position
///         lives as an ERC-6909 RECEIPT — ONE id per REFUND POSITION
///         (`refundTokenId(merchantId, orderId) = keccak256("Access0x1Refund", merchantId, orderId)`), so
///         the buyer's `balanceOf(buyer, refundTokenId(merchantId, orderId))` IS the exact still-open amount
///         of THAT one refund — a faithful 1:1 claim ticket, never an aggregate. Keying the id on the
///         (merchantId, orderId) position (NOT on the asset) is what keeps two refunds to the same buyer in
///         the same asset on DISTINCT ids, so resolving one never disturbs the other's balance (a per-asset
///         id would fungibly pool them and a burn of one would draw down the other); {claim} burns it,
///         {reclaim} burns the stale one. The
///         receipt is intentionally NON-TRANSFERABLE (a refund ticket, not a tradeable token): the
///         standard ERC-6909 write surface is omitted so a claim can only ever flow to its authorized
///         buyer. Lifecycle: `NONE → PENDING → {CLAIMED | RECLAIMED}`, the terminal pair absorbing — a
///         double-claim or a claim-after-reclaim reverts {NotPending} by the state guard itself.
///
///         FUNDING — three legs, the merchant's choice: a STANDARD allowance ({requestRefund}), an
///         EIP-2612 `permit` ({requestRefundWithPermit}, gasless allowance), or an EIP-3009
///         `receiveWithAuthorization` ({requestRefundWithAuthorization}, gasless push — USDC-native). A
///         native refund funds with `msg.value`; the two gasless legs are ERC-20-only ({GaslessNotForNative}).
///         Every funding pull is balance-delta-verified, rejecting a fee-on-transfer / rebasing token so
///         a refund position is always fully backed by the asset actually held.
///
///         COMPOSES the {Access0x1Router} for AUTHORIZATION ONLY — the merchant registry is the single
///         source of truth for "who may refund for merchant X" (`router.merchants(id).owner`), exactly
///         as the rest of the quartet authorizes. A refund takes NO FEE (it RETURNS value the buyer
///         already paid; the platform/merchant fee was already earned on the original settlement), so
///         there is no fee leg to mis-derive — the contract never splits and the buyer is made whole to
///         the wei. (The router's fee policy is therefore consulted by NOTHING on this path; the only
///         shared doctrine is the balance-delta `_pullExact` and the never-blockable `_payoutOrQueue`.)
///
///         CUSTODY — ZERO beyond the live unclaimed amount. The contract's balance of an asset always
///         equals Σ(every PENDING refund's `amount` in that asset) PLUS Σ(every queued `withdrawable` in
///         it) — the conservation invariant, the security floor. A resolved (CLAIMED/RECLAIMED) refund
///         leaves ~zero held. CEI + `nonReentrant` (`ReentrancyGuardTransient`, EIP-1153) guard every
///         value path; `SafeERC20` for tokens; custom errors only; an event on every state change.
///
///         ERCs: ERC-7540 (request→claim), EIP-3009 + EIP-2612 (gasless merchant funding), ERC-6909
///         (per-position claim ids), ERC-165 ({supportsInterface}).
///
///         UPGRADEABILITY (the Access0x1 UUPS TEMPLATE — every system contract follows this exact shape):
///         the contract is deployed behind an `ERC1967Proxy`; storage lives in the proxy, logic in this
///         implementation. State is set once via {initialize} (the constructor-replacement,
///         `initializer`-guarded); the implementation's own constructor calls `_disableInitializers()` so
///         the logic contract can never be initialized or hijacked directly. Upgrades route through
///         {upgradeToAndCall} and are authorized by {_authorizeUpgrade} (contract-`owner`-only — the
///         `Ownable2StepUpgradeable` owner / UPGRADE ADMIN, which holds NO authority over any refund).
///         Calling `renounceOwnership()` permanently freezes the implementation (no owner ⇒ no authorized
///         upgrade ⇒ immutable forever). A trailing `__gap` reserves slots for safe future appends.
///         `router` is plain storage set ONCE in {initialize} (an upgradeable contract cannot read
///         Solidity `immutable`s — they live in the impl bytecode, not the proxy storage).
contract Refunds is
    IRefunds,
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    /// @notice The native-asset sentinel: `address(0)` as an asset means the chain's native coin.
    address private constant NATIVE = address(0);

    /// @notice The audited, zero-custody money spine whose merchant registry authorizes every refund. Set
    ///         ONCE in {initialize} and never repointed (no setter) — `merchants(id).owner` is read live
    ///         on every {requestRefund}/{reclaim} so the "who may refund" source of truth is the router's,
    ///         never a copy. A refund takes no fee, so the router's fee policy is not consulted here.
    /// @dev    Plain storage, not `immutable`: an upgradeable contract reads state from the proxy, while
    ///         an `immutable` lives in the implementation bytecode. Effectively immutable per proxy.
    Access0x1Router public router;

    /// @notice refundKey ⇒ the refund record. The key is `keccak256(merchantId, orderId)`, so a refund is
    ///         uniquely addressed by its merchant + the off-chain order id and recomputable by any party.
    mapping(bytes32 refundKey => Refund refund) private _refunds;

    /// @notice owner ⇒ claim id ⇒ ERC-6909 receipt balance. The buyer's claimable-but-unclaimed refund
    ///         value for ONE position: `_balanceOf[buyer][refundTokenId(merchantId, orderId)]` is what the
    ///         buyer can still {claim} for that exact refund. Minted on {requestRefund}, burned on
    ///         {claim}/{reclaim}. The id is per (merchantId, orderId) POSITION, not per asset, so two
    ///         refunds to the same buyer in the same asset never share a balance. The ONLY 6909 state —
    ///         the receipt is non-transferable, so no allowance/operator maps exist.
    mapping(address owner => mapping(uint256 id => uint256 balance)) private _balanceOf;

    /// @notice account ⇒ asset ⇒ amount queued after a failed push. Pull-pattern: the owed party (or a
    ///         keeper on their behalf) claims via {withdraw}; a payout can never be lost or blocked.
    mapping(address account => mapping(address asset => uint256 amount)) private _withdrawable;

    /// @dev Reserved storage slots so future versions can APPEND new state without shifting the layout
    ///      above (UUPS storage-collision safety). Each new variable added in a later version consumes
    ///      one slot from the head of this gap; shrink `__gap` by exactly the number of slots added so the
    ///      total stays 50. NEVER reorder or insert a variable above this gap — only append.
    uint256[50] private __gap;

    /// @dev The implementation is the logic half of a UUPS pair; its OWN storage is never used in
    ///      production (the proxy holds state). `_disableInitializers()` burns the implementation's
    ///      initializer so it can never be initialized — and therefore never owned or upgraded — directly,
    ///      closing the classic uninitialized-implementation takeover. Runs at implementation-deploy time.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time initializer — the constructor-replacement for the proxy. Binds the composed
    ///         router and the admin (upgrade-admin) owner. Guarded by `initializer`, so it runs exactly
    ///         once per proxy; the typical deploy is `new ERC1967Proxy(impl, abi.encodeCall(initialize, ...))`.
    /// @dev    Wires the access bases in inheritance order: `Ownable` + its 2-step extension.
    ///         `ReentrancyGuardTransient` needs no init (its flag is transient storage, EIP-1153).
    ///         `initialOwner` becomes the UPGRADE ADMIN (the `Ownable2Step` owner); it must be non-zero
    ///         (`__Ownable_init` reverts on zero). The router must be non-zero (a new router = a fresh
    ///         Refunds proxy). No `__UUPSUpgradeable_init()` — in OZ 5.x that base holds no init storage.
    /// @param initialOwner The contract owner / upgrade admin (non-zero). Holds NO authority over any
    ///                     refund; the admin surface is intentionally empty beyond ownership + upgrades.
    /// @param router_      The deployed {Access0x1Router} whose merchant registry authorizes refunds.
    function initialize(address initialOwner, Access0x1Router router_) external initializer {
        if (address(router_) == address(0)) revert Refunds__ZeroAddress();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        router = router_;
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IRefunds
    function refundOf(uint256 merchantId, bytes32 orderId) external view returns (Refund memory) {
        return _refunds[_refundKey(merchantId, orderId)];
    }

    /// @inheritdoc IRefunds
    /// @dev True iff the refund exists, is PENDING, and the window is still open (`block.timestamp <
    ///      deadline`). The ERC-7540 "claimable request" predicate — a pure read, no state change.
    function isClaimable(uint256 merchantId, bytes32 orderId) external view returns (bool) {
        Refund storage r = _refunds[_refundKey(merchantId, orderId)];
        return r.state == RefundState.PENDING && block.timestamp < r.deadline;
    }

    /// @inheritdoc IRefunds
    function refundTokenId(uint256 merchantId, bytes32 orderId) public pure returns (uint256 id) {
        // One id per (merchantId, orderId) POSITION, deterministic + recomputable off-chain. Keying on the
        // position — not the asset — makes the receipt a faithful 1:1 ticket: two refunds to the same buyer
        // in the same asset get DISTINCT ids, so resolving one never disturbs the other's balance. The
        // "Access0x1Refund" tag namespaces these receipt ids against another estate contract's 6909 id space.
        return uint256(keccak256(abi.encodePacked("Access0x1Refund", merchantId, orderId)));
    }

    /// @inheritdoc IRefunds
    function withdrawable(address account, address asset) external view returns (uint256) {
        return _withdrawable[account][asset];
    }

    /// @inheritdoc IRefunds
    function balanceOf(address owner, uint256 id) external view returns (uint256) {
        return _balanceOf[owner][id];
    }

    /// @notice ERC-165 introspection: advertises the refund interface (and ERC-165 itself) so an
    ///         integrator can discover the contract's surface without an ABI probe.
    /// @param interfaceId The 4-byte interface identifier being queried.
    /// @return True iff `interfaceId` is {IRefunds} or {IERC165}.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IRefunds).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /*//////////////////////////////////////////////////////////////
                            REQUEST (ERC-7540 request leg)
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IRefunds
    /// @dev STANDARD-allowance funding. CEI + `nonReentrant`. The shared {_request} writes the record +
    ///      mints the receipt (effects) BEFORE the funding pull; for native, `msg.value` IS the funding
    ///      and must equal `amount`; for a token, `amount` is pulled from the merchant owner over a
    ///      pre-set allowance and balance-delta-verified. A token request must carry no value.
    function requestRefund(
        uint256 merchantId,
        bytes32 orderId,
        address buyer,
        address asset,
        uint256 amount,
        uint64 deadline
    ) external payable nonReentrant {
        address funder = _request(merchantId, orderId, buyer, asset, amount, deadline);
        if (asset == NATIVE) {
            if (msg.value != amount) revert Refunds__ValueMismatch(amount, msg.value);
        } else {
            if (msg.value != 0) revert Refunds__ValueMismatch(0, msg.value);
            _pullExact(asset, funder, amount); // funder == the merchant owner (msg.sender)
        }
    }

    /// @inheritdoc IRefunds
    /// @dev EIP-2612 gasless-allowance funding (ERC-20 only). CEI + `nonReentrant`. The permit grants
    ///      THIS contract `amount` from the merchant owner; it is submitted in a `try/catch` so a
    ///      front-run permit (already consumed by an attacker griefing the nonce) does not brick the
    ///      refund — the subsequent `_pullExact` still succeeds against the allowance the permit set
    ///      (OZ's own recommended pattern). Effects (record + receipt) precede the funding pull (CEI).
    function requestRefundWithPermit(
        uint256 merchantId,
        bytes32 orderId,
        address buyer,
        address asset,
        uint256 amount,
        uint64 deadline,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (asset == NATIVE) revert Refunds__GaslessNotForNative();
        address funder = _request(merchantId, orderId, buyer, asset, amount, deadline);
        // Tolerate a front-run permit: if it already set the allowance (or someone replayed the nonce),
        // the catch swallows the revert and `_pullExact` enforces the real funding below.
        // slither-disable-next-line unused-return
        try IERC20Permit(asset).permit(funder, address(this), amount, permitDeadline, v, r, s) { }
            catch { }
        _pullExact(asset, funder, amount);
    }

    /// @inheritdoc IRefunds
    /// @dev EIP-3009 gasless-PUSH funding (ERC-20 only, USDC-native). CEI + `nonReentrant`. The signed
    ///      authorization moves `amount` straight from `auth.from` into THIS contract (the token pins
    ///      `to == msg.sender == address(this)` and verifies the signature), so no allowance is involved.
    ///      `auth.from` must be the merchant owner (the authorizer of the refund), and the realized
    ///      balance delta must equal `amount` (fee-on-transfer reject). Effects precede the pull (CEI).
    function requestRefundWithAuthorization(
        uint256 merchantId,
        bytes32 orderId,
        address buyer,
        address asset,
        uint256 amount,
        uint64 deadline,
        ReceiveAuthorization calldata auth,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (asset == NATIVE) revert Refunds__GaslessNotForNative();
        // The authorization's funder is `auth.from`; require it equals the merchant owner so the funding
        // and the authorization name the same party. `_request` re-checks `msg.sender == owner`, so the
        // submitter is the owner too (the owner both authorizes the refund and signed the 3009).
        address funder = _request(merchantId, orderId, buyer, asset, amount, deadline);
        if (auth.from != funder) revert Refunds__NotMerchantOwner(merchantId, auth.from);

        // Push exactly `amount` from `auth.from` into this contract. Balance-delta-verified so a
        // fee-on-transfer/rebasing token (an authorization whose realized receipt < value) is rejected.
        uint256 balBefore = IERC20(asset).balanceOf(address(this));
        IERC3009Receive(asset)
            .receiveWithAuthorization(
                auth.from,
                address(this),
                amount,
                auth.validAfter,
                auth.validBefore,
                auth.nonce,
                v,
                r,
                s
            );
        uint256 received = IERC20(asset).balanceOf(address(this)) - balBefore;
        if (received != amount) revert Refunds__FeeOnTransferToken(amount, received);
    }

    /*//////////////////////////////////////////////////////////////
                            CLAIM (ERC-7540 claim leg)
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IRefunds
    /// @dev BUYER-only claim within the window. CEI + `nonReentrant`: flip to terminal CLAIMED + burn the
    ///      receipt (effects) BEFORE the push (a re-entrant claim finds the refund no longer PENDING and
    ///      reverts {NotPending}); then pay the buyer via the never-blockable {_payoutOrQueue} (a failed
    ///      push queues to the pull-map, never reverts the claim). The contract is left holding ~zero of
    ///      this refund's asset.
    function claim(uint256 merchantId, bytes32 orderId) external nonReentrant {
        bytes32 key = _refundKey(merchantId, orderId);
        Refund storage r = _requirePending(key, merchantId, orderId);
        if (msg.sender != r.buyer) {
            revert Refunds__NotBuyer(merchantId, orderId, msg.sender);
        }
        if (block.timestamp >= r.deadline) {
            revert Refunds__ClaimWindowClosed(merchantId, orderId, r.deadline);
        }

        address asset = r.asset;
        uint256 amount = r.amount;
        address buyer = r.buyer;

        // EFFECTS — terminal flip + receipt burn before any interaction (CEI / single-settlement guard).
        r.state = RefundState.CLAIMED;
        _burnReceipt(buyer, merchantId, orderId, amount);
        emit RefundClaimed(merchantId, orderId, buyer, asset, amount);

        // INTERACTION — pay the buyer; a failed push queues to the pull-map (never-blockable).
        _payoutOrQueue(buyer, asset, amount);
    }

    /// @inheritdoc IRefunds
    /// @dev MERCHANT-OWNER-only reclaim once the window has lapsed (the time-box escape). CEI +
    ///      `nonReentrant`: flip to terminal RECLAIMED + burn the buyer's stale receipt (effects) BEFORE
    ///      the push; then return the funds to `to` via the never-blockable {_payoutOrQueue}. A buyer who
    ///      never claims can never permanently lock the merchant's funds — but only AFTER the deadline,
    ///      so the buyer's claim window is sacrosanct until it closes.
    function reclaim(uint256 merchantId, bytes32 orderId, address to) external nonReentrant {
        if (to == address(0)) revert Refunds__ZeroAddress();
        bytes32 key = _refundKey(merchantId, orderId);
        Refund storage r = _requirePending(key, merchantId, orderId);
        if (msg.sender != _merchantOwner(merchantId)) {
            revert Refunds__NotMerchantOwner(merchantId, msg.sender);
        }
        if (block.timestamp < r.deadline) {
            revert Refunds__WindowNotClosed(merchantId, orderId, r.deadline);
        }

        address asset = r.asset;
        uint256 amount = r.amount;
        address buyer = r.buyer;

        // EFFECTS — terminal flip + burn the buyer's now-stale receipt before any interaction (CEI).
        r.state = RefundState.RECLAIMED;
        _burnReceipt(buyer, merchantId, orderId, amount);
        emit RefundReclaimed(merchantId, orderId, to, asset, amount);

        // INTERACTION — return the funds to the sink; a failed push queues to the pull-map.
        _payoutOrQueue(to, asset, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                WITHDRAW (pull-map)
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IRefunds
    /// @dev Pure pull-pattern. CEI + `nonReentrant`: the credit is zeroed BEFORE the transfer, so a
    ///      re-entrant claimer finds nothing owed. A payout parked here can always be withdrawn — no party
    ///      can block it. A native withdraw uses a low-level call (so a smart-account claimant is paid); a
    ///      failed native send reverts the whole withdraw, restoring the credit (the claimant can never
    ///      zero their balance without receiving the funds).
    function withdraw(address asset) external nonReentrant {
        uint256 amount = _withdrawable[msg.sender][asset];
        if (amount == 0) revert Refunds__NothingToWithdraw(asset);
        _withdrawable[msg.sender][asset] = 0; // effect before interaction
        emit Withdrawn(msg.sender, asset, amount);

        if (asset == NATIVE) {
            // slither-disable-next-line low-level-calls
            (bool ok,) = msg.sender.call{ value: amount }("");
            if (!ok) revert Refunds__WithdrawFailed(msg.sender, amount);
        } else {
            IERC20(asset).safeTransfer(msg.sender, amount);
        }
    }

    /// @inheritdoc IRefunds
    /// @dev Pull-pattern redirect — the anti-strand escape hatch. A credited party whose OWN address can
    ///      never receive (a permanently-reverting `receive`, a blocklisted account) would see {withdraw}
    ///      revert forever, permanently stranding the credit; {withdrawTo} lets that party pull THEIR OWN
    ///      balance to a receivable address. Authorization is structural: it ONLY ever reads and zeroes
    ///      `_withdrawable[msg.sender][asset]`, so no caller can move another party's credit. Same CEI +
    ///      `nonReentrant` as {withdraw}: the credit is zeroed BEFORE the send, so a re-entrant call finds
    ///      nothing owed. A failed send reverts the whole call, restoring the credit.
    function withdrawTo(address asset, address to) external nonReentrant {
        if (to == address(0)) revert Refunds__ZeroAddress();
        uint256 amount = _withdrawable[msg.sender][asset];
        if (amount == 0) revert Refunds__NothingToWithdraw(asset);
        _withdrawable[msg.sender][asset] = 0; // effect before interaction
        emit WithdrawnTo(msg.sender, to, asset, amount);

        if (asset == NATIVE) {
            // slither-disable-next-line low-level-calls
            (bool ok,) = to.call{ value: amount }("");
            if (!ok) revert Refunds__WithdrawToFailed(to, amount);
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @notice Authorize a UUPS upgrade. Restricted to the contract `owner` (the upgrade admin) — the
    ///         single gate {upgradeToAndCall} consults before swapping the implementation.
    /// @dev    Empty body: the `onlyOwner` modifier IS the policy. Once `renounceOwnership()` sets the
    ///         owner to address(0), every call here reverts, so the implementation becomes permanently
    ///         immutable (the on-chain "freeze"). `newImplementation` is intentionally unnamed — no
    ///         per-target allow-listing; the owner is fully trusted to vet the target off-chain.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }

    /// @dev The shared REQUEST core (all three funding legs). Validates inputs, authorizes the caller as
    ///      the merchant owner (the single source of truth, read live from the router), enforces the
    ///      one-refund-per-order-id uniqueness, writes the immutable record, and MINTS the buyer's
    ///      ERC-6909 claim receipt — all EFFECTS, completed before any funding interaction by the caller.
    ///      Returns the funder (the merchant owner) the caller then funds the refund from.
    /// @return funder The merchant owner (`msg.sender`) — the party that funds the refund.
    function _request(
        uint256 merchantId,
        bytes32 orderId,
        address buyer,
        address asset,
        uint256 amount,
        uint64 deadline
    ) private returns (address funder) {
        if (buyer == address(0)) revert Refunds__ZeroAddress();
        if (amount == 0) revert Refunds__ZeroAmount();
        if (deadline <= block.timestamp) revert Refunds__BadDeadline(deadline, block.timestamp);

        // Authorize against the router's registry: the caller must own this merchant. A never-registered
        // merchant has owner == address(0), which no caller can equal, so an unknown merchant is rejected
        // by the same check (msg.sender can never be the zero address).
        funder = _merchantOwner(merchantId);
        if (msg.sender != funder) revert Refunds__NotMerchantOwner(merchantId, msg.sender);

        bytes32 key = _refundKey(merchantId, orderId);
        if (_refunds[key].state != RefundState.NONE) {
            revert Refunds__AlreadyRequested(merchantId, orderId);
        }

        _refunds[key] = Refund({
            merchantId: merchantId,
            buyer: buyer,
            asset: asset,
            amount: amount,
            deadline: deadline,
            state: RefundState.PENDING
        });

        // Mint the buyer's ERC-6909 claim receipt (the ERC-7540 claimable position). The id is per
        // (merchantId, orderId) position, so this mint always lands on a virgin id (the uniqueness guard
        // above proved the position is fresh) — the receipt is a faithful 1:1 ticket for THIS refund.
        uint256 id = refundTokenId(merchantId, orderId);
        _balanceOf[buyer][id] += amount;
        emit Transfer(msg.sender, address(0), buyer, id, amount);

        emit RefundRequested(merchantId, orderId, buyer, asset, amount, deadline, id);
    }

    /// @dev Burn `amount` of the buyer's refund receipt for the (merchantId, orderId) position (a {claim}
    ///      or {reclaim}). The amount always equals the receipt minted at request — the per-position id is
    ///      unique, non-transferable, and never partially spent — so this can never underflow on a valid
    ///      resolution and a burn of one refund never touches any other refund's balance.
    function _burnReceipt(address buyer, uint256 merchantId, bytes32 orderId, uint256 amount)
        private
    {
        uint256 id = refundTokenId(merchantId, orderId);
        _balanceOf[buyer][id] -= amount;
        emit Transfer(msg.sender, buyer, address(0), id, amount);
    }

    /// @dev Push `amount` of `asset` to `to`, or queue it to the pull-map on failure — the
    ///      never-blockable payout. A native push uses a low-level call (so a smart-account recipient is
    ///      paid, not gas-capped); a token push uses a length-tolerant low-level `transfer` (a USDT-style
    ///      no-return-data token is a success, exactly like SafeERC20, so it never bricks a resolution).
    ///      Any genuine failure — a reverting `receive`, a blocklisted recipient, a `false`-returning liar
    ///      — credits `withdrawable[to][asset]` and the recipient claims via {withdraw}. So every
    ///      claim/reclaim either pays out or queues; it NEVER reverts the resolution.
    // slither-disable-next-line low-level-calls,reentrancy-events
    function _payoutOrQueue(address to, address asset, uint256 amount) private {
        if (amount == 0) return;
        bool ok;
        if (asset == NATIVE) {
            // slither-disable-next-line low-level-calls,arbitrary-send-eth
            (ok,) = to.call{ value: amount }("");
        } else {
            // Length-tolerant, like SafeERC20: empty return-data is a success (USDT), a 32-byte `true`
            // is a success, and only a genuine revert or a `false`-returning liar queues to the pull-map.
            // slither-disable-next-line low-level-calls
            (bool callOk, bytes memory ret) =
                asset.call(abi.encodeCall(IERC20.transfer, (to, amount)));
            ok = callOk && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
        }
        if (!ok) {
            _withdrawable[to][asset] += amount;
            emit PayoutQueued(to, asset, amount);
        }
    }

    /// @dev Pull exactly `amount` of an ERC-20 in, verifying via the balance delta that the token did not
    ///      skim (fee-on-transfer / rebasing) — those are rejected so the held refund always backs the
    ///      full `amount`. Mirrors the router's own `_pullExact` so the doctrine is identical.
    function _pullExact(address asset, address from, uint256 amount) private {
        uint256 balBefore = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(from, address(this), amount);
        uint256 received = IERC20(asset).balanceOf(address(this)) - balBefore;
        if (received != amount) revert Refunds__FeeOnTransferToken(amount, received);
    }

    /// @dev Load a refund and require it is PENDING (the only resolvable state). Reverts {Unknown} for an
    ///      unset key and {NotPending} for an already-resolved one — so a double-claim/reclaim is
    ///      impossible.
    function _requirePending(bytes32 key, uint256 merchantId, bytes32 orderId)
        private
        view
        returns (Refund storage r)
    {
        r = _refunds[key];
        RefundState state = r.state;
        if (state == RefundState.NONE) revert Refunds__Unknown(merchantId, orderId);
        if (state != RefundState.PENDING) {
            revert Refunds__NotPending(merchantId, orderId, state);
        }
    }

    /// @dev Read a router merchant's owner. A never-registered merchant returns `address(0)`, which is how
    ///      an unknown merchant is rejected by the owner-equality checks (no caller is address(0)).
    function _merchantOwner(uint256 merchantId) private view returns (address owner_) {
        (, owner_,,,,) = router.merchants(merchantId);
    }

    /// @dev The refund key: `keccak256(merchantId, orderId)`. Globally unique per merchant + order id and
    ///      recomputable by any party, so a refund is addressed by its business meaning, not a counter.
    function _refundKey(uint256 merchantId, bytes32 orderId) private pure returns (bytes32) {
        return keccak256(abi.encode(merchantId, orderId));
    }
}
