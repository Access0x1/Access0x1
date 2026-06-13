// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A 6-decimal ERC-20 (USDC-shaped) that REVERTS on a `transfer`/`transferFrom` to a
///         blocklisted address — the USDC-style compliance behaviour. Used to drive Access0x1Bookings'
///         refund pull-map: a refund push to a blocklisted payer must NOT revert the lifecycle
///         transition; it must land in `refundRescue` instead (law #5 — refunds never blocked). Mint
///         is never blocked so test funding stays exact.
contract BlocklistToken is ERC20 {
    mapping(address account => bool blocked) public blocklisted;

    constructor() ERC20("Blocklist USDC", "bUSDC") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Block (or unblock) an address from RECEIVING the token (the recipient leg reverts).
    function setBlocked(address account, bool blocked) external {
        blocklisted[account] = blocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to != address(0) && blocklisted[to]) revert("BlocklistToken: recipient blocked");
        super._update(from, to, value);
    }
}
