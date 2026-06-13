// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice The fund-me `MockFailedTransfer` port, adapted for a SafeERC20 router. Its `transfer`
///         silently `return false` (no revert) while moving NOTHING — the exact hostile token a
///         router that checked a raw boolean would mishandle.
/// @dev    Access0x1's router uses `SafeERC20.safeTransfer`, which treats a `false` return as a hard
///         failure and reverts (`SafeERC20FailedOperation`). So when this token is the merchant's
///         net/fee leg, `payToken` REVERTS and rolls back: no phantom `PaymentReceived`, no residual
///         token balance trapped in the router, the buyer's pull-in is undone. That revert is the
///         literal proof that "a transfer the token claimed-failed never settles a receipt."
///         `transferFrom` is left honest (real `super` move) so the router's pull-in leg succeeds and
///         the test reaches the OUTBOUND push that this token sabotages. Mint is unrestricted for
///         test funding.
contract MockFailedTransfer is ERC20 {
    constructor() ERC20("Mock Failed Transfer", "MFT") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Returns false WITHOUT moving value — the classic non-compliant "failed transfer" token.
    ///      SafeERC20 reverts on the false return, so the router never books the leg.
    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }
}
