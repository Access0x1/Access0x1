// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";

import { DeployAll } from "../../script/DeployAll.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";

import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Receiver } from "../../src/Access0x1Receiver.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";

import { MockForwarder } from "../mocks/MockForwarder.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";

/// @title  Access0x1ReceiverIntegration — the CRE consumer wired through the REAL deploy script.
/// @author Access0x1
/// @notice Cyfrin INTEGRATION layer for {Access0x1Receiver}. Unlike the unit/fuzz/attack suites
///         (which `new` the receiver directly) and unlike `EndToEnd.t.sol` (which hand-wires the
///         estate), this suite stands up the receiver through the PRODUCTION `DeployAll.run()` +
///         `HelperConfig` path — so the DEPLOY SCRIPT's receiver branch is itself under test:
///
///           - the `cfg.creForwarder != address(0)` guard actually deploying the consumer,
///           - the consumer constructed with the configured KeystoneForwarder + the ROUTER_OWNER,
///           - the consumer recorded in `DeployAll.receiver()` (address(0) when no forwarder),
///           - and the consumer composing with the SAME router the script deployed: the router's
///             real `PaymentReceived` receipt feeds the receiver's `onReport` audit write, delivered
///             along the prod path (caller == the Forwarder), exactly as the CRE workflow does.
///
///         Off the money path by construction: the integration proves a revert in `onReport` leaves
///         a completed settlement untouched, end to end, on script-deployed contracts.
///
/// @dev    Local HelperConfig hardcodes `creForwarder = address(0)` (no DON on Anvil), so it SKIPS
///         the receiver — which is correct for local, but means we must drive the script on a chain
///         whose config carries a real forwarder. We use the GENERIC catch-all branch
///         (`_liveConfigFromEnv`, any unnamed chainId) and set its env: `PLATFORM_TREASURY`,
///         `USDC_ADDRESS`/`USDC_USD_FEED` (a MockUSDC + MockV3Aggregator we deploy), and
///         `CRE_FORWARDER` (a MockForwarder we deploy). `ROUTER_OWNER` is pinned to the broadcast
///         default sender so the in-broadcast `onlyOwner` configure calls (allowlist USDC, set feed)
///         are authorized — reproducing the real `--sender $DEPLOYER` run. This file OWNS those
///         generic env keys on its dedicated catch-all chainId, so it never races the DeployAll unit
///         suite (which owns the named-chain + LOCAL keys).
contract Access0x1ReceiverIntegrationTest is Test {
    /// @dev Foundry's broadcast default sender — `vm.startBroadcast()` (no arg) pranks as this. The
    ///      script's `owner` defaults to `msg.sender`, which inside an in-test broadcast is THIS
    ///      address, so pinning ROUTER_OWNER to it lets the configure calls sign as the router owner.
    address internal constant BROADCASTER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    /// @dev A dedicated, unnamed chainId so HelperConfig falls through to `_liveConfigFromEnv` and
    ///      this suite owns the generic env keys alone (no collision with the DeployAll unit suite).
    uint256 internal constant CRE_INT_CHAIN_ID = 909_909;

    bytes10 internal constant WF_NAME = bytes10("notify-set");
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.50% merchant surcharge
    uint256 internal constant USD_AMOUNT_8 = 250e8; // a $250.00 order, 8-decimal USD
    bytes32 internal constant ORDER = keccak256("order-cre-int-1");
    bytes32 internal constant NAME_HASH = keccak256("acme.access0x1.eth");

    // Script-deployed estate (read out of DeployAll's public state after run()).
    DeployAll internal deployer;
    Access0x1Router internal router;
    PaymentLanes internal lanes;
    Access0x1Receiver internal receiver;

    // Mocks we deploy and feed into the script via env (a real ERC-20 + feed + forwarder).
    MockUSDC internal usdc;
    MockV3Aggregator internal usdcFeed;
    MockForwarder internal forwarder;

    // Actors.
    address internal treasury = makeAddr("treasury");
    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal buyer = makeAddr("buyer");
    address internal workflowOwner = makeAddr("workflowOwner"); // the CRE workflow owner

    uint256 internal merchantId;

    // Re-declared for expectEmit (events are not inherited into the test scope).
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

    event SettlementAudited(
        uint256 indexed auditId,
        uint256 indexed merchantId,
        bytes32 indexed orderId,
        address token,
        uint256 grossAmount,
        uint256 usdAmount8,
        uint64 srcChainSelector,
        uint64 notifiedAt
    );

    /// @notice Stand up the estate by running the REAL `DeployAll` script, then complete the
    ///         tenant-side wiring (allowlist the CRE workflow, register a merchant, fund the buyer).
    function setUp() public {
        // A non-zero, stable timestamp keeps the Chainlink feed inside the staleness window.
        vm.warp(1_700_000_000);
        vm.chainId(CRE_INT_CHAIN_ID);

        // Deploy the mocks the script will WIRE (a real ERC-20 + its USD feed) and the forwarder the
        // script will TRUST. These exist before the broadcast so their addresses can go into env.
        usdc = new MockUSDC(); // 6-decimal USDC (the non-18 token)
        usdcFeed = new MockV3Aggregator(8, 1e8); // USDC/USD = $1.00, 8-decimal
        forwarder = new MockForwarder(); // stand-in KeystoneForwarder (the DON delivery point)

        // Feed the generic (catch-all) HelperConfig branch entirely from env. CRE_FORWARDER non-zero
        // is what makes DeployAll actually DEPLOY the receiver (the branch under test).
        vm.setEnv("ROUTER_OWNER", vm.toString(BROADCASTER)); // owner == broadcaster: configure calls authorized
        vm.setEnv("PLATFORM_TREASURY", vm.toString(treasury));
        vm.setEnv("PLATFORM_FEE_BPS", "100"); // 1.00% platform fee -> treasury
        vm.setEnv("USDC_ADDRESS", vm.toString(address(usdc)));
        vm.setEnv("USDC_USD_FEED", vm.toString(address(usdcFeed)));
        vm.setEnv("DEPLOY_PAYMENT_LANES", "true"); // wire the ERC-6909 lane ledger too
        vm.setEnv("CRE_FORWARDER", vm.toString(address(forwarder))); // <-- deploys Access0x1Receiver

        deployer = new DeployAll();
        (router, lanes,) = deployer.run();
        receiver = deployer.receiver(); // recorded in the script's public state

        // The deploy script wired the receiver to TRUST our forwarder; now the tenant (router owner)
        // allowlists the CRE workflow owner + name. These are owner-only, so prank the script owner.
        vm.startPrank(BROADCASTER);
        receiver.setAllowedWorkflowOwner(workflowOwner, true);
        receiver.setAllowedWorkflowName(WF_NAME, true);
        vm.stopPrank();

        // Register a merchant (permissionless; the caller becomes the owner) and fund the buyer.
        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);

        usdc.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        usdc.approve(address(router), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
            THE SCRIPT'S RECEIVER BRANCH IS UNDER TEST
    //////////////////////////////////////////////////////////////*/

    /// @notice The deploy script DEPLOYED the receiver (because a forwarder was configured), wired it
    ///         to trust exactly that forwarder, and gave it the ROUTER_OWNER as its admin — the
    ///         receiver branch of `DeployAll` proven end to end, not hand-rolled in the test.
    function test_integration_deployScript_deploysAndWiresReceiver() public view {
        assertTrue(address(receiver) != address(0), "script deployed the CRE consumer");
        assertEq(
            receiver.i_forwarder(), address(forwarder), "consumer trusts the configured forwarder"
        );
        assertEq(receiver.owner(), BROADCASTER, "consumer admin == ROUTER_OWNER");
        assertEq(receiver.auditCount(), 0, "fresh consumer starts with an empty audit log");
        // It composes with the SAME router the script deployed (same broadcast).
        assertTrue(address(router) != address(0), "script deployed the router spine");
        assertTrue(router.tokenAllowed(address(usdc)), "script allowlisted the wired USDC");
    }

    /// @notice When NO forwarder is configured, the script SKIPS the receiver (the off-money-path
    ///         consumer is optional and a zero forwarder means the CRE value is not booth-confirmed).
    ///         This pins the other side of the branch: `receiver == address(0)`, money spine still up.
    function test_integration_deployScript_skipsReceiverWithoutForwarder() public {
        vm.setEnv("CRE_FORWARDER", vm.toString(address(0))); // no forwarder -> skip the consumer
        DeployAll d = new DeployAll();
        (Access0x1Router r,,) = d.run();
        assertTrue(address(r) != address(0), "router still deploys without the CRE consumer");
        assertEq(address(d.receiver()), address(0), "no forwarder -> receiver skipped (address(0))");
    }

    /*//////////////////////////////////////////////////////////////
            FULL COMPOSITION: SETTLE -> RECEIPT -> CRE AUDIT
    //////////////////////////////////////////////////////////////*/

    /// @notice End-to-end on SCRIPT-DEPLOYED contracts: a real `payToken` settlement emits the
    ///         router's `PaymentReceived`; those exact receipt fields feed the receiver's `onReport`
    ///         (delivered by the trusted Forwarder, the prod path), and the resulting
    ///         `SettlementAudited` entry mirrors the settlement. Proves the receiver composes with
    ///         the deployed router, not just in isolation.
    function test_integration_settlementFlows_intoCreAudit() public {
        // Price the order through the deployed router's in-tx Chainlink quote: $250 at $1/USDC = 250e6.
        uint256 gross = router.quote(merchantId, address(usdc), USD_AMOUNT_8);
        assertEq(gross, 250e6, "quote prices $250 at $1/USDC to 250e6 (6-dec USDC)");

        uint256 platformFee = gross * 100 / 10_000; // 1.00% -> treasury
        uint256 merchantFee = gross * MERCHANT_FEE_BPS / 10_000; // 0.50% -> feeRecipient
        uint256 net = gross - platformFee - merchantFee;
        assertEq(net + platformFee + merchantFee, gross, "net + fee == gross (conservation)");

        // The router emits the receipt the CRE workflow keys on — assert it exactly.
        vm.expectEmit(true, true, true, true, address(router));
        emit PaymentReceived(
            merchantId,
            buyer,
            address(usdc),
            gross,
            platformFee + merchantFee, // the event records the COMBINED fee
            net,
            USD_AMOUNT_8,
            ORDER,
            0 // same-chain settlement
        );
        vm.prank(buyer);
        router.payToken(merchantId, address(usdc), USD_AMOUNT_8, ORDER);

        // Zero custody on the deployed router; the net landed in the deployed lanes ledger.
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no token after settlement");
        uint256 laneId = lanes.laneId(block.chainid, address(usdc), payout);
        assertEq(lanes.balanceOf(payout, laneId), net, "merchant lane credited with net");

        // ── The CRE leg: feed the receipt fields into the SCRIPT-DEPLOYED receiver via the trusted
        // ── Forwarder. The audit entry must mirror the settlement field-for-field.
        uint64 notifiedAt = uint64(block.timestamp);
        bytes memory metadata = _metadata(WF_NAME, workflowOwner);
        bytes memory report = abi.encode(
            Access0x1Receiver.AuditEntry({
                merchantId: merchantId,
                token: address(usdc),
                grossAmount: gross,
                usdAmount8: USD_AMOUNT_8,
                orderId: ORDER,
                srcChainSelector: 0,
                notifiedAt: notifiedAt
            })
        );

        vm.expectEmit(true, true, true, true, address(receiver));
        emit SettlementAudited(
            0, merchantId, ORDER, address(usdc), gross, USD_AMOUNT_8, 0, notifiedAt
        );
        forwarder.deliver(address(receiver), metadata, report); // prod delivery path (caller == forwarder)
        assertEq(
            receiver.auditCount(), 1, "exactly one settlement audited on the deployed consumer"
        );
    }

    /// @notice OFF THE MONEY PATH, proven on deployed contracts: a settlement completes and credits
    ///         the lane; a subsequent `onReport` that REVERTS (unauthorized caller bypassing the
    ///         Forwarder) cannot roll back or alter that settled lane balance. The audit consumer is
    ///         purely additive — its failure mode is isolated from money.
    function test_integration_auditRevert_doesNotTouchSettlement() public {
        // Settle on the deployed router.
        vm.prank(buyer);
        router.payToken(merchantId, address(usdc), USD_AMOUNT_8, ORDER);
        uint256 laneId = lanes.laneId(block.chainid, address(usdc), payout);
        uint256 creditedNet = lanes.balanceOf(payout, laneId);
        assertGt(creditedNet, 0, "settlement credited the merchant lane");

        // A direct (non-Forwarder) onReport reverts at the gate; the settlement is unaffected.
        bytes memory report = abi.encode(
            Access0x1Receiver.AuditEntry({
                merchantId: merchantId,
                token: address(usdc),
                grossAmount: 250e6,
                usdAmount8: USD_AMOUNT_8,
                orderId: ORDER,
                srcChainSelector: 0,
                notifiedAt: uint64(block.timestamp)
            })
        );
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Receiver.UnauthorizedForwarder.selector, address(this))
        );
        receiver.onReport(_metadata(WF_NAME, workflowOwner), report);

        assertEq(
            lanes.balanceOf(payout, laneId), creditedNet, "settled lane survives the audit revert"
        );
        assertEq(receiver.auditCount(), 0, "no audit entry written by the rejected call");
    }

    /*//////////////////////////////////////////////////////////////
                              HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Keystone default-layout metadata: 32 cid + 10 name + 20 owner + 2 report = 64 bytes.
    function _metadata(bytes10 name, address wfOwner) internal pure returns (bytes memory) {
        bytes32 cid = keccak256("workflow-cid");
        bytes2 reportName = bytes2("r1");
        return abi.encodePacked(cid, name, bytes20(wfOwner), reportName);
    }
}
