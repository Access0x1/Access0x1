// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { DeployAll } from "../../script/DeployAll.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Invoices } from "../../src/Access0x1Invoices.sol";
import { IAccess0x1Invoices } from "../../src/interfaces/IAccess0x1Invoices.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

/// @title  Access0x1InvoicesIntegration
/// @author Access0x1
/// @notice The Cyfrin INTEGRATION layer for {Access0x1Invoices}: instead of `new`-ing the contracts in
///         the test, `setUp` runs the REAL multi-chain deploy script (`DeployAll` + `HelperConfig`) on
///         the local chain — so the DEPLOY ITSELF is under test — and then exercises the invoice
///         primitive through its production composition with the freshly deployed {Access0x1Router} and
///         {PaymentLanes}. A green run proves four things at once: (1) the script wires the invoice
///         contract to the real router, (2) a token invoice settles end-to-end through that router's
///         fee-split with the net leg landing in the ERC-6909 lane ledger and claimable to real token,
///         (3) a native invoice settles + refunds excess through the same deployed router, and (4) the
///         terminal-state machine + payer-lock hold against the deployed estate — exactly the path a
///         live Arc/Base instance walks.
/// @dev    The deploy script reads its config at `HelperConfig` CONSTRUCTION from the OS process env,
///         and Foundry runs test functions in PARALLEL while `vm.setEnv` mutates the shared env with no
///         per-test rollback. So this suite sets every key it needs ONCE, in `setUp`, before the single
///         `DeployAll().run()`, and reads the deployed addresses straight off the script's public state.
///
///         `ROUTER_OWNER` is pinned to Foundry's broadcast default sender (the address a no-arg
///         `vm.startBroadcast()` pranks as) so the in-broadcast owner-only configure calls
///         (`setTokenAllowed`, `setPriceFeed`, the lanes wiring) execute — reproducing a real
///         `forge script --sender $DEPLOYER` run where `owner` defaults to the signer. The local
///         `HelperConfig` branch deploys fresh mocks (MockUSDC 6-dec, MockV3Aggregator feeds), so no
///         RPC, no real addresses, and no hand-rolled wiring are needed — the script is the source of
///         truth, and a wiring regression in it fails THIS suite.
contract Access0x1InvoicesIntegration is Test {
    /// @dev Foundry's broadcast default sender — the address `vm.startBroadcast()` (no arg) pranks as.
    ///      Mirrored from `test/unit/DeployAll.t.sol` so the in-broadcast configure calls are authorized.
    address internal constant BROADCASTER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    /// @dev The local Anvil chain id — `HelperConfig` deploys fresh mocks on this branch.
    uint256 internal constant LOCAL_CHAIN_ID = 31_337;

    // The estate, read off the deploy script's public state after `run()`.
    Access0x1Router internal router;
    PaymentLanes internal lanes;
    Access0x1Invoices internal invoices;
    MockUSDC internal usdc;
    address internal treasury; // the platform fee sink the deployed router settled with

    // Actors layered ON TOP of the deployed estate (the script does not register merchants).
    address internal merchantOwner = makeAddr("int_merchantOwner");
    address internal payout = makeAddr("int_payout");
    address internal feeRecipient = makeAddr("int_feeRecipient");
    address internal payer = makeAddr("int_payer");

    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5% surcharge
    uint256 internal merchantId;
    uint16 internal platformFeeBps; // read back from the deployed router

    /// @notice Stand up the WHOLE estate via the real deploy script, then register a merchant on the
    ///         deployed router so the invoice tests can issue + settle real requests.
    function setUp() public {
        // A fixed, fresh timestamp so the deployed mock feeds stay inside the router's staleness window.
        vm.warp(1_700_000_000);

        // Drive the script's config: local chain (fresh mocks), owner = broadcaster (so the in-broadcast
        // owner-only wiring runs), and DEPLOY the optional PaymentLanes ledger so the full composition
        // (router net -> lane receipt -> claim) is exercised, not just the direct-push path.
        vm.chainId(LOCAL_CHAIN_ID);
        vm.setEnv("ROUTER_OWNER", vm.toString(BROADCASTER));
        vm.setEnv("DEPLOY_PAYMENT_LANES", "true");

        // ── THE REAL DEPLOY ─────────────────────────────────────────────────────────────────────────
        // This is the artifact under test: the same `run()` a `forge script` invocation calls. It
        // deploys the router, session grant, lanes, house factory, the commerce quartet (incl. our
        // invoices), and wires the local mocks + lanes in one broadcast.
        DeployAll deployer = new DeployAll();
        (Access0x1Router deployedRouter, PaymentLanes deployedLanes, HelperConfig hc) =
            deployer.run();

        router = deployedRouter;
        lanes = deployedLanes;
        invoices = deployer.invoices(); // read the wired invoice contract off the script's state
        platformFeeBps = router.platformFeeBps();
        treasury = router.platformTreasury(); // read back, never guess the local mock treasury

        // The local HelperConfig deployed a fresh MockUSDC and wired it as an allowlisted, fed token.
        HelperConfig.NetworkConfig memory cfg = hc.getConfig();
        usdc = MockUSDC(cfg.usdc);

        // Register a merchant on the DEPLOYED router (permissionless; the caller becomes the owner).
        vm.prank(merchantOwner);
        merchantId =
            router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, keccak256("acme"));
    }

    /// @dev The two-leg split for this merchant against the deployed router's platform fee.
    function _split(uint256 gross)
        internal
        view
        returns (uint256 platformFee, uint256 merchantFee, uint256 net)
    {
        platformFee = gross * platformFeeBps / 10_000;
        merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        net = gross - platformFee - merchantFee;
    }

    /*//////////////////////////////////////////////////////////////
                       THE DEPLOY IS WIRED (CYFRIN)
    //////////////////////////////////////////////////////////////*/

    /// @notice The script produced a real, correctly-wired estate: the invoice contract composes the
    ///         SAME router the script deployed and configured, the lanes ledger is authorized + wired
    ///         into that router, and USDC is an allowlisted, fed pay-in token. This is the precondition
    ///         every downstream integration test relies on — asserted explicitly so a wiring regression
    ///         in the deploy script fails HERE, not mysteriously inside a pay.
    function test_integration_deployScriptWiresInvoicesToRouterAndLanes() public view {
        assertTrue(address(invoices) != address(0), "DeployAll deployed an invoice contract");
        assertEq(
            address(invoices.router()), address(router), "invoices compose the deployed router"
        );
        assertEq(invoices.nextInvoiceId(), 1, "fresh invoice ledger starts at id 1");

        // Lanes were deployed, authorized as a router-credit source, and wired into the router.
        assertTrue(address(lanes) != address(0), "PaymentLanes deployed");
        assertTrue(lanes.isRouter(address(router)), "router authorized to credit lanes");
        assertEq(router.paymentLanes(), address(lanes), "router wired to mint lane receipts");

        // USDC is a live, fed pay-in token on the deployed router (the script's configure step ran).
        assertTrue(router.tokenAllowed(address(usdc)), "USDC allowlisted by the deploy script");
        assertTrue(router.priceFeedOf(address(usdc)) != address(0), "USDC has a price feed wired");
    }

    /*//////////////////////////////////////////////////////////////
              TOKEN PAY → ROUTER SPLIT → LANE RECEIPT → CLAIM
    //////////////////////////////////////////////////////////////*/

    /// @notice The full token settlement through the DEPLOYED estate: a merchant issues a $250 USDC
    ///         invoice; the payer settles it; the deployed router splits net + fee; the net is minted as
    ///         an ERC-6909 lane receipt for the merchant (not direct-pushed, because lanes are wired);
    ///         and the merchant CLAIMS it to real USDC. Conservation and zero-custody hold at every hop.
    function test_integration_tokenInvoice_settlesThroughRouterIntoLaneAndClaims() public {
        uint256 usd8 = 250e8;
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(
            merchantId, address(0), address(usdc), usd8, 0, keccak256("inv")
        );

        uint256 gross = router.quote(merchantId, address(usdc), usd8);
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _split(gross);
        uint256 laneId = lanes.laneId(block.chainid, address(usdc), payout);

        // Settle through the invoice -> router -> lanes path.
        usdc.mint(payer, gross);
        vm.startPrank(payer);
        usdc.approve(address(invoices), gross);
        vm.expectEmit(true, true, true, true, address(invoices));
        emit IAccess0x1Invoices.InvoicePaid(id, payer, address(usdc), gross, keccak256("inv"));
        invoices.pay(id, keccak256("inv"));
        vm.stopPrank();

        // Fee legs were pushed straight out to their sinks.
        assertEq(
            usdc.balanceOf(treasury), platformFee, "platform fee -> treasury (deployed router)"
        );
        assertEq(usdc.balanceOf(feeRecipient), merchantFee, "merchant surcharge -> feeRecipient");

        // The NET is held as a backed ERC-6909 lane receipt for the merchant payout (lanes are wired),
        // and the lanes ledger holds exactly that net in real token to back the receipt.
        assertEq(lanes.balanceOf(payout, laneId), net, "net credited as a lane receipt");
        assertEq(usdc.balanceOf(address(lanes)), net, "lanes hold the net that backs the receipt");

        // Conservation across the whole hop, and zero custody in the invoice + router.
        assertEq(platformFee + merchantFee + net, gross, "net + fee == gross");
        assertEq(usdc.balanceOf(address(invoices)), 0, "invoice zero custody");
        assertEq(usdc.balanceOf(address(router)), 0, "router zero custody");
        assertEq(
            uint8(invoices.invoiceOf(id).status),
            uint8(IAccess0x1Invoices.InvStatus.PAID),
            "invoice terminal PAID"
        );

        // The merchant claims its lane receipt: it burns and real USDC lands in the payout wallet.
        vm.prank(payout);
        lanes.claim(address(usdc));
        assertEq(usdc.balanceOf(payout), net, "merchant claimed net USDC");
        assertEq(lanes.balanceOf(payout, laneId), 0, "lane receipt burned after claim");
        assertEq(usdc.balanceOf(address(lanes)), 0, "lanes drained to zero after claim");
    }

    /*//////////////////////////////////////////////////////////////
                  NATIVE PAY → ROUTER SPLIT → EXCESS REFUND
    //////////////////////////////////////////////////////////////*/

    /// @notice The full native settlement through the DEPLOYED estate: a native-denominated invoice
    ///         settles through the deployed router's split (native legs are direct-pushed, not laned)
    ///         and the buyer's excess `msg.value` is refunded to the wei. Proves the native pay path
    ///         composes the deployed router end-to-end.
    function test_integration_nativeInvoice_settlesAndRefundsExcessThroughDeployedRouter() public {
        uint256 usd8 = 100e8; // $100 at $2000/ETH = 0.05 ETH gross
        vm.prank(merchantOwner);
        uint256 id =
            invoices.createInvoice(merchantId, payer, address(0), usd8, 0, keccak256("nat"));

        uint256 gross = router.quote(merchantId, address(0), usd8);
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _split(gross);

        uint256 excess = 0.2 ether;
        vm.deal(payer, gross + excess);
        vm.prank(payer);
        invoices.payNative{ value: gross + excess }(id, keccak256("nat"));

        // The deployed router delivered each native leg to its sink. A leg is "delivered" when it lands
        // as balance OR (if the sink rejected the push) is queued to the router's `rescue` pull-map —
        // both are guaranteed delivery by construction (the receipt stands either way). The platform
        // treasury on the local mock branch is the broadcaster, which may not accept a raw ETH push, so
        // its leg can legitimately sit in `rescue`; the merchant EOAs accept ETH directly. This is the
        // same native-conservation phrasing the handler-driven invariant suite uses.
        assertEq(payout.balance + router.rescue(payout), net, "net -> payout (deployed router)");
        assertEq(
            treasury.balance + router.rescue(treasury), platformFee, "platform fee -> treasury"
        );
        assertEq(
            feeRecipient.balance + router.rescue(feeRecipient),
            merchantFee,
            "merchant surcharge -> feeRecipient"
        );
        assertEq(net + platformFee + merchantFee, gross, "net + fee == gross");

        // The buyer kept exactly the excess; the invoice holds zero native (it forwards exactly gross
        // and refunds the rest in-tx). The router holds ONLY what it queued to `rescue` for a sink that
        // rejected its push (the broadcaster-treasury here) — i.e. it never retains an UNaccounted wei.
        assertEq(payer.balance, excess, "buyer refunded exactly the excess");
        assertEq(address(invoices).balance, 0, "invoice zero native custody");
        assertEq(
            address(router).balance,
            router.rescue(payout) + router.rescue(treasury) + router.rescue(feeRecipient),
            "router holds only queued-rescue native, nothing unaccounted"
        );
        assertEq(
            uint8(invoices.invoiceOf(id).status),
            uint8(IAccess0x1Invoices.InvStatus.PAID),
            "invoice terminal PAID"
        );
    }

    /*//////////////////////////////////////////////////////////////
            LIFECYCLE + AUTH AGAINST THE DEPLOYED MERCHANT REGISTRY
    //////////////////////////////////////////////////////////////*/

    /// @notice The merchant-owner authorization is read LIVE from the deployed router's registry: the
    ///         owner that registered the merchant can issue + void; a stranger cannot. Proves the invoice
    ///         contract's single source of truth for tenant auth is the real deployed registry, with no
    ///         copy of its own. A voided invoice is then permanently unpayable through the deployed path.
    function test_integration_lifecycleAuthBoundToDeployedRegistry() public {
        // The registered owner can create against the deployed router's merchant.
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(
            merchantId, address(0), address(usdc), 20e8, 0, keccak256("life")
        );
        assertTrue(invoices.isPayable(id), "owner-created invoice is OPEN");

        // A stranger cannot void it (auth flows from the deployed registry, not a local copy).
        address stranger = makeAddr("int_stranger");
        vm.prank(stranger);
        // First field is the MERCHANT id (matching {createInvoice}'s convention), not the invoice id.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotMerchantOwner.selector,
                merchantId,
                stranger
            )
        );
        invoices.void(id);

        // The owner voids it; it becomes permanently unpayable through the deployed router path.
        vm.prank(merchantOwner);
        invoices.void(id);
        assertFalse(invoices.isPayable(id), "voided invoice is unpayable");

        uint256 gross = router.quote(merchantId, address(usdc), 20e8);
        usdc.mint(payer, gross);
        vm.startPrank(payer);
        usdc.approve(address(invoices), gross);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotOpen.selector,
                id,
                IAccess0x1Invoices.InvStatus.VOID
            )
        );
        invoices.pay(id, keccak256("life"));
        vm.stopPrank();
    }

    /// @notice Single-settlement holds end-to-end against the DEPLOYED estate: once an invoice settles
    ///         through the deployed router + lanes, a replay reverts at the terminal-state guard and the
    ///         merchant's lane receipt is credited exactly once. This is the on-chain UNIQUE-index proven
    ///         over the production composition, not the in-test `new`-ed one.
    function test_integration_replayCannotDoubleSettleDeployedPath() public {
        vm.prank(merchantOwner);
        uint256 id = invoices.createInvoice(
            merchantId, address(0), address(usdc), 75e8, 0, keccak256("once")
        );
        uint256 gross = router.quote(merchantId, address(usdc), 75e8);
        (,, uint256 net) = _split(gross);
        uint256 laneId = lanes.laneId(block.chainid, address(usdc), payout);

        usdc.mint(payer, gross * 2);
        vm.startPrank(payer);
        usdc.approve(address(invoices), gross * 2);
        invoices.pay(id, keccak256("once-a"));

        // Replay with a fresh nonce still reverts — the invoice is terminal PAID.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Invoices.Access0x1Invoices__NotOpen.selector,
                id,
                IAccess0x1Invoices.InvStatus.PAID
            )
        );
        invoices.pay(id, keccak256("once-b"));
        vm.stopPrank();

        // The merchant lane was credited exactly one net, and nothing extra was pulled from the payer.
        assertEq(lanes.balanceOf(payout, laneId), net, "lane credited exactly once");
        assertEq(usdc.balanceOf(payer), gross, "only one gross debited across the replay");
    }
}
