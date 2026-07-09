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
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Access0x1Router } from "./Access0x1Router.sol";
import { IAccess0x1Rebates } from "./interfaces/IAccess0x1Rebates.sol";

/// @title  Access0x1Rebates
/// @author Access0x1
/// @notice The CONDITIONAL-REBATE leg of Access0x1: a merchant pre-funds a promotional pool, and a
///         buyer who settles a qualifying USD-priced payment through the router gets an instant
///         rebate FROM that pool in the SAME transaction. The mail-in rebate, with the mail — and the
///         "breakage" business model — removed: the release condition is a pure function of chain
///         state plus the settlement call itself (window by the chain clock, qualifying amount from
///         the call's own argument, pool balance, order-id idempotency). No receipt upload, no
///         processor, no oracle, no trusted human anywhere on the path.
/// @dev    BE-THE-CALLER, not the listener: a contract cannot read event logs, so the rebate does not
///         "watch for" the router's {PaymentReceived} — it IS the caller that produces it.
///         {payWithRebate} pulls the router-quoted gross from the buyer, settles it through
///         {Access0x1Router.payToken} (USD pricing, allowlist, staleness guard, and the platform fee
///         are the router's own audited arithmetic, applied exactly ONCE at the router), and then —
///         inside the same transaction — pays the buyer's rebate from the merchant's pre-funded pool.
///         Atomicity is the anti-fraud: if the settlement reverts, the rebate never existed; one
///         settlement can earn at most one rebate; and a consumed `orderId` reverts the whole call
///         BEFORE any value moves, so a replay can never settle (or claim) twice.
///
///         THE POOL IS FULLY BACKED. Funding is pulled exactly (fee-on-transfer tokens rejected via
///         the balance delta), rebates only ever decrement `funded` by what actually leaves (or
///         queues), and the post-window {reclaim} zeroes it. At rest the contract holds, per asset,
///         EXACTLY Σ promos' `funded` + Σ unclaimed queued rebates — the conservation invariant the
///         fuzz suite proves. The settlement itself nets to ZERO custody here: the gross is pulled in
///         and handed straight to the router (net → the merchant's payout, fee → the treasury);
///         nothing from the payment sticks to this contract.
///
///         NEVER-BLOCKABLE, both directions (law: money paths roll back, never swallow — and
///         refunds/reclaims are never blocked). A rebate whose inline push fails (a blocklisted or
///         reverting receiver) is QUEUED to a per-(account, asset) withdrawable map — the settlement
///         stands, the buyer claims later via {withdraw}/{withdrawTo}, nothing is lost and nothing
///         holds the payment hostage. And the merchant's {reclaim} touches nothing but this
///         contract's own state — no router call sits on that path, so no pause or outage can ever
///         hold the unspent pool hostage.
///
///         TENANT AUTHORITY IS THE ROUTER'S, READ LIVE. Promo configuration and reclaim authorize
///         against `router.merchants(id).owner` at call time — the audited registry, never a copy.
///         The contract `owner` (the UUPS upgrade admin) holds NO authority over any promo or pool.
///
///         UPGRADEABILITY (the Access0x1 UUPS TEMPLATE — every system contract follows this exact
///         shape): deployed behind an `ERC1967Proxy`; storage in the proxy, logic here. State is set
///         once via {initialize}; the implementation's constructor calls `_disableInitializers()` so
///         the logic contract can never be initialized or hijacked directly. Upgrades route through
///         {upgradeToAndCall}, authorized by {_authorizeUpgrade} (owner-only); `renounceOwnership()`
///         permanently freezes the implementation. A trailing `__gap` reserves slots for safe future
///         appends. `router` is plain storage set ONCE in {initialize} (an upgradeable contract
///         cannot read Solidity `immutable`s — they live in the impl bytecode).
contract Access0x1Rebates is
    IAccess0x1Rebates,
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    /// @notice The native-asset sentinel: `address(0)`. Promos are ERC-20 only in v1, so this is the
    ///         "never created" marker for {Promo.token} and the rejected pay-in for {payWithRebate}.
    address private constant NATIVE = address(0);

    /// @notice Basis-point denominator: a promo's `rebateBps` is its share of the gross out of this.
    uint16 public constant TOTAL_BPS = 10_000;

    /// @notice The audited, zero-custody money spine every settlement routes through. Set ONCE in
    ///         {initialize} and never repointed (no setter) — USD pricing, the token allowlist, and
    ///         the platform fee are the router's, taken once at the router, never copied here.
    /// @dev    Plain storage, not `immutable`: an upgradeable contract reads state from the proxy.
    Access0x1Router public router;

    /// @notice merchantId ⇒ the seat's promo (one active program per seat; see {createPromo}).
    mapping(uint256 merchantId => Promo promo) private _promos;

    /// @notice orderId ⇒ whether it already consumed a rebate — the idempotency key. Set ONLY when a
    ///         rebate actually pays (or queues), so a non-qualifying settlement never burns an id.
    mapping(bytes32 orderId => bool claimed) private _claimedOrder;

    /// @notice account ⇒ asset ⇒ queued rebate claimable via {withdraw} (the never-blockable lane:
    ///         only written when an inline rebate push failed).
    mapping(address account => mapping(address asset => uint256 amount)) private _withdrawable;

    /// @dev Reserved storage slots so future versions can APPEND new state without shifting the
    ///      layout above (UUPS storage-collision safety). Shrink by exactly the slots any later
    ///      version appends so the total stays 50. NEVER reorder or insert above this gap.
    uint256[50] private __gap;

    /// @dev The implementation is the logic half of a UUPS pair; `_disableInitializers()` burns its
    ///      initializer so the logic contract can never be initialized — and therefore never owned or
    ///      upgraded — directly. Runs at implementation-deploy time.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time initializer — the constructor-replacement for the proxy. Binds the composed
    ///         router and wires the admin (upgrade-admin) owner.
    /// @dev    `ReentrancyGuardTransient` needs no init (transient storage, EIP-1153). `initialOwner`
    ///         becomes the UPGRADE ADMIN only — it holds no authority over any promo or pool (that is
    ///         the router merchant owner's, read live). Non-zero enforced by `__Ownable_init`.
    /// @param initialOwner The contract owner / upgrade admin (non-zero).
    /// @param router_      The deployed {Access0x1Router} every settlement routes through (non-zero).
    function initialize(address initialOwner, Access0x1Router router_) external initializer {
        if (address(router_) == address(0)) revert Access0x1Rebates__ZeroAddress();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        router = router_;
    }

    /*//////////////////////////////////////////////////////////////
                                 PROMO
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Rebates
    /// @dev `onlyMerchantOwner` read LIVE from the router registry (an unknown seat has owner
    ///      `address(0)`, which no caller equals — same rejection). Terms are write-once per funded
    ///      lifecycle: creating over a pool that still holds funds reverts, so money can never sit
    ///      behind re-aimed terms — drain or {reclaim} first, then configure the next program.
    function createPromo(
        uint256 merchantId,
        address token,
        uint64 start,
        uint64 end,
        uint16 rebateBps,
        uint256 minUsd8
    ) external {
        address merchantOwner = _merchantOwner(merchantId);
        if (msg.sender != merchantOwner) {
            revert Access0x1Rebates__NotMerchantOwner(merchantId, msg.sender);
        }
        if (token == NATIVE) revert Access0x1Rebates__ZeroAddress();
        if (start >= end || end <= block.timestamp) {
            revert Access0x1Rebates__BadWindow(start, end);
        }
        if (rebateBps == 0 || rebateBps > TOTAL_BPS) {
            revert Access0x1Rebates__BadRebateBps(rebateBps);
        }
        Promo storage p = _promos[merchantId];
        if (p.funded != 0) revert Access0x1Rebates__PromoStillFunded(merchantId, p.funded);

        p.token = token;
        p.start = start;
        p.end = end;
        p.rebateBps = rebateBps;
        p.minUsd8 = minUsd8;
        // p.funded stays 0 — funding is a separate, exact-pull step ({fundPromo}).
        emit PromoCreated(merchantId, token, start, end, rebateBps, minUsd8);
    }

    /// @inheritdoc IAccess0x1Rebates
    /// @dev Open funding (anyone may top up a live promo) with an EXACT pull — the balance delta must
    ///      equal `amount` (fee-on-transfer/rebasing tokens rejected), so `funded` is always fully
    ///      backed by real balance. A closed window takes no new money (reclaim is the only exit).
    function fundPromo(uint256 merchantId, uint256 amount) external nonReentrant {
        Promo storage p = _promos[merchantId];
        if (p.token == NATIVE) revert Access0x1Rebates__NoPromo(merchantId);
        if (amount == 0) revert Access0x1Rebates__ZeroAmount();
        if (block.timestamp > p.end) revert Access0x1Rebates__PromoEnded(merchantId, p.end);

        _pullExact(p.token, msg.sender, amount);
        p.funded += amount;
        emit PromoFunded(merchantId, msg.sender, amount, p.funded);
    }

    /// @inheritdoc IAccess0x1Rebates
    /// @dev The merchant's never-blockable exit. Reads only this contract's own state and the router
    ///      REGISTRY view (for live owner auth) — the settlement path, the router's pause, a stale
    ///      feed, none of it sits between the merchant and the unspent pool. CEI: the pool is zeroed
    ///      before the transfer; a failed transfer reverts the whole call and restores it.
    function reclaim(uint256 merchantId, address to) external nonReentrant {
        if (to == address(0)) revert Access0x1Rebates__ZeroAddress();
        address merchantOwner = _merchantOwner(merchantId);
        if (msg.sender != merchantOwner) {
            revert Access0x1Rebates__NotMerchantOwner(merchantId, msg.sender);
        }
        Promo storage p = _promos[merchantId];
        if (p.token == NATIVE) revert Access0x1Rebates__NoPromo(merchantId);
        if (block.timestamp <= p.end) revert Access0x1Rebates__PromoNotEnded(merchantId, p.end);
        uint256 amount = p.funded;
        if (amount == 0) revert Access0x1Rebates__NothingToReclaim(merchantId);

        p.funded = 0; // effect before interaction
        emit PromoReclaimed(merchantId, to, p.token, amount);
        IERC20(p.token).safeTransfer(to, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                 SETTLE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Rebates
    /// @dev CEI + `nonReentrant`. Order of operations, and why each step sits where it does:
    ///      1. IDEMPOTENCY FIRST: a consumed `orderId` reverts before any value moves — a replayed
    ///         submission can never settle twice chasing a rebate that will not come.
    ///      2. SETTLE THROUGH THE ROUTER: quote (allowlist + feed + staleness, in-tx) → exact pull
    ///         from the buyer → approve the router for exactly the gross → `payToken` (the router
    ///         pulls the gross, takes the platform fee ONCE, pushes the net to the merchant's payout,
    ///         and emits {PaymentReceived} — the receipt) → reset the allowance to zero. If ANY of it
    ///         reverts, the whole call reverts: no settlement ⇒ no rebate, ever. The settlement nets
    ///         to zero custody here — nothing from the payment sticks to this contract.
    ///      3. QUALIFY, from chain state + this call's own arguments only: promo token match, chain
    ///         clock inside [start, end], `usdAmount8 >= minUsd8`, pool non-empty. No off-chain fact.
    ///      4. PAY THE REBATE from the pool, capped at what remains, to the ACTUAL payer
    ///         (`msg.sender`): effects first (mark the orderId, decrement the pool), then push — and
    ///         if the push cannot land, QUEUE it ({RebateQueued} → {withdraw}) rather than revert a
    ///         settled payment. A zero-rounded rebate is a no-op that burns nothing.
    ///      A non-qualifying call is NOT an error: the payment settles exactly as a direct router
    ///      payment would (the promo simply does not apply), and the untouched `orderId` stays usable.
    function payWithRebate(uint256 merchantId, address token, uint256 usdAmount8, bytes32 orderId)
        external
        nonReentrant
    {
        if (token == NATIVE) revert Access0x1Rebates__NativeNotSupported();
        if (_claimedOrder[orderId]) revert Access0x1Rebates__OrderAlreadyClaimed(orderId);

        // ── settle THROUGH the canonical router (set at initialize; never an arbitrary target) ──
        uint256 gross = router.quote(merchantId, token, usdAmount8);
        _pullExact(token, msg.sender, gross);
        IERC20(token).forceApprove(address(router), gross);
        router.payToken(merchantId, token, usdAmount8, orderId); // PaymentReceived emitted HERE
        IERC20(token).forceApprove(address(router), 0); // defensively drop any dangling allowance

        // ── the predicate: pure chain state + this call's own arguments. No human, no feed. ──
        Promo storage p = _promos[merchantId];
        bool qualifies = token == p.token && p.funded != 0 && block.timestamp >= p.start
            && block.timestamp <= p.end && usdAmount8 >= p.minUsd8;
        if (!qualifies) return; // settled, promo does not apply — not an error

        uint256 rebate = Math.min(Math.mulDiv(gross, p.rebateBps, TOTAL_BPS), p.funded);
        if (rebate == 0) return; // zero-rounded — nothing to pay, nothing burned

        // Effects before the push: one settlement = at most one rebate, conservation holds even if
        // the push re-enters (it cannot — nonReentrant — but the ordering stands on its own).
        _claimedOrder[orderId] = true;
        p.funded -= rebate;
        _pushOrQueue(merchantId, msg.sender, p.token, rebate, orderId);
    }

    /*//////////////////////////////////////////////////////////////
                                WITHDRAW
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Rebates
    /// @dev Pure pull-pattern; CEI + `nonReentrant`: the credit is zeroed BEFORE the transfer, so a
    ///      re-entrant claimer finds nothing owed; a failed transfer reverts and restores the credit.
    function withdraw(address asset) external nonReentrant {
        uint256 amount = _withdrawable[msg.sender][asset];
        if (amount == 0) revert Access0x1Rebates__NothingToWithdraw(asset);
        _withdrawable[msg.sender][asset] = 0; // effect before interaction
        emit Withdrawn(msg.sender, asset, amount);
        IERC20(asset).safeTransfer(msg.sender, amount);
    }

    /// @inheritdoc IAccess0x1Rebates
    /// @dev The anti-strand escape hatch (a claimant whose own address cannot receive redirects to
    ///      one that can). Authorization is structural: only `msg.sender`'s own credit moves.
    function withdrawTo(address asset, address to) external nonReentrant {
        if (to == address(0)) revert Access0x1Rebates__ZeroAddress();
        uint256 amount = _withdrawable[msg.sender][asset];
        if (amount == 0) revert Access0x1Rebates__NothingToWithdraw(asset);
        _withdrawable[msg.sender][asset] = 0; // effect before interaction
        emit WithdrawnTo(msg.sender, to, asset, amount);
        IERC20(asset).safeTransfer(to, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Rebates
    function promos(uint256 merchantId)
        external
        view
        returns (
            address token,
            uint64 start,
            uint64 end,
            uint16 rebateBps,
            uint256 minUsd8,
            uint256 funded
        )
    {
        Promo storage p = _promos[merchantId];
        return (p.token, p.start, p.end, p.rebateBps, p.minUsd8, p.funded);
    }

    /// @inheritdoc IAccess0x1Rebates
    function claimedOrder(bytes32 orderId) external view returns (bool) {
        return _claimedOrder[orderId];
    }

    /// @inheritdoc IAccess0x1Rebates
    function withdrawable(address account, address asset) external view returns (uint256) {
        return _withdrawable[account][asset];
    }

    /// @inheritdoc IAccess0x1Rebates
    function previewRebate(uint256 merchantId, address token, uint256 usdAmount8, bytes32 orderId)
        external
        view
        returns (uint256 rebate)
    {
        if (token == NATIVE || _claimedOrder[orderId]) return 0;
        Promo storage p = _promos[merchantId];
        bool qualifies = token == p.token && p.funded != 0 && block.timestamp >= p.start
            && block.timestamp <= p.end && usdAmount8 >= p.minUsd8;
        if (!qualifies) return 0;
        uint256 gross = router.quote(merchantId, token, usdAmount8);
        rebate = Math.min(Math.mulDiv(gross, p.rebateBps, TOTAL_BPS), p.funded);
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @notice Authorize a UUPS upgrade. Restricted to the contract `owner` (the upgrade admin).
    /// @dev    Empty body: the `onlyOwner` modifier IS the policy. `renounceOwnership()` makes the
    ///         implementation permanently immutable.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }

    /// @dev Push the rebate to the buyer; if the push cannot land (a reverting or blocklisted
    ///      receiver, or a token that reports failure), QUEUE it to the pull-map instead — the
    ///      settlement is never held hostage by its own reward, and the rebate is never lost. The
    ///      low-level `transfer` try/catch mirrors the never-blockable doctrine of the other legs;
    ///      a token that returns nothing (non-standard) decodes as success only when the call
    ///      succeeded, matching SafeERC20's acceptance rule.
    function _pushOrQueue(
        uint256 merchantId,
        address buyer,
        address asset,
        uint256 amount,
        bytes32 orderId
    ) private {
        // slither-disable-next-line low-level-calls
        (bool ok, bytes memory ret) = asset.call(abi.encodeCall(IERC20.transfer, (buyer, amount)));
        // SafeERC20's acceptance rule, inlined: the call succeeded, the token has code (an empty
        // account "succeeds" vacuously), and the return — if any — decodes true. Unreachable for a
        // codeless asset on this path (it settled through the router first), kept for doctrine.
        bool sent = ok && asset.code.length > 0 && (ret.length == 0 || abi.decode(ret, (bool)));
        if (sent) {
            emit RebatePaid(merchantId, buyer, asset, amount, orderId);
        } else {
            _withdrawable[buyer][asset] += amount;
            emit RebateQueued(merchantId, buyer, asset, amount, orderId);
        }
    }

    /// @dev Pull exactly `amount` of an ERC-20 in, verifying via the balance delta that the token did
    ///      not skim (fee-on-transfer / rebasing rejected). Mirrors the router's own `_pullExact` so
    ///      the doctrine is identical at every hop.
    function _pullExact(address token, address from, uint256 amount) private {
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(from, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        if (received != amount) revert Access0x1Rebates__FeeOnTransferToken(amount, received);
    }

    /// @dev Read a router merchant's owner LIVE. A never-registered merchant returns `address(0)`,
    ///      which no caller equals — the same check rejects unknown seats.
    function _merchantOwner(uint256 merchantId) private view returns (address owner_) {
        (, owner_,,,,) = router.merchants(merchantId);
    }
}
