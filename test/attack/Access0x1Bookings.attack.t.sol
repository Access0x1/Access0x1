// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Bookings } from "../../src/Access0x1Bookings.sol";
import { IAccess0x1Bookings } from "../../src/interfaces/IAccess0x1Bookings.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { BlocklistToken } from "../mocks/BlocklistToken.sol";

/// @notice Adversarial tests for Access0x1Bookings — exploit attempts, not happy-path coverage.
contract Access0x1BookingsAttackTest is Test {
    Access0x1Bookings internal bookings;
    Access0x1Router internal router;
    MockV3Aggregator internal usdcFeed;
    MockUSDC internal usdc;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal payer = makeAddr("payer");
    uint256 internal merchantId;

    uint64 internal constant SLOT_TS = 1_700_100_000;
    bytes32 internal constant SLOT_KEY = keccak256("slot");
    uint256 internal constant DEPOSIT_USD8 = 50e8;
    uint64 internal constant HOLD_SECS = 1 days;

    function setUp() public {
        vm.warp(1_700_000_000);
        router = new Access0x1Router(admin, treasury, 100); // 1%
        usdcFeed = new MockV3Aggregator(8, 1e8);
        usdc = new MockUSDC();
        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();
        bookings = new Access0x1Bookings(admin, address(router), address(0));
        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, 50, keccak256("m"));
        usdc.mint(payer, 1_000_000e6);
        vm.prank(payer);
        usdc.approve(address(bookings), type(uint256).max);
    }

    function _policy() internal pure returns (IAccess0x1Bookings.Policy memory) {
        return IAccess0x1Bookings.Policy({
            cancelWindowSecs: 2 hours, lateFeeUsd8: 10e8, noShowFeeUsd8: 20e8
        });
    }

    function _reserve(bytes32 nonce) internal returns (uint256 id) {
        vm.prank(payer);
        id = bookings.reserve(
            merchantId,
            SLOT_KEY,
            SLOT_TS,
            address(usdc),
            DEPOSIT_USD8,
            0,
            _policy(),
            HOLD_SECS,
            nonce
        );
    }

    /// @notice ATTACK: double-refund via claimRefund replay. After a refund is queued, the owed party
    ///         claims once; a second claim must revert (nothing owed) — CEI zeroes the credit first.
    function test_attack_doubleClaimRefundReverts() public {
        BlocklistToken bt = new BlocklistToken();
        vm.startPrank(admin);
        router.setTokenAllowed(address(bt), true);
        router.setPriceFeed(address(bt), address(usdcFeed));
        vm.stopPrank();
        bt.mint(payer, 1_000_000e6);
        vm.prank(payer);
        bt.approve(address(bookings), type(uint256).max);

        vm.prank(payer);
        uint256 id = bookings.reserve(
            merchantId,
            SLOT_KEY,
            SLOT_TS,
            address(bt),
            DEPOSIT_USD8,
            0,
            _policy(),
            HOLD_SECS,
            keccak256("n")
        );
        bt.setBlocked(payer, true);
        vm.warp(block.timestamp + HOLD_SECS + 1);
        bookings.expireHold(id); // refund queued

        bt.setBlocked(payer, false);
        vm.prank(payer);
        bookings.claimRefund(address(bt)); // first claim succeeds
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__NothingToClaim.selector, address(bt)
            )
        );
        bookings.claimRefund(address(bt)); // second claim finds nothing
    }

    /// @notice ATTACK: settle on a stale price. The feed last updated > 1h ago; {reserve} must revert
    ///         through the in-tx staleness guard rather than escrow against a bad quote.
    function test_attack_stalePriceBlocksReserve() public {
        usdcFeed.setRoundData(2, 1e8, block.timestamp, block.timestamp - 3601, 2);
        vm.prank(payer);
        vm.expectRevert(); // OracleLib__StalePrice bubbles up through quote()
        bookings.reserve(
            merchantId,
            SLOT_KEY,
            SLOT_TS,
            address(usdc),
            DEPOSIT_USD8,
            0,
            _policy(),
            HOLD_SECS,
            keccak256("n")
        );
    }

    /// @notice ATTACK: cancel-window fee gaming via price drift. The late fee is RE-QUOTED at cancel
    ///         time, and the fee taken can never exceed the escrow — so a payer cannot make the fee
    ///         exceed the deposit by crashing the token price, and an operator cannot inflate it past
    ///         the escrow by spiking the price (the clamp holds, refund ≥ 0).
    function test_attack_lateFeeNeverExceedsEscrow() public {
        uint256 id = _reserve(keccak256("n"));
        uint256 escrow = bookings.reservationOf(id).escrowAmount;

        // Spike the token value 100x so the $10 fee would quote to 100x the tokens (far above escrow).
        vm.warp(SLOT_TS - 1 hours);
        usdcFeed.updateAnswer(0.01e8); // token now worth $0.01 → $10 fee = 1000 tokens vs ~50 escrow

        uint256 payerBalBefore = usdc.balanceOf(payer);
        vm.prank(payer);
        bookings.cancel(id, IAccess0x1Bookings.ActorType.PAYER);

        // Fee clamped to escrow: payer gets back >= 0, contract holds zero, no negative refund.
        assertLe(usdc.balanceOf(payout), escrow); // operator never got more than the escrow
        assertGe(usdc.balanceOf(payer), payerBalBefore); // refund never negative
        assertEq(bookings.escrowedOf(address(usdc)), 0);
        assertEq(usdc.balanceOf(address(bookings)), 0);
    }

    /// @notice ATTACK: a refund to a payer that cannot receive (blocklisted) must NOT block the cancel
    ///         lifecycle — it lands in the pull-map (law #5, refunds never blocked).
    function test_attack_blockedRefundCannotBrickCancel() public {
        BlocklistToken bt = new BlocklistToken();
        vm.startPrank(admin);
        router.setTokenAllowed(address(bt), true);
        router.setPriceFeed(address(bt), address(usdcFeed));
        vm.stopPrank();
        bt.mint(payer, 1_000_000e6);
        vm.prank(payer);
        bt.approve(address(bookings), type(uint256).max);

        vm.prank(payer);
        uint256 id = bookings.reserve(
            merchantId,
            SLOT_KEY,
            SLOT_TS,
            address(bt),
            DEPOSIT_USD8,
            0,
            _policy(),
            HOLD_SECS,
            keccak256("n")
        );
        uint256 escrow = bookings.reservationOf(id).escrowAmount;

        // Block the payer, then cancel (free, before window) — the refund must queue, not revert.
        bt.setBlocked(payer, true);
        vm.prank(payer);
        bookings.cancel(id, IAccess0x1Bookings.ActorType.PAYER);

        assertEq(bookings.refundRescueOf(payer, address(bt)), escrow);
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.CANCELLED)
        );
    }

    /// @notice ATTACK: complete release when the merchant was deactivated post-reserve. The fee leg
    ///         (payToken) reverts on an inactive merchant; the try/catch must absorb it and refund the
    ///         FULL escrow to the payer rather than bricking complete or stranding the deposit.
    function test_attack_inactiveMerchantOnCompleteRefundsPayer() public {
        uint256 id = _reserve(keccak256("n"));
        uint256 escrow = bookings.reservationOf(id).escrowAmount;
        vm.prank(merchantOwner);
        bookings.confirm(id);

        // Operator deactivates the merchant on the Router — payToken would now revert MerchantInactive.
        vm.prank(merchantOwner);
        router.updateMerchant(merchantId, payout, feeRecipient, 50, false);

        uint256 payerBalBefore = usdc.balanceOf(payer);
        vm.prank(merchantOwner);
        bookings.complete(id); // must NOT revert

        // Fee leg failed → full escrow refunded to payer; no funds stranded; contract holds zero.
        assertEq(usdc.balanceOf(payer) - payerBalBefore, escrow);
        assertEq(usdc.balanceOf(payout), 0);
        assertEq(bookings.escrowedOf(address(usdc)), 0);
        assertEq(usdc.balanceOf(address(bookings)), 0);
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.COMPLETED)
        );
    }

    /// @notice ATTACK: slot-collision squat then release. While a slot is HELD a second reserve on the
    ///         same key reverts; after the holder expires/cancels the slot is reusable.
    function test_attack_slotSquatThenFree() public {
        uint256 id = _reserve(keccak256("n1"));
        IAccess0x1Bookings.Policy memory p = _policy();
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__SlotTaken.selector, SLOT_KEY, id
            )
        );
        bookings.reserve(
            merchantId,
            SLOT_KEY,
            SLOT_TS,
            address(usdc),
            DEPOSIT_USD8,
            0,
            p,
            HOLD_SECS,
            keccak256("n2")
        );

        vm.warp(block.timestamp + HOLD_SECS + 1);
        bookings.expireHold(id);
        usdcFeed.updateAnswer(1e8); // fresh round for the in-tx re-quote of the new reserve
        // Now free.
        vm.prank(payer);
        uint256 id2 = bookings.reserve(
            merchantId,
            SLOT_KEY,
            SLOT_TS,
            address(usdc),
            DEPOSIT_USD8,
            0,
            p,
            HOLD_SECS,
            keccak256("n3")
        );
        assertEq(bookings.occupant(SLOT_KEY), id2);
    }

    /// @dev Push the feed > 1h stale so the in-tx re-quote on a resolution leg reverts inside the
    ///      Router's OracleLib guard.
    function _staleFeed() internal {
        usdcFeed.setRoundData(99, 1e8, block.timestamp - 4000, block.timestamp - 4000, 99);
    }

    /// @notice ATTACK (law #5): a STALE oracle must not block a late CANCEL — and therefore must not
    ///         block the payer's refund. The late fee cannot be priced when the feed is dead, so the fee
    ///         leg takes NOTHING and the FULL escrow flows back to the payer; the cancel never reverts.
    ///         REGRESSION for the OPUS red-team finding (oracle outage froze the fee/refund paths because
    ///         the re-quote bubbled out before the never-blocked machinery ran).
    function test_attack_staleOracleDoesNotBlockLateCancelRefund() public {
        uint256 id = _reserve(keccak256("n"));
        uint256 escrow = bookings.reservationOf(id).escrowAmount;

        // Enter the late-cancel window (within 2h of the slot), then kill the feed.
        vm.warp(SLOT_TS - 1 hours);
        _staleFeed();

        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(payer);
        bookings.cancel(id, IAccess0x1Bookings.ActorType.PAYER); // MUST NOT revert

        // Oracle down → no fee priced → full escrow refunds; operator got nothing.
        assertEq(usdc.balanceOf(payer) - payerBefore, escrow);
        assertEq(usdc.balanceOf(payout), 0);
        assertEq(bookings.escrowedOf(address(usdc)), 0);
        assertEq(usdc.balanceOf(address(bookings)), 0);
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.CANCELLED)
        );
    }

    /// @notice ATTACK (law #5): a STALE oracle must not freeze a CONFIRMED no-show — the no-show fee
    ///         cannot be priced, so the operator keeps nothing and the FULL escrow refunds to the payer
    ///         rather than the deposit being stranded until the feed recovers.
    function test_attack_staleOracleDoesNotBlockNoShowRefund() public {
        uint256 id = _reserve(keccak256("n"));
        uint256 escrow = bookings.reservationOf(id).escrowAmount;
        vm.prank(merchantOwner);
        bookings.confirm(id);

        _staleFeed();
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(merchantOwner);
        bookings.markNoShow(id); // MUST NOT revert

        assertEq(usdc.balanceOf(payer) - payerBefore, escrow);
        assertEq(usdc.balanceOf(payout), 0);
        assertEq(bookings.escrowedOf(address(usdc)), 0);
        assertEq(usdc.balanceOf(address(bookings)), 0);
    }

    /// @notice ATTACK (law #5): a STALE oracle must not freeze a CONFIRMED complete — the release
    ///         cannot be priced, so it routes nothing and the FULL escrow refunds to the payer; the
    ///         deposit is never strandable behind a dead feed.
    function test_attack_staleOracleDoesNotStrandCompleteDeposit() public {
        uint256 id = _reserve(keccak256("n"));
        uint256 escrow = bookings.reservationOf(id).escrowAmount;
        vm.prank(merchantOwner);
        bookings.confirm(id);

        _staleFeed();
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(merchantOwner);
        bookings.complete(id); // MUST NOT revert

        assertEq(usdc.balanceOf(payer) - payerBefore, escrow);
        assertEq(usdc.balanceOf(payout), 0);
        assertEq(bookings.escrowedOf(address(usdc)), 0);
        assertEq(usdc.balanceOf(address(bookings)), 0);
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.COMPLETED)
        );
    }
}
