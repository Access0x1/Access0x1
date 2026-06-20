// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @notice FABLE RED-TEAM — adversarial stateful invariant that, UNLIKE the canonical
///         PaymentLanesHandler, fires MISMATCHED-asset claimLane calls every step. The existing
///         invariant fuzzer only ever claims the matching asset, so it never stresses the firewall
///         no-op under a long random call sequence. This handler:
///           - credits 3 merchants across 3 assets (usdc, eurc, evil),
///           - claims with a DELIBERATELY scrambled asset most of the time,
///           - transfers receipts between merchants,
///         and tracks per-asset ghost totals INDEPENDENTLY. The invariants then assert per-asset
///         conservation (held == Σ unclaimed of that asset) and a frozen cross-merchant canary.
contract PaymentLanesFirewallHandler is Test {
    PaymentLanes public immutable lanes;
    MockUSDC public immutable usdc;
    MockUSDC public immutable eurc;
    MockUSDC public immutable evil;

    address[3] public merchants;
    MockUSDC[3] public assets;

    // frozen canary (cross-merchant isolation)
    address public canaryOwner;
    uint256 public canaryId;
    uint256 public canaryBalance;

    // per-asset ghost: Σ credited - Σ claimed (matching asset only; mismatched claims move nothing)
    mapping(address asset => uint256 net) public ghostHeld;

    constructor(PaymentLanes lanes_, MockUSDC usdc_, MockUSDC eurc_, MockUSDC evil_) {
        lanes = lanes_;
        usdc = usdc_;
        eurc = eurc_;
        evil = evil_;

        merchants[0] = makeAddr("fwi_m0");
        merchants[1] = makeAddr("fwi_m1");
        merchants[2] = makeAddr("fwi_m2");
        assets[0] = usdc_;
        assets[1] = eurc_;
        assets[2] = evil_;

        for (uint256 i = 0; i < 3; i++) {
            assets[i].mint(address(this), type(uint128).max);
            assets[i].approve(address(lanes_), type(uint256).max);
        }
    }

    function seedCanary() external {
        canaryOwner = makeAddr("fwi_canary");
        canaryBalance = 12_345e6;
        canaryId = lanes.credit(canaryOwner, address(usdc), canaryBalance);
        ghostHeld[address(usdc)] += canaryBalance;
    }

    function _m(uint256 s) internal view returns (address) {
        return merchants[s % 3];
    }

    function _a(uint256 s) internal view returns (MockUSDC) {
        return assets[s % 3];
    }

    /// @notice Credit a bounded amount to a chosen (merchant, asset).
    function credit(uint256 mSeed, uint256 aSeed, uint256 amount) external {
        address m = _m(mSeed);
        MockUSDC a = _a(aSeed);
        amount = bound(amount, 1, 1_000_000e6);
        lanes.credit(m, address(a), amount);
        ghostHeld[address(a)] += amount;
    }

    /// @notice Claim with a possibly-MISMATCHED asset. `assetSeed` is chosen INDEPENDENTLY of the lane
    ///         the merchant actually holds, so most steps are firewall no-ops. We update the ghost ONLY
    ///         when the claim's asset matches the lane the merchant holds a balance on — i.e. exactly
    ///         when the contract should pay out. If the firewall is broken and a mismatched claim pays,
    ///         the conservation invariant catches the divergence.
    function claimScrambled(uint256 mSeed, uint256 laneAssetSeed, uint256 claimAssetSeed) external {
        address m = _m(mSeed);
        MockUSDC laneAsset = _a(laneAssetSeed); // the asset whose lane we look at
        MockUSDC claimAsset = _a(claimAssetSeed); // the asset we PASS to claimLane (maybe different)

        uint256 id = lanes.laneId(block.chainid, address(laneAsset), m);
        uint256 bal = lanes.balanceOf(m, id);

        vm.prank(m);
        // claimLane(id, claimAsset): if claimAsset == laneAsset and bal>0 it pays bal; if claimAsset
        // mismatches the lane's bound asset it must be a no-op; if bal==0 it reverts.
        try lanes.claimLane(id, address(claimAsset)) {
            // Reached only on a non-reverting call. The contract pays out iff claimAsset == laneAsset
            // (the lane's bound asset) AND bal > 0. A mismatched no-op also does not revert but moves
            // nothing — so only decrement the ghost when the assets actually match.
            if (address(claimAsset) == address(laneAsset) && bal > 0) {
                ghostHeld[address(laneAsset)] -= bal;
            }
        } catch { }
    }

    /// @notice Transfer part of a merchant's lane to another merchant (conserves held totals).
    function transfer(uint256 fromSeed, uint256 toSeed, uint256 aSeed, uint256 amount) external {
        address from = _m(fromSeed);
        address to = _m(toSeed);
        MockUSDC a = _a(aSeed);
        uint256 id = lanes.laneId(block.chainid, address(a), from);
        uint256 bal = lanes.balanceOf(from, id);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(from);
        lanes.transfer(to, id, amount);
    }
}

/// @notice Per-asset conservation + cross-merchant isolation must hold even when claims are fired with
///         deliberately scrambled (often mismatched) assets across a long random call sequence.
contract PaymentLanesFirewallInvariant is StdInvariant, Test, ProxyDeployer {
    PaymentLanes internal lanes;
    PaymentLanesFirewallHandler internal handler;
    MockUSDC internal usdc;
    MockUSDC internal eurc;
    MockUSDC internal evil;
    address internal admin = makeAddr("fwi_admin");

    function setUp() public {
        usdc = new MockUSDC();
        eurc = new MockUSDC();
        evil = new MockUSDC();
        lanes = PaymentLanes(
            deployProxy(
                address(new PaymentLanes()), abi.encodeCall(PaymentLanes.initialize, (admin))
            )
        );

        handler = new PaymentLanesFirewallHandler(lanes, usdc, eurc, evil);
        vm.prank(admin);
        lanes.setRouter(address(handler), true);
        handler.seedCanary();

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = PaymentLanesFirewallHandler.credit.selector;
        selectors[1] = PaymentLanesFirewallHandler.claimScrambled.selector;
        selectors[2] = PaymentLanesFirewallHandler.transfer.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @notice Per-asset conservation under scrambled-asset claims: each asset's held balance equals the
    ///         independently-tracked ghost (Σ credited − Σ matched-claimed). A mismatched claim that
    ///         leaked value would push held BELOW the ghost and trip this.
    function invariant_firewall_conservationUsdc() public view {
        assertEq(usdc.balanceOf(address(lanes)), handler.ghostHeld(address(usdc)));
    }

    function invariant_firewall_conservationEurc() public view {
        assertEq(eurc.balanceOf(address(lanes)), handler.ghostHeld(address(eurc)));
    }

    function invariant_firewall_conservationEvil() public view {
        assertEq(evil.balanceOf(address(lanes)), handler.ghostHeld(address(evil)));
    }

    /// @notice Cross-merchant isolation: the frozen canary lane never moves no matter what scrambled
    ///         claims fire on other lanes/assets.
    function invariant_firewall_canaryFrozen() public view {
        assertEq(
            lanes.balanceOf(handler.canaryOwner(), handler.canaryId()), handler.canaryBalance()
        );
    }
}
