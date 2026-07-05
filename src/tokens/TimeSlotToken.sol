// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC5007 } from "../interfaces/IERC5007.sol";

/// @title  TimeSlotToken
/// @author Access0x1
/// @notice A VANILLA, CLONEABLE ERC-5007 "Time NFT": a plain OZ ERC-721 where every token also carries
///         a validity WINDOW — `startTime(id)` .. `endTime(id)` as signed 64-bit UNIX seconds. The use
///         case is a booking/reservation SLOT as a transferable NFT: mint a token that represents "this
///         room, 14:00–15:00 next Tuesday", and it can be sold or gifted while the slot is still ahead.
///         The window is metadata the standard exposes; this preset ALSO ships a convenience gate
///         ({isValidNow}) that collapses the window against `block.timestamp` so a consumer can ask
///         "is this slot live right now?" without doing the arithmetic — but the token stays fully
///         transferable at every point in its life (expiry is descriptive, never a transfer lock).
/// @dev    REUSABLE-BASE RULES (nothing privileged, nothing hardcoded):
///           - The mint authority is the {Ownable} `owner`, a CONSTRUCTOR PARAM. The deployer keeps
///             nothing unless it IS that owner. No treasury, fee, or address is baked in.
///           - Every token's window is set ONCE at mint via {mintSlot} and is immutable thereafter
///             (a slot's time cannot silently move under a holder who bought it for that time). A
///             deployment needing reschedulable slots overrides/extends with its own guarded setter.
///           - {startTime}/{endTime} follow the EIP-5007 letter: they REVERT for a nonexistent token
///             (via `_requireOwned`). The never-revert convenience view is {isValidNow}, which returns
///             false for a nonexistent id instead of throwing (safe to staticcall from a router).
///         WINDOW RULE: {mintSlot} requires `startTime <= endTime` (a zero-length instant `start ==
///         end` is allowed and reads as never-valid, since validity is the half-open `[start, end)`).
///         Times are `int64`, so a slot may sit wholly in the past or begin before the epoch — the
///         standard imposes no "future only" rule and neither does this base; enforce that in a
///         subclass if a deployment wants it. Everything is `virtual` so a clone can layer royalties,
///         URIs, access tiers, or a reschedule path without forking this file.
contract TimeSlotToken is ERC721, Ownable, IERC5007 {
    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice The validity window per token: `[start, end)` in signed UNIX seconds. Set once at
    ///         {mintSlot}, immutable after. A nonexistent token has no entry (both read as 0), but
    ///         callers must not infer existence from these — use {startTime}/{endTime} (which revert)
    ///         or {isValidNow} (which is existence-aware).
    mapping(uint256 tokenId => int64 start) private _startTime;
    mapping(uint256 tokenId => int64 end) private _endTime;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice A slot token was minted with its (immutable) validity window.
    /// @param tokenId The freshly minted slot.
    /// @param to The receiver of the slot.
    /// @param start The (inclusive) window start, UNIX seconds.
    /// @param end The (exclusive) window end, UNIX seconds.
    event SlotMinted(uint256 indexed tokenId, address indexed to, int64 start, int64 end);

    /// @notice A window was supplied with `start > end` — an impossible slot.
    error TimeSlotToken__InvalidWindow(int64 start, int64 end);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploy a fresh time-slot collection. `owner_` is the sole mint authority (Ownable).
    /// @param name_ The ERC-721 collection name.
    /// @param symbol_ The ERC-721 collection symbol.
    /// @param owner_ The mint authority / upgrade admin (non-zero — enforced by {Ownable}).
    constructor(string memory name_, string memory symbol_, address owner_)
        ERC721(name_, symbol_)
        Ownable(owner_)
    { }

    /*//////////////////////////////////////////////////////////////
                                  MINT
    //////////////////////////////////////////////////////////////*/

    /// @notice Mint slot `tokenId` to `to` with an immutable validity window `[start, end)`. Only the
    ///         {Ownable} owner. Uses `_safeMint`, so a contract receiver must implement
    ///         {IERC721Receiver}.
    /// @param to The receiver (must be able to accept ERC-721s).
    /// @param tokenId The slot id to mint (must not already exist).
    /// @param start The (inclusive) window start, UNIX seconds.
    /// @param end The (exclusive) window end, UNIX seconds. Must satisfy `start <= end`.
    function mintSlot(address to, uint256 tokenId, int64 start, int64 end)
        external
        virtual
        onlyOwner
    {
        if (start > end) revert TimeSlotToken__InvalidWindow(start, end);
        _startTime[tokenId] = start;
        _endTime[tokenId] = end;
        _safeMint(to, tokenId);
        emit SlotMinted(tokenId, to, start, end);
    }

    /*//////////////////////////////////////////////////////////////
                             ERC-5007 SURFACE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC5007
    /// @dev Reverts for a nonexistent token (per the standard) via `_requireOwned`.
    function startTime(uint256 tokenId) public view virtual returns (int64) {
        _requireOwned(tokenId);
        return _startTime[tokenId];
    }

    /// @inheritdoc IERC5007
    /// @dev Reverts for a nonexistent token (per the standard) via `_requireOwned`.
    function endTime(uint256 tokenId) public view virtual returns (int64) {
        _requireOwned(tokenId);
        return _endTime[tokenId];
    }

    /*//////////////////////////////////////////////////////////////
                            CONVENIENCE VIEW
    //////////////////////////////////////////////////////////////*/

    /// @notice Whether `tokenId` is live at the current block time: `start <= now < end`, using the
    ///         half-open convention so a slot is valid from its start up to (but not including) its
    ///         end.
    /// @dev Composability: this MUST NOT revert. A nonexistent token reads as `false` (it owns no
    ///      window), so a router may staticcall it speculatively. `block.timestamp` is cast to `int64`
    ///      — safe for any realistic timestamp (int64 covers year ~292 billion).
    /// @param tokenId The slot to check.
    /// @return live True iff the token exists and now falls inside `[start, end)`.
    function isValidNow(uint256 tokenId) public view virtual returns (bool live) {
        if (_ownerOf(tokenId) == address(0)) return false;
        int64 nowT = int64(uint64(block.timestamp));
        return _startTime[tokenId] <= nowT && nowT < _endTime[tokenId];
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    /// @notice ERC-165 detection: true for {IERC5007} (`type(IERC5007).interfaceId` == `0x7a0cdf92`,
    ///         computed from the interface — see {IERC5007} on why the EIP's quoted `0xf140be0d` is not
    ///         reproducible from its selectors) plus everything the OZ ERC-721 base advertises
    ///         (IERC721, IERC721Metadata, IERC165).
    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC721, IERC165)
        returns (bool)
    {
        return interfaceId == type(IERC5007).interfaceId || super.supportsInterface(interfaceId);
    }
}
