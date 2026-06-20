// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { Refunds } from "../../src/Refunds.sol";
import { IRefunds } from "../../src/interfaces/IRefunds.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { RefundsHandler } from "./RefundsHandler.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @notice The {Refunds} money invariants under a bounded, handler-driven fuzzer — the security floor for
///         the unified refund primitive. Every property is asserted against an INDEPENDENT ghost
///         recomputation in the handler, never against the contract's own numbers.
/// @dev    Time is FROZEN (so transitions are reachable; {reclaim} warps past the deadline and back). The
///         handler drives request/claim/reclaim as the EOA merchant owner + EOA buyers — all of whom
///         always receive, so no push ever queues and the conservation invariant holds as an exact
///         equality. A FROZEN CANARY refund (requested once, never resolved) backs the never-blockable
///         invariant: a PENDING refund's full amount is always present and claimable.
contract RefundsInvariant is StdInvariant, Test, ProxyDeployer {
    Refunds internal refunds;
    Access0x1Router internal router;
    RefundsHandler internal handler;

    MockV3Aggregator internal usdcFeed;
    MockUSDC internal usdc;

    address internal admin = makeAddr("inv_admin");
    address internal treasury = makeAddr("inv_treasury");
    uint256 internal merchantOwnerPk = 0xB0B;
    address internal merchantOwner = vm.addr(0xB0B);
    address internal payout = makeAddr("inv_payout");
    address internal feeRecipient = makeAddr("inv_feeRecipient");
    uint256 internal merchantId;

    function setUp() public {
        vm.warp(1_700_000_000);

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (admin, treasury, 100))
            )
        ); // 1% platform fee (unused by Refunds — a refund takes no fee)

        usdcFeed = new MockV3Aggregator(8, 1e8); // $1 (only needed so the token is allowlisted)
        usdc = new MockUSDC();
        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        address refundsImpl = address(new Refunds());
        refunds = Refunds(
            deployProxy(refundsImpl, abi.encodeCall(Refunds.initialize, (admin, router)))
        );

        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, 50, keccak256("inv_m"));

        handler = new RefundsHandler(refunds, router, usdc, merchantId, merchantOwner);
        handler.seedCanary();

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = RefundsHandler.request.selector;
        selectors[1] = RefundsHandler.claim.selector;
        selectors[2] = RefundsHandler.reclaim.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @notice Invariant 1 — conservation (the headline): the contract's balance for each asset is ALWAYS
    ///         >= Σ(PENDING refund amounts) for that asset. Funds are never created or stranded. With EOA
    ///         recipients nothing ever queues, so the `held` ghost is the full backing and the `>=` holds
    ///         (it would also hold if a future queued credit left extra backing).
    function invariant_tokenConservation() public view {
        assertGe(usdc.balanceOf(address(refunds)), handler.ghostOpen(address(usdc)));
    }

    function invariant_nativeConservation() public view {
        assertGe(address(refunds).balance, handler.ghostOpen(address(0)));
    }

    /// @notice Invariant 1 (exact form) — the contract holds EXACTLY the open backing (no leak, no
    ///         excess): every resolution moved the full amount out, every request moved the full amount
    ///         in, and no push queued (EOA recipients), so balance == Σ pending amounts on the nose.
    function invariant_tokenBalanceExact() public view {
        assertEq(usdc.balanceOf(address(refunds)), handler.ghostOpen(address(usdc)));
    }

    function invariant_nativeBalanceExact() public view {
        assertEq(address(refunds).balance, handler.ghostOpen(address(0)));
    }

    /// @notice Invariant 2 — the ERC-6909 claim receipt backs the held funds: the canary buyer's receipt
    ///         balance on the USDC claim id always equals the canary's still-open amount. The receipt is
    ///         a faithful claim ticket — minted on request, burned on resolution — so a buyer can never
    ///         hold a receipt for funds the contract does not hold (or vice versa).
    function invariant_receiptMatchesCanary() public view {
        uint256 id = refunds.refundTokenId(handler.merchantId(), handler.canaryOrder());
        assertEq(refunds.balanceOf(handler.canaryBuyer(), id), handler.canaryAmount());
    }

    /// @notice Invariant 3 — never-blockable / always-claimable: the frozen canary stays PENDING with its
    ///         full amount continuously present and CLAIMABLE. A PENDING refund's funds can never be
    ///         locked or lost; the buyer's claim always goes through (proven executably below).
    function invariant_canaryAlwaysClaimable() public view {
        IRefunds.Refund memory c = refunds.refundOf(handler.merchantId(), handler.canaryOrder());
        assertEq(uint8(c.state), uint8(IRefunds.RefundState.PENDING)); // never resolved
        assertEq(c.amount, handler.canaryAmount());
        assertTrue(refunds.isClaimable(handler.merchantId(), handler.canaryOrder()));
        // The contract always holds at least the canary's amount (plus every other live refund's).
        assertGe(usdc.balanceOf(address(refunds)), handler.canaryAmount());
    }

    /// @notice Invariant 4 — every resolution returned EXACTLY the held amount: claim/reclaim moved
    ///         `amount` out, no more, no less (no value created or lost; a refund takes no fee).
    function invariant_resolveAlwaysExact() public view {
        assertTrue(handler.resolveAlwaysExact());
    }

    /// @notice Invariant 5 (never-blockable, executable) — a claim on the live canary PENDING refund
    ///         always succeeds. Runs the actual claim against a forked copy of state each round, proving a
    ///         PENDING refund is genuinely claimable (not merely funded) and can never be double-claimed
    ///         (the post-claim state is terminal CLAIMED). Restores state so the canary stays PENDING.
    function invariant_canaryIsAlwaysClaimable() public {
        uint256 snap = vm.snapshotState();
        uint256 mId = handler.merchantId();
        bytes32 order = handler.canaryOrder();
        address buyer = handler.canaryBuyer();
        vm.prank(buyer);
        refunds.claim(mId, order); // must not revert — a PENDING refund is always claimable
        assertEq(uint8(refunds.refundOf(mId, order).state), uint8(IRefunds.RefundState.CLAIMED));
        // The receipt was burned by the claim — no double-claim is possible.
        assertEq(refunds.balanceOf(buyer, refunds.refundTokenId(mId, order)), 0);
        vm.revertToState(snap); // restore so the canary stays PENDING for the other invariants/rounds
    }
}
