// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC7858 } from "../interfaces/IERC7858.sol";

/// @title  ExpirableToken
/// @author Access0x1
/// @notice A VANILLA, CLONEABLE ERC-7858 "expirable NFT": a plain OZ ERC-721 where every token carries
///         a validity window and a single {isTokenValid} gate collapses it against "now". Use it for a
///         pass, voucher, licence, or credential that is meaningful only for a bounded stretch of time:
///         after `endTime` the token is EXPIRED — still owned, still transferable, but semantically
///         inactive. This preset uses `TIME_BASED` expiry (UNIX seconds).
/// @dev    COMPLEMENTARY TO {TimeSlotToken} (ERC-5007), NOT a duplicate — pick by what the window
///         MEANS:
///           - {TimeSlotToken} (ERC-5007) exposes `startTime`/`endTime` as `int64` and treats the
///             window as DESCRIPTIVE metadata about WHEN a booked slot happens. The window is neutral;
///             a consumer decides what to do with it. Standard id `0xf140be0d`.
///           - {ExpirableToken} (ERC-7858, THIS) treats the window as the token's LIFECYCLE: the
///             built-in {isTokenValid} boolean IS the product contract ("is this pass still good?"),
///             and {expiryType} advertises how the window is measured so a reader interprets it
///             correctly. Times are unsigned (`uint256`).
///         So: reach for {TimeSlotToken} when you're SELLING a time (a 2pm reservation); reach for
///         {ExpirableToken} when you're GATING on validity (a 30-day pass). They can coexist in one
///         deployment.
///         REUSABLE-BASE RULES (nothing privileged, nothing hardcoded): mint authority is the
///         {Ownable} `owner` (a constructor param); the window is set once at {mintExpirable} and is
///         immutable after (a pass's expiry cannot silently move under its holder). {isTokenValid}
///         NEVER reverts (false for a nonexistent id) so routers can staticcall it; the raw
///         {startTime}/{endTime} endpoints are exposed for display and composition and DO revert for a
///         nonexistent token. Everything is `virtual` so a clone can add renewal, URIs, or a
///         soulbound (non-transferable) twist without forking.
contract ExpirableToken is ERC721, Ownable, IERC7858 {
    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice The validity window per token: `[start, end)` in UNIX seconds. Set once at
    ///         {mintExpirable}, immutable after.
    mapping(uint256 tokenId => uint256 start) private _startTime;
    mapping(uint256 tokenId => uint256 end) private _endTime;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice An expirable token was minted with its (immutable) validity window.
    /// @param tokenId The freshly minted token.
    /// @param to The receiver.
    /// @param start The (inclusive) window start, UNIX seconds.
    /// @param end The (exclusive) window end, UNIX seconds.
    event ExpirableMinted(uint256 indexed tokenId, address indexed to, uint256 start, uint256 end);

    /// @notice A window was supplied with `start >= end` — a token that is never valid. Refused: a
    ///         zero-or-negative-length pass is almost certainly a caller bug, and allowing it would
    ///         mint an already-dead token.
    error ExpirableToken__InvalidWindow(uint256 start, uint256 end);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploy a fresh expirable collection. `owner_` is the sole mint authority (Ownable).
    /// @param name_ The ERC-721 collection name.
    /// @param symbol_ The ERC-721 collection symbol.
    /// @param owner_ The mint authority (non-zero — enforced by {Ownable}).
    constructor(string memory name_, string memory symbol_, address owner_)
        ERC721(name_, symbol_)
        Ownable(owner_)
    { }

    /*//////////////////////////////////////////////////////////////
                                  MINT
    //////////////////////////////////////////////////////////////*/

    /// @notice Mint expirable `tokenId` to `to` with an immutable validity window `[start, end)`. Only
    ///         the {Ownable} owner. Requires `start < end` (a positive-length window). Uses
    ///         `_safeMint`.
    /// @param to The receiver (must be able to accept ERC-721s).
    /// @param tokenId The token id to mint (must not already exist).
    /// @param start The (inclusive) window start, UNIX seconds.
    /// @param end The (exclusive) window end, UNIX seconds. Must satisfy `start < end`.
    function mintExpirable(address to, uint256 tokenId, uint256 start, uint256 end)
        external
        virtual
        onlyOwner
    {
        if (start >= end) revert ExpirableToken__InvalidWindow(start, end);
        _startTime[tokenId] = start;
        _endTime[tokenId] = end;
        _safeMint(to, tokenId);
        emit TokenExpiryUpdated(tokenId, start, end);
        emit ExpirableMinted(tokenId, to, start, end);
    }

    /*//////////////////////////////////////////////////////////////
                             ERC-7858 SURFACE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC7858
    /// @dev This preset is TIME_BASED — `startTime`/`endTime` are UNIX seconds, compared against
    ///      `block.timestamp`. A BLOCKS_BASED clone overrides this and {isTokenValid}.
    function expiryType() public view virtual returns (EXPIRY_TYPE) {
        return EXPIRY_TYPE.TIME_BASED;
    }

    /// @inheritdoc IERC7858
    /// @dev Never reverts: a nonexistent token reads as `false` (it owns no window). Half-open window,
    ///      so a token is valid from `start` up to (but not including) `end`.
    function isTokenValid(uint256 tokenId) public view virtual returns (bool) {
        if (_ownerOf(tokenId) == address(0)) return false;
        return _startTime[tokenId] <= block.timestamp && block.timestamp < _endTime[tokenId];
    }

    /// @inheritdoc IERC7858
    /// @dev Reverts for a nonexistent token via `_requireOwned` (the raw endpoint, for display).
    function startTime(uint256 tokenId) public view virtual returns (uint256) {
        _requireOwned(tokenId);
        return _startTime[tokenId];
    }

    /// @inheritdoc IERC7858
    /// @dev Reverts for a nonexistent token via `_requireOwned` (the raw endpoint, for display).
    function endTime(uint256 tokenId) public view virtual returns (uint256) {
        _requireOwned(tokenId);
        return _endTime[tokenId];
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    /// @notice ERC-165 detection: true for {IERC7858} (computed from this repo's interface, never a
    ///         hand-copied magic constant that could drift) plus everything the OZ ERC-721 base
    ///         advertises (IERC721, IERC721Metadata, IERC165).
    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC721, IERC165)
        returns (bool)
    {
        return interfaceId == type(IERC7858).interfaceId || super.supportsInterface(interfaceId);
    }
}
