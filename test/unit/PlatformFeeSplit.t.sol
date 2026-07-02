// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Escrow } from "../../src/Access0x1Escrow.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @notice THE platform-fee proof — the disclosed 1% (100 bps) rail fee is EXACTLY
///         `mulDiv(gross, platformFeeBps, 10_000)`, routed to the platform treasury (the deploy
///         wallet), with the remainder to the merchant, and `fee + net == gross` holding to the wei
///         on BOTH settle paths: the router's instant push (`payToken`/`payNative`) and the escrow's
///         conditional release (`confirm` → `_release`). One suite, one fixture, so the two paths
///         are proven against the SAME live router policy — the escrow never re-derives the rate, it
///         reads `platformFeeBps()`/`platformTreasury()` live, and the live-read tests prove a
///         mid-hold policy change is honored at release time.
///
///         Coverage demanded by the fee mandate:
///           - 1% default: exact `mulDiv(X, 100, 10_000)` → treasury, remainder → merchant;
///           - conservation: `fee + net == gross` (no dust lost, no double-count), contract ≈ 0 after;
///           - edges: `fee = 0`, `fee = MAX_FEE_BPS` (1000), tiny/odd grosses (1, 33, 99, 101, …)
///             where flooring bites;
///           - a merchant surcharge (`feeBps`) STACKED on top, with `platform + merchant` at exactly
///             `MAX_FEE_BPS` — three exact legs summing to gross — and the cap rejecting one bp more;
///           - fuzz over amount × platform bps × merchant bps on both paths.
contract PlatformFeeSplitTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    Access0x1Escrow internal escrow;

    /// @notice The deploy wallet the platform fee routes to — the same canonical mirror-deployer
    ///         address pinned by {DeployAll} (`CANONICAL_MIRROR_DEPLOYER`), asserted here verbatim so
    ///         the test breaks loudly if the fee destination ever silently drifts from the wallet
    ///         disclosed to integrators.
    address internal constant TREASURY = 0xA121e1eF31BbF0826aa67dc01e7977e80Af58D73;

    /// @notice The disclosed default platform fee: 1% = 100 bps.
    uint16 internal constant PLATFORM_FEE_BPS = 100;

    /// @notice Mirror of the contracts' private basis-point denominator (10_000 = 100%).
    uint256 internal constant FEE_DENOMINATOR = 10_000;

    address internal owner = makeAddr("owner"); // router admin
    address internal admin = makeAddr("admin"); // escrow upgrade admin
    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient"); // the merchant's surcharge leg
    address internal buyer = makeAddr("buyer");
    address internal seller = makeAddr("seller");

    MockV3Aggregator internal nativeFeed; // ETH/USD, 8 dp, $2000
    MockV3Aggregator internal usdcFeed; // USDC/USD, 8 dp, $1
    MockUSDC internal usdc; // 6 dp

    bytes32 internal constant ORDER = keccak256("order-1");
    uint64 internal deadline;

    function setUp() public {
        vm.warp(1_700_000_000); // fresh, non-zero clock: feeds stay inside the staleness window
        deadline = uint64(block.timestamp + 7 days);

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (owner, TREASURY, PLATFORM_FEE_BPS))
            )
        );
        escrow = Access0x1Escrow(
            deployProxy(
                address(new Access0x1Escrow()),
                abi.encodeCall(Access0x1Escrow.initialize, (admin, router))
            )
        );

        nativeFeed = new MockV3Aggregator(8, 2000e8); // $2000 ETH
        usdcFeed = new MockV3Aggregator(8, 1e8); // $1 USDC
        usdc = new MockUSDC();
        vm.startPrank(owner);
        router.setPriceFeed(address(0), address(nativeFeed));
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Register a merchant with surcharge `feeBps` (surcharge leg → `feeRecipient`).
    function _register(uint16 feeBps) internal returns (uint256 id) {
        vm.prank(merchantOwner);
        id = router.registerMerchant(payout, feeRecipient, feeBps, keccak256("merchant"));
    }

    /// @dev With the $1 USDC feed (8 dp) and the 6-dp token, `quote` = ceil(usd8 / 100) — so a USD
    ///      amount of `gross * 100` prices to EXACTLY `gross` token units. This is how the tests pin
    ///      arbitrary (odd, tiny) grosses on the router's pay path.
    function _usdForGross(uint256 gross) internal pure returns (uint256 usd8) {
        return gross * 100;
    }

    /// @dev Drive `payToken` for an exact `gross`, returning each leg's balance delta.
    function _payTokenAndDeltas(uint256 merchantId, uint256 gross)
        internal
        returns (uint256 dTreasury, uint256 dPayout, uint256 dFeeRecipient)
    {
        usdc.mint(buyer, gross);
        uint256 tBefore = usdc.balanceOf(TREASURY);
        uint256 pBefore = usdc.balanceOf(payout);
        uint256 fBefore = usdc.balanceOf(feeRecipient);

        vm.startPrank(buyer);
        usdc.approve(address(router), gross);
        router.payToken(merchantId, address(usdc), _usdForGross(gross), ORDER);
        vm.stopPrank();

        dTreasury = usdc.balanceOf(TREASURY) - tBefore;
        dPayout = usdc.balanceOf(payout) - pBefore;
        dFeeRecipient = usdc.balanceOf(feeRecipient) - fBefore;
    }

    /// @dev Open a token escrow of exactly `amount` against `merchantId` and release it (buyer
    ///      confirm), returning the treasury/seller balance deltas.
    function _escrowReleaseAndDeltas(uint256 merchantId, uint256 amount)
        internal
        returns (uint256 dTreasury, uint256 dSeller)
    {
        usdc.mint(buyer, amount);
        vm.startPrank(buyer);
        usdc.approve(address(escrow), amount);
        uint256 id = escrow.open(seller, merchantId, address(usdc), amount, address(0), deadline);
        vm.stopPrank();

        uint256 tBefore = usdc.balanceOf(TREASURY);
        uint256 sBefore = usdc.balanceOf(seller);
        vm.prank(buyer);
        escrow.confirm(id);

        dTreasury = usdc.balanceOf(TREASURY) - tBefore;
        dSeller = usdc.balanceOf(seller) - sBefore;
    }

    /*//////////////////////////////////////////////////////////////
                    ROUTER PATH — THE 1% DEFAULT, EXACTLY
    //////////////////////////////////////////////////////////////*/

    /// @notice At the disclosed default (100 bps → the deploy wallet), a token payment of gross X
    ///         splits to EXACTLY `mulDiv(X, 100, 10_000)` → treasury and the remainder → merchant,
    ///         with `fee + net == gross` and the router holding nothing after.
    function test_routerTokenSplit_onePercentExactly() public {
        uint256 merchantId = _register(0); // no surcharge: isolate the platform leg
        uint256 gross = 12_345_677; // odd on purpose — flooring must still conserve

        (uint256 dTreasury, uint256 dPayout, uint256 dFeeRecipient) =
            _payTokenAndDeltas(merchantId, gross);

        uint256 expectedFee = Math.mulDiv(gross, PLATFORM_FEE_BPS, FEE_DENOMINATOR);
        assertEq(dTreasury, expectedFee, "treasury leg != mulDiv(gross, 100, 10_000)");
        assertEq(dPayout, gross - expectedFee, "merchant leg != gross - fee");
        assertEq(dFeeRecipient, 0, "no surcharge configured, surcharge leg must be zero");
        assertEq(dTreasury + dPayout, gross, "fee + net != gross (dust lost or double-counted)");
        assertEq(usdc.balanceOf(address(router)), 0, "router must hold nothing after settlement");
    }

    /// @notice Same exactness on the native path: `payNative` splits the quoted gross wei-exactly.
    function test_routerNativeSplit_onePercentExactly() public {
        uint256 merchantId = _register(0);
        uint256 usd8 = 29e8; // $29
        uint256 gross = router.quote(merchantId, address(0), usd8);

        vm.deal(buyer, gross);
        uint256 tBefore = TREASURY.balance;
        uint256 pBefore = payout.balance;
        vm.prank(buyer);
        router.payNative{ value: gross }(merchantId, usd8, ORDER);

        uint256 expectedFee = Math.mulDiv(gross, PLATFORM_FEE_BPS, FEE_DENOMINATOR);
        assertEq(TREASURY.balance - tBefore, expectedFee, "native treasury leg inexact");
        assertEq(payout.balance - pBefore, gross - expectedFee, "native merchant leg inexact");
        assertEq(
            (TREASURY.balance - tBefore) + (payout.balance - pBefore),
            gross,
            "native fee + net != gross"
        );
        assertEq(address(router).balance, 0, "router must hold no native after settlement");
    }

    /// @notice The receipt event's fee/net figures equal the balance-verified split — the on-chain
    ///         disclosure an indexer reads is the same arithmetic the money follows (no double-count).
    function test_routerEmitsTheExactSplitItPays() public {
        uint256 merchantId = _register(0);
        uint256 gross = 1_000_000; // 1 USDC
        uint256 usd8 = _usdForGross(gross);
        uint256 expectedFee = Math.mulDiv(gross, PLATFORM_FEE_BPS, FEE_DENOMINATOR);

        usdc.mint(buyer, gross);
        vm.startPrank(buyer);
        usdc.approve(address(router), gross);
        vm.expectEmit(true, true, true, true, address(router));
        emit Access0x1Router.PaymentReceived(
            merchantId,
            buyer,
            address(usdc),
            gross,
            expectedFee,
            gross - expectedFee,
            usd8,
            ORDER,
            0
        );
        router.payToken(merchantId, address(usdc), usd8, ORDER);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                    ROUTER PATH — EDGES: 0, MAX, TINY/ODD
    //////////////////////////////////////////////////////////////*/

    /// @notice `platformFeeBps = 0`: the treasury gets nothing and the merchant nets the full gross.
    function test_routerSplit_feeZero() public {
        vm.prank(owner);
        router.setPlatformFee(0);
        uint256 merchantId = _register(0);
        uint256 gross = 12_345_677;

        (uint256 dTreasury, uint256 dPayout,) = _payTokenAndDeltas(merchantId, gross);
        assertEq(dTreasury, 0, "zero fee must route nothing to the treasury");
        assertEq(dPayout, gross, "zero fee must net the merchant the full gross");
    }

    /// @notice `platformFeeBps = MAX_FEE_BPS` (1000 = 10%, the hard cap): still exactly
    ///         `mulDiv(gross, 1000, 10_000)` → treasury, remainder → merchant, sum == gross.
    function test_routerSplit_feeAtMax() public {
        uint16 maxBps = router.MAX_FEE_BPS();
        vm.prank(owner);
        router.setPlatformFee(maxBps);
        uint256 merchantId = _register(0);
        uint256 gross = 12_345_677;

        (uint256 dTreasury, uint256 dPayout,) = _payTokenAndDeltas(merchantId, gross);
        uint256 expectedFee = Math.mulDiv(gross, maxBps, FEE_DENOMINATOR);
        assertEq(dTreasury, expectedFee, "max-fee treasury leg inexact");
        assertEq(dPayout, gross - expectedFee, "max-fee merchant leg inexact");
        assertEq(dTreasury + dPayout, gross, "max-fee split must conserve gross");
    }

    /// @notice Tiny/odd grosses where flooring bites (1, 33, 99 floor the 1% fee to 0; 101, 9_999,
    ///         10_001 floor mid-digit): each leg is the exact `mulDiv`, and conservation holds — the
    ///         rounding remainder stays with the MERCHANT, never vanishes, never double-pays.
    function test_routerSplit_tinyAndOddAmountsConserveExactly() public {
        uint256 merchantId = _register(0);
        uint256[7] memory grosses = [uint256(1), 33, 99, 101, 9_999, 10_001, 1_000_007];

        for (uint256 i = 0; i < grosses.length; i++) {
            uint256 gross = grosses[i];
            (uint256 dTreasury, uint256 dPayout,) = _payTokenAndDeltas(merchantId, gross);
            uint256 expectedFee = Math.mulDiv(gross, PLATFORM_FEE_BPS, FEE_DENOMINATOR);
            assertEq(dTreasury, expectedFee, "odd-gross treasury leg inexact");
            assertEq(dPayout, gross - expectedFee, "odd-gross merchant leg inexact");
            assertEq(dTreasury + dPayout, gross, "odd-gross split must conserve gross");
        }
        assertEq(usdc.balanceOf(address(router)), 0, "no dust may accumulate in the router");
    }

    /*//////////////////////////////////////////////////////////////
                ROUTER PATH — MERCHANT SURCHARGE STACKED ON TOP
    //////////////////////////////////////////////////////////////*/

    /// @notice A merchant surcharge stacked on the platform fee at EXACTLY the combined cap
    ///         (100 + 900 = MAX_FEE_BPS): three exact legs — platform → treasury, surcharge →
    ///         the merchant's fee recipient, net → payout — summing to gross with no dust.
    function test_routerSplit_merchantSurchargeStackedToExactCap() public {
        uint16 surchargeBps = router.MAX_FEE_BPS() - PLATFORM_FEE_BPS; // 900
        uint256 merchantId = _register(surchargeBps);
        uint256 gross = 12_345_677;

        (uint256 dTreasury, uint256 dPayout, uint256 dFeeRecipient) =
            _payTokenAndDeltas(merchantId, gross);

        uint256 platformFee = Math.mulDiv(gross, PLATFORM_FEE_BPS, FEE_DENOMINATOR);
        uint256 merchantFee = Math.mulDiv(gross, surchargeBps, FEE_DENOMINATOR);
        assertEq(dTreasury, platformFee, "platform leg inexact under a stacked surcharge");
        assertEq(dFeeRecipient, merchantFee, "surcharge leg != mulDiv(gross, feeBps, 10_000)");
        assertEq(dPayout, gross - platformFee - merchantFee, "net leg inexact under stacking");
        assertEq(dTreasury + dFeeRecipient + dPayout, gross, "three-leg split must conserve gross");
    }

    /// @notice One bp past the combined cap is rejected at registration — the stack can never be
    ///         configured beyond `MAX_FEE_BPS`.
    function test_routerRejectsSurchargeBeyondCombinedCap() public {
        uint256 oneOver = uint256(router.MAX_FEE_BPS()) - PLATFORM_FEE_BPS + 1;
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__FeeTooHigh.selector,
                oneOver + PLATFORM_FEE_BPS,
                router.MAX_FEE_BPS()
            )
        );
        router.registerMerchant(payout, feeRecipient, uint16(oneOver), keccak256("m"));
    }

    /// @notice Fuzz the whole router surface: any gross × any platform bps × any surcharge within
    ///         the cap — every leg is the exact `mulDiv` and the three legs conserve gross.
    /// @param grossSeed     Fuzzed gross token amount.
    /// @param platformSeed  Fuzzed platform fee bps.
    /// @param surchargeSeed Fuzzed merchant surcharge bps.
    function testFuzz_routerSplit_exactForAnyConfig(
        uint256 grossSeed,
        uint16 platformSeed,
        uint16 surchargeSeed
    ) public {
        uint256 gross = bound(grossSeed, 1, 1e13); // up to 10M USDC (6 dp)
        uint16 pBps = uint16(bound(platformSeed, 0, router.MAX_FEE_BPS()));
        uint16 mBps = uint16(bound(surchargeSeed, 0, router.MAX_FEE_BPS() - pBps));

        vm.prank(owner);
        router.setPlatformFee(pBps);
        uint256 merchantId = _register(mBps);

        (uint256 dTreasury, uint256 dPayout, uint256 dFeeRecipient) =
            _payTokenAndDeltas(merchantId, gross);

        assertEq(dTreasury, Math.mulDiv(gross, pBps, FEE_DENOMINATOR), "fuzz: platform leg");
        assertEq(dFeeRecipient, Math.mulDiv(gross, mBps, FEE_DENOMINATOR), "fuzz: surcharge leg");
        assertEq(dPayout, gross - dTreasury - dFeeRecipient, "fuzz: net leg");
        assertEq(dTreasury + dFeeRecipient + dPayout, gross, "fuzz: conservation");
        assertEq(usdc.balanceOf(address(router)), 0, "fuzz: router must hold nothing");
    }

    /*//////////////////////////////////////////////////////////////
                    ESCROW PATH — THE SAME SPLIT, LIVE-READ
    //////////////////////////////////////////////////////////////*/

    /// @notice The escrow release mirrors the router's split exactly: at the 1% default, a held X
    ///         releases `mulDiv(X, 100, 10_000)` → the SAME treasury and the remainder → the seller,
    ///         `fee + net == amount`, and the escrow holds nothing after. The merchant surcharge is
    ///         NOT applied on this path (the platform leg only) — asserted, not assumed.
    function test_escrowReleaseSplit_onePercentExactly() public {
        uint256 merchantId = _register(900); // surcharge configured, must be IGNORED by the escrow
        uint256 amount = 12_345_677;

        uint256 fBefore = usdc.balanceOf(feeRecipient);
        uint256 pBefore = usdc.balanceOf(payout);
        (uint256 dTreasury, uint256 dSeller) = _escrowReleaseAndDeltas(merchantId, amount);

        uint256 expectedFee = Math.mulDiv(amount, PLATFORM_FEE_BPS, FEE_DENOMINATOR);
        assertEq(dTreasury, expectedFee, "escrow treasury leg != mulDiv(amount, 100, 10_000)");
        assertEq(dSeller, amount - expectedFee, "escrow seller leg != amount - fee");
        assertEq(dTreasury + dSeller, amount, "escrow fee + net != amount");
        assertEq(usdc.balanceOf(feeRecipient), fBefore, "escrow must not pay the surcharge leg");
        assertEq(usdc.balanceOf(payout), pBefore, "escrow pays the seller, not the merchant payout");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow must hold nothing after release");
    }

    /// @notice The escrow's native release splits wei-exactly to the same treasury.
    function test_escrowNativeReleaseSplit_onePercentExactly() public {
        uint256 merchantId = _register(0);
        uint256 amount = 1 ether + 1 wei; // odd wei so flooring bites

        vm.deal(buyer, amount);
        vm.prank(buyer);
        uint256 id = escrow.open{ value: amount }(
            seller, merchantId, address(0), amount, address(0), deadline
        );

        uint256 tBefore = TREASURY.balance;
        uint256 sBefore = seller.balance;
        vm.prank(buyer);
        escrow.confirm(id);

        uint256 expectedFee = Math.mulDiv(amount, PLATFORM_FEE_BPS, FEE_DENOMINATOR);
        assertEq(TREASURY.balance - tBefore, expectedFee, "escrow native treasury leg inexact");
        assertEq(seller.balance - sBefore, amount - expectedFee, "escrow native seller leg inexact");
        assertEq(address(escrow).balance, 0, "escrow must hold no native after release");
    }

    /// @notice Escrow edges: `fee = 0` (all to the seller) and `fee = MAX_FEE_BPS` (exact 10%),
    ///         plus the tiny/odd amounts where the 1% fee floors to zero — each leg exact, each
    ///         release conserving the held amount.
    function test_escrowReleaseSplit_edgesAndOddAmounts() public {
        uint256 merchantId = _register(0);

        // fee = 0
        vm.prank(owner);
        router.setPlatformFee(0);
        (uint256 dT0, uint256 dS0) = _escrowReleaseAndDeltas(merchantId, 12_345_677);
        assertEq(dT0, 0, "zero fee must route nothing to the treasury");
        assertEq(dS0, 12_345_677, "zero fee must release the full amount to the seller");

        // fee = MAX_FEE_BPS
        uint16 maxBps = router.MAX_FEE_BPS();
        vm.prank(owner);
        router.setPlatformFee(maxBps);
        (uint256 dTMax, uint256 dSMax) = _escrowReleaseAndDeltas(merchantId, 12_345_677);
        assertEq(dTMax, Math.mulDiv(12_345_677, maxBps, FEE_DENOMINATOR), "max-fee leg inexact");
        assertEq(dTMax + dSMax, 12_345_677, "max-fee release must conserve the amount");

        // tiny/odd amounts back at the 1% default
        vm.prank(owner);
        router.setPlatformFee(PLATFORM_FEE_BPS);
        uint256[6] memory amounts = [uint256(1), 33, 99, 101, 9_999, 10_001];
        for (uint256 i = 0; i < amounts.length; i++) {
            (uint256 dT, uint256 dS) = _escrowReleaseAndDeltas(merchantId, amounts[i]);
            assertEq(
                dT,
                Math.mulDiv(amounts[i], PLATFORM_FEE_BPS, FEE_DENOMINATOR),
                "odd-amount escrow treasury leg inexact"
            );
            assertEq(dT + dS, amounts[i], "odd-amount escrow release must conserve");
        }
        assertEq(usdc.balanceOf(address(escrow)), 0, "no dust may accumulate in the escrow");
    }

    /// @notice The escrow reads the router's policy LIVE at release, never a snapshot at open: a
    ///         fee/treasury change made WHILE the deposit is held is what the release settles with.
    function test_escrowReadsFeeAndTreasuryLiveAtRelease() public {
        uint256 merchantId = _register(0);
        uint256 amount = 1_000_000; // 1 USDC

        usdc.mint(buyer, amount);
        vm.startPrank(buyer);
        usdc.approve(address(escrow), amount);
        uint256 id = escrow.open(seller, merchantId, address(usdc), amount, address(0), deadline);
        vm.stopPrank();

        // Mid-hold, the platform changes BOTH the rate and the destination.
        address newTreasury = makeAddr("newTreasury");
        vm.startPrank(owner);
        router.setPlatformFee(250); // 2.5%
        router.setTreasury(newTreasury);
        vm.stopPrank();

        vm.prank(buyer);
        escrow.confirm(id);

        uint256 expectedFee = Math.mulDiv(amount, 250, FEE_DENOMINATOR);
        assertEq(usdc.balanceOf(newTreasury), expectedFee, "release must use the LIVE rate + dest");
        assertEq(usdc.balanceOf(TREASURY), 0, "the old treasury must receive nothing");
        assertEq(usdc.balanceOf(seller), amount - expectedFee, "seller nets against the live rate");
    }

    /// @notice Fuzz the escrow release: any held amount × any platform bps — the fee leg is the
    ///         exact `mulDiv`, the seller nets the remainder, and the two legs conserve the amount.
    /// @param amountSeed   Fuzzed held token amount.
    /// @param platformSeed Fuzzed platform fee bps.
    function testFuzz_escrowReleaseSplit_exactForAnyConfig(uint256 amountSeed, uint16 platformSeed)
        public
    {
        uint256 amount = bound(amountSeed, 1, 1e13);
        uint16 pBps = uint16(bound(platformSeed, 0, router.MAX_FEE_BPS()));
        vm.prank(owner);
        router.setPlatformFee(pBps);
        uint256 merchantId = _register(0);

        (uint256 dTreasury, uint256 dSeller) = _escrowReleaseAndDeltas(merchantId, amount);

        assertEq(dTreasury, Math.mulDiv(amount, pBps, FEE_DENOMINATOR), "fuzz: escrow fee leg");
        assertEq(dSeller, amount - dTreasury, "fuzz: escrow seller leg");
        assertEq(dTreasury + dSeller, amount, "fuzz: escrow conservation");
        assertEq(usdc.balanceOf(address(escrow)), 0, "fuzz: escrow must hold nothing");
    }
}
