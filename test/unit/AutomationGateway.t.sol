// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Vm } from "forge-std/Vm.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { AutomationGateway } from "../../src/AutomationGateway.sol";
import { IAutomationGateway } from "../../src/interfaces/IAutomationGateway.sol";
import {
    AutomationCompatibleInterface
} from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import { Access0x1Subscriptions } from "../../src/Access0x1Subscriptions.sol";
import {
    IAccess0x1Subscriptions,
    IAccess0x1Router
} from "../../src/interfaces/IAccess0x1Subscriptions.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { SessionGrant } from "../../src/SessionGrant.sol";
import { ISessionGrant } from "../../src/interfaces/ISessionGrant.sol";

import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @notice A trivial v2 implementation for the upgrade test: adds one view, changes no storage, so an
///         upgrade to it must preserve every prior slot (the watch registry + the Subscriptions binding).
contract AutomationGatewayV2 is AutomationGateway {
    /// @notice A marker the original implementation does not expose — proves the new logic is live.
    function version2Marker() external pure returns (string memory) {
        return "v2";
    }
}

/// @notice The AutomationGateway unit suite — the permissionless Chainlink Automation front-door over
///         the REAL {Access0x1Subscriptions} (composed with the genuine Access0x1Router + SessionGrant +
///         a MockV3Aggregator-fed MockUSDC, so every renewal exercises the true fee-split + in-tx
///         USD->token quote, never a stub). Covers register/deregister (permissionless + idempotent),
///         {checkUpkeep} finding a due sub / skipping a not-due one / respecting the batch cap,
///         {performUpkeep} renewing a due sub (period advanced), the try/catch isolating a system-side
///         renew revert, the on-chain re-validation skipping a now-not-due id, the zero-custody +
///         permissionless-registration properties, ERC-165, and the UUPS upgrade + permanent freeze.
contract AutomationGatewayTest is Test, ProxyDeployer {
    AutomationGateway internal gw;
    address internal gwImpl;

    Access0x1Subscriptions internal subsC;
    Access0x1Router internal router;
    SessionGrant internal grant;

    MockUSDC internal usdc;
    MockV3Aggregator internal usdcFeed;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");

    address internal subscriber;
    uint256 internal subscriberPk;

    uint256 internal merchantId;

    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5%
    uint16 internal constant GRACE = 3;

    uint8 internal constant PLAN_KEY = 2;
    uint256 internal constant PRICE_USD8 = 29e8; // $29 / period
    uint32 internal constant PERIOD = 30 days;
    uint256 internal constant PERIODS = 12;
    uint256 internal constant BUDGET = PRICE_USD8 * PERIODS; // 12 periods authorized
    uint64 internal expiry;

    function setUp() public {
        vm.warp(1_700_000_000); // fresh, stable time for the staleness guard

        (subscriber, subscriberPk) = makeAddrAndKey("subscriber");

        usdc = new MockUSDC();
        usdcFeed = new MockV3Aggregator(8, 1e8); // $1.00/USDC

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (admin, treasury, PLATFORM_FEE_BPS))
            )
        );
        grant = SessionGrant(
            deployProxy(
                address(new SessionGrant()),
                abi.encodeCall(SessionGrant.initialize, ("Access0x1 SessionGrant", "1", admin))
            )
        );
        subsC = Access0x1Subscriptions(
            deployProxy(
                address(new Access0x1Subscriptions()),
                abi.encodeCall(
                    Access0x1Subscriptions.initialize,
                    (admin, IAccess0x1Router(address(router)), ISessionGrant(address(grant)), GRACE)
                )
            )
        );

        // The gateway under test, behind its own UUPS proxy (production shape).
        gwImpl = address(new AutomationGateway());
        gw = AutomationGateway(
            deployProxy(
                gwImpl,
                abi.encodeCall(
                    AutomationGateway.initialize, (admin, IAccess0x1Subscriptions(address(subsC)))
                )
            )
        );

        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        vm.prank(merchantOwner);
        merchantId =
            router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, keccak256("acme"));

        vm.prank(merchantOwner);
        subsC.setPlan(merchantId, PLAN_KEY, PRICE_USD8, PERIOD, true);

        expiry = uint64(block.timestamp + 365 days);

        // Fund + approve the subscriber so renewals can pull through the router fee-split.
        usdc.mint(subscriber, 1_000_000e6);
        vm.prank(subscriber);
        usdc.approve(address(subsC), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Open a SessionGrant owned by the subscriber, naming the Subscriptions contract as delegate.
    function _openSession(uint256 budget) internal returns (bytes32 id) {
        vm.prank(subscriber);
        id = grant.openSession(address(subsC), budget, expiry);
    }

    /// @dev Subscribe (no trial) on a fresh session that covers `PERIODS`, returning the new sub id.
    function _subscribe() internal returns (uint256 subId) {
        bytes32 sessionId = _openSession(BUDGET);
        vm.prank(subscriber);
        subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);
    }

    /// @dev Warp to `ts` AND re-stamp a fresh feed answer there, so a keeper renewing later reads a live
    ///      (non-stale) Chainlink round (mirrors the Subscriptions suite's `_warpAndRefresh`).
    function _warpAndRefresh(uint256 ts) internal {
        vm.warp(ts);
        usdcFeed.updateAnswer(1e8); // re-stamp updatedAt = now, $1.00/USDC
    }

    /// @dev Decode a checkUpkeep result's performData into the due-id array.
    function _decode(bytes memory performData) internal pure returns (uint256[] memory) {
        return abi.decode(performData, (uint256[]));
    }

    /*//////////////////////////////////////////////////////////////
                              INITIALIZE
    //////////////////////////////////////////////////////////////*/

    function test_initialize_setsState() public view {
        assertEq(gw.subscriptions(), address(subsC));
        assertEq(gw.owner(), admin);
        assertEq(gw.watchedCount(), 0);
        assertEq(gw.MAX_SCAN(), 50);
        assertEq(gw.MAX_BATCH(), 50);
    }

    function test_initialize_revertZeroSubscriptions() public {
        address impl = address(new AutomationGateway());
        vm.expectRevert(IAutomationGateway.AutomationGateway__ZeroAddress.selector);
        deployProxy(
            impl,
            abi.encodeCall(
                AutomationGateway.initialize, (admin, IAccess0x1Subscriptions(address(0)))
            )
        );
    }

    function test_initialize_revertZeroOwner() public {
        address impl = address(new AutomationGateway());
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        deployProxy(
            impl,
            abi.encodeCall(
                AutomationGateway.initialize, (address(0), IAccess0x1Subscriptions(address(subsC)))
            )
        );
    }

    function test_initialize_cannotReinit() public {
        vm.expectRevert();
        gw.initialize(admin, IAccess0x1Subscriptions(address(subsC)));
    }

    /*//////////////////////////////////////////////////////////////
                               REGISTRY
    //////////////////////////////////////////////////////////////*/

    function test_register_addsAndEmits() public {
        uint256 subId = _subscribe();
        vm.expectEmit(true, true, false, false, address(gw));
        emit IAutomationGateway.Registered(subId, stranger);
        vm.prank(stranger); // PERMISSIONLESS — a third party may sponsor a sub for automation
        gw.register(subId);

        assertTrue(gw.isWatched(subId));
        assertEq(gw.watchedCount(), 1);
        assertEq(gw.watchedAt(0), subId);
    }

    function test_register_permissionless_anyId_isHarmless() public {
        // Registering a non-existent id is allowed and harmless: it can only ever be poked via the
        // self-guarding {renew}, which never charges an unknown sub.
        vm.prank(stranger);
        gw.register(999_999);
        assertTrue(gw.isWatched(999_999));
        assertFalse(gw.isDue(999_999)); // status NONE → never due
    }

    function test_register_idempotent_noDoubleEmit() public {
        uint256 subId = _subscribe();
        vm.prank(stranger);
        gw.register(subId);
        assertEq(gw.watchedCount(), 1);

        // A second register is a silent no-op (no event, no growth).
        vm.recordLogs();
        vm.prank(keeper);
        gw.register(subId);
        assertEq(vm.getRecordedLogs().length, 0, "re-register emits nothing");
        assertEq(gw.watchedCount(), 1, "no duplicate entry");
    }

    function test_deregister_removesAndEmits() public {
        uint256 subId = _subscribe();
        vm.prank(stranger);
        gw.register(subId);

        vm.expectEmit(true, true, false, false, address(gw));
        emit IAutomationGateway.Deregistered(subId, stranger);
        vm.prank(stranger);
        gw.deregister(subId);

        assertFalse(gw.isWatched(subId));
        assertEq(gw.watchedCount(), 0);
    }

    function test_deregister_idempotent_unwatchedIsNoOp() public {
        vm.recordLogs();
        vm.prank(stranger);
        gw.deregister(12_345); // never watched
        assertEq(vm.getRecordedLogs().length, 0, "deregister of unwatched emits nothing");
        assertEq(gw.watchedCount(), 0);
    }

    /*//////////////////////////////////////////////////////////////
                              CHECKUPKEEP
    //////////////////////////////////////////////////////////////*/

    function test_checkUpkeep_findsDueSub() public {
        uint256 subId = _subscribe();
        vm.prank(stranger);
        gw.register(subId);

        // Not due yet → no upkeep.
        (bool needed0,) = gw.checkUpkeep("");
        assertFalse(needed0, "not due before periodEnd");

        // Warp past the period → due.
        _warpAndRefresh(subsC.subs(subId).periodEnd);
        (bool needed1, bytes memory performData) = gw.checkUpkeep("");
        assertTrue(needed1, "due after periodEnd");
        uint256[] memory ids = _decode(performData);
        assertEq(ids.length, 1);
        assertEq(ids[0], subId);
    }

    function test_checkUpkeep_skipsNotDueSub() public {
        uint256 due = _subscribe();
        uint256 notDue = _subscribe();
        vm.prank(stranger);
        gw.register(due);
        vm.prank(stranger);
        gw.register(notDue);

        // Advance only `due` past its period (both have the same periodEnd at subscribe; renew `notDue`
        // once so its periodEnd jumps a full period into the future while `due` stays due).
        _warpAndRefresh(subsC.subs(notDue).periodEnd);
        subsC.renew(notDue); // notDue's periodEnd now = old + PERIOD (far future); due is still due

        (bool needed, bytes memory performData) = gw.checkUpkeep("");
        assertTrue(needed);
        uint256[] memory ids = _decode(performData);
        assertEq(ids.length, 1, "only the still-due sub is collected");
        assertEq(ids[0], due);
        assertFalse(gw.isDue(notDue), "renewed sub is no longer due");
    }

    function test_checkUpkeep_respectsBatchCap() public {
        // Register MAX_BATCH + 5 due subs; checkUpkeep must return EXACTLY MAX_BATCH ids.
        uint256 cap = gw.MAX_BATCH();
        uint256 n = cap + 5;
        uint256[] memory ids = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            ids[i] = _subscribe();
            vm.prank(stranger);
            gw.register(ids[i]);
        }
        // All share the same periodEnd; warp past it so every one is due.
        _warpAndRefresh(subsC.subs(ids[0]).periodEnd);

        (bool needed, bytes memory performData) = gw.checkUpkeep("");
        assertTrue(needed);
        uint256[] memory due = _decode(performData);
        assertEq(due.length, cap, "batch capped at MAX_BATCH even with more due");
    }

    function test_checkUpkeep_emptyRegistry_noUpkeep() public view {
        (bool needed, bytes memory performData) = gw.checkUpkeep("");
        assertFalse(needed);
        assertEq(_decode(performData).length, 0);
    }

    /*//////////////////////////////////////////////////////////////
                             PERFORMUPKEEP
    //////////////////////////////////////////////////////////////*/

    function test_performUpkeep_renewsDueSub() public {
        uint256 subId = _subscribe();
        vm.prank(stranger);
        gw.register(subId);

        uint64 firstEnd = subsC.subs(subId).periodEnd;
        _warpAndRefresh(firstEnd);

        (bool needed, bytes memory performData) = gw.checkUpkeep("");
        assertTrue(needed);

        uint256 gross = router.quote(merchantId, address(usdc), PRICE_USD8);
        vm.expectEmit(true, false, false, true, address(gw));
        emit IAutomationGateway.Renewed(subId, gross);

        vm.prank(keeper); // permissionless perform
        gw.performUpkeep(performData);

        // The subscription advanced exactly one period and is ACTIVE.
        IAccess0x1Subscriptions.Subscription memory s = subsC.subs(subId);
        assertEq(s.periodEnd, firstEnd + PERIOD, "period advanced by exactly one period");
        assertEq(uint8(s.status), uint8(IAccess0x1Subscriptions.SubStatus.ACTIVE));
        assertFalse(gw.isDue(subId), "no longer due after renew");
    }

    function test_performUpkeep_noCustody() public {
        uint256 subId = _subscribe();
        vm.prank(stranger);
        gw.register(subId);
        _warpAndRefresh(subsC.subs(subId).periodEnd);

        (, bytes memory performData) = gw.checkUpkeep("");
        vm.prank(keeper);
        gw.performUpkeep(performData);

        // The gateway (and the Subscriptions contract) hold ~zero token — the pull is subscriber→router.
        assertEq(usdc.balanceOf(address(gw)), 0, "gateway holds no custody");
        assertEq(usdc.balanceOf(address(subsC)), 0, "subscriptions holds no custody");
    }

    function test_performUpkeep_revalidates_skipsNowNotDueId() public {
        // checkUpkeep flags the sub as due, but another caller renews it before perform lands. The
        // gateway's on-chain re-validation must SKIP it (no revert, no event) — proving it never trusts
        // the stale off-chain snapshot.
        uint256 subId = _subscribe();
        vm.prank(stranger);
        gw.register(subId);
        _warpAndRefresh(subsC.subs(subId).periodEnd);

        (, bytes memory performData) = gw.checkUpkeep("");
        uint64 endBefore = subsC.subs(subId).periodEnd;

        // Front-run: someone else renews it directly.
        vm.prank(stranger);
        subsC.renew(subId);
        uint64 endAfterFrontRun = subsC.subs(subId).periodEnd;
        assertEq(endAfterFrontRun, endBefore + PERIOD, "front-runner advanced the period");

        // Perform with the now-stale data: the id is no longer due → skipped, no Renewed event, no
        // double-charge (period unchanged by the perform).
        vm.recordLogs();
        vm.prank(keeper);
        gw.performUpkeep(performData);
        assertEq(vm.getRecordedLogs().length, 0, "no-op perform emits nothing");
        assertEq(
            subsC.subs(subId).periodEnd,
            endAfterFrontRun,
            "perform did NOT advance an already-renewed sub"
        );
    }

    function test_performUpkeep_tryCatch_isolatesSystemSideFailure() public {
        // Two due subs in the batch. The router is PAUSED, so each renew's charge reverts EnforcedPause —
        // a SYSTEM-side failure {Access0x1Subscriptions.renew} RE-REVERTS (not the subscriber's fault).
        // The gateway's try/catch must isolate it: emit RenewFailed for each, never revert the batch.
        uint256 a = _subscribe();
        uint256 b = _subscribe();
        vm.prank(stranger);
        gw.register(a);
        vm.prank(stranger);
        gw.register(b);

        _warpAndRefresh(subsC.subs(a).periodEnd);
        (, bytes memory performData) = gw.checkUpkeep("");
        assertEq(_decode(performData).length, 2, "both due");

        vm.prank(admin);
        router.pause(); // make every renew's charge revert system-side

        vm.recordLogs();
        vm.prank(keeper);
        gw.performUpkeep(performData); // must NOT revert despite both renews reverting
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // Both subs emitted RenewFailed (topic0 = the event sig); neither was renewed.
        bytes32 failSig = keccak256("RenewFailed(uint256,bytes)");
        uint256 failures;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == failSig) ++failures;
        }
        assertEq(failures, 2, "both renews isolated as RenewFailed, batch survived");

        // Both still due (untouched) — a paused router never advanced either period.
        assertTrue(gw.isDue(a));
        assertTrue(gw.isDue(b));

        // After unpause + refresh, a re-perform renews both cleanly (proves the failure was retryable).
        vm.prank(admin);
        router.unpause();
        _warpAndRefresh(block.timestamp); // re-stamp the feed post-unpause
        (, bytes memory pd2) = gw.checkUpkeep("");
        vm.prank(keeper);
        gw.performUpkeep(pd2);
        assertFalse(gw.isDue(a), "a renewed on retry");
        assertFalse(gw.isDue(b), "b renewed on retry");
    }

    function test_performUpkeep_skipsTerminalAndUnknownIds() public {
        // A hand-crafted performData with an unknown id + a canceled id: re-validation skips both, no
        // revert, no event — the untrusted-input guard.
        uint256 subId = _subscribe();
        vm.prank(subscriber);
        subsC.cancel(subId); // now CANCELED (terminal, not due)

        uint256[] memory ids = new uint256[](2);
        ids[0] = subId; // canceled
        ids[1] = 777_777; // never existed
        bytes memory performData = abi.encode(ids);

        vm.recordLogs();
        vm.prank(keeper);
        gw.performUpkeep(performData);
        assertEq(vm.getRecordedLogs().length, 0, "terminal + unknown ids skipped silently");
    }

    function test_performUpkeep_emptyData_noOp() public {
        uint256[] memory ids = new uint256[](0);
        vm.recordLogs();
        vm.prank(keeper);
        gw.performUpkeep(abi.encode(ids));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    /*//////////////////////////////////////////////////////////////
                                isDue
    //////////////////////////////////////////////////////////////*/

    function test_isDue_falseForUnknown() public view {
        assertFalse(gw.isDue(404)); // status NONE
    }

    function test_isDue_falseBeforePeriodEnd_trueAtPeriodEnd() public {
        uint256 subId = _subscribe();
        uint64 end = subsC.subs(subId).periodEnd;
        vm.warp(end - 1);
        assertFalse(gw.isDue(subId), "not due one second before periodEnd");
        vm.warp(end);
        assertTrue(gw.isDue(subId), "due at the exact periodEnd second");
    }

    function test_isDue_falseForCanceled() public {
        uint256 subId = _subscribe();
        vm.prank(subscriber);
        subsC.cancel(subId);
        // Even after the period ends, a CANCELED sub is never due.
        _warpAndRefresh(subsC.subs(subId).periodEnd + 1);
        assertFalse(gw.isDue(subId), "canceled sub never due");
    }

    function test_isDue_trueForPastDue() public {
        // Drive a sub to PAST_DUE (budget exhausted) and confirm it stays renewable/due.
        bytes32 sessionId = _openSession(PRICE_USD8); // covers exactly one period
        vm.prank(subscriber);
        uint256 subId = subsC.subscribe(merchantId, PLAN_KEY, address(usdc), sessionId, false);
        _warpAndRefresh(subsC.subs(subId).periodEnd);
        subsC.renew(subId); // duns to PAST_DUE (no budget), period NOT advanced
        assertEq(uint8(subsC.subs(subId).status), uint8(IAccess0x1Subscriptions.SubStatus.PAST_DUE));
        assertTrue(gw.isDue(subId), "PAST_DUE within grace is still due/renewable");
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    function test_supportsInterface() public view {
        assertTrue(gw.supportsInterface(type(IAutomationGateway).interfaceId));
        assertTrue(gw.supportsInterface(type(AutomationCompatibleInterface).interfaceId));
        assertTrue(gw.supportsInterface(type(IERC165).interfaceId));
        assertFalse(gw.supportsInterface(0xffffffff));
        assertFalse(gw.supportsInterface(0xdeadbeef));
    }

    /*//////////////////////////////////////////////////////////////
                            UUPS UPGRADE
    //////////////////////////////////////////////////////////////*/

    function test_upgrade_preservesRegistryAndBinding() public {
        uint256 subId = _subscribe();
        vm.prank(stranger);
        gw.register(subId);
        assertEq(gw.watchedCount(), 1);

        address v2 = address(new AutomationGatewayV2());
        vm.prank(admin);
        UUPSUpgradeable(address(gw)).upgradeToAndCall(v2, "");

        // State survives the implementation swap.
        assertEq(gw.subscriptions(), address(subsC));
        assertEq(gw.watchedCount(), 1);
        assertTrue(gw.isWatched(subId));
        assertEq(AutomationGatewayV2(address(gw)).version2Marker(), "v2");
    }

    function test_upgrade_revertNotOwner() public {
        address v2 = address(new AutomationGatewayV2());
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        vm.prank(stranger);
        UUPSUpgradeable(address(gw)).upgradeToAndCall(v2, "");
    }

    function test_renounceOwnership_freezesUpgrade() public {
        vm.prank(admin);
        gw.renounceOwnership();
        assertEq(gw.owner(), address(0));

        address v2 = address(new AutomationGatewayV2());
        // No owner ⇒ _authorizeUpgrade reverts for everyone ⇒ permanently frozen.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        vm.prank(admin);
        UUPSUpgradeable(address(gw)).upgradeToAndCall(v2, "");
    }
}
