// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC1155 } from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/// @title  MockERC1155
/// @author Access0x1
/// @notice Test-only mintable ERC-1155 standing in for any multi-token collection. Plain OZ
///         ERC-1155 with public single/batch mint — no hooks, no surprises.
contract MockERC1155 is ERC1155 {
    constructor() ERC1155("") { }

    /// @notice Mint `amount` of token `id` to `to` (safe mint — runs the receiver hook).
    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }

    /// @notice Batch-mint `amounts` of `ids` to `to` (safe mint — runs the batch receiver hook).
    function mintBatch(address to, uint256[] calldata ids, uint256[] calldata amounts) external {
        _mintBatch(to, ids, amounts, "");
    }
}
