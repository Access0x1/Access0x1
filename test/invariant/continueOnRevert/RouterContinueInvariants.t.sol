// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { Access0x1Router } from "../../../src/Access0x1Router.sol";
import { MockV3Aggregator } from "../../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../../mocks/MockUSDC.sol";
import { RouterContinueHandler } from "./RouterContinueHandler.sol";

/// @notice The `continueOnRevert` TWIN of `Access0x1RouterInvariant`. The bounded suite proves "no
///         VALID input ever reverts and conservation holds on the accepted-input space"; this one
///         proves "no HOSTILE sequence — unbounded amounts, mismatched assets, garbage ids, raw
///         out-of-order calls — can reach ANY state where the conservation / zero-custody / per-asset
///         firewall properties break." It mirrors fund-me's `ContinueOnRevert` invariants vs its
///         `StopOnRevert` (fail-on-revert) ones, and re-asserts the SAME money properties against an
///         INDEPENDENT ghost recompute.
/// @dev    Every invariant carries a per-function Foundry inline-config natspec that flips
///         fail-on-revert to false, so the hostile handler's reverting calls are TOLERATED — the
///         per-function override beats the global true in foundry.toml, so this suite needs NO config
///         edit and cannot collide with the existing bounded suites. The handler advances its ghosts
///         only on a SUCCESSFUL call, so the recompute stays exact across the accepted-and-rejected
///         union. (The literal directive marker is deliberately omitted from this prose: Foundry's
///         inline-config scanner would otherwise try to parse this sentence as a config line.)
contract RouterContinueInvariants is StdInvariant, Test {
    Access0x1Router internal router;
    RouterContinueHandler internal handler;
    MockV3Aggregator internal nativeFeed;
    MockV3Aggregator internal usdcFeed;
    MockUSDC internal usdc;
    address internal treasury = makeAddr("cont_treasury");
    address internal canaryOwner = makeAddr("cont_canaryOwner");

    // The frozen canary (never touched by the handler) backs the isolation invariant.
    uint256 internal canaryId;
    address internal canaryPayout = makeAddr("cont_canaryPayout");
    address internal canaryFeeRecipient = makeAddr("cont_canaryFeeRecipient");
    uint16 internal constant CANARY_FEE_BPS = 75;
    bytes32 internal constant CANARY_NAME = keccak256("cont_canary");

    /// @dev A never-configured token address, fixed at setUp so the view getters invariant can probe
    ///      an unknown-token key without calling a non-view cheatcode inside a `view` function.
    address internal unknownToken = makeAddr("cont_unknownToken");

    function setUp() public {
        vm.warp(1_700_000_000); // fixed, fresh time so the feeds stay live across the run

        nativeFeed = new MockV3Aggregator(8, 2000e8); // ETH/USD = $2000
        usdcFeed = new MockV3Aggregator(8, 1e8); // USDC/USD = $1
        usdc = new MockUSDC();

        router = new Access0x1Router(address(this), treasury, 100); // 1% platform fee
        router.setPriceFeed(address(0), address(nativeFeed));
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));

        vm.prank(canaryOwner);
        canaryId =
            router.registerMerchant(canaryPayout, canaryFeeRecipient, CANARY_FEE_BPS, CANARY_NAME);

        handler = new RouterContinueHandler(router, usdc, treasury);
        router.transferOwnership(address(handler)); // Ownable2Step handover to the actor
        handler.acceptRouterOwnership();

        // Drive the six hostile state-changing actions (exclude views + the one-shot accept).
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = RouterContinueHandler.registerMerchant.selector;
        selectors[1] = RouterContinueHandler.updateMerchant.selector;
        selectors[2] = RouterContinueHandler.setPlatformFee.selector;
        selectors[3] = RouterContinueHandler.payNative.selector;
        selectors[4] = RouterContinueHandler.payToken.selector;
        selectors[5] = RouterContinueHandler.claimRescue.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @notice Conservation (native): delivered + outstanding-rescue == gross, even under hostile,
    ///         revert-tolerated sequences. No wei is created or destroyed by any reachable path.
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_continue_conservationNative() public view {
        assertEq(
            handler.deliveredNative() + handler.outstandingRescue(), handler.ghostGrossNative()
        );
    }

    /// @notice Conservation (token): every token the hostile handler successfully pushed in was
    ///         delivered out; the cross-asset firewall holds (mismatched-asset calls revert, so the
    ///         token ghost only reflects real USDC settlements).
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_continue_conservationToken() public view {
        assertEq(handler.deliveredToken(), handler.ghostGrossToken());
    }

    /// @notice Σfees: the platform cut always lands at the treasury in full — a hostile sequence can
    ///         never redirect or skim it.
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_continue_platformCutToTreasury() public view {
        assertEq(treasury.balance, handler.ghostPlatformNative());
        assertEq(usdc.balanceOf(treasury), handler.ghostPlatformToken());
    }

    /// @notice Zero-custody residual: the router holds no token at all and only the native still owed
    ///         through `rescue` — including after hostile claim attempts.
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_continue_zeroCustody() public view {
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(address(router).balance, handler.outstandingRescue());
    }

    /// @notice Merchant isolation: no hostile operation on any other merchant mutates the frozen
    ///         canary's stored configuration.
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_continue_merchantIsolation() public view {
        (address payout, address mOwner, address fr, uint16 feeBps, bool active, bytes32 nameHash) =
            router.merchants(canaryId);
        assertEq(payout, canaryPayout);
        assertEq(mOwner, canaryOwner);
        assertEq(fr, canaryFeeRecipient);
        assertEq(feeBps, CANARY_FEE_BPS);
        assertTrue(active);
        assertEq(nameHash, CANARY_NAME);
    }

    /// @notice Fee cap: no payment is ever charged more than MAX_FEE_BPS of gross, even after a
    ///         hostile platform-fee raise under an existing surcharge (the squeeze).
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_continue_feeCap() public view {
        assertTrue(handler.feeCapRespected());
    }

    /// @notice Getters can't revert: every public view on the router is callable in ANY reachable
    ///         state the hostile fuzzer drove the contract into. A view that reverts on some state is
    ///         a DoS surface for indexers/SDKs/frontends — this asserts none exists. Runs once per
    ///         fuzz sequence.
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_gettersCantRevert() public view {
        // Scalar / config getters.
        router.owner();
        router.pendingOwner();
        router.paused();
        router.platformTreasury();
        router.platformFeeBps();
        router.nextMerchantId();
        router.paymentLanes();
        router.MAX_FEE_BPS();

        // Mapping getters over a spread of keys: the canary, every handler merchant, a never-set id,
        // the native sentinel + the allowlisted token + an unknown token + the zero address.
        router.merchants(canaryId);
        router.merchants(0);
        router.merchants(type(uint256).max);
        uint256 next = router.nextMerchantId();
        for (uint256 i = 1; i < next && i <= 16; ++i) {
            router.merchants(i);
        }

        address[4] memory tokens = [address(0), address(usdc), unknownToken, address(this)];
        for (uint256 i = 0; i < tokens.length; ++i) {
            router.tokenAllowed(tokens[i]);
            router.priceFeedOf(tokens[i]);
            router.rescue(tokens[i]);
        }
        router.rescue(treasury);
        router.rescue(canaryPayout);

        // The priced view: a real quote against the live feed must not revert on a sane USD amount.
        router.quote(canaryId, address(0), 1e8);
        router.quote(canaryId, address(usdc), 1e8);
    }
}
