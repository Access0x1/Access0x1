// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockERC777 } from "../mocks/MockERC777.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @title  Access0x1Router777AttackTest
/// @author Access0x1
/// @notice Proof that the router safely accepts an ERC-777 pay token. ERC-777 is ERC-20-compatible,
///         so `payToken` accepts it with no code change — the risk is the `tokensReceived` /
///         `tokensToSend` HOOKS, which hand control to attacker code mid-settlement (the imBTC /
///         Uniswap-V1 reentrancy class). These tests arm a malicious 777 to re-enter `payToken` on
///         the pull-IN leg, the outbound-PUSH legs, and both, and assert that:
///           1. the shared `nonReentrant` guard reverts the inner call;
///           2. because the router's transfers are plain (non-try) SafeERC20, that inner revert
///              propagates and rolls back the ENTIRE outer payment (atomic — no phantom receipt);
///           3. the money invariants hold on the surviving (non-attacking) happy path: every leg
///              conserves (net + platformFee + merchantFee == gross) and the router keeps ZERO custody.
contract Access0x1Router777AttackTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    MockV3Aggregator internal tokenFeed;
    MockERC777 internal token;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal sellerPayout = makeAddr("sellerPayout");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal merchantOwner = makeAddr("merchantOwner");
    address internal buyer = makeAddr("buyer");

    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5%
    uint256 internal constant PRICE_USD8 = 25e8; // $25.00
    bytes32 internal constant ORDER = keccak256("777");

    uint256 internal merchantId;

    function setUp() public {
        vm.warp(1_700_000_000);
        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (owner, treasury, PLATFORM_FEE_BPS))
            )
        );

        token = new MockERC777();
        tokenFeed = new MockV3Aggregator(8, 1e8); // $1 per token, like USDC

        vm.startPrank(owner);
        router.setTokenAllowed(address(token), true);
        router.setPriceFeed(address(token), address(tokenFeed));
        vm.stopPrank();

        vm.prank(merchantOwner);
        merchantId =
            router.registerMerchant(sellerPayout, feeRecipient, MERCHANT_FEE_BPS, keccak256("m"));

        // Fund the buyer generously so an undetected double-settle would have the balance to succeed.
        token.mint(buyer, 1_000_000e6);
    }

    /// @dev Expected legs for a clean settlement of `gross`.
    function _legs(uint256 gross)
        internal
        pure
        returns (uint256 platformFee, uint256 merchantFee, uint256 net)
    {
        platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        net = gross - platformFee - merchantFee;
    }

    /// @notice ATTACK: the 777 `tokensReceived` hook re-enters `payToken` on the router's pull-IN leg
    ///         — the most dangerous window, mid-settlement before any split or push. The guard must
    ///         revert the inner call and (via the plain SafeERC20 transfer) the whole outer payment.
    function test_attack_777_receivedHookReentrancyReverts() public {
        token.arm(router, merchantId, PRICE_USD8, 1); // mode 1 = tokensReceived on pull-in

        uint256 gross = router.quote(merchantId, address(token), PRICE_USD8);
        vm.prank(buyer);
        token.approve(address(router), gross);

        vm.prank(buyer);
        vm.expectRevert(); // inner nonReentrant revert propagates through the pull-in
        router.payToken(merchantId, address(token), PRICE_USD8, ORDER);

        // Atomic rollback: nothing settled anywhere, buyer keeps every token, router holds nothing.
        assertEq(token.balanceOf(address(router)), 0, "router custody after blocked pull-in");
        assertEq(token.balanceOf(sellerPayout), 0, "seller paid on a reverted tx");
        assertEq(token.balanceOf(treasury), 0, "treasury paid on a reverted tx");
        assertEq(token.balanceOf(feeRecipient), 0, "feeRecipient paid on a reverted tx");
        assertEq(token.balanceOf(buyer), 1_000_000e6, "buyer lost tokens on a reverted tx");
    }

    /// @notice ATTACK: the 777 `tokensToSend` hook re-enters `payToken` on the router's OUTBOUND push
    ///         (net → payout). The guard reverts the inner call; the plain SafeERC20 push re-throws,
    ///         reverting the whole outer payment — proving an outbound callback cannot double-settle.
    function test_attack_777_sendHookReentrancyReverts() public {
        token.arm(router, merchantId, PRICE_USD8, 2); // mode 2 = tokensToSend on outbound push

        uint256 gross = router.quote(merchantId, address(token), PRICE_USD8);
        vm.prank(buyer);
        token.approve(address(router), gross);

        vm.prank(buyer);
        vm.expectRevert();
        router.payToken(merchantId, address(token), PRICE_USD8, ORDER);

        assertEq(token.balanceOf(address(router)), 0, "router custody after blocked push");
        assertEq(token.balanceOf(sellerPayout), 0, "seller paid on a reverted tx");
        assertEq(token.balanceOf(treasury), 0, "treasury paid on a reverted tx");
        assertEq(token.balanceOf(buyer), 1_000_000e6, "buyer lost tokens on a reverted tx");
    }

    /// @notice ATTACK: BOTH hooks armed. The first one reached (pull-in) reverts the tx; either way
    ///         the outer payment rolls back atomically and no value leaks.
    function test_attack_777_bothHooksReentrancyReverts() public {
        token.arm(router, merchantId, PRICE_USD8, 3); // mode 3 = both

        uint256 gross = router.quote(merchantId, address(token), PRICE_USD8);
        vm.prank(buyer);
        token.approve(address(router), gross);

        vm.prank(buyer);
        vm.expectRevert();
        router.payToken(merchantId, address(token), PRICE_USD8, ORDER);

        assertEq(token.balanceOf(address(router)), 0, "router custody after blocked dual-hook");
        assertEq(token.balanceOf(sellerPayout), 0, "seller paid on a reverted tx");
        assertEq(token.balanceOf(buyer), 1_000_000e6, "buyer lost tokens on a reverted tx");
    }

    /// @notice SAFETY: with the hook DISARMED, the same 777 settles cleanly. This is the proof the
    ///         router genuinely ACCEPTS ERC-777 as a pay token (not merely rejects it): the money
    ///         invariants hold (net + fees == gross, exact two-leg split) and the router keeps ZERO
    ///         custody — identical behavior to a plain ERC-20.
    function test_777_disarmedSettlesCleanlyZeroCustody() public {
        token.arm(router, merchantId, PRICE_USD8, 0); // no hook

        uint256 gross = router.quote(merchantId, address(token), PRICE_USD8);
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _legs(gross);

        vm.prank(buyer);
        token.approve(address(router), gross);
        vm.prank(buyer);
        router.payToken(merchantId, address(token), PRICE_USD8, ORDER);

        // Money invariants.
        assertEq(net + platformFee + merchantFee, gross, "conservation");
        assertEq(token.balanceOf(sellerPayout), net, "net to payout");
        assertEq(token.balanceOf(treasury), platformFee, "platform fee to treasury");
        assertEq(token.balanceOf(feeRecipient), merchantFee, "merchant fee to feeRecipient");
        // Zero custody: the router holds nothing after settlement.
        assertEq(token.balanceOf(address(router)), 0, "router zero custody");
        // Buyer paid exactly gross.
        assertEq(token.balanceOf(buyer), 1_000_000e6 - gross, "buyer charged exactly gross");
    }

    /// @notice FUZZ (stateless): for any price, the disarmed 777 settles with exact conservation and
    ///         zero router custody, and the effective fee never exceeds the cap.
    function testFuzz_777_settlesConservedZeroCustody(uint256 usd8) public {
        usd8 = bound(usd8, 1e6, 100_000e8); // $0.01 .. $100k
        token.arm(router, merchantId, usd8, 0);

        uint256 gross = router.quote(merchantId, address(token), usd8);
        vm.assume(gross > 0 && gross <= 1_000_000e6);
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _legs(gross);

        vm.prank(buyer);
        token.approve(address(router), gross);
        vm.prank(buyer);
        router.payToken(merchantId, address(token), usd8, ORDER);

        assertEq(net + platformFee + merchantFee, gross, "conservation");
        assertEq(token.balanceOf(address(router)), 0, "zero custody");
        assertLe((platformFee + merchantFee) * 10_000, gross * router.MAX_FEE_BPS(), "fee cap");
    }
}
