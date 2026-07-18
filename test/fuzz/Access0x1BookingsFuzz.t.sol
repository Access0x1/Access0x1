// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Bookings } from "../../src/Access0x1Bookings.sol";
import { IAccess0x1Bookings } from "../../src/interfaces/IAccess0x1Bookings.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { SessionGrant } from "../../src/SessionGrant.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { BlocklistToken } from "../mocks/BlocklistToken.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @title  Access0x1BookingsFuzz
/// @author Access0x1
/// @notice STATELESS (single-function) fuzz suite for {Access0x1Bookings} — the Cyfrin "fuzz each
///         public/external entry point with `bound()`-constrained inputs and assert the per-call
///         invariants hold" layer. This is the complement to the STATEFUL handler-driven invariant
///         suite (`test/invariant/Access0x1Bookings.invariant.t.sol`): there a long random call
///         sequence is replayed against ghost totals; here EACH money function is driven once over a
///         wide, independently-bounded input space and the conservation/clamp/never-negative-refund
///         properties are asserted at that single call boundary.
/// @dev    DISTINCT from the two round-trip fuzz tests in
///         `test/attack/Access0x1BookingsRoundTrip.attack.t.sol` (which fuzz the decimal/price space of
///         `complete` + `markNoShow` only). This file fuzzes the entry points those omit — `reserve`
///         escrow accounting, the permissionless `expireHold` refund, the FREE-window and LATE-window
///         `cancel` branches, and `claimRefund` — each over fuzzed deposit / fee / time / price inputs,
///         using the real composed Router (never a mock split). The single shared USDC feed is held at
///         a fresh round (time frozen) so the in-tx quote never goes stale; price-drift fuzzing is
///         already owned by the round-trip attack file, so it is deliberately not re-done here.
contract Access0x1BookingsFuzz is Test, ProxyDeployer {
    Access0x1Bookings internal bookings;
    Access0x1Router internal router;
    SessionGrant internal sessionGrant;

    MockV3Aggregator internal usdcFeed; // USDC/USD, 8 dp
    MockUSDC internal usdc; // 6 dp

    address internal admin = makeAddr("fz_admin");
    address internal treasury = makeAddr("fz_treasury");
    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%

    address internal merchantOwner = makeAddr("fz_merchantOwner");
    address internal payout = makeAddr("fz_payout");
    address internal feeRecipient = makeAddr("fz_feeRecipient");
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5%
    uint256 internal merchantId;

    address internal payer = makeAddr("fz_payer");

    /// @dev A far-future slot so the default (non-warped) reserve sits OUTSIDE the cancel window — the
    ///      free-cancel branch. Tests that need the late branch warp forward explicitly.
    uint64 internal constant SLOT_TS = 1_700_100_000;
    uint64 internal constant HOLD_SECS = 1 days;

    function setUp() public {
        // Frozen, fresh time: the single USDC/USD feed stays inside the staleness window for every
        // in-tx quote, so a fuzzed input never trips the oracle guard (price-drift is fuzzed elsewhere).
        vm.warp(1_700_000_000);

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (admin, treasury, PLATFORM_FEE_BPS))
            )
        );
        usdcFeed = new MockV3Aggregator(8, 1e8); // $1.00
        usdc = new MockUSDC();

        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        sessionGrant = SessionGrant(
            deployProxy(
                address(new SessionGrant()),
                abi.encodeCall(SessionGrant.initialize, ("Access0x1 SessionGrant", "1", admin))
            )
        );
        // Deploy Bookings behind a UUPS proxy (impl → ERC1967Proxy running initialize → cast).
        address bookingsImpl = address(new Access0x1Bookings());
        bookings = Access0x1Bookings(
            deployProxy(
                bookingsImpl,
                abi.encodeCall(
                    Access0x1Bookings.initialize, (admin, address(router), address(sessionGrant))
                )
            )
        );

        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, keccak256("m"));

        usdc.mint(payer, type(uint128).max);
        vm.prank(payer);
        usdc.approve(address(bookings), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _policy(uint32 windowSecs, uint256 lateUsd8, uint256 noShowUsd8)
        internal
        pure
        returns (IAccess0x1Bookings.Policy memory)
    {
        return IAccess0x1Bookings.Policy({
            cancelWindowSecs: windowSecs, lateFeeUsd8: lateUsd8, noShowFeeUsd8: noShowUsd8
        });
    }

    /// @dev The total token sitting at the three operator sinks (payout + treasury + feeRecipient).
    function _sinks() internal view returns (uint256) {
        return usdc.balanceOf(payout) + usdc.balanceOf(treasury) + usdc.balanceOf(feeRecipient);
    }

    /*//////////////////////////////////////////////////////////////
                              RESERVE (fuzz)
    //////////////////////////////////////////////////////////////*/

    /// @notice FUZZ {reserve}: across any in-range deposit, the escrow ledger, the contract's real
    ///         ERC-20 balance, and the stored record's `escrowAmount` must all agree EXACTLY with the
    ///         in-tx Router quote, the payer must be debited exactly that amount, and the slot + nonce
    ///         must be consumed. Proves the reserve leg neither creates nor loses backing for any
    ///         deposit (the conservation anchor is set correctly on entry).
    /// @param depositSeed Fuzzed deposit, bounded to $1 .. $10M (8-dp USD).
    /// @param slotSeed    Fuzzed opaque slot key (any 32-byte value is a valid slot).
    function testFuzz_reserveEscrowsExactlyQuotedAmount(uint256 depositSeed, bytes32 slotSeed)
        public
    {
        uint256 depositUsd8 = bound(depositSeed, 1e8, 10_000_000e8);
        uint256 expected = router.quote(merchantId, address(usdc), depositUsd8);
        // A dust deposit can quote to zero token at some decimal/price combos; this fixed $1+ floor on a
        // 6-dp $1 feed always quotes positive, so the reserve is always a real escrow.
        assertGt(expected, 0, "fixture should always quote positive");

        uint256 payerBefore = usdc.balanceOf(payer);

        vm.prank(payer);
        uint256 id = bookings.reserve(
            merchantId,
            slotSeed,
            SLOT_TS,
            address(usdc),
            depositUsd8,
            0,
            _policy(2 hours, 10e8, 20e8),
            HOLD_SECS,
            keccak256(abi.encode("nonce", depositSeed, slotSeed))
        );

        // Conservation on entry: ledger == real balance == record, payer debited exactly the escrow.
        assertEq(bookings.escrowedOf(address(usdc)), expected, "ledger != quoted escrow");
        assertEq(usdc.balanceOf(address(bookings)), expected, "balance != quoted escrow");
        assertEq(bookings.reservationOf(id).escrowAmount, expected, "record != quoted escrow");
        assertEq(payerBefore - usdc.balanceOf(payer), expected, "payer not debited exactly escrow");

        // Slot + nonce consumed; the booking is HELD and occupies its slot.
        assertEq(
            bookings.occupant(merchantId, slotSeed), id, "slot not occupied by this reservation"
        );
        assertTrue(
            bookings.nonceUsed(keccak256(abi.encode("nonce", depositSeed, slotSeed))),
            "nonce not consumed"
        );
        assertEq(uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.HELD));
    }

    /*//////////////////////////////////////////////////////////////
                            EXPIRE HOLD (fuzz)
    //////////////////////////////////////////////////////////////*/

    /// @notice FUZZ {expireHold}: for any deposit and any hold window, once the deadline has passed the
    ///         FULL escrow returns to the payer (no fee is ever taken on an expiry — it is a pure
    ///         refund), the escrow ledger zeroes, the contract holds zero of the token, and no operator
    ///         sink received anything. Proves expiry is a guaranteed, fee-free refund (law #5) for any
    ///         input, when called by the authorized payer (expiry is now payer/merchant-owner only).
    /// @param depositSeed Fuzzed deposit, $1 .. $1M.
    /// @param holdSeed    Fuzzed hold window in seconds (>= MIN_HOLD_SECS .. ~1yr).
    /// @param warpSeed    Fuzzed extra time past the deadline.
    function testFuzz_expireHoldRefundsFullEscrowFeeFree(
        uint256 depositSeed,
        uint64 holdSeed,
        uint64 warpSeed
    ) public {
        uint256 depositUsd8 = bound(depositSeed, 1e8, 1_000_000e8);
        uint64 holdSecs = uint64(bound(holdSeed, bookings.MIN_HOLD_SECS(), 365 days));
        uint64 past = uint64(bound(warpSeed, 1, 365 days)); // strictly past the deadline

        vm.prank(payer);
        uint256 id = bookings.reserve(
            merchantId,
            keccak256("expire-slot"),
            SLOT_TS,
            address(usdc),
            depositUsd8,
            0,
            _policy(2 hours, 10e8, 20e8),
            holdSecs,
            keccak256("expire-nonce")
        );
        uint256 escrow = bookings.reservationOf(id).escrowAmount;
        uint256 payerBefore = usdc.balanceOf(payer);
        uint256 sinksBefore = _sinks();

        // Past the deadline; the payer (an authorized party) triggers the refund.
        vm.warp(uint256(block.timestamp) + holdSecs + past);
        vm.prank(payer);
        bookings.expireHold(id);

        assertEq(usdc.balanceOf(payer) - payerBefore, escrow, "payer not fully refunded on expiry");
        assertEq(_sinks(), sinksBefore, "an operator sink took a fee on a pure expiry");
        assertEq(bookings.escrowedOf(address(usdc)), 0, "escrow ledger not drained");
        assertEq(usdc.balanceOf(address(bookings)), 0, "token stranded after expiry");
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.EXPIRED)
        );
        assertTrue(
            bookings.isSlotFree(merchantId, keccak256("expire-slot")), "slot not freed after expiry"
        );
    }

    /*//////////////////////////////////////////////////////////////
                          CANCEL — FREE WINDOW (fuzz)
    //////////////////////////////////////////////////////////////*/

    /// @notice FUZZ free-window {cancel}: a cancel strictly BEFORE `slotTimestamp - cancelWindowSecs`
    ///         refunds the FULL escrow no matter the policy fees, takes nothing for the operator, and
    ///         leaves zero on the contract. Proves the policy snapshot's late/no-show fees are
    ///         irrelevant outside the window — an early cancel is always whole — for any deposit/fee.
    /// @param depositSeed Fuzzed deposit, $1 .. $1M.
    /// @param lateSeed    Fuzzed (irrelevant-here) late fee, proving it is never charged early.
    /// @param windowSeed  Fuzzed cancel-window length.
    function testFuzz_cancelBeforeWindowRefundsFull(
        uint256 depositSeed,
        uint256 lateSeed,
        uint32 windowSeed
    ) public {
        uint256 depositUsd8 = bound(depositSeed, 1e8, 1_000_000e8);
        uint256 lateUsd8 = bound(lateSeed, 1e8, 5_000e8); // a real, possibly large late fee
        // Window must be short enough that "now" (block.timestamp) is strictly before the window start
        // (windowStart = slotTimestamp - window). Bound it under the slot/now gap so the FREE branch is
        // guaranteed; the LATE branch is fuzzed in the next test.
        uint256 gap = SLOT_TS - block.timestamp; // > 0 by fixture
        uint32 windowSecs = uint32(bound(windowSeed, 0, gap - 1));

        vm.prank(payer);
        uint256 id = bookings.reserve(
            merchantId,
            keccak256("free-slot"),
            SLOT_TS,
            address(usdc),
            depositUsd8,
            0,
            _policy(windowSecs, lateUsd8, 20e8),
            HOLD_SECS,
            keccak256("free-nonce")
        );
        uint256 escrow = bookings.reservationOf(id).escrowAmount;
        uint256 payerBefore = usdc.balanceOf(payer);
        uint256 sinksBefore = _sinks();

        vm.prank(payer);
        bookings.cancel(id, IAccess0x1Bookings.ActorType.PAYER);

        assertEq(usdc.balanceOf(payer) - payerBefore, escrow, "early cancel not a full refund");
        assertEq(_sinks(), sinksBefore, "operator took a fee on a free-window cancel");
        assertEq(bookings.escrowedOf(address(usdc)), 0, "escrow ledger not drained");
        assertEq(usdc.balanceOf(address(bookings)), 0, "token stranded after free cancel");
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.CANCELLED)
        );
    }

    /*//////////////////////////////////////////////////////////////
                          CANCEL — LATE WINDOW (fuzz)
    //////////////////////////////////////////////////////////////*/

    /// @notice FUZZ late-window {cancel}: a cancel INSIDE the window with a positive late fee routes the
    ///         fee through the real Router fee-split and refunds the exact remainder. The core money
    ///         invariants asserted per call: (1) routed-to-sinks + refunded-to-payer == the full escrow
    ///         (exact conservation — nothing created or lost), (2) the routed fee never exceeds the
    ///         clamped target (so the payer refund is never negative), and (3) the contract is left
    ///         holding ZERO of the token. Holds for any deposit / late-fee combination.
    /// @param depositSeed Fuzzed deposit, $1 .. $1M.
    /// @param lateSeed    Fuzzed late fee, $1 .. $100 (well below the deposit so the fee clamp is the
    ///                    re-quoted target, not the escrow — exercising the genuine fee-split path).
    function testFuzz_cancelInsideWindowConservesEscrowExactly(
        uint256 depositSeed,
        uint256 lateSeed
    ) public {
        uint256 depositUsd8 = bound(depositSeed, 1_000e8, 1_000_000e8); // big enough fee never clamps
        uint256 lateUsd8 = bound(lateSeed, 1e8, 100e8); // $1 .. $100 late fee

        vm.prank(payer);
        uint256 id = bookings.reserve(
            merchantId,
            keccak256("late-slot"),
            SLOT_TS,
            address(usdc),
            depositUsd8,
            0,
            _policy(2 hours, lateUsd8, 20e8),
            HOLD_SECS,
            keccak256("late-nonce")
        );
        uint256 escrow = bookings.reservationOf(id).escrowAmount;

        // Move strictly inside the cancel window (within 2h of the slot) and re-post the feed round so
        // the in-tx fee re-quote is fresh, not stale.
        vm.warp(SLOT_TS - 1 hours);
        usdcFeed.updateAnswer(1e8);

        uint256 feeTarget = router.quote(merchantId, address(usdc), lateUsd8); // expected gross fee
        uint256 payerBefore = usdc.balanceOf(payer);
        uint256 sinksBefore = _sinks();

        vm.prank(payer);
        bookings.cancel(id, IAccess0x1Bookings.ActorType.PAYER);

        uint256 routed = _sinks() - sinksBefore;
        uint256 refunded = usdc.balanceOf(payer) - payerBefore;

        assertEq(routed + refunded, escrow, "escrow not exactly conserved (created/lost value)");
        assertLe(routed, feeTarget, "routed fee exceeds the quoted target");
        assertLe(routed, escrow, "routed fee exceeds the held escrow (refund would be negative)");
        assertEq(usdc.balanceOf(address(bookings)), 0, "token dust stranded after late cancel");
        assertEq(bookings.escrowedOf(address(usdc)), 0, "escrow ledger not drained");
    }

    /*//////////////////////////////////////////////////////////////
                            CLAIM REFUND (fuzz)
    //////////////////////////////////////////////////////////////*/

    /// @notice FUZZ {claimRefund}: a claim only ever pays out EXACTLY what is owed and zeroes the credit
    ///         (pull-pattern), and a claim with nothing owed always reverts {NothingToClaim} — for any
    ///         caller and any owed amount. The owed credit is seeded through a REAL failed-push: the
    ///         repo's {BlocklistToken} (reused, not re-mocked) reverts the refund transfer to a blocked
    ///         payer, so the full escrow queues to the pull-map (law #5). The fuzzed dimension is the
    ///         deposit (hence the owed amount). Proves the pull-map neither over- nor under-pays.
    /// @param depositSeed Fuzzed deposit, $1 .. $1M (drives the owed escrow amount).
    function testFuzz_claimRefundPaysExactlyOwed(uint256 depositSeed) public {
        // First: a claim with nothing owed must always revert, regardless of who calls.
        address stranger = makeAddr("fz_stranger");
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__NothingToClaim.selector, address(usdc)
            )
        );
        bookings.claimRefund(address(usdc));

        // Seed an owed credit through a genuine failed-push using the repo's BlocklistToken (6-dp, USDC
        // shaped): a blocked recipient makes the refund transfer revert, so the lifecycle transition
        // queues the full escrow rather than blocking (law #5).
        uint256 depositUsd8 = bound(depositSeed, 1e8, 1_000_000e8);

        BlocklistToken bt = new BlocklistToken();
        vm.startPrank(admin);
        router.setTokenAllowed(address(bt), true);
        router.setPriceFeed(address(bt), address(usdcFeed)); // reuse the $1 feed
        vm.stopPrank();
        bt.mint(payer, type(uint96).max);
        vm.prank(payer);
        bt.approve(address(bookings), type(uint256).max);

        vm.prank(payer);
        uint256 id = bookings.reserve(
            merchantId,
            keccak256("claim-slot"),
            SLOT_TS,
            address(bt),
            depositUsd8,
            0,
            _policy(2 hours, 10e8, 20e8),
            HOLD_SECS,
            keccak256("claim-nonce")
        );
        uint256 escrow = bookings.reservationOf(id).escrowAmount;

        // Block the payer + expire: the refund push reverts inside the token transfer, so it queues.
        bt.setBlocked(payer, true);
        vm.warp(uint256(block.timestamp) + HOLD_SECS + 1);
        vm.prank(payer); // payer is authorized to expire their own hold
        bookings.expireHold(id); // must NOT revert despite the blocked push — it queues
        assertEq(bookings.refundRescueOf(payer, address(bt)), escrow, "refund not queued on block");

        // Unblock + claim: the claim pays out EXACTLY the owed escrow and zeroes the credit.
        bt.setBlocked(payer, false);
        uint256 payerBefore = bt.balanceOf(payer);
        vm.prank(payer);
        bookings.claimRefund(address(bt));

        assertEq(bt.balanceOf(payer) - payerBefore, escrow, "claim did not pay exactly owed");
        assertEq(bookings.refundRescueOf(payer, address(bt)), 0, "credit not zeroed");
        assertEq(bt.balanceOf(address(bookings)), 0, "token stranded after claim");

        // A second claim now reverts — the credit is exhausted, never double-payable.
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__NothingToClaim.selector, address(bt)
            )
        );
        bookings.claimRefund(address(bt));
    }
}
