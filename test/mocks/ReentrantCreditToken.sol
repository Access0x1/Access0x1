// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IPaymentLanes } from "../../src/interfaces/IPaymentLanes.sol";

/// @notice A malicious ERC-20 that, while being pulled INTO PaymentLanes by `credit`, re-enters
///         `credit` on the same lanes contract. Since the token's transfer happens inside the
///         router's authorized call, the re-entrant `credit` runs while `nonReentrant` is engaged —
///         the guard must revert it, which (because `credit` does the transfer last and the whole
///         thing is one call) bubbles up and reverts the entire credit. The test asserts the outer
///         credit reverts, i.e. no partial mint survives.
contract ReentrantCreditToken is ERC20 {
    IPaymentLanes public lanes;
    address public reenterRecipient;
    bool public armed;

    constructor() ERC20("Reentrant Credit USDC", "rxUSDC") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setLanes(IPaymentLanes lanes_, address recipient) external {
        lanes = lanes_;
        reenterRecipient = recipient;
    }

    function arm(bool on) external {
        armed = on;
    }

    /// @dev On the inbound pull (to the lanes contract) attempt a re-entrant credit of 1 unit.
    function _update(address from, address to, uint256 value) internal override {
        if (armed && to == address(lanes) && address(lanes) != address(0)) {
            armed = false;
            lanes.credit(reenterRecipient, address(this), 1); // must revert via nonReentrant
        }
        super._update(from, to, value);
    }
}
