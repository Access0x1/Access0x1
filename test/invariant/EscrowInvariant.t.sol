// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { Access0x1Escrow } from "../../src/Access0x1Escrow.sol";
import { IAccess0x1Escrow } from "../../src/interfaces/IAccess0x1Escrow.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { EscrowHandler } from "./EscrowHandler.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @notice The Access0x1Escrow money invariants under a bounded, handler-driven fuzzer — the security
///         floor for the conditional-escrow primitive. Every property is asserted against an INDEPENDENT
///         ghost recomputation in the handler, never against the contract's own numbers.
/// @dev    Time is FROZEN (so transitions are reachable; {claimAfterTimeout} warps past the deadline and
///         back). The handler drives open/confirm/claimAfterTimeout/cancel/arbitrate as EOA buyers,
///         sellers, and one arbiter — all of whom always receive, so no push ever queues and the
///         conservation invariant holds as an exact equality. A FROZEN CANARY escrow (opened once, never
///         resolved) backs the never-blockable invariant: an OPEN escrow's full deposit is always present
///         and resolvable.
contract Access0x1EscrowInvariant is StdInvariant, Test, ProxyDeployer {
    Access0x1Escrow internal escrow;
    Access0x1Router internal router;
    EscrowHandler internal handler;

    MockV3Aggregator internal usdcFeed;
    MockUSDC internal usdc;

    address internal admin = makeAddr("inv_admin");
    address internal treasury = makeAddr("inv_treasury");
    address internal merchantOwner = makeAddr("inv_merchantOwner");
    address internal payout = makeAddr("inv_payout");
    address internal feeRecipient = makeAddr("inv_feeRecipient");
    uint256 internal merchantId;

    function setUp() public {
        vm.warp(1_700_000_000); // fixed, fresh time held constant by the fuzzer

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (admin, treasury, 100))
            )
        ); // 1% platform fee

        usdcFeed = new MockV3Aggregator(8, 1e8); // $1 (only needed so the token is allowlisted)
        usdc = new MockUSDC();
        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        address escrowImpl = address(new Access0x1Escrow());
        escrow = Access0x1Escrow(
            deployProxy(escrowImpl, abi.encodeCall(Access0x1Escrow.initialize, (admin, router)))
        );

        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, 50, keccak256("inv_m")); // 0.5%

        handler = new EscrowHandler(escrow, router, usdc, merchantId, treasury);
        handler.seedCanary();

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = EscrowHandler.open.selector;
        selectors[1] = EscrowHandler.confirm.selector;
        selectors[2] = EscrowHandler.claimAfterTimeout.selector;
        selectors[3] = EscrowHandler.cancel.selector;
        selectors[4] = EscrowHandler.arbitrate.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @notice Invariant 1 — conservation (the headline): the contract's balance for each asset is ALWAYS
    ///         >= Σ(open-escrow amounts) + Σ(withdrawable) for that asset. Funds are never created or
    ///         stranded. With EOA recipients nothing ever queues, so the `held` ghost is the full backing
    ///         and the `>=` holds (it would also hold if a future queued credit left extra backing).
    function invariant_tokenConservation() public view {
        assertGe(usdc.balanceOf(address(escrow)), handler.ghostOpen(address(usdc)));
    }

    function invariant_nativeConservation() public view {
        assertGe(address(escrow).balance, handler.ghostOpen(address(0)));
    }

    /// @notice Invariant 1 (exact form) — the contract holds EXACTLY the open backing (no leak, no
    ///         excess): every resolution moved the full deposit out, every open moved the full deposit
    ///         in, and no push queued (EOA recipients), so balance == Σ open amounts on the nose.
    function invariant_tokenBalanceExact() public view {
        assertEq(usdc.balanceOf(address(escrow)), handler.ghostOpen(address(usdc)));
    }

    function invariant_nativeBalanceExact() public view {
        assertEq(address(escrow).balance, handler.ghostOpen(address(0)));
    }

    /// @notice Invariant 2 — never-blockable / always-resolvable: the frozen canary stays OPEN with its
    ///         full deposit continuously present, AND a release on it always succeeds (proven below). An
    ///         OPEN escrow's funds can never be locked or lost; a resolution always goes through.
    function invariant_openEscrowAlwaysFunded() public view {
        IAccess0x1Escrow.Escrow memory c = escrow.escrowOf(handler.canaryId());
        assertEq(uint8(c.state), uint8(IAccess0x1Escrow.EscrowState.OPEN)); // never resolved
        assertEq(c.amount, handler.canaryAmount());
        // The contract always holds at least the canary's deposit (plus every other live escrow's).
        assertGe(usdc.balanceOf(address(escrow)), handler.canaryAmount());
    }

    /// @notice Invariant 3 — the release split is always EXACT: net + fee == amount on every release the
    ///         fuzzer reached (mirrored from the router's live rate; no value created or lost in the split).
    function invariant_splitAlwaysExact() public view {
        assertTrue(handler.splitAlwaysExact());
    }

    /// @notice Invariant 4 — every released leg landed at the seller/treasury sinks: the independent
    ///         ghost total routed equals the token actually at those sinks (the escrow neither creates nor
    ///         loses value on a release; the merchant surcharge is never taken here).
    function invariant_settledMatchesSinks() public view {
        // USDC sinks: every seller's + the treasury's balance. Sellers are a fixed set in the handler.
        uint256 sinks = usdc.balanceOf(treasury);
        for (uint256 i = 0; i < 3; i++) {
            sinks += usdc.balanceOf(handler.sellers(i));
        }
        assertEq(sinks, handler.ghostSettled(address(usdc)));
    }

    /// @notice Invariant 5 (never-blockable, executable) — a release on the live canary OPEN escrow
    ///         always succeeds. Runs the actual resolution against a forked copy of state each round (the
    ///         arbiter releases it), proving an OPEN escrow is genuinely resolvable, not merely funded.
    function invariant_openEscrowIsAlwaysResolvable() public {
        uint256 snap = vm.snapshotState();
        uint256 id = handler.canaryId();
        address arb = handler.arbiter();
        vm.prank(arb);
        escrow.arbitrate(id, true); // must not revert — an OPEN escrow is always resolvable
        assertEq(uint8(escrow.escrowOf(id).state), uint8(IAccess0x1Escrow.EscrowState.RELEASED));
        vm.revertToState(snap); // restore so the canary stays OPEN for the other invariants/rounds
    }
}
