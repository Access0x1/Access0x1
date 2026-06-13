// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A USDT-style ERC-20 whose `transfer`/`transferFrom` return NOTHING (no `bool`) but DO move
///         value. Proves the router's `SafeERC20` choice is load-bearing: a raw
///         `require(token.transfer(...))` would revert on the empty return (USDT can't be used), but
///         SafeERC20 inspects the return-data length and accepts a no-data success — so the router
///         settles real USDT-class tokens correctly while still rejecting the `return false` liars.
/// @dev    These overrides deliberately break the OpenZeppelin `IERC20` `returns (bool)` ABI: they
///         move the value via the internal `_transfer`/`_spendAllowance` machinery and then return
///         with no data. Because mainnet USDT does exactly this, exercising the router against it is
///         the realistic non-mock-divergence check. Mint is unrestricted for funding.
contract MockReturnsNothingToken is ERC20 {
    constructor() ERC20("Mock Returns Nothing", "USDTish") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Moves the value, then returns with EMPTY return-data (no bool) — the USDT non-compliance.
    function transfer(address to, uint256 value) public override returns (bool) {
        _transfer(_msgSender(), to, value);
        assembly {
            return(0, 0)
        }
    }

    /// @dev Spends the allowance + moves the value, then returns EMPTY (no bool) — USDT-style.
    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _spendAllowance(from, _msgSender(), value);
        _transfer(from, to, value);
        assembly {
            return(0, 0)
        }
    }
}
