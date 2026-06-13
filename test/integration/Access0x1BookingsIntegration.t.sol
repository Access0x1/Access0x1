// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { DeployAll } from "../../script/DeployAll.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Bookings } from "../../src/Access0x1Bookings.sol";
import { IAccess0x1Bookings } from "../../src/interfaces/IAccess0x1Bookings.sol";
import { SessionGrant } from "../../src/SessionGrant.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";

/// @title  Access0x1BookingsIntegration
/// @author Access0x1
/// @notice INTEGRATION suite for {Access0x1Bookings} — the Cyfrin "deploy through the REAL script, so
///         the deploy is tested too, then exercise the contract end-to-end through its real
///         composition" layer. Unlike the unit/fuzz/invariant suites (which `new` the contract in
///         isolation), this `setUp` runs the production {DeployAll} script on a local Anvil chain:
///         HelperConfig deploys the mock USDC + feed, DeployAll deploys + wires the Router, the
///         SessionGrant, and the Bookings contract over them, and allowlists USDC. We then read the
///         deployed `bookings` straight off the script's public state and drive the WHOLE lifecycle
///         through that wired stack — proving the script ships a correctly-composed contract (the
///         Router is the SAME instance Bookings was constructed with, the SessionGrant is wired, USDC
///         is priced through the deployed feed) and that the deposit-escrow flow works against it.
/// @dev    The deploy is the unit-under-test as much as the lifecycle: a regression in DeployAll's
///         wiring (wrong router, missing allowlist, unwired sessionGrant) fails here, not just in a
///         hand-built fixture. `ROUTER_OWNER` is pinned to the broadcaster so the script's in-broadcast
///         owner-only configure calls (USDC allowlist + feed) are authorized — the real `--sender
///         $DEPLOYER` match, exactly as `test/unit/DeployAll.t.sol` does it.
contract Access0x1BookingsIntegrationTest is Test {
    /// @dev Foundry's broadcast default sender — what `vm.startBroadcast()` (no arg) pranks as, and the
    ///      address the script's `owner` defaults to (so the in-broadcast configure calls are signed).
    address internal constant BROADCASTER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;
    uint256 internal constant LOCAL_CHAIN_ID = 31_337;

    Access0x1Router internal router;
    Access0x1Bookings internal bookings;
    SessionGrant internal sessionGrant;
    MockUSDC internal usdc;
    MockV3Aggregator internal usdcFeed;

    // The deployed-stack actors. The Router owner is the broadcaster (script default); a merchant is
    // registered permissionlessly post-deploy, and a payer is funded against the deployed USDC.
    address internal merchantOwner = makeAddr("it_merchantOwner");
    address internal payout = makeAddr("it_payout");
    address internal feeRecipient = makeAddr("it_feeRecipient");
    address internal payer = makeAddr("it_payer");
    uint256 internal merchantId;

    uint64 internal constant SLOT_TS = 1_700_100_000;
    bytes32 internal constant SLOT_KEY = keccak256("integration-slot");
    uint256 internal constant DEPOSIT_USD8 = 75e8; // $75
    uint64 internal constant HOLD_SECS = 1 days;

    /// @notice Stand up the entire estate via the production {DeployAll} script (the deploy under test),
    ///         then register a merchant and fund a payer against the DEPLOYED contracts.
    function setUp() public {
        // Frozen, fresh time so the deployed USDC/USD feed stays inside the staleness window.
        vm.warp(1_700_000_000);
        vm.chainId(LOCAL_CHAIN_ID);
        // Pin the router owner to the broadcaster so the script's onlyOwner configure calls succeed
        // (reproduces the real `forge script --sender $DEPLOYER` run where owner == the signer).
        vm.setEnv("ROUTER_OWNER", vm.toString(BROADCASTER));

        // ── Run the REAL deploy script. HelperConfig (local branch) deploys the mock USDC + feed in its
        //    own broadcast; DeployAll deploys + wires Router, SessionGrant, Bookings, and allowlists USDC.
        DeployAll deployer = new DeployAll();
        (Access0x1Router deployedRouter,, HelperConfig hc) = deployer.run();
        HelperConfig.NetworkConfig memory cfg = hc.getConfig();

        router = deployedRouter;
        bookings = deployer.bookings();
        sessionGrant = deployer.sessionGrant();
        usdc = MockUSDC(cfg.usdc);
        usdcFeed = MockV3Aggregator(cfg.usdcUsdFeed);

        // Sanity-bind the deployed composition before exercising it (the deploy IS under test): the
        // Bookings contract must point at the SAME router + sessionGrant the script wired, and the
        // Router must already have USDC allowlisted + priced through the deployed feed.
        assertTrue(address(bookings) != address(0), "script did not deploy Bookings");
        assertEq(
            address(bookings.router()), address(router), "Bookings wired to a different router"
        );
        assertEq(
            address(bookings.sessionGrant()),
            address(sessionGrant),
            "Bookings wired to a different sessionGrant"
        );
        assertEq(bookings.owner(), BROADCASTER, "Bookings owner is not the deploy owner");
        assertTrue(router.tokenAllowed(address(usdc)), "USDC not allowlisted by the deploy");
        assertEq(
            router.priceFeedOf(address(usdc)), address(usdcFeed), "USDC feed not wired by deploy"
        );

        // Register a merchant on the DEPLOYED router (permissionless) and fund a payer with DEPLOYED USDC.
        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, 50, keccak256("it_m")); // 0.5%

        usdc.mint(payer, 1_000_000e6);
        vm.prank(payer);
        usdc.approve(address(bookings), type(uint256).max);
    }

    function _policy(uint32 windowSecs, uint256 lateUsd8, uint256 noShowUsd8)
        internal
        pure
        returns (IAccess0x1Bookings.Policy memory)
    {
        return IAccess0x1Bookings.Policy({
            cancelWindowSecs: windowSecs, lateFeeUsd8: lateUsd8, noShowFeeUsd8: noShowUsd8
        });
    }

    function _reserve(bytes32 slotKey, bytes32 nonce)
        internal
        returns (uint256 id, uint256 escrow)
    {
        vm.prank(payer);
        id = bookings.reserve(
            merchantId,
            slotKey,
            SLOT_TS,
            address(usdc),
            DEPOSIT_USD8,
            0,
            _policy(2 hours, 10e8, 20e8),
            HOLD_SECS,
            nonce
        );
        escrow = bookings.reservationOf(id).escrowAmount;
    }

    /*//////////////////////////////////////////////////////////////
        HAPPY PATH — reserve → confirm → complete through the DEPLOYED stack
    //////////////////////////////////////////////////////////////*/

    /// @notice INTEGRATION: the full settle path against the script-deployed stack — a payer reserves a
    ///         deposit (priced through the deployed Router/feed), the merchant confirms then completes,
    ///         and the deposit releases through the REAL Router fee-split to the deployed sinks. Proves
    ///         the deployed Bookings composes the deployed Router's split end-to-end (net + fee == gross
    ///         is the Router's own invariant; here the value reaches the right wired sinks).
    function test_integration_reserveConfirmCompleteThroughDeployedStack() public {
        (uint256 id, uint256 escrow) = _reserve(SLOT_KEY, keccak256("it_n1"));

        // The escrow priced through the DEPLOYED router/feed: $75 at $1/USDC = 75e6 (6-dp USDC).
        assertEq(escrow, 75e6, "deposit not priced through the deployed router/feed");
        assertEq(usdc.balanceOf(address(bookings)), escrow, "escrow not held by deployed Bookings");

        // Recompute the split independently (1% platform via the script's default fee, 0.5% merchant).
        uint256 platformFee = escrow * router.platformFeeBps() / 10_000;
        uint256 merchantFee = escrow * 50 / 10_000;
        uint256 net = escrow - platformFee - merchantFee;

        vm.prank(merchantOwner);
        bookings.confirm(id);
        vm.prank(merchantOwner);
        bookings.complete(id);

        // The deposit released through the deployed Router's split to the deployed sinks.
        assertEq(usdc.balanceOf(payout), net, "merchant net mis-routed");
        assertEq(usdc.balanceOf(router.platformTreasury()), platformFee, "platform fee mis-routed");
        assertEq(usdc.balanceOf(feeRecipient), merchantFee, "merchant surcharge mis-routed");
        assertEq(usdc.balanceOf(address(bookings)), 0, "deployed Bookings left holding token");
        assertEq(bookings.escrowedOf(address(usdc)), 0, "escrow ledger not drained");
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.COMPLETED)
        );
        assertTrue(bookings.isSlotFree(SLOT_KEY), "slot not freed for reuse");
    }

    /*//////////////////////////////////////////////////////////////
        REFUND PATH — permissionless expiry against the DEPLOYED stack
    //////////////////////////////////////////////////////////////*/

    /// @notice INTEGRATION: the guaranteed-refund path against the deployed stack — a held deposit that
    ///         passes its deadline is refunded in full to the payer by a permissionless keeper, with no
    ///         operator sink touched. Proves law #5 (refunds never blocked) holds through the real
    ///         deploy wiring, not just a hand-built fixture.
    function test_integration_expireRefundsPayerThroughDeployedStack() public {
        (uint256 id, uint256 escrow) = _reserve(SLOT_KEY, keccak256("it_n2"));
        uint256 payerBefore = usdc.balanceOf(payer);

        vm.warp(block.timestamp + HOLD_SECS + 1);
        vm.prank(makeAddr("it_keeper")); // permissionless keeper, not the payer
        bookings.expireHold(id);

        assertEq(usdc.balanceOf(payer) - payerBefore, escrow, "payer not fully refunded on expiry");
        assertEq(usdc.balanceOf(payout), 0, "an operator sink took a fee on a pure expiry");
        assertEq(bookings.escrowedOf(address(usdc)), 0, "escrow ledger not drained");
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.EXPIRED)
        );
    }

    /*//////////////////////////////////////////////////////////////
        SESSION PATH — cancelWithSession over the DEPLOYED SessionGrant
    //////////////////////////////////////////////////////////////*/

    /// @notice INTEGRATION: the relayed-cancel path exercises the REAL composition of the deployed
    ///         Bookings with the deployed SessionGrant. A payer opens a manage-session on the deployed
    ///         SessionGrant delegating a relayer; the relayer then cancels the payer's booking on the
    ///         deployed Bookings WITHOUT the payer's wallet, and the deposit refunds to the payer.
    ///         Proves DeployAll wired Bookings to the SAME SessionGrant whose sessions it honors —
    ///         a cross-contract composition only this integration layer can prove.
    function test_integration_cancelWithSessionAcrossDeployedSessionGrant() public {
        (uint256 id, uint256 escrow) = _reserve(SLOT_KEY, keccak256("it_n3"));
        address relayer = makeAddr("it_relayer");

        // The payer opens a session on the DEPLOYED SessionGrant (nonce 0 = the first session).
        vm.prank(payer);
        sessionGrant.openSession(relayer, 1e18, uint64(block.timestamp + 1 days));

        uint256 payerBefore = usdc.balanceOf(payer);
        // The relayer (delegate) cancels on the deployed Bookings via the deployed SessionGrant.
        vm.prank(relayer);
        bookings.cancelWithSession(id, 0, IAccess0x1Bookings.ActorType.PAYER);

        // Free cancel (well before the window): the full escrow refunds to the payer.
        assertEq(usdc.balanceOf(payer) - payerBefore, escrow, "session cancel did not refund payer");
        assertEq(
            uint8(bookings.reservationOf(id).status), uint8(IAccess0x1Bookings.RStatus.CANCELLED)
        );
        assertTrue(bookings.isSlotFree(SLOT_KEY), "slot not freed after session cancel");
    }
}
