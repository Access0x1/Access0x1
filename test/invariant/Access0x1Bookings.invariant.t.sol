// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { Access0x1Bookings } from "../../src/Access0x1Bookings.sol";
import { IAccess0x1Bookings } from "../../src/interfaces/IAccess0x1Bookings.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { BookingsHandler } from "./BookingsHandler.sol";

/// @notice The Access0x1Bookings money invariants under a bounded, handler-driven fuzzer — the
///         security floor for the deposit-escrow primitive. Every property is asserted against an
///         INDEPENDENT ghost recomputation in the handler, never against the contract's own numbers.
/// @dev    Time is FROZEN (so feeds stay fresh and every transition is reachable); the handler drives
///         reserve/confirm/complete/expireHold/cancel/markNoShow/claimRefund as a real merchant owner
///         and three EOA payers. A FROZEN CANARY reservation (seeded once, never touched) backs the
///         isolation + policy-immutability invariants.
contract Access0x1BookingsInvariant is StdInvariant, Test {
    Access0x1Bookings internal bookings;
    Access0x1Router internal router;
    BookingsHandler internal handler;

    MockV3Aggregator internal usdcFeed;
    MockV3Aggregator internal eurcFeed;
    MockUSDC internal usdc;
    MockUSDC internal eurc;

    address internal admin = makeAddr("inv_admin");
    address internal treasury = makeAddr("inv_treasury");
    address internal merchantOwner = makeAddr("inv_merchantOwner");
    address internal payout = makeAddr("inv_payout");
    address internal feeRecipient = makeAddr("inv_feeRecipient");
    uint256 internal merchantId;

    function setUp() public {
        vm.warp(1_700_000_000); // fixed, fresh time held constant by the fuzzer

        router = new Access0x1Router(admin, treasury, 100); // 1% platform fee
        usdcFeed = new MockV3Aggregator(8, 1e8); // $1
        eurcFeed = new MockV3Aggregator(8, 11e7); // $1.10
        usdc = new MockUSDC();
        eurc = new MockUSDC();

        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        router.setTokenAllowed(address(eurc), true);
        router.setPriceFeed(address(eurc), address(eurcFeed));
        vm.stopPrank();

        bookings = new Access0x1Bookings(admin, address(router), address(0));

        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, 50, keccak256("inv_m")); // 0.5%

        handler = new BookingsHandler(
            bookings, router, usdc, eurc, merchantId, payout, feeRecipient, treasury
        );
        handler.seedCanary();

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = BookingsHandler.reserve.selector;
        selectors[1] = BookingsHandler.confirm.selector;
        selectors[2] = BookingsHandler.complete.selector;
        selectors[3] = BookingsHandler.expireHold.selector;
        selectors[4] = BookingsHandler.cancel.selector;
        selectors[5] = BookingsHandler.markNoShow.selector;
        selectors[6] = BookingsHandler.claimRefund.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @notice Invariant 2 — escrow conservation: the contract's ERC-20 balance of each token equals
    ///         the independent ghost sum of every live (HELD/CONFIRMED) reservation's escrow. Nothing
    ///         leaks; the contract holds no free-floating balance beyond live escrow (the payers are
    ///         EOAs that always receive, so no refund ever queues to the pull-map during the run).
    function invariant_escrowConservation() public view {
        assertEq(usdc.balanceOf(address(bookings)), handler.ghostEscrowed(address(usdc)));
        assertEq(eurc.balanceOf(address(bookings)), handler.ghostEscrowed(address(eurc)));
    }

    /// @notice Invariant 1 (end-to-end) — every release/fee leg flows through the Router fee-split, so
    ///         the operator sinks (payout + treasury + feeRecipient) hold exactly the independent ghost
    ///         total routed. `net + fee == gross` is the Router's own invariant; here we prove the
    ///         Bookings contract neither creates nor loses value on the way to the split.
    function invariant_routedMatchesSinks() public view {
        uint256 sinksUsdc =
            usdc.balanceOf(payout) + usdc.balanceOf(treasury) + usdc.balanceOf(feeRecipient);
        uint256 sinksEurc =
            eurc.balanceOf(payout) + eurc.balanceOf(treasury) + eurc.balanceOf(feeRecipient);
        assertEq(sinksUsdc, handler.ghostRouted(address(usdc)));
        assertEq(sinksEurc, handler.ghostRouted(address(eurc)));
    }

    /// @notice Invariant 4 — the fee/release taken on any terminal transition never exceeds that
    ///         reservation's escrow (so the payer refund is never negative; the clamp holds under all
    ///         price drift the fuzzer can reach).
    function invariant_feeNeverExceedsEscrow() public view {
        assertTrue(handler.feeNeverExceededEscrow());
    }

    /// @notice Invariant 5 — the policy snapshot is immutable: the frozen canary's policy (and its
    ///         immutable record fields) are exactly what was written at reserve, no matter what the
    ///         fuzzer did to other reservations.
    function invariant_policySnapshotImmutable() public view {
        IAccess0x1Bookings.Reservation memory r = bookings.reservationOf(handler.canaryId());
        assertEq(r.policy.cancelWindowSecs, handler.CANARY_WINDOW());
        assertEq(r.policy.lateFeeUsd8, handler.CANARY_LATE());
        assertEq(r.policy.noShowFeeUsd8, handler.CANARY_NOSHOW());
        assertEq(r.escrowAmount, handler.canaryEscrow());
        assertEq(uint8(r.status), uint8(IAccess0x1Bookings.RStatus.HELD)); // never transitioned
    }

    /// @notice Invariant 6 — tenant/slot isolation: the canary keeps its slot for its whole life (no
    ///         other reservation's transition ever freed or stole it), and its escrow is untouched.
    function invariant_canarySlotIsolation() public view {
        assertEq(bookings.occupant(handler.CANARY_SLOT()), handler.canaryId());
        assertFalse(bookings.isSlotFree(handler.CANARY_SLOT()));
    }

    /// @notice Invariant 3 (soundness) — the escrow ledger never overcounts the real backing: the
    ///         contract can always cover the ghost-tracked live escrow (a refund/release is always
    ///         deliverable because the funds are present). Equivalent to conservation here, asserted as
    ///         a `>=` so it also holds if a future rescue-queue path leaves extra backing.
    function invariant_escrowAlwaysBacked() public view {
        assertGe(usdc.balanceOf(address(bookings)), handler.ghostEscrowed(address(usdc)));
        assertGe(eurc.balanceOf(address(bookings)), handler.ghostEscrowed(address(eurc)));
    }
}
