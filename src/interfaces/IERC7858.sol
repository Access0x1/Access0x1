// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title  IERC7858
/// @author Access0x1
/// @notice ERC-7858 — Expirable NFTs. An ERC-721 extension where each token carries a validity range
///         (`startTime` .. `endTime`) and a single boolean `isTokenValid` collapses that range against
///         "now". Unlike ERC-5007 (which exposes the window but ascribes it no lifecycle meaning), the
///         window here IS the token's lifecycle: outside it the token is EXPIRED — still owned, still
///         transferable, but semantically inactive (a lapsed pass, an aged voucher, a time-boxed
///         credential). A cloner reads `isTokenValid` as the gate; the raw endpoints are exposed for
///         off-chain display and composition.
/// @dev    The `EXPIRY_TYPE` enum mirrors the standard: a deployment fixes whether the window is
///         measured in block numbers or in UNIX timestamps, and advertises which via {expiryType} so a
///         reader interprets `startTime`/`endTime` correctly. This kit's {ExpirableToken} preset uses
///         `TIME_BASED`. The function set matches the EIP-7858 reference so implementers can advertise
///         the standard ERC-165 id; because the finalized id is deployment-fixed by the standard's own
///         reference, {ExpirableToken} advertises `type(IERC7858).interfaceId` computed from THIS
///         interface (documented in the preset), never a hand-copied magic constant that could drift.
interface IERC7858 is IERC165 {
    /// @notice How the validity window of a token is measured.
    /// @dev A deployment fixes ONE type for the whole collection and reports it via {expiryType}.
    ///      `BLOCKS_BASED` — `startTime`/`endTime` are block numbers; `TIME_BASED` — UNIX seconds.
    enum EXPIRY_TYPE {
        BLOCKS_BASED,
        TIME_BASED
    }

    /// @notice Emitted when the validity window of `tokenId` is set or changed.
    /// @param tokenId The token whose window changed.
    /// @param start The (inclusive) start of the validity window.
    /// @param end The (exclusive) end of the validity window.
    event TokenExpiryUpdated(uint256 indexed tokenId, uint256 indexed start, uint256 indexed end);

    /// @notice Which unit the validity window is expressed in for this collection.
    /// @return The collection-wide {EXPIRY_TYPE}.
    function expiryType() external view returns (EXPIRY_TYPE);

    /// @notice Whether `tokenId` is currently inside its validity window (i.e. not expired / not yet
    ///         started).
    /// @dev MUST NOT revert for a nonexistent token — returns false instead (composability: routers
    ///      call this speculatively).
    /// @param tokenId The token to check.
    /// @return True iff `start <= now < end` in the collection's {expiryType} unit.
    function isTokenValid(uint256 tokenId) external view returns (bool);

    /// @notice The (inclusive) start of the validity window of `tokenId`.
    /// @param tokenId The token to read.
    /// @return The start point, in the collection's {expiryType} unit.
    function startTime(uint256 tokenId) external view returns (uint256);

    /// @notice The (exclusive) end of the validity window of `tokenId`.
    /// @param tokenId The token to read.
    /// @return The end point, in the collection's {expiryType} unit.
    function endTime(uint256 tokenId) external view returns (uint256);
}
