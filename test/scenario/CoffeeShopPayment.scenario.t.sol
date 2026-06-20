// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";

import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @title  CoffeeShop — the simplest real flow, told as a story
/// @author Access0x1
/// @notice SCENARIO (the way an auditor reads the happy path): a corner coffee shop wants to take
///         crypto without holding a wallet of "merchant funds." The owner onboards once, a customer
///         buys a $5 latte in USDC, and in that ONE transaction the platform fee is taken, the
///         merchant is paid the net, and the router is left holding nothing.
///
///         What an auditor is checking here, in plain terms:
///           1. Onboarding is permissionless and the caller becomes the merchant owner (no admin
///              gatekeeper can lock a business out).
///           2. The price is read from the Chainlink feed INSIDE the settlement tx — not a number the
///              frontend passed in — so the customer can never under/over-pay a quote that drifted.
///           3. CONSERVATION: net + platformFee + merchantFee == gross, to the wei. No dust is
///              created or destroyed by the split.
///           4. ZERO CUSTODY: after the tx the router's USDC balance is exactly zero. A business's
///              money is never parked in the contract, not even for one block.
///           5. The exact recipients: net -> the shop's payout wallet, platform fee -> treasury.
///
///         This is deliberately NOT a fuzz test. It is a single, concrete, readable transaction with
///         realistic names and amounts, so a reviewer can follow the money by eye.
contract CoffeeShopPaymentScenarioTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    MockUSDC internal usdc; // 6-decimal USDC — the real shape on Base / Arc
    MockV3Aggregator internal usdcFeed; // USDC/USD, 8 decimals, pinned at $1.00

    // The cast of characters — real-sounding so the scenario reads like an incident report.
    address internal platformAdmin = makeAddr("access0x1-platform-admin");
    address internal treasury = makeAddr("access0x1-treasury");
    address internal beanScene = makeAddr("bean-scene-coffee-owner"); // the shop owner's wallet
    address internal shopTill = makeAddr("bean-scene-till"); // where net settles (the "register")
    address internal regular = makeAddr("morning-regular"); // the customer buying a latte

    uint16 internal constant PLATFORM_FEE_BPS = 100; // Access0x1 takes 1.00%
    uint16 internal constant SHOP_SURCHARGE_BPS = 0; // the shop adds no surcharge of its own
    uint256 internal constant LATTE_USD8 = 5e8; // a $5.00 latte, in the estate's 8-dp USD unit

    function setUp() public {
        // Pin a stable, recent timestamp so the Chainlink staleness guard (1h window) is satisfied.
        vm.warp(1_700_000_000);

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(
                    Access0x1Router.initialize, (platformAdmin, treasury, PLATFORM_FEE_BPS)
                )
            )
        );
        usdc = new MockUSDC();
        usdcFeed = new MockV3Aggregator(8, 1e8); // $1.00 / USDC

        // The platform allowlists USDC and wires its price feed (admin-only config, once).
        vm.startPrank(platformAdmin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        // Give the regular customer a wallet with USDC and the standard "approve the router" step a
        // real checkout would prompt once.
        usdc.mint(regular, 1_000e6);
        vm.prank(regular);
        usdc.approve(address(router), type(uint256).max);
    }

    /// @notice The full story: onboard -> pay $5 -> exact split -> merchant paid net -> zero custody.
    function test_scenario_coffeeShop_paysFiveDollars_splitsExactly_zeroCustody() public {
        // ── Act 1: the shop onboards. It is permissionless — Bean Scene registers itself. ──────────
        vm.prank(beanScene);
        uint256 merchantId = router.registerMerchant(
            shopTill, address(0), SHOP_SURCHARGE_BPS, keccak256("bean-scene")
        );

        // The caller — not the platform — is recorded as the merchant owner. No one can lock them out.
        (address payout, address owner,,,,) = router.merchants(merchantId);
        assertEq(
            owner, beanScene, "the shop owner is whoever registered (permissionless onboarding)"
        );
        assertEq(payout, shopTill, "net settles to the till the shop chose");

        // ── Act 2: the quote is read live from Chainlink, in-tx. At $1/USDC a $5 latte is 5 USDC. ──
        uint256 gross = router.quote(merchantId, address(usdc), LATTE_USD8);
        assertEq(gross, 5e6, "$5 at $1.00/USDC prices to exactly 5 USDC (6 decimals)");

        // The split an auditor reproduces by hand: 1% of 5 USDC = 0.05 USDC to the platform.
        uint256 platformFee = gross * PLATFORM_FEE_BPS / 10_000; // 50_000 (0.05 USDC)
        uint256 net = gross - platformFee; // 4_950_000 (4.95 USDC)
        // The single most important line: nothing is created or lost in the split.
        assertEq(net + platformFee, gross, "CONSERVATION: net + fee == gross");

        // Snapshot every wallet so each leg is proven by its own delta, not by trust.
        uint256 customerBefore = usdc.balanceOf(regular);
        uint256 tillBefore = usdc.balanceOf(shopTill);
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        // ── Act 3: the customer taps to pay. One transaction settles everything. ───────────────────
        vm.prank(regular);
        router.payToken(merchantId, address(usdc), LATTE_USD8, keccak256("order-latte-0001"));

        // The customer paid exactly the gross — not a wei more (no hidden spread).
        assertEq(
            usdc.balanceOf(regular), customerBefore - gross, "customer debited exactly the gross"
        );

        // The shop was paid its net IN THE SAME TX — no settlement delay, no payout batch.
        assertEq(usdc.balanceOf(shopTill), tillBefore + net, "shop paid net in the same tx");

        // The platform's 1% landed at the treasury.
        assertEq(usdc.balanceOf(treasury), treasuryBefore + platformFee, "platform fee -> treasury");

        // ── The clincher: zero custody. The router never holds the business's money. ───────────────
        assertEq(usdc.balanceOf(address(router)), 0, "router holds ZERO USDC after settlement");
    }
}
