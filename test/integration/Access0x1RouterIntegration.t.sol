// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { DeployAll } from "../../script/DeployAll.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

/// @title  Access0x1RouterIntegration
/// @author Access0x1
/// @notice The Cyfrin INTEGRATION tier for the router: `setUp` deploys the router through the REAL
///         {DeployAll} + {HelperConfig} script (so the DEPLOY ITSELF is under test, not a hand-rolled
///         `new Access0x1Router(...)`), then exercises the money spine end-to-end through its real,
///         script-wired composition — including the {PaymentLanes} (ERC-6909) lane-receipt seam that
///         {DeployAll} authorizes and wires when `DEPLOY_PAYMENT_LANES=true`.
///
///         This is deliberately DIFFERENT from the existing `EndToEnd.t.sol` (which constructs the
///         estate by hand) and from `DeployAll.t.sol` (which runs the script but only asserts the
///         WIRED CONFIG, never settles a payment through it). Here the assertions are: the
///         script-deployed router actually prices via the script-wired Chainlink mock, splits the fee
///         two ways, routes the net into the script-authorized PaymentLanes as a claimable receipt,
///         and stays zero-custody — proving the deployed-and-wired system composes, not just the
///         contract in isolation.
/// @dev    On the local chain id (31337) {HelperConfig} deploys the shared mocks ({MockUSDC} 6-dec,
///         {MockV3Aggregator} $1 USDC + $2000 native) inside its own broadcast, so the whole flow is
///         self-contained with no RPC/env. `ROUTER_OWNER` is pinned to the broadcast default sender
///         (matching `DeployAll.t.sol`'s `_ownerIsBroadcaster`) so the in-broadcast owner-only configure
///         + lanes-wiring calls are authorized — reproducing a real `--sender $DEPLOYER` run where the
///         owner defaults to the signer. The mocks are reused, never re-declared.
contract Access0x1RouterIntegration is Test {
    /// @dev Foundry's broadcast default sender — the address `vm.startBroadcast()` (no arg) pranks as.
    ///      The router owner is pinned here so the script's owner-only steps run inside the broadcast.
    address internal constant BROADCASTER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    /// @dev Local Anvil chain id — selects HelperConfig's mock-deploying branch.
    uint256 internal constant LOCAL_CHAIN_ID = 31_337;

    Access0x1Router internal router;
    PaymentLanes internal lanes;
    HelperConfig internal helperConfig;
    HelperConfig.NetworkConfig internal cfg;

    MockUSDC internal usdc; // resolved from the script-deployed mock (cfg.usdc)
    address internal treasury; // the script's treasury (= broadcaster on local)

    address internal merchantOwner = makeAddr("it_merchantOwner");
    address internal payout = makeAddr("it_payout");
    address internal feeRecipient = makeAddr("it_feeRecipient");
    address internal buyer = makeAddr("it_buyer");

    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.50% surcharge
    uint256 internal constant USD_AMOUNT_8 = 250e8; // a $250.00 order, 8-dec USD
    bytes32 internal constant ORDER = keccak256("it_order-1");
    bytes32 internal constant NAME_HASH = keccak256("acme.access0x1.eth");

    // Re-declared so the integration test can `expectEmit` on the receipt (events are not inherited
    // into test scope). Mirrors Access0x1Router.PaymentReceived exactly.
    event PaymentReceived(
        uint256 indexed merchantId,
        address indexed buyer,
        address indexed token,
        uint256 grossAmount,
        uint256 feeAmount,
        uint256 netAmount,
        uint256 usdAmount8,
        bytes32 orderId,
        uint64 srcChainSelector
    );

    /// @notice Deploy the spine through the REAL {DeployAll} script (lanes ON), then resolve the
    ///         script-deployed mocks + register a merchant. Everything below the script call exercises
    ///         the deployed-and-wired system, never a fresh hand-built router.
    function setUp() public {
        // A non-zero, stable timestamp keeps the script-wired Chainlink mock inside the staleness window.
        vm.warp(1_700_000_000);
        vm.chainId(LOCAL_CHAIN_ID);

        // Pin the owner to the broadcaster so the script's owner-only configure + lanes-wiring calls
        // execute inside the broadcast (the `--sender $DEPLOYER` real-run match).
        vm.setEnv("ROUTER_OWNER", vm.toString(BROADCASTER));
        // Ask the script to also deploy + authorize + wire PaymentLanes (the lane-receipt seam).
        vm.setEnv("DEPLOY_PAYMENT_LANES", "true");

        // THE DEPLOY UNDER TEST: one script call stands up + wires the whole spine.
        (router, lanes, helperConfig) = new DeployAll().run();
        cfg = helperConfig.getConfig();

        // Resolve the script-deployed mocks (HelperConfig deployed these on the local branch).
        usdc = MockUSDC(cfg.usdc);
        treasury = cfg.treasury; // on local, the broadcaster

        // Register a merchant against the script-deployed router (permissionless; caller = owner).
        vm.prank(merchantOwner);
        router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);

        // Fund + approve the buyer to pay through the real router.
        usdc.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        usdc.approve(address(router), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
            THE DEPLOY ITSELF IS CORRECT (script post-conditions)
    //////////////////////////////////////////////////////////////*/

    /// @notice The script produced a fully wired spine: the router exists, is owned by the configured
    ///         admin, carries the script's treasury + fee, and has USDC allowlisted + fed + PaymentLanes
    ///         authorized and wired — the exact composition the money path below relies on. This asserts
    ///         the DEPLOY is the system under test, not a fixture.
    function test_integration_deployWiredTheWholeSpine() public view {
        assertTrue(address(router) != address(0), "router deployed");
        assertEq(router.owner(), BROADCASTER, "router owned by the configured admin");
        assertEq(router.platformTreasury(), cfg.treasury, "treasury wired from config");
        assertEq(router.platformFeeBps(), cfg.platformFeeBps, "platform fee wired from config");
        assertEq(router.nextMerchantId(), 2, "one merchant registered in setUp (next id is 2)");

        // USDC allowlisted + fed by the script's configure step.
        assertTrue(router.tokenAllowed(cfg.usdc), "USDC allowlisted by the script");
        assertEq(router.priceFeedOf(cfg.usdc), cfg.usdcUsdFeed, "USDC/USD feed wired by the script");
        assertEq(router.priceFeedOf(address(0)), cfg.nativeUsdFeed, "native feed at sentinel slot");

        // PaymentLanes deployed, the router authorized to credit it, and wired into the router.
        assertTrue(
            address(lanes) != address(0), "PaymentLanes deployed (DEPLOY_PAYMENT_LANES=true)"
        );
        assertTrue(lanes.isRouter(address(router)), "router authorized to credit lanes");
        assertEq(router.paymentLanes(), address(lanes), "lanes wired into the router pay path");
    }

    /*//////////////////////////////////////////////////////////////
        THE FULL MONEY FLOW THROUGH THE SCRIPT-WIRED COMPOSITION
    //////////////////////////////////////////////////////////////*/

    /// @notice End-to-end through the script-deployed system: quote via the script-wired Chainlink mock
    ///         -> payToken -> exact two-leg split -> net routed into the script-authorized PaymentLanes
    ///         as a lane receipt -> merchant claims real USDC -> router stays zero-custody. Every leg is
    ///         a delta against the deployed system, with the receipt event asserted exactly.
    function test_integration_payTokenRoutesNetIntoLanesAndClaims() public {
        uint256 merchantId = 1; // the only merchant registered in setUp

        // Pricing comes from the SCRIPT-WIRED feed: $1.00/USDC -> a $250 order is 250 USDC = 250e6.
        uint256 gross = router.quote(merchantId, address(usdc), USD_AMOUNT_8);
        assertEq(gross, 250e6, "script-wired feed prices $250 at $1/USDC to 250e6");

        uint256 platformFee = gross * router.platformFeeBps() / 10_000;
        uint256 merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        uint256 net = gross - platformFee - merchantFee;
        assertEq(net + platformFee + merchantFee, gross, "conservation: net + fee == gross");

        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        uint256 feeRecipientBefore = usdc.balanceOf(feeRecipient);
        uint256 lanesBefore = usdc.balanceOf(address(lanes));
        uint256 laneId = lanes.laneId(block.chainid, address(usdc), payout);

        // The receipt event the indexer / CRE keys on — asserted exactly against the deployed router.
        vm.expectEmit(true, true, true, true, address(router));
        emit PaymentReceived(
            merchantId,
            buyer,
            address(usdc),
            gross,
            platformFee + merchantFee,
            net,
            USD_AMOUNT_8,
            ORDER,
            0
        );

        vm.prank(buyer);
        router.payToken(merchantId, address(usdc), USD_AMOUNT_8, ORDER);

        // Buyer debited exactly gross; the two fee legs landed at their sinks via the deployed router.
        assertEq(usdc.balanceOf(buyer), buyerBefore - gross, "buyer debited exactly gross");
        assertEq(usdc.balanceOf(treasury), treasuryBefore + platformFee, "platform fee -> treasury");
        assertEq(
            usdc.balanceOf(feeRecipient),
            feeRecipientBefore + merchantFee,
            "merchant surcharge -> feeRecipient"
        );

        // The NET was routed into the SCRIPT-WIRED PaymentLanes as a non-custodial lane receipt.
        assertEq(
            usdc.balanceOf(address(lanes)), lanesBefore + net, "net held by the wired PaymentLanes"
        );
        assertEq(lanes.balanceOf(payout, laneId), net, "merchant lane credited with net");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no token (zero custody)");

        // The merchant pulls its lane: the receipt burns and real USDC lands in the payout wallet.
        vm.prank(payout);
        lanes.claim(address(usdc));
        assertEq(usdc.balanceOf(payout), net, "merchant claimed net USDC out of the lane");
        assertEq(lanes.balanceOf(payout, laneId), 0, "lane receipt burned after claim");
        assertEq(usdc.balanceOf(address(lanes)), lanesBefore, "lanes drained back to baseline");
    }

    /// @notice Pay the SAME merchant TWICE through the deployed system: the lane receipt ACCUMULATES,
    ///         the platform cut accrues at the treasury across both, and the router never accrues
    ///         residual — proving the script-wired lane seam is additive and zero-custody under repeat
    ///         settlement, not just a single happy path.
    function test_integration_repeatPaymentsAccumulateLaneAndTreasury() public {
        uint256 merchantId = 1;
        uint256 gross = router.quote(merchantId, address(usdc), USD_AMOUNT_8);
        uint256 platformFee = gross * router.platformFeeBps() / 10_000;
        uint256 merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        uint256 net = gross - platformFee - merchantFee;
        uint256 laneId = lanes.laneId(block.chainid, address(usdc), payout);
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        for (uint256 i = 0; i < 3; ++i) {
            vm.prank(buyer);
            router.payToken(merchantId, address(usdc), USD_AMOUNT_8, ORDER);
        }

        assertEq(lanes.balanceOf(payout, laneId), net * 3, "lane receipt accumulates across 3 pays");
        assertEq(
            usdc.balanceOf(treasury), treasuryBefore + platformFee * 3, "treasury accrues each cut"
        );
        assertEq(usdc.balanceOf(address(router)), 0, "router stays zero-custody across repeats");

        // One claim drains the full accumulated net.
        vm.prank(payout);
        lanes.claim(address(usdc));
        assertEq(usdc.balanceOf(payout), net * 3, "single claim pulls the full accumulated net");
        assertEq(lanes.balanceOf(payout, laneId), 0, "lane fully burned");
    }

    /// @notice The native path also settles through the SCRIPT-WIRED native feed: a $250 order prices
    ///         via the $2000/ETH mock the script deployed, the split is exact, and (because the native
    ///         leg never touches PaymentLanes) net pushes straight to the EOA payout. Critically, on
    ///         this script-deployed system the platform treasury is the deploy SENDER address — which
    ///         carries code in the Foundry script EVM and rejects a bare native `.call`. The router
    ///         must NOT revert the settled payment over a payee that rejects native (money-safety invariant 5):
    ///         it queues that leg into `rescue` for the treasury to pull, while the receipt stands and
    ///         the clean-EOA legs (net, surcharge) settle directly. The router still holds no native
    ///         beyond exactly what is owed back through `rescue` (zero custody). This proves both pay
    ///         paths compose with the deployed configuration AND that a hostile/contract treasury can
    ///         never strand or roll back a native settlement.
    function test_integration_payNativeSettlesAndQueuesContractTreasury() public {
        uint256 merchantId = 1;
        uint256 gross = router.quote(merchantId, address(0), USD_AMOUNT_8);
        // $250 at $2000/ETH = 0.125 ETH.
        assertEq(gross, 0.125 ether, "script-wired native feed prices $250 at $2000/ETH");

        uint256 platformFee = gross * router.platformFeeBps() / 10_000;
        uint256 merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        uint256 net = gross - platformFee - merchantFee;

        // The script's treasury (the deploy sender) carries code in this EVM and rejects native — the
        // exact condition the rescue queue exists to absorb.
        assertGt(treasury.code.length, 0, "treasury is a contract that rejects native here");

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        router.payNative{ value: gross }(merchantId, USD_AMOUNT_8, ORDER); // receipt still stands

        // Clean-EOA legs push directly; native net bypasses lanes (lanes is a token-only seam).
        assertEq(payout.balance, net, "native net -> payout EOA directly (no lane)");
        assertEq(feeRecipient.balance, merchantFee, "surcharge -> feeRecipient EOA directly");
        // The platform cut to the rejecting treasury was QUEUED, never lost and never reverting.
        assertEq(treasury.balance, 0, "rejecting treasury received no direct native");
        assertEq(router.rescue(treasury), platformFee, "platform cut queued to rescue, not lost");
        // Zero custody: the router holds exactly the one owed-back rescue credit, nothing more.
        assertEq(address(router).balance, platformFee, "router holds only the owed rescue");
        assertEq(net + platformFee + merchantFee, gross, "conservation across the native path");
    }
}
