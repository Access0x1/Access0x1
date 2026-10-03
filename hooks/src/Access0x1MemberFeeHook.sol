// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {IAccess0x1Merchants, IMsgSender} from "./Access0x1ReceiptHook.sol";

/// @notice Any membership contract with this read. Access0x1's MembershipToken has it; a business may
///         bring its own.
interface IMembership {
    function isActive(address member, uint256 tierId) external view returns (bool);
}

/// @title Access0x1MemberFeeHook
/// @author Access0x1
/// @notice A merchant's pool where its members trade cheaper. The merchant names a membership
///         contract and tier, a member fee and a public fee; a swapper with an active membership
///         pays the member fee, everyone else the public fee. Open to any business on the Access0x1
///         Router, with any membership contract.
/// @dev beforeInitialize | beforeSwap = 0x2000 | 0x80 = 0x2080. No delta, no funds, no admin.
///
///      A pool must be configured BEFORE it is initialised, and only dynamic-fee pools are accepted:
///      on a static-fee pool the override would be ignored. The first configuration of a PoolId binds
///      it to that merchant for good; afterwards only that merchant's current owner on the Router can
///      change the fees or membership. Fees are capped at MAX_FEE.
///
///      Who is swapping: `sender` is a router. A router the merchant's owner trusts is asked for its
///      user with `msgSender()`; for any other router the swapper is the router itself, which holds
///      no membership, so it pays the public fee. Any failing external read also means the public fee:
///      a broken membership contract can make a member pay more, never make a swap fail.
contract Access0x1MemberFeeHook is BaseHook {
    using LPFeeLibrary for uint24;

    struct PoolConfig {
        uint256 merchantId;
        IMembership membership;
        uint256 tierId;
        uint24 memberFee; // pips: 1_000_000 = 100%
        uint24 publicFee;
        bool exists;
    }

    event PoolConfigured(
        PoolId indexed poolId,
        uint256 indexed merchantId,
        address membership,
        uint256 tierId,
        uint24 memberFee,
        uint24 publicFee
    );
    event RouterTrustSet(uint256 indexed merchantId, address indexed router, bool trusted);
    event MemberSwap(PoolId indexed poolId, address indexed swapper, bool member, uint24 fee);

    error ZeroMerchantRegistry();
    error NotMerchantOwner(uint256 merchantId, address caller);
    error PoolBoundToAnotherMerchant(PoolId poolId, uint256 merchantId);
    error FeeTooHigh(uint24 fee);
    error MemberFeeAbovePublicFee(uint24 memberFee, uint24 publicFee);
    error NotDynamicFee();
    error NotConfigured(PoolId poolId);

    /// @notice The highest fee either side may be set to: 10%.
    uint24 public constant MAX_FEE = 100_000;

    uint256 internal constant READ_GAS = 50_000;

    IAccess0x1Merchants public immutable merchantRegistry;

    mapping(PoolId => PoolConfig) public poolConfig;
    mapping(uint256 => mapping(address => bool)) public trustedRouter;

    constructor(IPoolManager _poolManager, IAccess0x1Merchants _merchantRegistry) BaseHook(_poolManager) {
        if (address(_merchantRegistry) == address(0)) revert ZeroMerchantRegistry();
        merchantRegistry = _merchantRegistry;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeInitialize = true;
        permissions.beforeSwap = true;
    }

    /// @notice Set or change a pool's fees and membership. The first call binds the PoolId to `merchantId`.
    function configure(
        PoolKey calldata key,
        uint256 merchantId,
        IMembership membership,
        uint256 tierId,
        uint24 memberFee,
        uint24 publicFee
    ) external {
        _onlyMerchantOwner(merchantId);
        if (publicFee > MAX_FEE) revert FeeTooHigh(publicFee);
        if (memberFee > publicFee) revert MemberFeeAbovePublicFee(memberFee, publicFee);

        PoolId id = key.toId();
        PoolConfig storage c = poolConfig[id];
        if (c.exists && c.merchantId != merchantId) revert PoolBoundToAnotherMerchant(id, c.merchantId);
        poolConfig[id] = PoolConfig(merchantId, membership, tierId, memberFee, publicFee, true);
        emit PoolConfigured(id, merchantId, address(membership), tierId, memberFee, publicFee);
    }

    function setRouterTrust(uint256 merchantId, address router, bool trusted) external {
        _onlyMerchantOwner(merchantId);
        trustedRouter[merchantId][router] = trusted;
        emit RouterTrustSet(merchantId, router, trusted);
    }

    /// @notice The fee `swapper` would pay in this pool right now.
    function feeFor(PoolKey calldata key, address swapper) public view returns (uint24 fee, bool member) {
        PoolConfig memory c = poolConfig[key.toId()];
        member = _isMember(c, swapper);
        fee = member ? c.memberFee : c.publicFee;
    }

    function _beforeInitialize(address, PoolKey calldata key, uint160) internal view override returns (bytes4) {
        if (!key.fee.isDynamicFee()) revert NotDynamicFee();
        if (!poolConfig[key.toId()].exists) revert NotConfigured(key.toId());
        return this.beforeInitialize.selector;
    }

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        PoolConfig memory c = poolConfig[id];
        address swapper = trustedRouter[c.merchantId][sender] ? _reportedSwapper(sender) : sender;
        bool member = _isMember(c, swapper);
        uint24 fee = member ? c.memberFee : c.publicFee;
        emit MemberSwap(id, swapper, member, fee);
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function _isMember(PoolConfig memory c, address who) internal view returns (bool) {
        if (who == address(0) || address(c.membership) == address(0)) return false;
        try c.membership.isActive{gas: READ_GAS}(who, c.tierId) returns (bool active) {
            return active;
        } catch {
            return false;
        }
    }

    function _reportedSwapper(address router) internal view returns (address) {
        try IMsgSender(router).msgSender{gas: READ_GAS}() returns (address who) {
            return who;
        } catch {
            return address(0);
        }
    }

    function _onlyMerchantOwner(uint256 merchantId) internal view {
        (, address owner,,,,) = merchantRegistry.merchants(merchantId);
        if (owner == address(0) || msg.sender != owner) revert NotMerchantOwner(merchantId, msg.sender);
    }
}
