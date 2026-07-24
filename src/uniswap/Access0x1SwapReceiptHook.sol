// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { BeforeSwapDelta } from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {
    ModifyLiquidityParams,
    SwapParams
} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @title  Access0x1SwapReceiptHook
/// @author Access0x1
/// @notice A Uniswap v4 hook that turns every swap through a hooked pool into an ATTRIBUTABLE,
///         on-chain receipt — the payout-swap leg of the Access0x1 earn→store→own story. When a
///         merchant's settled USDC is swapped into their payout token through a v4 pool carrying
///         this hook, the swapper passes `abi.encode(merchantId, orderRef)` as `hookData` and the
///         hook emits {SwapReceipt}: pool id, swapper, merchant attribution, order reference, and
///         the signed balance delta — a provable trail an indexer (or the ProvenanceRegistry
///         anchor loop) can consume, with ZERO custody and ZERO fee taken.
///
///         Scope (truth in copy): `afterSwap` is the ONLY implemented callback — the other nine
///         revert {Access0x1SwapReceiptHook__HookNotImplemented}, matching the declared
///         {REQUIRED_HOOK_FLAGS}. v4 encodes hook permissions IN THE CONTRACT ADDRESS: a live
///         deployment must be CREATE2-mined so the address carries exactly the AFTER_SWAP flag
///         (bit 6 — `Hooks.AFTER_SWAP_FLAG`). That mining is a deploy-time step; this contract is
///         built + unit-tested, and is NOT claimed deployed until a broadcast record exists.
contract Access0x1SwapReceiptHook is IHooks {
    using PoolIdLibrary for PoolKey;

    /// @notice The only hook permission this contract needs: AFTER_SWAP (bit 6 of the address).
    /// @dev    Mirrors `Hooks.AFTER_SWAP_FLAG` (1 << 6) from v4-core — the deployer mines a
    ///         CREATE2 salt until `uint160(address(hook)) & ALL_HOOK_MASK == REQUIRED_HOOK_FLAGS`.
    uint160 public constant REQUIRED_HOOK_FLAGS = uint160(1) << 6;

    /// @notice The v4 PoolManager allowed to invoke callbacks (the only caller).
    address public immutable POOL_MANAGER;

    /// @notice One attributable swap receipt. `merchantId`/`orderRef` are zero when the swapper
    ///         passed no attribution — the receipt still records the swap itself.
    /// @param  poolId     The v4 pool the swap ran through.
    /// @param  sender     The initial msg.sender of the swap (the router/swapper).
    /// @param  merchantId The Access0x1 merchant this payout swap belongs to (0 = unattributed).
    /// @param  orderRef   Caller-chosen order/settlement reference (0 = unattributed).
    /// @param  delta      The swap's signed balance delta as passed by the PoolManager.
    event SwapReceipt(
        PoolId indexed poolId,
        address indexed sender,
        uint256 indexed merchantId,
        bytes32 orderRef,
        int256 delta
    );

    error Access0x1SwapReceiptHook__ZeroPoolManager();
    error Access0x1SwapReceiptHook__NotPoolManager();
    error Access0x1SwapReceiptHook__HookNotImplemented();

    modifier onlyPoolManager() {
        if (msg.sender != POOL_MANAGER) revert Access0x1SwapReceiptHook__NotPoolManager();
        _;
    }

    /// @param poolManager The chain's canonical v4 PoolManager (env/broadcast-sourced, never hardcoded).
    constructor(address poolManager) {
        if (poolManager == address(0)) revert Access0x1SwapReceiptHook__ZeroPoolManager();
        POOL_MANAGER = poolManager;
    }

    /// @inheritdoc IHooks
    /// @notice Emits the {SwapReceipt}. `hookData` optionally carries
    ///         `abi.encode(uint256 merchantId, bytes32 orderRef)`; anything shorter attributes 0/0.
    ///         Takes no delta (returns 0) — the hook never touches funds.
    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata,
        BalanceDelta delta,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4, int128) {
        uint256 merchantId;
        bytes32 orderRef;
        if (hookData.length >= 64) {
            (merchantId, orderRef) = abi.decode(hookData, (uint256, bytes32));
        }
        emit SwapReceipt(key.toId(), sender, merchantId, orderRef, BalanceDelta.unwrap(delta));
        return (IHooks.afterSwap.selector, 0);
    }

    // ── The nine unimplemented callbacks (permissions say so; the address must too) ──

    /// @inheritdoc IHooks
    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert Access0x1SwapReceiptHook__HookNotImplemented();
    }

    /// @inheritdoc IHooks
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert Access0x1SwapReceiptHook__HookNotImplemented();
    }

    /// @inheritdoc IHooks
    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert Access0x1SwapReceiptHook__HookNotImplemented();
    }

    /// @inheritdoc IHooks
    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert Access0x1SwapReceiptHook__HookNotImplemented();
    }

    /// @inheritdoc IHooks
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert Access0x1SwapReceiptHook__HookNotImplemented();
    }

    /// @inheritdoc IHooks
    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert Access0x1SwapReceiptHook__HookNotImplemented();
    }

    /// @inheritdoc IHooks
    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        pure
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        revert Access0x1SwapReceiptHook__HookNotImplemented();
    }

    /// @inheritdoc IHooks
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert Access0x1SwapReceiptHook__HookNotImplemented();
    }

    /// @inheritdoc IHooks
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert Access0x1SwapReceiptHook__HookNotImplemented();
    }
}
