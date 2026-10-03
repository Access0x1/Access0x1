// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @notice The one read this hook makes of the Access0x1 Router: its public `merchants` getter.
/// @dev Written here from the Router's `Merchant` struct, not imported: the Router builds with
///      solc 0.8.28 and via_ir, this workspace with 0.8.30 and without.
interface IAccess0x1Merchants {
    function merchants(uint256 merchantId)
        external
        view
        returns (address payout, address owner, address feeRecipient, uint16 feeBps, bool active, bytes32 nameHash);
}

/// @notice A swap router that can say whose swap it is running (as W11-style routers do).
interface IMsgSender {
    function msgSender() external view returns (address);
}

/// @title Access0x1ReceiptHook
/// @author Access0x1
/// @notice A receipt for every swap through a pool that names this hook, open to any business and
///         any pool. A swap may carry `abi.encode(uint256 merchantId, bytes32 orderRef)` as hook
///         data. The receipt says whether that claim is VERIFIED: the merchant is registered and
///         active on the Access0x1 Router, and the swap was made by that merchant's own payout or
///         owner wallet.
/// @dev afterSwap only: mask 0x40. No delta, no fee, no funds, no admin, no upgrade path. A swap
///      settles exactly as it would without the hook, and nothing here can make it revert except
///      running out of gas.
///
///      Who made the swap. The PoolManager reports `sender`, which is the router contract, not
///      the person. A merchant's owner may therefore name routers it trusts to report the user
///      truthfully through `msgSender()`. For a trusted router the swapper is what it reports; for
///      any other caller the swapper is `sender` itself. Trust is per merchant and set only by that
///      merchant's owner, so no one can make a router speak for a business that did not choose it.
///
///      Replaces Access0x1SwapReceiptHook (src/uniswap/, live on Sepolia), whose attribution was
///      self-asserted: anyone could emit a receipt naming any merchant.
contract Access0x1ReceiptHook is BaseHook {
    /// @notice One swap. `verified` is true only when the claim in the hook data was checked and held.
    /// @param sender what the PoolManager reports as the swap's caller (usually a router)
    /// @param swapper who made the swap: `msgSender()` of a router this merchant trusts, else `sender`
    event SwapReceipt(
        PoolId indexed poolId,
        uint256 indexed merchantId,
        address indexed swapper,
        address sender,
        bytes32 orderRef,
        int256 delta,
        bool verified
    );

    event RouterTrustSet(uint256 indexed merchantId, address indexed router, bool trusted);

    error ZeroMerchantRegistry();
    error NotMerchantOwner(uint256 merchantId, address caller);

    /// @dev Gas allowed for each external read inside afterSwap. A registry or router that needs more,
    ///      or reverts, leaves the receipt unverified; the swap goes on.
    uint256 internal constant READ_GAS = 50_000;

    /// @notice The Access0x1 Router whose merchant records this hook checks against.
    IAccess0x1Merchants public immutable merchantRegistry;

    /// @notice merchantId => router => whether that merchant's owner trusts the router's msgSender().
    mapping(uint256 => mapping(address => bool)) public trustedRouter;

    constructor(IPoolManager _poolManager, IAccess0x1Merchants _merchantRegistry) BaseHook(_poolManager) {
        if (address(_merchantRegistry) == address(0)) revert ZeroMerchantRegistry();
        merchantRegistry = _merchantRegistry;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.afterSwap = true;
    }

    /// @notice Trust, or stop trusting, `router` to report who is swapping for this merchant.
    /// @dev Only the merchant's current owner on the Router may call it; ownership is read live, so
    ///      an owner transfer on the Router moves this power with it.
    function setRouterTrust(uint256 merchantId, address router, bool trusted) external {
        (, address owner,,,,) = merchantRegistry.merchants(merchantId);
        if (owner == address(0) || msg.sender != owner) revert NotMerchantOwner(merchantId, msg.sender);
        trustedRouter[merchantId][router] = trusted;
        emit RouterTrustSet(merchantId, router, trusted);
    }

    /// @dev Hook data that is not exactly 64 bytes is no claim: merchantId 0, unverified. It never
    ///      reverts, so bad hook data cannot fail someone's swap.
    function _afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata,
        BalanceDelta delta,
        bytes calldata data
    ) internal override returns (bytes4, int128) {
        uint256 merchantId;
        bytes32 orderRef;
        if (data.length == 64) (merchantId, orderRef) = abi.decode(data, (uint256, bytes32));

        address swapper = sender;
        bool verified;
        if (merchantId != 0) {
            if (trustedRouter[merchantId][sender]) swapper = _reportedSwapper(sender);
            verified = _isMerchantWallet(merchantId, swapper);
        }

        emit SwapReceipt(key.toId(), merchantId, swapper, sender, orderRef, BalanceDelta.unwrap(delta), verified);
        return (this.afterSwap.selector, 0);
    }

    /// @dev A trusted router that reverts, runs out of its gas, or reports address(0) gives no swapper.
    function _reportedSwapper(address router) internal view returns (address) {
        try IMsgSender(router).msgSender{gas: READ_GAS}() returns (address who) {
            return who;
        } catch {
            return address(0);
        }
    }

    function _isMerchantWallet(uint256 merchantId, address who) internal view returns (bool) {
        if (who == address(0)) return false;
        try merchantRegistry.merchants{gas: READ_GAS}(merchantId) returns (
            address payout, address owner, address, uint16, bool active, bytes32
        ) {
            return active && (who == payout || who == owner);
        } catch {
            return false;
        }
    }
}
