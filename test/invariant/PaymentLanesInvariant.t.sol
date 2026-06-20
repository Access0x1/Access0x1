// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { PaymentLanesHandler } from "./PaymentLanesHandler.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @notice PaymentLanes' two invariants under a bounded, handler-driven fuzzer:
///         (1) cross-merchant lane isolation — a frozen canary lane never moves; and
///         (2) conservation — for every asset, the ERC-20 held by PaymentLanes equals the sum of
///         unclaimed lane balances (Σ credited − Σ claimed), recomputed INDEPENDENTLY in the handler.
contract PaymentLanesInvariant is StdInvariant, Test, ProxyDeployer {
    PaymentLanes internal lanes;
    PaymentLanesHandler internal handler;
    MockUSDC internal usdc;
    MockUSDC internal eurc;
    address internal admin = makeAddr("pl_admin");

    function setUp() public {
        usdc = new MockUSDC();
        eurc = new MockUSDC();
        lanes = PaymentLanes(
            deployProxy(
                address(new PaymentLanes()), abi.encodeCall(PaymentLanes.initialize, (admin))
            )
        );

        handler = new PaymentLanesHandler(lanes, usdc, eurc);
        // Authorize the handler as the router so its credits succeed, then seed the frozen canary.
        vm.prank(admin);
        lanes.setRouter(address(handler), true);
        handler.seedCanary();

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = PaymentLanesHandler.credit.selector;
        selectors[1] = PaymentLanesHandler.claim.selector;
        selectors[2] = PaymentLanesHandler.transfer.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @notice Invariant 1 — cross-merchant isolation: the frozen canary lane (never touched by any
    ///         action) keeps its exact credited balance no matter what happens on other lanes.
    function invariant_canaryLaneFrozen() public view {
        assertEq(
            lanes.balanceOf(handler.canaryOwner(), handler.canaryId()), handler.canaryBalance()
        );
    }

    /// @notice Invariant 2 — conservation (USDC): PaymentLanes' USDC balance equals Σ unclaimed USDC
    ///         lane balances (the independent ghost), so every receipt is fully backed and no surplus
    ///         is held.
    function invariant_conservationUsdc() public view {
        assertEq(usdc.balanceOf(address(lanes)), handler.ghostHeld(address(usdc)));
    }

    /// @notice Invariant 2 — conservation (EURC): same, for the second asset.
    function invariant_conservationEurc() public view {
        assertEq(eurc.balanceOf(address(lanes)), handler.ghostHeld(address(eurc)));
    }
}
