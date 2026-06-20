// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { GaslessPayIn } from "../../src/GaslessPayIn.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDCGasless } from "../mocks/MockUSDCGasless.sol";
import { GaslessPayInHandler } from "./GaslessPayInHandler.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @notice The GaslessPayIn money invariants under a bounded, handler-driven fuzzer — the security floor
///         for the gasless first-dollar primitive. Every property is asserted against an INDEPENDENT
///         ghost recomputation in the handler, never against the contract's own numbers. The headline is
///         ZERO CUSTODY: across every settled pay-in on every rail, the contract (and the router) retain
///         no token balance, and net + fee == gross at the sinks.
/// @dev    Time is FROZEN (so the feed stays live). The handler drives the three rails as EOA buyers it
///         holds the keys for; all recipients always receive, so the router never queues and conservation
///         is an exact equality. Runs under `fail_on_revert = true`, so the handler's funded, fresh-nonce
///         actions never revert — a token-replay or shortfall would trip the run.
contract GaslessPayInInvariant is StdInvariant, Test, ProxyDeployer {
    GaslessPayIn internal payIn;
    Access0x1Router internal router;
    GaslessPayInHandler internal handler;

    MockV3Aggregator internal usdcFeed;
    MockUSDCGasless internal usdc;

    address internal admin = makeAddr("gpi_admin");
    address internal treasury = makeAddr("gpi_treasury");
    address internal merchantOwner = makeAddr("gpi_merchantOwner");
    address internal payout = makeAddr("gpi_payout");
    address internal feeRecipient = makeAddr("gpi_feeRecipient");
    uint256 internal merchantId;

    function setUp() public {
        vm.warp(1_700_000_000); // fixed, fresh time held constant by the fuzzer

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (admin, treasury, 100))
            )
        ); // 1% platform fee

        usdcFeed = new MockV3Aggregator(8, 1e8); // $1 per USDC
        usdc = new MockUSDCGasless();
        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        address payInImpl = address(new GaslessPayIn());
        payIn = GaslessPayIn(
            deployProxy(payInImpl, abi.encodeCall(GaslessPayIn.initialize, (admin, router)))
        );

        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, 50, keccak256("gpi_m")); // 0.5%

        handler = new GaslessPayInHandler(
            payIn, router, usdc, merchantId, treasury, payout, feeRecipient
        );

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = GaslessPayInHandler.payInWithPermit.selector;
        selectors[1] = GaslessPayInHandler.payInWithPermit7597.selector;
        selectors[2] = GaslessPayInHandler.payInWithAuthorization.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @notice Invariant 1 — ZERO CUSTODY (the headline): the GaslessPayIn contract retains NO token
    ///         balance after any settled pay-in, on any rail. The pull is exact and the router pushes the
    ///         full net + fee out in the same tx; the contract's own residual check enforces this, and the
    ///         fuzzer proves it holds across every interleaving.
    function invariant_zeroCustodyPayIn() public view {
        assertEq(usdc.balanceOf(address(payIn)), 0);
    }

    /// @notice Invariant 1 (router leg) — the composed router also retains no token after settlement (its
    ///         own zero-custody property, re-checked through this primitive's traffic).
    function invariant_zeroCustodyRouter() public view {
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    /// @notice Invariant 2 — net + fee == gross (conservation): every token unit the router split was
    ///         delivered to a sink. The independent ghost sum of gross routed equals the sink total, so no
    ///         value is created or lost across the gasless hop.
    function invariant_conservationMatchesSinks() public view {
        assertEq(handler.sinkTotal(), handler.ghostGrossSettled());
    }

    /// @notice Invariant 3 — no dangling router allowance: the contract never leaves an approval to the
    ///         router standing between pay-ins (it force-resets to 0 after every route), so no stale
    ///         allowance can ever be exploited.
    function invariant_noDanglingRouterAllowance() public view {
        assertEq(usdc.allowance(address(payIn), address(router)), 0);
    }
}
