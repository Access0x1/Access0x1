// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {IMsgSender} from "./Access0x1ReceiptHook.sol";

/// @notice The two SessionGrant calls this hook makes (Access0x1's SessionGrant, src/SessionGrant.sol).
interface ISessionBudget {
    function ownerOf(bytes32 sessionId) external view returns (address);
    function spend(bytes32 sessionId, uint256 amount) external returns (uint256 remainingAfter);
}

/// @title Access0x1SessionBudgetHook
/// @author Access0x1
/// @notice Lets anyone cap their own swaps with an Access0x1 SessionGrant budget. The owner opens a
///         session whose DELEGATE is this hook, with a budget and an expiry; a swap that carries the
///         session id as hook data is charged against it, and a swap that would exceed it, or comes
///         after expiry or revocation, reverts. Any pool, any business.
/// @dev beforeSwap only: mask 0x80. No delta, no fee, no funds, no admin.
///
///      Units: the budget is counted in the raw units of each swap's input token, so a session should
///      be used with one input token. Only exact-input swaps can be charged: an exact-output swap's
///      input is not known before it runs, so carrying a session on one reverts.
///
///      Who may charge a session: only its owner. `sender` is a router; a router the OWNER trusts is
///      asked for its user with `msgSender()`. Without that check anyone who learned a session id
///      could burn the owner's budget.
///
///      A swap with no hook data is not touched. Hook data of any length other than 32 bytes reverts:
///      a swapper who meant to be capped must not be silently uncapped.
contract Access0x1SessionBudgetHook is BaseHook {
    event SessionCharged(
        PoolId indexed poolId, bytes32 indexed sessionId, address indexed owner, uint256 amount, uint256 remaining
    );
    event RouterTrustSet(address indexed owner, address indexed router, bool trusted);

    error ZeroSessionGrant();
    error MalformedSessionData(uint256 length);
    error ExactOutputCannotBeCharged();
    error NotSessionOwner(bytes32 sessionId, address swapper);

    uint256 internal constant READ_GAS = 50_000;

    ISessionBudget public immutable sessions;

    /// @notice owner => router => whether the owner trusts the router to report them as its user.
    mapping(address => mapping(address => bool)) public trustedRouter;

    constructor(IPoolManager _poolManager, ISessionBudget _sessions) BaseHook(_poolManager) {
        if (address(_sessions) == address(0)) revert ZeroSessionGrant();
        sessions = _sessions;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeSwap = true;
    }

    /// @notice Trust, or stop trusting, `router` to report the caller as its user.
    function setRouterTrust(address router, bool trusted) external {
        trustedRouter[msg.sender][router] = trusted;
        emit RouterTrustSet(msg.sender, router, trusted);
    }

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata data)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (data.length != 0) {
            if (data.length != 32) revert MalformedSessionData(data.length);
            if (params.amountSpecified >= 0) revert ExactOutputCannotBeCharged();
            bytes32 sessionId = abi.decode(data, (bytes32));

            address owner = sessions.ownerOf(sessionId);
            address swapper = sender;
            if (owner != address(0) && trustedRouter[owner][sender]) {
                try IMsgSender(sender).msgSender{gas: READ_GAS}() returns (address who) {
                    swapper = who;
                } catch {}
            }
            if (owner == address(0) || swapper != owner) revert NotSessionOwner(sessionId, swapper);

            uint256 amount = uint256(-params.amountSpecified);
            // Reverts with SessionGrant's own error when the budget is short, expired or revoked.
            uint256 left = sessions.spend(sessionId, amount);
            emit SessionCharged(key.toId(), sessionId, owner, amount, left);
        }
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }
}
