// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Receiver } from "../../src/Access0x1Receiver.sol";
import { ChainRegistry } from "../../src/ChainRegistry.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";
import { HouseTokenFactory } from "../../src/HouseTokenFactory.sol";
import { HouseToken } from "../../src/HouseToken.sol";
import { SessionGrant } from "../../src/SessionGrant.sol";
import { NameMath } from "../../src/NameMath.sol";
import { IPaymentLanes } from "../../src/interfaces/IPaymentLanes.sol";
import { ISessionGrant } from "../../src/interfaces/ISessionGrant.sol";
import { IHouseTokenFactory } from "../../src/interfaces/IHouseTokenFactory.sol";

import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockForwarder } from "../mocks/MockForwarder.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @title  EndToEnd — the Access0x1 demo flow as ONE provable test
/// @author Access0x1
/// @notice Wires the WHOLE system together on a local fork-style setup (MockUSDC + MockV3Aggregator
///         + the real contracts) and runs the full money flow end to end — the proof that the
///         pieces COMPOSE, not just pass in isolation:
///
///           1. Deploy the stack: ChainRegistry, Access0x1Router, PaymentLanes,
///              Access0x1Receiver (behind a MockForwarder), HouseTokenFactory, SessionGrant.
///           2. Register a merchant with an ENS-style nameHash; show its on-chain brand color
///              via NameMath.colorOf, and record the chain's facts in ChainRegistry.
///           3. Wire PaymentLanes (authorize the router) and the USDC/USD Chainlink feed.
///           4. Run a full payToken: assert the Chainlink-priced quote, the exact two-leg fee
///              split (platform -> treasury, surcharge -> feeRecipient, net+fee==gross), the
///              merchant's PaymentLanes lane credited (and claimable to real USDC), and the
///              PaymentReceived receipt event.
///           5. Feed the PaymentReceived fields into Access0x1Receiver.onReport — DELIVERED VIA
///              THE FORWARDER MOCK — and assert the SettlementAudited audit entry mirrors the
///              settlement (the CRE "Notified Settlement" leg, off the money path by construction).
///           6. The agent path: open a SessionGrant session and spend within budget.
///           7. A business deploys its own HouseToken through the factory (zero-custody).
///
/// @dev    `using NameMath for bytes32` so the test can show `nameHash.colorOf()` exactly as the
///         brand layer / SDK does (NameMath is an inlined library of `internal` pure functions).
contract EndToEndTest is Test, ProxyDeployer {
    using NameMath for bytes32;

    /*//////////////////////////////////////////////////////////////
                                STACK
    //////////////////////////////////////////////////////////////*/

    ChainRegistry internal registry;
    Access0x1Router internal router;
    PaymentLanes internal lanes;
    Access0x1Receiver internal receiver;
    HouseTokenFactory internal factory;
    SessionGrant internal sessions;
    MockForwarder internal forwarder;

    MockUSDC internal usdc; // 6-decimal USDC (the Arc-trap non-18 token)
    MockV3Aggregator internal usdcFeed; // USDC/USD, 8 decimals

    /*//////////////////////////////////////////////////////////////
                                ACTORS
    //////////////////////////////////////////////////////////////*/

    address internal platformAdmin = makeAddr("platformAdmin");
    address internal treasury = makeAddr("treasury"); // platform fee leg lands here
    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout"); // merchant net (lane recipient)
    address internal feeRecipient = makeAddr("feeRecipient"); // merchant surcharge leg
    address internal buyer = makeAddr("buyer");
    address internal workflowOwner = makeAddr("workflowOwner"); // the CRE workflow owner

    /*//////////////////////////////////////////////////////////////
                              PARAMETERS
    //////////////////////////////////////////////////////////////*/

    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1.00% -> treasury
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.50% surcharge -> feeRecipient
    uint256 internal constant USD_AMOUNT_8 = 250e8; // a $250.00 order, 8-decimal USD
    bytes32 internal constant ORDER = keccak256("order-e2e-1");

    // namehash("acme.access0x1.eth") — the merchant's ENS-style identity commitment.
    bytes32 internal constant NAME_HASH = keccak256("acme.access0x1.eth");

    bytes10 internal constant WF_NAME = bytes10("notify-set"); // the CRE workflow name

    uint256 internal merchantId;

    // Re-declared so the test can `expectEmit` on them (events are not inherited into test scope).
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

    /// @notice Stand up and wire the entire deployment exactly as the deploy scripts do.
    function setUp() public {
        // A non-zero, stable timestamp keeps the Chainlink feed inside the staleness window.
        vm.warp(1_700_000_000);

        // ── 1. Deploy the stack ─────────────────────────────────────────────────────────────────
        registry = ChainRegistry(
            deployProxy(
                address(new ChainRegistry()),
                abi.encodeCall(ChainRegistry.initialize, (platformAdmin))
            )
        );
        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(
                    Access0x1Router.initialize, (platformAdmin, treasury, PLATFORM_FEE_BPS)
                )
            )
        );
        lanes = PaymentLanes(
            deployProxy(
                address(new PaymentLanes()),
                abi.encodeCall(PaymentLanes.initialize, (platformAdmin))
            )
        );
        forwarder = new MockForwarder();
        receiver = new Access0x1Receiver(address(forwarder), platformAdmin);
        factory = HouseTokenFactory(
            deployProxy(
                address(new HouseTokenFactory()),
                abi.encodeCall(HouseTokenFactory.initialize, (platformAdmin))
            )
        );
        sessions = SessionGrant(
            deployProxy(
                address(new SessionGrant()),
                abi.encodeCall(
                    SessionGrant.initialize, ("Access0x1 SessionGrant", "1", platformAdmin)
                )
            )
        );

        usdc = new MockUSDC();
        usdcFeed = new MockV3Aggregator(8, 1e8); // $1.00, 8-decimal feed

        // ── 2. Wire the system as a single control plane ────────────────────────────────────────
        vm.startPrank(platformAdmin);

        // Router: allowlist USDC, set its Chainlink feed, route net into PaymentLanes.
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        router.setPaymentLanes(address(lanes));

        // PaymentLanes: authorize the router as a crediting source.
        lanes.setRouter(address(router), true);

        // Receiver: allowlist the CRE workflow owner + name (the Forwarder is trusted at construction).
        receiver.setAllowedWorkflowOwner(workflowOwner, true);
        receiver.setAllowedWorkflowName(WF_NAME, true);

        // ChainRegistry: record this chain's facts (native USDC + the live router) — the SDK source.
        registry.addChain(
            block.chainid,
            ChainRegistry.ChainConfig({
                usdc: address(usdc),
                router: address(router),
                ccipSelector: 0, // same-chain demo: no live CCIP lane
                flags: 0x0002 | 0x0008 // FLAG_CIRCLE_USDC | FLAG_TESTNET
            })
        );
        registry.setChainLive(block.chainid, true);

        vm.stopPrank();

        // ── 3. Register the merchant (permissionless, the caller becomes the owner) ──────────────
        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);

        // Fund the buyer with USDC and approve the router to pull the gross.
        usdc.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        usdc.approve(address(router), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                       THE FULL MONEY FLOW (ONE TEST)
    //////////////////////////////////////////////////////////////*/

    /// @notice The demo flow, asserted as one composed transaction graph: quote -> pay -> split ->
    ///         lane credit -> receipt event -> CRE audit (via the Forwarder). Every leg is checked.
    function test_e2e_fullMoneyFlow_quote_split_lane_receipt_audit() public {
        // ── Identity: the merchant's NAME sets its on-chain brand color, for free (no storage). ──
        bytes3 brandColor = NAME_HASH.colorOf();
        assertEq(
            brandColor,
            bytes3(keccak256(abi.encode("color", NAME_HASH))),
            "brand color must equal NameMath.colorOf(nameHash)"
        );
        // The merchant record on-chain commits to exactly this name.
        (,,,,, bytes32 storedNameHash) = router.merchants(merchantId);
        assertEq(storedNameHash, NAME_HASH, "merchant nameHash must be the ENS commitment");

        // The chain registry resolves this chain to the live router + native USDC (SDK lookup).
        ChainRegistry.ChainConfig memory cfg = registry.getChain(block.chainid);
        assertEq(cfg.router, address(router), "registry must resolve to the deployed router");
        assertEq(cfg.usdc, address(usdc), "registry must resolve native USDC");
        assertTrue(registry.isLive(block.chainid), "chain must be flagged live");

        // ── Pricing: the gross is the Chainlink-priced USD->token conversion, read IN-TX. ────────
        // At $1.00/USDC (1e8 feed) a $250 order is exactly 250 USDC = 250e6 (6 decimals).
        uint256 gross = router.quote(merchantId, address(usdc), USD_AMOUNT_8);
        assertEq(gross, 250e6, "quote must price $250 at $1/USDC to 250e6 USDC");

        // ── The exact two-leg fee split. ─────────────────────────────────────────────────────────
        uint256 platformFee = gross * PLATFORM_FEE_BPS / 10_000; // 1% -> treasury
        uint256 merchantFee = gross * MERCHANT_FEE_BPS / 10_000; // 0.5% -> feeRecipient
        uint256 net = gross - platformFee - merchantFee;
        // Conservation: nothing is created or destroyed in the split.
        assertEq(net + platformFee + merchantFee, gross, "net + fee must equal gross");

        // Snapshot balances before the pay so each leg can be proven by its delta.
        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        uint256 feeRecipientBefore = usdc.balanceOf(feeRecipient);
        uint256 lanesBefore = usdc.balanceOf(address(lanes));

        // The merchant's lane id (chainid, USDC, payout) — recomputable off-chain for free.
        uint256 laneId = lanes.laneId(block.chainid, address(usdc), payout);

        // ── The receipt event the indexer / CRE keys on — asserted exactly. ──────────────────────
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

        // ── Settle. ──────────────────────────────────────────────────────────────────────────────
        vm.prank(buyer);
        router.payToken(merchantId, address(usdc), USD_AMOUNT_8, ORDER);

        // Buyer paid exactly the gross.
        assertEq(usdc.balanceOf(buyer), buyerBefore - gross, "buyer debited exactly gross");

        // Platform fee leg landed at the treasury; merchant surcharge leg landed at feeRecipient.
        assertEq(usdc.balanceOf(treasury), treasuryBefore + platformFee, "platform fee -> treasury");
        assertEq(
            usdc.balanceOf(feeRecipient),
            feeRecipientBefore + merchantFee,
            "merchant surcharge -> feeRecipient"
        );

        // The NET routed into PaymentLanes as a non-custodial lane receipt for the merchant payout.
        assertEq(
            usdc.balanceOf(address(lanes)), lanesBefore + net, "net held by PaymentLanes (backed)"
        );
        assertEq(lanes.balanceOf(payout, laneId), net, "merchant lane credited with net");

        // Router holds zero USDC after settlement — zero custody.
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no token (zero custody)");

        // The merchant pulls its lane: the receipt burns and real USDC lands in the payout wallet.
        vm.prank(payout);
        lanes.claim(address(usdc));
        assertEq(usdc.balanceOf(payout), net, "merchant claimed net USDC");
        assertEq(lanes.balanceOf(payout, laneId), 0, "lane receipt burned after claim");
        assertEq(usdc.balanceOf(address(lanes)), lanesBefore, "lanes drained back to baseline");

        // ── The CRE "Notified Settlement" leg: feed the receipt fields into onReport via the ─────
        // ── Forwarder mock and assert the audit entry mirrors the settlement. ────────────────────
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
            0, // first audit entry
            merchantId,
            ORDER,
            address(usdc),
            gross,
            USD_AMOUNT_8,
            0,
            notifiedAt
        );
        // Delivered by the trusted Forwarder (NOT a raw prank) — the prod delivery path.
        forwarder.deliver(address(receiver), metadata, report);
        assertEq(receiver.auditCount(), 1, "exactly one settlement audited");
    }

    /// @notice The audit consumer is OFF the money path by construction: a revert inside onReport
    ///         (here, an unauthorized caller) can never touch a settlement that already happened.
    function test_e2e_audit_isOffMoneyPath() public {
        // Settle first.
        vm.prank(buyer);
        router.payToken(merchantId, address(usdc), USD_AMOUNT_8, ORDER);
        uint256 laneId = lanes.laneId(block.chainid, address(usdc), payout);
        uint256 creditedNet = lanes.balanceOf(payout, laneId);
        assertGt(creditedNet, 0, "settlement credited the lane");

        // A stranger calling onReport directly (bypassing the Forwarder) reverts — and the
        // settlement above is wholly unaffected.
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

        // Lane balance still intact: the audit failure did not roll back the money path.
        assertEq(lanes.balanceOf(payout, laneId), creditedNet, "settlement survives audit revert");
    }

    /*//////////////////////////////////////////////////////////////
                          THE AGENT PATH (SESSION)
    //////////////////////////////////////////////////////////////*/

    /// @notice An owner authorizes an agent (delegate) to spend up to a budget until an expiry, then
    ///         the agent spends within budget — the ERC-7702 "sign once, delegated session" path.
    function test_e2e_agentSession_openAndSpendWithinBudget() public {
        address agent = makeAddr("agent");
        uint256 budgetCap = 1_000e8; // $1,000 of authorization (USD-8dp accounting unit)
        uint64 expiry = uint64(block.timestamp + 1 days);

        // Owner opens the session directly (the 7702-EOA entrypoint).
        vm.prank(merchantOwner);
        bytes32 sessionId = sessions.openSession(agent, budgetCap, expiry);
        assertEq(
            sessionId,
            sessions.computeSessionId(merchantOwner, agent, 0),
            "session id is keccak(owner, delegate, nonce)"
        );
        assertEq(sessions.remaining(sessionId), budgetCap, "full budget available at open");

        // The agent spends twice, within budget; each spend decrements the remaining authorization.
        vm.prank(agent);
        uint256 afterFirst = sessions.spend(sessionId, 300e8);
        assertEq(afterFirst, budgetCap - 300e8, "remaining after first spend");

        vm.expectEmit(true, true, false, true, address(sessions));
        emit ISessionGrant.SessionSpent(sessionId, agent, 200e8, budgetCap - 500e8);
        vm.prank(agent);
        uint256 afterSecond = sessions.spend(sessionId, 200e8);
        assertEq(afterSecond, budgetCap - 500e8, "remaining after second spend");
        assertEq(sessions.remaining(sessionId), budgetCap - 500e8, "view matches accounting");

        // A spend beyond the remaining budget is rejected — the budget is a hard ceiling.
        uint256 left = budgetCap - 500e8;
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISessionGrant.SessionGrant__BudgetExceeded.selector, sessionId, left, left + 1
            )
        );
        sessions.spend(sessionId, left + 1);
    }

    /*//////////////////////////////////////////////////////////////
                         THE HOUSE TOKEN DEPLOY
    //////////////////////////////////////////////////////////////*/

    /// @notice A business deploys its OWN ERC-20 through the factory and owns it outright — the
    ///         factory keeps no key, no role, no balance (zero custody by construction).
    function test_e2e_houseTokenDeploy_zeroCustody() public {
        uint256 supply = 1_000_000e18;

        vm.expectEmit(false, false, false, false, address(factory));
        emit IHouseTokenFactory.Deployed(
            merchantOwner, address(0), address(this), "Acme Points", "ACME", supply
        );
        vm.prank(merchantOwner);
        address token = factory.deployHouseToken(merchantOwner, "Acme Points", "ACME", 18, supply);

        // Provenance recorded; the factory holds NO supply and NO authority.
        assertTrue(factory.isHouseToken(token), "factory records provenance");
        assertEq(factory.deployedCount(), 1, "deployed count incremented");
        assertEq(
            IERC20(token).balanceOf(merchantOwner), supply, "full supply minted to the business"
        );
        assertEq(IERC20(token).balanceOf(address(factory)), 0, "factory holds no balance");
        assertEq(HouseToken(token).owner(), merchantOwner, "business owns its token");

        // The house token can flow through the same router seam: allowlist + feed it, then it is a
        // first-class pay-in currency (closed-loop payments). Prove the wiring composes.
        MockV3Aggregator houseFeed = new MockV3Aggregator(8, 1e8);
        vm.startPrank(platformAdmin);
        router.setTokenAllowed(token, true);
        router.setPriceFeed(token, address(houseFeed));
        vm.stopPrank();
        // An 18-decimal house token at $1.00: a $250 order quotes to 250e18.
        assertEq(
            router.quote(merchantId, token, USD_AMOUNT_8),
            250e18,
            "house token prices through the same router"
        );
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Build the Keystone default-layout metadata buffer the Forwarder delivers in PROD:
    ///      32 bytes workflow_cid + 10 bytes workflow_name + 20 bytes workflow_owner + 2 bytes
    ///      report_name = 64 bytes. Mirrors test/unit/Access0x1Receiver.t.sol::_metadata.
    function _metadata(bytes10 name, address wfOwner) internal pure returns (bytes memory) {
        bytes32 cid = keccak256("workflow-cid");
        bytes2 reportName = bytes2("r1");
        return abi.encodePacked(cid, name, bytes20(wfOwner), reportName);
    }
}
