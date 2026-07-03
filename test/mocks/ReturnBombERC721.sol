// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  ReturnBombERC721
/// @author Access0x1
/// @notice Test-only hostile "ERC-721": EVERY call (including `ownerOf`) succeeds but returns a
///         1,000,000-byte zero blob — a classic return bomb. Used to prove that
///         {Access0x1Account.owner} (a) resolves such a binding to no owner and (b) copies at
///         most one word of returndata, so the bomb can never inflate the account's caller-side
///         memory cost.
contract ReturnBombERC721 {
    /// @notice The size of the returndata blob every call answers with.
    uint256 public constant BOMB_SIZE = 1_000_000;

    /// @dev Succeeds with `BOMB_SIZE` bytes of zeroed returndata for any selector.
    fallback() external {
        assembly {
            return(0, 1000000)
        }
    }
}
