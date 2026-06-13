// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IPaymentLanes } from "../../src/interfaces/IPaymentLanes.sol";

/// @notice A malicious 6-decimal ERC-20 that, on the `transfer` PaymentLanes makes during `claim`,
///         tries to re-enter `claim` on the same lane. CEI (balance zeroed first) makes the re-entry
///         find nothing to claim, and the `nonReentrant` guard blocks it outright — either way no
///         double-spend. `attack` is armed externally so ordinary transfers (e.g. the `credit` pull)
///         behave normally.
contract ReentrantClaimToken is ERC20 {
    IPaymentLanes public lanes;
    bool public armed;

    constructor() ERC20("Reentrant Claim USDC", "rcUSDC") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setLanes(IPaymentLanes lanes_) external {
        lanes = lanes_;
    }

    function arm(bool on) external {
        armed = on;
    }

    /// @dev On the outbound `claim` transfer (from the lanes contract to the claimant) attempt a
    ///      re-entrant claim. The guard / CEI must defeat it; we swallow the revert so the legitimate
    ///      transfer still completes and the test can assert the post-state.
    function _update(address from, address to, uint256 value) internal override {
        if (armed && from == address(lanes) && address(lanes) != address(0)) {
            armed = false; // one-shot, avoid infinite recursion if the guard were absent
            try lanes.claim(address(this)) { } catch { }
        }
        super._update(from, to, value);
    }
}
