// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title  IERC4907
/// @author Access0x1
/// @notice ERC-4907 — the rental extension to ERC-721. It adds a second, EXPIRING role on top of
///         ownership: a "user" who may enjoy the NFT (a rented venue slot, a leased machine, a licensed
///         asset) without ever holding title. The owner keeps the token; `setUser` grants the user
///         role until a UNIX `expires`; after that instant `userOf` reads back as the zero address with
///         no transaction required (lazy expiry).
/// @dev    Members are VERBATIM from EIP-4907 so the ERC-165 interface id is the standard one:
///         `0xad092b5c`. `expires` is `uint256` UNIX seconds. Implementations MUST clear the user role
///         on transfer (a sale of the underlying asset ends the tenancy) and SHOULD emit
///         {UpdateUser} whenever the (user, expires) pair effectively changes. Requires ERC-165
///         (`supportsInterface(0xad092b5c)` must return true on implementers).
interface IERC4907 is IERC165 {
    /// @notice Emitted when the user of an NFT or the expiry of the user role is changed.
    /// @dev The zero address for `user` indicates that there is no user address.
    /// @param tokenId The NFT whose user role changed.
    /// @param user The new user of the NFT (zero if cleared).
    /// @param expires The UNIX timestamp after which `user` no longer holds the role.
    event UpdateUser(uint256 indexed tokenId, address indexed user, uint64 expires);

    /// @notice Set the user and expires of an NFT.
    /// @dev The zero address indicates there is no user. Throws if `tokenId` is not valid NFT.
    /// @param tokenId The NFT to set the user and expiry for.
    /// @param user The new user of the NFT.
    /// @param expires UNIX timestamp, the new user could use the NFT before `expires`.
    function setUser(uint256 tokenId, address user, uint64 expires) external;

    /// @notice Get the user address of an NFT.
    /// @dev The zero address indicates that there is no user or the user is expired.
    /// @param tokenId The NFT to get the user address for.
    /// @return The user address for this NFT.
    function userOf(uint256 tokenId) external view returns (address);

    /// @notice Get the user expires of an NFT.
    /// @dev The zero value indicates that there is no user.
    /// @param tokenId The NFT to get the user expires for.
    /// @return The user expires for this NFT.
    function userExpires(uint256 tokenId) external view returns (uint256);
}
