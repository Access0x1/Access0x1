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
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC2981 } from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Access0x1Router } from "./Access0x1Router.sol";
import { ISplitSettler } from "./interfaces/ISplitSettler.sol";

/// @title  SplitSettler
/// @author Rensley R. @vyperpilleddev
/// @notice The REVENUE-SPLIT leg of Access0x1: one incoming USD-priced payment fans out to N configured
///         payees (seller + platform-affiliate + creator + tax + …) by basis-point shares that sum to
///         EXACTLY the gross. A merchant owner configures a split ONCE — a write-once list of
///         (payee, shareBps) legs whose shares total {TOTAL_BPS} (10_000) — and anyone pays it. Each
///         payee leg is PULL-claimable and NEVER-BLOCKABLE: the fanned-out share is credited to a
///         per-(account, asset) withdrawable map the payee claims via {withdraw}, so a hostile,
///         reverting, or blocklisted payee can never block the split for the OTHER legs (law #5).
/// @dev    COMPOSES the router, never duplicates it. Settlement is a TWO-STAGE pipe:
///
///         1. The gross is settled THROUGH {Access0x1Router} first. The split is bound to a router
///            merchant whose `payout` is THIS contract, so a {settleToken}/{settleNative} pulls the
///            router-quoted gross from the payer, hands it to `router.payToken`/`router.payNative`, and
///            the router prices USD→token in-tx, takes Access0x1's PLATFORM FEE EXACTLY ONCE (to its
///            treasury), and pushes the NET back to this contract. The platform fee is never re-derived
///            here — it is the router's own audited arithmetic, charged a single time at the router.
///
///         2. The net the router returned is fanned out among the configured payees by their shares.
///            Each leg floors `net * shareBps / TOTAL_BPS`; the LAST leg absorbs the rounding remainder,
///            so Σ(leg credits) == net EXACTLY — no dust is created or stranded. Each leg is CREDITED to
///            the pull-map (never pushed inline), so one payee can never block, re-enter, or grief the
///            split: every payee pulls their own share when they choose.
///
///         The net captured for the fan-out is the BALANCE DELTA across the router call (token: the
///         contract's ERC-20 balance rise; native: the contract's native-balance rise from the router's
///         net push into {receive}), so a token that skims or a router that changes its split can never
///         desync the fan-out from what actually arrived. A fee-on-transfer pay-in token is rejected at
///         the pull (the balance delta must equal the gross).
///
///         ZERO CUSTODY beyond the unclaimed pull-map. The contract holds, for each asset, EXACTLY the
///         sum of every unclaimed withdrawable balance in that asset (conservation — funds are never
///         created or stranded). The router holds nothing (it pushed the net straight back).
///
///         ERCs. ERC-165 {supportsInterface} advertises {ISplitSettler}, {IERC2981}, and ERC-165. The
///         ERC-2981 royalty / SHARE-SHAPE standard exposes a split's PRIMARY payee + its cut of a sale
///         price via {royaltyInfo}, so a marketplace/integrator can discover the share shape without an
///         off-chain registry. The per-payee withdrawable map IS the payout-lane surface (one claimable
///         balance per payee per asset). CEI + `nonReentrant` (`ReentrancyGuardTransient`) guard every
///         value path; `SafeERC20` for tokens; custom errors only; an event on every state change; the
///         fan-out is a BOUNDED loop ({MAX_PAYEES} cap) so it can never run out of gas.
///
///         UPGRADEABILITY (the Access0x1 UUPS TEMPLATE — every system contract follows this exact
///         shape): the contract is deployed behind an `ERC1967Proxy`; storage lives in the proxy, logic
///         in this implementation. State is set once via {initialize} (the constructor-replacement,
///         `initializer`-guarded); the implementation's own constructor calls `_disableInitializers()`
///         so the logic contract can never be initialized or hijacked directly. Upgrades route through
///         {upgradeToAndCall} and are authorized by {_authorizeUpgrade} (contract-`owner`-only — the
///         `Ownable2StepUpgradeable` owner / UPGRADE ADMIN, which holds NO authority over any split's
///         funds; the per-split authority lives with the router merchant owner, read live). Calling
///         `renounceOwnership()` permanently freezes the implementation. A trailing `__gap` reserves
///         slots for safe future storage appends. `router` is plain storage set ONCE in {initialize}
///         (an upgradeable contract cannot read Solidity `immutable`s — they live in the impl bytecode).
contract SplitSettler is
    ISplitSettler,
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    /// @notice The native-asset sentinel: `address(0)` as an asset means the chain's native coin.
    address private constant NATIVE = address(0);

    /// @notice Basis-point denominator: a split's shares sum to EXACTLY this (10_000 = 100% of the net).
    uint16 public constant TOTAL_BPS = 10_000;

    /// @notice Hard ceiling on payee legs per split — the unbounded-loop guard. The fan-out and the
    ///         create-time validation both iterate the payee set, so capping it keeps every value path's
    ///         gas bounded and DoS-free. 64 is generous for real splits (seller + platform + affiliate +
    ///         creator + tax is five) while staying well inside the block gas limit.
    uint256 public constant MAX_PAYEES = 64;

    /// @notice The audited, zero-custody money spine every settlement routes through. Set ONCE in
    ///         {initialize} and never repointed (no setter) — the platform fee + USD pricing are the
    ///         router's, taken once at the router, never copied here.
    /// @dev    Plain storage, not `immutable`: an upgradeable contract reads state from the proxy, while
    ///         an `immutable` lives in the implementation bytecode. Effectively immutable per proxy.
    Access0x1Router public router;

    /// @notice splitId ⇒ the split record (merchant binding + immutable payee legs + active flag).
    mapping(uint256 id => Split split) private _splits;

    /// @notice account ⇒ asset ⇒ amount claimable. The payout-lane surface: a fanned-out share lands
    ///         here (pull-pattern, never pushed inline), as does any payout whose redirect push failed.
    ///         The payee (or a keeper on their behalf) claims via {withdraw}; a payout is never lost.
    mapping(address account => mapping(address asset => uint256 amount)) private _withdrawable;

    /// @notice The id assigned to the next {createSplit}. Starts at 1, so 0 is the unset sentinel.
    uint256 public nextSplitId;

    /// @dev Reserved storage slots so future versions can APPEND new state without shifting the layout
    ///      above (UUPS storage-collision safety). Each new variable added in a later version consumes
    ///      one slot from the head of this gap; shrink `__gap` by exactly the number of slots added so
    ///      the total stays 50. NEVER reorder or insert a variable above this gap — only append.
    uint256[50] private __gap;

    /// @dev The implementation is the logic half of a UUPS pair; its OWN storage is never used in
    ///      production (the proxy holds state). `_disableInitializers()` burns the implementation's
    ///      initializer so it can never be initialized — and therefore never owned or upgraded —
    ///      directly, closing the classic uninitialized-implementation takeover. Runs at
    ///      implementation-deploy time.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time initializer — the constructor-replacement for the proxy. Binds the composed
    ///         router, seeds the split-id counter, and wires the admin (upgrade-admin) owner. Guarded by
    ///         `initializer`, so it runs exactly once per proxy; the typical deploy is
    ///         `new ERC1967Proxy(impl, abi.encodeCall(initialize, ...))`.
    /// @dev    Wires the access bases in inheritance order: Ownable + its 2-step extension.
    ///         `ReentrancyGuardTransient` needs no init (its flag is transient storage, EIP-1153).
    ///         `initialOwner` becomes the UPGRADE ADMIN (the `Ownable2Step` owner); it must be non-zero
    ///         (`__Ownable_init` reverts on zero). The router must be non-zero (a new router = a fresh
    ///         SplitSettler proxy).
    /// @param initialOwner The contract owner / upgrade admin (non-zero). Holds NO authority over any
    ///                     split or claim; per-split authority is the router merchant owner's, read live.
    /// @param router_      The deployed {Access0x1Router} every settlement routes its gross through.
    function initialize(address initialOwner, Access0x1Router router_) external initializer {
        if (address(router_) == address(0)) revert SplitSettler__ZeroAddress();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        router = router_;
        nextSplitId = 1;
    }

    /*//////////////////////////////////////////////////////////////
                                CREATE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc ISplitSettler
    /// @dev    `onlyMerchantOwner`: the configurer must own the router merchant the gross settles through
    ///         — read live from `router.merchants(merchantId).owner`, so tenant authorization is the
    ///         audited registry's, never a copy here. The payee set is validated EXHAUSTIVELY at write:
    ///         1..{MAX_PAYEES} legs, every `account` non-zero, `primaryIndex` in range, and Σ `shareBps`
    ///         == {TOTAL_BPS} EXACTLY (the "Σ shares == gross" floor — checked once, here, so the hot
    ///         settle path never re-validates). The legs are written ONCE and never mutated; only
    ///         `active` changes after this. The merchant's router `payout` MUST be this contract for the
    ///         net to return here — that wiring is a deploy-runbook step, not enforced on-chain (a
    ///         misconfigured payout simply sends the net elsewhere and the settle's net-delta is 0).
    function createSplit(uint256 merchantId, Payee[] calldata payees, uint16 primaryIndex)
        external
        returns (uint256 id)
    {
        // Tenant auth: caller must own this merchant. A never-registered merchant has owner == address(0),
        // which no caller can equal, so an unknown merchant is rejected by the same check.
        address merchantOwner = _merchantOwner(merchantId);
        if (msg.sender != merchantOwner) {
            revert SplitSettler__NotMerchantOwner(merchantId, msg.sender);
        }

        uint256 count = payees.length;
        if (count == 0 || count > MAX_PAYEES) {
            revert SplitSettler__BadPayeeCount(count, MAX_PAYEES);
        }
        if (primaryIndex >= count) revert SplitSettler__BadPrimaryIndex(primaryIndex, count);

        // Validate the shares sum to EXACTLY TOTAL_BPS and every payee is non-zero. The cap above bounds
        // this loop, so it can never run out of gas. `uint256` accumulator can't overflow: count is
        // capped and each shareBps is a uint16.
        uint256 sum;
        for (uint256 i = 0; i < count; ++i) {
            if (payees[i].account == address(0)) revert SplitSettler__ZeroAddress();
            sum += payees[i].shareBps;
        }
        if (sum != TOTAL_BPS) revert SplitSettler__SharesNotExact(sum, TOTAL_BPS);

        id = nextSplitId++;
        // Write the immutable split snapshot. The struct has a dynamic `payees` array, so it is built in
        // storage leg-by-leg (a `calldata[] → storage[]` copy) rather than assigned as a whole.
        Split storage s = _splits[id];
        s.merchantId = merchantId;
        s.primaryIndex = primaryIndex;
        s.active = true;
        for (uint256 i = 0; i < count; ++i) {
            s.payees.push(payees[i]);
        }
        emit SplitCreated(id, merchantId, count, primaryIndex);
    }

    /// @inheritdoc ISplitSettler
    /// @dev `onlyMerchantOwner` (read live) + must-exist. Toggling `active` gates only NEW settlements;
    ///      a paused split's already-queued claims stay withdrawable (no hostage funds).
    function setSplitActive(uint256 id, bool active) external {
        Split storage s = _splits[id];
        if (s.merchantId == 0) revert SplitSettler__SplitUnknown(id);
        address merchantOwner = _merchantOwner(s.merchantId);
        if (msg.sender != merchantOwner) {
            revert SplitSettler__NotMerchantOwner(s.merchantId, msg.sender);
        }
        s.active = active;
        emit SplitActiveSet(id, active);
    }

    /*//////////////////////////////////////////////////////////////
                                SETTLE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc ISplitSettler
    /// @dev    CEI + `nonReentrant`. Checks (active split, token path) → interaction stage 1 (pull the
    ///         router-quoted gross from the payer, rejecting fee-on-transfer via the balance delta; route
    ///         it through `router.payToken` so the platform fee is taken ONCE at the router and the net
    ///         pushed back here) → effect+interaction stage 2 (fan the net DELTA out to the payee legs as
    ///         pull-credits). The net is measured as the contract's ERC-20 balance rise across the router
    ///         call, so the fan-out always matches what actually arrived. Settlement is NOT idempotent by
    ///         a state flip (a split is a reusable payment target, like a merchant) — replay protection,
    ///         when needed, is the caller's `orderId` in the off-chain reconcile, exactly as a direct
    ///         router payment. The router quotes the same gross in-tx, so the amount pulled is what it
    ///         splits. Holds ~zero token balance for this asset beyond unclaimed credits afterwards.
    function settleToken(uint256 id, address token, uint256 usdAmount8, bytes32 orderId)
        external
        nonReentrant
    {
        Split storage s = _requireActive(id);
        if (token == NATIVE) revert SplitSettler__WrongSettlePath(id, token);
        uint256 merchantId = s.merchantId;

        // STAGE 1 — pull the gross from the payer and settle it through the router fee-split. The router
        // quotes USD→token in-tx (allowlist + feed + staleness), takes the platform fee ONCE → treasury,
        // and pushes the net back to this contract (the merchant's configured `payout`). The net is the
        // balance rise across the call, robust to any router-side change in the fee math.
        uint256 gross = router.quote(merchantId, token, usdAmount8);
        // Capture the net-measurement baseline BEFORE the pull: across pull-in (+gross) → router
        // payToken (gross out, net back) the balance nets to +net, so `net = after - balBefore` is
        // exact and never underflows (this contract is BOTH the router's payer and the merchant payout).
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        _pullExact(token, msg.sender, gross);

        IERC20(token).forceApprove(address(router), gross);
        router.payToken(merchantId, token, usdAmount8, orderId);
        // The router pulled the full approval; reset any dangling allowance to 0 defensively.
        IERC20(token).forceApprove(address(router), 0);
        uint256 net = IERC20(token).balanceOf(address(this)) - balBefore;

        // STAGE 2 — fan the returned net out to the payee legs (pull-credits, never-blockable).
        _fanOut(id, s, token, net);
        emit SplitSettled(id, msg.sender, token, gross, net, orderId);
    }

    /// @inheritdoc ISplitSettler
    /// @dev    The native mirror of {settleToken}. CEI + `nonReentrant`: quote the gross, require
    ///         `msg.value` covers it, forward EXACTLY `gross` into `router.payNative` (which takes the
    ///         platform fee once → treasury and pushes the net back into this contract's {receive}), fan
    ///         the net DELTA out to the legs, then refund the buyer's excess. The net is the contract's
    ///         native-balance rise across the router call (the excess refund is computed from `msg.value`,
    ///         not the balance, so the two never interfere). A failed excess refund DOES revert (the
    ///         buyer is present and must not silently lose it); a fanned-out leg never reverts the settle
    ///         (it queues to the pull-map).
    function settleNative(uint256 id, uint256 usdAmount8, bytes32 orderId)
        external
        payable
        nonReentrant
    {
        Split storage s = _requireActive(id);
        uint256 merchantId = s.merchantId;

        uint256 gross = router.quote(merchantId, NATIVE, usdAmount8);
        if (msg.value < gross) revert SplitSettler__Underpaid(gross, msg.value);

        // Measure the net as the native-balance rise from the router's push, ISOLATED from the unspent
        // excess still sitting in this call. `msg.value` (gross + excess) already arrived, so subtracting
        // exactly the `gross` we are about to forward gives a baseline that already includes the excess.
        // After forwarding `gross` and the router pushing `net` back, the rise above that baseline is
        // precisely `net` — the excess is in the baseline on BOTH sides and cancels, so it never inflates
        // the fan-out. (Holds for any pre-existing contract balance too: it cancels identically.)
        uint256 balBefore = address(this).balance - gross;
        router.payNative{ value: gross }(merchantId, usdAmount8, orderId);
        uint256 net = address(this).balance - balBefore;

        // STAGE 2 — fan the returned net out to the payee legs (pull-credits, never-blockable). The
        // excess earmarked for the buyer's refund below is NOT part of `net` (it cancelled in the delta),
        // so the credits can never eat into it.
        _fanOut(id, s, NATIVE, net);
        emit SplitSettled(id, msg.sender, NATIVE, gross, net, orderId);

        uint256 refund = msg.value - gross;
        if (refund > 0) {
            // slither-disable-next-line low-level-calls
            (bool ok,) = msg.sender.call{ value: refund }("");
            if (!ok) revert SplitSettler__NativeRefundFailed(msg.sender, refund);
        }
    }

    /// @notice Accept the router's native net push back into this contract (the settle stage-1 return
    ///         leg). The router settles the net to this contract's `payout` via a low-level call, so a
    ///         payable `receive` is required for the native split path to function.
    /// @dev    No logic: the value is measured by the settle path's balance delta, never trusted from a
    ///         direct send. Anyone may send native here, but unsolicited value simply sits in the
    ///         contract as un-credited surplus (it is NOT fanned out — only the per-settle delta is),
    ///         so a stray send can never mint a payee a credit or break conservation (the invariant is
    ///         balance >= Σ withdrawable, with equality on the clean path).
    receive() external payable { }

    /*//////////////////////////////////////////////////////////////
                                WITHDRAW
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc ISplitSettler
    /// @dev Pure pull-pattern. CEI + `nonReentrant`: the credit is zeroed BEFORE the transfer, so a
    ///      re-entrant claimer finds nothing owed. A native withdraw uses a low-level call (so a
    ///      smart-account claimant is paid, not gas-capped); a failed native send reverts the whole
    ///      withdraw, restoring the credit (the claimant can never zero their balance without receiving).
    function withdraw(address asset) external nonReentrant {
        uint256 amount = _withdrawable[msg.sender][asset];
        if (amount == 0) revert SplitSettler__NothingToWithdraw(asset);
        _withdrawable[msg.sender][asset] = 0; // effect before interaction
        emit Withdrawn(msg.sender, asset, amount);

        if (asset == NATIVE) {
            // slither-disable-next-line low-level-calls
            (bool ok,) = msg.sender.call{ value: amount }("");
            if (!ok) revert SplitSettler__WithdrawFailed(msg.sender, amount);
        } else {
            IERC20(asset).safeTransfer(msg.sender, amount);
        }
    }

    /// @inheritdoc ISplitSettler
    /// @dev The anti-strand escape hatch. A credited party whose OWN address can never receive (a
    ///      permanently-reverting `receive`, a blocklisted account) would see {withdraw} revert forever,
    ///      stranding the credit; {withdrawTo} sends THEIR OWN balance to a receivable address.
    ///      Authorization is structural: it ONLY reads and zeroes `_withdrawable[msg.sender][asset]`, so
    ///      no caller can move another party's credit. Same CEI + `nonReentrant` as {withdraw}.
    function withdrawTo(address asset, address to) external nonReentrant {
        if (to == address(0)) revert SplitSettler__ZeroAddress();
        uint256 amount = _withdrawable[msg.sender][asset];
        if (amount == 0) revert SplitSettler__NothingToWithdraw(asset);
        _withdrawable[msg.sender][asset] = 0; // effect before interaction
        emit WithdrawnTo(msg.sender, to, asset, amount);

        if (asset == NATIVE) {
            // slither-disable-next-line low-level-calls
            (bool ok,) = to.call{ value: amount }("");
            if (!ok) revert SplitSettler__WithdrawToFailed(to, amount);
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc ISplitSettler
    function splitOf(uint256 id) external view returns (Split memory) {
        return _splits[id];
    }

    /// @inheritdoc ISplitSettler
    function withdrawable(address account, address asset) external view returns (uint256) {
        return _withdrawable[account][asset];
    }

    /// @inheritdoc ISplitSettler
    function isActive(uint256 id) external view returns (bool) {
        return _splits[id].active;
    }

    /// @inheritdoc ISplitSettler
    function previewSplit(uint256 id, uint256 net)
        external
        view
        returns (uint256[] memory amounts)
    {
        Split storage s = _splits[id];
        uint256 count = s.payees.length;
        if (count == 0) revert SplitSettler__SplitUnknown(id);
        amounts = new uint256[](count);
        uint256 running;
        // Floor every leg except the last; the last absorbs the remainder so Σ == net exactly. This is
        // the same arithmetic {_fanOut} applies, exposed read-only for the SDK.
        for (uint256 i = 0; i < count; ++i) {
            if (i + 1 == count) {
                amounts[i] = net - running; // last leg absorbs the rounding remainder
            } else {
                uint256 leg = Math.mulDiv(net, s.payees[i].shareBps, TOTAL_BPS);
                amounts[i] = leg;
                running += leg;
            }
        }
    }

    /// @inheritdoc IERC2981
    /// @notice ERC-2981 share-shape: report a split's PRIMARY payee and its cut of `salePrice`, so a
    ///         marketplace can discover the share shape without an off-chain registry. `tokenId` is the
    ///         split id. The amount is `salePrice * primaryShareBps / TOTAL_BPS` (floored, the same per-
    ///         leg math the fan-out uses), denominated in whatever unit `salePrice` is — exactly the
    ///         ERC-2981 contract.
    /// @dev    A never-created split (empty payee set) returns `(address(0), 0)` — the ERC-2981
    ///         "no royalty" answer — rather than reverting, so a marketplace probe of an unknown id is a
    ///         clean miss, not a failure.
    /// @param tokenId   The split id whose primary share is being queried.
    /// @param salePrice The sale price to compute the primary payee's cut of.
    /// @return receiver The split's primary payee (address(0) if the split does not exist).
    /// @return royaltyAmount The primary payee's cut of `salePrice` (0 if the split does not exist).
    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        external
        view
        returns (address receiver, uint256 royaltyAmount)
    {
        Split storage s = _splits[tokenId];
        uint256 count = s.payees.length;
        if (count == 0) return (address(0), 0); // unknown split ⇒ ERC-2981 "no royalty"
        Payee storage p = s.payees[s.primaryIndex];
        receiver = p.account;
        royaltyAmount = Math.mulDiv(salePrice, p.shareBps, TOTAL_BPS);
    }

    /// @notice ERC-165 introspection: advertises the split interface, the ERC-2981 royalty / share-shape
    ///         standard, and ERC-165 itself, so an integrator can discover the contract's surface without
    ///         an ABI probe.
    /// @param interfaceId The 4-byte interface identifier being queried.
    /// @return True iff `interfaceId` is {ISplitSettler}, {IERC2981}, or {IERC165}.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(ISplitSettler).interfaceId
            || interfaceId == type(IERC2981).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @notice Authorize a UUPS upgrade. Restricted to the contract `owner` (the upgrade admin) — the
    ///         single gate {upgradeToAndCall} consults before swapping the implementation.
    /// @dev    Empty body: the `onlyOwner` modifier IS the policy. Once `renounceOwnership()` sets the
    ///         owner to address(0), every call here reverts, so the implementation becomes permanently
    ///         immutable. `newImplementation` is intentionally unnamed — no per-target allow-listing; the
    ///         owner is fully trusted to vet the target off-chain.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }

    /// @dev The fan-out core both settle paths share. Splits `net` among the split's payee legs by their
    ///      shares and CREDITS each to the pull-map (never pushes inline — that is what makes one payee
    ///      unable to block, re-enter, or grief the others). Every leg floors `net * shareBps / TOTAL_BPS`
    ///      except the LAST, which absorbs the remainder, so Σ(credits) == `net` EXACTLY (no dust created
    ///      or stranded — the "Σ shares == gross" property at the net level). The loop is bounded by
    ///      {MAX_PAYEES} (enforced at {createSplit}), so it can never run out of gas. `net == 0` (a
    ///      misconfigured merchant payout, so the router pushed nothing back) is a no-op: every leg
    ///      credits 0 and conservation is untouched.
    /// @param id    The split that settled (for the credit events).
    /// @param s     The split storage pointer (its immutable payee legs).
    /// @param asset The settled asset (address(0) = native) the credits are denominated in.
    /// @param net   The net returned by the router, to fan out.
    function _fanOut(uint256 id, Split storage s, address asset, uint256 net) private {
        uint256 count = s.payees.length;
        uint256 running;
        for (uint256 i = 0; i < count; ++i) {
            Payee storage p = s.payees[i];
            uint256 leg;
            if (i + 1 == count) {
                leg = net - running; // last leg absorbs the rounding remainder ⇒ Σ legs == net exactly
            } else {
                leg = Math.mulDiv(net, p.shareBps, TOTAL_BPS);
                running += leg;
            }
            if (leg == 0) continue; // skip a zero-share or dust-free leg (no event, no state write)
            // Effect: credit the leg to the pull-map (the payout lane). The payee claims via {withdraw};
            // a share is never pushed inline, so a reverting/blocklisted payee can never block the split.
            _withdrawable[p.account][asset] += leg;
            emit ShareCredited(id, p.account, asset, leg);
        }
    }

    /// @dev Pull exactly `amount` of an ERC-20 in, verifying via the balance delta that the token did not
    ///      skim (fee-on-transfer / rebasing) — those are rejected so the router always splits the full
    ///      gross. Mirrors the router's own `_pullExact` so the doctrine is identical at every hop.
    function _pullExact(address token, address from, uint256 amount) private {
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(from, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        if (received != amount) revert SplitSettler__FeeOnTransferToken(amount, received);
    }

    /// @dev Load a split and require it exists and is active (the only settleable state). Reverts
    ///      {SplitUnknown} for an unset id and {SplitInactive} for a paused one.
    function _requireActive(uint256 id) private view returns (Split storage s) {
        s = _splits[id];
        if (s.merchantId == 0) revert SplitSettler__SplitUnknown(id);
        if (!s.active) revert SplitSettler__SplitInactive(id);
    }

    /// @dev Read a router merchant's owner. A never-registered merchant returns `address(0)`, which is
    ///      how every owner-equality check rejects an unknown merchant (no caller is address(0)).
    function _merchantOwner(uint256 merchantId) private view returns (address owner_) {
        (, owner_,,,,) = router.merchants(merchantId);
    }
}
