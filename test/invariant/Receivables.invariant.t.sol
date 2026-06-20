// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Receivables } from "../../src/Receivables.sol";
import { IReceivables } from "../../src/interfaces/IReceivables.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { ReceivablesHandler } from "./ReceivablesHandler.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @notice The {Receivables} money invariants under a bounded, handler-driven fuzzer. Every property is
///         asserted against an INDEPENDENT ghost recomputation in the handler (or a frozen canary),
///         never against the contract's own numbers.
/// @dev    The handler owns two CONDUIT merchants (router payout == the Receivables contract) and drives
///         mint/factor/pay/cancel; time is frozen so the feeds stay live. Two frozen canaries the
///         handler never touches back the structural invariants: an OPEN canary (must stay OPEN, held by
///         a stranger the handler never factors to — invariant 5) and a CANCELLED canary (must stay
///         burned — invariant 6). The suite runs under `fail_on_revert = true`, so the handler's
///         early-returns ARE the single-settlement proof (a replay would revert and fail the run).
contract ReceivablesInvariant is StdInvariant, Test, ProxyDeployer {
    Access0x1Router internal router;
    Receivables internal recv;
    ReceivablesHandler internal handler;
    MockV3Aggregator internal nativeFeed;
    MockV3Aggregator internal usdcFeed;
    MockUSDC internal usdc;

    address internal treasury = makeAddr("recv_treasury");
    address internal ownerB = makeAddr("recv_ownerB"); // owns the canary merchant

    // Frozen canaries (the handler never sees these ids).
    uint256 internal openCanaryId; // held by `canaryHolder`, must stay OPEN forever
    uint256 internal cancelCanaryId; // cancelled at setUp, must stay burned forever
    address internal canaryHolder = makeAddr("recv_canaryHolder");

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

        address recvImpl = address(new Receivables());
        recv = Receivables(
            payable(deployProxy(
                    recvImpl,
                    abi.encodeCall(
                        Receivables.initialize, (router, address(this), "Recv", "RCV", "ipfs://c")
                    )
                ))
        );

        // A canary CONDUIT merchant owned by ownerB, used only for the frozen canary receivables; the
        // handler registers its OWN two merchants in its constructor, so this one is never touched.
        vm.prank(ownerB);
        uint256 canaryMerchant =
            router.registerMerchant(address(recv), ownerB, 50, keccak256("recvCanaryM"));

        vm.startPrank(ownerB);
        openCanaryId =
            recv.mint(canaryMerchant, canaryHolder, address(0), address(usdc), 50e8, 0, "");
        cancelCanaryId =
            recv.mint(canaryMerchant, canaryHolder, address(0), address(usdc), 50e8, 0, "");
        recv.cancel(cancelCanaryId);
        vm.stopPrank();

        handler = new ReceivablesHandler(router, recv, usdc, treasury);

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = ReceivablesHandler.mint.selector;
        selectors[1] = ReceivablesHandler.factor.selector;
        selectors[2] = ReceivablesHandler.pay.selector;
        selectors[3] = ReceivablesHandler.payNative.selector;
        selectors[4] = ReceivablesHandler.cancel.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @notice Invariant 1 — net + fee == gross (token conservation): every token unit the router split
    ///         was delivered to a sink (the net to a creditor + the fee legs). The independent ghost sum
    ///         of gross equals the sink sum.
    function invariant_conservationToken() public view {
        assertEq(handler.deliveredToken(), handler.ghostGrossSettled());
    }

    /// @notice Invariant 1 — net + fee == gross (native conservation): every native unit settled was
    ///         delivered to a sink. No wei is created or destroyed in the hop.
    function invariant_conservationNative() public view {
        assertEq(handler.deliveredNative(), handler.ghostGrossSettledNative());
    }

    /// @notice Invariant 3 — zero custody: neither the Receivables contract nor the router ever retains a
    ///         balance after settlement (pulled/forwarded in the same tx; native excess refunded; net
    ///         forwarded to the holder).
    function invariant_zeroCustody() public view {
        assertEq(usdc.balanceOf(address(recv)), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(address(recv).balance, 0);
        assertEq(address(router).balance, 0);
    }

    /// @notice Invariant 2 — settles AT MOST once + status↔token-existence: no receivable was settled
    ///         more than once; a settled receivable is SETTLED and its token is BURNED; an unsettled one
    ///         is OPEN (token exists, held by exactly one creditor) or CANCELLED (token burned).
    function invariant_settlesAtMostOnce() public view {
        uint256 n = handler.idCount();
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = handler.idAt(i);
            assertLe(handler.settleCountOf(id), 1);
            IReceivables.Status status = recv.receivableOf(id).status;
            if (handler.settleCountOf(id) == 1) {
                assertEq(uint8(status), uint8(IReceivables.Status.SETTLED));
                assertFalse(_exists(id)); // a settled receivable's token is burned
            } else {
                assertTrue(
                    status == IReceivables.Status.OPEN || status == IReceivables.Status.CANCELLED
                );
                // EXACTLY ONE creditor per OPEN receivable: the token exists and ownerOf is non-zero.
                // A CANCELLED receivable's token is burned.
                assertEq(_exists(id), status == IReceivables.Status.OPEN);
            }
        }
        assertLe(handler.ghostSettleCount(), handler.ghostMintedCount());
    }

    /// @notice Invariant 5 — tenant isolation + one creditor: the OPEN canary, held by a holder the
    ///         handler never factors to, is never mutated by any handler action — it stays exactly OPEN,
    ///         still held by its one creditor, with its original immutable fields.
    function invariant_openCanaryUntouched() public view {
        IReceivables.Receivable memory r = recv.receivableOf(openCanaryId);
        assertEq(uint8(r.status), uint8(IReceivables.Status.OPEN));
        assertEq(r.token, address(usdc));
        assertEq(r.amountUsd8, 50e8);
        assertTrue(recv.isPayable(openCanaryId));
        assertEq(IERC721(address(recv)).ownerOf(openCanaryId), canaryHolder); // its one creditor
    }

    /// @notice Invariant 6 — a CANCELLED receivable can never be revived/paid: the CANCELLED canary
    ///         stays terminally CANCELLED + burned no matter what the handler does (terminal
    ///         monotonicity).
    function invariant_cancelCanaryStaysCancelled() public view {
        IReceivables.Receivable memory r = recv.receivableOf(cancelCanaryId);
        assertEq(uint8(r.status), uint8(IReceivables.Status.CANCELLED));
        assertFalse(recv.isPayable(cancelCanaryId));
        assertFalse(_exists(cancelCanaryId)); // token burned
    }

    /// @dev Whether a token id still exists (was not burned) — `ownerOf` reverts for a burned token.
    function _exists(uint256 id) internal view returns (bool) {
        try IERC721(address(recv)).ownerOf(id) returns (address o) {
            return o != address(0);
        } catch {
            return false;
        }
    }
}
