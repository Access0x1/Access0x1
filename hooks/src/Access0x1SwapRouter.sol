// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @title Access0x1SwapRouter
/// @notice A minimal v4 router: one exact-input swap on one pool, the input pulled from the caller,
///         the output sent to a recipient, with a minimum output and a deadline.
/// @dev A router is not a hook: it has no permission bits and any pool can
///      be swapped through it. It holds no tokens and no ETH before or after a call.
///
///      While a swap is running, `msgSender()` returns the account that called `swapExactIn`.
///      A hook's `sender` argument is this router; a hook that TRUSTS this router can ask it who
///      the user is. The value lives in transient storage and is gone when the call ends.
contract Access0x1SwapRouter is IUnlockCallback {
    using SafeERC20 for IERC20;

    error NotPoolManager();
    error DeadlinePassed(uint256 deadline, uint256 nowIs);
    error TooLittleReceived(uint256 minimum, uint256 received);
    error WrongEthAmount(uint256 sent, uint256 expected);
    error SwapInProgress();
    error NothingToSwap();

    IPoolManager public immutable poolManager;

    /// @dev address(0) outside a swap. Also the reentrancy lock: a swap cannot start while it is set.
    address private transient _swapper;

    struct Call {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        address payer;
        address recipient;
        bytes hookData;
    }

    constructor(IPoolManager _poolManager) {
        poolManager = _poolManager;
    }

    /// @notice The account whose swap is running, or address(0) when none is.
    function msgSender() external view returns (address) {
        return _swapper;
    }

    /// @notice Swaps exactly `amountIn` of the input currency for at least `minAmountOut` of the other.
    /// @param zeroForOne true sells currency0 for currency1.
    /// @param recipient who receives the output.
    /// @param deadline the last timestamp at which the swap may execute.
    /// @return amountOut what the recipient received.
    function swapExactIn(
        PoolKey calldata key,
        bool zeroForOne,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes calldata hookData,
        uint256 deadline
    ) external payable returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert DeadlinePassed(deadline, block.timestamp);
        if (amountIn == 0) revert NothingToSwap();
        if (_swapper != address(0)) revert SwapInProgress();
        // Native input must arrive with the call, exactly; an ERC-20 input must come with no ETH.
        uint256 ethExpected = (zeroForOne ? key.currency0 : key.currency1).isAddressZero() ? amountIn : 0;
        if (msg.value != ethExpected) revert WrongEthAmount(msg.value, ethExpected);

        _swapper = msg.sender;
        bytes memory result = poolManager.unlock(
            abi.encode(
                Call({
                    key: key,
                    zeroForOne: zeroForOne,
                    amountIn: amountIn,
                    payer: msg.sender,
                    recipient: recipient,
                    hookData: hookData
                })
            )
        );
        _swapper = address(0);

        amountOut = abi.decode(result, (uint256));
        // The pool does not revert when it gives little; it is this check that protects the user.
        if (amountOut < minAmountOut) revert TooLittleReceived(minAmountOut, amountOut);
    }

    /// @dev Only the PoolManager may call this. If anyone could, they could name any `payer` who
    ///      has approved this router and spend that approval.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Call memory call = abi.decode(data, (Call));

        BalanceDelta delta = poolManager.swap(
            call.key,
            SwapParams({
                zeroForOne: call.zeroForOne,
                amountSpecified: -int256(call.amountIn),
                sqrtPriceLimitX96: call.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            call.hookData
        );

        // What the swapper owes (negative) and is owed (positive), after any hook's own deltas.
        int256 owedIn = call.zeroForOne ? delta.amount0() : delta.amount1();
        int256 owedOut = call.zeroForOne ? delta.amount1() : delta.amount0();
        Currency input = call.zeroForOne ? call.key.currency0 : call.key.currency1;
        Currency output = call.zeroForOne ? call.key.currency1 : call.key.currency0;

        uint256 paid = owedIn < 0 ? uint256(-owedIn) : 0;
        if (paid != 0) _pay(input, call.payer, paid);
        // An exact-input swap can use less than it was given (a hook, or a price limit). ETH
        // that was sent and not used goes back to the payer.
        if (input.isAddressZero() && call.amountIn > paid) input.transfer(call.payer, call.amountIn - paid);

        uint256 received = owedOut > 0 ? uint256(owedOut) : 0;
        if (received != 0) poolManager.take(output, call.recipient, received);
        return abi.encode(received);
    }

    /// @dev `sync` first, for native ETH too, so the PoolManager counts only what arrives now.
    function _pay(Currency currency, address payer, uint256 amount) internal {
        poolManager.sync(currency);
        if (currency.isAddressZero()) {
            poolManager.settle{value: amount}();
        } else {
            IERC20(Currency.unwrap(currency)).safeTransferFrom(payer, address(poolManager), amount);
            poolManager.settle();
        }
    }
}
