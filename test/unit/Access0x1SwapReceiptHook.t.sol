// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";

import { Access0x1SwapReceiptHook } from "../../src/uniswap/Access0x1SwapReceiptHook.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";

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
}
