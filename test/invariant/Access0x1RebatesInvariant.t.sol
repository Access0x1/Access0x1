// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Rebates } from "../../src/Access0x1Rebates.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import { Access0x1RebatesHandler } from "./Access0x1RebatesHandler.sol";

/// @notice The Rebates conservation suite. The money law under fuzz: the contract's token balance
///         equals EXACTLY the sum of every promo's remaining `funded` plus every unclaimed queued
///         rebate — funds are never created, never stranded, and the settlement leg leaves ZERO
///         custody behind (the gross only passes through to the router). A second invariant
///         cross-checks the LEDGER against REALITY: every rebate the pool ledger recorded as spent
///         must equal what the buyer's balance actually gained (the handler tracks it per payment).
/// @dev    `fail_on_revert = true` (foundry.toml): the handler pre-guards every call, so ANY revert
///         inside the run — a broken predicate, a double-claimed fresh orderId, an underflowing
///         pool — fails the suite, not just the equality checks.
contract Access0x1RebatesInvariant is Test, ProxyDeployer {
    Access0x1Router internal router;
    Access0x1Rebates internal rebates;
    Access0x1RebatesHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal merchantOwner = makeAddr("merchantOwner");
    address internal merchantPayout = makeAddr("merchantPayout");

    MockV3Aggregator internal usdcFeed;
    MockUSDC internal usdc;

    uint256 internal seatLong;
    uint256 internal seatShort;

    function setUp() public {
        vm.warp(1_700_000_000);

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (owner, treasury, 100))
            )
        );
        rebates = Access0x1Rebates(
            deployProxy(
                address(new Access0x1Rebates()),
                abi.encodeCall(Access0x1Rebates.initialize, (admin, router))
            )
        );

        usdcFeed = new MockV3Aggregator(8, 1e8);
        usdc = new MockUSDC();
        vm.startPrank(owner);
        router.setTokenAllowed(address(usdc), true);
        // A generous staleness window so the handler's bounded warps (≤ 2 days per step) exercise the
        // PROMO clock, not the oracle guard (the handler also refreshes the feed on every warp).
        router.setPriceFeed(address(usdc), address(usdcFeed), 30 days);
        vm.stopPrank();

        vm.startPrank(merchantOwner);
        seatLong = router.registerMerchant(merchantPayout, address(0), 0, keccak256("long"));
        seatShort = router.registerMerchant(merchantPayout, address(0), 0, keccak256("short"));
        // The long seat's window outlives any fuzz run (10 years); the short seat closes in 3 days,
        // so warps outlive it and the fuzzer exercises settles-without-rebate + reclaim.
        rebates.createPromo(
            seatLong,
            address(usdc),
            uint64(block.timestamp),
            uint64(block.timestamp + 3650 days),
            500, // 5%
            25e8 // $25 minimum
        );
        rebates.createPromo(
            seatShort,
            address(usdc),
            uint64(block.timestamp),
            uint64(block.timestamp + 3 days),
            1000, // 10%
            0 // every amount qualifies
        );
        vm.stopPrank();

        handler = new Access0x1RebatesHandler(rebates, router, usdc, usdcFeed, seatLong, seatShort);
        targetContract(address(handler));
    }

    /// @notice THE conservation law, EXACT form: contract balance == Σ promos' funded + Σ unclaimed
    ///         queued rebates. Nothing minted, nothing stranded, zero settlement custody.
    function invariant_poolFullyBackedExact() public view {
        (,,,,, uint256 fundedLong) = rebates.promos(seatLong);
        (,,,,, uint256 fundedShort) = rebates.promos(seatShort);
        uint256 queued = rebates.withdrawable(handler.buyer(), address(usdc));
        assertEq(
            usdc.balanceOf(address(rebates)),
            fundedLong + fundedShort + queued,
            "balance != funded + queued (conservation broken)"
        );
    }

    /// @notice The ledger never lies: every pool decrement equals what the buyer actually received.
    function invariant_rebateLedgerMatchesReality() public view {
        assertTrue(handler.rebateAccountingExact(), "ledger drifted from real transfers");
    }
}
