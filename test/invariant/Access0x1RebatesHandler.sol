// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Rebates } from "../../src/Access0x1Rebates.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";

/// @notice Drives the Rebates invariant fuzzer through the full pool lifecycle — fundPromo,
///         payWithRebate, time travel, and the post-window reclaim — across TWO merchant seats (one
///         long-window promo that stays live, one short-window promo the fuzzer can outlive and
///         reclaim), while cross-checking the ledger against real transfers. Every action is written
///         to NEVER revert (`fail_on_revert = true`): amounts are `bound`ed, each payment carries a
///         fresh orderId (the idempotency key is consumed, never replayed), funding skips a closed
///         window, reclaim early-returns until it is legal, and every warp refreshes the price feed
///         so the router's staleness guard never fires on a stale MOCK rather than a real defect.
/// @dev    The buyer is an EOA holding no code, so the inline rebate push always lands and the queue
///         stays empty — the conservation invariant then reduces to the EXACT equality (contract
///         balance == Σ promos' funded + Σ withdrawable) the suite asserts. The handler separately
///         recomputes each rebate from the buyer's REAL balance delta and compares it to the pool's
///         ledger movement (`rebateAccountingExact`), so a drift between what the ledger says left
///         the pool and what the buyer actually received would surface immediately.
contract Access0x1RebatesHandler is Test {
    Access0x1Rebates public immutable rebates;
    Access0x1Router public immutable router;
    MockUSDC public immutable usdc;
    MockV3Aggregator public immutable feed;

    uint256 public immutable seatLong; // promo window outlives the fuzz run
    uint256 public immutable seatShort; // promo window the fuzzer can outlive + reclaim

    address public buyer;
    address public funder;

    /// @notice Every payment's ledger movement matched the buyer's real balance delta.
    bool public rebateAccountingExact = true;

    uint256 internal _nonce;

    constructor(
        Access0x1Rebates rebates_,
        Access0x1Router router_,
        MockUSDC usdc_,
        MockV3Aggregator feed_,
        uint256 seatLong_,
        uint256 seatShort_
    ) {
        rebates = rebates_;
        router = router_;
        usdc = usdc_;
        feed = feed_;
        seatLong = seatLong_;
        seatShort = seatShort_;

        buyer = makeAddr("rbh_buyer");
        funder = makeAddr("rbh_funder");
        usdc_.mint(buyer, type(uint128).max);
        vm.prank(buyer);
        usdc_.approve(address(rebates_), type(uint256).max);
        vm.prank(funder);
        usdc_.approve(address(rebates_), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _seat(uint256 seed) internal view returns (uint256) {
        return seed % 2 == 0 ? seatLong : seatShort;
    }

    function _promo(uint256 seat) internal view returns (uint64 end, uint16 bps, uint256 funded) {
        (,, end, bps,, funded) = rebates.promos(seat);
    }

    /*//////////////////////////////////////////////////////////////
                                ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Top up a promo pool (skips a closed window — a dead promo takes no new money).
    function fund(uint256 seatSeed, uint256 amtSeed) external {
        uint256 seat = _seat(seatSeed);
        (uint64 end,,) = _promo(seat);
        if (block.timestamp > end) return;
        uint256 amount = bound(amtSeed, 1, 1_000_000e6);
        usdc.mint(funder, amount);
        vm.prank(funder);
        rebates.fundPromo(seat, amount);
    }

    /// @notice Settle a payment with a FRESH orderId; cross-check the pool's ledger movement against
    ///         the buyer's real balance delta (they must match to the unit — the fully-backed rule).
    function pay(uint256 seatSeed, uint256 usdSeed) external {
        uint256 seat = _seat(seatSeed);
        uint256 usd8 = bound(usdSeed, 1e8, 10_000e8); // $1 .. $10k
        bytes32 orderId = keccak256(abi.encode("rbh", _nonce++));

        (,, uint256 fundedBefore) = _promo(seat);
        uint256 gross = router.quote(seat, address(usdc), usd8);
        uint256 buyerBefore = usdc.balanceOf(buyer);

        vm.prank(buyer);
        rebates.payWithRebate(seat, address(usdc), usd8, orderId);

        (,, uint256 fundedAfter) = _promo(seat);
        uint256 ledgerOut = fundedBefore - fundedAfter; // what the pool ledger says left
        uint256 buyerGot = usdc.balanceOf(buyer) + gross - buyerBefore; // what actually arrived
        if (ledgerOut != buyerGot) rebateAccountingExact = false;
    }

    /// @notice Travel forward (bounded), refreshing the feed so staleness never masks the run.
    function warp(uint256 dSeed) external {
        vm.warp(block.timestamp + bound(dSeed, 10 minutes, 2 days));
        feed.updateAnswer(1e8);
    }

    /// @notice The merchant owner reclaims a closed, funded pool (early-returns until legal).
    function reclaimShort() external {
        (uint64 end,, uint256 funded) = _promo(seatShort);
        if (block.timestamp <= end || funded == 0) return;
        (, address seatOwner,,,,) = router.merchants(seatShort);
        vm.prank(seatOwner);
        rebates.reclaim(seatShort, seatOwner);
    }
}
