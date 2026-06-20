// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { RouterHandler } from "./RouterHandler.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @notice The router's six money invariants under a bounded, handler-driven fuzzer — the security
///         floor for a zero-custody payments contract. Every property is asserted against an
///         INDEPENDENT ghost recomputation in the handler, never against the contract's own numbers.
/// @dev    The handler owns the platform + every merchant and drives register/update/setPlatformFee/
///         payNative/payToken. A frozen "canary" merchant (id 1, never touched by the handler) backs
///         the isolation invariant: if any operation on another merchant corrupted its slot, the
///         snapshot comparison would catch it.
contract Access0x1RouterInvariant is StdInvariant, Test, ProxyDeployer {
    Access0x1Router internal router;
    RouterHandler internal handler;
    MockV3Aggregator internal nativeFeed;
    MockV3Aggregator internal usdcFeed;
    MockUSDC internal usdc;
    address internal treasury = makeAddr("inv_treasury");
    address internal canaryOwner = makeAddr("canaryOwner");

    // The frozen canary's snapshot (invariant 4).
    uint256 internal canaryId;
    address internal canaryPayout = makeAddr("canaryPayout");
    address internal canaryFeeRecipient = makeAddr("canaryFeeRecipient");
    uint16 internal constant CANARY_FEE_BPS = 75;
    bytes32 internal constant CANARY_NAME = keccak256("canary");

    function setUp() public {
        vm.warp(1_700_000_000); // fixed, fresh time; the fuzzer holds it constant so feeds stay live

        nativeFeed = new MockV3Aggregator(8, 2000e8); // ETH/USD = $2000
        usdcFeed = new MockV3Aggregator(8, 1e8); // USDC/USD = $1
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

        // The canary: a normal merchant the handler never sees, so its slot must never change.
        vm.prank(canaryOwner);
        canaryId = router.registerMerchant(
            canaryPayout, canaryFeeRecipient, CANARY_FEE_BPS, CANARY_NAME
        );

        handler = new RouterHandler(router, usdc, treasury);
        router.transferOwnership(address(handler)); // Ownable2Step handover to the actor
        handler.acceptRouterOwnership();

        // Drive only the five state-changing actions (exclude the view helpers + the one-shot accept,
        // which would revert and trip fail_on_revert).
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = RouterHandler.registerMerchant.selector;
        selectors[1] = RouterHandler.updateMerchant.selector;
        selectors[2] = RouterHandler.setPlatformFee.selector;
        selectors[3] = RouterHandler.payNative.selector;
        selectors[4] = RouterHandler.payToken.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @notice Invariant 1 — fee + net == gross (native): no wei is created or destroyed. Everything
    ///         paid in is either delivered to a sink or owed back as rescue.
    function invariant_conservationNative() public view {
        assertEq(
            handler.deliveredNative() + handler.outstandingRescue(), handler.ghostGrossNative()
        );
    }

    /// @notice Invariant 1 — fee + net == gross (token): every token pulled in is delivered out.
    function invariant_conservationToken() public view {
        assertEq(handler.deliveredToken(), handler.ghostGrossToken());
    }

    /// @notice Invariant 2 — Σfees: the platform's cut lands at the treasury in full, every time. A
    ///         merchant can never redirect it (the dedicated treasury balance equals the independent
    ///         sum of expected platform fees).
    function invariant_platformCutToTreasury() public view {
        assertEq(treasury.balance, handler.ghostPlatformNative());
        assertEq(usdc.balanceOf(treasury), handler.ghostPlatformToken());
    }

    /// @notice Invariant 3 — zero-custody residual: the router holds no token at all, and only ever
    ///         holds the native that is owed back through `rescue`.
    function invariant_zeroCustody() public view {
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(address(router).balance, handler.outstandingRescue());
    }

    /// @notice Invariant 4 — merchant isolation: paying or updating any other merchant never mutates
    ///         the frozen canary's stored configuration.
    function invariant_merchantIsolation() public view {
        (address payout, address mOwner, address fr, uint16 feeBps, bool active, bytes32 nameHash) =
            router.merchants(canaryId);
        assertEq(payout, canaryPayout);
        assertEq(mOwner, canaryOwner);
        assertEq(fr, canaryFeeRecipient);
        assertEq(feeBps, CANARY_FEE_BPS);
        assertTrue(active);
        assertEq(nameHash, CANARY_NAME);
    }

    /// @notice Invariant 5 — fee cap: no payment is ever charged more than MAX_FEE_BPS of gross, even
    ///         after the platform fee is raised under an existing merchant surcharge (the squeeze).
    function invariant_feeCap() public view {
        assertTrue(handler.feeCapRespected());
    }
}
