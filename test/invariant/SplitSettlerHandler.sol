// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { SplitSettler } from "../../src/SplitSettler.sol";
import { ISplitSettler } from "../../src/interfaces/ISplitSettler.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

/// @notice Drives the SplitSettler invariant fuzzer through the full lifecycle — createSplit, settleToken,
///         settleNative, and withdraw — across a fixed merchant (whose router payout is the settler) and
///         two assets (one native, one ERC-20), while tracking ghost totals the suite checks the contract
///         against. Every action is written to NEVER revert (`fail_on_revert = true`): inputs are
///         `bound`ed, share sets are constructed to sum to exactly TOTAL_BPS, and preconditions early-return.
/// @dev    Payees are EOAs that always receive, so a {withdraw} always succeeds and never queues a failed
///         push — the conservation invariant then reduces to an exact equality (balance == Σ withdrawable)
///         the suite asserts. The settle math is independent of the contract's own numbers: the handler
///         recomputes the router's net (gross − platform fee) and folds it into the per-asset ghost, so a
///         drift between credited and held would surface. A FROZEN CANARY split (created once, never
///         paused) backs the "every split has Σ shares == TOTAL_BPS and is settleable" property.
contract SplitSettlerHandler is Test {
    SplitSettler public immutable settler;
    Access0x1Router public immutable router;
    MockUSDC public immutable usdc; // 6 dp ERC-20 asset

    uint256 public immutable merchantId;
    address public immutable treasury;
    uint16 public immutable platformFeeBps;

    /// @notice The native-asset sentinel mirrored from the contract.
    address internal constant NATIVE = address(0);
    uint16 internal constant TOTAL_BPS = 10_000;

    /// @notice A fixed set of payees (EOAs that always receive) the fuzzer fans out to, and one payer.
    address[4] public payees;
    address public payer;

    /// @notice Live split ids the fuzzer can settle.
    uint256[] public liveSplits;

    // ---- frozen canary (every split keeps Σ shares == TOTAL_BPS and stays settleable) ----
    uint256 public canarySplitId;

    // ---- ghost accounting ----
    /// @notice asset ⇒ Σ net credited across all settlements (== Σ withdrawable while nothing is claimed,
    ///         and the contract must always HOLD at least this much).
    mapping(address asset => uint256 credited) public ghostCredited;
    /// @notice asset ⇒ Σ withdrawn out to payees (so credited − withdrawn == currently-held backing).
    mapping(address asset => uint256 withdrawn) public ghostWithdrawn;
    /// @notice Whether every settlement's fanned-out legs summed EXACTLY to the router net (no dust).
    bool public splitAlwaysExact = true;

    constructor(
        SplitSettler settler_,
        Access0x1Router router_,
        MockUSDC usdc_,
        uint256 merchantId_,
        address treasury_,
        uint16 platformFeeBps_
    ) {
        settler = settler_;
        router = router_;
        usdc = usdc_;
        merchantId = merchantId_;
        treasury = treasury_;
        platformFeeBps = platformFeeBps_;

        payer = makeAddr("ssh_payer");
        usdc_.mint(payer, type(uint128).max);
        vm.deal(payer, type(uint128).max);
        vm.prank(payer);
        usdc_.approve(address(settler_), type(uint256).max);

        for (uint256 i = 0; i < 4; ++i) {
            payees[i] = makeAddr(string(abi.encodePacked("ssh_payee", i)));
        }
    }

    /// @notice Seed the frozen canary split — created once, never paused, so the suite can assert every
    ///         split keeps Σ shares == TOTAL_BPS and stays settleable.
    function seedCanary() external {
        canarySplitId = _create(7000, 1500, 1000, 500);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _asset(uint256 seed) internal view returns (address) {
        return seed % 2 == 0 ? address(usdc) : NATIVE;
    }

    /// @dev Create a 4-leg split from four shares the caller has arranged to sum to TOTAL_BPS.
    function _create(uint16 a, uint16 b, uint16 c, uint16 d) internal returns (uint256 id) {
        ISplitSettler.Payee[] memory p = new ISplitSettler.Payee[](4);
        p[0] = ISplitSettler.Payee({ account: payees[0], shareBps: a });
        p[1] = ISplitSettler.Payee({ account: payees[1], shareBps: b });
        p[2] = ISplitSettler.Payee({ account: payees[2], shareBps: c });
        p[3] = ISplitSettler.Payee({ account: payees[3], shareBps: d });
        vm.prank(_merchantOwner());
        id = settler.createSplit(merchantId, p, 0);
    }

    function _merchantOwner() internal view returns (address o) {
        (, o,,,,) = router.merchants(merchantId);
    }

    /// @dev The router's net for a gross: gross − floor(gross * platformFeeBps / TOTAL_BPS).
    function _routerNet(uint256 gross) internal view returns (uint256) {
        return gross - (gross * platformFeeBps / TOTAL_BPS);
    }

    function _pickSplit(uint256 seed) internal view returns (uint256 id, bool ok) {
        if (liveSplits.length == 0) return (0, false);
        id = liveSplits[seed % liveSplits.length];
        ok = true;
    }

    /*//////////////////////////////////////////////////////////////
                                ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Create a fresh split with a random 4-way share that the handler forces to sum to TOTAL_BPS
    ///         (the first three are bounded, the fourth absorbs the remainder), so createSplit never reverts.
    function createSplit(uint256 s0, uint256 s1, uint256 s2) external {
        uint16 a = uint16(bound(s0, 1, 9700));
        uint16 b = uint16(bound(s1, 1, uint256(TOTAL_BPS) - a - 2));
        uint16 c = uint16(bound(s2, 1, uint256(TOTAL_BPS) - a - b - 1));
        uint16 d = uint16(uint256(TOTAL_BPS) - a - b - c); // remainder ⇒ Σ == TOTAL_BPS exactly
        liveSplits.push(_create(a, b, c, d));
    }

    /// @notice Settle a token payment through a live split: gross routes through the router fee-split
    ///         (platform fee once → treasury), the net fans out to the four EOA payees as pull-credits.
    function settleToken(uint256 seed, uint256 usdSeed) external {
        (uint256 id, bool ok) = _pickSplit(seed);
        if (!ok) return;
        uint256 usd8 = bound(usdSeed, 1e8, 1_000_000e8); // $1 .. $1M
        uint256 gross = router.quote(merchantId, address(usdc), usd8);
        uint256 net = _routerNet(gross);

        uint256 heldBefore = usdc.balanceOf(address(settler));
        vm.prank(payer);
        settler.settleToken(id, address(usdc), usd8, keccak256(abi.encode(seed, usdSeed)));
        uint256 credited = usdc.balanceOf(address(settler)) - heldBefore;

        if (credited != net) splitAlwaysExact = false; // fanned-out legs must sum to the router net
        ghostCredited[address(usdc)] += credited;
    }

    /// @notice Settle a native payment through a live split (exact value, no excess).
    function settleNative(uint256 seed, uint256 usdSeed) external {
        (uint256 id, bool ok) = _pickSplit(seed);
        if (!ok) return;
        uint256 usd8 = bound(usdSeed, 1e8, 1_000_000e8);
        uint256 gross = router.quote(merchantId, NATIVE, usd8);
        uint256 net = _routerNet(gross);

        uint256 heldBefore = address(settler).balance;
        vm.prank(payer);
        settler.settleNative{ value: gross }(id, usd8, keccak256(abi.encode(seed, usd8)));
        uint256 credited = address(settler).balance - heldBefore;

        if (credited != net) splitAlwaysExact = false;
        ghostCredited[NATIVE] += credited;
    }

    /// @notice A payee pulls its full claimable balance for an asset (EOA — always receives).
    function withdraw(uint256 payeeSeed, uint256 assetSeed) external {
        address who = payees[payeeSeed % payees.length];
        address asset = _asset(assetSeed);
        uint256 owed = settler.withdrawable(who, asset);
        if (owed == 0) return;
        vm.prank(who);
        settler.withdraw(asset);
        ghostWithdrawn[asset] += owed;
    }
}
