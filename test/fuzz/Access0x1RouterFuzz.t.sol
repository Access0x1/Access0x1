// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @title  Access0x1RouterFuzz
/// @author Access0x1
/// @notice STATELESS (per-function) property fuzzing for the router's public/external surface — the
///         Cyfrin "fuzz each function with `bound()`-constrained inputs and assert the per-call
///         invariants" tier. The handler-driven {Access0x1RouterInvariant} suite proves the SEQUENCE
///         properties (conservation across a campaign, isolation, the fee-cap squeeze); this file is
///         its single-call complement: every entry point is fuzzed in ISOLATION over its full accepted
///         input space, and each test asserts the money laws that must hold on that ONE call —
///           - net + platformFee + merchantFee == gross           (conservation, no wei created/burned)
///           - platformFee + merchantFee <= MAX_FEE_BPS of gross   (the buyer-protection fee cap)
///           - the platform cut always lands at the treasury        (a merchant can't redirect it)
///           - the router holds zero residual token / only-owed native (zero custody)
///         No state is carried between fuzz runs (a fresh router per run via `setUp`), so a failure
///         here localizes to a single call's arithmetic, not an emergent multi-call interaction.
/// @dev    Reuses the shared mocks ({MockUSDC} 6-dec, {MockV3Aggregator} 8-dec) — no new mock is
///         introduced. Time is warped to a fixed, fresh stamp so the feeds stay inside the OracleLib
///         staleness window across every fuzz run. The fee splits are recomputed INDEPENDENTLY of the
///         contract (mirroring the unit suite's `_fees`), so the assertions are a true oracle, never a
///         tautology against the contract's own math.
contract Access0x1RouterFuzz is Test, ProxyDeployer {
    Access0x1Router internal router;
    MockV3Aggregator internal nativeFeed; // ETH/USD, 8 dp
    MockV3Aggregator internal usdcFeed; // USDC/USD, 8 dp
    MockUSDC internal usdc; // 6 dp (the Arc-trap non-18 token)

    address internal owner = makeAddr("fz_owner");
    address internal treasury = makeAddr("fz_treasury");
    address internal merchantOwner = makeAddr("fz_merchantOwner");
    address internal payout = makeAddr("fz_payout");
    address internal feeRecipient = makeAddr("fz_feeRecipient");
    address internal buyer = makeAddr("fz_buyer");

    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1.00%
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.50%
    bytes32 internal constant ORDER = keccak256("fz_order");

    // The native feed is $2000/ETH and USDC is $1; both fixed so the fuzzed dimension is the USD
    // amount / config inputs, not the price (the price-conversion arithmetic is unit-tested).
    int256 internal constant NATIVE_PRICE_8 = 2000e8;
    int256 internal constant USDC_PRICE_8 = 1e8;

    function setUp() public {
        vm.warp(1_700_000_000); // fixed, fresh time so the feeds never go stale during a run
        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (owner, treasury, PLATFORM_FEE_BPS))
            )
        );
        nativeFeed = new MockV3Aggregator(8, NATIVE_PRICE_8);
        usdcFeed = new MockV3Aggregator(8, USDC_PRICE_8);
        usdc = new MockUSDC();
        vm.startPrank(owner);
        router.setPriceFeed(address(0), address(nativeFeed));
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();
    }

    /// @dev Register a merchant as `merchantOwner` with a chosen surcharge; returns its id.
    function _register(uint16 feeBps) internal returns (uint256 id) {
        vm.prank(merchantOwner);
        id = router.registerMerchant(payout, feeRecipient, feeBps, keccak256("fz_m"));
    }

    /// @dev The two-leg split, recomputed independently of the contract (floor each leg, like
    ///      `_splitFee`). Mirrors the unit suite so the property assertions are a real oracle.
    function _expectedFees(uint256 gross, uint16 mBps)
        internal
        pure
        returns (uint256 platformFee, uint256 merchantFee, uint256 net)
    {
        platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        merchantFee = gross * mBps / 10_000;
        net = gross - platformFee - merchantFee;
    }

    /*//////////////////////////////////////////////////////////////
                          registerMerchant (fuzz)
    //////////////////////////////////////////////////////////////*/

    /// @notice FUZZ registerMerchant over any accepted surcharge + non-zero payout + arbitrary
    ///         feeRecipient/nameHash. PROVES: a valid registration always succeeds, the id is
    ///         monotonic and never the 0 sentinel, and every field is stored verbatim with the caller
    ///         pinned as the immutable owner. The accepted space is `feeBps + platformFeeBps <=
    ///         MAX_FEE_BPS`, so the surcharge is bounded into that window.
    function testFuzz_registerMerchant_storesEveryFieldAndAssignsLiveId(
        address payoutAddr,
        address feeRecipientAddr,
        uint16 feeBps,
        bytes32 nameHash
    ) public {
        vm.assume(payoutAddr != address(0));
        // Bound the surcharge into the accepted window: combined fee must not exceed the cap.
        feeBps = uint16(bound(feeBps, 0, router.MAX_FEE_BPS() - PLATFORM_FEE_BPS));

        uint256 idBefore = router.nextMerchantId();
        vm.prank(merchantOwner);
        uint256 id = router.registerMerchant(payoutAddr, feeRecipientAddr, feeBps, nameHash);

        assertEq(id, idBefore, "id must be the pre-call nextMerchantId");
        assertGt(id, 0, "id must never be the unset 0 sentinel");
        assertEq(router.nextMerchantId(), idBefore + 1, "nextMerchantId must increment by one");

        (address p, address o, address fr, uint16 fb, bool active, bytes32 nh) =
            router.merchants(id);
        assertEq(p, payoutAddr, "payout stored verbatim");
        assertEq(o, merchantOwner, "caller is the immutable owner");
        assertEq(fr, feeRecipientAddr, "feeRecipient stored verbatim (zero allowed)");
        assertEq(fb, feeBps, "surcharge stored verbatim");
        assertTrue(active, "a fresh merchant is active");
        assertEq(nh, nameHash, "nameHash commitment stored verbatim");
    }

    /// @notice FUZZ registerMerchant's REVERT space: any surcharge whose combined fee exceeds the cap
    ///         must revert with the typed `FeeTooHigh` (no merchant can ever be configured past the
    ///         10% buyer-protection ceiling), and a zero payout always reverts `ZeroAddress`.
    function testFuzz_registerMerchant_revertsAboveCapOrZeroPayout(uint16 feeBps) public {
        uint16 maxFee = router.MAX_FEE_BPS();
        // Force the surcharge strictly above the room left under the platform fee.
        feeBps = uint16(bound(feeBps, maxFee - PLATFORM_FEE_BPS + 1, type(uint16).max));
        uint256 combined = uint256(feeBps) + PLATFORM_FEE_BPS;

        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__FeeTooHigh.selector, combined, maxFee)
        );
        router.registerMerchant(payout, feeRecipient, feeBps, keccak256("fz_over"));

        // Zero payout is rejected regardless of fee.
        vm.prank(merchantOwner);
        vm.expectRevert(Access0x1Router.Access0x1__ZeroAddress.selector);
        router.registerMerchant(address(0), feeRecipient, 0, keccak256("fz_zero"));
    }

    /*//////////////////////////////////////////////////////////////
                           updateMerchant (fuzz)
    //////////////////////////////////////////////////////////////*/

    /// @notice FUZZ updateMerchant over any accepted new config. PROVES the mutable fields change
    ///         exactly as supplied while the IMMUTABLE identity (owner + nameHash) is preserved —
    ///         the property the invariant suite's isolation canary rests on, asserted here per-call.
    function testFuzz_updateMerchant_changesMutableKeepsIdentity(
        address newPayout,
        address newFeeRecipient,
        uint16 newFeeBps,
        bool active
    ) public {
        vm.assume(newPayout != address(0));
        newFeeBps = uint16(bound(newFeeBps, 0, router.MAX_FEE_BPS() - PLATFORM_FEE_BPS));
        bytes32 originalName = keccak256("fz_identity");

        vm.prank(merchantOwner);
        uint256 id = router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, originalName);

        vm.prank(merchantOwner);
        router.updateMerchant(id, newPayout, newFeeRecipient, newFeeBps, active);

        (address p, address o, address fr, uint16 fb, bool a, bytes32 nh) = router.merchants(id);
        assertEq(p, newPayout, "payout updated");
        assertEq(fr, newFeeRecipient, "feeRecipient updated");
        assertEq(fb, newFeeBps, "surcharge updated");
        assertEq(a, active, "active toggled to the supplied value");
        assertEq(o, merchantOwner, "owner is immutable across an update");
        assertEq(nh, originalName, "nameHash is immutable across an update");
    }

    /// @notice FUZZ updateMerchant's authorization: ANY caller that is not the merchant owner must be
    ///         rejected with `NotMerchantOwner` — no surface lets a stranger rewrite another
    ///         merchant's payout (a funds-redirection attack).
    function testFuzz_updateMerchant_revertsForNonOwner(address caller) public {
        uint256 id = _register(MERCHANT_FEE_BPS);
        vm.assume(caller != merchantOwner);

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__NotMerchantOwner.selector, id, caller)
        );
        router.updateMerchant(id, payout, feeRecipient, MERCHANT_FEE_BPS, true);
    }

    /*//////////////////////////////////////////////////////////////
                               quote (fuzz)
    //////////////////////////////////////////////////////////////*/

    /// @notice FUZZ quote across the whole sane USD range, for both native and USDC. PROVES the
    ///         priced token amount is always positive (ceil rounding never yields 0 for a positive
    ///         USD ask) and is monotonic in USD — a larger ask never quotes a smaller token amount,
    ///         so no rounding seam lets a buyer underpay by asking for more.
    function testFuzz_quote_isPositiveAndMonotonic(uint256 usdAmount8) public view {
        usdAmount8 = bound(usdAmount8, 1, 1_000_000_000e8); // $1e-8 .. $1B

        uint256 qNative = router.quote(1, address(0), usdAmount8);
        uint256 qToken = router.quote(1, address(usdc), usdAmount8);
        assertGt(qNative, 0, "native quote must be > 0 for a positive USD ask");
        assertGt(qToken, 0, "token quote must be > 0 for a positive USD ask");

        // Monotonicity: doubling the ask never reduces the quote (guards against an overflow/round
        // seam that could make a bigger order cheaper). Bound the doubled ask to avoid 10**exp blowup.
        uint256 doubled = usdAmount8 <= 500_000_000e8 ? usdAmount8 * 2 : usdAmount8;
        assertGe(
            router.quote(1, address(usdc), doubled), qToken, "quote must be monotonic in USD ask"
        );
    }

    /// @notice FUZZ quote's reject space: any token that is neither native nor an allowlisted-with-feed
    ///         currency must revert `TokenNotAllowed`, and a zero USD ask always reverts `ZeroAmount` —
    ///         the pricing gate can never be coaxed into quoting an unpriceable asset or a free order.
    function testFuzz_quote_revertsForUnpriceableTokenOrZeroUsd(address token, uint256 usdAmount8)
        public
    {
        vm.assume(token != address(0) && token != address(usdc));
        usdAmount8 = bound(usdAmount8, 1, 1_000_000e8);

        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__TokenNotAllowed.selector, token)
        );
        router.quote(1, token, usdAmount8);

        // A zero ask is rejected before any feed read, for the allowlisted token too.
        vm.expectRevert(Access0x1Router.Access0x1__ZeroAmount.selector);
        router.quote(1, address(usdc), 0);
    }

    /*//////////////////////////////////////////////////////////////
                             payNative (fuzz)
    //////////////////////////////////////////////////////////////*/

    /// @notice FUZZ the native money path across any USD amount, any surcharge, and any non-negative
    ///         overpay. PROVES the four money laws hold on a SINGLE settlement:
    ///           1. conservation — net + platformFee + merchantFee == gross;
    ///           2. fee cap      — combined fee <= MAX_FEE_BPS of gross;
    ///           3. exact split  — net→payout, platform cut→treasury, surcharge→feeRecipient;
    ///           4. zero custody — the router keeps nothing, the buyer is debited exactly gross
    ///                             (any overpay refunded).
    function testFuzz_payNative_conservationSplitAndRefund(
        uint256 usdAmount8,
        uint16 mBps,
        uint256 overpay
    ) public {
        usdAmount8 = bound(usdAmount8, 1, 1_000_000e8); // $1e-8 .. $1M
        mBps = uint16(bound(mBps, 0, router.MAX_FEE_BPS() - PLATFORM_FEE_BPS));
        uint256 id = _register(mBps);

        uint256 gross = router.quote(id, address(0), usdAmount8);
        overpay = bound(overpay, 0, 100 ether);
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _expectedFees(gross, mBps);

        uint256 funding = gross + overpay;
        vm.deal(buyer, funding);
        vm.prank(buyer);
        router.payNative{ value: funding }(id, usdAmount8, ORDER);

        // 1. Conservation.
        assertEq(net + platformFee + merchantFee, gross, "net + fee must equal gross");
        // 2. Fee cap.
        assertLe(
            (platformFee + merchantFee) * 10_000,
            gross * router.MAX_FEE_BPS(),
            "combined fee must never exceed MAX_FEE_BPS of gross"
        );
        // 3. Exact split to the three sinks (EOAs accept native, so no rescue queueing here).
        assertEq(payout.balance, net, "net landed at payout");
        assertEq(treasury.balance, platformFee, "platform cut landed at treasury");
        assertEq(feeRecipient.balance, merchantFee, "surcharge landed at feeRecipient");
        // 4. Zero custody + the buyer paid exactly gross (overpay refunded).
        assertEq(address(router).balance, 0, "router holds no native (zero custody)");
        assertEq(buyer.balance, funding - gross, "buyer debited exactly gross; overpay refunded");
        assertEq(router.rescue(payout), 0, "no rescue queued for a happy native settlement");
    }

    /// @notice FUZZ underpayment: any value strictly below the in-tx quote must revert `Underpaid`
    ///         with the exact (required, provided) pair — the router never settles a short payment.
    function testFuzz_payNative_revertsWhenUnderpaid(uint256 usdAmount8, uint256 shortfall) public {
        usdAmount8 = bound(usdAmount8, 1, 1_000_000e8);
        uint256 id = _register(MERCHANT_FEE_BPS);
        uint256 gross = router.quote(id, address(0), usdAmount8);
        vm.assume(gross > 0);
        shortfall = bound(shortfall, 1, gross);
        uint256 provided = gross - shortfall;

        vm.deal(buyer, gross);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__Underpaid.selector, gross, provided)
        );
        router.payNative{ value: provided }(id, usdAmount8, ORDER);
    }

    /*//////////////////////////////////////////////////////////////
                              payToken (fuzz)
    //////////////////////////////////////////////////////////////*/

    /// @notice FUZZ the ERC-20 money path across any USD amount + any surcharge. PROVES the same four
    ///         money laws on a single token settlement, with the extra zero-residual assertion that is
    ///         the heart of the zero-custody claim: after the pull-in and the two-leg push, the router
    ///         holds EXACTLY zero of the settlement token.
    function testFuzz_payToken_conservationSplitAndZeroCustody(uint256 usdAmount8, uint16 mBps)
        public
    {
        usdAmount8 = bound(usdAmount8, 1, 1_000_000e8);
        mBps = uint16(bound(mBps, 0, router.MAX_FEE_BPS() - PLATFORM_FEE_BPS));
        uint256 id = _register(mBps);

        uint256 gross = router.quote(id, address(usdc), usdAmount8);
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _expectedFees(gross, mBps);

        usdc.mint(buyer, gross);
        vm.prank(buyer);
        usdc.approve(address(router), gross);
        vm.prank(buyer);
        router.payToken(id, address(usdc), usdAmount8, ORDER);

        // 1. Conservation.
        assertEq(net + platformFee + merchantFee, gross, "net + fee must equal gross");
        // 2. Fee cap.
        assertLe(
            (platformFee + merchantFee) * 10_000,
            gross * router.MAX_FEE_BPS(),
            "combined fee must never exceed MAX_FEE_BPS of gross"
        );
        // 3. Exact split.
        assertEq(usdc.balanceOf(payout), net, "net -> payout");
        assertEq(usdc.balanceOf(treasury), platformFee, "platform cut -> treasury");
        assertEq(usdc.balanceOf(feeRecipient), merchantFee, "surcharge -> feeRecipient");
        // 4. Zero residual token in the router + the buyer fully debited.
        assertEq(usdc.balanceOf(address(router)), 0, "router holds zero token (zero custody)");
        assertEq(usdc.balanceOf(buyer), 0, "buyer debited exactly gross");
    }

    /// @notice FUZZ payToken's allowlist gate: native (address(0)) is always rejected (it must go
    ///         through payNative), and any non-allowlisted token reverts `TokenNotAllowed` — the
    ///         pull-in path can never be pointed at an unpriced/unauthorized asset.
    function testFuzz_payToken_rejectsNativeAndUnallowlisted(address token) public {
        uint256 id = _register(MERCHANT_FEE_BPS);
        vm.assume(token != address(usdc)); // usdc IS allowlisted; everything else must reject

        // Native sentinel: rejected with TokenNotAllowed(address(0)).
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__TokenNotAllowed.selector, address(0))
        );
        router.payToken(id, address(0), 20e8, ORDER);

        // Any other non-allowlisted token: rejected in quote (allowlist + feed gate).
        vm.assume(token != address(0));
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__TokenNotAllowed.selector, token)
        );
        router.payToken(id, token, 20e8, ORDER);
    }

    /*//////////////////////////////////////////////////////////////
                          admin setters (fuzz)
    //////////////////////////////////////////////////////////////*/

    /// @notice FUZZ setPlatformFee: any value within the cap is accepted and stored; anything above
    ///         the cap reverts `FeeTooHigh`. The platform can never set a confiscatory rate, at any
    ///         input.
    function testFuzz_setPlatformFee_boundedByCap(uint16 newBps) public {
        uint16 maxFee = router.MAX_FEE_BPS();
        if (newBps <= maxFee) {
            vm.prank(owner);
            router.setPlatformFee(newBps);
            assertEq(router.platformFeeBps(), newBps, "accepted fee stored");
        } else {
            vm.prank(owner);
            vm.expectRevert(
                abi.encodeWithSelector(
                    Access0x1Router.Access0x1__FeeTooHigh.selector, newBps, maxFee
                )
            );
            router.setPlatformFee(newBps);
        }
    }

    /// @notice FUZZ the owner gate on every admin setter: a NON-owner caller is rejected on each of
    ///         setPlatformFee / setTreasury / setTokenAllowed / setPriceFeed / setPaymentLanes /
    ///         pause — there is no admin surface a stranger can reach.
    function testFuzz_adminSetters_onlyOwner(address caller) public {
        vm.assume(caller != owner);

        vm.startPrank(caller);
        vm.expectRevert(); // Ownable: OwnableUnauthorizedAccount(caller)
        router.setPlatformFee(200);
        vm.expectRevert();
        router.setTreasury(makeAddr("fz_newTreasury"));
        vm.expectRevert();
        router.setTokenAllowed(address(usdc), false);
        vm.expectRevert();
        router.setPriceFeed(address(usdc), address(0));
        vm.expectRevert();
        router.setPaymentLanes(address(0));
        vm.expectRevert();
        router.pause();
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                            claimRescue (fuzz)
    //////////////////////////////////////////////////////////////*/

    /// @notice FUZZ claimRescue against ANY caller with no queued credit: it always reverts
    ///         `NothingToRescue` and never sends value — there is no path to drain the router via a
    ///         claim you are not owed.
    function testFuzz_claimRescue_revertsWhenNothingOwed(address caller) public {
        // No settlement has queued anything, so every address is owed 0.
        assertEq(router.rescue(caller), 0, "precondition: caller owed nothing");
        vm.prank(caller);
        vm.expectRevert(Access0x1Router.Access0x1__NothingToRescue.selector);
        router.claimRescue();
    }
}
