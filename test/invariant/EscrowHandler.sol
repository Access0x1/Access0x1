// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Escrow } from "../../src/Access0x1Escrow.sol";
import { IAccess0x1Escrow } from "../../src/interfaces/IAccess0x1Escrow.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

/// @notice Drives the Access0x1Escrow invariant fuzzer through the full lifecycle — open, confirm,
///         claimAfterTimeout, cancel, arbitrate (release/refund), and withdraw — across a fixed merchant
///         and two assets (one native, one ERC-20), while tracking ghost totals the suite checks the
///         contract against. Every action is written to NEVER revert (the suite runs
///         `fail_on_revert = true`): inputs are `bound`ed and preconditions early-return.
/// @dev    TIME IS FROZEN by the test (so transitions are reachable without warping); {claimAfterTimeout}
///         momentarily warps past the (short) deadline and back. Buyers are EOAs that always receive, so
///         no push ever queues during the run — the conservation invariant then reduces to an exact
///         equality the suite asserts. A FROZEN CANARY escrow (opened once, never resolved) backs the
///         "an OPEN escrow's funds are always fully present" never-blockable invariant.
contract EscrowHandler is Test {
    Access0x1Escrow public immutable escrow;
    Access0x1Router public immutable router;
    MockUSDC public immutable usdc; // 6 dp ERC-20 asset

    uint256 public immutable merchantId;
    address public immutable treasury;

    /// @notice The native-asset sentinel mirrored from the contract.
    address internal constant NATIVE = address(0);

    /// @notice A small fixed set of buyers/sellers/arbiters the fuzzer cycles through (all EOAs that
    ///         always receive — so the run reaches the exact-conservation equality, no queued pushes).
    address[3] public buyers;
    address[3] public sellers;
    address public arbiter;

    /// @notice Live (OPEN) escrow ids the fuzzer can resolve.
    uint256[] public liveIds;
    /// @notice id ⇒ index+1 in `liveIds` (0 = not live). O(1) removal on a terminal transition.
    mapping(uint256 id => uint256 idxPlus1) internal _liveIdx;

    // ---- frozen canary (never-blockable: an OPEN escrow is always fully funded) ----
    uint256 public canaryId;
    uint256 public canaryAmount;

    // ---- ghost accounting ----
    /// @notice asset ⇒ Σ amount held across all live (OPEN) escrows (the conservation target).
    mapping(address asset => uint256 held) public ghostOpen;
    /// @notice asset ⇒ Σ queued in the pull-map across all accounts (stays 0 with EOA recipients).
    mapping(address asset => uint256 queued) public ghostQueued;
    /// @notice asset ⇒ Σ token paid OUT to the seller+treasury sinks across all releases.
    mapping(address asset => uint256 settled) public ghostSettled;
    /// @notice Whether every release's net+fee summed exactly to the held amount (no value created/lost).
    bool public splitAlwaysExact = true;

    constructor(
        Access0x1Escrow escrow_,
        Access0x1Router router_,
        MockUSDC usdc_,
        uint256 merchantId_,
        address treasury_
    ) {
        escrow = escrow_;
        router = router_;
        usdc = usdc_;
        merchantId = merchantId_;
        treasury = treasury_;
        arbiter = makeAddr("eh_arbiter");

        for (uint256 i = 0; i < 3; i++) {
            buyers[i] = makeAddr(string(abi.encodePacked("eh_buyer", i)));
            sellers[i] = makeAddr(string(abi.encodePacked("eh_seller", i)));
            usdc_.mint(buyers[i], type(uint128).max);
            vm.deal(buyers[i], type(uint128).max);
            vm.prank(buyers[i]);
            usdc_.approve(address(escrow_), type(uint256).max);
        }
    }

    /// @notice Seed the frozen canary escrow — opened once, never resolved, so the never-blockable
    ///         invariant can assert its funds are always present and it stays OPEN.
    function seedCanary() external {
        canaryAmount = 42e6;
        vm.prank(buyers[0]);
        canaryId = escrow.open(
            sellers[0],
            merchantId,
            address(usdc),
            canaryAmount,
            arbiter,
            uint64(block.timestamp + 365 days)
        );
        ghostOpen[address(usdc)] += canaryAmount;
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _asset(uint256 seed) internal view returns (address) {
        return seed % 2 == 0 ? address(usdc) : NATIVE;
    }

    function _addLive(uint256 id) internal {
        liveIds.push(id);
        _liveIdx[id] = liveIds.length;
    }

    function _removeLive(uint256 id) internal {
        uint256 idxPlus1 = _liveIdx[id];
        if (idxPlus1 == 0) return;
        uint256 idx = idxPlus1 - 1;
        uint256 lastIdx = liveIds.length - 1;
        if (idx != lastIdx) {
            uint256 moved = liveIds[lastIdx];
            liveIds[idx] = moved;
            _liveIdx[moved] = idx + 1;
        }
        liveIds.pop();
        _liveIdx[id] = 0;
    }

    function _pickLive(uint256 seed) internal view returns (uint256 id, bool ok) {
        if (liveIds.length == 0) return (0, false);
        id = liveIds[seed % liveIds.length];
        ok = true;
    }

    /// @dev The current total at the seller+treasury sinks for `asset`.
    function _sinkTotal(address asset, address seller) internal view returns (uint256) {
        if (asset == NATIVE) return seller.balance + treasury.balance;
        return MockUSDC(asset).balanceOf(seller) + MockUSDC(asset).balanceOf(treasury);
    }

    /// @dev Fold a resolved release into the split-exactness ghost: net+fee must equal the held amount.
    function _recordRelease(uint256 amount, uint256 sinkDelta) internal {
        if (sinkDelta != amount) splitAlwaysExact = false;
    }

    /*//////////////////////////////////////////////////////////////
                                ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Open a fresh funded escrow. A unique (buyer, seller) pair and a future deadline; the asset
    ///         alternates native/ERC-20 so both conservation legs are exercised.
    function open(uint256 buyerSeed, uint256 sellerSeed, uint256 assetSeed, uint256 amtSeed)
        external
    {
        address buyer = buyers[buyerSeed % buyers.length];
        address seller = sellers[sellerSeed % sellers.length];
        address asset = _asset(assetSeed);
        uint256 amount = bound(amtSeed, 1, 1_000_000e6); // up to 1M units

        uint64 dl = uint64(block.timestamp + 1 days);
        uint256 id;
        if (asset == NATIVE) {
            vm.prank(buyer);
            id = escrow.open{ value: amount }(seller, merchantId, NATIVE, amount, arbiter, dl);
        } else {
            vm.prank(buyer);
            id = escrow.open(seller, merchantId, asset, amount, arbiter, dl);
        }
        ghostOpen[asset] += amount;
        _addLive(id);
    }

    /// @notice Buyer-confirms a release: net → seller, fee → treasury, through the live split.
    function confirm(uint256 seed) external {
        (uint256 id, bool ok) = _pickLive(seed);
        if (!ok) return;
        IAccess0x1Escrow.Escrow memory e = escrow.escrowOf(id);
        if (e.state != IAccess0x1Escrow.EscrowState.OPEN) return;

        uint256 sinkBefore = _sinkTotal(e.asset, e.seller);
        vm.prank(e.buyer);
        escrow.confirm(id);
        uint256 sinkDelta = _sinkTotal(e.asset, e.seller) - sinkBefore;

        ghostOpen[e.asset] -= e.amount;
        ghostSettled[e.asset] += sinkDelta;
        _recordRelease(e.amount, sinkDelta);
        _removeLive(id);
    }

    /// @notice Permissionless timeout release. Warps past the deadline, releases, restores frozen time.
    function claimAfterTimeout(uint256 seed) external {
        (uint256 id, bool ok) = _pickLive(seed);
        if (!ok) return;
        IAccess0x1Escrow.Escrow memory e = escrow.escrowOf(id);
        if (e.state != IAccess0x1Escrow.EscrowState.OPEN) return;

        uint256 frozenNow = block.timestamp;
        vm.warp(uint256(e.deadline) + 1);
        uint256 sinkBefore = _sinkTotal(e.asset, e.seller);
        escrow.claimAfterTimeout(id); // anyone may call (this handler is fine)
        uint256 sinkDelta = _sinkTotal(e.asset, e.seller) - sinkBefore;
        vm.warp(frozenNow);

        ghostOpen[e.asset] -= e.amount;
        ghostSettled[e.asset] += sinkDelta;
        _recordRelease(e.amount, sinkDelta);
        _removeLive(id);
    }

    /// @notice Seller-cancels: full refund to the buyer (no fee). Funds leave `held`, never queue (EOA).
    function cancel(uint256 seed) external {
        (uint256 id, bool ok) = _pickLive(seed);
        if (!ok) return;
        IAccess0x1Escrow.Escrow memory e = escrow.escrowOf(id);
        if (e.state != IAccess0x1Escrow.EscrowState.OPEN) return;

        vm.prank(e.seller);
        escrow.cancel(id);
        ghostOpen[e.asset] -= e.amount;
        _removeLive(id);
    }

    /// @notice Arbiter ruling — release on even seeds, refund on odd. Exercises both arbiter legs.
    function arbitrate(uint256 seed) external {
        (uint256 id, bool ok) = _pickLive(seed);
        if (!ok) return;
        IAccess0x1Escrow.Escrow memory e = escrow.escrowOf(id);
        if (e.state != IAccess0x1Escrow.EscrowState.OPEN) return;

        bool release = seed % 2 == 0;
        uint256 sinkBefore = _sinkTotal(e.asset, e.seller);
        vm.prank(arbiter);
        escrow.arbitrate(id, release);
        if (release) {
            uint256 sinkDelta = _sinkTotal(e.asset, e.seller) - sinkBefore;
            ghostSettled[e.asset] += sinkDelta;
            _recordRelease(e.amount, sinkDelta);
        }
        ghostOpen[e.asset] -= e.amount;
        _removeLive(id);
    }
}
