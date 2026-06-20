// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Bookings } from "../../src/Access0x1Bookings.sol";
import { IAccess0x1Bookings } from "../../src/interfaces/IAccess0x1Bookings.sol";
import { SessionGrant } from "../../src/SessionGrant.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";
import { OracleLib } from "../../src/libraries/OracleLib.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @title  Access0x1BookingsIntegration
/// @author Access0x1
/// @notice RACE-FREE INTEGRATION suite for {Access0x1Bookings} — the cross-contract composition layer.
///         The prior version of this file ran the production {DeployAll} script in `setUp`, which writes
///         deploy config through the process-global `vm.setEnv` (`ROUTER_OWNER` / `DEPLOY_PAYMENT_LANES`).
///         Run in isolation it passed; run inside the COMBINED suite it raced — the parallel integration
///         suites all mutate the same env keys, so a foreign suite could flip `ROUTER_OWNER` mid-`setUp`
///         and the net got mis-routed (the observed `0 != 73875000` flake). It was quarantined for that.
///
///         This re-add is DETERMINISTIC and shares NOTHING process-global: `setUp` `new`s the REAL
///         Router + SessionGrant + PaymentLanes + Bookings (over the real {OracleLib} staleness guard,
///         priced through a real {MockV3Aggregator}) and wires them by direct owner-pranked calls — no
///         script, no `vm.setEnv`, no shared deploy state. Two suites running this in parallel touch only
///         their own freshly-`new`d instances, so the composition is exercised end to end with zero race.
///         The {DeployAll} script's own wiring is covered separately by `test/unit/DeployAll.t.sol`.
///
///         What it proves through the WIRED stack (not a single contract in isolation):
///           1. reserve → confirm → complete: the held deposit RELEASES through the real Router fee-split,
///              netting to the merchant payout EXACTLY (`net + platformFee + merchantFee == gross`), with
///              the platform + merchant fee legs landing on their wired sinks and the contract left at 0.
///           2. reserve → late-cancel with a STALE feed: inside the cancel window, with a non-zero late
///              fee policy, a stale oracle makes the fee re-quote revert — yet law #5 holds: the operator
///              takes NOTHING and the FULL escrow refunds to the payer. Refund never blocked.
///           3. reserve → confirm → no-show with a STALE feed: same guarantee on the no-show leg — the
///              fee re-quote fails, the full escrow refunds, no sink is touched.
///           4. reserve → relayed cancel over the wired SessionGrant: a delegate the payer authorized
///              cancels without the payer's wallet, and the deposit refunds to the payer.
contract Access0x1BookingsIntegrationTest is Test, ProxyDeployer {
    /*//////////////////////////////////////////////////////////////
                                 ESTATE
    //////////////////////////////////////////////////////////////*/

    Access0x1Router internal router;
    SessionGrant internal sessionGrant;
    PaymentLanes internal lanes;
    Access0x1Bookings internal bookings;

    MockUSDC internal usdc; // 6-decimal USDC (the non-18 Arc-trap token)
    MockV3Aggregator internal usdcFeed; // USDC/USD, 8 decimals

    /*//////////////////////////////////////////////////////////////
                                 ACTORS
    //////////////////////////////////////////////////////////////*/

    address internal platformAdmin = makeAddr("bint_platformAdmin");
    address internal treasury = makeAddr("bint_treasury"); // platform fee leg lands here
    address internal merchantOwner = makeAddr("bint_merchantOwner");
    address internal payout = makeAddr("bint_payout"); // merchant net
    address internal feeRecipient = makeAddr("bint_feeRecipient"); // merchant surcharge leg
    address internal payer = makeAddr("bint_payer");

    /*//////////////////////////////////////////////////////////////
                               PARAMETERS
    //////////////////////////////////////////////////////////////*/

    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1.00% → treasury
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.50% surcharge → feeRecipient
    uint256 internal constant DEPOSIT_USD8 = 75e8; // $75.00 deposit, 8-dp USD unit
    uint64 internal constant HOLD_SECS = 1 days;
    bytes32 internal constant SLOT_KEY = keccak256("bint-slot-1");

    // The slot's service moment, and a cancel window wide enough that we can warp INTO it without
    // crossing the hold deadline — so a "late" cancel is exercised while the reservation is still HELD.
    uint64 internal slotTimestamp;
    uint32 internal constant CANCEL_WINDOW_SECS = 2 hours;

    uint256 internal merchantId;

    /// @notice Stand up + wire the REAL stack DIRECTLY (no DeployAll, no vm.setEnv), then register a
    ///         merchant and fund the payer. Every test runs against these freshly-`new`d instances, so
    ///         parallel suites never collide on shared process state.
    function setUp() public {
        // A non-zero, stable timestamp keeps the feed inside its 1-hour staleness window at reserve.
        vm.warp(1_700_000_000);
        // The slot is 1 day out; the 2-hour cancel window opens at slotTimestamp - 2h, which we can warp
        // into while still well before the 1-day hold deadline (so the booking stays HELD for the cancel).
        slotTimestamp = uint64(block.timestamp) + 1 days;

        // ── Deploy the real estate directly ──────────────────────────────────────────────────────
        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(
                    Access0x1Router.initialize, (platformAdmin, treasury, PLATFORM_FEE_BPS)
                )
            )
        );
        sessionGrant = SessionGrant(
            deployProxy(
                address(new SessionGrant()),
                abi.encodeCall(
                    SessionGrant.initialize, ("Access0x1 SessionGrant", "1", platformAdmin)
                )
            )
        );
        lanes = PaymentLanes(
            deployProxy(
                address(new PaymentLanes()),
                abi.encodeCall(PaymentLanes.initialize, (platformAdmin))
            )
        );
        // Deploy Bookings behind a UUPS proxy (impl → ERC1967Proxy running initialize → cast).
        address bookingsImpl = address(new Access0x1Bookings());
        bookings = Access0x1Bookings(
            deployProxy(
                bookingsImpl,
                abi.encodeCall(
                    Access0x1Bookings.initialize,
                    (platformAdmin, address(router), address(sessionGrant))
                )
            )
        );

        usdc = new MockUSDC();
        usdcFeed = new MockV3Aggregator(8, 1e8); // $1.00, 8-decimal feed

        // ── Wire the stack as the deploy script does, by direct owner calls (no env, no script) ───
        vm.startPrank(platformAdmin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        lanes.setRouter(address(router), true);
        router.setPaymentLanes(address(lanes));
        vm.stopPrank();

        // Bind the composition we are about to exercise (the wiring IS under test here too).
        assertEq(
            address(bookings.router()), address(router), "Bookings wired to a different router"
        );
        assertEq(
            address(bookings.sessionGrant()),
            address(sessionGrant),
            "Bookings wired to a different sessionGrant"
        );
        assertEq(bookings.owner(), platformAdmin, "Bookings owner mismatch");
        assertTrue(router.tokenAllowed(address(usdc)), "USDC not allowlisted");
        assertEq(router.priceFeedOf(address(usdc)), address(usdcFeed), "USDC feed not wired");

        // Register a merchant (permissionless; caller becomes owner) and fund the payer.
        vm.prank(merchantOwner);
        merchantId =
            router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, keccak256("bint_m"));

        usdc.mint(payer, 1_000_000e6);
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

    /// @dev Reserve a $75 deposit against `SLOT_KEY` with the given policy. Returns the id + held escrow.
    function _reserve(uint256 lateUsd8, uint256 noShowUsd8, bytes32 nonce)
        internal
        returns (uint256 id, uint256 escrow)
    {
        vm.prank(payer);
        id = bookings.reserve(
            merchantId,
            SLOT_KEY,
            slotTimestamp,
            address(usdc),
            DEPOSIT_USD8,
            0,
            _policy(CANCEL_WINDOW_SECS, lateUsd8, noShowUsd8),
            HOLD_SECS,
            nonce
        );
        escrow = bookings.reservationOf(id).escrowAmount;
    }

    /// @dev Force the wired USDC/USD feed stale: post a round whose `updatedAt` is older than the
    ///      OracleLib 1-hour staleness window relative to now. The next `router.quote` for USDC then
    ///      reverts {OracleLib__StalePrice} — exactly the oracle-outage the refund path must survive.
    function _staleFeed() internal {
        uint256 staleAt = block.timestamp - 2 hours; // > 3600s old ⇒ stale
        usdcFeed.setRoundData(2, 1e8, staleAt, staleAt, 2);
        // Prove the wired quote really reverts now, so the refund tests exercise the catch path.
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        router.quote(merchantId, address(usdc), 1e8);
    }

    /*//////////////////////////////////////////////////////////////
        HAPPY PATH — reserve → confirm → complete (net to merchant exactly)
    //////////////////////////////////////////////////////////////*/

    /// @notice The full settle path through the wired stack: the payer reserves a deposit priced through
    ///         the real Router/feed, the merchant confirms then completes, and the deposit releases
    ///         through the REAL Router fee-split. Because PaymentLanes is WIRED, the merchant's net is
    ///         credited as a non-custodial lane receipt (not pushed) — so we assert the net lands in the
    ///         merchant's lane EXACTLY, the fee legs hit their wired sinks, then the merchant CLAIMS the
    ///         lane out to real USDC at `payout`. Net to the merchant, exactly, through the full chain.
    function test_integration_reserveConfirmComplete_netsToMerchantExactly() public {
        (uint256 id, uint256 escrow) = _reserve(10e8, 20e8, keccak256("bint_n1"));

        // $75 at $1/USDC = 75e6 (6-dp USDC) — priced through the wired router/feed.
        assertEq(escrow, 75e6, "deposit not priced through the wired router/feed");
        assertEq(usdc.balanceOf(address(bookings)), escrow, "escrow not held by Bookings");
        assertEq(bookings.escrowedOf(address(usdc)), escrow, "escrow ledger not bumped");

        // Recompute the split independently from the wired config (no re-derivation of router internals).
        uint256 platformFee = escrow * router.platformFeeBps() / 10_000;
        uint256 merchantFee = escrow * MERCHANT_FEE_BPS / 10_000;
        uint256 net = escrow - platformFee - merchantFee;

        vm.prank(merchantOwner);
        bookings.confirm(id);
        vm.prank(merchantOwner);
        bookings.complete(id);

        // The deposit released through the real Router split: net → the merchant's wired lane receipt,
        // fee legs → their wired sinks. The lane holds exactly the net (non-custodial receipt).
        uint256 laneNet =
            lanes.balanceOf(payout, lanes.laneId(block.chainid, address(usdc), payout));
        assertEq(laneNet, net, "merchant net mis-routed into the wired lane");
        assertEq(usdc.balanceOf(treasury), platformFee, "platform fee mis-routed");
        assertEq(usdc.balanceOf(feeRecipient), merchantFee, "merchant surcharge mis-routed");
        assertEq(
            net + platformFee + merchantFee, escrow, "split is not conservative (net+fee==gross)"
        );

        // The merchant claims the lane out to real USDC at `payout` — net to the merchant, exactly.
        vm.prank(payout);
        lanes.claim(address(usdc));
        assertEq(
            usdc.balanceOf(payout), net, "merchant did not net the deposit exactly after claim"
        );

        // Bookings drained, ledger drained, terminal status, slot reusable.
        assertEq(usdc.balanceOf(address(bookings)), 0, "Bookings left holding token");
        assertEq(bookings.escrowedOf(address(usdc)), 0, "escrow ledger not drained");
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.COMPLETED)
        );
        assertTrue(bookings.isSlotFree(SLOT_KEY), "slot not freed for reuse");
    }

    /*//////////////////////////////////////////////////////////////
        REFUND-NEVER-BLOCKED — late cancel inside the window on a STALE feed
    //////////////////////////////////////////////////////////////*/

    /// @notice Law #5 through the wired stack: a payer cancels INSIDE the cancel window, under a policy
    ///         with a real non-zero late fee, but the oracle has gone stale. The fee re-quote reverts;
    ///         rather than bricking the refund, the operator takes NOTHING and the FULL escrow returns to
    ///         the payer. A stale feed can never block a refund — and never strand it on a sink either.
    function test_integration_lateCancelRefundsFullyEvenOnStaleFeed() public {
        (uint256 id, uint256 escrow) = _reserve(10e8, 20e8, keccak256("bint_n2"));

        // Move INTO the cancel window (slotTimestamp - 2h ≤ now < hold deadline). Still HELD: the cancel
        // here is a LATE cancel that would normally charge the 10e8 late fee.
        vm.warp(slotTimestamp - CANCEL_WINDOW_SECS + 1);
        assertLt(block.timestamp, bookings.reservationOf(id).holdExpiresAt, "must still be HELD");

        // Now break the oracle: the late-fee re-quote will revert {OracleLib__StalePrice}.
        _staleFeed();

        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(payer);
        bookings.cancel(id, IAccess0x1Bookings.ActorType.PAYER);

        // FULL refund despite being a late cancel with a non-zero fee policy — the stale feed zeroed the
        // fee leg, never the refund.
        assertEq(
            usdc.balanceOf(payer) - payerBefore,
            escrow,
            "late cancel did not fully refund on stale feed"
        );
        assertEq(usdc.balanceOf(payout), 0, "operator took a fee while the feed was stale");
        assertEq(usdc.balanceOf(treasury), 0, "platform took a fee while the feed was stale");
        assertEq(
            usdc.balanceOf(feeRecipient), 0, "merchant surcharge taken while the feed was stale"
        );
        assertEq(
            usdc.balanceOf(address(bookings)), 0, "Bookings left holding token after stale cancel"
        );
        assertEq(bookings.escrowedOf(address(usdc)), 0, "escrow ledger not drained on stale cancel");
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.CANCELLED)
        );
        assertTrue(bookings.isSlotFree(SLOT_KEY), "slot not freed after stale cancel");
    }

    /// @notice Law #5 on the no-show leg through the wired stack: a CONFIRMED booking is marked a no-show
    ///         while the oracle is stale. The no-show-fee re-quote reverts, so the operator keeps NOTHING
    ///         and the full escrow refunds to the payer. The merchant's intended fee is sacrificed before
    ///         the payer's guaranteed refund — never the other way around.
    function test_integration_noShowRefundsFullyEvenOnStaleFeed() public {
        (uint256 id, uint256 escrow) = _reserve(10e8, 20e8, keccak256("bint_n3"));

        vm.prank(merchantOwner);
        bookings.confirm(id);

        // Stale the feed, then mark the no-show: the re-quote of the 20e8 no-show fee reverts.
        _staleFeed();

        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(merchantOwner);
        bookings.markNoShow(id);

        assertEq(
            usdc.balanceOf(payer) - payerBefore,
            escrow,
            "no-show did not fully refund on stale feed"
        );
        assertEq(usdc.balanceOf(payout), 0, "operator kept a no-show fee while the feed was stale");
        assertEq(usdc.balanceOf(treasury), 0, "platform took a fee while the feed was stale");
        assertEq(
            usdc.balanceOf(address(bookings)), 0, "Bookings left holding token after stale no-show"
        );
        assertEq(
            bookings.escrowedOf(address(usdc)), 0, "escrow ledger not drained on stale no-show"
        );
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.NO_SHOW)
        );
    }

    /*//////////////////////////////////////////////////////////////
        SESSION PATH — relayed cancel over the WIRED SessionGrant
    //////////////////////////////////////////////////////////////*/

    /// @notice The relayed-cancel path exercises the REAL composition of Bookings with the wired
    ///         SessionGrant: the payer opens a manage-session delegating a relayer, the relayer cancels
    ///         the payer's booking WITHOUT the payer's wallet, and the deposit refunds to the payer.
    ///         Proves Bookings honors sessions from the SAME SessionGrant it was constructed with.
    function test_integration_cancelWithSessionRefundsPayer() public {
        (uint256 id, uint256 escrow) = _reserve(10e8, 20e8, keccak256("bint_n4"));
        address relayer = makeAddr("bint_relayer");

        // The payer opens a session on the WIRED SessionGrant (nonce 0 = the payer's first session)
        // AND allowlists the relayer for cancels — both consents are required (M-2 confused-deputy fix).
        vm.prank(payer);
        sessionGrant.openSession(relayer, 1e18, uint64(block.timestamp + 1 days));
        vm.prank(payer);
        bookings.setCancelRelayer(relayer, true);

        // Free cancel (well before the cancel window) ⇒ full escrow refunds to the payer.
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(relayer);
        bookings.cancelWithSession(id, 0, IAccess0x1Bookings.ActorType.PAYER);

        assertEq(usdc.balanceOf(payer) - payerBefore, escrow, "session cancel did not refund payer");
        assertEq(usdc.balanceOf(payout), 0, "operator took a fee on a free session cancel");
        assertEq(
            bookings.escrowedOf(address(usdc)), 0, "escrow ledger not drained on session cancel"
        );
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.CANCELLED)
        );
        assertTrue(bookings.isSlotFree(SLOT_KEY), "slot not freed after session cancel");
    }
}
