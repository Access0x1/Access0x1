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
    EIP712Upgradeable
} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {
    ReentrancyGuardTransient
} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { Access0x1Router } from "./Access0x1Router.sol";
import { IAccess0x1Escrow } from "./interfaces/IAccess0x1Escrow.sol";

/// @title  Access0x1Escrow
/// @author Access0x1
/// @notice The CONDITIONAL-SETTLEMENT leg of Access0x1 — the deposit-hold primitive the instant-push
///         {Access0x1Router} structurally cannot do. The router settles atomically (pull → split →
///         push in one tx, no hold); an escrow HOLDS a buyer's deposit until a condition resolves, then
///         either RELEASES to the seller through the router's exact fee-split or REFUNDS the buyer in
///         full. A buyer opens an escrow against a seller + a router merchant; the deposit is released
///         when the buyer {confirm}s, the deadline lapses ({claimAfterTimeout}, permissionless so funds
///         never lock), or an optional arbiter rules to release; it is refunded when the seller
///         {cancel}s or the arbiter rules to refund. A buyer may also authorize the release off-chain
///         and have a relayer submit it ({releaseWithSig}, EIP-712 + ERC-1271).
/// @dev    COMPOSES, never duplicates. This contract owns the HOLD/RESOLUTION lifecycle ONLY. It never
///         re-derives the router's fee constant: on release it reads the router's LIVE public values —
///         `platformFeeBps()` for the rate and `platformTreasury()` for the destination — and splits
///         `fee = amount * platformFeeBps / 10_000`, `net = amount - fee`, so `net + fee == amount`
///         holds exactly and the fee policy can never drift from the router's. (The router's `quote`
///         is NOT used here: an escrow holds a fixed TOKEN amount the buyer deposited, not a USD price
///         re-quoted at settle time — so the release is a pure split of the held amount, with no oracle
///         dependency and therefore nothing an oracle outage can brick.)
///
///         ZERO CUSTODY beyond the live hold. The contract's balance of an asset always equals the sum
///         of every OPEN escrow's `amount` in that asset PLUS every queued `withdrawable` balance in it
///         (conservation — funds are never created or stranded). A resolved escrow leaves ~zero held.
///
///         NEVER-BLOCKABLE payout (estate law #5). Every push — to the seller, the treasury, or the
///         buyer — uses a pull-on-failure fallback: a failed native or token send credits
///         `withdrawable[recipient][asset]` and the recipient pulls it later via {withdraw}. A hostile
///         recipient (a reverting `receive`, a blocklisted address, a USDT-style no-return token) can
///         NEVER lock an escrow or block a refund — the resolution always completes, the funds always
///         remain claimable. CEI ordering + `nonReentrant` guard every value path; SafeERC20 for tokens;
///         custom errors only; an event on every state change.
///
///         ERCs. ERC-165 {supportsInterface} advertises {IAccess0x1Escrow}. The optional signed-release
///         path uses EIP-712 (typed structured data) for the authorization digest and ERC-1271
///         (smart-account signature validation) so a deployed smart-account buyer can authorize a
///         release as well as an EOA.
///
///         UPGRADEABILITY (the Access0x1 UUPS TEMPLATE — every system contract follows this exact
///         shape): the contract is deployed behind an `ERC1967Proxy`; storage lives in the proxy, logic
///         in this implementation. State is set once via {initialize} (the constructor-replacement,
///         `initializer`-guarded); the implementation's own constructor calls `_disableInitializers()`
///         so the logic contract can never be initialized or hijacked directly. Upgrades route through
///         {upgradeToAndCall} and are authorized by {_authorizeUpgrade} (contract-`owner`-only — the
///         `Ownable2StepUpgradeable` owner / UPGRADE ADMIN, which holds NO authority over any escrow or
///         refund). Calling `renounceOwnership()` permanently freezes the implementation (no owner ⇒ no
///         authorized upgrade ⇒ immutable forever). A trailing `__gap` reserves slots for safe future
///         storage appends. `router` is plain storage set ONCE in {initialize} (an upgradeable contract
///         cannot read Solidity `immutable`s — they live in the impl bytecode, not the proxy storage).
contract Access0x1Escrow is
    IAccess0x1Escrow,
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    EIP712Upgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    /// @notice The native-asset sentinel: `address(0)` as an asset means the chain's native coin.
    address private constant NATIVE = address(0);

    /// @notice Basis-point denominator (10_000 = 100%), matching the router's fee math. The RATE
    ///         (`platformFeeBps`) and the DESTINATION (`platformTreasury`) are read LIVE from the router
    ///         — only this denominator is a shared constant, identical on both sides of the split.
    uint256 private constant FEE_DENOMINATOR = 10_000;

    /// @notice The ERC-1271 "valid signature" magic return value (`IERC1271.isValidSignature.selector`).
    bytes4 private constant ERC1271_MAGIC = IERC1271.isValidSignature.selector;

    /// @notice The EIP-712 typehash for a buyer's off-chain release authorization.
    /// @dev    keccak256("ReleaseAuthorization(uint256 escrowId)"). The escrow id is the only field —
    ///         the chain id and this contract's address are bound by the EIP-712 domain separator, so a
    ///         signature for escrow `id` on this contract/chain cannot be replayed on another id, chain,
    ///         or deployment. The escrow is terminal after release, so the same authorization can never
    ///         be replayed against the same id either.
    bytes32 public constant RELEASE_AUTHORIZATION_TYPEHASH =
        keccak256("ReleaseAuthorization(uint256 escrowId)");

    /// @notice The audited, zero-custody money spine the release leg's fee-split mirrors. Set ONCE in
    ///         {initialize} and never repointed (no setter) — `platformFeeBps()` + `platformTreasury()`
    ///         are read live from it on every release so the fee policy is the router's, never a copy.
    /// @dev    Plain storage, not `immutable`: an upgradeable contract reads state from the proxy, while
    ///         an `immutable` lives in the implementation bytecode. Effectively immutable per proxy.
    Access0x1Router public router;

    /// @notice escrowId ⇒ the escrow record.
    mapping(uint256 id => Escrow escrow) private _escrows;

    /// @notice account ⇒ asset ⇒ amount queued after a failed push. Pull-pattern: the owed party (or a
    ///         keeper on their behalf) claims via {withdraw}; a payout can never be lost or blocked.
    mapping(address account => mapping(address asset => uint256 amount)) private _withdrawable;

    /// @notice The id assigned to the next {open}. Starts at 1, so 0 is the unset/unknown sentinel.
    uint256 public nextEscrowId;

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

    /// @notice One-time initializer — the constructor-replacement for the proxy. Wires the EIP-712
    ///         domain and the admin (upgrade-admin) owner, binds the composed router, and seeds the
    ///         escrow-id counter. Guarded by `initializer`, so it runs exactly once per proxy; the
    ///         typical deploy is `new ERC1967Proxy(impl, abi.encodeCall(initialize, ...))`.
    /// @dev    Wires every base in inheritance order: Ownable + its 2-step extension, then the EIP-712
    ///         domain ("Access0x1Escrow" / "1"). `initialOwner` becomes the UPGRADE ADMIN (the
    ///         `Ownable2Step` owner); it must be non-zero (`__Ownable_init` reverts on zero). No
    ///         `__UUPSUpgradeable_init()`/`__ReentrancyGuard_init()` — in OZ 5.x those bases hold no
    ///         initializable storage. The router must be non-zero (a new router = a fresh Escrow proxy).
    /// @param initialOwner The contract owner / upgrade admin (non-zero). Holds NO authority over any
    ///                     escrow or refund; the admin surface is intentionally empty beyond ownership.
    /// @param router_      The deployed {Access0x1Router} whose live fee-split the release leg mirrors.
    function initialize(address initialOwner, Access0x1Router router_) external initializer {
        if (address(router_) == address(0)) revert Access0x1Escrow__ZeroAddress();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __EIP712_init("Access0x1Escrow", "1");
        router = router_;
        nextEscrowId = 1;
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Escrow
    function escrowOf(uint256 id) external view returns (Escrow memory) {
        return _escrows[id];
    }

    /// @inheritdoc IAccess0x1Escrow
    function withdrawable(address account, address asset) external view returns (uint256) {
        return _withdrawable[account][asset];
    }

    /// @inheritdoc IAccess0x1Escrow
    function isOpen(uint256 id) external view returns (bool) {
        return _escrows[id].state == EscrowState.OPEN;
    }

    /// @notice The EIP-712 domain separator (exposed for off-chain signers building {releaseWithSig}).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice The EIP-712 digest a buyer signs to authorize a relayer-submitted {releaseWithSig}.
    /// @param id The escrow id the authorization is bound to.
    /// @return The typed-data digest to sign (domain-bound to this contract + chain id).
    function releaseDigest(uint256 id) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(RELEASE_AUTHORIZATION_TYPEHASH, id)));
    }

    /// @notice ERC-165 introspection: advertises the escrow interface (and ERC-165 itself) so an
    ///         integrator can discover the contract's surface without an ABI probe.
    /// @param interfaceId The 4-byte interface identifier being queried.
    /// @return True iff `interfaceId` is {IAccess0x1Escrow} or {IERC165}.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IAccess0x1Escrow).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    /*//////////////////////////////////////////////////////////////
                                  OPEN
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Escrow
    /// @dev CEI + `nonReentrant`. Checks (non-zero seller, positive amount, future deadline, merchant
    ///      exists, the native/token value path) → effects (write the immutable record, bump the id) →
    ///      interaction (pull the token in and verify the balance delta, rejecting fee-on-transfer /
    ///      rebasing tokens; for native the value already arrived with the call). The merchant existence
    ///      is read live from `router.merchants(merchantId).owner` so the escrow can only target a real
    ///      fee-split tenant. The arbiter is optional (`address(0)` = none); the buyer is `msg.sender`.
    function open(
        address seller,
        uint256 merchantId,
        address asset,
        uint256 amount,
        address arbiter,
        uint64 deadline
    ) external payable nonReentrant returns (uint256 id) {
        if (seller == address(0)) revert Access0x1Escrow__ZeroAddress();
        if (amount == 0) revert Access0x1Escrow__ZeroAmount();
        if (deadline <= block.timestamp) {
            revert Access0x1Escrow__BadDeadline(deadline, block.timestamp);
        }
        if (_merchantOwner(merchantId) == address(0)) {
            revert Access0x1Escrow__Unknown(merchantId);
        }

        id = nextEscrowId++;
        _escrows[id] = Escrow({
            buyer: msg.sender,
            seller: seller,
            merchantId: merchantId,
            asset: asset,
            amount: amount,
            arbiter: arbiter,
            deadline: deadline,
            state: EscrowState.OPEN
        });

        emit EscrowOpened(id, msg.sender, seller, merchantId, asset, amount, arbiter, deadline);

        // Interaction: take custody of the deposit. Native arrives with the call (msg.value must equal
        // amount exactly); a token is pulled and verified against the balance delta (fee-on-transfer
        // reject). A token escrow must carry no value, so a stray msg.value on the token path reverts.
        if (asset == NATIVE) {
            if (msg.value != amount) revert Access0x1Escrow__ValueMismatch(amount, msg.value);
        } else {
            if (msg.value != 0) revert Access0x1Escrow__ValueMismatch(0, msg.value);
            _pullExact(asset, msg.sender, amount);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                RELEASE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Escrow
    /// @dev BUYER-only release: the buyer signs off that the condition is met. CEI + `nonReentrant`,
    ///      delegated to {_release}.
    function confirm(uint256 id) external nonReentrant {
        Escrow storage e = _requireOpen(id);
        if (msg.sender != e.buyer) revert Access0x1Escrow__NotAuthorized(id, msg.sender);
        _release(id, e, msg.sender);
    }

    /// @inheritdoc IAccess0x1Escrow
    /// @dev PERMISSIONLESS auto-release once the deadline has passed — the anti-lock guarantee: a buyer
    ///      who goes silent can never strand the seller's funds, because anyone (a keeper, the seller,
    ///      a bot) may fire the release at/after `deadline`. The deadline is checked with `>=` so a
    ///      claim exactly AT the deadline second is allowed. CEI + `nonReentrant`.
    function claimAfterTimeout(uint256 id) external nonReentrant {
        Escrow storage e = _requireOpen(id);
        if (block.timestamp < e.deadline) {
            revert Access0x1Escrow__TimeoutNotReached(id, e.deadline, block.timestamp);
        }
        _release(id, e, msg.sender);
    }

    /// @inheritdoc IAccess0x1Escrow
    /// @dev Relayed signed release: any caller submits a BUYER-signed EIP-712 authorization. The
    ///      signature is validated against the escrow's `buyer` (EOA via ECDSA, deployed smart account
    ///      via ERC-1271) over {releaseDigest}, which is domain-bound to this contract + chain id and
    ///      pins the escrow id — so the authorization cannot be replayed onto another id/chain/deploy,
    ///      and the terminal state stops a replay onto the same id. The release settlement is identical
    ///      to {confirm}. CEI + `nonReentrant`.
    function releaseWithSig(uint256 id, bytes calldata signature) external nonReentrant {
        Escrow storage e = _requireOpen(id);
        if (!_isValidSignatureNow(e.buyer, releaseDigest(id), signature)) {
            revert Access0x1Escrow__BadSignature(id);
        }
        _release(id, e, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                                REFUND
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Escrow
    /// @dev SELLER-only refund: the seller cancels the deal and returns the full deposit to the buyer.
    ///      No fee is taken on a refund. NEVER-BLOCKABLE (a failed push queues to the pull-map). CEI +
    ///      `nonReentrant`, delegated to {_refund}.
    function cancel(uint256 id) external nonReentrant {
        Escrow storage e = _requireOpen(id);
        if (msg.sender != e.seller) revert Access0x1Escrow__NotAuthorized(id, msg.sender);
        _refund(id, e, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                                ARBITRATE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Escrow
    /// @dev ARBITER-only ruling. An escrow opened with `arbiter == address(0)` has no arbiter, and no
    ///      caller can equal address(0), so this can never be invoked against an un-arbitered escrow.
    ///      `release == true` settles to the seller through the fee-split; `release == false` refunds
    ///      the buyer in full. CEI + `nonReentrant`.
    function arbitrate(uint256 id, bool release) external nonReentrant {
        Escrow storage e = _requireOpen(id);
        if (msg.sender != e.arbiter) revert Access0x1Escrow__NotAuthorized(id, msg.sender);
        if (release) {
            _release(id, e, msg.sender);
        } else {
            _refund(id, e, msg.sender);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                WITHDRAW
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1Escrow
    /// @dev Pure pull-pattern. CEI + `nonReentrant`: the credit is zeroed BEFORE the transfer, so a
    ///      re-entrant claimer finds nothing owed. A payout parked here can always be withdrawn — no
    ///      party can block it. A native withdraw uses a low-level call (so a smart-account claimant is
    ///      paid); a failed native send reverts the whole withdraw, restoring the credit (the claimant
    ///      can never zero their balance without receiving the funds).
    function withdraw(address asset) external nonReentrant {
        uint256 amount = _withdrawable[msg.sender][asset];
        if (amount == 0) revert Access0x1Escrow__NothingToWithdraw(asset);
        _withdrawable[msg.sender][asset] = 0; // effect before interaction
        emit Withdrawn(msg.sender, asset, amount);

        if (asset == NATIVE) {
            // slither-disable-next-line low-level-calls
            (bool ok,) = msg.sender.call{ value: amount }("");
            if (!ok) revert Access0x1Escrow__WithdrawFailed(msg.sender, amount);
        } else {
            IERC20(asset).safeTransfer(msg.sender, amount);
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

    /// @dev The shared release core (confirm / timeout / arbiter-release / signed-release). MIRRORS the
    ///      router's fee-split by reading its LIVE public values — never a re-derived constant: the
    ///      platform RATE is `router.platformFeeBps()` and the DESTINATION is `router.platformTreasury()`.
    ///      `fee = amount * rate / 10_000` (floored, exactly as the router floors), `net = amount - fee`,
    ///      so `net + fee == amount` holds with no rounding leak. CEI: flip to terminal RELEASED + zero
    ///      out the held amount BEFORE any push (a re-entrant resolution finds the escrow no longer OPEN
    ///      and reverts {NotOpen}); then push `fee` → treasury and `net` → seller, each via the
    ///      never-blockable {_payoutOrQueue} (a failed push queues to the pull-map, never reverts the
    ///      release). The contract is left holding ~zero of this escrow's asset.
    function _release(uint256 id, Escrow storage e, address caller) private {
        address asset = e.asset;
        uint256 amount = e.amount;
        address seller = e.seller;

        // Read the router's live split policy — the rate and the treasury, never copied as constants.
        uint256 fee = Math.mulDiv(amount, router.platformFeeBps(), FEE_DENOMINATOR);
        uint256 net = amount - fee;
        address treasury = router.platformTreasury();

        // EFFECT — terminal flip before any interaction (CEI / single-settlement / reentrancy guard).
        e.state = EscrowState.RELEASED;
        emit EscrowReleased(id, caller, net, fee);

        // INTERACTIONS — push each leg; a failed push queues to the pull-map (never-blockable).
        _payoutOrQueue(treasury, asset, fee);
        _payoutOrQueue(seller, asset, net);
    }

    /// @dev The shared refund core (seller-cancel / arbiter-refund). FULL refund, NO fee. CEI: flip to
    ///      terminal REFUNDED BEFORE the push (a re-entrant resolution reverts {NotOpen}); then return
    ///      the whole `amount` to the buyer via the never-blockable {_payoutOrQueue} (a failed push
    ///      queues to the pull-map, so a hostile/blocklisted buyer can never block their own refund —
    ///      it simply becomes claimable later). The contract is left holding ~zero of this asset.
    function _refund(uint256 id, Escrow storage e, address caller) private {
        address asset = e.asset;
        uint256 amount = e.amount;
        address buyer = e.buyer;

        // EFFECT — terminal flip before any interaction (CEI / single-settlement / reentrancy guard).
        e.state = EscrowState.REFUNDED;
        emit EscrowRefunded(id, caller, amount);

        // INTERACTION — return the full deposit; a failed push queues to the pull-map (never-blockable).
        _payoutOrQueue(buyer, asset, amount);
    }

    /// @dev Push `amount` of `asset` to `to`, or queue it to the pull-map on failure — the
    ///      never-blockable payout (estate law #5). A native push uses a low-level call (so a
    ///      smart-account recipient is paid, not gas-capped); a token push uses a length-tolerant
    ///      low-level `transfer` (a USDT-style no-return-data token is a success, exactly like
    ///      SafeERC20, so it never bricks a resolution). Any genuine failure — a reverting `receive`, a
    ///      blocklisted recipient, a `false`-returning liar — credits `withdrawable[to][asset]` and the
    ///      recipient claims via {withdraw}. So every release/refund leg either pays out or queues; it
    ///      NEVER reverts the resolution.
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

    /// @dev Pull exactly `amount` of an ERC-20 in, verifying via the balance delta that the token did
    ///      not skim (fee-on-transfer / rebasing) — those are rejected so the held escrow always backs
    ///      the full `amount`. Mirrors the router's own `_pullExact` so the doctrine is identical.
    function _pullExact(address asset, address from, uint256 amount) private {
        uint256 balBefore = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(from, address(this), amount);
        uint256 received = IERC20(asset).balanceOf(address(this)) - balBefore;
        if (received != amount) revert Access0x1Escrow__FeeOnTransferToken(amount, received);
    }

    /// @dev Load an escrow and require it is OPEN (the only resolvable state). Reverts {Unknown} for an
    ///      unset id and {NotOpen} for an already-resolved one — so a double-settle is impossible.
    function _requireOpen(uint256 id) private view returns (Escrow storage e) {
        e = _escrows[id];
        EscrowState state = e.state;
        if (state == EscrowState.NONE) revert Access0x1Escrow__Unknown(id);
        if (state != EscrowState.OPEN) revert Access0x1Escrow__NotOpen(id, state);
    }

    /// @dev Read a router merchant's owner. A never-registered merchant returns `address(0)`, which is
    ///      how {open} rejects an unknown merchant (no real merchant has a zero owner).
    function _merchantOwner(uint256 merchantId) private view returns (address owner_) {
        (, owner_,,,,) = router.merchants(merchantId);
    }

    /// @dev Validate `signature` over `hash` for `signer`: ERC-1271 if the signer has code (a deployed
    ///      smart account), else ECDSA EOA recovery. `tryRecoverCalldata` (never `recover`) is used so a
    ///      malformed/garbage signature is a clean `false` rather than a revert.
    function _isValidSignatureNow(address signer, bytes32 hash, bytes calldata sig)
        private
        view
        returns (bool)
    {
        if (signer.code.length > 0) {
            (bool ok, bytes memory ret) =
                signer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (hash, sig)));
            return ok && ret.length == 32 && abi.decode(ret, (bytes4)) == ERC1271_MAGIC;
        }
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, sig);
        return err == ECDSA.RecoverError.NoError && recovered == signer && recovered != address(0);
    }
}
