// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { Access0x1RwaToken } from "../Access0x1RwaToken.sol";

/// @title  DeedToken
/// @author Access0x1
/// @notice A VANILLA, CLONEABLE real-world-asset DEED on the ERC-7943 (uRWA) base: it INHERITS the full
///         compliance surface of {Access0x1RwaToken} — per-token freezing, authorized `forcedTransfer`
///         (court order / recovery), and `canSend`/`canReceive` policy gates enforced on every mint and
///         transfer — and adds the two things a deed needs on top: per-token metadata (a parcel/registry
///         reference + a document URI) and an OPTIONAL, param'd FRACTIONALIZATION hook. One token = one
///         titled asset (a property, a parcel, a vehicle title); compliance-gated transfers are the base's
///         job, this contract records the deed and the (un)lock that fractionalization needs.
/// @dev    REUSABLE-BASE RULES (inherited + extended, nothing hardcoded):
///           - Everything about authority is the base's: `admin_` (constructor param) holds
///             `DEFAULT_ADMIN_ROLE` and grants {MINTER_ROLE}/{BURNER_ROLE}/{FREEZER_ROLE}/
///             {WHITELIST_ROLE}/{FORCE_TRANSFER_ROLE}. `canSend`/`canReceive` default to the base's
///             reference allowlist and are `virtual` — a deployment with a real property-registry KYC
///             overrides them and inherits enforcement unchanged.
///           - FRACTIONALIZATION is a PARAM'D HOOK, not a baked-in vault. The admin sets a single
///             `fractionalizer` address (an external ERC-20 fractional-wrapper factory of the clone's
///             choice, or `address(0)` to disable). When set, ONLY that address may {lockForFraction} a
///             deed (the holder must first consent by approving the fractionalizer for the token, exactly
///             like any ERC-721 escrow) — the deed transfers into the fractionalizer, which mints the
///             fractional ERC-20 supply. {redeemFromFraction} is the inverse: the fractionalizer returns
///             the whole deed to a compliant holder after burning the fractional supply. The wrapper's
///             economics live in the external contract; this base only records that a deed is currently
///             fraction-locked, so the metadata layer and off-chain indexers can reflect it.
///         The lock is expressed purely through OWNERSHIP + a `fractionLocked` flag: a locked deed is
///         held by the `fractionalizer` and cannot be re-locked. Compliance still applies — the
///         fractionalizer itself must be a `canReceive` endpoint, so a deed can only fractionalize into a
///         compliant wrapper. No new custody, no new money path.
contract DeedToken is Access0x1RwaToken {
    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice The external ERC-20 fractional-wrapper factory allowed to (un)lock deeds, or
    ///         `address(0)` to disable fractionalization entirely (the default). Admin-set.
    address public fractionalizer;

    /// @notice tokenId ⇒ the deed's document/metadata URI (a title deed scan, a registry link).
    mapping(uint256 tokenId => string uri) private _deedURI;

    /// @notice tokenId ⇒ an opaque off-chain registry/parcel reference (a title number hash, a VIN
    ///         hash). Recorded at mint, immutable — the on-chain commitment to the real asset.
    mapping(uint256 tokenId => bytes32 ref) private _registryRef;

    /// @notice tokenId ⇒ currently fraction-locked (held by the `fractionalizer`, fractional ERC-20
    ///         supply outstanding). Set by {lockForFraction}, cleared by {redeemFromFraction}.
    mapping(uint256 tokenId => bool locked) private _fractionLocked;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice The fractionalizer factory address changed (`address(0)` disables fractionalization).
    event FractionalizerSet(address indexed oldFractionalizer, address indexed newFractionalizer);

    /// @notice A deed was minted with its registry reference and (optional) URI.
    event DeedMinted(uint256 indexed tokenId, address indexed to, bytes32 registryRef);

    /// @notice Deed `tokenId` was locked into the fractionalizer (fractional supply now outstanding).
    event DeedFractionLocked(uint256 indexed tokenId, address indexed fractionalizer);

    /// @notice Deed `tokenId` was redeemed out of the fractionalizer back to a compliant holder.
    event DeedFractionRedeemed(uint256 indexed tokenId, address indexed to);

    /// @notice Fractionalization is disabled (`fractionalizer == address(0)`) or the caller is not it.
    error DeedToken__NotFractionalizer(address caller);

    /// @notice The deed is already fraction-locked.
    error DeedToken__AlreadyLocked(uint256 tokenId);

    /// @notice The deed is not fraction-locked (nothing to redeem).
    error DeedToken__NotLocked(uint256 tokenId);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploy a fresh deed registry. Forwards to the uRWA base (name/symbol/admin); the
    ///         `fractionalizer` starts unset (fractionalization disabled until the admin configures it).
    /// @param name_   The ERC-721 collection name.
    /// @param symbol_ The ERC-721 collection symbol.
    /// @param admin_  The role admin (non-zero) — receives `DEFAULT_ADMIN_ROLE` only (base rule).
    constructor(string memory name_, string memory symbol_, address admin_)
        Access0x1RwaToken(name_, symbol_, admin_)
    { }

    /*//////////////////////////////////////////////////////////////
                              ISSUE (with deed data)
    //////////////////////////////////////////////////////////////*/

    /// @notice Mint a deed with its registry reference + document URI. Only {MINTER_ROLE}; the receiver
    ///         must clear `canReceive` (enforced by the base's `_update`). The registry ref and URI are
    ///         written once, before the mint.
    /// @param to          The receiver (must be a compliant `canReceive` endpoint).
    /// @param tokenId     The deed id (must not already exist).
    /// @param registryRef Opaque off-chain registry/parcel reference (title number hash, VIN hash).
    /// @param uri_        The deed document/metadata URI (may be empty).
    function mintDeed(address to, uint256 tokenId, bytes32 registryRef, string calldata uri_)
        external
        onlyRole(MINTER_ROLE)
    {
        _registryRef[tokenId] = registryRef;
        if (bytes(uri_).length != 0) _deedURI[tokenId] = uri_;
        emit DeedMinted(tokenId, to, registryRef);
        // `_safeMint` funnels through the base's `_update` compliance gate (receiver must `canReceive`),
        // so this is the SAME compliance path the base's public `mint` takes — the `onlyRole(MINTER_ROLE)`
        // modifier above is the identical authority gate. We call the internal directly because the
        // base's `mint` is `external` (not callable as an internal function).
        _safeMint(to, tokenId);
    }

    /*//////////////////////////////////////////////////////////////
                              ADMIN: FRACTIONALIZER
    //////////////////////////////////////////////////////////////*/

    /// @notice Set (or clear) the external fractional-wrapper factory. Only `DEFAULT_ADMIN_ROLE`.
    ///         `address(0)` disables fractionalization. A non-zero fractionalizer SHOULD be a compliant
    ///         `canReceive` endpoint (the deed locks INTO it and the base's compliance gate enforces
    ///         that at lock time), so a clone's whitelist must include it.
    /// @param newFractionalizer The fractional-wrapper factory, or `address(0)` to disable.
    // slither-disable-next-line missing-zero-check
    function setFractionalizer(address newFractionalizer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit FractionalizerSet(fractionalizer, newFractionalizer);
        fractionalizer = newFractionalizer;
    }

    /*//////////////////////////////////////////////////////////////
                             FRACTIONALIZATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Lock a deed into the fractionalizer (which then mints the fractional ERC-20 supply). Only
    ///         the configured `fractionalizer` may call, and only after the current holder has approved
    ///         it for the token (standard ERC-721 escrow consent) — so a holder must actively opt in;
    ///         the fractionalizer cannot seize an un-approved deed. Records the lock and pulls the deed
    ///         to itself via the base transfer (compliance-gated: the fractionalizer must be a
    ///         `canReceive` endpoint, and the holder a `canSend` one).
    /// @param tokenId The deed to fraction-lock (must exist, not already locked).
    /// @param holder  The current owner consenting to the lock (must own `tokenId`).
    function lockForFraction(uint256 tokenId, address holder) external {
        if (msg.sender != fractionalizer || fractionalizer == address(0)) {
            revert DeedToken__NotFractionalizer(msg.sender);
        }
        if (_fractionLocked[tokenId]) revert DeedToken__AlreadyLocked(tokenId);
        _fractionLocked[tokenId] = true;
        emit DeedFractionLocked(tokenId, msg.sender);
        // Pull the deed from the consenting holder into the fractionalizer. `safeTransferFrom` runs the
        // base's compliance `_update` (holder canSend, fractionalizer canReceive, token unfrozen) and
        // requires the fractionalizer be approved by `holder` — the opt-in. The fractionalizer mints
        // the fractional supply in its own contract after this returns.
        safeTransferFrom(holder, msg.sender, tokenId);
    }

    /// @notice Redeem a whole deed out of the fractionalizer back to a compliant holder (after the
    ///         fractionalizer has burned the fractional supply in its own contract). Only the
    ///         `fractionalizer` may call; it must currently hold the deed. Clears the lock and transfers
    ///         the deed to `to` (compliance-gated: `to` must be a `canReceive` endpoint).
    /// @param tokenId The deed to redeem (must be locked and held by the fractionalizer).
    /// @param to      The compliant receiver of the whole deed.
    function redeemFromFraction(uint256 tokenId, address to) external {
        if (msg.sender != fractionalizer || fractionalizer == address(0)) {
            revert DeedToken__NotFractionalizer(msg.sender);
        }
        if (!_fractionLocked[tokenId]) revert DeedToken__NotLocked(tokenId);
        _fractionLocked[tokenId] = false;
        emit DeedFractionRedeemed(tokenId, to);
        // Transfer the deed from the fractionalizer (the caller/owner) to the compliant receiver. The
        // base `_update` enforces `canReceive(to)`.
        safeTransferFrom(msg.sender, to, tokenId);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Whether deed `tokenId` is currently fraction-locked.
    /// @param tokenId The deed id.
    /// @return Whether it is locked in the fractionalizer.
    function isFractionLocked(uint256 tokenId) external view returns (bool) {
        return _fractionLocked[tokenId];
    }

    /// @notice The opaque off-chain registry/parcel reference recorded for deed `tokenId`.
    /// @param tokenId The deed id.
    /// @return The registry reference (zero if never set).
    function registryRefOf(uint256 tokenId) external view returns (bytes32) {
        return _registryRef[tokenId];
    }

    /// @inheritdoc ERC721
    /// @dev The deed document/metadata URI set at mint (empty if none). Reverts for a nonexistent deed.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _deedURI[tokenId];
    }

    // supportsInterface + all compliance surface (forcedTransfer, freeze, canSend/canReceive/
    // canTransfer, the allowlist, the _update gate, ERC-165) are inherited UNCHANGED from
    // {Access0x1RwaToken} — a DeedToken is a fully ERC-7943-compliant uRWA token by inheritance.
}
