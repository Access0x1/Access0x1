// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Invoices } from "../../src/Access0x1Invoices.sol";
import { IAccess0x1Invoices } from "../../src/interfaces/IAccess0x1Invoices.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { InvoicesHandler } from "./InvoicesHandler.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @notice The invoice contract's six money invariants under a bounded, handler-driven fuzzer. Every
///         property is asserted against an INDEPENDENT ghost recomputation in the handler (or a frozen
///         canary), never against the contract's own numbers.
/// @dev    The handler owns two merchants and drives create/pay/void; time is frozen so the feeds stay
///         live. Three frozen canaries the handler never touches back the structural invariants: an
///         OPEN canary locked to a stranger (must stay OPEN — invariant 5), a VOID canary (must stay
///         VOID — invariant 6), and both also prove tenant isolation (invariant 4). The suite runs
///         under `fail_on_revert = true`, so the handler's early-returns ARE the single-settlement
///         proof (a replay would revert and fail the run).
contract Access0x1InvoicesInvariant is StdInvariant, Test, ProxyDeployer {
    Access0x1Router internal router;
    Access0x1Invoices internal invoices;
    InvoicesHandler internal handler;
    MockV3Aggregator internal nativeFeed;
    MockV3Aggregator internal usdcFeed;
    MockUSDC internal usdc;

    address internal treasury = makeAddr("inv_treasury");
    address internal ownerA = makeAddr("inv_ownerA");
    address internal ownerB = makeAddr("inv_ownerB");

    // Frozen canaries (the handler never sees these ids).
    uint256 internal openCanaryId; // locked to `lockedStranger`, must stay OPEN forever
    uint256 internal voidCanaryId; // voided at setUp, must stay VOID forever
    address internal lockedStranger = makeAddr("lockedStranger");

    function setUp() public {
        vm.warp(1_700_000_000); // fixed, fresh time held constant so feeds stay live

        nativeFeed = new MockV3Aggregator(8, 2000e8);
        usdcFeed = new MockV3Aggregator(8, 1e8);
        usdc = new MockUSDC();

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (address(this), treasury, 100))
            )
        ); // 1% platform fee
        router.setPriceFeed(address(0), address(nativeFeed));
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));

        // Deploy the invoice contract behind its UUPS proxy (impl + ERC1967Proxy initialized in one tx);
        // the test is the upgrade admin, though no invariant here exercises an upgrade.
        address invoicesImpl = address(new Access0x1Invoices());
        invoices = Access0x1Invoices(
            deployProxy(
                invoicesImpl, abi.encodeCall(Access0x1Invoices.initialize, (router, address(this)))
            )
        );

        // A canary merchant owned by the test (ownerB), used only for the frozen canary invoices. The
        // handler registers its OWN two merchants in its constructor (it must be their owner to create
        // + void), so the canary merchant is never touched by any handler action.
        vm.prank(ownerB);
        uint256 canaryMerchant =
            router.registerMerchant(makeAddr("inv_canaryPayout"), ownerA, 50, keccak256("canaryM"));

        // Canaries on the canary merchant — created by its owner, never handed to the handler.
        vm.startPrank(ownerB);
        openCanaryId = invoices.createInvoice(
            canaryMerchant, lockedStranger, address(usdc), 50e8, 0, keccak256("open")
        );
        voidCanaryId = invoices.createInvoice(
            canaryMerchant, address(0), address(usdc), 50e8, 0, keccak256("void")
        );
        invoices.void(voidCanaryId);
        vm.stopPrank();

        handler = new InvoicesHandler(router, invoices, usdc, treasury);

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = InvoicesHandler.createInvoice.selector;
        selectors[1] = InvoicesHandler.pay.selector;
        selectors[2] = InvoicesHandler.payNative.selector;
        selectors[3] = InvoicesHandler.void.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @notice Invariant 1 — net + fee == gross (token conservation): every token unit the router
    ///         split was delivered to a sink. The independent ghost sum of gross equals the sink sum.
    function invariant_conservationToken() public view {
        assertEq(handler.deliveredToken(), handler.ghostGrossSettled());
    }

    /// @notice Invariant 1 — net + fee == gross (native conservation): every native unit settled was
    ///         delivered to a sink (or queued to rescue). No wei is created or destroyed in the hop.
    function invariant_conservationNative() public view {
        assertEq(handler.deliveredNative(), handler.ghostGrossSettledNative());
    }

    /// @notice Invariant 3 — zero custody: neither the invoice contract nor the router ever retains a
    ///         balance after settlement (pulled/forwarded in the same tx; native excess refunded).
    function invariant_zeroCustody() public view {
        assertEq(usdc.balanceOf(address(invoices)), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(address(invoices).balance, 0);
        assertEq(address(router).balance, 0);
    }

    /// @notice Invariant 2 — settles AT MOST once: no invoice the handler created was settled more than
    ///         once, and the global settlement count never exceeds the created count. (A replay would
    ///         have reverted and tripped `fail_on_revert`; this is the positive cross-check.)
    function invariant_settlesAtMostOnce() public view {
        uint256 n = handler.invoiceCount();
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = handler.invoiceIdAt(i);
            assertLe(handler.settleCountOf(id), 1);
            // A settled invoice is necessarily PAID; an unsettled one is OPEN or VOID, never PAID.
            IAccess0x1Invoices.InvStatus status = invoices.invoiceOf(id).status;
            if (handler.settleCountOf(id) == 1) {
                assertEq(uint8(status), uint8(IAccess0x1Invoices.InvStatus.PAID));
            } else {
                assertTrue(
                    status == IAccess0x1Invoices.InvStatus.OPEN
                        || status == IAccess0x1Invoices.InvStatus.VOID
                );
            }
        }
        assertLe(handler.ghostSettleCount(), handler.ghostCreatedCount());
    }

    /// @notice Invariant 4 + 5 — tenant isolation + locked-payer: the OPEN canary, locked to a payer
    ///         the handler is NOT, is never mutated by any handler action — it stays exactly OPEN with
    ///         its original immutable fields. A locked invoice is unpayable by anyone but its payer.
    function invariant_openCanaryUntouched() public view {
        IAccess0x1Invoices.Invoice memory inv = invoices.invoiceOf(openCanaryId);
        assertEq(uint8(inv.status), uint8(IAccess0x1Invoices.InvStatus.OPEN));
        assertEq(inv.payer, lockedStranger);
        assertEq(inv.token, address(usdc));
        assertEq(inv.amountUsd8, 50e8);
        assertTrue(invoices.isPayable(openCanaryId));
    }

    /// @notice Invariant 6 — a VOID invoice can never be paid: the VOID canary stays terminally VOID
    ///         no matter what the handler does (terminal-state monotonicity).
    function invariant_voidCanaryStaysVoid() public view {
        IAccess0x1Invoices.Invoice memory inv = invoices.invoiceOf(voidCanaryId);
        assertEq(uint8(inv.status), uint8(IAccess0x1Invoices.InvStatus.VOID));
        assertFalse(invoices.isPayable(voidCanaryId));
    }
}
