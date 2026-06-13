// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

/// @notice Drives the PaymentLanes invariant fuzzer through credit / claim / transfer across a fixed
///         set of merchants and two assets, while tracking ghost totals the suite checks the contract
///         against. The handler IS the authorized router, so its credits always succeed; every action
///         is written to NEVER revert (the suite runs `fail_on_revert = true`): inputs are `bound`ed
///         and preconditions early-return.
/// @dev    A FROZEN CANARY lane (`canaryOwner` on `usdc`) is credited ONCE in the constructor and then
///         never touched by any action — the isolation invariant asserts its balance never moves.
contract PaymentLanesHandler is Test {
    PaymentLanes public immutable lanes;
    MockUSDC public immutable usdc;
    MockUSDC public immutable eurc;

    /// @notice The merchants the fuzzer credits/claims/transfers among (canary excluded).
    address[3] public merchants;
    address[2] public assets;

    // ---- frozen canary (isolation invariant 1) ----
    address public canaryOwner;
    uint256 public canaryId;
    uint256 public canaryBalance;

    // ---- ghost accounting (conservation invariant 2) ----
    /// @notice asset ⇒ Σ credited - Σ claimed = the amount that MUST be held by lanes for that asset.
    mapping(address asset => uint256 net) public ghostHeld;

    constructor(PaymentLanes lanes_, MockUSDC usdc_, MockUSDC eurc_) {
        lanes = lanes_;
        usdc = usdc_;
        eurc = eurc_;

        merchants[0] = makeAddr("pl_m0");
        merchants[1] = makeAddr("pl_m1");
        merchants[2] = makeAddr("pl_m2");
        assets[0] = address(usdc_);
        assets[1] = address(eurc_);

        // Fund + approve the handler (the authorized router) for both assets.
        usdc_.mint(address(this), type(uint128).max);
        eurc_.mint(address(this), type(uint128).max);
        usdc_.approve(address(lanes_), type(uint256).max);
        eurc_.approve(address(lanes_), type(uint256).max);
    }

    /// @notice Seed the frozen canary lane — called once by the test AFTER the handler is authorized
    ///         as the router. Never touched again by any fuzzed action, so the isolation invariant can
    ///         assert its balance is immutable.
    function seedCanary() external {
        canaryOwner = makeAddr("pl_canary");
        canaryBalance = 777e6;
        canaryId = lanes.credit(canaryOwner, address(usdc), canaryBalance);
        ghostHeld[address(usdc)] += canaryBalance;
    }

    function _asset(uint256 seed) internal view returns (address) {
        return assets[seed % assets.length];
    }

    function _merchant(uint256 seed) internal view returns (address) {
        return merchants[seed % merchants.length];
    }

    /// @notice Credit a (bounded) amount to a chosen merchant + asset.
    function credit(uint256 mSeed, uint256 aSeed, uint256 amount) external {
        address m = _merchant(mSeed);
        address a = _asset(aSeed);
        amount = bound(amount, 1, 1_000_000e6);
        lanes.credit(m, a, amount);
        ghostHeld[a] += amount;
    }

    /// @notice A merchant claims its full lane for a chosen asset (no-op if empty — early return keeps
    ///         `fail_on_revert` happy).
    function claim(uint256 mSeed, uint256 aSeed) external {
        address m = _merchant(mSeed);
        address a = _asset(aSeed);
        uint256 id = lanes.laneId(block.chainid, a, m);
        uint256 bal = lanes.balanceOf(m, id);
        if (bal == 0) return;
        vm.prank(m);
        lanes.claim(a);
        ghostHeld[a] -= bal;
    }

    /// @notice Move part of one merchant's lane to another (transfers conserve held totals).
    function transfer(uint256 fromSeed, uint256 toSeed, uint256 aSeed, uint256 amount) external {
        address from = _merchant(fromSeed);
        address to = _merchant(toSeed);
        if (to == address(0)) return;
        address a = _asset(aSeed);
        uint256 id = lanes.laneId(block.chainid, a, from);
        uint256 bal = lanes.balanceOf(from, id);
        if (bal == 0) return;
        amount = bound(amount, 0, bal);
        if (amount == 0) return;
        vm.prank(from);
        lanes.transfer(to, id, amount);
        // ghostHeld unchanged: a transfer moves a receipt between owners, not in/out of the contract.
    }
}
