// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Access0x1Bookings } from "../../src/Access0x1Bookings.sol";
import { IAccess0x1Bookings } from "../../src/interfaces/IAccess0x1Bookings.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

/// @notice Drives the Access0x1Bookings invariant fuzzer through the full lifecycle — reserve, confirm,
///         complete, expireHold, cancel, markNoShow, claimRefund — across a fixed merchant + two
///         assets, while tracking ghost totals the suite checks the contract against. Every action is
///         written to NEVER revert (the suite runs `fail_on_revert = true`): inputs are `bound`ed and
///         preconditions early-return.
/// @dev    TIME IS FROZEN (the test pins `block.timestamp`), so the feeds stay fresh and transitions
///         are reachable without warping: reserves use `holdSecs = 0` (immediately expirable) and a
///         `slotTimestamp` in the past (always inside the cancel window, so the late-fee branch is
///         exercised). A FROZEN CANARY merchant + reservation (created once, never touched) backs the
///         isolation + policy-immutability invariants.
contract BookingsHandler is Test {
    Access0x1Bookings public immutable bookings;
    Access0x1Router public immutable router;
    MockUSDC public immutable usdc; // 6 dp
    MockUSDC public immutable eurc; // 6 dp (second asset for multi-asset conservation)

    uint256 public immutable merchantId;
    address public immutable payout;
    address public immutable feeRecipient;
    address public immutable treasury;

    /// @notice A small fixed set of payers the fuzzer reserves as.
    address[3] public payers;

    /// @notice Live reservation ids (HELD or CONFIRMED) the fuzzer can transition.
    uint256[] public liveIds;
    /// @notice id ⇒ index+1 in `liveIds` (0 = not live). Lets us O(1) remove on terminal transitions.
    mapping(uint256 id => uint256 idxPlus1) internal _liveIdx;

    /// @notice slotKey nonce — every reserve uses a unique slot so collisions never trip fail_on_revert
    ///         (slot-collision is unit-tested separately).
    uint256 internal slotNonce;
    uint256 internal clientNonceCtr;

    // ---- frozen canary (isolation + policy-immutability invariants) ----
    uint256 public canaryId;
    bytes32 public constant CANARY_SLOT = keccak256("canary-slot");
    uint32 public constant CANARY_WINDOW = 1234;
    uint256 public constant CANARY_LATE = 7e8;
    uint256 public constant CANARY_NOSHOW = 9e8;
    uint256 public canaryEscrow;

    // ---- ghost accounting ----
    /// @notice asset ⇒ Σ escrowed across all live reservations (the conservation target).
    mapping(address asset => uint256 held) public ghostEscrowed;
    /// @notice asset ⇒ Σ token routed to the operator sinks through the fee-split (release + fees).
    mapping(address asset => uint256 routed) public ghostRouted;
    /// @notice Whether every fee/release taken stayed ≤ the reservation's escrow (invariant 4).
    bool public feeNeverExceededEscrow = true;

    constructor(
        Access0x1Bookings bookings_,
        Access0x1Router router_,
        MockUSDC usdc_,
        MockUSDC eurc_,
        uint256 merchantId_,
        address payout_,
        address feeRecipient_,
        address treasury_
    ) {
        bookings = bookings_;
        router = router_;
        usdc = usdc_;
        eurc = eurc_;
        merchantId = merchantId_;
        payout = payout_;
        feeRecipient = feeRecipient_;
        treasury = treasury_;

        payers[0] = makeAddr("bh_payer0");
        payers[1] = makeAddr("bh_payer1");
        payers[2] = makeAddr("bh_payer2");
        for (uint256 i = 0; i < payers.length; i++) {
            usdc_.mint(payers[i], type(uint128).max);
            eurc_.mint(payers[i], type(uint128).max);
            vm.startPrank(payers[i]);
            usdc_.approve(address(bookings_), type(uint256).max);
            eurc_.approve(address(bookings_), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// @notice Seed the frozen canary reservation — created once, never touched by any action, so the
    ///         isolation + policy-immutability invariants can assert it is unchanged.
    function seedCanary() external {
        IAccess0x1Bookings.Policy memory p = IAccess0x1Bookings.Policy({
            cancelWindowSecs: CANARY_WINDOW, lateFeeUsd8: CANARY_LATE, noShowFeeUsd8: CANARY_NOSHOW
        });
        vm.prank(payers[0]);
        canaryId = bookings.reserve(
            merchantId,
            CANARY_SLOT,
            uint64(block.timestamp + 365 days), // far future: never inside the cancel window
            address(usdc),
            33e8,
            0,
            p,
            uint64(365 days), // never expirable during the run
            keccak256("canary-nonce")
        );
        canaryEscrow = bookings.reservationOf(canaryId).escrowAmount;
        ghostEscrowed[address(usdc)] += canaryEscrow;
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _asset(uint256 seed) internal view returns (address) {
        return seed % 2 == 0 ? address(usdc) : address(eurc);
    }

    function _addLive(uint256 id) internal {
        liveIds.push(id);
        _liveIdx[id] = liveIds.length; // index+1
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

    /// @dev Record the operator's take on a terminal money move and fold it into the fee/escrow cap.
    function _recordRouted(address asset, uint256 escrowBefore, uint256 sinkDelta) internal {
        ghostRouted[asset] += sinkDelta;
        if (sinkDelta > escrowBefore) feeNeverExceededEscrow = false;
    }

    /// @dev The total token at the operator sinks for `asset` (payout + treasury + feeRecipient).
    function _sinkTotal(address asset) internal view returns (uint256) {
        return MockUSDC(asset).balanceOf(payout) + MockUSDC(asset).balanceOf(treasury)
            + MockUSDC(asset).balanceOf(feeRecipient);
    }

    /*//////////////////////////////////////////////////////////////
                                ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Reserve a fresh slot. `holdSecs = 0` (immediately expirable) and a PAST slotTimestamp
    ///         (always inside the cancel window) so every downstream transition is reachable with frozen
    ///         time. A unique slot key avoids collisions (unit-tested separately).
    function reserve(uint256 payerSeed, uint256 assetSeed, uint256 depositSeed) external {
        address payer = payers[payerSeed % payers.length];
        address asset = _asset(assetSeed);
        uint256 depositUsd8 = bound(depositSeed, 1e8, 10_000e8); // $1 .. $10k
        bytes32 slotKey = keccak256(abi.encode("slot", slotNonce++));
        bytes32 nonce = keccak256(abi.encode("nonce", clientNonceCtr++));

        IAccess0x1Bookings.Policy memory p = IAccess0x1Bookings.Policy({
            cancelWindowSecs: 1 hours,
            lateFeeUsd8: bound(depositSeed, 1e8, 5_000e8), // a real (possibly > deposit) late fee
            noShowFeeUsd8: bound(depositSeed, 1e8, 5_000e8)
        });

        vm.prank(payer);
        uint256 id = bookings.reserve(
            merchantId,
            slotKey,
            uint64(block.timestamp - 1), // in the past → inside the cancel window
            asset,
            depositUsd8,
            0,
            p,
            0, // holdSecs = 0 → immediately expirable
            nonce
        );
        ghostEscrowed[asset] += bookings.reservationOf(id).escrowAmount;
        _addLive(id);
    }

    /// @notice Confirm a HELD reservation (pure intent — no money moves, escrow stays held).
    function confirm(uint256 seed) external {
        (uint256 id, bool ok) = _pickLive(seed);
        if (!ok) return;
        if (bookings.reservationOf(id).status != IAccess0x1Bookings.RStatus.HELD) return;
        _asMerchantOwner();
        bookings.confirm(id);
    }

    /// @notice Complete a CONFIRMED reservation — releases the held deposit through the fee-split.
    function complete(uint256 seed) external {
        (uint256 id, bool ok) = _pickLive(seed);
        if (!ok) return;
        IAccess0x1Bookings.Reservation memory r = bookings.reservationOf(id);
        if (r.status != IAccess0x1Bookings.RStatus.CONFIRMED) return;

        uint256 escrowBefore = r.escrowAmount;
        uint256 sinkBefore = _sinkTotal(r.token);
        _asMerchantOwner();
        bookings.complete(id);
        uint256 sinkDelta = _sinkTotal(r.token) - sinkBefore;

        ghostEscrowed[r.token] -= escrowBefore;
        _recordRouted(r.token, escrowBefore, sinkDelta);
        _removeLive(id);
    }

    /// @notice Expire a HELD reservation (holdSecs was 0, so always expirable) — refunds the payer.
    function expireHold(uint256 seed) external {
        (uint256 id, bool ok) = _pickLive(seed);
        if (!ok) return;
        IAccess0x1Bookings.Reservation memory r = bookings.reservationOf(id);
        if (r.status != IAccess0x1Bookings.RStatus.HELD) return;

        bookings.expireHold(id); // permissionless
        ghostEscrowed[r.token] -= r.escrowAmount;
        _removeLive(id);
    }

    /// @notice Cancel a HELD/CONFIRMED reservation (always inside the window → late fee applies).
    function cancel(uint256 seed) external {
        (uint256 id, bool ok) = _pickLive(seed);
        if (!ok) return;
        IAccess0x1Bookings.Reservation memory r = bookings.reservationOf(id);
        if (
            r.status != IAccess0x1Bookings.RStatus.HELD
                && r.status != IAccess0x1Bookings.RStatus.CONFIRMED
        ) return;
        // A `lateFeeUsd8 == 0` policy would BLOCK a late cancel — but the reserve action always sets a
        // positive late fee, so cancel never reverts here.
        uint256 escrowBefore = r.escrowAmount;
        uint256 sinkBefore = _sinkTotal(r.token);
        vm.prank(r.payer);
        bookings.cancel(id, IAccess0x1Bookings.ActorType.PAYER);
        uint256 sinkDelta = _sinkTotal(r.token) - sinkBefore;

        ghostEscrowed[r.token] -= escrowBefore;
        _recordRouted(r.token, escrowBefore, sinkDelta);
        _removeLive(id);
    }

    /// @notice No-show a CONFIRMED reservation — keep the fee, refund the remainder.
    function markNoShow(uint256 seed) external {
        (uint256 id, bool ok) = _pickLive(seed);
        if (!ok) return;
        IAccess0x1Bookings.Reservation memory r = bookings.reservationOf(id);
        if (r.status != IAccess0x1Bookings.RStatus.CONFIRMED) return;

        uint256 escrowBefore = r.escrowAmount;
        uint256 sinkBefore = _sinkTotal(r.token);
        _asMerchantOwner();
        bookings.markNoShow(id);
        uint256 sinkDelta = _sinkTotal(r.token) - sinkBefore;

        ghostEscrowed[r.token] -= escrowBefore;
        _recordRouted(r.token, escrowBefore, sinkDelta);
        _removeLive(id);
    }

    /// @notice Claim any queued refund (no-op if nothing owed). Drives the pull-map path.
    function claimRefund(uint256 payerSeed, uint256 assetSeed) external {
        address payer = payers[payerSeed % payers.length];
        address asset = _asset(assetSeed);
        if (bookings.refundRescueOf(payer, asset) == 0) return;
        vm.prank(payer);
        bookings.claimRefund(asset);
    }

    /// @dev Prank as the merchant owner for the next call. The merchant owner is set by the test to
    ///      this handler's stored `merchantOwner` (passed via the Router registration), but to keep the
    ///      handler self-contained we re-read it from the Router and prank it.
    function _asMerchantOwner() internal {
        (, address owner_,,,,) = router.merchants(merchantId);
        vm.prank(owner_);
    }
}
