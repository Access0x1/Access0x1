// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Refunds } from "../../src/Refunds.sol";
import { IRefunds } from "../../src/interfaces/IRefunds.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

/// @notice Drives the {Refunds} invariant fuzzer through the full lifecycle — request (a merchant funds
///         a time-boxed refund), claim (the buyer pulls before the window), and reclaim (the merchant
///         pulls back after the window) — across a fixed merchant and two assets (one native, one
///         ERC-20), while tracking ghost totals the suite checks the contract against.
/// @dev    TIME IS FROZEN by the test (so transitions are reachable without warping); {claim} and
///         {reclaim} momentarily warp inside/outside the window and back. All recipients are EOAs that
///         always receive, so no push ever queues during the run — the conservation invariant then
///         reduces to an exact equality the suite asserts. A FROZEN CANARY refund (requested once,
///         never resolved) backs the "a PENDING refund's funds are always fully present + claimable"
///         never-blockable invariant. Every action is written to NEVER revert
///         (`fail_on_revert = true`): inputs are `bound`ed and preconditions early-return.
contract RefundsHandler is Test {
    Refunds public immutable refunds;
    Access0x1Router public immutable router;
    MockUSDC public immutable usdc; // 6 dp ERC-20 asset

    uint256 public immutable merchantId;
    address public immutable merchantOwner;

    /// @notice The native-asset sentinel mirrored from the contract.
    address internal constant NATIVE = address(0);

    /// @notice A small fixed set of buyers the fuzzer cycles through (all EOAs that always receive — so
    ///         the run reaches the exact-conservation equality, no queued pushes).
    address[3] public buyers;
    /// @notice A fixed sink the merchant reclaims into.
    address public sink;

    /// @notice Live (PENDING) order ids the fuzzer can resolve.
    bytes32[] public liveOrders;
    /// @notice order ⇒ index+1 in `liveOrders` (0 = not live). O(1) removal on a terminal transition.
    mapping(bytes32 order => uint256 idxPlus1) internal _liveIdx;
    /// @notice A monotonic counter so every request gets a unique order id.
    uint256 internal _orderNonce;

    // ---- frozen canary (never-blockable: a PENDING refund is always fully funded + claimable) ----
    bytes32 public canaryOrder;
    address public canaryBuyer;
    uint256 public canaryAmount;

    // ---- ghost accounting ----
    /// @notice asset ⇒ Σ amount held across all PENDING refunds (the conservation target).
    mapping(address asset => uint256 held) public ghostOpen;
    /// @notice asset ⇒ Σ refund value RETURNED (claimed by buyers + reclaimed to the sink).
    mapping(address asset => uint256 returned) public ghostReturned;
    /// @notice Whether every resolution moved EXACTLY the held amount out (no value created/lost).
    bool public resolveAlwaysExact = true;

    constructor(
        Refunds refunds_,
        Access0x1Router router_,
        MockUSDC usdc_,
        uint256 merchantId_,
        address merchantOwner_
    ) {
        refunds = refunds_;
        router = router_;
        usdc = usdc_;
        merchantId = merchantId_;
        merchantOwner = merchantOwner_;
        sink = makeAddr("rh_sink");

        for (uint256 i = 0; i < 3; i++) {
            buyers[i] = makeAddr(string(abi.encodePacked("rh_buyer", i)));
        }

        // The merchant owner funds every refund; pre-fund + pre-approve it for the whole run.
        usdc_.mint(merchantOwner_, type(uint128).max);
        vm.deal(merchantOwner_, type(uint128).max);
        vm.prank(merchantOwner_);
        usdc_.approve(address(refunds_), type(uint256).max);
    }

    /// @notice Seed the frozen canary refund — requested once, never resolved, so the never-blockable
    ///         invariant can assert its funds are always present, it stays PENDING, and it is claimable.
    function seedCanary() external {
        canaryAmount = 42e6;
        canaryBuyer = buyers[0];
        canaryOrder = _nextOrder();
        vm.prank(merchantOwner);
        refunds.requestRefund(
            merchantId,
            canaryOrder,
            canaryBuyer,
            address(usdc),
            canaryAmount,
            uint64(block.timestamp + 365 days)
        );
        ghostOpen[address(usdc)] += canaryAmount;
        _addLive(canaryOrder);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _asset(uint256 seed) internal view returns (address) {
        return seed % 2 == 0 ? address(usdc) : NATIVE;
    }

    function _nextOrder() internal returns (bytes32) {
        return keccak256(abi.encodePacked("rh_order", _orderNonce++));
    }

    function _addLive(bytes32 order) internal {
        liveOrders.push(order);
        _liveIdx[order] = liveOrders.length;
    }

    function _removeLive(bytes32 order) internal {
        uint256 idxPlus1 = _liveIdx[order];
        if (idxPlus1 == 0) return;
        uint256 idx = idxPlus1 - 1;
        uint256 lastIdx = liveOrders.length - 1;
        if (idx != lastIdx) {
            bytes32 moved = liveOrders[lastIdx];
            liveOrders[idx] = moved;
            _liveIdx[moved] = idx + 1;
        }
        liveOrders.pop();
        _liveIdx[order] = 0;
    }

    function _pickLive(uint256 seed) internal view returns (bytes32 order, bool ok) {
        if (liveOrders.length == 0) return (bytes32(0), false);
        order = liveOrders[seed % liveOrders.length];
        ok = true;
    }

    function _balanceAt(address asset, address who) internal view returns (uint256) {
        if (asset == NATIVE) return who.balance;
        return MockUSDC(asset).balanceOf(who);
    }

    /*//////////////////////////////////////////////////////////////
                                ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Request a fresh funded, time-boxed refund. The asset alternates native/ERC-20 so both
    ///         conservation legs are exercised; the buyer cycles through the fixed EOA set.
    function request(uint256 buyerSeed, uint256 assetSeed, uint256 amtSeed) external {
        address buyer = buyers[buyerSeed % buyers.length];
        address asset = _asset(assetSeed);
        uint256 amount = bound(amtSeed, 1, 1_000_000e6);
        bytes32 order = _nextOrder();
        uint64 dl = uint64(block.timestamp + 1 days);

        if (asset == NATIVE) {
            vm.prank(merchantOwner);
            refunds.requestRefund{ value: amount }(merchantId, order, buyer, NATIVE, amount, dl);
        } else {
            vm.prank(merchantOwner);
            refunds.requestRefund(merchantId, order, buyer, asset, amount, dl);
        }
        ghostOpen[asset] += amount;
        _addLive(order);
    }

    /// @notice The buyer claims a pending refund within its window (the funds return to the buyer).
    function claim(uint256 seed) external {
        (bytes32 order, bool ok) = _pickLive(seed);
        if (!ok) return;
        if (order == canaryOrder) return; // never resolve the canary (the never-blockable witness)
        IRefunds.Refund memory r = refunds.refundOf(merchantId, order);
        if (r.state != IRefunds.RefundState.PENDING) return;
        if (block.timestamp >= r.deadline) return; // window closed — claim would revert; skip

        uint256 before = _balanceAt(r.asset, r.buyer);
        vm.prank(r.buyer);
        refunds.claim(merchantId, order);
        uint256 delta = _balanceAt(r.asset, r.buyer) - before;

        if (delta != r.amount) resolveAlwaysExact = false;
        ghostOpen[r.asset] -= r.amount;
        ghostReturned[r.asset] += delta;
        _removeLive(order);
    }

    /// @notice The merchant reclaims a pending refund AFTER its window lapses. Warps past the deadline,
    ///         reclaims to the sink, restores frozen time.
    function reclaim(uint256 seed) external {
        (bytes32 order, bool ok) = _pickLive(seed);
        if (!ok) return;
        if (order == canaryOrder) return; // never resolve the canary
        IRefunds.Refund memory r = refunds.refundOf(merchantId, order);
        if (r.state != IRefunds.RefundState.PENDING) return;

        uint256 frozenNow = block.timestamp;
        vm.warp(uint256(r.deadline) + 1);
        uint256 before = _balanceAt(r.asset, sink);
        vm.prank(merchantOwner);
        refunds.reclaim(merchantId, order, sink);
        uint256 delta = _balanceAt(r.asset, sink) - before;
        vm.warp(frozenNow);

        if (delta != r.amount) resolveAlwaysExact = false;
        ghostOpen[r.asset] -= r.amount;
        ghostReturned[r.asset] += delta;
        _removeLive(order);
    }
}
