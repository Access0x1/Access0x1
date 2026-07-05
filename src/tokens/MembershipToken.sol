// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC1155 } from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title  MembershipToken
/// @author Access0x1
/// @notice A VANILLA, CLONEABLE creator/subscription MEMBERSHIP as an ERC-1155: each token `id` is a
///         TIER, a member holds a per-tier balance, and each (member, tier) carries a TIME-BOXED
///         validity (`validUntil`). Minting a membership sets/extends that member's expiry for the tier;
///         a lapsed membership still exists as a token but reads {isActive} == false until renewed. A
///         tier may be SOULBOUND (non-transferable — a personal membership) or freely transferable (a
///         tradeable pass), configured per tier. The contract records tiers + memberships and NOTHING
///         about money movement: the recurring charge is settled by the shared {Access0x1Router}
///         (USD→token, fee-split, zero-custody), and this token exposes a PURE {quoteSplit} that mirrors
///         the router's exact floor-bps fee model so a clone declares its platform/creator split with
///         the SAME arithmetic — never a re-implemented, drift-prone copy.
/// @dev    REUSABLE-BASE RULES (nothing privileged, nothing hardcoded):
///           - `admin_` (constructor param) holds only `DEFAULT_ADMIN_ROLE`; it grants {MINTER_ROLE}
///             (the router-settled renewal leg) and {MANAGER_ROLE} (tier config) per its own governance.
///           - The platform fee is a PARAM: `platformFeeBps` (≤ `MAX_FEE_BPS`, the same 10% ceiling and
///             10_000 denominator as the router) + `platformTreasury`, both admin-settable. They are
///             DECLARATIVE — this contract moves no funds — so a clone reads {quoteSplit} to settle the
///             creator/platform split through the router with matching math. NO address is baked in.
///           - Tiers are created by {MANAGER_ROLE}: each has a `price` (USD 8-decimals, the estate's
///             `usdAmount8`), a `period` (validity seconds granted per mint), a `soulbound` flag, and a
///             metadata `uri`. Price/period/soulbound are the creator's knobs; nothing is fixed.
///         ENFORCEMENT lives in {_update} (ERC-1155's single transfer choke-point): MINT (`from == 0`)
///         and BURN (`to == 0`) always pass; a soulbound tier reverts any wallet-to-wallet transfer.
///         Expiry is a READ-TIME view derived from stored state — no money path and no cron ever writes
///         "active": {isActive} compares `validUntil` to `block.timestamp`, so a renewal simply pushes
///         the timestamp forward and re-unlocks with no sweep.
contract MembershipToken is ERC1155, AccessControl {
    using Math for uint256;

    /*//////////////////////////////////////////////////////////////
                                 ROLES
    //////////////////////////////////////////////////////////////*/

    /// @notice May mint/renew memberships — the router-settled charge leg (or a manual grant).
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice May create/configure tiers and set the platform fee params.
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

    /*//////////////////////////////////////////////////////////////
                                 CONFIG
    //////////////////////////////////////////////////////////////*/

    /// @notice Basis-point denominator (10_000 = 100%) — identical to the router's fee model.
    uint16 public constant FEE_DENOMINATOR = 10_000;

    /// @notice Hard ceiling on the declared platform fee: 10% (1000 bps). Matches the router's ceiling,
    ///         so no clone can declare a confiscatory split.
    uint16 public constant MAX_FEE_BPS = 1000;

    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice A membership tier. Immutable fields (`price`, `period`, `soulbound`) are the creator's
    ///         product config; `exists` distinguishes a created tier from an unset id.
    struct Tier {
        uint256 price; // USD price of one period, 8 decimals (usdAmount8); 0 = free tier
        uint64 period; // validity seconds granted per mint (must be > 0 for a created tier)
        bool soulbound; // true ⇒ non-transferable (personal membership)
        bool exists; // set true at creation; false = tier id never created
    }

    /// @notice tierId ⇒ its config. Public getter for the frontend/SDK.
    mapping(uint256 tierId => Tier tier) public tiers;

    /// @notice member ⇒ tierId ⇒ unix time the membership is valid THROUGH. A mint sets it to
    ///         `max(now, current) + period` (renew extends, lapsed-then-renew restarts from now).
    mapping(address member => mapping(uint256 tierId => uint64 validUntil)) private _validUntil;

    /// @notice tierId ⇒ per-tier metadata URI (overrides the base ERC-1155 uri for that id).
    mapping(uint256 tierId => string uri) private _tierURI;

    /// @notice The declared platform fee in bps (the split a clone settles through the router with).
    uint16 public platformFeeBps;

    /// @notice Where the declared platform fee leg is intended to settle (informational — no funds move
    ///         through this contract).
    address public platformTreasury;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice A tier was created or reconfigured.
    event TierSet(uint256 indexed tierId, uint256 price, uint64 period, bool soulbound);

    /// @notice A membership was minted/renewed: `member` is valid through `validUntil` for `tierId`.
    event MembershipMinted(
        address indexed member, uint256 indexed tierId, uint256 amount, uint64 validUntil
    );

    /// @notice The declared platform fee params changed.
    event PlatformFeeSet(uint16 feeBps, address indexed treasury);

    /// @notice A zero address was supplied where a non-zero one is required.
    error MembershipToken__ZeroAddress();

    /// @notice The requested fee exceeds `MAX_FEE_BPS`.
    error MembershipToken__FeeTooHigh(uint16 requested, uint16 max);

    /// @notice A tier was referenced that was never created.
    error MembershipToken__TierNotFound(uint256 tierId);

    /// @notice A tier was created with a zero validity period (a membership must last some time).
    error MembershipToken__ZeroPeriod();

    /// @notice A transfer was attempted on a soulbound tier (personal, non-transferable membership).
    error MembershipToken__Soulbound(uint256 tierId);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploy a fresh membership collection. `admin_` is the only configured authority. The
    ///         platform fee params are set from constructor params (`platformFeeBps_` ≤ `MAX_FEE_BPS`);
    ///         a zero treasury is allowed at construction (a free / no-fee product) and set later.
    /// @param baseUri_         The ERC-1155 base URI (per-tier URIs override it).
    /// @param admin_           The role admin (non-zero). Receives `DEFAULT_ADMIN_ROLE` only.
    /// @param platformFeeBps_  The declared platform fee in bps (≤ `MAX_FEE_BPS`).
    /// @param platformTreasury_ Where the declared platform fee is intended to settle (may be zero).
    constructor(
        string memory baseUri_,
        address admin_,
        uint16 platformFeeBps_,
        address platformTreasury_
    ) ERC1155(baseUri_) {
        if (admin_ == address(0)) revert MembershipToken__ZeroAddress();
        if (platformFeeBps_ > MAX_FEE_BPS) {
            revert MembershipToken__FeeTooHigh(platformFeeBps_, MAX_FEE_BPS);
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        platformFeeBps = platformFeeBps_;
        platformTreasury = platformTreasury_;
        emit PlatformFeeSet(platformFeeBps_, platformTreasury_);
    }

    /*//////////////////////////////////////////////////////////////
                              TIER MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Create or reconfigure a tier. Only {MANAGER_ROLE}. `period` must be > 0 (a membership
    ///         must last some time). Reconfiguring an existing tier changes future mints only — it never
    ///         retroactively alters a member's already-granted `validUntil`.
    /// @param tierId    The tier id (also the ERC-1155 token id).
    /// @param price     USD price of one period, 8 decimals (0 = free tier).
    /// @param period    Validity seconds granted per mint (> 0).
    /// @param soulbound True ⇒ non-transferable.
    /// @param uri_       Per-tier metadata URI (empty ⇒ falls back to the base URI).
    function setTier(
        uint256 tierId,
        uint256 price,
        uint64 period,
        bool soulbound,
        string calldata uri_
    ) external onlyRole(MANAGER_ROLE) {
        if (period == 0) revert MembershipToken__ZeroPeriod();
        tiers[tierId] =
            Tier({ price: price, period: period, soulbound: soulbound, exists: true });
        if (bytes(uri_).length != 0) _tierURI[tierId] = uri_;
        emit TierSet(tierId, price, period, soulbound);
    }

    /// @notice Set the declared platform fee params (the split a clone settles through the router with).
    ///         Only `DEFAULT_ADMIN_ROLE`. `feeBps ≤ MAX_FEE_BPS`. No funds move here — this is the
    ///         DECLARATION the settlement layer reads; the router remains the single money authority.
    /// @param feeBps   The platform fee in bps (≤ `MAX_FEE_BPS`).
    /// @param treasury Where the fee leg is intended to settle (may be zero for a no-fee product).
    function setPlatformFee(uint16 feeBps, address treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeBps > MAX_FEE_BPS) revert MembershipToken__FeeTooHigh(feeBps, MAX_FEE_BPS);
        platformFeeBps = feeBps;
        platformTreasury = treasury;
        emit PlatformFeeSet(feeBps, treasury);
    }

    /*//////////////////////////////////////////////////////////////
                              MINT / RENEW
    //////////////////////////////////////////////////////////////*/

    /// @notice Mint/renew a membership. Only {MINTER_ROLE} (the router-settled charge leg or a grant).
    ///         Grants the tier's `period` of validity: extends from the later of now or the member's
    ///         current expiry, so a renewal before expiry ADDS a period and a renewal after a lapse
    ///         restarts from now (no lost or double-counted time). Also mints `amount` of the ERC-1155
    ///         balance (typically 1) as the on-chain membership receipt.
    /// @param to     The member (non-zero, must accept ERC-1155 via the receiver hook).
    /// @param tierId The tier to grant (must exist).
    /// @param amount The ERC-1155 balance to mint (usually 1).
    /// @return newValidUntil The member's new expiry for the tier.
    function mint(address to, uint256 tierId, uint256 amount)
        external
        onlyRole(MINTER_ROLE)
        returns (uint64 newValidUntil)
    {
        Tier storage t = tiers[tierId];
        if (!t.exists) revert MembershipToken__TierNotFound(tierId);

        uint64 current = _validUntil[to][tierId];
        uint64 base = current > block.timestamp ? current : uint64(block.timestamp);
        newValidUntil = base + t.period;
        _validUntil[to][tierId] = newValidUntil;

        emit MembershipMinted(to, tierId, amount, newValidUntil);
        _mint(to, tierId, amount, ""); // receiver-hook checked; reverts a non-accepting contract
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Whether `member` currently holds an ACTIVE membership in `tierId` — a positive balance
    ///         AND an unexpired `validUntil`. A lapsed membership reads false until renewed.
    /// @param member The account to check.
    /// @param tierId The tier.
    /// @return active True iff balance > 0 and `block.timestamp <= validUntil`.
    function isActive(address member, uint256 tierId) external view returns (bool active) {
        return balanceOf(member, tierId) > 0 && block.timestamp <= _validUntil[member][tierId];
    }

    /// @notice The unix time `member`'s membership in `tierId` is valid through (0 = never granted).
    /// @param member The account.
    /// @param tierId The tier.
    /// @return The `validUntil` timestamp.
    function validUntil(address member, uint256 tierId) external view returns (uint64) {
        return _validUntil[member][tierId];
    }

    /// @notice The DECLARED creator/platform fee split for a gross amount, using the router's EXACT
    ///         floor-bps arithmetic (`platformFee = gross · feeBps / 10_000`, floored; `creatorNet =
    ///         gross − platformFee`), so a clone settling through the router matches to the wei. Pure —
    ///         reads only the configured `platformFeeBps`. This is a QUOTE for the settlement layer; no
    ///         funds move in this contract.
    /// @param gross The gross amount (in whatever unit the settlement uses — token wei or usdAmount8).
    /// @return platformFee The platform's cut (floored).
    /// @return creatorNet  What the creator nets (`gross − platformFee`).
    function quoteSplit(uint256 gross)
        external
        view
        returns (uint256 platformFee, uint256 creatorNet)
    {
        platformFee = gross.mulDiv(platformFeeBps, FEE_DENOMINATOR);
        creatorNet = gross - platformFee;
    }

    /// @inheritdoc ERC1155
    /// @dev Returns the per-tier URI if set, else the base ERC-1155 URI (the `{id}`-templated default).
    function uri(uint256 tierId) public view override returns (string memory) {
        string memory tierUri = _tierURI[tierId];
        return bytes(tierUri).length != 0 ? tierUri : super.uri(tierId);
    }

    /*//////////////////////////////////////////////////////////////
                              ENFORCEMENT
    //////////////////////////////////////////////////////////////*/

    /// @dev The single ERC-1155 transfer choke-point. MINT (`from == 0`) and BURN (`to == 0`) always
    ///      pass — a grant or a giveback is never a "transfer". A wallet-to-wallet move (both non-zero)
    ///      of a SOULBOUND tier reverts, so a personal membership can never be traded while a
    ///      tradeable-pass tier moves freely. Batch transfers are gated per id.
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override
    {
        if (from != address(0) && to != address(0)) {
            for (uint256 i = 0; i < ids.length; ++i) {
                if (tiers[ids[i]].soulbound) revert MembershipToken__Soulbound(ids[i]);
            }
        }
        super._update(from, to, ids, values);
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC165
    /// @dev Unions the ERC-1155 + {AccessControl} interface ids.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
