// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { ModifyLiquidityParams, SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";

import { MockUSDC } from "../test/mocks/MockUSDC.sol";

/// @dev Canonical v4-periphery PoolSwapTest surface (struct layout must mirror the deployed
///      contract's — {takeClaims, settleUsingBurn}).
struct TestSettings {
    bool takeClaims;
    bool settleUsingBurn;
}

interface IPoolSwapTest {
    function swap(
        PoolKey memory key,
        SwapParams memory params,
        TestSettings memory testSettings,
        bytes memory hookData
    ) external payable returns (BalanceDelta);
}

interface IPoolModifyLiquidityTest {
    function modifyLiquidity(
        PoolKey memory key,
        ModifyLiquidityParams memory params,
        bytes memory hookData
    ) external payable returns (BalanceDelta);
}

/// @title  LiveFireSwapReceipt
/// @author Access0x1
/// @notice THE LIVE-FIRE PROOF for {Access0x1SwapReceiptHook}: on a real chain (Ethereum
///         Sepolia), initialize a fresh v4 pool that carries the deployed hook, seed it with
///         minimal liquidity, and run ONE swap whose `hookData` carries a merchant attribution —
///         so the hook's `afterSwap` emits a {SwapReceipt} event in a public, explorer-linkable
///         transaction. That event is the difference between "a hook exists" and "the hook
///         works, on-chain, attributably".
///
///         Everything here is test-scale and self-contained: two fresh {MockUSDC} tokens are
///         deployed and minted to the broadcaster (no real assets touched), liquidity is dust
///         (L = 1e18 over ±600 ticks ≈ 0.03 raw units a side), the swap is 1.0 mock-USDC
///         exact-in. The canonical Sepolia v4 PoolManager and the v4-periphery test routers are
///         the defaults, all four verified on-chain 2026-08-17 (codesize + the hook's own
///         `POOL_MANAGER()` readback matching the canonical manager).
///
///         Usage (simulate first, then owner broadcasts — see funding/uniswap handoff 11):
///           forge script script/LiveFireSwapReceipt.s.sol \
///             --rpc-url $SEPOLIA_RPC --sender $DEPLOYER [-vv]            # simulation
///           ... --account $DEPLOYER_ACCOUNT --broadcast --slow           # the live fire
contract LiveFireSwapReceipt is Script {
    using PoolIdLibrary for PoolKey;

    /// @notice Canonical Sepolia v4 PoolManager (docs + on-chain verified; the deployed hook's
    ///         immutable `POOL_MANAGER()` returns exactly this address).
    address internal constant DEFAULT_POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    /// @notice Canonical Sepolia v4-periphery PoolSwapTest router.
    address internal constant DEFAULT_SWAP_TEST = 0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe;
    /// @notice Canonical Sepolia v4-periphery PoolModifyLiquidityTest router.
    address internal constant DEFAULT_LIQ_TEST = 0x0C478023803a644c94c4CE1C1e7b9A087e411B0A;
    /// @notice The mined, deployed Access0x1SwapReceiptHook (address carries AFTER_SWAP, bit 6).
    address internal constant DEFAULT_HOOK = 0x4d6cF3e12C331393880df02b53017A478A6ec040;

    /// @notice sqrtPriceX96 for a 1:1 starting price (2^96).
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    function run() external {
        address poolManager = vm.envOr("V4_POOL_MANAGER", DEFAULT_POOL_MANAGER);
        address swapTest = vm.envOr("V4_SWAP_TEST", DEFAULT_SWAP_TEST);
        address liqTest = vm.envOr("V4_LIQ_TEST", DEFAULT_LIQ_TEST);
        address hook = vm.envOr("SWAP_RECEIPT_HOOK", DEFAULT_HOOK);
        uint256 merchantId = vm.envOr("MERCHANT_ID", uint256(1));
        bytes32 orderRef = vm.envOr("ORDER_REF", bytes32("A0X1-LIVEFIRE-1"));

        vm.startBroadcast();

        // 1. Two fresh test tokens, minted to the broadcaster, approved to both routers.
        MockUSDC tokenA = new MockUSDC();
        MockUSDC tokenB = new MockUSDC();
        (MockUSDC t0, MockUSDC t1) =
            address(tokenA) < address(tokenB) ? (tokenA, tokenB) : (tokenB, tokenA);
        t0.mint(msg.sender, 1e20);
        t1.mint(msg.sender, 1e20);
        t0.approve(swapTest, type(uint256).max);
        t1.approve(swapTest, type(uint256).max);
        t0.approve(liqTest, type(uint256).max);
        t1.approve(liqTest, type(uint256).max);

        // 2. The hooked pool: fee 0.30%, tick spacing 60, hooks = the deployed receipt hook.
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(t0)),
            currency1: Currency.wrap(address(t1)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(hook)
        });
        IPoolManager(poolManager).initialize(key, SQRT_PRICE_1_1);

        // 3. Dust liquidity around the current price so the swap has something to trade against.
        IPoolModifyLiquidityTest(liqTest)
            .modifyLiquidity(
                key,
                ModifyLiquidityParams({
                tickLower: -600, tickUpper: 600, liquidityDelta: 1e18, salt: 0
            }),
                ""
            );

        // 4. THE LIVE FIRE: 1.0 mock-USDC exact-in, hookData = the merchant attribution. The
        //    PoolManager calls the hook's afterSwap, which emits SwapReceipt(poolId, sender,
        //    merchantId, orderRef, delta) into this transaction's logs.
        IPoolSwapTest(swapTest)
            .swap(
                key,
                SwapParams({
                zeroForOne: true,
                amountSpecified: -1_000_000, // exact-in 1.0 (6-dec mock)
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
                TestSettings({ takeClaims: false, settleUsingBurn: false }),
                abi.encode(merchantId, orderRef)
            );

        vm.stopBroadcast();

        console2.log("pool token0        :", address(t0));
        console2.log("pool token1        :", address(t1));
        console2.log("hook (attached)    :", hook);
        console2.log("merchantId         :", merchantId);
        console2.log("poolId:");
        console2.logBytes32(PoolId.unwrap(key.toId()));
        console2.log("SwapReceipt should be in the swap tx's logs (topic0 = keccak of the event).");
    }
}
