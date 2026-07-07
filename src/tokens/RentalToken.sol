// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC4907 } from "../interfaces/IERC4907.sol";

/// @title  RentalToken
/// @author Access0x1
/// @notice A VANILLA, CLONEABLE ERC-4907 "rentable NFT": a plain OZ ERC-721 with a second, EXPIRING
///         role bolted on. Ownership (title) and USAGE (tenancy) are separated — the owner keeps the
///         token while granting a time-boxed "user" the right to enjoy the asset: rent a machine, lease
///         a venue slot, license a work, all WITHOUT surrendering ownership. `setUser(id, user,
///         expires)` grants the role until a UNIX instant; after it, {userOf} reads back as the zero
///         address with NO transaction required (lazy expiry — the tenancy just lapses).
/// @dev    REUSABLE-BASE RULES (nothing privileged, nothing hardcoded):
///           - Mint authority is the {Ownable} `owner`, a CONSTRUCTOR PARAM. No treasury/fee/address
///             is baked in; a clone configures its own owner.
///           - {setUser} authorization is the OZ ERC-721 spend gate (`_isAuthorized`): the token
///             owner OR an approved operator/spender may set the tenant — the same authority that
///             could transfer the token, which is the correct bar for granting usage of it. It is
///             `virtual` so a rental-marketplace clone can widen or narrow this (e.g. gate on an
///             escrow contract) without forking.
///           - USER ROLE CLEARS ON TRANSFER: a sale of the underlying asset ends the tenancy. The
///             clear happens in {_update} (the single OZ 5.x transfer choke-point) so plain,
///             approved-operator, and safe transfers all end the lease identically — and a {UpdateUser}
///             clear event is emitted only when a user was actually set (no noise on mint or on a
///             transfer of an unrented token).
///         LAZY EXPIRY: storage is never rewritten when a lease lapses — {userOf} compares the stored
///         `expires` against `block.timestamp` and returns zero once past. So {userExpires} may report
///         a nonzero (past) value for a token whose {userOf} already reads zero; that is the standard's
///         intended behavior (the record persists until overwritten). Everything is `virtual` so a
///         clone can layer rent collection, royalties, or URIs on top.
contract RentalToken is ERC721, Ownable, IERC4907 {
    /*//////////////////////////////////////////////////////////////
                                 TYPES / STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice The tenant record for a token: who may use it, and until when (UNIX seconds).
    /// @param user The current tenant (zero if none).
    /// @param expires The UNIX instant after which the tenancy lapses.
    struct UserInfo {
        address user;
        uint64 expires;
    }

    /// @notice Tenant record per token. A token with no active tenant has a zeroed record; a lapsed
    ///         tenancy keeps its (stale) record until overwritten or the token transfers.
    mapping(uint256 tokenId => UserInfo info) private _users;

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice A tenancy was set with an `expires` already in the past — a lease that is dead on
    ///         arrival. Refused so {userOf} can never disagree with the emitted {UpdateUser} the
    ///         instant it is set.
    error RentalToken__ExpiryInPast(uint64 expires, uint256 nowTime);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploy a fresh rentable collection. `owner_` is the sole mint authority (Ownable).
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

    /// @notice Mint asset `tokenId` to `to`. Only the {Ownable} owner. Uses `_safeMint`, so a contract
    ///         receiver must implement {IERC721Receiver}. A freshly minted token has no tenant.
    /// @param to The receiver (must be able to accept ERC-721s).
    /// @param tokenId The asset id to mint (must not already exist).
    function mint(address to, uint256 tokenId) external virtual onlyOwner {
        _safeMint(to, tokenId);
    }

    /*//////////////////////////////////////////////////////////////
                             ERC-4907 SURFACE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC4907
    /// @dev Authorized by the OZ ERC-721 spend gate: the owner or an approved spender/operator (the
    ///      same authority that could transfer the token). Setting `user == 0` explicitly ends a
    ///      tenancy (any `expires` is stored as-is but reads as no-user). A NON-zero `user` requires
    ///      `expires > block.timestamp` so the grant is live the moment it is recorded. Always emits
    ///      {UpdateUser}.
    function setUser(uint256 tokenId, address user, uint64 expires) public virtual {
        address owner = _requireOwned(tokenId);
        _checkAuthorized(owner, _msgSender(), tokenId);
        if (user != address(0) && expires <= block.timestamp) {
            revert RentalToken__ExpiryInPast(expires, block.timestamp);
        }
        _users[tokenId] = UserInfo({ user: user, expires: expires });
        emit UpdateUser(tokenId, user, expires);
    }

    /// @inheritdoc IERC4907
    /// @dev Lazy expiry: returns the stored user only while `expires >= block.timestamp`, else zero.
    ///      Never reverts — a nonexistent or unrented token reads as the zero address.
    function userOf(uint256 tokenId) public view virtual returns (address) {
        UserInfo storage info = _users[tokenId];
        if (info.expires >= block.timestamp) return info.user;
        return address(0);
    }

    /// @inheritdoc IERC4907
    /// @dev The RAW stored expiry — may report a past value for a token whose {userOf} already reads
    ///      zero (the record persists until overwritten). Never reverts.
    function userExpires(uint256 tokenId) public view virtual returns (uint256) {
        return _users[tokenId].expires;
    }

    /*//////////////////////////////////////////////////////////////
                              ENFORCEMENT
    //////////////////////////////////////////////////////////////*/

    /// @dev The single OZ 5.x transfer choke-point. On a real transfer (owner actually changes and it
    ///      is NOT a mint), any active tenant record is cleared and a `user == 0` {UpdateUser} is
    ///      emitted — a sale ends the lease. The clear is skipped when no user was set, so mints and
    ///      transfers of unrented tokens emit no spurious event. Runs BEFORE `super._update` moves the
    ///      token so `from` is still resolvable and the state is consistent for observers.
    function _update(address to, uint256 tokenId, address auth)
        internal
        virtual
        override
        returns (address from)
    {
        from = super._update(to, tokenId, auth);
        // Clear the tenancy only on a genuine ownership change (not a mint from address(0)), and only
        // when a user was actually set — avoids emitting a clear on every plain mint/transfer.
        if (from != address(0) && from != to && _users[tokenId].user != address(0)) {
            delete _users[tokenId];
            emit UpdateUser(tokenId, address(0), 0);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    /// @notice ERC-165 detection: true for {IERC4907} (`0xad092b5c` — pinned by the standard) plus
    ///         everything the OZ ERC-721 base advertises (IERC721, IERC721Metadata, IERC165).
    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC721, IERC165)
        returns (bool)
    {
        return interfaceId == type(IERC4907).interfaceId || super.supportsInterface(interfaceId);
    }
}
