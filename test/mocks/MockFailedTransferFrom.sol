// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice The fund-me `MockFailedTransferFrom` port, adapted for a SafeERC20 router. Its
///         `transferFrom` silently `return false` (no revert) while moving NOTHING — sabotaging the
///         router's pull-in leg, the very FIRST money movement of `payToken`.
/// @dev    `payToken` pulls the gross in via `_pullExact` → `SafeERC20.safeTransferFrom`, which treats
///         the `false` return as a hard failure and reverts (`SafeERC20FailedOperation`). The whole
///         `payToken` therefore reverts BEFORE any split/emit/push: no `PaymentReceived` is emitted
///         against money that never arrived, no fee is paid out of thin air, and the router's token
///         balance is unchanged. This is the proof that a buyer whose pull silently failed cannot
///         create a phantom payment. `transfer` stays honest so this mock isolates the pull-in failure
///         (the outbound-push failure is covered by `MockFailedTransfer`). Mint is unrestricted.
contract MockFailedTransferFrom is ERC20 {
    constructor() ERC20("Mock Failed TransferFrom", "MFTF") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Returns false WITHOUT moving value — SafeERC20 reverts on it, so the pull-in fails closed.
    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}
