// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IPaymentLanes } from "./interfaces/IPaymentLanes.sol";

/// @title  PaymentLanes
/// @author Access0x1
/// @notice A standalone ERC-6909 multi-token contract whose tokens are non-custodial RECEIPTS for
///         value an Access0x1 router has settled. A "lane" is one ERC-6909 id, deterministically
///         derived from a (chainId, asset, recipient) triple, so every (chain, token, merchant)
///         leg is a globally unique, collision-resistant id any party can recompute off-chain.
/// @dev    Custody model — NON-CUSTODIAL PULL RECEIPT. An allowlisted router calls {credit} after it
///         has finished its own settlement, transferring the net asset into this contract and minting
///         a matching lane balance to the merchant. The lane balance is fully backed: the contract's
///         ERC-20 balance for an asset always equals the sum of unclaimed lane balances for that asset
///         (conservation). The merchant — and only the merchant (or its operator/spender) — controls
///         that balance; Access0x1 holds no admin key over any lane balance. {claim} burns the balance
///         and returns the underlying with `SafeERC20`. CEI + `nonReentrant` guard every value path:
///         balances are written BEFORE any external token call, so a malicious asset that re-enters on
///         transfer finds the balance already settled.
contract PaymentLanes is IPaymentLanes, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice owner ⇒ lane id ⇒ credited-but-unclaimed balance. The whole accounting state.
    mapping(address owner => mapping(uint256 id => uint256 balance)) private _balanceOf;

    /// @notice lane id ⇒ the ERC-20 asset that backs it. Bound on the FIRST {credit} of a lane and
    ///         immutable thereafter (a lane id is `keccak256(chainId, asset, recipient)`, so a given id
    ///         deterministically maps to exactly one asset). This is the cross-asset firewall: {claim}
    ///         and {claimLane} can only ever pay out THE asset that funded the lane, never another
    ///         asset's pool. A lane with no stored asset (`address(0)`) was never credited.
    mapping(uint256 id => address asset) private _laneAsset;

    /// @notice owner ⇒ spender ⇒ lane id ⇒ allowance (ERC-6909 per-id allowance).
    mapping(address owner => mapping(address spender => mapping(uint256 id => uint256 amount)))
        private _allowance;

    /// @notice owner ⇒ operator ⇒ blanket transfer authority over ALL of owner's lanes.
    mapping(address owner => mapping(address operator => bool approved)) private _isOperator;

    /// @notice router ⇒ may call {credit}. An admin-settable allowlist, never a secret.
    mapping(address router => bool authorized) public isRouter;

    /// @param initialOwner The admin that manages the router allowlist (multisig in prod). Holds NO
    ///                     authority over any merchant's lane balance — only over {setRouter}.
    constructor(address initialOwner) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert PaymentLanes__ZeroAddress();
    }

    /*//////////////////////////////////////////////////////////////
                            ROUTER ALLOWLIST (admin)
    //////////////////////////////////////////////////////////////*/

    /// @notice Authorize or revoke a router that may call {credit}. Only the owner may call.
    /// @dev    The allowlist is public (`isRouter`) — not a secret. Revoking a compromised router
    ///         instantly stops new credits without touching any already-minted lane balance.
    /// @param router     The router address to (de)authorize (non-zero).
    /// @param authorized True to allow {credit}, false to revoke.
    function setRouter(address router, bool authorized) external onlyOwner {
        if (router == address(0)) revert PaymentLanes__ZeroAddress();
        isRouter[router] = authorized;
        emit RouterSet(router, authorized);
    }

    /*//////////////////////////////////////////////////////////////
                            ERC-6909 READ
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IPaymentLanes
    function balanceOf(address owner, uint256 id) external view returns (uint256) {
        return _balanceOf[owner][id];
    }

    /// @inheritdoc IPaymentLanes
    function allowance(address owner, address spender, uint256 id) external view returns (uint256) {
        return _allowance[owner][spender][id];
    }

    /// @inheritdoc IPaymentLanes
    function isOperator(address owner, address operator) external view returns (bool) {
        return _isOperator[owner][operator];
    }

    /*//////////////////////////////////////////////////////////////
                            ERC-6909 WRITE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IPaymentLanes
    /// @dev Moves lane tokens from the caller. CEI: both balance writes precede the event; no external
    ///      call is made, so no `nonReentrant` is needed on this pure-bookkeeping path.
    function transfer(address to, uint256 id, uint256 amount) external returns (bool) {
        _transfer(msg.sender, msg.sender, to, id, amount);
        return true;
    }

    /// @inheritdoc IPaymentLanes
    /// @dev Spends the caller's per-id allowance unless the caller is an operator for `from`. An
    ///      operator bypasses (and does not decrement) any per-id allowance, per ERC-6909.
    function transferFrom(address from, address to, uint256 id, uint256 amount)
        external
        returns (bool)
    {
        if (!_isOperator[from][msg.sender]) {
            uint256 allowed = _allowance[from][msg.sender][id];
            if (allowed != type(uint256).max) {
                if (allowed < amount) {
                    revert PaymentLanes__InsufficientAllowance(
                        from, msg.sender, id, allowed, amount
                    );
                }
                // Effect-before-interaction: decrement the allowance before moving balances.
                uint256 remaining = allowed - amount;
                _allowance[from][msg.sender][id] = remaining;
                emit Approval(from, msg.sender, id, remaining);
            }
        }
        _transfer(msg.sender, from, to, id, amount);
        return true;
    }

    /// @inheritdoc IPaymentLanes
    /// @dev ERC-6909 `approve` overwrites the prior allowance unconditionally — there is no
    ///      approve-to-zero-first race footgun as in ERC-20.
    function approve(address spender, uint256 id, uint256 amount) external returns (bool) {
        _allowance[msg.sender][spender][id] = amount;
        emit Approval(msg.sender, spender, id, amount);
        return true;
    }

    /// @inheritdoc IPaymentLanes
    function setOperator(address operator, bool approved) external returns (bool) {
        _isOperator[msg.sender][operator] = approved;
        emit OperatorSet(msg.sender, operator, approved);
        return true;
    }

    /*//////////////////////////////////////////////////////////////
                          PAYMENTLANES EXTENSIONS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IPaymentLanes
    /// @dev CEI + `nonReentrant`. Authorization is checked first, then the lane balance is minted
    ///      (effect) and the event emitted, and only THEN the net asset is pulled in from the router
    ///      with `SafeERC20.safeTransferFrom` (interaction). Pulling the asset in is what keeps the
    ///      lane fully backed: after this call the contract's balance of `asset` rises by exactly
    ///      `amount`, matching the minted lane balance (conservation invariant). A malicious asset
    ///      that re-enters on transfer is stopped by the guard; even absent the guard, CEI means the
    ///      lane balance is already committed, so no double-mint is possible.
    function credit(address recipient, address asset, uint256 amount)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (!isRouter[msg.sender]) revert PaymentLanes__Unauthorized();
        if (recipient == address(0) || asset == address(0)) revert PaymentLanes__ZeroAddress();
        if (amount == 0) revert PaymentLanes__ZeroAmount();

        id = _laneId(block.chainid, asset, recipient);
        // Effect: bind the lane id to its backing asset (idempotent — a given id always maps to the
        // same asset because the id IS keccak256(chainId, asset, recipient)) and mint the receipt
        // before the external transfer (CEI). Binding here is what lets {claim}/{claimLane} pay out
        // ONLY this asset, slamming the cross-asset drain shut.
        _laneAsset[id] = asset;
        _balanceOf[recipient][id] += amount;
        emit Transfer(msg.sender, address(0), recipient, id, amount);

        // Interaction: pull the backing asset from the router so the lane balance is fully funded.
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @inheritdoc IPaymentLanes
    /// @dev Convenience claim of the caller's own lane (`laneId(chainid, asset, caller)`).
    function claim(address asset) external nonReentrant {
        if (asset == address(0)) revert PaymentLanes__ZeroAddress();
        _claim(_laneId(block.chainid, asset, msg.sender), asset);
    }

    /// @inheritdoc IPaymentLanes
    /// @dev Claim an explicit lane id (e.g. one received via {transfer}).
    function claimLane(uint256 id, address asset) external nonReentrant {
        if (asset == address(0)) revert PaymentLanes__ZeroAddress();
        _claim(id, asset);
    }

    /// @dev CEI + `nonReentrant` (guarded by the public entrypoints). The caller's entire balance on
    ///      `id` is zeroed (effect) BEFORE the underlying is sent back (interaction), so a re-entrant
    ///      asset finds nothing left to claim — the classic CEI reentrancy defense, belt-and-
    ///      suspendered by the guard.
    /// @dev CROSS-ASSET FIREWALL. A lane releases ONLY the asset that funded it (bound at {credit} in
    ///      `_laneAsset[id]`). The claimable amount IN `asset` is the lane balance when — and only
    ///      when — `asset` is that lane's backing asset; against any OTHER asset the claimable amount
    ///      is zero. So a holder of a lane backed by a worthless coin who points `asset` at USDC claims
    ///      NOTHING: a credited lane queried for a mismatched asset is a safe no-op return that burns
    ///      no receipt and moves not a single unit of USDC — the cross-asset / cross-merchant pool
    ///      drain is unreachable. (An empty or never-funded lane still reverts {NothingToClaim}.) CEI:
    ///      the balance is zeroed (effect) before the underlying is sent back (interaction), so a
    ///      re-entrant asset finds nothing left, belt-and-suspendered by the `nonReentrant` guard on
    ///      the public entrypoints.
    /// @param id    The lane id to burn.
    /// @param asset The ERC-20 that funded `id`, returned to the caller. Must equal `_laneAsset[id]`.
    function _claim(uint256 id, address asset) private {
        address backing = _laneAsset[id];

        // Cross-asset firewall: a lane that HAS a backing asset (was credited) releases ONLY that
        // asset. If the caller points a CREDITED lane at a DIFFERENT asset, there is nothing claimable
        // in `asset` here — return a safe no-op WITHOUT burning the receipt or moving a single unit of
        // `asset` (it still backs OTHER lanes / merchants). This is what makes the cross-asset /
        // cross-merchant pool drain unreachable: the only `asset` a lane can ever pay out is the one
        // bound at {credit}. An UNCREDITED lane (`backing == address(0)`) falls through to the
        // zero-balance revert below, so an empty/never-funded lane still reports {NothingToClaim}.
        if (backing != address(0) && asset != backing) return;

        // Same-asset (or never-funded) path: the caller's full balance on `id` is claimable. An empty
        // lane (already claimed, never funded, or one the caller does not hold) reverts.
        uint256 amount = _balanceOf[msg.sender][id];
        if (amount == 0) revert PaymentLanes__NothingToClaim(msg.sender, asset);

        // Effect: burn the full receipt before returning the underlying (CEI).
        _balanceOf[msg.sender][id] = 0;
        emit Transfer(msg.sender, msg.sender, address(0), id, amount);

        // Interaction: return the backing asset to the claimant.
        IERC20(asset).safeTransfer(msg.sender, amount);
    }

    /// @inheritdoc IPaymentLanes
    function laneId(uint256 chainId_, address asset, address recipient)
        external
        pure
        returns (uint256)
    {
        return _laneId(chainId_, asset, recipient);
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev The shared balance mover for {transfer}/{transferFrom}. Reverts on a zero recipient or an
    ///      over-spend; writes both legs (effects) before emitting (CEI). No external call here.
    /// @param caller The address that initiated the move (logged in the event).
    /// @param from   The source holder.
    /// @param to     The recipient (non-zero).
    /// @param id     The lane id.
    /// @param amount The amount to move.
    function _transfer(address caller, address from, address to, uint256 id, uint256 amount)
        private
    {
        if (to == address(0)) revert PaymentLanes__ZeroAddress();
        uint256 bal = _balanceOf[from][id];
        if (bal < amount) revert PaymentLanes__InsufficientBalance(from, id, bal, amount);
        unchecked {
            // bal >= amount checked above; the credit cannot overflow because the debit conserves
            // total issued for this id (a lane balance never exceeds what was credited).
            _balanceOf[from][id] = bal - amount;
            _balanceOf[to][id] += amount;
        }
        emit Transfer(caller, from, to, id, amount);
    }

    /// @dev The deterministic lane key. `keccak256(abi.encode(chainId, asset, recipient))` over the
    ///      full uint256/address/address triple — `abi.encode` (not `encodePacked`) so each leg sits
    ///      in its own 32-byte word and no two distinct triples can collide via boundary aliasing.
    ///      Pure — no SLOAD — so off-chain callers recompute lane ids for free.
    /// @param chainId_  The chain id leg.
    /// @param asset     The ERC-20 leg.
    /// @param recipient The recipient leg.
    /// @return The lane id.
    function _laneId(uint256 chainId_, address asset, address recipient)
        private
        pure
        returns (uint256)
    {
        return uint256(keccak256(abi.encode(chainId_, asset, recipient)));
    }
}
