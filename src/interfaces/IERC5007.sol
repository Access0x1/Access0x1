// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title  IERC5007
/// @author Access0x1
/// @notice ERC-5007 — Time NFT, the "start time + end time" extension to ERC-721. Every token carries
///         a validity WINDOW: `startTime(id)` and `endTime(id)` as signed 64-bit UNIX seconds. The use
///         case is a reservation/slot as a transferable NFT — a booking that begins and ends at a
///         known instant, tradeable while it is still in the future.
/// @dev    Members are VERBATIM from EIP-5007 (`startTime`/`endTime`, `int64` UNIX seconds), so a
///         token MAY sit entirely in the past (both < now) or begin before the Unix epoch (negative)
///         — the standard imposes no ordering beyond the implementer's own construction rules.
///         INTERFACE ID: this kit advertises `type(IERC5007).interfaceId` COMPUTED from this two-method
///         interface (`startTime.selector ^ endTime.selector = 0x7a0cdf92`), never a hand-copied magic
///         constant that could drift. NOTE: the EIP-5007 text quotes `0xf140be0d`, but that value is
///         not reproducible from the interface's own selectors (a known inconsistency in the EIP's
///         stated id); the honest, verifiable id for detection is the computed `0x7a0cdf92`. A consumer
///         should feature-detect via `supportsInterface(type(IERC5007).interfaceId)`, not a literal.
///         Requires ERC-165.
interface IERC5007 is IERC165 {
    /// @notice Get the start time of an NFT.
    /// @dev Throws if `tokenId` is not a valid NFT.
    /// @param tokenId The NFT to get the start time of.
    /// @return The start time of the NFT, as UNIX timestamp seconds.
    function startTime(uint256 tokenId) external view returns (int64);

    /// @notice Get the end time of an NFT.
    /// @dev Throws if `tokenId` is not a valid NFT.
    /// @param tokenId The NFT to get the end time of.
    /// @return The end time of the NFT, as UNIX timestamp seconds.
    function endTime(uint256 tokenId) external view returns (int64);
}
