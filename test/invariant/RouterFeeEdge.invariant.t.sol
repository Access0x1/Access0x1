// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/*//////////////////////////////////////////////////////////////
                        BOUNDARY-DECIMAL TOKENS
//////////////////////////////////////////////////////////////*/

/// @notice A 0-decimal ERC-20. With a $1.00 feed, `quote(usd = 1e8)` rounds UP to exactly **1 wei**
///         of token — the smallest non-zero gross the router can ever settle. This is the 1-wei-gross
///         boundary: at a 1-wei gross both `Math.mulDiv` fee legs floor to 0, so the whole gross
///         becomes `net`, and we must still see `net + fee == gross` (with fee == 0) hold exactly.
contract ZeroDecimalToken is ERC20 {
    constructor() ERC20("ZeroDec", "ZRO") { }

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice A 36-decimal ERC-20 — well past USDC's 6 and ETH's 18. With an 8-decimal feed this drives
///         `quote`'s `10 ** (feedDecimals + tokenDecimals) == 10 ** 44` scaling factor, the high end of
///         the conversion range, producing a very large gross. The point: the fee split + conservation
///         identity hold for a max-decimals token exactly as they do for 6-dec USDC, with no overflow
///         (`Math.mulDiv` keeps full 512-bit precision).
contract MaxDecimalToken is ERC20 {
    constructor() ERC20("MaxDec", "MAX") { }

    function decimals() public pure override returns (uint8) {
        return 36;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/*//////////////////////////////////////////////////////////////
                              HANDLER
//////////////////////////////////////////////////////////////*/

/// @notice The actor that hammers the router's two-leg `_splitFee` at its BOUNDARY values — driven
///         through the LIVE pay paths (`payNative`/`payToken`), never against a mirror. It deliberately
///         parks merchants at the extremes the generic router invariant only samples: a 0-bps merchant,
///         a merchant pinned at the MAX_FEE_BPS cap, and the platform-fee "squeeze" (raising the
///         platform cut so an existing merchant surcharge would push the combined fee over the cap).
///         Those configs are then settled at the value boundaries — a 1-wei gross (0-decimal token),
///         normal 6-dec USDC, native, and a max-decimals (36-dec) token.
/// @dev    Like {RouterHandler}, every action is written to NEVER revert (the suite runs
///         `fail_on_revert = true`): inputs are bounded and preconditions early-return. The handler is
///         the platform owner (to move the platform fee + exercise the squeeze) and every merchant's
///         owner (to update them). Fee + net sinks are DISJOINT dedicated addresses so the balance
///         delta a sink sees provably came from the router — that is what makes the per-call
///         `net + fee == gross` and `Σfee ≤ MAX_FEE_BPS · gross` checks exact. All three settlement
///         tokens here PUSH cleanly (EOAs / accepting payouts), so native never queues to `rescue`;
///         the rescue path is already covered by {RouterHandler}, so this suite stays focused on the
///         fee-edge arithmetic.
contract RouterFeeEdgeHandler is Test {
    using Math for uint256;

    uint16 internal constant MAX_FEE_BPS = 1000;
    uint256 internal constant FEE_DENOMINATOR = 10_000;
    uint256 internal constant USD_DECIMALS = 8;

    Access0x1Router public immutable router;
    address public immutable treasury;

    // The three settlement assets that span the decimal range: native (18), USDC (6), the two
    // boundary-decimal tokens (0 and 36).
    MockUSDC public immutable usdc;
    ZeroDecimalToken public immutable zeroDec; // 1-wei-gross boundary
    MaxDecimalToken public immutable maxDec; // max-decimals boundary

    // Disjoint net + fee sinks (EOAs, so every push succeeds — no rescue, no fee-on-transfer).
    address public immutable payout;
    address public immutable feeRecipient;

    // The three boundary merchants: feeBps == 0, feeBps == MAX (under a 0 platform fee), and a
    // "squeeze" merchant whose surcharge gets clamped once the platform fee is raised.
    uint256 public zeroFeeMerchant; // merchant surcharge = 0 bps
    uint256 public maxFeeMerchant; // merchant surcharge = MAX_FEE_BPS bps (platform at 0)
    uint256 public squeezeMerchant; // merchant surcharge that the platform-fee squeeze can clamp

    // ---- ghost accounting (the spec the contract is checked against) ----
    bool public conservationHeld = true; // AND of "net + platformFee + merchantFee == gross"
    bool public feeCapRespected = true; // AND of "platformFee + merchantFee ≤ MAX_FEE_BPS · gross"
    uint256 public payCount; // settlements driven — telemetry (`forge test -vv` / call summary)
    uint256 public oneWeiGrossSeen; // 1-wei grosses settled — telemetry for the smallest boundary

    constructor(
        Access0x1Router router_,
        MockUSDC usdc_,
        ZeroDecimalToken zeroDec_,
        MaxDecimalToken maxDec_,
        address treasury_,
        uint256 zeroFeeMerchant_,
        uint256 maxFeeMerchant_,
        uint256 squeezeMerchant_
    ) {
        router = router_;
        usdc = usdc_;
        zeroDec = zeroDec_;
        maxDec = maxDec_;
        treasury = treasury_;
        zeroFeeMerchant = zeroFeeMerchant_;
        maxFeeMerchant = maxFeeMerchant_;
        squeezeMerchant = squeezeMerchant_;
        payout = makeAddr("edge_payout");
        feeRecipient = makeAddr("edge_feeRecipient");
    }

    /// @notice Finish the Ownable2Step handover from the test (called once in setUp).
    function acceptRouterOwnership() external {
        router.acceptOwnership();
    }

    /*//////////////////////////////////////////////////////////////
                          ACTION HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Resolve one of the three boundary merchants from a seed. All three share the same disjoint
    ///      `payout` + `feeRecipient`, so the fee leg always lands at `feeRecipient` and the net at
    ///      `payout`, and the balance-delta checks below stay exact.
    function _pickMerchant(uint256 seed) internal view returns (uint256 id) {
        uint256 which = seed % 3;
        if (which == 0) return zeroFeeMerchant;
        if (which == 1) return maxFeeMerchant;
        return squeezeMerchant;
    }

    /// @dev The platform leg the router will charge: `platformFeeBps` of gross, floored — never
    ///      squeezed (only the MERCHANT surcharge is clamped). Recomputed independently of the contract.
    function _expectedPlatformFee(uint256 gross) internal view returns (uint256) {
        return Math.mulDiv(gross, router.platformFeeBps(), FEE_DENOMINATOR);
    }

    /// @dev The effective merchant surcharge AFTER the buyer-protection clamp (mirrors `_splitFee`):
    ///      if `platformFeeBps + feeBps > MAX_FEE_BPS`, the surcharge is squeezed to the cap remainder.
    function _expectedMerchantFee(uint256 id, uint256 gross) internal view returns (uint256) {
        (,,, uint16 feeBps,,) = router.merchants(id);
        uint256 pBps = router.platformFeeBps();
        uint256 mBps = feeBps;
        if (pBps + mBps > MAX_FEE_BPS) mBps = pBps >= MAX_FEE_BPS ? 0 : MAX_FEE_BPS - pBps;
        return Math.mulDiv(gross, mBps, FEE_DENOMINATOR);
    }

    /// @dev Fold one settlement into the two edge invariants, using the INDEPENDENT recompute above.
    ///      `feeDelta` is what the router actually delivered to the fee sinks (treasury + feeRecipient);
    ///      `gross` is what went in. Asserts both the conservation identity and the hard fee cap, and
    ///      cross-checks the delivered fee against the expected split so a wrong-leg bug is caught too.
    function _record(uint256 id, uint256 gross, uint256 feeDelta, uint256 netDelta) internal {
        uint256 expPlatform = _expectedPlatformFee(gross);
        uint256 expMerchant = _expectedMerchantFee(id, gross);
        uint256 expFee = expPlatform + expMerchant;

        // Conservation: every wei in is either fee or net — the router neither mints nor burns.
        if (netDelta + feeDelta != gross) conservationHeld = false;
        // The router charged exactly the independently-recomputed fee (right legs, right clamp).
        if (feeDelta != expFee) conservationHeld = false;
        // Hard buyer-protection cap: the total fee is never more than MAX_FEE_BPS of gross. Compared
        // by cross-multiplication to avoid any division rounding in the bound itself.
        if (feeDelta * FEE_DENOMINATOR > gross * MAX_FEE_BPS) feeCapRespected = false;

        if (gross == 1) oneWeiGrossSeen++;
        payCount++;
    }

    /*//////////////////////////////////////////////////////////////
                                ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Settle a native payment against a boundary merchant, at a USD amount spanning the small
    ///         end ($0.01) up to $1M. ETH/USD is $2000, so even $0.01 yields a many-wei gross; the
    ///         1-wei-gross boundary itself is exercised by the 0-decimal token in `payTokenEdge`.
    function payNativeEdge(uint256 idSeed, uint256 usdSeed) external {
        uint256 id = _pickMerchant(idSeed);
        uint256 usd = bound(usdSeed, 1e6, 1_000_000e8); // $0.01 .. $1,000,000
        uint256 gross = router.quote(id, address(0), usd);
        if (gross == 0) return;

        uint256 feeBefore = treasury.balance + feeRecipient.balance;
        uint256 netBefore = payout.balance;

        vm.deal(address(this), gross);
        router.payNative{ value: gross }(id, usd, bytes32(usd));

        uint256 feeDelta = (treasury.balance + feeRecipient.balance) - feeBefore;
        uint256 netDelta = payout.balance - netBefore;
        _record(id, gross, feeDelta, netDelta);
    }

    /// @notice Settle a token payment against a boundary merchant in one of the three decimal regimes:
    ///         0-dec (the 1-wei-gross boundary), 6-dec USDC, or 36-dec (the max-decimals boundary). The
    ///         USD floor is $1.00 so the 0-decimal token's `quote` rounds UP to exactly 1 wei.
    function payTokenEdge(uint256 idSeed, uint256 usdSeed, uint256 tokenSeed) external {
        uint256 id = _pickMerchant(idSeed);
        address token = _pickToken(tokenSeed);
        uint256 usd = bound(usdSeed, 1e8, 1_000_000e8); // $1.00 .. $1,000,000
        uint256 gross = router.quote(id, token, usd);
        if (gross == 0) return;

        uint256 feeBefore = _balOf(token, treasury) + _balOf(token, feeRecipient);
        uint256 netBefore = _balOf(token, payout);

        _mintToken(token, address(this), gross);
        ERC20(token).approve(address(router), gross);
        router.payToken(id, token, usd, bytes32(usd));

        uint256 feeDelta = (_balOf(token, treasury) + _balOf(token, feeRecipient)) - feeBefore;
        uint256 netDelta = _balOf(token, payout) - netBefore;
        _record(id, gross, feeDelta, netDelta);
    }

    /// @notice Move the platform fee across its whole range [0, MAX_FEE_BPS]. This is what drives the
    ///         `_splitFee` SQUEEZE: once the platform fee plus the squeeze-merchant's surcharge exceeds
    ///         the cap, the merchant leg is clamped — and the two edge invariants must still hold.
    function setPlatformFee(uint16 newBps) external {
        router.setPlatformFee(uint16(bound(newBps, 0, MAX_FEE_BPS)));
    }

    /*//////////////////////////////////////////////////////////////
                              TOKEN UTILS
    //////////////////////////////////////////////////////////////*/

    function _pickToken(uint256 seed) internal view returns (address) {
        uint256 which = seed % 3;
        if (which == 0) return address(zeroDec); // 1-wei-gross boundary
        if (which == 1) return address(usdc); // the real 6-dec regime
        return address(maxDec); // max-decimals boundary
    }

    function _balOf(address token, address who) internal view returns (uint256) {
        return ERC20(token).balanceOf(who);
    }

    function _mintToken(address token, address to, uint256 amount) internal {
        if (token == address(usdc)) usdc.mint(to, amount);
        else if (token == address(zeroDec)) zeroDec.mint(to, amount);
        else maxDec.mint(to, amount);
    }
}

/*//////////////////////////////////////////////////////////////
                         INVARIANT SUITE
//////////////////////////////////////////////////////////////*/

/// @notice Two-leg `_splitFee` boundary invariants — the security floor for the fee math, pinned at the
///         EDGE configs the generic {Access0x1RouterInvariant} only samples. Driven through the LIVE
///         router (not a mirror — the symbolic {FeeSplitSymbolic} proves the formula; this proves the
///         shipped contract obeys it at the boundaries), with every property asserted against an
///         INDEPENDENT ghost recompute in the handler.
///
///         Boundaries covered, all under one fuzzer:
///           • fee == 0          — a 0-bps merchant under a 0-bps platform fee (the whole gross is net).
///           • fee == MAX_FEE_BPS — a merchant pinned at the 10% cap; the platform-fee squeeze.
///           • 1-wei gross        — the 0-decimal token (`quote($1) == 1`), where both fee legs floor to 0.
///           • max-decimals token — a 36-decimal token, the high end of the `quote` scaling range.
///
/// @dev    Run at the configured invariant runs × depth (≥ 4096 calls under the CI profile:
///         `runs = 256 · depth = 128`, `fail_on_revert = true` — every handler action is revert-free).
contract RouterFeeEdgeInvariant is StdInvariant, Test, ProxyDeployer {
    Access0x1Router internal router;
    RouterFeeEdgeHandler internal handler;
    MockV3Aggregator internal nativeFeed;
    MockV3Aggregator internal usdFeed; // shared $1.00 feed for usdc / zeroDec / maxDec
    MockUSDC internal usdc;
    ZeroDecimalToken internal zeroDec;
    MaxDecimalToken internal maxDec;

    address internal treasury = makeAddr("edge_treasury");
    address internal merchantOwner = makeAddr("edge_merchantOwner");
    address internal edgePayout = makeAddr("edge_payout"); // mirrors the handler's makeAddr seed
    address internal edgeFeeRecipient = makeAddr("edge_feeRecipient");

    uint16 internal constant MAX_FEE_BPS = 1000;

    function setUp() public {
        vm.warp(1_700_000_000); // fixed, fresh time; the fuzzer holds it constant so feeds stay live

        nativeFeed = new MockV3Aggregator(8, 2000e8); // ETH/USD = $2000
        usdFeed = new MockV3Aggregator(8, 1e8); // $1.00 — used for all three ERC-20s
        usdc = new MockUSDC();
        zeroDec = new ZeroDecimalToken();
        maxDec = new MaxDecimalToken();

        // Start the platform fee at 0 so the MAX_FEE_BPS merchant can be registered at the full cap;
        // the handler later raises the platform fee to drive the squeeze on the third merchant.
        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (address(this), treasury, 0))
            )
        );

        // Allowlist + price the native coin and all three boundary-decimal tokens.
        router.setPriceFeed(address(0), address(nativeFeed));
        _allow(address(usdc));
        _allow(address(zeroDec));
        _allow(address(maxDec));

        // The three boundary merchants — all paying out to the SAME disjoint payout / feeRecipient so
        // the handler's balance-delta accounting is exact.
        vm.startPrank(merchantOwner);
        uint256 zeroFeeMerchant =
            router.registerMerchant(edgePayout, edgeFeeRecipient, 0, keccak256("edge_zeroFee"));
        uint256 maxFeeMerchant = router.registerMerchant(
            edgePayout, edgeFeeRecipient, MAX_FEE_BPS, keccak256("edge_maxFee")
        );
        // A mid surcharge: harmless at platform fee 0, but the moment the handler raises the platform
        // fee above `MAX_FEE_BPS - 600` the combined fee crosses the cap and `_splitFee` squeezes it.
        uint256 squeezeMerchant =
            router.registerMerchant(edgePayout, edgeFeeRecipient, 600, keccak256("edge_squeeze"));
        vm.stopPrank();

        handler = new RouterFeeEdgeHandler(
            router,
            usdc,
            zeroDec,
            maxDec,
            treasury,
            zeroFeeMerchant,
            maxFeeMerchant,
            squeezeMerchant
        );
        router.transferOwnership(address(handler)); // Ownable2Step handover to the actor
        handler.acceptRouterOwnership();

        // Drive only the three state-changing actions (exclude the one-shot accept + view helpers,
        // which would revert and trip fail_on_revert).
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = RouterFeeEdgeHandler.payNativeEdge.selector;
        selectors[1] = RouterFeeEdgeHandler.payTokenEdge.selector;
        selectors[2] = RouterFeeEdgeHandler.setPlatformFee.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @dev Allowlist a token and point its feed at the shared $1.00 aggregator.
    function _allow(address token) internal {
        router.setTokenAllowed(token, true);
        router.setPriceFeed(token, address(usdFeed));
    }

    /// @notice Edge invariant 1 — conservation at every boundary: across every settlement the fuzzer
    ///         drove (fee 0, fee MAX, 1-wei gross, 36-dec token, under the platform-fee squeeze),
    ///         `net + platformFee + merchantFee == gross` held exactly AND the fee delivered matched the
    ///         independently-recomputed split. No wei is created or destroyed at any edge.
    function invariant_edgeConservation() public view {
        assertTrue(handler.conservationHeld(), "net + fee == gross must hold at every boundary");
    }

    /// @notice Edge invariant 2 — the hard fee cap holds at the boundaries: no settlement ever charged
    ///         more than `MAX_FEE_BPS` of gross, including a merchant pinned at the cap and the squeeze
    ///         where a raised platform fee would otherwise push the combined fee over it.
    function invariant_edgeFeeCap() public view {
        assertTrue(
            handler.feeCapRespected(),
            "platform + merchant fee must never exceed MAX_FEE_BPS of gross"
        );
    }

    /*//////////////////////////////////////////////////////////////
                CONCRETE BOUNDARY PROBES (under forge test)
    //////////////////////////////////////////////////////////////*/

    // These deterministic cases pin each named boundary so the suite never passes vacuously (an
    // invariant evaluated before the fuzzer happens to settle that edge is not proof the edge holds).
    // They drive the LIVE router exactly as the handler does, then assert the same two properties.

    /// @dev Settle `usd` (8-dp) in `token` against `id`, returning the gross + the deltas the sinks
    ///      saw. Mirrors the handler's pay path so the boundary probes exercise the shipped contract.
    function _settleToken(uint256 id, address token, uint256 usd)
        internal
        returns (uint256 gross, uint256 feeDelta, uint256 netDelta)
    {
        gross = router.quote(id, token, usd);
        uint256 feeBefore =
            ERC20(token).balanceOf(treasury) + ERC20(token).balanceOf(edgeFeeRecipient);
        uint256 netBefore = ERC20(token).balanceOf(edgePayout);

        deal(token, address(this), gross);
        ERC20(token).approve(address(router), gross);
        router.payToken(id, token, usd, bytes32(usd));

        feeDelta = (ERC20(token).balanceOf(treasury) + ERC20(token).balanceOf(edgeFeeRecipient))
            - feeBefore;
        netDelta = ERC20(token).balanceOf(edgePayout) - netBefore;
    }

    /// @notice Boundary: fee == 0. A 0-bps merchant under a 0-bps platform fee — the whole gross is net.
    function test_boundary_zeroFee() public {
        uint256 id = handler.zeroFeeMerchant();
        (uint256 gross, uint256 feeDelta, uint256 netDelta) = _settleToken(id, address(usdc), 250e8);
        assertEq(feeDelta, 0, "a 0-bps merchant under a 0-bps platform fee charges no fee");
        assertEq(netDelta, gross, "the whole gross is net when the fee is 0");
        assertEq(netDelta + feeDelta, gross, "net + fee == gross at the zero-fee boundary");
    }

    /// @notice Boundary: 1-wei gross. The 0-decimal token at $1.00 quotes to exactly 1 wei, where both
    ///         `Math.mulDiv` fee legs floor to 0 — so even a MAX_FEE_BPS merchant nets the whole wei.
    function test_boundary_oneWeiGross() public {
        uint256 id = handler.maxFeeMerchant(); // the merchant pinned at the cap
        (uint256 gross, uint256 feeDelta, uint256 netDelta) =
            _settleToken(id, address(zeroDec), 1e8);
        assertEq(gross, 1, "the 0-decimal token quotes $1.00 to exactly 1 wei");
        assertEq(feeDelta, 0, "both fee legs floor to 0 at a 1-wei gross");
        assertEq(netDelta, 1, "the single wei is delivered as net");
        assertEq(netDelta + feeDelta, gross, "net + fee == gross at the 1-wei boundary");
    }

    /// @notice Boundary: fee == MAX_FEE_BPS, max-decimals token. A merchant pinned at the 10% cap,
    ///         settled in a 36-decimal token — the high end of the `quote` scaling range. The combined
    ///         fee is exactly MAX_FEE_BPS of gross, no more.
    function test_boundary_maxFee_maxDecimals() public {
        uint256 id = handler.maxFeeMerchant();
        uint256 usd = 1000e8; // $1,000 in a 36-dec token => a very large gross
        (uint256 gross, uint256 feeDelta, uint256 netDelta) = _settleToken(id, address(maxDec), usd);
        assertEq(feeDelta, gross * MAX_FEE_BPS / 10_000, "fee is exactly MAX_FEE_BPS of gross");
        assertEq(
            netDelta + feeDelta, gross, "net + fee == gross at the max-fee max-decimals boundary"
        );
        assertLe(feeDelta * 10_000, gross * MAX_FEE_BPS, "fee never exceeds the cap");
    }

    /// @notice Boundary: the platform-fee SQUEEZE. Raise the platform fee so the squeeze merchant's
    ///         600-bps surcharge would push the combined fee over the cap; `_splitFee` clamps the
    ///         merchant leg, never the platform cut, and the total stays at exactly MAX_FEE_BPS.
    function test_boundary_platformFeeSqueeze() public {
        // Platform 700 bps + merchant 600 bps = 1300 > 1000 cap; merchant squeezed to 1000-700 = 300.
        vm.prank(address(handler));
        router.setPlatformFee(700);

        uint256 id = handler.squeezeMerchant();
        (uint256 gross, uint256 feeDelta, uint256 netDelta) = _settleToken(id, address(usdc), 500e8);
        // Platform leg untouched at 700 bps; merchant leg clamped to the 300-bps remainder.
        uint256 expFee = gross * 700 / 10_000 + gross * 300 / 10_000;
        assertEq(feeDelta, expFee, "platform cut untouched, merchant surcharge squeezed to the cap");
        assertEq(netDelta + feeDelta, gross, "net + fee == gross under the squeeze");
        assertLe(feeDelta * 10_000, gross * MAX_FEE_BPS, "the squeeze holds the total at the cap");
    }
}
