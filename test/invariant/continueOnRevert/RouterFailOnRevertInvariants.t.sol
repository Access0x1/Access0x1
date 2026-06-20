// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { Access0x1Router } from "../../../src/Access0x1Router.sol";
import { MockV3Aggregator } from "../../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../../mocks/MockUSDC.sol";
import { RouterHandler } from "../RouterHandler.sol";
import { ProxyDeployer } from "../../utils/ProxyDeployer.sol";

/// @notice The `failOnRevert` half of the dual invariant pair — the explicit twin that lives beside
///         the `continueOnRevert` suite so the gold-standard fund-me split (`StopOnRevert` bounded vs
///         `ContinueOnRevert` hostile) is readable in one directory. It reuses the SAME bounded
///         `RouterHandler` as the canonical `Access0x1RouterInvariant`: every action is `bound`ed and
///         early-returns on bad preconditions, so under the global `fail_on_revert = true` ANY revert
///         is a real bug. It re-asserts the conservation / Σfees / zero-custody / isolation / fee-cap
///         properties AND adds `invariant_gettersCantRevert`, the dual of the one in the continue
///         suite — proving the public view surface never reverts even on the bounded, all-valid path.
/// @dev    No per-function natspec here: these invariants inherit the global `fail_on_revert = true`
///         from `[profile.default.invariant]`, which is exactly what makes this the StopOnRevert half.
contract RouterFailOnRevertInvariants is StdInvariant, Test, ProxyDeployer {
    Access0x1Router internal router;
    RouterHandler internal handler;
    MockV3Aggregator internal nativeFeed;
    MockV3Aggregator internal usdcFeed;
    MockUSDC internal usdc;
    address internal treasury = makeAddr("for_treasury");
    address internal canaryOwner = makeAddr("for_canaryOwner");

    uint256 internal canaryId;
    address internal canaryPayout = makeAddr("for_canaryPayout");
    address internal canaryFeeRecipient = makeAddr("for_canaryFeeRecipient");
    uint16 internal constant CANARY_FEE_BPS = 75;
    bytes32 internal constant CANARY_NAME = keccak256("for_canary");

    function setUp() public {
        vm.warp(1_700_000_000);

        nativeFeed = new MockV3Aggregator(8, 2000e8);
        usdcFeed = new MockV3Aggregator(8, 1e8);
        usdc = new MockUSDC();

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (address(this), treasury, 100))
            )
        );
        router.setPriceFeed(address(0), address(nativeFeed));
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));

        vm.prank(canaryOwner);
        canaryId =
            router.registerMerchant(canaryPayout, canaryFeeRecipient, CANARY_FEE_BPS, CANARY_NAME);

        handler = new RouterHandler(router, usdc, treasury);
        router.transferOwnership(address(handler));
        handler.acceptRouterOwnership();

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = RouterHandler.registerMerchant.selector;
        selectors[1] = RouterHandler.updateMerchant.selector;
        selectors[2] = RouterHandler.setPlatformFee.selector;
        selectors[3] = RouterHandler.payNative.selector;
        selectors[4] = RouterHandler.payToken.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @notice Conservation (native): delivered + outstanding-rescue == gross on the bounded path.
    function invariant_failOnRevert_conservationNative() public view {
        assertEq(
            handler.deliveredNative() + handler.outstandingRescue(), handler.ghostGrossNative()
        );
    }

    /// @notice Conservation (token): every token pulled in is delivered out.
    function invariant_failOnRevert_conservationToken() public view {
        assertEq(handler.deliveredToken(), handler.ghostGrossToken());
    }

    /// @notice Σfees: the platform cut lands at the treasury in full.
    function invariant_failOnRevert_platformCutToTreasury() public view {
        assertEq(treasury.balance, handler.ghostPlatformNative());
        assertEq(usdc.balanceOf(treasury), handler.ghostPlatformToken());
    }

    /// @notice Zero-custody residual: no token held; only owed-back native.
    function invariant_failOnRevert_zeroCustody() public view {
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(address(router).balance, handler.outstandingRescue());
    }

    /// @notice Merchant isolation: the frozen canary's slot never mutates.
    function invariant_failOnRevert_merchantIsolation() public view {
        (address payout, address mOwner, address fr, uint16 feeBps, bool active, bytes32 nameHash) =
            router.merchants(canaryId);
        assertEq(payout, canaryPayout);
        assertEq(mOwner, canaryOwner);
        assertEq(fr, canaryFeeRecipient);
        assertEq(feeBps, CANARY_FEE_BPS);
        assertTrue(active);
        assertEq(nameHash, CANARY_NAME);
    }

    /// @notice Fee cap: no payment exceeds MAX_FEE_BPS of gross.
    function invariant_failOnRevert_feeCap() public view {
        assertTrue(handler.feeCapRespected());
    }

    /// @notice Getters can't revert (bounded twin): every public view is callable in every reachable
    ///         state of the all-valid path. The dual of the continue-suite invariant of the same name.
    function invariant_failOnRevert_gettersCantRevert() public view {
        router.owner();
        router.pendingOwner();
        router.paused();
        router.platformTreasury();
        router.platformFeeBps();
        router.nextMerchantId();
        router.paymentLanes();
        router.MAX_FEE_BPS();

        router.merchants(canaryId);
        router.merchants(0);
        router.merchants(type(uint256).max);
        uint256 next = router.nextMerchantId();
        for (uint256 i = 1; i < next && i <= 16; ++i) {
            router.merchants(i);
        }

        router.tokenAllowed(address(0));
        router.tokenAllowed(address(usdc));
        router.priceFeedOf(address(0));
        router.priceFeedOf(address(usdc));
        router.rescue(canaryPayout);
        router.rescue(treasury);

        router.quote(canaryId, address(0), 1e8);
        router.quote(canaryId, address(usdc), 1e8);
    }
}
