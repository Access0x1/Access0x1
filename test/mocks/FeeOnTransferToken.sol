// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice An ERC-20 that skims 1% on every transfer (burned to a sink). The router must reject it:
///         the balance delta it pulls is less than the gross it asked for, so `payToken` reverts
///         `FeeOnTransferToken`. Mint/burn are not skimmed so funding stays exact.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee On Transfer", "FOT") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100; // 1% skim
            super._update(from, to, value - fee);
            if (fee > 0) super._update(from, address(0xdead), fee);
        } else {
            super._update(from, to, value);
        }
    }
}
