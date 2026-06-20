// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { OracleLib } from "../../src/libraries/OracleLib.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { RevertingReceiver } from "../mocks/RevertingReceiver.sol";
import { ReentrantPayout } from "../mocks/ReentrantPayout.sol";
import { FeeOnTransferToken } from "../mocks/FeeOnTransferToken.sol";
import { RescueClaimer } from "../mocks/RescueClaimer.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    OwnableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @notice A trivial v2 implementation used by the upgrade test: a subclass that adds one view function
///         and changes nothing else, so an upgrade to it must preserve all prior state. It deliberately
///         carries no new storage (it would consume from `__gap` if it did), proving the proxy keeps
///         every slot across the implementation swap.
contract Access0x1RouterV2 is Access0x1Router {
    /// @notice A marker the original implementation does not expose — lets the test prove the new logic
    ///         is live after {upgradeToAndCall}.
    /// @return The constant string identifying this as the v2 implementation.
    function version2Marker() external pure returns (string memory) {
        return "v2";
    }
}

/// @notice The router's unit suite — the full surface in one fixture: initializer, merchant
///         registry, pricing, both pay paths (with adversarial mocks), admin, and rescue. The router
///         is deployed BEHIND a UUPS proxy (deploy impl → `ERC1967Proxy` with `initialize(...)`
///         calldata → cast the proxy to the type) via the shared {ProxyDeployer}, so every behavioural
///         test exercises the production proxy↔impl shape. Tail tests cover the UUPS upgrade + the
///         permanent freeze via `renounceOwnership`.
contract Access0x1RouterTest is Test, ProxyDeployer {
    Access0x1Router internal router;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%

    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient");
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5%
    bytes32 internal constant NAME_HASH = keccak256("acme");

    MockV3Aggregator internal nativeFeed; // ETH/USD, 8 dp
    MockV3Aggregator internal usdcFeed; // USDC/USD, 8 dp
    MockUSDC internal usdc; // 6 dp

    address internal buyer = makeAddr("buyer");
    bytes32 internal constant ORDER = keccak256("order-1");

    function setUp() public virtual {
        // Deploy the implementation, then the ERC1967 proxy that initializes it, then drive the proxy.
        address impl = address(new Access0x1Router());
        address proxy = deployProxy(
            impl, abi.encodeCall(Access0x1Router.initialize, (owner, treasury, PLATFORM_FEE_BPS))
        );
        router = Access0x1Router(proxy);
    }

    /// @dev Deploy + wire a native ($2000) and a USDC ($1) feed, and allowlist USDC. Called by the
    ///      pricing tests; a fresh, non-zero warp keeps the feeds inside the staleness window.
    function _configureFeeds() internal {
        vm.warp(1_700_000_000);
        nativeFeed = new MockV3Aggregator(8, 2000e8);
        usdcFeed = new MockV3Aggregator(8, 1e8);
        usdc = new MockUSDC();
        vm.startPrank(owner);
        router.setPriceFeed(address(0), address(nativeFeed));
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();
    }

    /// @dev Register the default merchant as `merchantOwner`; returns its id.
    function _register() internal returns (uint256 id) {
        vm.prank(merchantOwner);
        id = router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);
    }

    /// @dev The two-leg split for the default merchant: platform cut, merchant surcharge, net.
    function _fees(uint256 gross)
        internal
        pure
        returns (uint256 platformFee, uint256 merchantFee, uint256 net)
    {
        platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        net = gross - platformFee - merchantFee;
    }

    /*//////////////////////////////////////////////////////////////
                              INITIALIZER
    //////////////////////////////////////////////////////////////*/

    function test_constructorSetsInitialState() public view {
        assertEq(router.owner(), owner);
        assertEq(router.platformTreasury(), treasury);
        assertEq(router.platformFeeBps(), PLATFORM_FEE_BPS);
        assertEq(router.nextMerchantId(), 1); // 0 stays the unset sentinel
        assertEq(router.MAX_FEE_BPS(), 1000);
    }

    function test_constructorRevertsOnZeroTreasury() public {
        // Validation moved from the constructor into initialize(); the revert surfaces when the proxy
        // runs the initializer in its constructor.
        address impl = address(new Access0x1Router());
        vm.expectRevert(Access0x1Router.Access0x1__ZeroAddress.selector);
        deployProxy(
            impl, abi.encodeCall(Access0x1Router.initialize, (owner, address(0), PLATFORM_FEE_BPS))
        );
    }

    function test_constructorRevertsOnFeeTooHigh() public {
        uint16 tooHigh = router.MAX_FEE_BPS() + 1;
        address impl = address(new Access0x1Router());
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__FeeTooHigh.selector, tooHigh, router.MAX_FEE_BPS()
            )
        );
        deployProxy(impl, abi.encodeCall(Access0x1Router.initialize, (owner, treasury, tooHigh)));
    }

    function test_initialize_revertOnSecondCall() public {
        // The proxy was already initialized in setUp; a second call must revert (one-time initializer).
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        router.initialize(owner, treasury, PLATFORM_FEE_BPS);
    }

    /*//////////////////////////////////////////////////////////////
                            REGISTER MERCHANT
    //////////////////////////////////////////////////////////////*/

    function test_registerStoresMerchantAndEmits() public {
        vm.expectEmit(true, true, false, true, address(router));
        emit Access0x1Router.MerchantRegistered(
            1, merchantOwner, payout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH
        );
        uint256 id = _register();

        assertEq(id, 1);
        (address p, address o, address fr, uint16 fb, bool active, bytes32 nh) = router.merchants(1);
        assertEq(p, payout);
        assertEq(o, merchantOwner);
        assertEq(fr, feeRecipient);
        assertEq(fb, MERCHANT_FEE_BPS);
        assertTrue(active);
        assertEq(nh, NAME_HASH);
        assertEq(router.nextMerchantId(), 2);
    }

    function test_registerIncrementsId() public {
        assertEq(_register(), 1);
        assertEq(_register(), 2);
    }

    function test_registerRevertsOnZeroPayout() public {
        vm.prank(merchantOwner);
        vm.expectRevert(Access0x1Router.Access0x1__ZeroAddress.selector);
        router.registerMerchant(address(0), feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);
    }

    function test_registerRevertsWhenFeeCapExceeded() public {
        uint16 maxFee = router.MAX_FEE_BPS(); // cache before prank — a call here would consume it
        uint16 over = maxFee - PLATFORM_FEE_BPS + 1; // combined = 1001 > 1000
        uint256 combined = uint256(over) + PLATFORM_FEE_BPS;
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__FeeTooHigh.selector, combined, maxFee)
        );
        router.registerMerchant(payout, feeRecipient, over, NAME_HASH);
    }

    function test_registerAllowsExactlyMaxFee() public {
        uint16 atCap = router.MAX_FEE_BPS() - PLATFORM_FEE_BPS; // combined == 1000
        vm.prank(merchantOwner);
        uint256 id = router.registerMerchant(payout, feeRecipient, atCap, NAME_HASH);
        (,,, uint16 fb,,) = router.merchants(id);
        assertEq(fb, atCap);
    }

    function test_registerAllowsZeroFeeRecipient() public {
        vm.prank(merchantOwner);
        uint256 id = router.registerMerchant(payout, address(0), MERCHANT_FEE_BPS, NAME_HASH);
        (,, address fr,,,) = router.merchants(id);
        assertEq(fr, address(0)); // allowed: pay path falls back to payout
    }

    /*//////////////////////////////////////////////////////////////
                            UPDATE MERCHANT
    //////////////////////////////////////////////////////////////*/

    function test_updateChangesConfigAndPreservesIdentity() public {
        uint256 id = _register();
        address newPayout = makeAddr("newPayout");
        address newFeeRecipient = makeAddr("newFeeRecipient");
        uint16 newFeeBps = 200;

        vm.expectEmit(true, false, false, true, address(router));
        emit Access0x1Router.MerchantUpdated(id, newPayout, newFeeRecipient, newFeeBps, false);
        vm.prank(merchantOwner);
        router.updateMerchant(id, newPayout, newFeeRecipient, newFeeBps, false);

        (address p, address o, address fr, uint16 fb, bool active, bytes32 nh) =
            router.merchants(id);
        assertEq(p, newPayout);
        assertEq(fr, newFeeRecipient);
        assertEq(fb, newFeeBps);
        assertFalse(active);
        assertEq(o, merchantOwner); // owner is immutable
        assertEq(nh, NAME_HASH); // nameHash is immutable
    }

    function test_updateRevertsOnUnknownId() public {
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__MerchantNotFound.selector, 999)
        );
        router.updateMerchant(999, payout, feeRecipient, MERCHANT_FEE_BPS, true);
    }

    function test_updateRevertsWhenNotOwner() public {
        uint256 id = _register();
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__NotMerchantOwner.selector, id, attacker
            )
        );
        router.updateMerchant(id, payout, feeRecipient, MERCHANT_FEE_BPS, true);
    }

    function test_updateRevertsOnZeroPayout() public {
        uint256 id = _register();
        vm.prank(merchantOwner);
        vm.expectRevert(Access0x1Router.Access0x1__ZeroAddress.selector);
        router.updateMerchant(id, address(0), feeRecipient, MERCHANT_FEE_BPS, true);
    }

    function test_updateRevertsWhenFeeCapExceeded() public {
        uint256 id = _register();
        uint16 maxFee = router.MAX_FEE_BPS(); // cache before prank — a call here would consume it
        uint16 over = maxFee - PLATFORM_FEE_BPS + 1;
        uint256 combined = uint256(over) + PLATFORM_FEE_BPS;
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__FeeTooHigh.selector, combined, maxFee)
        );
        router.updateMerchant(id, payout, feeRecipient, over, true);
    }

    /*//////////////////////////////////////////////////////////////
                      MERCHANT OWNERSHIP (2-step transfer)
    //////////////////////////////////////////////////////////////*/

    /// @notice O-4: the full 2-step transfer. The current owner proposes a new owner (control unchanged),
    ///         then the proposed owner accepts and becomes the owner; the pending slot clears.
    function test_proposeAndAcceptMerchantOwner() public {
        uint256 id = _register();
        address newOwner = makeAddr("newMerchantOwner");

        // Step 1: current owner proposes. Control does NOT change yet.
        vm.expectEmit(true, true, true, false, address(router));
        emit Access0x1Router.MerchantOwnerProposed(id, merchantOwner, newOwner);
        vm.prank(merchantOwner);
        router.proposeMerchantOwner(id, newOwner);

        assertEq(router.pendingMerchantOwner(id), newOwner);
        (, address ownerMid,,,,) = router.merchants(id);
        assertEq(ownerMid, merchantOwner, "owner unchanged until accept");

        // Step 2: the proposed owner accepts. Control transfers; pending clears.
        vm.expectEmit(true, true, true, false, address(router));
        emit Access0x1Router.MerchantOwnerTransferred(id, merchantOwner, newOwner);
        vm.prank(newOwner);
        router.acceptMerchantOwner(id);

        (, address ownerAfter,,,,) = router.merchants(id);
        assertEq(ownerAfter, newOwner, "new owner now controls the merchant");
        assertEq(router.pendingMerchantOwner(id), address(0), "pending cleared on accept");
    }

    /// @notice O-4: after a completed transfer, the NEW owner can update the merchant and the OLD owner
    ///         can no longer — control genuinely moved (a recovery path for a compromised key).
    function test_ownershipTransferMovesControl() public {
        uint256 id = _register();
        address newOwner = makeAddr("newMerchantOwner");
        vm.prank(merchantOwner);
        router.proposeMerchantOwner(id, newOwner);
        vm.prank(newOwner);
        router.acceptMerchantOwner(id);

        // The OLD owner is now rejected by updateMerchant.
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__NotMerchantOwner.selector, id, merchantOwner
            )
        );
        router.updateMerchant(id, payout, feeRecipient, MERCHANT_FEE_BPS, true);

        // The NEW owner can update it.
        address freshPayout = makeAddr("freshPayout");
        vm.prank(newOwner);
        router.updateMerchant(id, freshPayout, feeRecipient, MERCHANT_FEE_BPS, true);
        (address p,,,,,) = router.merchants(id);
        assertEq(p, freshPayout);
    }

    /// @notice O-4: only the current merchant owner may propose a new owner.
    function test_proposeMerchantOwnerRevertsForNonOwner() public {
        uint256 id = _register();
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__NotMerchantOwner.selector, id, attacker
            )
        );
        router.proposeMerchantOwner(id, attacker);
    }

    /// @notice O-4: proposing on an unknown merchant reverts {MerchantNotFound}.
    function test_proposeMerchantOwnerRevertsOnUnknownId() public {
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__MerchantNotFound.selector, 999)
        );
        router.proposeMerchantOwner(999, merchantOwner);
    }

    /// @notice O-4: only the EXACT pending owner may accept. A stranger (here the current owner, who is
    ///         not the proposed address) is rejected and control does not change.
    function test_acceptMerchantOwnerRevertsForNonPending() public {
        uint256 id = _register();
        address newOwner = makeAddr("newMerchantOwner");
        vm.prank(merchantOwner);
        router.proposeMerchantOwner(id, newOwner);

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__NotPendingMerchantOwner.selector, id, stranger
            )
        );
        router.acceptMerchantOwner(id);

        (, address ownerStill,,,,) = router.merchants(id);
        assertEq(
            ownerStill, merchantOwner, "control unchanged when a non-pending caller tries to accept"
        );
    }

    /// @notice O-4: accepting when nothing was proposed (zero pending) reverts — an unset proposal can
    ///         never transfer control, not even to address(0).
    function test_acceptMerchantOwnerRevertsWhenNoPending() public {
        uint256 id = _register();
        address claimant = makeAddr("claimant");
        vm.prank(claimant);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__NotPendingMerchantOwner.selector, id, claimant
            )
        );
        router.acceptMerchantOwner(id);
    }

    /// @notice O-4: re-proposing overwrites the prior pending owner, and passing address(0) cancels a
    ///         pending proposal so the previously-proposed address can no longer accept.
    function test_proposeMerchantOwnerCanCancelAndOverwrite() public {
        uint256 id = _register();
        address first = makeAddr("firstProposed");
        address second = makeAddr("secondProposed");

        vm.prank(merchantOwner);
        router.proposeMerchantOwner(id, first);
        assertEq(router.pendingMerchantOwner(id), first);

        // Overwrite with a different proposal.
        vm.prank(merchantOwner);
        router.proposeMerchantOwner(id, second);
        assertEq(router.pendingMerchantOwner(id), second);

        // The first (now-stale) proposed owner cannot accept.
        vm.prank(first);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__NotPendingMerchantOwner.selector, id, first
            )
        );
        router.acceptMerchantOwner(id);

        // Cancel entirely with address(0); now nobody can accept.
        vm.prank(merchantOwner);
        router.proposeMerchantOwner(id, address(0));
        assertEq(router.pendingMerchantOwner(id), address(0));
        vm.prank(second);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__NotPendingMerchantOwner.selector, id, second
            )
        );
        router.acceptMerchantOwner(id);
    }

    /*//////////////////////////////////////////////////////////////
                                QUOTE
    //////////////////////////////////////////////////////////////*/

    function test_quoteNativeConversion() public {
        _configureFeeds();
        // $20.00 at ETH=$2000 → 0.01 ETH
        assertEq(router.quote(1, address(0), 20e8), 0.01 ether);
    }

    function test_quoteUsdcConversion() public {
        _configureFeeds();
        // $20.00 at USDC=$1 → 20 USDC (6 dp) — proves non-18-decimal handling
        assertEq(router.quote(1, address(usdc), 20e8), 20e6);
    }

    function test_quoteRoundsUp() public {
        _configureFeeds();
        vm.prank(owner);
        // ETH=$3000: 1e-8 USD → 1e26 / 3e19 = 3333333.33… → ceil 3333334
        nativeFeed.updateAnswer(3000e8);
        assertEq(router.quote(1, address(0), 1), 3_333_334);
    }

    function test_quoteRevertsOnZeroUsd() public {
        _configureFeeds();
        vm.expectRevert(Access0x1Router.Access0x1__ZeroAmount.selector);
        router.quote(1, address(0), 0);
    }

    function test_quoteRevertsWhenTokenNotAllowed() public {
        _configureFeeds();
        address rando = makeAddr("rando");
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__TokenNotAllowed.selector, rando)
        );
        router.quote(1, rando, 20e8);
    }

    function test_quoteRevertsWhenAllowedButNoFeed() public {
        _configureFeeds();
        address noFeed = makeAddr("noFeed");
        vm.prank(owner);
        router.setTokenAllowed(noFeed, true); // allowed, but priceFeedOf stays 0
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__TokenNotAllowed.selector, noFeed)
        );
        router.quote(1, noFeed, 20e8);
    }

    function test_quoteRevertsOnStaleFeed() public {
        _configureFeeds();
        nativeFeed.setRoundData(1, 2000e8, block.timestamp - 3601, block.timestamp - 3601, 1);
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector); // surfaced through the inlined guard
        router.quote(1, address(0), 20e8);
    }

    /// @dev Per-feed staleness (Medium fix): a 24h-heartbeat USDC/USD feed wired via the 3-arg
    ///      `setPriceFeed` with an 86400+margin window prices fine even when its answer is ~24h old —
    ///      where the flat 1h default would falsely revert it as stale. Proves the window is honored.
    function test_quoteHonorsPerFeedStaleness24hHeartbeat() public {
        _configureFeeds();
        uint256 window = 86_400 + 3600;
        vm.prank(owner);
        router.setPriceFeed(address(usdc), address(usdcFeed), window);
        assertEq(router.stalenessOf(address(usdc)), window);
        // Answer last updated ~24h ago — stale under the 1h default, fresh under the 24h+ window.
        usdcFeed.setRoundData(1, 1e8, block.timestamp - 86_400, block.timestamp - 86_400, 1);
        assertEq(router.quote(1, address(usdc), 20e8), 20e6); // does NOT revert
    }

    /// @dev Even with a wide per-feed window, a genuinely stale answer (older than the configured
    ///      window) still reverts `OracleLib__StalePrice` — the guard is widened, not disabled.
    function test_quoteRevertsWhenBeyondPerFeedStaleness() public {
        _configureFeeds();
        uint256 window = 86_400 + 3600;
        vm.prank(owner);
        router.setPriceFeed(address(usdc), address(usdcFeed), window);
        // Older than the configured window ⇒ genuinely stale ⇒ revert.
        usdcFeed.setRoundData(1, 1e8, block.timestamp - window - 1, block.timestamp - window - 1, 1);
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        router.quote(1, address(usdc), 20e8);
    }

    /// @dev The 2-arg `setPriceFeed` leaves `stalenessOf` at 0, so `quote()` falls back to OracleLib's
    ///      1h default: an answer just over 1h old still reverts as stale (backward-compatible).
    function test_twoArgSetPriceFeedKeeps1hDefault() public {
        _configureFeeds(); // wires usdc via the 2-arg overload
        assertEq(router.stalenessOf(address(usdc)), 0); // unset ⇒ 1h default
        // 1h + 1s old: fresh under any wider window, but stale under the inherited 1h default.
        usdcFeed.setRoundData(1, 1e8, block.timestamp - 3601, block.timestamp - 3601, 1);
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        router.quote(1, address(usdc), 20e8);
    }

    /// @dev The 3-arg `setPriceFeed` rejects a zero `maxStaleness` (no silent 0-window write).
    function test_threeArgSetPriceFeedRejectsZeroStaleness() public {
        _configureFeeds();
        vm.prank(owner);
        vm.expectRevert(Access0x1Router.Access0x1__ZeroAmount.selector);
        router.setPriceFeed(address(usdc), address(usdcFeed), 0);
    }

    /// @dev The 3-arg `setPriceFeed` rejects a zero feed (a window with no feed is meaningless;
    ///      callers clear via the 2-arg overload).
    function test_threeArgSetPriceFeedRejectsZeroFeed() public {
        _configureFeeds();
        vm.prank(owner);
        vm.expectRevert(Access0x1Router.Access0x1__ZeroAddress.selector);
        router.setPriceFeed(address(usdc), address(0), 86_400);
    }

    /// @dev Re-wiring with the 2-arg overload resets a previously-set per-feed window back to the 1h
    ///      default, so clearing-by-2-arg can never leave a stale wide window behind.
    function test_twoArgSetPriceFeedResetsStaleness() public {
        _configureFeeds();
        vm.startPrank(owner);
        router.setPriceFeed(address(usdc), address(usdcFeed), 86_400);
        assertEq(router.stalenessOf(address(usdc)), 86_400);
        router.setPriceFeed(address(usdc), address(usdcFeed)); // 2-arg resets to default
        vm.stopPrank();
        assertEq(router.stalenessOf(address(usdc)), 0);
    }

    function test_quoteRevertsOnZeroPrice() public {
        _configureFeeds();
        nativeFeed.updateAnswer(0);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__InvalidPrice.selector, int256(0))
        );
        router.quote(1, address(0), 20e8);
    }

    function test_quoteRevertsOnNegativePrice() public {
        _configureFeeds();
        nativeFeed.updateAnswer(-1);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__InvalidPrice.selector, int256(-1))
        );
        router.quote(1, address(0), 20e8);
    }

    /// @dev A token whose `decimals()` reverts must surface the TYPED `Access0x1__TokenNotAllowed`
    ///      (caught in the `quote()` try/catch), never an opaque bubble-up. The token is fully
    ///      allowlisted with a valid feed, so it reaches the `IERC20Metadata(token).decimals()`
    ///      read — and the revert there is exactly the griefing case the guard exists to absorb.
    function test_quoteRevertsWhenTokenDecimalsRevert() public {
        _configureFeeds();
        RevertingDecimalsToken hostile = new RevertingDecimalsToken();
        vm.startPrank(owner);
        router.setTokenAllowed(address(hostile), true);
        router.setPriceFeed(address(hostile), address(usdcFeed)); // valid $1 feed
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__TokenNotAllowed.selector, address(hostile)
            )
        );
        router.quote(1, address(hostile), 20e8);
    }

    /// @dev A feed whose `decimals()` reverts (but whose `latestRoundData()` is valid + fresh, so the
    ///      staleness guard passes) must ALSO surface the typed `Access0x1__TokenNotAllowed` from the
    ///      `feed.decimals()` try/catch — the other half of the same hardening.
    function test_quoteRevertsWhenFeedDecimalsRevert() public {
        _configureFeeds();
        RevertingDecimalsFeed hostileFeed = new RevertingDecimalsFeed(2000e8);
        address tok = makeAddr("tokWithHostileFeed");
        vm.startPrank(owner);
        router.setTokenAllowed(tok, true);
        router.setPriceFeed(tok, address(hostileFeed));
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__TokenNotAllowed.selector, tok)
        );
        router.quote(1, tok, 20e8);
    }

    /// @dev `feedDecimals` enters the `mulDiv` exponent, so a non-8-decimal feed must still produce
    ///      the correct token amount. Wire an 18-decimal ETH/USD feed at $2000 and assert $20.00
    ///      still quotes 0.01 ETH — proving the live `feed.decimals()` read (not a hardcoded 8) is
    ///      what makes the arithmetic vendor-agnostic.
    function test_quoteWithNonEightDecimalFeed() public {
        vm.warp(1_700_000_000);
        MockV3Aggregator feed18 = new MockV3Aggregator(18, 2000e18); // ETH/USD, 18 dp, $2000
        vm.prank(owner);
        router.setPriceFeed(address(0), address(feed18));
        // $20.00 (8 dp) at ETH=$2000 → 0.01 ETH, independent of the feed's own decimals.
        assertEq(router.quote(1, address(0), 20e8), 0.01 ether);
    }

    /*//////////////////////////////////////////////////////////////
                              PAY NATIVE
    //////////////////////////////////////////////////////////////*/

    function test_payNativeSettlesAndEmits() public {
        _configureFeeds();
        uint256 id = _register();
        uint256 gross = router.quote(id, address(0), 20e8); // 0.01 ether
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _fees(gross);

        vm.deal(buyer, 1 ether);
        vm.expectEmit(true, true, true, true, address(router));
        emit Access0x1Router.PaymentReceived(
            id, buyer, address(0), gross, platformFee + merchantFee, net, 20e8, ORDER, 0
        );
        vm.prank(buyer);
        router.payNative{ value: gross }(id, 20e8, ORDER);

        assertEq(payout.balance, net);
        assertEq(treasury.balance, platformFee); // platform cut always → treasury
        assertEq(feeRecipient.balance, merchantFee); // merchant surcharge → feeRecipient
        assertEq(address(router).balance, 0); // no custody
        assertEq(net + platformFee + merchantFee, gross); // net + fee == gross
    }

    function test_payNativeRefundsExcess() public {
        _configureFeeds();
        uint256 id = _register();
        uint256 gross = router.quote(id, address(0), 20e8);

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        router.payNative{ value: gross + 0.5 ether }(id, 20e8, ORDER);

        assertEq(buyer.balance, 1 ether - gross); // net effect: buyer paid exactly gross
    }

    function test_payNativeRevertsUnderpaid() public {
        _configureFeeds();
        uint256 id = _register();
        uint256 gross = router.quote(id, address(0), 20e8);

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__Underpaid.selector, gross, gross - 1)
        );
        router.payNative{ value: gross - 1 }(id, 20e8, ORDER);
    }

    function test_payNativeRevertsWhenMerchantNotFound() public {
        _configureFeeds();
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__MerchantNotFound.selector, 42)
        );
        router.payNative{ value: 1 ether }(42, 20e8, ORDER);
    }

    function test_payNativeRevertsWhenInactive() public {
        _configureFeeds();
        uint256 id = _register();
        vm.prank(merchantOwner);
        router.updateMerchant(id, payout, feeRecipient, MERCHANT_FEE_BPS, false); // deactivate

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__MerchantInactive.selector, id)
        );
        router.payNative{ value: 1 ether }(id, 20e8, ORDER);
    }

    function test_payNativeQueuesRescueWhenPayoutRejects() public {
        _configureFeeds();
        RevertingReceiver badPayout = new RevertingReceiver();
        vm.prank(merchantOwner);
        uint256 id =
            router.registerMerchant(address(badPayout), feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);
        uint256 gross = router.quote(id, address(0), 20e8);
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _fees(gross);

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        router.payNative{ value: gross }(id, 20e8, ORDER); // receipt still emits

        assertEq(router.rescue(address(badPayout)), net); // queued, not lost
        assertEq(treasury.balance, platformFee); // platform cut still paid
        assertEq(feeRecipient.balance, merchantFee); // merchant surcharge still paid
        assertEq(address(router).balance, net); // router holds exactly the rescued net
    }

    function test_payNativeRevertsWhenRefundFails() public {
        _configureFeeds();
        uint256 id = _register();
        uint256 gross = router.quote(id, address(0), 20e8);

        RevertingReceiver badBuyer = new RevertingReceiver();
        vm.deal(address(badBuyer), 1 ether);
        vm.prank(address(badBuyer));
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__NativePushFailed.selector, address(badBuyer), 0.5 ether
            )
        );
        router.payNative{ value: gross + 0.5 ether }(id, 20e8, ORDER);
    }

    function test_payNativeReentrancyIsBlocked() public {
        _configureFeeds();
        vm.prank(merchantOwner);
        uint256 id = router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);

        ReentrantPayout attacker = new ReentrantPayout(router, id);
        vm.prank(merchantOwner);
        router.updateMerchant(id, address(attacker), feeRecipient, MERCHANT_FEE_BPS, true);

        uint256 gross = router.quote(id, address(0), 20e8);
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _fees(gross);

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        router.payNative{ value: gross }(id, 20e8, ORDER);

        // re-entry reverted → net push failed → queued; the merchant is NOT settled twice
        assertEq(router.rescue(address(attacker)), net);
        assertEq(treasury.balance, platformFee);
        assertEq(feeRecipient.balance, merchantFee);
    }

    /*//////////////////////////////////////////////////////////////
                              PAY TOKEN
    //////////////////////////////////////////////////////////////*/

    function test_payTokenSettlesAndEmits() public {
        _configureFeeds();
        uint256 id = _register();
        uint256 gross = router.quote(id, address(usdc), 20e8); // 20 USDC
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _fees(gross);

        usdc.mint(buyer, 100e6);
        vm.prank(buyer);
        usdc.approve(address(router), gross);

        vm.expectEmit(true, true, true, true, address(router));
        emit Access0x1Router.PaymentReceived(
            id, buyer, address(usdc), gross, platformFee + merchantFee, net, 20e8, ORDER, 0
        );
        vm.prank(buyer);
        router.payToken(id, address(usdc), 20e8, ORDER);

        assertEq(usdc.balanceOf(payout), net);
        assertEq(usdc.balanceOf(treasury), platformFee); // platform cut → treasury
        assertEq(usdc.balanceOf(feeRecipient), merchantFee); // merchant surcharge → feeRecipient
        assertEq(usdc.balanceOf(address(router)), 0); // no custody — zero residual
        assertEq(net + platformFee + merchantFee, gross);
    }

    function test_payTokenRevertsOnUnknownMerchant() public {
        _configureFeeds();
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__MerchantNotFound.selector, 999)
        );
        router.payToken(999, address(usdc), 20e8, ORDER);
    }

    function test_payTokenRevertsOnNativeToken() public {
        _configureFeeds();
        uint256 id = _register();
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__TokenNotAllowed.selector, address(0))
        );
        router.payToken(id, address(0), 20e8, ORDER);
    }

    function test_payTokenRevertsWhenNotAllowed() public {
        _configureFeeds();
        uint256 id = _register();
        MockUSDC other = new MockUSDC(); // never allowlisted, no feed
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__TokenNotAllowed.selector, address(other)
            )
        );
        router.payToken(id, address(other), 20e8, ORDER);
    }

    function test_payTokenRevertsOnFeeOnTransfer() public {
        _configureFeeds();
        uint256 id = _register();
        FeeOnTransferToken fot = new FeeOnTransferToken();
        vm.startPrank(owner);
        router.setTokenAllowed(address(fot), true);
        router.setPriceFeed(address(fot), address(usdcFeed)); // $1, so gross = 20e6
        vm.stopPrank();

        uint256 gross = router.quote(id, address(fot), 20e8);
        uint256 received = gross - gross / 100; // the token skims 1%
        fot.mint(buyer, 100e6);
        vm.prank(buyer);
        fot.approve(address(router), gross);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__FeeOnTransferToken.selector, gross, received
            )
        );
        router.payToken(id, address(fot), 20e8, ORDER);
    }

    function test_payTokenRevertsOnInsufficientAllowance() public {
        _configureFeeds();
        uint256 id = _register();
        usdc.mint(buyer, 100e6); // minted, but never approved
        vm.prank(buyer);
        vm.expectRevert(); // OZ ERC20InsufficientAllowance bubbled through SafeERC20
        router.payToken(id, address(usdc), 20e8, ORDER);
    }

    function test_payTokenRevertsWhenInactive() public {
        _configureFeeds();
        uint256 id = _register();
        vm.prank(merchantOwner);
        router.updateMerchant(id, payout, feeRecipient, MERCHANT_FEE_BPS, false);

        usdc.mint(buyer, 100e6);
        vm.prank(buyer);
        usdc.approve(address(router), type(uint256).max);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__MerchantInactive.selector, id)
        );
        router.payToken(id, address(usdc), 20e8, ORDER);
    }

    /*//////////////////////////////////////////////////////////////
                            ADMIN — setPlatformFee
    //////////////////////////////////////////////////////////////*/

    function test_setPlatformFeeUpdatesAndEmits() public {
        vm.expectEmit(false, false, false, true, address(router));
        emit Access0x1Router.PlatformFeeUpdated(PLATFORM_FEE_BPS, 250);
        vm.prank(owner);
        router.setPlatformFee(250);
        assertEq(router.platformFeeBps(), 250);
    }

    function test_setPlatformFeeAllowsExactlyMax() public {
        uint16 maxFee = router.MAX_FEE_BPS();
        vm.prank(owner);
        router.setPlatformFee(maxFee);
        assertEq(router.platformFeeBps(), maxFee);
    }

    function test_setPlatformFeeRevertsAboveMax() public {
        uint16 maxFee = router.MAX_FEE_BPS();
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__FeeTooHigh.selector, maxFee + 1, maxFee
            )
        );
        router.setPlatformFee(maxFee + 1);
    }

    function test_setPlatformFeeRevertsWhenNotOwner() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        router.setPlatformFee(250);
    }

    /*//////////////////////////////////////////////////////////////
                            ADMIN — setTreasury
    //////////////////////////////////////////////////////////////*/

    function test_setTreasuryUpdatesAndEmits() public {
        address newTreasury = makeAddr("newTreasury");
        vm.expectEmit(true, false, false, true, address(router)); // newTreasury is indexed
        emit Access0x1Router.TreasuryUpdated(treasury, newTreasury);
        vm.prank(owner);
        router.setTreasury(newTreasury);
        assertEq(router.platformTreasury(), newTreasury);
    }

    function test_setTreasuryRevertsOnZero() public {
        vm.prank(owner);
        vm.expectRevert(Access0x1Router.Access0x1__ZeroAddress.selector);
        router.setTreasury(address(0));
    }

    function test_setTreasuryRevertsWhenNotOwner() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        router.setTreasury(makeAddr("newTreasury"));
    }

    /*//////////////////////////////////////////////////////////////
                            ADMIN — pause / unpause
    //////////////////////////////////////////////////////////////*/

    function test_pauseAndUnpauseToggleState() public {
        assertFalse(router.paused());
        vm.prank(owner);
        router.pause();
        assertTrue(router.paused());
        vm.prank(owner);
        router.unpause();
        assertFalse(router.paused());
    }

    function test_pauseRevertsWhenNotOwner() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        router.pause();
    }

    function test_unpauseRevertsWhenNotOwner() public {
        vm.prank(owner);
        router.pause();
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        router.unpause();
    }

    function test_payNativeRevertsWhenPaused() public {
        _configureFeeds();
        uint256 id = _register();
        uint256 gross = router.quote(id, address(0), 20e8);
        vm.prank(owner);
        router.pause();

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.payNative{ value: gross }(id, 20e8, ORDER);
    }

    function test_payTokenRevertsWhenPaused() public {
        _configureFeeds();
        uint256 id = _register();
        vm.prank(owner);
        router.pause();

        usdc.mint(buyer, 100e6);
        vm.prank(buyer);
        usdc.approve(address(router), type(uint256).max);
        vm.prank(buyer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.payToken(id, address(usdc), 20e8, ORDER);
    }

    /*//////////////////////////////////////////////////////////////
                                claimRescue
    //////////////////////////////////////////////////////////////*/

    /// @dev Queue a rescue credit: a payout contract that rejects the push, paid once.
    function _queueRescue() internal returns (RescueClaimer claimer, uint256 net) {
        _configureFeeds();
        claimer = new RescueClaimer(router); // defaults to Mode.Reject
        vm.prank(merchantOwner);
        uint256 id =
            router.registerMerchant(address(claimer), feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);

        uint256 gross = router.quote(id, address(0), 20e8);
        (,, net) = _fees(gross);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        router.payNative{ value: gross }(id, 20e8, ORDER); // push to claimer fails → queued
        assertEq(router.rescue(address(claimer)), net);
    }

    function test_claimRescuePullsAndEmits() public {
        (RescueClaimer claimer, uint256 net) = _queueRescue();
        claimer.setMode(RescueClaimer.Mode.Accept);

        vm.expectEmit(true, false, false, true, address(router));
        emit Access0x1Router.Rescued(address(claimer), net);
        claimer.claim();

        assertEq(address(claimer).balance, net);
        assertEq(router.rescue(address(claimer)), 0); // credit cleared
        assertEq(address(router).balance, 0); // no custody left
    }

    function test_claimRescueRevertsWhenNothingOwed() public {
        vm.prank(buyer);
        vm.expectRevert(Access0x1Router.Access0x1__NothingToRescue.selector);
        router.claimRescue();
    }

    function test_claimRescueRevertsAndPreservesCreditOnReentry() public {
        (RescueClaimer claimer, uint256 net) = _queueRescue();
        claimer.setMode(RescueClaimer.Mode.Reenter);

        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__NativePushFailed.selector, address(claimer), net
            )
        );
        claimer.claim();

        // The re-entrant claim rolled back whole: the credit is intact, nothing double-paid.
        assertEq(router.rescue(address(claimer)), net);
        assertEq(address(claimer).balance, 0);
    }

    /*//////////////////////////////////////////////////////////////
                          UUPS UPGRADE / FREEZE
    //////////////////////////////////////////////////////////////*/

    function test_upgrade_preservesStateAndAddsFn() public {
        // Seed state under the v1 implementation: a registered merchant + a bumped fee + a treasury swap.
        uint256 id = _register();
        address newTreasury = makeAddr("newTreasury");
        vm.startPrank(owner);
        router.setPlatformFee(250);
        router.setTreasury(newTreasury);
        vm.stopPrank();

        // The owner (upgrade admin) upgrades the proxy to v2.
        address v2 = address(new Access0x1RouterV2());
        vm.prank(owner);
        UUPSUpgradeable(address(router)).upgradeToAndCall(v2, "");

        // The new logic is live...
        assertEq(Access0x1RouterV2(address(router)).version2Marker(), "v2");

        // ...and ALL prior state survived the implementation swap (storage lives in the proxy).
        (address p, address o,, uint16 fb, bool active,) = router.merchants(id);
        assertEq(p, payout);
        assertEq(o, merchantOwner);
        assertEq(fb, MERCHANT_FEE_BPS);
        assertTrue(active);
        assertEq(router.platformFeeBps(), 250);
        assertEq(router.platformTreasury(), newTreasury);
        assertEq(router.nextMerchantId(), 2);
        assertEq(router.owner(), owner); // upgrade admin unchanged
    }

    function test_upgrade_revertNonOwner() public {
        address v2 = address(new Access0x1RouterV2());
        // A non-owner cannot upgrade — _authorizeUpgrade is onlyOwner.
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger)
        );
        UUPSUpgradeable(address(router)).upgradeToAndCall(v2, "");
    }

    function test_freeze_renounceOwnershipBlocksUpgradeForever() public {
        // The owner renounces ownership: the upgrade admin becomes address(0).
        vm.prank(owner);
        OwnableUpgradeable(address(router)).renounceOwnership();
        assertEq(router.owner(), address(0));

        // With no owner, _authorizeUpgrade reverts for EVERYONE — the implementation is frozen forever.
        address v2 = address(new Access0x1RouterV2());
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, owner)
        );
        UUPSUpgradeable(address(router)).upgradeToAndCall(v2, "");
    }
}

/// @notice Test-only token whose `decimals()` REVERTS. Stands in for a hostile/broken ERC-20 that
///         griefs the pricing path; the router's `quote()` try/catch must convert this into the
///         typed `Access0x1__TokenNotAllowed`. Only `decimals()` is exercised (quote is view-only).
contract RevertingDecimalsToken {
    error DecimalsBlocked();

    function decimals() external pure returns (uint8) {
        revert DecimalsBlocked();
    }
}

/// @notice Test-only Chainlink feed that returns a valid + fresh round but REVERTS on `decimals()`.
///         Exercises the `feed.decimals()` half of the `quote()` try/catch hardening.
contract RevertingDecimalsFeed is AggregatorV3Interface {
    error DecimalsBlocked();

    int256 private immutable i_answer;

    constructor(int256 answer_) {
        i_answer = answer_;
    }

    function decimals() external pure override returns (uint8) {
        revert DecimalsBlocked();
    }

    function description() external pure override returns (string memory) {
        return "RevertingDecimalsFeed";
    }

    function version() external pure override returns (uint256) {
        return 0;
    }

    function getRoundData(uint80)
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, i_answer, block.timestamp, block.timestamp, 1);
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, i_answer, block.timestamp, block.timestamp, 1);
    }
}
