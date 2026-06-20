// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { SplitSettler } from "../../src/SplitSettler.sol";
import { ISplitSettler } from "../../src/interfaces/ISplitSettler.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { SplitSettlerHandler } from "./SplitSettlerHandler.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @notice The SplitSettler money invariants under a bounded, handler-driven fuzzer — the security floor
///         for the revenue-split primitive. Every property is asserted against an INDEPENDENT ghost
///         recomputation in the handler, never against the contract's own numbers.
/// @dev    Payees are EOAs that always receive, so no fanned-out share ever fails its {withdraw} — the
///         conservation invariant then holds as an EXACT equality (the contract holds exactly the credited
///         minus the withdrawn). The merchant's router payout is the settler, so the router returns the net
///         here for the fan-out. A FROZEN CANARY split (created once, never paused) backs the "every split
///         keeps Σ shares == TOTAL_BPS and is settleable" never-blockable property.
contract SplitSettlerInvariant is StdInvariant, Test, ProxyDeployer {
    SplitSettler internal settler;
    Access0x1Router internal router;
    SplitSettlerHandler internal handler;

    MockV3Aggregator internal usdcFeed;
    MockV3Aggregator internal nativeFeed;
    MockUSDC internal usdc;

    address internal admin = makeAddr("inv_admin");
    address internal treasury = makeAddr("inv_treasury");
    address internal merchantOwner = makeAddr("inv_merchantOwner");
    uint256 internal merchantId;
    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%

    function setUp() public {
        vm.warp(1_700_000_000);

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (admin, treasury, PLATFORM_FEE_BPS))
            )
        );

        usdcFeed = new MockV3Aggregator(8, 1e8); // $1
        nativeFeed = new MockV3Aggregator(8, 2000e8); // $2000
        usdc = new MockUSDC();
        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        router.setPriceFeed(address(0), address(nativeFeed));
        vm.stopPrank();

        address settlerImpl = address(new SplitSettler());
        settler = SplitSettler(
            payable(deployProxy(
                    settlerImpl, abi.encodeCall(SplitSettler.initialize, (admin, router))
                ))
        );

        // The merchant's router payout IS the settler (so the net returns here); no merchant surcharge.
        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(address(settler), address(0), 0, keccak256("inv_m"));

        handler = new SplitSettlerHandler(
            settler, router, usdc, merchantId, treasury, PLATFORM_FEE_BPS
        );
        handler.seedCanary();

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = SplitSettlerHandler.createSplit.selector;
        selectors[1] = SplitSettlerHandler.settleToken.selector;
        selectors[2] = SplitSettlerHandler.settleNative.selector;
        selectors[3] = SplitSettlerHandler.withdraw.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @notice Invariant 1 — conservation (the headline): the contract's balance for each asset is ALWAYS
    ///         >= the still-held backing (Σ net credited − Σ withdrawn) for that asset. Funds are never
    ///         created or stranded. With EOA payees nothing ever fails its withdraw, so the `>=` holds
    ///         (it is exact below); the `>=` form also tolerates any stray surplus a direct send leaves.
    function invariant_tokenConservation() public view {
        uint256 backing =
            handler.ghostCredited(address(usdc)) - handler.ghostWithdrawn(address(usdc));
        assertGe(usdc.balanceOf(address(settler)), backing);
    }

    function invariant_nativeConservation() public view {
        uint256 backing = handler.ghostCredited(address(0)) - handler.ghostWithdrawn(address(0));
        assertGe(address(settler).balance, backing);
    }

    /// @notice Invariant 1 (exact form) — the contract holds EXACTLY the credited-minus-withdrawn backing
    ///         (no leak, no excess): every settlement fanned the full net into the pull-map, every
    ///         withdraw took exactly what was owed, and no push queued (EOA payees), so the balance equals
    ///         Σ withdrawable on the nose. This is the "contract balance == Σ unclaimed payouts" property.
    function invariant_tokenBalanceExact() public view {
        uint256 backing =
            handler.ghostCredited(address(usdc)) - handler.ghostWithdrawn(address(usdc));
        assertEq(usdc.balanceOf(address(settler)), backing);
    }

    function invariant_nativeBalanceExact() public view {
        uint256 backing = handler.ghostCredited(address(0)) - handler.ghostWithdrawn(address(0));
        assertEq(address(settler).balance, backing);
    }

    /// @notice Invariant 2 — the fan-out is always EXACT: every settlement's fanned-out legs summed to the
    ///         router net (no value created or lost in the split; the last leg absorbed the rounding).
    function invariant_splitAlwaysExact() public view {
        assertTrue(handler.splitAlwaysExact());
    }

    /// @notice Invariant 3 (Σ shares == TOTAL_BPS) — the frozen canary split's legs always sum to exactly
    ///         TOTAL_BPS, the "Σ shares == gross" floor at the share level. Every settleable split was
    ///         validated to this at creation and the shares are immutable, so it can never drift.
    function invariant_canarySharesSumToTotal() public view {
        ISplitSettler.Split memory s = settler.splitOf(handler.canarySplitId());
        uint256 sum;
        for (uint256 i = 0; i < s.payees.length; ++i) {
            sum += s.payees[i].shareBps;
        }
        assertEq(sum, settler.TOTAL_BPS());
    }

    /// @notice Invariant 4 (settleable, executable) — the live canary split always settles: a real
    ///         token settlement against it succeeds on a forked copy of state each round, proving an
    ///         active split is genuinely settleable (Σ shares is exact and the fan-out goes through),
    ///         not merely well-formed. State is restored so the canary stays clean for the other rounds.
    function invariant_canaryIsAlwaysSettleable() public {
        uint256 snap = vm.snapshotState();
        uint256 id = handler.canarySplitId();
        uint256 usd8 = 50e8; // $50
        uint256 gross = router.quote(merchantId, address(usdc), usd8);
        address payer = makeAddr("inv_probe_payer");
        usdc.mint(payer, gross);
        vm.startPrank(payer);
        usdc.approve(address(settler), gross);
        settler.settleToken(id, address(usdc), usd8, keccak256("probe")); // must not revert
        vm.stopPrank();
        vm.revertToState(snap); // restore so the canary stays clean for the other invariants/rounds
    }
}
