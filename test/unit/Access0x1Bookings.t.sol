// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Access0x1Bookings } from "../../src/Access0x1Bookings.sol";
import { IAccess0x1Bookings } from "../../src/interfaces/IAccess0x1Bookings.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { SessionGrant } from "../../src/SessionGrant.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { FeeOnTransferToken } from "../mocks/FeeOnTransferToken.sol";
import { BlocklistToken } from "../mocks/BlocklistToken.sol";
import { MockReturnsNothingToken } from "../mocks/MockReturnsNothingToken.sol";

/// @notice The Access0x1Bookings unit suite — the full lifecycle in one fixture: reserve, confirm,
///         complete, expire, cancel (free / late-fee / blocked), no-show, and the refund pull-map. The
///         escrow flows through a real Router (composed, never mocked), so every release/fee leg is the
///         actual fee-split.
contract Access0x1BookingsTest is Test {
    Access0x1Bookings internal bookings;
    Access0x1Router internal router;
    SessionGrant internal sessionGrant;

    MockV3Aggregator internal usdcFeed; // USDC/USD, 8 dp
    MockUSDC internal usdc; // 6 dp

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%

    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient");
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5%
    uint256 internal merchantId;

    address internal payer = makeAddr("payer");

    uint64 internal constant SLOT_TS = 1_700_100_000;
    bytes32 internal constant SLOT_KEY = keccak256("slot-A");
    uint256 internal constant DEPOSIT_USD8 = 50e8; // $50
    uint64 internal constant HOLD_SECS = 1 days;

    function setUp() public virtual {
        vm.warp(1_700_000_000);

        router = new Access0x1Router(admin, treasury, PLATFORM_FEE_BPS);
        usdcFeed = new MockV3Aggregator(8, 1e8); // $1
        usdc = new MockUSDC();

        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        sessionGrant = new SessionGrant("Access0x1 SessionGrant", "1");
        bookings = new Access0x1Bookings(admin, address(router), address(sessionGrant));

        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, keccak256("m"));

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

    function _reserve(bytes32 slotKey, bytes32 nonce)
        internal
        returns (uint256 id, uint256 escrow)
    {
        IAccess0x1Bookings.Policy memory p = _policy(2 hours, 10e8, 20e8); // $10 late, $20 no-show
        vm.prank(payer);
        id = bookings.reserve(
            merchantId, slotKey, SLOT_TS, address(usdc), DEPOSIT_USD8, 0, p, HOLD_SECS, nonce
        );
        escrow = bookings.reservationOf(id).escrowAmount;
    }

    /// @dev The Router fee-split for a given gross, recomputed independently.
    function _split(uint256 gross)
        internal
        pure
        returns (uint256 platformFee, uint256 merchantFee, uint256 net)
    {
        platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        net = gross - platformFee - merchantFee;
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_constructorSetsState() public view {
        assertEq(bookings.owner(), admin);
        assertEq(address(bookings.router()), address(router));
        assertEq(address(bookings.sessionGrant()), address(sessionGrant));
        assertEq(bookings.nextReservationId(), 1);
    }

    function test_constructorRevertsOnZeroRouter() public {
        vm.expectRevert(IAccess0x1Bookings.Access0x1Bookings__ZeroAddress.selector);
        new Access0x1Bookings(admin, address(0), address(sessionGrant));
    }

    function test_constructorAllowsZeroSessionGrant() public {
        Access0x1Bookings b = new Access0x1Bookings(admin, address(router), address(0));
        assertEq(address(b.sessionGrant()), address(0));
    }

    /*//////////////////////////////////////////////////////////////
                                RESERVE
    //////////////////////////////////////////////////////////////*/

    function test_reserveEscrowsDepositAndOccupiesSlot() public {
        uint256 expectedEscrow = router.quote(merchantId, address(usdc), DEPOSIT_USD8);

        vm.expectEmit(true, true, true, true, address(bookings));
        emit IAccess0x1Bookings.SlotHeld(
            1,
            merchantId,
            payer,
            SLOT_KEY,
            address(usdc),
            expectedEscrow,
            uint64(block.timestamp) + HOLD_SECS
        );
        (uint256 id, uint256 escrow) = _reserve(SLOT_KEY, keccak256("n1"));

        assertEq(id, 1);
        assertEq(escrow, expectedEscrow);
        assertEq(usdc.balanceOf(address(bookings)), escrow);
        assertEq(bookings.escrowedOf(address(usdc)), escrow);
        assertEq(bookings.occupant(SLOT_KEY), id);
        assertFalse(bookings.isSlotFree(SLOT_KEY));

        IAccess0x1Bookings.Reservation memory r = bookings.reservationOf(id);
        assertEq(uint8(r.status), uint8(IAccess0x1Bookings.RStatus.HELD));
        assertEq(r.payer, payer);
        assertEq(r.merchantId, merchantId);
        assertEq(r.depositUsd8, DEPOSIT_USD8);
        assertEq(r.policy.lateFeeUsd8, 10e8);
        assertEq(r.policy.noShowFeeUsd8, 20e8);
    }

    function test_reserveRevertsOnSlotTaken() public {
        _reserve(SLOT_KEY, keccak256("n1"));
        IAccess0x1Bookings.Policy memory p = _policy(2 hours, 10e8, 20e8);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__SlotTaken.selector, SLOT_KEY, 1
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
    }

    function test_reserveRevertsOnReusedNonce() public {
        _reserve(SLOT_KEY, keccak256("dup"));
        IAccess0x1Bookings.Policy memory p = _policy(2 hours, 10e8, 20e8);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__NonceUsed.selector, keccak256("dup")
            )
        );
        bookings.reserve(
            merchantId,
            keccak256("slot-B"),
            SLOT_TS,
            address(usdc),
            DEPOSIT_USD8,
            0,
            p,
            HOLD_SECS,
            keccak256("dup")
        );
    }

    function test_reserveRevertsOnZeroDeposit() public {
        IAccess0x1Bookings.Policy memory p = _policy(2 hours, 10e8, 20e8);
        vm.prank(payer);
        vm.expectRevert(IAccess0x1Bookings.Access0x1Bookings__ZeroAmount.selector);
        bookings.reserve(
            merchantId, SLOT_KEY, SLOT_TS, address(usdc), 0, 0, p, HOLD_SECS, keccak256("n")
        );
    }

    function test_reserveRevertsOnZeroToken() public {
        IAccess0x1Bookings.Policy memory p = _policy(2 hours, 10e8, 20e8);
        vm.prank(payer);
        vm.expectRevert(IAccess0x1Bookings.Access0x1Bookings__ZeroAddress.selector);
        bookings.reserve(
            merchantId, SLOT_KEY, SLOT_TS, address(0), DEPOSIT_USD8, 0, p, HOLD_SECS, keccak256("n")
        );
    }

    function test_reserveRevertsOnUnknownMerchant() public {
        IAccess0x1Bookings.Policy memory p = _policy(2 hours, 10e8, 20e8);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__MerchantNotFound.selector, 999
            )
        );
        bookings.reserve(
            999, SLOT_KEY, SLOT_TS, address(usdc), DEPOSIT_USD8, 0, p, HOLD_SECS, keccak256("n")
        );
    }

    function test_reserveRejectsFeeOnTransferToken() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        vm.startPrank(admin);
        router.setTokenAllowed(address(fot), true);
        router.setPriceFeed(address(fot), address(usdcFeed));
        vm.stopPrank();
        fot.mint(payer, 1_000_000e6);
        vm.prank(payer);
        fot.approve(address(bookings), type(uint256).max);

        IAccess0x1Bookings.Policy memory p = _policy(2 hours, 10e8, 20e8);
        vm.prank(payer);
        vm.expectRevert(); // FeeOnTransferToken delta check
        bookings.reserve(
            merchantId,
            SLOT_KEY,
            SLOT_TS,
            address(fot),
            DEPOSIT_USD8,
            0,
            p,
            HOLD_SECS,
            keccak256("n")
        );
    }

    /*//////////////////////////////////////////////////////////////
                                CONFIRM
    //////////////////////////////////////////////////////////////*/

    function test_confirmIsPureIntentNoMoneyMoves() public {
        (uint256 id, uint256 escrow) = _reserve(SLOT_KEY, keccak256("n1"));

        vm.expectEmit(true, false, false, false, address(bookings));
        emit IAccess0x1Bookings.Confirmed(id);
        vm.prank(merchantOwner);
        bookings.confirm(id);

        // Escrow still held — confirm is intent, not settlement.
        assertEq(usdc.balanceOf(address(bookings)), escrow);
        assertEq(bookings.escrowedOf(address(usdc)), escrow);
        assertEq(usdc.balanceOf(payout), 0);
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.CONFIRMED)
        );
        // CONFIRMED still occupies the slot.
        assertEq(bookings.occupant(SLOT_KEY), id);
    }

    function test_confirmOnlyMerchantOwner() public {
        (uint256 id,) = _reserve(SLOT_KEY, keccak256("n1"));
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__NotMerchantOwner.selector, merchantId, payer
            )
        );
        bookings.confirm(id);
    }

    function test_confirmRevertsIfNotHeld() public {
        (uint256 id,) = _reserve(SLOT_KEY, keccak256("n1"));
        vm.prank(merchantOwner);
        bookings.confirm(id);
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__WrongStatus.selector,
                id,
                IAccess0x1Bookings.RStatus.CONFIRMED,
                IAccess0x1Bookings.RStatus.HELD
            )
        );
        bookings.confirm(id);
    }

    /*//////////////////////////////////////////////////////////////
                                COMPLETE
    //////////////////////////////////////////////////////////////*/

    function test_completeReleasesThroughFeeSplitAndFreesSlot() public {
        (uint256 id, uint256 escrow) = _reserve(SLOT_KEY, keccak256("n1"));
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _split(escrow);

        vm.prank(merchantOwner);
        bookings.confirm(id);
        vm.prank(merchantOwner);
        bookings.complete(id);

        // Escrow fully released, fee-split delivered to the real sinks.
        assertEq(usdc.balanceOf(address(bookings)), 0);
        assertEq(bookings.escrowedOf(address(usdc)), 0);
        assertEq(usdc.balanceOf(payout), net);
        assertEq(usdc.balanceOf(treasury), platformFee);
        assertEq(usdc.balanceOf(feeRecipient), merchantFee);
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.COMPLETED)
        );
        assertTrue(bookings.isSlotFree(SLOT_KEY)); // slot freed for reuse
    }

    function test_completeRefundsSurplusWhenTokenAppreciates() public {
        (uint256 id, uint256 escrow) = _reserve(SLOT_KEY, keccak256("n1"));
        vm.prank(merchantOwner);
        bookings.confirm(id);
        // Token doubles in USD value: the same $50 now needs HALF the token, so the escrow has surplus.
        usdcFeed.updateAnswer(2e8); // USDC/USD = $2

        uint256 payerBalBefore = usdc.balanceOf(payer);
        vm.prank(merchantOwner);
        bookings.complete(id);

        uint256 grossNow = escrow / 2; // ~half the tokens cover the same USD
        assertApproxEqAbs(usdc.balanceOf(payer) - payerBalBefore, escrow - grossNow, 2);
        assertEq(usdc.balanceOf(address(bookings)), 0);
        assertEq(bookings.escrowedOf(address(usdc)), 0);
    }

    function test_completeOnlyMerchantOwnerAndConfirmed() public {
        (uint256 id,) = _reserve(SLOT_KEY, keccak256("n1"));
        // Not confirmed yet.
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__WrongStatus.selector,
                id,
                IAccess0x1Bookings.RStatus.HELD,
                IAccess0x1Bookings.RStatus.CONFIRMED
            )
        );
        bookings.complete(id);
    }

    /*//////////////////////////////////////////////////////////////
                              EXPIRE HOLD
    //////////////////////////////////////////////////////////////*/

    function test_expireHoldRefundsPayerPermissionlessly() public {
        (uint256 id, uint256 escrow) = _reserve(SLOT_KEY, keccak256("n1"));
        uint256 payerBalBefore = usdc.balanceOf(payer);

        vm.warp(block.timestamp + HOLD_SECS + 1);
        address keeper = makeAddr("keeper");
        vm.prank(keeper); // permissionless
        bookings.expireHold(id);

        assertEq(usdc.balanceOf(payer) - payerBalBefore, escrow);
        assertEq(usdc.balanceOf(address(bookings)), 0);
        assertEq(bookings.escrowedOf(address(usdc)), 0);
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.EXPIRED)
        );
        assertTrue(bookings.isSlotFree(SLOT_KEY));
    }

    function test_expireHoldRevertsBeforeDeadline() public {
        (uint256 id,) = _reserve(SLOT_KEY, keccak256("n1"));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__HoldNotExpired.selector,
                id,
                uint64(block.timestamp) + HOLD_SECS,
                block.timestamp
            )
        );
        bookings.expireHold(id);
    }

    function test_expireRefundToBlocklistedPayerGoesToRescue() public {
        // Use a blocklist token whose holder (payer) can be blocked from receiving.
        BlocklistToken bt = new BlocklistToken();
        vm.startPrank(admin);
        router.setTokenAllowed(address(bt), true);
        router.setPriceFeed(address(bt), address(usdcFeed));
        vm.stopPrank();
        bt.mint(payer, 1_000_000e6);
        vm.prank(payer);
        bt.approve(address(bookings), type(uint256).max);

        IAccess0x1Bookings.Policy memory p = _policy(2 hours, 10e8, 20e8);
        vm.prank(payer);
        uint256 id = bookings.reserve(
            merchantId,
            SLOT_KEY,
            SLOT_TS,
            address(bt),
            DEPOSIT_USD8,
            0,
            p,
            HOLD_SECS,
            keccak256("n")
        );
        uint256 escrow = bookings.reservationOf(id).escrowAmount;

        // Block the payer from receiving; the refund push must NOT revert — it queues.
        bt.setBlocked(payer, true);
        vm.warp(block.timestamp + HOLD_SECS + 1);
        bookings.expireHold(id);

        assertEq(bookings.refundRescueOf(payer, address(bt)), escrow);
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.EXPIRED)
        );

        // Unblock + claim.
        bt.setBlocked(payer, false);
        vm.prank(payer);
        bookings.claimRefund(address(bt));
        assertEq(bookings.refundRescueOf(payer, address(bt)), 0);
        assertEq(bt.balanceOf(address(bookings)), 0);
    }

    function test_claimRefundRevertsWhenNothingOwed() public {
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__NothingToClaim.selector, address(usdc)
            )
        );
        bookings.claimRefund(address(usdc));
    }

    /*//////////////////////////////////////////////////////////////
                                CANCEL
    //////////////////////////////////////////////////////////////*/

    function test_cancelFreeRefundsFullBeforeWindow() public {
        (uint256 id, uint256 escrow) = _reserve(SLOT_KEY, keccak256("n1"));
        // Now is well before slotTimestamp - 2h, so it's a free cancel.
        uint256 payerBalBefore = usdc.balanceOf(payer);
        vm.prank(payer);
        bookings.cancel(id, IAccess0x1Bookings.ActorType.PAYER);

        assertEq(usdc.balanceOf(payer) - payerBalBefore, escrow); // full refund
        assertEq(usdc.balanceOf(payout), 0); // no fee taken
        assertEq(bookings.escrowedOf(address(usdc)), 0);
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.CANCELLED)
        );
        assertTrue(bookings.isSlotFree(SLOT_KEY));
    }

    function test_cancelLateTakesFeeThroughSplit() public {
        (uint256 id, uint256 escrow) = _reserve(SLOT_KEY, keccak256("n1"));
        // Move inside the late window (within 2h of the slot) and post a fresh feed round.
        vm.warp(SLOT_TS - 1 hours);
        usdcFeed.updateAnswer(1e8); // fresh round so the in-tx quote is not stale

        uint256 feeTokens = router.quote(merchantId, address(usdc), 10e8); // $10 late fee in token
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _split(feeTokens);
        uint256 payerBalBefore = usdc.balanceOf(payer);

        vm.prank(merchantOwner);
        bookings.cancel(id, IAccess0x1Bookings.ActorType.MERCHANT);

        // Late fee routed through the fee-split; remainder refunded.
        assertEq(usdc.balanceOf(payout), net);
        assertEq(usdc.balanceOf(treasury), platformFee);
        assertEq(usdc.balanceOf(feeRecipient), merchantFee);
        assertApproxEqAbs(usdc.balanceOf(payer) - payerBalBefore, escrow - feeTokens, 2);
        assertEq(usdc.balanceOf(address(bookings)), 0);
        assertEq(bookings.escrowedOf(address(usdc)), 0);
    }

    function test_cancelLateBlockedWhenNoLateFee() public {
        IAccess0x1Bookings.Policy memory p = _policy(2 hours, 0, 20e8); // lateFee 0 = blocked
        vm.prank(payer);
        uint256 id = bookings.reserve(
            merchantId,
            SLOT_KEY,
            SLOT_TS,
            address(usdc),
            DEPOSIT_USD8,
            0,
            p,
            HOLD_SECS,
            keccak256("n")
        );
        vm.warp(SLOT_TS - 1 hours); // inside the window
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__CancellationWindowActive.selector, id
            )
        );
        bookings.cancel(id, IAccess0x1Bookings.ActorType.PAYER);
    }

    function test_cancelUnauthorizedReverts() public {
        (uint256 id,) = _reserve(SLOT_KEY, keccak256("n1"));
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__NotAuthorized.selector, id, stranger
            )
        );
        bookings.cancel(id, IAccess0x1Bookings.ActorType.PAYER);
    }

    function test_cancelConfirmedRefundsHeldEscrow() public {
        // Escrow is held through CONFIRMED, so a free cancel after confirm refunds it in full.
        (uint256 id, uint256 escrow) = _reserve(SLOT_KEY, keccak256("n1"));
        vm.prank(merchantOwner);
        bookings.confirm(id);

        uint256 payerBalBefore = usdc.balanceOf(payer);
        vm.prank(payer);
        bookings.cancel(id, IAccess0x1Bookings.ActorType.PAYER);

        assertEq(usdc.balanceOf(payer) - payerBalBefore, escrow); // full refund (before window)
        assertEq(bookings.escrowedOf(address(usdc)), 0);
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.CANCELLED)
        );
        assertTrue(bookings.isSlotFree(SLOT_KEY));
    }

    /*//////////////////////////////////////////////////////////////
                                NO-SHOW
    //////////////////////////////////////////////////////////////*/

    function test_noShowKeepsFeeRefundsRemainder() public {
        (uint256 id, uint256 escrow) = _reserve(SLOT_KEY, keccak256("n1"));
        vm.prank(merchantOwner);
        bookings.confirm(id); // escrow held through CONFIRMED

        uint256 feeTokens = router.quote(merchantId, address(usdc), 20e8); // $20 no-show fee in token
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _split(feeTokens);
        uint256 payerBalBefore = usdc.balanceOf(payer);

        vm.prank(merchantOwner);
        bookings.markNoShow(id);

        // No-show fee routed through the fee-split; remainder refunded to payer.
        assertEq(usdc.balanceOf(payout), net);
        assertEq(usdc.balanceOf(treasury), platformFee);
        assertEq(usdc.balanceOf(feeRecipient), merchantFee);
        assertApproxEqAbs(usdc.balanceOf(payer) - payerBalBefore, escrow - feeTokens, 2);
        assertEq(usdc.balanceOf(address(bookings)), 0);
        assertEq(bookings.escrowedOf(address(usdc)), 0);
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.NO_SHOW)
        );
        assertTrue(bookings.isSlotFree(SLOT_KEY));
    }

    function test_noShowOnlyMerchantOwner() public {
        (uint256 id,) = _reserve(SLOT_KEY, keccak256("n1"));
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__WrongStatus.selector,
                id,
                IAccess0x1Bookings.RStatus.HELD,
                IAccess0x1Bookings.RStatus.CONFIRMED
            )
        );
        bookings.markNoShow(id);
    }

    /*//////////////////////////////////////////////////////////////
                          CANCEL VIA SESSION (manage-token)
    //////////////////////////////////////////////////////////////*/

    function test_cancelWithSessionByPayerDelegate() public {
        (uint256 id, uint256 escrow) = _reserve(SLOT_KEY, keccak256("n1"));
        address relayer = makeAddr("relayer");

        // The payer opens a manage-session delegating the relayer (nonce 0, the first session) AND
        // separately allowlists the relayer for cancels — both consents are now required (M-2).
        vm.prank(payer);
        sessionGrant.openSession(relayer, 1e18, uint64(block.timestamp + 1 days));
        vm.prank(payer);
        bookings.setCancelRelayer(relayer, true);

        uint256 payerBalBefore = usdc.balanceOf(payer);
        vm.prank(relayer);
        bookings.cancelWithSession(id, 0, IAccess0x1Bookings.ActorType.PAYER);

        assertEq(usdc.balanceOf(payer) - payerBalBefore, escrow); // free cancel, full refund to payer
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.CANCELLED)
        );
    }

    /// @notice M-2 regression: a relayer the payer opened a LIVE session for but never allowlisted for
    ///         cancels is REJECTED — a generic agent-budget session can no longer be repurposed as
    ///         cancel authority (the confused-deputy fix). Adding the allowlist opt-in then succeeds.
    function test_cancelWithSessionRejectsUnapprovedRelayer() public {
        (uint256 id, uint256 escrow) = _reserve(SLOT_KEY, keccak256("n1"));
        address relayer = makeAddr("relayer");

        // A live session, but NO setCancelRelayer opt-in: the second consent gate is missing.
        vm.prank(payer);
        sessionGrant.openSession(relayer, 1e18, uint64(block.timestamp + 1 days));

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__NotAuthorized.selector, id, relayer
            )
        );
        bookings.cancelWithSession(id, 0, IAccess0x1Bookings.ActorType.PAYER);

        // The payer grants the contract-scoped consent → the very same call now succeeds.
        vm.prank(payer);
        bookings.setCancelRelayer(relayer, true);
        uint256 payerBalBefore = usdc.balanceOf(payer);
        vm.prank(relayer);
        bookings.cancelWithSession(id, 0, IAccess0x1Bookings.ActorType.PAYER);
        assertEq(usdc.balanceOf(payer) - payerBalBefore, escrow);
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.CANCELLED)
        );
    }

    /// @notice A payer can revoke a previously-granted cancel-relayer approval; the relayer is then
    ///         rejected even with a still-live session (the allowlist is a standing, payer-revocable gate).
    function test_cancelWithSessionRejectsAfterRelayerRevoked() public {
        (uint256 id,) = _reserve(SLOT_KEY, keccak256("n1"));
        address relayer = makeAddr("relayer");

        vm.prank(payer);
        sessionGrant.openSession(relayer, 1e18, uint64(block.timestamp + 1 days));
        vm.prank(payer);
        bookings.setCancelRelayer(relayer, true);
        // The payer changes their mind and clears the cancel approval (session stays live).
        vm.prank(payer);
        bookings.setCancelRelayer(relayer, false);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__NotAuthorized.selector, id, relayer
            )
        );
        bookings.cancelWithSession(id, 0, IAccess0x1Bookings.ActorType.PAYER);
    }

    function test_cancelWithSessionRejectsWrongDelegate() public {
        (uint256 id,) = _reserve(SLOT_KEY, keccak256("n1"));
        address relayer = makeAddr("relayer");
        address attacker = makeAddr("attacker");

        vm.prank(payer);
        sessionGrant.openSession(relayer, 1e18, uint64(block.timestamp + 1 days));
        // Allowlist the attacker so the test exercises the SESSION check, not the allowlist gate: even
        // an allowlisted caller is rejected when (payer, attacker, 0) recomputes to no live session.
        vm.prank(payer);
        bookings.setCancelRelayer(attacker, true);

        // The attacker is not the session delegate — recomputing (payer, attacker, 0) finds no session.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__NotAuthorized.selector, id, attacker
            )
        );
        bookings.cancelWithSession(id, 0, IAccess0x1Bookings.ActorType.PAYER);
    }

    function test_cancelWithSessionRejectsRevokedSession() public {
        (uint256 id,) = _reserve(SLOT_KEY, keccak256("n1"));
        address relayer = makeAddr("relayer");

        vm.prank(payer);
        bytes32 sid = sessionGrant.openSession(relayer, 1e18, uint64(block.timestamp + 1 days));
        // Allowlisted for cancels, so the rejection is proven to come from the REVOKED session, not
        // the allowlist gate.
        vm.prank(payer);
        bookings.setCancelRelayer(relayer, true);
        vm.prank(payer);
        sessionGrant.revoke(sid);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__NotAuthorized.selector, id, relayer
            )
        );
        bookings.cancelWithSession(id, 0, IAccess0x1Bookings.ActorType.PAYER);
    }

    function test_cancelWithSessionRevertsWhenDisabled() public {
        // A bookings instance with NO session grant configured rejects the relayed-cancel path.
        Access0x1Bookings noSession = new Access0x1Bookings(admin, address(router), address(0));
        vm.prank(payer);
        usdc.approve(address(noSession), type(uint256).max);
        IAccess0x1Bookings.Policy memory p = _policy(2 hours, 10e8, 20e8);
        vm.prank(payer);
        uint256 id = noSession.reserve(
            merchantId,
            SLOT_KEY,
            SLOT_TS,
            address(usdc),
            DEPOSIT_USD8,
            0,
            p,
            HOLD_SECS,
            keccak256("n")
        );
        address relayer = makeAddr("relayer");
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__NotAuthorized.selector, id, relayer
            )
        );
        noSession.cancelWithSession(id, 0, IAccess0x1Bookings.ActorType.PAYER);
    }

    /*//////////////////////////////////////////////////////////////
                            SLOT REUSE
    //////////////////////////////////////////////////////////////*/

    function test_slotFreedAfterTerminalCanBeReReserved() public {
        (uint256 id1,) = _reserve(SLOT_KEY, keccak256("n1"));
        vm.prank(payer);
        bookings.cancel(id1, IAccess0x1Bookings.ActorType.PAYER);
        assertTrue(bookings.isSlotFree(SLOT_KEY));

        // Re-reserve the same slot — must succeed now.
        (uint256 id2,) = _reserve(SLOT_KEY, keccak256("n2"));
        assertEq(id2, 2);
        assertEq(bookings.occupant(SLOT_KEY), id2);
    }

    /*//////////////////////////////////////////////////////////////
              M-3 · USDT-STYLE (NO-RETURN-DATA) REFUND PUSHES
    //////////////////////////////////////////////////////////////*/

    // The token whose transfer/transferFrom move value but return NO data (USDT/BNB-class). Before the
    // M-3 fix, `_payoutOrQueue`'s `try transfer() returns (bool)` decoded the empty return in the
    // SUCCESS path, reverting the WHOLE lifecycle transition and locking the escrow. After the fix the
    // length-safe low-level call accepts the no-data success, so every refund/surplus push either pays
    // out or queues — it NEVER reverts the transition. These four tests prove that across all four
    // refund-bearing transitions: complete (surplus), expireHold, cancel, markNoShow.
    MockReturnsNothingToken internal noData;
    MockV3Aggregator internal noDataFeed;

    /// @dev Allowlist a fresh USDT-style token on the Router with a $1 feed, fund + approve the payer,
    ///      and reserve a deposit in it. Returns the reservation id and the escrowed token amount.
    function _setUpNoDataReserve(bytes32 slotKey, bytes32 nonce)
        internal
        returns (uint256 id, uint256 escrow)
    {
        noData = new MockReturnsNothingToken();
        noDataFeed = new MockV3Aggregator(8, 1e8); // $1, 8 dp
        vm.startPrank(admin);
        router.setTokenAllowed(address(noData), true);
        router.setPriceFeed(address(noData), address(noDataFeed));
        vm.stopPrank();

        noData.mint(payer, 1_000_000e6);
        vm.prank(payer);
        noData.approve(address(bookings), type(uint256).max);

        IAccess0x1Bookings.Policy memory p = _policy(2 hours, 10e8, 20e8); // $10 late, $20 no-show
        vm.prank(payer);
        id = bookings.reserve(
            merchantId, slotKey, SLOT_TS, address(noData), DEPOSIT_USD8, 0, p, HOLD_SECS, nonce
        );
        escrow = bookings.reservationOf(id).escrowAmount;
    }

    /// @notice complete() surplus refund in a no-data token does not revert. Raising the feed price
    ///         after reserve re-quotes the deposit gross BELOW the escrow, so a surplus refunds to the
    ///         payer — that push must succeed (or queue), never brick the COMPLETED transition.
    function test_noDataToken_completeSurplusRefundSucceeds() public {
        (uint256 id, uint256 escrow) = _setUpNoDataReserve(SLOT_KEY, keccak256("nd1"));

        vm.prank(merchantOwner);
        bookings.confirm(id);

        // Token doubles in USD value → the $50 deposit re-quotes to ~half the escrow → surplus refund.
        noDataFeed.updateAnswer(2e8);

        // The re-quoted gross at the doubled price (the amount the Router will pull) — the surplus is
        // the escrow minus this, and it must come back to the payer.
        uint256 grossNow = router.quote(merchantId, address(noData), DEPOSIT_USD8);
        assertLt(grossNow, escrow, "price rise should make the re-quoted gross below the escrow");

        uint256 payerBefore = noData.balanceOf(payer);
        vm.prank(merchantOwner);
        bookings.complete(id); // MUST NOT revert on the no-data surplus push

        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.COMPLETED)
        );
        // The escrow ledger fully drains (release + refund), and the surplus reached the payer either
        // directly or via the pull-map — the refund is never lost (law #5). The surplus is at least
        // `escrow - grossNow` (the routed gross is clamped to `grossNow` and the token→USD inversion can
        // only route LESS, never more, so the refund is never smaller than this floor).
        assertEq(bookings.escrowedOf(address(noData)), 0);
        uint256 paidOut = noData.balanceOf(payer) - payerBefore;
        uint256 queued = bookings.refundRescueOf(payer, address(noData));
        assertGe(paidOut + queued, escrow - grossNow, "surplus below the escrow-minus-gross floor");
    }

    /// @notice expireHold() full-escrow refund in a no-data token does not revert.
    function test_noDataToken_expireHoldRefundSucceeds() public {
        (uint256 id, uint256 escrow) = _setUpNoDataReserve(SLOT_KEY, keccak256("nd2"));

        vm.warp(block.timestamp + HOLD_SECS + 1);
        uint256 payerBefore = noData.balanceOf(payer);
        bookings.expireHold(id); // MUST NOT revert on the no-data refund push

        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.EXPIRED)
        );
        assertEq(bookings.escrowedOf(address(noData)), 0);
        // The full escrow reached the payer (no-data success), not the queue.
        assertEq(noData.balanceOf(payer) - payerBefore, escrow);
        assertEq(bookings.refundRescueOf(payer, address(noData)), 0);
    }

    /// @notice cancel() free-refund in a no-data token does not revert.
    function test_noDataToken_cancelRefundSucceeds() public {
        (uint256 id, uint256 escrow) = _setUpNoDataReserve(SLOT_KEY, keccak256("nd3"));

        // Well before the cancel window ⇒ free cancel ⇒ full escrow refunds to the payer.
        uint256 payerBefore = noData.balanceOf(payer);
        vm.prank(payer);
        bookings.cancel(id, IAccess0x1Bookings.ActorType.PAYER); // MUST NOT revert

        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.CANCELLED)
        );
        assertEq(bookings.escrowedOf(address(noData)), 0);
        assertEq(noData.balanceOf(payer) - payerBefore, escrow);
        assertEq(bookings.refundRescueOf(payer, address(noData)), 0);
    }

    /// @notice markNoShow() remainder refund in a no-data token does not revert: the no-show fee routes
    ///         to the operator through the Router (SafeERC20, no-data-safe) and the remainder pushes
    ///         back to the payer via the now-length-safe `_payoutOrQueue`.
    function test_noDataToken_markNoShowRefundSucceeds() public {
        (uint256 id, uint256 escrow) = _setUpNoDataReserve(SLOT_KEY, keccak256("nd4"));

        vm.prank(merchantOwner);
        bookings.confirm(id);

        uint256 payerBefore = noData.balanceOf(payer);
        uint256 payoutBefore = noData.balanceOf(payout);
        vm.prank(merchantOwner);
        bookings.markNoShow(id); // MUST NOT revert on the no-data remainder push

        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.NO_SHOW)
        );
        assertEq(bookings.escrowedOf(address(noData)), 0);
        // The operator kept a fee and the payer got the remainder — both legs settled, none reverted.
        assertGt(noData.balanceOf(payout) - payoutBefore, 0, "operator took no no-show fee");
        uint256 paidOut = noData.balanceOf(payer) - payerBefore;
        uint256 queued = bookings.refundRescueOf(payer, address(noData));
        assertGt(paidOut + queued, 0, "remainder neither paid nor queued");
        assertLt(paidOut + queued, escrow, "remainder should be escrow minus the no-show fee");
    }
}
