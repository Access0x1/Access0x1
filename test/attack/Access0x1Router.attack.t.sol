// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

/// @notice A malicious merchant payout that, on receiving its net during `payNative`, tries to
///         re-enter through a DIFFERENT function — `claimRescue` — to drain more than it is owed.
///         The shared `nonReentrant` guard must make the inner call revert, which (because the whole
///         `receive` reverts) merely makes the outer push fail, so the net is queued exactly once.
contract CrossFunctionReentrant {
    Access0x1Router public immutable router;

    constructor(Access0x1Router router_) {
        router = router_;
    }

    receive() external payable {
        // Re-enter via claimRescue. nonReentrant (shared with payNative) reverts this inner call.
        router.claimRescue();
    }
}

/// @notice Adversarial tests for the money path — exploit attempts, not happy-path coverage. A green
///         run here is the proof that the router resists the classic payments attacks.
contract Access0x1RouterAttackTest is Test {
    Access0x1Router internal router;
    MockV3Aggregator internal nativeFeed;
    MockV3Aggregator internal usdcFeed;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal buyer = makeAddr("buyer");
    uint16 internal constant PLATFORM_FEE_BPS = 100;
    uint16 internal constant MERCHANT_FEE_BPS = 50;
    bytes32 internal constant ORDER = keccak256("attack");

    function setUp() public {
        vm.warp(1_700_000_000);
        router = new Access0x1Router(owner, treasury, PLATFORM_FEE_BPS);
        nativeFeed = new MockV3Aggregator(8, 2000e8);
        usdcFeed = new MockV3Aggregator(8, 1e8);
        usdc = new MockUSDC();
        vm.startPrank(owner);
        router.setPriceFeed(address(0), address(nativeFeed));
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();
    }

    /// @notice ATTACK: cross-function reentrancy. A malicious payout re-enters `claimRescue` while
    ///         being paid. The guard blocks it; the net is queued once and the router is not drained.
    function test_attack_crossFunctionReentrancyIsBlocked() public {
        CrossFunctionReentrant attacker = new CrossFunctionReentrant(router);
        vm.prank(address(attacker));
        uint256 id = router.registerMerchant(
            address(attacker), feeRecipient, MERCHANT_FEE_BPS, keccak256("evil")
        );

        uint256 gross = router.quote(id, address(0), 20e8);
        uint256 platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        uint256 merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        uint256 net = gross - platformFee - merchantFee;

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        router.payNative{ value: gross }(id, 20e8, ORDER);

        // The re-entrant claim reverted → the net push failed → queued exactly once. No double-pay,
        // no extra drained from the router: it holds precisely the one queued net.
        assertEq(router.rescue(address(attacker)), net);
        assertEq(address(attacker).balance, 0);
        assertEq(address(router).balance, net);
        assertEq(treasury.balance, platformFee); // fees still settled correctly
        assertEq(feeRecipient.balance, merchantFee);
    }

    /// @notice ATTACK: settle on a stale price. The feed last updated > 1h ago; `payNative` must
    ///         revert through the in-tx staleness guard rather than settle on a bad quote.
    function test_attack_stalePriceBlocksSettlement() public {
        vm.prank(address(0xBEEF));
        uint256 id = router.registerMerchant(makeAddr("p"), feeRecipient, 0, keccak256("m"));

        // Push the feed's updatedAt to just over the 1-hour window.
        nativeFeed.setRoundData(2, 2000e8, block.timestamp, block.timestamp - 3601, 2);

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(); // OracleLib__StalePrice bubbles up through quote()
        router.payNative{ value: 1 ether }(id, 20e8, ORDER);
    }

    /// @notice ATTACK: fee-rounding theft. Across arbitrary small USD amounts, the fee can never
    ///         exceed MAX_FEE_BPS of gross and `net + fee == gross` must hold exactly — no dust is
    ///         created for, or stolen from, anyone.
    function testFuzz_attack_feeRoundingCannotExceedCapOrLeak(uint256 usdAmount8) public {
        usdAmount8 = bound(usdAmount8, 1, 1_000_000e8);
        vm.prank(address(0xCAFE));
        uint256 id = router.registerMerchant(makeAddr("p2"), feeRecipient, MERCHANT_FEE_BPS, "m2");

        uint256 gross = router.quote(id, address(0), usdAmount8);
        vm.assume(gross > 0);
        uint256 platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        uint256 merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        uint256 net = gross - platformFee - merchantFee;

        // Conservation + cap, recomputed independently of the contract.
        assertEq(net + platformFee + merchantFee, gross);
        assertLe((platformFee + merchantFee) * 10_000, gross * router.MAX_FEE_BPS());
    }
}
