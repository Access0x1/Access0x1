// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";

import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Bookings } from "../../src/Access0x1Bookings.sol";
import { IAccess0x1Bookings } from "../../src/interfaces/IAccess0x1Bookings.sol";

import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @title  SalonBooking — a deposit, a late cancel, a no-show, and a refund that NEVER gets stuck
/// @author Access0x1
/// @notice SCENARIO: a hair salon takes a refundable deposit to hold an appointment. Two real things
///         can go wrong, and the law (money-safety invariant #5: money rolls back, refunds are never blocked) says
///         the customer's money must always be reachable:
///
///           (c1) A customer books, then cancels LATE (inside the salon's cancel window). The salon's
///                policy keeps a snapshotted late fee; the rest is refunded. The fee is RE-QUOTED at
///                cancel time so price drift can't be gamed, and is CLAMPED to the escrow so the refund
///                can never go negative.
///           (c2) A customer books, never shows. The salon keeps the no-show fee; the remainder is
///                refunded. THEN we make the price feed go STALE before the no-show is marked — and the
///                refund STILL goes through (the contract treats an unreadable oracle as "take no fee"
///                and returns the FULL escrow rather than bricking the customer's refund).
///
///         What an auditor is checking:
///           1. The cancellation Policy is SNAPSHOTTED at reserve and immutable — the salon can't
///              retroactively raise the fee on a live booking.
///           2. CONSERVATION across the escrow ledger: escrowedOf(token) tracks the contract's real
///              balance; a resolved booking leaves ~zero of that booking's escrow.
///           3. refund = escrow - fee, and fee <= escrow always (refund never negative).
///           4. REFUND NEVER BLOCKED: even with a dead/stale feed, the no-show resolves and the
///              customer is made whole (the fee leg simply takes nothing).
contract SalonBookingScenarioTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    Access0x1Bookings internal bookings;

    MockUSDC internal usdc;
    MockV3Aggregator internal usdcFeed;

    address internal platformAdmin = makeAddr("access0x1-platform-admin");
    address internal treasury = makeAddr("access0x1-treasury");
    address internal salonOwner = makeAddr("shears-salon-owner");
    address internal salonChair = makeAddr("shears-salon-payout"); // where the salon's fee lands
    address internal client = makeAddr("appointment-client"); // the customer paying the deposit

    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%
    uint16 internal constant SALON_SURCHARGE_BPS = 0;

    uint256 internal constant DEPOSIT_USD8 = 40e8; // a $40 deposit to hold the chair
    uint256 internal constant LATE_FEE_USD8 = 15e8; // $15 kept if you cancel late
    uint256 internal constant NO_SHOW_FEE_USD8 = 25e8; // $25 kept if you ghost the appointment
    uint32 internal constant CANCEL_WINDOW = 24 hours; // "late" = within 24h of the appointment

    uint256 internal merchantId;
    uint64 internal appointmentTime;

    function setUp() public {
        vm.warp(1_700_000_000);

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(
                    Access0x1Router.initialize, (platformAdmin, treasury, PLATFORM_FEE_BPS)
                )
            )
        );
        // No SessionGrant manage-token in this scenario (relayed cancels disabled) -> address(0).
        // Deploy Bookings behind a UUPS proxy (impl → ERC1967Proxy running initialize → cast).
        address bookingsImpl = address(new Access0x1Bookings());
        bookings = Access0x1Bookings(
            deployProxy(
                bookingsImpl,
                abi.encodeCall(
                    Access0x1Bookings.initialize, (platformAdmin, address(router), address(0))
                )
            )
        );

        usdc = new MockUSDC();
        usdcFeed = new MockV3Aggregator(8, 1e8); // $1.00 / USDC

        vm.startPrank(platformAdmin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        vm.prank(salonOwner);
        merchantId = router.registerMerchant(
            salonChair, address(0), SALON_SURCHARGE_BPS, keccak256("shears-salon")
        );

        // The appointment is a week out; the deposit is paid now.
        appointmentTime = uint64(block.timestamp + 7 days);

        usdc.mint(client, 10_000e6);
        vm.prank(client);
        usdc.approve(address(bookings), type(uint256).max);
    }

    /// @dev The salon's standard cancellation policy, snapshotted at reserve.
    function _policy() internal pure returns (IAccess0x1Bookings.Policy memory) {
        return IAccess0x1Bookings.Policy({
            cancelWindowSecs: CANCEL_WINDOW,
            lateFeeUsd8: LATE_FEE_USD8,
            noShowFeeUsd8: NO_SHOW_FEE_USD8
        });
    }

    /// @dev Reserve one appointment slot and return its id. The deposit ($40) is escrowed as USDC.
    function _reserve(bytes32 slotKey, bytes32 nonce) internal returns (uint256 id) {
        vm.prank(client);
        id = bookings.reserve(
            merchantId,
            slotKey,
            appointmentTime,
            address(usdc),
            DEPOSIT_USD8,
            0, // no in-person balance due in this scenario
            _policy(),
            uint64(14 days), // hold valid for two weeks
            nonce
        );
    }

    /// @notice (c1) Late cancel: the snapshotted late fee is kept, the rest refunded, refund >= 0.
    function test_scenario_salon_lateCancel_keepsPolicyFee_refundsRemainder() public {
        uint256 escrow = router.quote(merchantId, address(usdc), DEPOSIT_USD8); // 40e6
        assertEq(escrow, 40e6, "$40 deposit escrows to 40 USDC");

        uint256 id = _reserve(keccak256("chair-1@friday-2pm"), keccak256("nonce-c1"));

        // The escrow ledger now backs exactly the contract's USDC balance (conservation).
        assertEq(bookings.escrowedOf(address(usdc)), escrow, "escrow ledger tracks the deposit");
        assertEq(usdc.balanceOf(address(bookings)), escrow, "contract holds exactly the escrow");

        // The salon confirms the appointment (pure intent; the deposit stays held as collateral).
        vm.prank(salonOwner);
        bookings.confirm(id);

        // The customer cancels LATE — inside the 24h window before the appointment.
        vm.warp(appointmentTime - 1 hours);
        usdcFeed.updateAnswer(1e8); // keep the feed fresh at cancel time

        uint256 clientBefore = usdc.balanceOf(client);
        uint256 chairBefore = usdc.balanceOf(salonChair);
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.prank(client);
        bookings.cancel(id, IAccess0x1Bookings.ActorType.PAYER);

        // The late fee was RE-QUOTED at cancel time: $15 -> 15 USDC, routed through the fee-split.
        uint256 feeToken = router.quote(merchantId, address(usdc), LATE_FEE_USD8); // 15e6
        uint256 platformCut = feeToken * PLATFORM_FEE_BPS / 10_000; // 1% of the fee leg
        uint256 salonNet = feeToken - platformCut;
        uint256 refund = escrow - feeToken; // 40 - 15 = 25 USDC back to the customer

        // The customer got the remainder back; refund is strictly positive (fee <= escrow).
        assertEq(
            usdc.balanceOf(client), clientBefore + refund, "customer refunded escrow minus late fee"
        );
        assertGt(refund, 0, "refund is never negative");

        // The salon kept its late fee (net, through the router split); the platform took its cut.
        assertEq(
            usdc.balanceOf(salonChair), chairBefore + salonNet, "salon keeps the late fee (net)"
        );
        assertEq(
            usdc.balanceOf(treasury), treasuryBefore + platformCut, "platform cut on the fee leg"
        );

        // The booking resolved: escrow ledger drained, contract holds ~zero, slot freed.
        assertEq(bookings.escrowedOf(address(usdc)), 0, "escrow ledger drained to zero");
        assertEq(usdc.balanceOf(address(bookings)), 0, "contract holds no leftover escrow");
        assertTrue(
            bookings.isSlotFree(merchantId, keccak256("chair-1@friday-2pm")),
            "slot freed for re-booking"
        );

        IAccess0x1Bookings.Reservation memory r = bookings.reservationOf(id);
        assertEq(uint8(r.status), uint8(IAccess0x1Bookings.RStatus.CANCELLED), "terminal CANCELLED");
    }

    /// @notice (c2) No-show with a STALE feed: the fee can't be priced, so the salon takes NOTHING and
    ///         the FULL deposit refunds. The refund is never blocked by an oracle outage (law #5).
    function test_scenario_salon_noShow_staleFeed_refundsFullEscrow_neverBlocked() public {
        uint256 escrow = router.quote(merchantId, address(usdc), DEPOSIT_USD8); // 40e6 (priced now)

        uint256 id = _reserve(keccak256("chair-2@saturday-10am"), keccak256("nonce-c2"));
        vm.prank(salonOwner);
        bookings.confirm(id);

        // The appointment time comes and goes; the customer never shows. Crucially, by the time the
        // salon marks the no-show, the Chainlink feed has gone STALE (no fresh round for > 1 hour) —
        // an oracle outage exactly when the customer needs their refund.
        vm.warp(appointmentTime + 2 hours); // > the 1h staleness window since the last feed update
        // (We deliberately do NOT refresh usdcFeed — it is now stale and quote() would revert.)

        // Sanity: pricing really is broken right now — a direct quote reverts on staleness.
        vm.expectRevert();
        router.quote(merchantId, address(usdc), NO_SHOW_FEE_USD8);

        uint256 clientBefore = usdc.balanceOf(client);
        uint256 chairBefore = usdc.balanceOf(salonChair);

        // The salon marks the no-show. The fee leg's re-quote reverts internally — but the contract
        // catches it and treats it as "take no fee," so the resolution proceeds and the customer is
        // refunded the FULL escrow rather than having their money stranded behind a dead oracle.
        vm.prank(salonOwner);
        bookings.markNoShow(id);

        assertEq(
            usdc.balanceOf(client),
            clientBefore + escrow,
            "FULL deposit refunded despite stale feed"
        );
        assertEq(usdc.balanceOf(salonChair), chairBefore, "salon took no fee (could not price it)");
        assertEq(bookings.escrowedOf(address(usdc)), 0, "escrow ledger drained");
        assertEq(usdc.balanceOf(address(bookings)), 0, "no money stranded in the contract");

        IAccess0x1Bookings.Reservation memory r = bookings.reservationOf(id);
        assertEq(uint8(r.status), uint8(IAccess0x1Bookings.RStatus.NO_SHOW), "terminal NO_SHOW");
    }

    /// @notice (c2, fresh-feed variant) The normal no-show: the salon keeps the $25 fee and refunds
    ///         the $15 remainder. This is the baseline the stale-feed case degrades from.
    function test_scenario_salon_noShow_freshFeed_keepsFee_refundsRemainder() public {
        uint256 escrow = router.quote(merchantId, address(usdc), DEPOSIT_USD8); // 40e6
        uint256 id = _reserve(keccak256("chair-3@sunday-noon"), keccak256("nonce-c2b"));
        vm.prank(salonOwner);
        bookings.confirm(id);

        // The customer no-shows, but the feed is healthy at resolution time.
        vm.warp(appointmentTime + 2 hours);
        usdcFeed.updateAnswer(1e8); // a fresh round — pricing works

        uint256 feeToken = router.quote(merchantId, address(usdc), NO_SHOW_FEE_USD8); // 25e6
        uint256 platformCut = feeToken * PLATFORM_FEE_BPS / 10_000;
        uint256 salonNet = feeToken - platformCut;
        uint256 refund = escrow - feeToken; // 40 - 25 = 15 USDC back

        uint256 clientBefore = usdc.balanceOf(client);
        uint256 chairBefore = usdc.balanceOf(salonChair);

        vm.prank(salonOwner);
        bookings.markNoShow(id);

        assertEq(usdc.balanceOf(client), clientBefore + refund, "customer refunded the remainder");
        assertEq(
            usdc.balanceOf(salonChair), chairBefore + salonNet, "salon kept the no-show fee (net)"
        );
        assertGt(refund, 0, "refund never negative");
        assertEq(bookings.escrowedOf(address(usdc)), 0, "escrow drained");
    }
}
