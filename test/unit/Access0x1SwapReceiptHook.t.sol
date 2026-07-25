// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";

import { Access0x1SwapReceiptHook } from "../../src/uniswap/Access0x1SwapReceiptHook.sol";
import { DeploySwapReceiptHook } from "../../script/DeploySwapReceiptHook.s.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { ModifyLiquidityParams, SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @notice Unit suite for the v4 SwapReceiptHook: receipt emission + attribution decoding, the
///         only-PoolManager gate, the unimplemented-callback law, and the declared flag constant.
contract Access0x1SwapReceiptHookTest is Test {
    using PoolIdLibrary for PoolKey;

    Access0x1SwapReceiptHook internal hook;
    address internal manager;
    address internal swapper;

    event SwapReceipt(
        PoolId indexed poolId,
        address indexed sender,
        uint256 indexed merchantId,
        bytes32 orderRef,
        int256 delta
    );

    function setUp() public {
        manager = makeAddr("poolManager");
        swapper = makeAddr("swapper");
        hook = new Access0x1SwapReceiptHook(manager);
    }

    function _key() internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0x1111)),
            currency1: Currency.wrap(address(0x2222)),
            fee: 500,
            tickSpacing: 10,
            hooks: IHooks(address(0))
        });
    }

    function _params() internal pure returns (SwapParams memory) {
        return SwapParams({ zeroForOne: true, amountSpecified: -1_000_000, sqrtPriceLimitX96: 0 });
    }

    function test_Constructor_ZeroManager_Reverts() public {
        vm.expectRevert(Access0x1SwapReceiptHook.Access0x1SwapReceiptHook__ZeroPoolManager.selector);
        new Access0x1SwapReceiptHook(address(0));
    }

    function test_AfterSwap_EmitsAttributedReceipt() public {
        PoolKey memory key = _key();
        bytes memory hookData = abi.encode(uint256(42), bytes32("order-7"));
        BalanceDelta delta = BalanceDelta.wrap(-123456);

        vm.expectEmit(true, true, true, true);
        emit SwapReceipt(key.toId(), swapper, 42, bytes32("order-7"), -123456);

        vm.prank(manager);
        (bytes4 selector, int128 hookDelta) =
            hook.afterSwap(swapper, key, _params(), delta, hookData);
        assertEq(selector, IHooks.afterSwap.selector);
        assertEq(hookDelta, 0); // the hook never takes currency
    }

    function test_AfterSwap_EmptyHookData_UnattributedReceipt() public {
        PoolKey memory key = _key();
        vm.expectEmit(true, true, true, true);
        emit SwapReceipt(key.toId(), swapper, 0, bytes32(0), 0);

        vm.prank(manager);
        hook.afterSwap(swapper, key, _params(), BalanceDelta.wrap(0), "");
    }

    function test_AfterSwap_NonManager_Reverts() public {
        vm.expectRevert(Access0x1SwapReceiptHook.Access0x1SwapReceiptHook__NotPoolManager.selector);
        hook.afterSwap(swapper, _key(), _params(), BalanceDelta.wrap(0), "");
    }

    function test_UnimplementedCallbacks_Revert() public {
        vm.expectRevert(
            Access0x1SwapReceiptHook.Access0x1SwapReceiptHook__HookNotImplemented.selector
        );
        hook.beforeSwap(swapper, _key(), _params(), "");

        vm.expectRevert(
            Access0x1SwapReceiptHook.Access0x1SwapReceiptHook__HookNotImplemented.selector
        );
        hook.beforeInitialize(swapper, _key(), 0);

        vm.expectRevert(
            Access0x1SwapReceiptHook.Access0x1SwapReceiptHook__HookNotImplemented.selector
        );
        hook.beforeDonate(swapper, _key(), 0, 0, "");
    }

    function test_RequiredFlags_AfterSwapOnly() public view {
        // Mirrors Hooks.AFTER_SWAP_FLAG (1 << 6) — what the deployer mines the address for.
        assertEq(hook.REQUIRED_HOOK_FLAGS(), uint160(1) << 6);
    }

    /// @notice The six callbacks the first revert test left uncovered — all nine unimplemented
    ///         callbacks now provably revert, so a mis-flagged deployment fails loudly on every
    ///         lifecycle edge, not just the three spot-checked ones.
    function test_UnimplementedCallbacks_RevertAllRemaining() public {
        bytes4 err = Access0x1SwapReceiptHook.Access0x1SwapReceiptHook__HookNotImplemented.selector;

        vm.expectRevert(err);
        hook.afterInitialize(swapper, _key(), 0, 0);

        vm.expectRevert(err);
        hook.beforeAddLiquidity(swapper, _key(), _liquidityParams(), "");

        vm.expectRevert(err);
        hook.afterAddLiquidity(
            swapper, _key(), _liquidityParams(), BalanceDelta.wrap(0), BalanceDelta.wrap(0), ""
        );

        vm.expectRevert(err);
        hook.beforeRemoveLiquidity(swapper, _key(), _liquidityParams(), "");

        vm.expectRevert(err);
        hook.afterRemoveLiquidity(
            swapper, _key(), _liquidityParams(), BalanceDelta.wrap(0), BalanceDelta.wrap(0), ""
        );

        vm.expectRevert(err);
        hook.afterDonate(swapper, _key(), 0, 0, "");
    }

    /// @notice 63 bytes sits just under the decode threshold: the receipt still lands, attributed
    ///         0/0 — malformed hookData can never fail someone's swap.
    function test_AfterSwap_HookData63Bytes_Unattributed() public {
        PoolKey memory key = _key();
        vm.expectEmit(true, true, true, true);
        emit SwapReceipt(key.toId(), swapper, 0, bytes32(0), 0);

        vm.prank(manager);
        hook.afterSwap(swapper, key, _params(), BalanceDelta.wrap(0), new bytes(63));
    }

    /// @notice Exactly 64 bytes is the attribution boundary: both words decode.
    function test_AfterSwap_HookData64Bytes_Attributed() public {
        PoolKey memory key = _key();
        bytes memory hookData = abi.encode(uint256(7), bytes32("ref-64"));
        assertEq(hookData.length, 64);

        vm.expectEmit(true, true, true, true);
        emit SwapReceipt(key.toId(), swapper, 7, bytes32("ref-64"), 0);

        vm.prank(manager);
        hook.afterSwap(swapper, key, _params(), BalanceDelta.wrap(0), hookData);
    }

    /// @notice Over-long hookData (65+ bytes) decodes its first two words and ignores the tail —
    ///         the documented garbage-but-harmless posture, pinned so it can never regress into a
    ///         revert that fails a swap.
    function test_AfterSwap_HookDataOverlong_DecodesFirstTwoWords() public {
        PoolKey memory key = _key();
        bytes memory hookData =
            bytes.concat(abi.encode(uint256(9), bytes32("ref-long")), hex"deadbeef");
        assertEq(hookData.length, 68);

        vm.expectEmit(true, true, true, true);
        emit SwapReceipt(key.toId(), swapper, 9, bytes32("ref-long"), 0);

        vm.prank(manager);
        hook.afterSwap(swapper, key, _params(), BalanceDelta.wrap(0), hookData);
    }

    /// @notice The deploy script's miner terminates and lands on an address whose low 14 bits are
    ///         exactly AFTER_SWAP — the script and the contract can never silently diverge.
    function test_MineSalt_FindsFlaggedAddress() public {
        DeploySwapReceiptHook deployer = new DeploySwapReceiptHook();
        (, address predicted) = deployer.mineSalt(manager);
        assertEq(
            uint160(predicted) & uint160((1 << 14) - 1),
            hook.REQUIRED_HOOK_FLAGS(),
            "mined address must carry exactly the AFTER_SWAP flag"
        );
    }

    function _liquidityParams() internal pure returns (ModifyLiquidityParams memory) {
        return ModifyLiquidityParams({
            tickLower: -10, tickUpper: 10, liquidityDelta: 1_000, salt: bytes32(0)
        });
    }
}
