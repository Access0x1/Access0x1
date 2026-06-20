// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { DeployAll } from "../../script/DeployAll.s.sol";
import { CreateXEtch } from "../helpers/CreateXEtch.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

/// @title  PaymentLanesIntegration
/// @author Access0x1
/// @notice INTEGRATION suite for {PaymentLanes} the Cyfrin way — `setUp` stands up the system by running
///         the REAL {DeployAll} deploy script (which itself runs {HelperConfig}), so the production
///         deploy + wiring path is exercised and asserted, not re-implemented by hand. Unlike the manual
///         {EndToEndTest} (which `new`s and wires each contract directly in its setUp), this proves that
///         PaymentLanes composes correctly with the Router as the SCRIPT actually deploys and wires them:
///
///           - {DeployAll} on the local chain deploys the mock USDC + a $1 feed (via HelperConfig),
///             deploys the Router and {PaymentLanes}, authorizes the Router on the ledger
///             (`setRouter`), and wires the ledger into the Router (`setPaymentLanes`) — all in one
///             broadcast. We assert the wiring landed, then drive a real `payToken` through it.
///           - A real buyer pays a real merchant: the Router pulls the gross, splits the fee, and routes
///             the NET into PaymentLanes as a non-custodial lane receipt (the `_settleNet` lanes leg).
///             We assert the lane is credited + fully backed, the Router holds zero custody, and the
///             merchant can {claim} real USDC out of the lane.
///           - The transfer + claimLane receipt flow works end-to-end on a SCRIPT-deployed ledger (a
///             merchant assigns part of its receipt to a third party, who pulls the underlying).
///           - The cross-asset firewall holds on the script-deployed ledger (a foreign-asset claim is a
///             no-op against the real, deployed instance).
///
/// @dev    Runs on the local chain id (31337) so HelperConfig deploys fresh mocks and the in-broadcast
///         owner-only wiring (`setRouter`/`setPaymentLanes`) executes. Per the {DeployAllTest} pattern,
///         `ROUTER_OWNER` is pinned to Foundry's broadcast default sender so `owner` (which defaults to
///         `msg.sender` inside `run()`) can sign those `onlyOwner` calls under a unit-test broadcast, and
///         `DEPLOY_PAYMENT_LANES=true` switches on the optional ledger. The mock USDC the script deploys
///         is mintable, so the buyer is funded from it directly.
contract PaymentLanesIntegrationTest is Test {
    /// @dev The local Anvil chain id — HelperConfig's mock-deploying branch.
    uint256 internal constant LOCAL = 31_337;

    /// @dev Foundry's broadcast default sender (the address `vm.startBroadcast()` with no arg pranks as).
    ///      Mirrors {DeployAllTest}.BROADCASTER. Pinning ROUTER_OWNER to it makes the in-broadcast
    ///      owner-only wiring authorized under the unit-test broadcast.
    address internal constant BROADCASTER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    Access0x1Router internal router;
    PaymentLanes internal lanes;
    MockUSDC internal usdc; // the mock USDC the SCRIPT (HelperConfig) deployed + allowlisted

    address internal merchantOwner = makeAddr("pli_merchantOwner");
    address internal payout = makeAddr("pli_payout"); // the lane recipient (merchant net)
    address internal feeRecipient = makeAddr("pli_feeRecipient"); // merchant surcharge leg
    address internal buyer = makeAddr("pli_buyer");

    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.50% merchant surcharge
    uint256 internal constant USD_AMOUNT_8 = 250e8; // a $250.00 order, 8-decimal USD accounting unit
    bytes32 internal constant ORDER = keccak256("pli-order-1");
    bytes32 internal constant NAME_HASH = keccak256("acme.access0x1.eth");

    uint256 internal merchantId;
    uint16 internal platformFeeBps; // read back from the script-deployed router

    /// @notice Stand up the whole estate by RUNNING THE REAL DEPLOY SCRIPT, then register a merchant and
    ///         fund the buyer from the script-deployed mock USDC. Asserting the wiring here means every
    ///         test below runs against the production deploy path, not a hand-wired fixture.
    function setUp() public {
        CreateXEtch.enable(vm);
        // A non-zero, stable timestamp keeps the mock Chainlink feed inside its staleness window.
        vm.warp(1_700_000_000);

        // Drive the real deploy script on the local chain with the optional lanes ledger ON. The script
        // deploys HelperConfig (fresh mocks), the Router, PaymentLanes, authorizes + wires them, and
        // allowlists + feeds the mock USDC — exactly as a real `forge script` run would.
        vm.chainId(LOCAL);
        vm.setEnv("ROUTER_OWNER", vm.toString(BROADCASTER));
        vm.setEnv("DEPLOY_PAYMENT_LANES", "true");

        HelperConfig hc;
        (router, lanes, hc) = new DeployAll().run();
        usdc = MockUSDC(hc.getConfig().usdc);

        // ── Assert the SCRIPT produced a correctly wired money spine + lanes ledger. ───────────────
        assertTrue(address(router) != address(0), "script deployed a router");
        assertTrue(address(lanes) != address(0), "script deployed PaymentLanes (lanes ON)");
        assertEq(router.owner(), BROADCASTER, "router owner is the broadcaster (ROUTER_OWNER)");
        assertEq(lanes.owner(), BROADCASTER, "lanes owner is the broadcaster (ROUTER_OWNER)");
        assertTrue(lanes.isRouter(address(router)), "script authorized the router on the ledger");
        assertEq(router.paymentLanes(), address(lanes), "script wired the ledger into the router");
        assertTrue(router.tokenAllowed(address(usdc)), "script allowlisted the mock USDC");
        assertTrue(
            router.priceFeedOf(address(usdc)) != address(0), "script wired the USDC/USD feed"
        );

        platformFeeBps = router.platformFeeBps();

        // ── Register a merchant on the live router and fund the buyer from the deployed mock USDC. ──
        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);

        usdc.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        usdc.approve(address(router), type(uint256).max);
    }

    /// @dev Pay `USD_AMOUNT_8` for the merchant in USDC through the live router; returns the fee legs +
    ///      net so each assertion can be proven by exact value.
    function _payOnce()
        internal
        returns (uint256 gross, uint256 platformFee, uint256 merchantFee, uint256 net)
    {
        gross = router.quote(merchantId, address(usdc), USD_AMOUNT_8);
        platformFee = gross * platformFeeBps / 10_000;
        merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        net = gross - platformFee - merchantFee;

        vm.prank(buyer);
        router.payToken(merchantId, address(usdc), USD_AMOUNT_8, ORDER);
    }

    /*//////////////////////////////////////////////////////////////
          REAL pay -> lane credit -> claim, on a SCRIPT-deployed ledger
    //////////////////////////////////////////////////////////////*/

    /// @notice The headline composition: a real buyer pays a real merchant through the SCRIPT-deployed
    ///         router, the net routes into the SCRIPT-deployed PaymentLanes as a fully-backed lane
    ///         receipt, the router keeps zero custody, and the merchant claims real USDC out of the lane.
    ///         This is the production money path proven against the production deploy path.
    function test_integration_payCreditsLaneAndMerchantClaims() public {
        uint256 lanesBefore = usdc.balanceOf(address(lanes));
        (uint256 gross, uint256 platformFee, uint256 merchantFee, uint256 net) = _payOnce();

        // Conservation of the split: nothing created or destroyed.
        assertEq(net + platformFee + merchantFee, gross, "net + fee == gross");

        // The merchant's NET is now a lane receipt, fully backed by USDC held in PaymentLanes.
        uint256 laneId = lanes.laneId(block.chainid, address(usdc), payout);
        assertEq(lanes.balanceOf(payout, laneId), net, "merchant lane credited with net");
        assertEq(usdc.balanceOf(address(lanes)), lanesBefore + net, "lane fully backed by net USDC");

        // Zero custody: the router holds no token after settlement.
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no token (zero custody)");

        // The merchant pulls its net out of the lane: receipt burns, real USDC lands in the wallet.
        vm.prank(payout);
        lanes.claim(address(usdc));
        assertEq(usdc.balanceOf(payout), net, "merchant claimed exactly net USDC");
        assertEq(lanes.balanceOf(payout, laneId), 0, "lane receipt burned after claim");
        assertEq(usdc.balanceOf(address(lanes)), lanesBefore, "lanes drained back to baseline");
    }

    /// @notice Per-asset conservation holds across the full composition: at every checkpoint the USDC
    ///         held by the SCRIPT-deployed lanes equals the sum of unclaimed lane balances it backs.
    function test_integration_conservationAcrossPayAndClaim() public {
        (,,, uint256 net) = _payOnce();
        uint256 laneId = lanes.laneId(block.chainid, address(usdc), payout);

        // Post-pay: held USDC == the single unclaimed lane balance.
        assertEq(
            usdc.balanceOf(address(lanes)),
            lanes.balanceOf(payout, laneId),
            "held == sum of unclaimed lanes after pay"
        );

        // A second pay accumulates onto the same lane and the backing tracks it.
        vm.prank(buyer);
        router.payToken(merchantId, address(usdc), USD_AMOUNT_8, keccak256("pli-order-2"));
        assertEq(lanes.balanceOf(payout, laneId), net * 2, "second pay accumulates onto the lane");
        assertEq(
            usdc.balanceOf(address(lanes)),
            lanes.balanceOf(payout, laneId),
            "held == sum of unclaimed lanes after second pay"
        );

        // Claim drains it back to exactly zero — no residual custody in the deployed ledger.
        vm.prank(payout);
        lanes.claim(address(usdc));
        assertEq(usdc.balanceOf(address(lanes)), 0, "held returns to zero after claim");
        assertEq(usdc.balanceOf(payout), net * 2, "merchant received the accumulated net");
    }

    /*//////////////////////////////////////////////////////////////
          RECEIPT TRANSFER -> claimLane, end-to-end on the deployed ledger
    //////////////////////////////////////////////////////////////*/

    /// @notice The ERC-6909 receipt is transferable on the script-deployed ledger: a merchant assigns
    ///         part of its credited lane to a third party, who pulls the underlying USDC via {claimLane}.
    ///         Total claimed across both holders equals the credited net — value is conserved through the
    ///         transfer, and the deployed lanes drains back to baseline.
    function test_integration_receiptTransferThenClaimLane() public {
        uint256 lanesBefore = usdc.balanceOf(address(lanes));
        (,,, uint256 net) = _payOnce();
        uint256 laneId = lanes.laneId(block.chainid, address(usdc), payout);

        address assignee = makeAddr("pli_assignee");
        uint256 share = net / 3;

        // The merchant assigns a share of its receipt to the assignee (a real ERC-6909 transfer).
        vm.prank(payout);
        lanes.transfer(assignee, laneId, share);
        assertEq(lanes.balanceOf(assignee, laneId), share, "assignee holds the transferred share");
        assertEq(lanes.balanceOf(payout, laneId), net - share, "merchant keeps the remainder");

        // Both holders pull the underlying out of the SAME lane id with claimLane.
        vm.prank(assignee);
        lanes.claimLane(laneId, address(usdc));
        vm.prank(payout);
        lanes.claimLane(laneId, address(usdc));

        assertEq(usdc.balanceOf(assignee), share, "assignee pulled its exact share");
        assertEq(usdc.balanceOf(payout), net - share, "merchant pulled the remainder");
        assertEq(usdc.balanceOf(assignee) + usdc.balanceOf(payout), net, "total claimed == net");
        assertEq(usdc.balanceOf(address(lanes)), lanesBefore, "deployed lanes drained to baseline");
    }

    /*//////////////////////////////////////////////////////////////
          CROSS-ASSET FIREWALL on the SCRIPT-deployed instance
    //////////////////////////////////////////////////////////////*/

    /// @notice The cross-asset firewall holds against the REAL deployed ledger: a USDC-backed lane
    ///         pointed at a foreign asset is a safe no-op (no burn, no transfer), and the bound-asset
    ///         claim still pays full value. Proves the firewall is a property of the deployed bytecode,
    ///         not just an isolated unit fixture.
    function test_integration_crossAssetFirewallOnDeployedLedger() public {
        (,,, uint256 net) = _payOnce();
        uint256 laneId = lanes.laneId(block.chainid, address(usdc), payout);

        // A foreign asset the merchant does not hold a lane in (a fresh 6dp coin).
        MockUSDC foreign = new MockUSDC();

        // Point the USDC-backed lane at the foreign asset: must move nothing and keep the receipt.
        uint256 usdcHeld = usdc.balanceOf(address(lanes));
        vm.prank(payout);
        lanes.claimLane(laneId, address(foreign));
        assertEq(lanes.balanceOf(payout, laneId), net, "receipt survives the mismatched no-op");
        assertEq(usdc.balanceOf(address(lanes)), usdcHeld, "USDC pool untouched by the mismatch");
        assertEq(foreign.balanceOf(payout), 0, "no foreign asset paid out");

        // The bound-asset claim still pays the full net — the no-op was not a griefing burn.
        vm.prank(payout);
        lanes.claimLane(laneId, address(usdc));
        assertEq(usdc.balanceOf(payout), net, "full net redeemable on the bound asset");
        assertEq(lanes.balanceOf(payout, laneId), 0, "now burned");
    }
}
