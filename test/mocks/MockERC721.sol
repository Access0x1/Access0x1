// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title  MockERC721
/// @author Access0x1
/// @notice Test-only mintable ERC-721 standing in for any NFT collection a seller lists through
///         {Access0x1Nft}. Plain OZ ERC-721 with a public `mint` — no hooks, no surprises.
contract MockERC721 is ERC721 {
    uint256 private _nextId;

    constructor() ERC721("Mock NFT", "MNFT") { }

    /// @notice Mint the next sequential token id to `to`.
    /// @return id The minted token id.
    function mint(address to) external returns (uint256 id) {
        id = _nextId++;
        _safeMint(to, id);
    }

    /// @notice Mint a specific token id to `to` (for deterministic test ids).
    function mintId(address to, uint256 id) external {
        _safeMint(to, id);
    }
}
