// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Invoices } from "../../src/Access0x1Invoices.sol";
import { IAccess0x1Invoices } from "../../src/interfaces/IAccess0x1Invoices.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

/// @title  Access0x1InvoicesFuzz
/// @author Access0x1
/// @notice The Cyfrin STATELESS-FUZZ layer for {Access0x1Invoices}: every public/external function is
///         fuzzed in isolation with `bound`-constrained inputs, and the per-call money + lifecycle
///         invariants are asserted on EACH run — not against the contract's own returned numbers, but
///         against an INDEPENDENT recomputation (the router quote / the bps split / the buyer balance
///         delta). This is the single-transaction complement to the handler-driven stateful invariant
///         suite (`test/invariant/Access0x1Invoices.invariant.t.sol`): the invariant suite proves the
///         properties hold across SEQUENCES; this proves they hold for ANY single call's inputs.
/// @dev    Reuses the repo's canonical mocks (MockUSDC 6-dec, MockV3Aggregator 8-dec) — no new mocks.
///         Each test fuzzes ONE entrypoint:
///           - createInvoice : id monotonicity, write-once snapshot, OPEN-on-create, over arbitrary
///                             merchant/payer/token/amount/dueBy/memo.
///           - pay (token)   : net + fee == gross, zero custody at both hops, no dangling allowance,
///                             terminal PAID, over arbitrary USD price.
///           - payNative     : exact-excess refund to the wei, sinks net exactly gross, zero custody,
///                             over arbitrary overpay.
///           - void          : OPEN → VOID one-way, unpayable after, over arbitrary lock/token shape.
///         Time is frozen at a fresh timestamp so the feeds stay inside the staleness window for every
///         run (a fuzzed `pay` must fail for a real reason, never an incidentally-stale feed).
contract Access0x1InvoicesFuzz is Test {
    Access0x1Router internal router;
    Access0x1Invoices internal invoices;

    MockV3Aggregator internal nativeFeed; // ETH/USD, 8 dp
    MockV3Aggregator internal usdcFeed; // USDC/USD, 8 dp
    MockUSDC internal usdc; // 6 dp

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal payer = makeAddr("payer");

    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5%

    uint256 internal merchantId;

    function setUp() public {
        // A fixed, fresh time so every fuzzed pay sees a live feed (staleness is not what we test here).
        vm.warp(1_700_000_000);

        router = new Access0x1Router(owner, treasury, PLATFORM_FEE_BPS);
        invoices = new Access0x1Invoices(router);

        nativeFeed = new MockV3Aggregator(8, 2000e8); // ETH/USD = $2000
        usdcFeed = new MockV3Aggregator(8, 1e8); // USDC/USD = $1
        usdc = new MockUSDC();

        vm.startPrank(owner);
        router.setPriceFeed(address(0), address(nativeFeed));
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        vm.prank(merchantOwner);
        merchantId =
            router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, keccak256("acme"));
    }

    /// @dev The independent two-leg split the router applies — recomputed here so the assertions never
    ///      lean on the contract's own arithmetic.
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
                           FUZZ — createInvoice
    //////////////////////////////////////////////////////////////*/

    /// @notice FUZZ {createInvoice}: for ANY (payer, token, amount, dueBy, memo) the merchant owner
    ///         supplies, the new invoice is stored as the EXACT immutable snapshot, is OPEN (payable),
    ///         and the id increments by one. Proves the create path never mutates a field it was given
    ///         and never skips the id sequence.
    function testFuzz_createStoresImmutableSnapshotAndIsOpen(
        address fuzzPayer,
        uint256 amountUsd8,
        uint64 dueBy,
        bytes32 memoHash
    ) public {
        amountUsd8 = bound(amountUsd8, 1, type(uint256).max); // only constraint: amount > 0
        uint256 idBefore = invoices.nextInvoiceId();

        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(
            merchantId, fuzzPayer, address(usdc), amountUsd8, dueBy, memoHash
        );

        assertEq(id, idBefore, "id is the pre-call nextInvoiceId");
        assertEq(invoices.nextInvoiceId(), idBefore + 1, "nextInvoiceId increments by exactly one");

        IAccess0x1Invoices.Invoice memory inv = invoices.invoiceOf(id);
        assertEq(inv.merchantId, merchantId, "merchantId stored verbatim");
        assertEq(inv.payer, fuzzPayer, "payer stored verbatim");
        assertEq(inv.token, address(usdc), "token stored verbatim");
        assertEq(inv.amountUsd8, amountUsd8, "amount stored verbatim");
        assertEq(inv.dueBy, dueBy, "dueBy stored verbatim");
        assertEq(inv.memoHash, memoHash, "memoHash stored verbatim");
        assertEq(uint8(inv.status), uint8(IAccess0x1Invoices.InvStatus.OPEN), "created OPEN");
        assertTrue(invoices.isPayable(id), "an OPEN invoice is payable");
    }

    /// @notice FUZZ {createInvoice} auth: ANY caller that is NOT the merchant owner is rejected, and no
    ///         invoice is created (nextInvoiceId is untouched). Proves the owner-equality gate holds for
    ///         every non-owner address the fuzzer can pick.
    function testFuzz_createRevertsForAnyNonOwner(address caller, uint256 amountUsd8) public {
        vm.assume(caller != merchantOwner);
        amountUsd8 = bound(amountUsd8, 1, type(uint256).max);
        uint256 idBefore = invoices.nextInvoiceId();

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotMerchantOwner.selector, merchantId, caller
            )
        );
        invoices.createInvoice(merchantId, payer, address(usdc), amountUsd8, 0, bytes32(0));

        assertEq(invoices.nextInvoiceId(), idBefore, "no id consumed by a rejected create");
    }

    /*//////////////////////////////////////////////////////////////
                              FUZZ — pay (token)
    //////////////////////////////////////////////////////////////*/

    /// @notice FUZZ {pay}: for ANY USD price, a token settlement conserves value exactly
    ///         (net + platformFee + merchantFee == gross), leaves ZERO custody in the invoice and the
    ///         router, leaves NO dangling invoice→router allowance, and moves the invoice to terminal
    ///         PAID. The gross is the router's own in-tx quote; the split is recomputed independently.
    function testFuzz_payTokenConservesAndZeroCustody(uint256 amountUsd8) public {
        amountUsd8 = bound(amountUsd8, 1e8, 1_000_000e8); // $1 .. $1M

        vm.prank(merchantOwner);
        uint256 id =
            invoices.createInvoice(merchantId, payer, address(usdc), amountUsd8, 0, bytes32(0));

        uint256 gross = router.quote(merchantId, address(usdc), amountUsd8);
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _split(gross);

        usdc.mint(payer, gross);
        vm.startPrank(payer);
        usdc.approve(address(invoices), gross);
        invoices.pay(id, keccak256("fuzz-pay"));
        vm.stopPrank();

        // Conservation: every minted unit landed in exactly one sink; nothing created or destroyed.
        assertEq(usdc.balanceOf(payout), net, "net -> payout");
        assertEq(usdc.balanceOf(treasury), platformFee, "platform fee -> treasury");
        assertEq(usdc.balanceOf(feeRecipient), merchantFee, "merchant fee -> feeRecipient");
        assertEq(net + platformFee + merchantFee, gross, "net + fee == gross");

        // Zero custody at BOTH hops, and the payer was fully debited the gross.
        assertEq(usdc.balanceOf(address(invoices)), 0, "invoice holds zero token");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds zero token");
        assertEq(usdc.balanceOf(payer), 0, "payer debited exactly gross, no skim");

        // No reusable allowance and a terminal PAID state.
        assertEq(usdc.allowance(address(invoices), address(router)), 0, "no dangling allowance");
        assertEq(
            uint8(invoices.invoiceOf(id).status),
            uint8(IAccess0x1Invoices.InvStatus.PAID),
            "terminal PAID"
        );
        assertFalse(invoices.isPayable(id), "a PAID invoice is no longer payable");
    }

    /// @notice FUZZ {pay} single-settlement: for ANY number of pay attempts (each with a distinct
    ///         nonce), an unlocked token invoice settles AT MOST once. Exactly one attempt succeeds; the
    ///         sinks net exactly one gross; the rest revert at the terminal-state guard. This is the
    ///         stateless analogue of the invariant suite's "settles at most once".
    function testFuzz_payTokenSettlesAtMostOnce(uint256 amountUsd8, uint8 attempts) public {
        amountUsd8 = bound(amountUsd8, 1e8, 100_000e8);
        attempts = uint8(bound(attempts, 1, 10));

        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(
            merchantId, address(0), address(usdc), amountUsd8, 0, bytes32(0)
        );
        uint256 gross = router.quote(merchantId, address(usdc), amountUsd8);

        usdc.mint(payer, gross * uint256(attempts) + gross); // enough to (try to) pay every attempt
        vm.startPrank(payer);
        usdc.approve(address(invoices), type(uint256).max);

        uint256 successes;
        for (uint256 i = 0; i < attempts; ++i) {
            try invoices.pay(id, keccak256(abi.encode("nonce", i))) {
                successes++;
            } catch { }
        }
        vm.stopPrank();

        assertEq(successes, 1, "exactly one settlement across all attempts");
        assertEq(
            usdc.balanceOf(payout) + usdc.balanceOf(treasury) + usdc.balanceOf(feeRecipient),
            gross,
            "sinks net exactly one gross"
        );
        assertEq(usdc.balanceOf(address(invoices)), 0, "zero custody after the storm");
    }

    /// @notice FUZZ {pay} payer-lock: for ANY non-payer caller, a locked invoice cannot be settled — it
    ///         reverts `NotAuthorizedPayer` and stays OPEN, regardless of who tries. The lock holds for
    ///         every address the fuzzer can pick that is not the locked payer.
    function testFuzz_payTokenLockedRejectsAnyOtherPayer(address caller) public {
        vm.assume(caller != payer);
        vm.assume(caller != address(0)); // address(0) cannot be an EOA msg.sender in practice

        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, payer, address(usdc), 20e8, 0, bytes32(0));
        uint256 gross = router.quote(merchantId, address(usdc), 20e8);

        usdc.mint(caller, gross);
        vm.startPrank(caller);
        usdc.approve(address(invoices), gross);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotAuthorizedPayer.selector, id, payer, caller
            )
        );
        invoices.pay(id, keccak256("locked"));
        vm.stopPrank();

        assertTrue(
            invoices.isPayable(id), "locked invoice stays OPEN after a rejected non-payer pay"
        );
        assertEq(usdc.balanceOf(caller), gross, "the rejected caller was not debited");
    }

    /*//////////////////////////////////////////////////////////////
                             FUZZ — payNative
    //////////////////////////////////////////////////////////////*/

    /// @notice FUZZ {payNative}: for ANY excess over the quoted gross, the buyer is refunded the excess
    ///         to the WEI, the sinks net exactly gross, and the invoice + router hold zero native after.
    ///         Proves the native pay path forwards exactly gross and never over- or under-refunds.
    function testFuzz_payNativeRefundsExactExcess(uint256 excess) public {
        excess = bound(excess, 0, 100 ether);

        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, payer, address(0), 20e8, 0, bytes32(0));
        uint256 gross = router.quote(merchantId, address(0), 20e8);
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _split(gross);

        vm.deal(payer, gross + excess);
        vm.prank(payer);
        invoices.payNative{ value: gross + excess }(id, keccak256("over"));

        // The buyer keeps exactly the excess (paid exactly gross, net of the refund leg).
        assertEq(payer.balance, excess, "buyer refunded exactly msg.value - gross");

        // The sinks net exactly gross, split correctly.
        assertEq(payout.balance, net, "net -> payout");
        assertEq(treasury.balance, platformFee, "platform fee -> treasury");
        assertEq(feeRecipient.balance, merchantFee, "merchant fee -> feeRecipient");
        assertEq(net + platformFee + merchantFee, gross, "net + fee == gross");

        // Zero native custody at both hops, terminal PAID.
        assertEq(address(invoices).balance, 0, "invoice holds zero native");
        assertEq(address(router).balance, 0, "router holds zero native");
        assertEq(
            uint8(invoices.invoiceOf(id).status),
            uint8(IAccess0x1Invoices.InvStatus.PAID),
            "terminal PAID"
        );
    }

    /// @notice FUZZ {payNative} underpay: for ANY value strictly below the quoted gross, the call
    ///         reverts `Underpaid` and the invoice stays OPEN — there is no partial settlement, and the
    ///         flip-to-PAID rolls back with the revert.
    function testFuzz_payNativeUnderpayReverts(uint256 value) public {
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(merchantId, payer, address(0), 20e8, 0, bytes32(0));
        uint256 gross = router.quote(merchantId, address(0), 20e8);
        value = bound(value, 0, gross - 1); // strictly underpaid

        vm.deal(payer, gross);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__Underpaid.selector, gross, value
            )
        );
        invoices.payNative{ value: value }(id, keccak256("under"));

        assertTrue(invoices.isPayable(id), "an underpaid native invoice stays OPEN");
        assertEq(payout.balance, 0, "no merchant payout from a reverted underpay");
    }

    /*//////////////////////////////////////////////////////////////
                               FUZZ — void
    //////////////////////////////////////////////////////////////*/

    /// @notice FUZZ {void}: for ANY lock/token shape of an OPEN invoice, the merchant owner can void it
    ///         once (OPEN → VOID), after which it is permanently unpayable and a second void reverts.
    ///         Proves the void path is a one-way terminal transition for every invoice shape.
    function testFuzz_voidIsOneWayTerminal(bool locked, bool native, uint256 amountUsd8) public {
        amountUsd8 = bound(amountUsd8, 1, type(uint256).max);
        address lockedPayer = locked ? payer : address(0);
        address token = native ? address(0) : address(usdc);

        vm.prank(merchantOwner);
        uint256 id =
            invoices.createInvoice(merchantId, lockedPayer, token, amountUsd8, 0, bytes32(0));

        // First void succeeds and flips to terminal VOID.
        vm.prank(merchantOwner);
        invoices.void(id);
        assertEq(
            uint8(invoices.invoiceOf(id).status),
            uint8(IAccess0x1Invoices.InvStatus.VOID),
            "OPEN -> VOID"
        );
        assertFalse(invoices.isPayable(id), "a VOID invoice is not payable");

        // A second void reverts — VOID is absorbing.
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotOpen.selector,
                id,
                IAccess0x1Invoices.InvStatus.VOID
            )
        );
        invoices.void(id);
    }

    /// @notice FUZZ {void} auth: ANY caller that is not the merchant owner cannot void, and the invoice
    ///         stays OPEN and payable. Proves the void gate holds for every non-owner the fuzzer picks.
    function testFuzz_voidRejectsAnyNonOwner(address caller) public {
        vm.assume(caller != merchantOwner);

        vm.prank(merchantOwner);
        uint256 id =
            invoices.createInvoice(merchantId, address(0), address(usdc), 20e8, 0, bytes32(0));

        vm.prank(caller);
        // First field is the MERCHANT id (matching {createInvoice}'s convention), not the invoice id.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotMerchantOwner.selector, merchantId, caller
            )
        );
        invoices.void(id);

        assertTrue(invoices.isPayable(id), "a non-owner void leaves the invoice OPEN");
    }
}
