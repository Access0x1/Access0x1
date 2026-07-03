// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC7943NonFungible } from "./interfaces/IERC7943NonFungible.sol";

/// @title  Access0x1RwaToken
/// @author Access0x1
/// @notice A VANILLA, CLONEABLE compliant real-world-asset NFT: a plain OZ ERC-721 underneath, with
///         the ERC-7943 (uRWA) NonFungible compliance surface bolted on top — per-tokenId freezing,
///         authorized `forcedTransfer` (court order / lost-key recovery), and `canSend`/`canReceive`
///         policy gates enforced on EVERY mint and transfer. One token = one asset (a property, a
///         deed, an instrument); the contract records and gates the asset, nothing more.
/// @dev    REUSABLE-BASE RULES (nothing privileged, nothing hardcoded):
///           - The admin is a CONSTRUCTOR PARAM. It receives only `DEFAULT_ADMIN_ROLE` and from
///             there grants the five operational roles ({MINTER_ROLE}, {BURNER_ROLE},
///             {FREEZER_ROLE}, {WHITELIST_ROLE}, {FORCE_TRANSFER_ROLE}) to whatever regulator /
///             issuer / registrar set a deployment chooses. No address is baked in; every clone
///             configures its own authority set.
///           - COMPLIANCE MECHANISM IS THE IMPLEMENTER'S: ERC-7943 deliberately mandates no identity
///             registry. This base ships the simplest honest reference — a {WHITELIST_ROLE}-managed
///             allowlist backing {canSend}/{canReceive}. Both are `virtual`; a deployment with real
///             KYC/KYB (registry contract, oracle, signature check) overrides them and inherits the
///             enforcement below unchanged. "ERC-7943 compliant" says nothing about HOW compliance
///             is decided — this contract's answer is: allowlist by default, yours by override.
///         ENFORCEMENT lives in {_update} (the single OZ 5.x transfer choke-point), so plain
///         transfers, approved-operator transfers, and safe-transfers are all gated identically:
///         mint requires `canReceive(to)`; a wallet-to-wallet transfer requires `canSend(from)`,
///         `canReceive(to)`, and the token NOT frozen for `from`. {forcedTransfer} deliberately
///         BYPASSES the sender-side gate and the freeze (unfreezing FIRST, then moving — the seizure
///         must not be blockable by the very freeze the same authority set) but still honors
///         `canReceive(to)`: seized assets can only land on a compliant receiver. {burn} is a
///         {BURNER_ROLE} authority action (asset retired from the registry) and clears any frozen
///         flag as hygiene. The views {canSend}/{canReceive}/{canTransfer}/{getFrozenTokens} never
///         revert and never write storage (uRWA composability contract).
///         KNOWN uRWA SEMANTICS (documented, not bugs): {setFrozenTokens} has overwrite
///         (approve-like) semantics — treat updates like allowance updates; freezes are keyed by
///         (account, tokenId) and MAY be set for a token the account does not hold; there is no
///         whole-account kill-switch — "freeze this investor entirely" is expressed by removing them
///         from the allowlist, which blocks their sends AND receives.
contract Access0x1RwaToken is ERC721, AccessControl, IERC7943NonFungible {
    /*//////////////////////////////////////////////////////////////
                                 ROLES
    //////////////////////////////////////////////////////////////*/

    /// @notice May mint new asset tokens (to allowed receivers only — {canReceive} still gates).
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice May retire (burn) asset tokens — an authority action, not a holder right.
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    /// @notice May freeze/unfreeze individual tokenIds via {setFrozenTokens}.
    bytes32 public constant FREEZER_ROLE = keccak256("FREEZER_ROLE");

    /// @notice May manage the reference allowlist behind {canSend}/{canReceive}.
    bytes32 public constant WHITELIST_ROLE = keccak256("WHITELIST_ROLE");

    /// @notice May execute {forcedTransfer} — the regulatory seizure / recovery path.
    bytes32 public constant FORCE_TRANSFER_ROLE = keccak256("FORCE_TRANSFER_ROLE");

    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice The reference compliance allowlist backing {canSend}/{canReceive}. Managed by
    ///         {WHITELIST_ROLE}; a deployment with a real identity mechanism overrides the views and
    ///         may leave this list unused.
    mapping(address account => bool allowed) private _whitelisted;

    /// @notice Frozen flags, keyed by (account, tokenId) exactly as the standard specifies — a flag
    ///         MAY exist for a token the account does not currently hold ({getFrozenTokens} gotcha).
    ///         Only the flag keyed by the CURRENT owner blocks a transfer.
    mapping(address account => mapping(uint256 tokenId => bool frozen)) private _frozenTokens;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice The reference allowlist changed for `account` (now allowed to send AND receive, or
    ///         neither). Implementation-specific — NOT part of the ERC-7943 surface.
    event Whitelisted(address indexed account, bool allowed);

    /// @notice A zero address was supplied where a non-zero one is required (admin at construction,
    ///         allowlist entries). The zero address must never become an allowed endpoint — mint and
    ///         burn are the only paths that may touch it, and they are role-gated.
    error Access0x1RwaToken__ZeroAddress();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploy a fresh compliant-asset registry. `admin_` is the ONLY configured authority:
    ///         it holds `DEFAULT_ADMIN_ROLE` and grants/revokes the operational roles per its own
    ///         governance. The deployer keeps nothing unless it IS the admin.
    /// @param name_   The ERC-721 collection name.
    /// @param symbol_ The ERC-721 collection symbol.
    /// @param admin_  The role admin (non-zero). Receives `DEFAULT_ADMIN_ROLE` only — operational
    ///                roles are granted explicitly so separation of duties is a choice, not a leak.
    constructor(string memory name_, string memory symbol_, address admin_) ERC721(name_, symbol_) {
        if (admin_ == address(0)) revert Access0x1RwaToken__ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
    }

    /*//////////////////////////////////////////////////////////////
                             ISSUE / RETIRE
    //////////////////////////////////////////////////////////////*/

    /// @notice Mint asset token `tokenId` to `to`. Only {MINTER_ROLE}; the receiver must clear
    ///         {canReceive} (enforced in {_update}) — an asset can never be issued to a
    ///         non-compliant holder.
    /// @param to      The receiver (must be allowed by {canReceive}).
    /// @param tokenId The asset id to mint (must not already exist).
    function mint(address to, uint256 tokenId) external onlyRole(MINTER_ROLE) {
        _safeMint(to, tokenId);
    }

    /// @notice Retire asset token `tokenId`. Only {BURNER_ROLE} — burning is an authority action
    ///         (asset redeemed / de-tokenized), not a holder right, so it is NOT blocked by a
    ///         freeze; any frozen flag on the current owner is cleared first (no stale flags).
    /// @param tokenId The asset id to burn (must exist).
    function burn(uint256 tokenId) external onlyRole(BURNER_ROLE) {
        address owner = _requireOwned(tokenId);
        if (_frozenTokens[owner][tokenId]) {
            _frozenTokens[owner][tokenId] = false;
            emit Frozen(owner, tokenId, false);
        }
        _burn(tokenId);
    }

    /*//////////////////////////////////////////////////////////////
                        ERC-7943 (uRWA) SURFACE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC7943NonFungible
    /// @dev Only {FORCE_TRANSFER_ROLE}. Deliberately bypasses `canSend(from)`, the frozen flag, AND
    ///      ERC-721 approvals (a seizure needs no consent) — but `canReceive(to)` is still enforced,
    ///      so a seized asset can only land on a compliant receiver. UNFREEZE-BEFORE-TRANSFER
    ///      ordering: the frozen flag is cleared (with its {Frozen} event) BEFORE the move, so the
    ///      seizure cannot be blocked by the freeze and no stale flag survives on the old owner. The
    ///      move calls `super._update` — the raw OZ transfer — INTENTIONALLY skipping this
    ///      contract's {_update} compliance override; the bypass is this function's documented
    ///      contract, not an accident.
    function forcedTransfer(address from, address to, uint256 tokenId)
        external
        onlyRole(FORCE_TRANSFER_ROLE)
        returns (bool result)
    {
        if (!canReceive(to)) revert ERC7943CannotReceive(to);
        address owner = _ownerOf(tokenId);
        if (owner == address(0)) revert ERC721NonexistentToken(tokenId);
        if (owner != from) revert ERC721IncorrectOwner(from, tokenId, owner);

        if (_frozenTokens[from][tokenId]) {
            _frozenTokens[from][tokenId] = false;
            emit Frozen(from, tokenId, false);
        }

        // Raw OZ transfer (auth = 0 ⇒ no approval check), bypassing the compliance _update above.
        super._update(to, tokenId, address(0));

        emit ForcedTransfer(from, to, tokenId);
        return true;
    }

    /// @inheritdoc IERC7943NonFungible
    /// @dev Only {FREEZER_ROLE}. OVERWRITE (approve-like) semantics per the standard — the same
    ///      front-running window as ERC-20 `approve`; treat updates like allowance updates. The flag
    ///      is keyed by (account, tokenId) and MAY be set while `account` does not hold the token
    ///      (spec-allowed); it only blocks transfers when `account` is the current owner.
    function setFrozenTokens(address account, uint256 tokenId, bool frozenStatus)
        external
        onlyRole(FREEZER_ROLE)
        returns (bool result)
    {
        if (account == address(0)) revert Access0x1RwaToken__ZeroAddress();
        _frozenTokens[account][tokenId] = frozenStatus;
        emit Frozen(account, tokenId, frozenStatus);
        return true;
    }

    /// @inheritdoc IERC7943NonFungible
    /// @dev Reference default: the {WHITELIST_ROLE}-managed allowlist. `virtual` — override with a
    ///      real identity/KYC mechanism; MUST NOT revert and MUST NOT write storage.
    function canSend(address account) public view virtual returns (bool allowed) {
        return _whitelisted[account];
    }

    /// @inheritdoc IERC7943NonFungible
    /// @dev Reference default: the {WHITELIST_ROLE}-managed allowlist. `virtual` — override with a
    ///      real identity/KYC mechanism; MUST NOT revert and MUST NOT write storage.
    function canReceive(address account) public view virtual returns (bool allowed) {
        return _whitelisted[account];
    }

    /// @inheritdoc IERC7943NonFungible
    function getFrozenTokens(address account, uint256 tokenId)
        external
        view
        returns (bool frozenStatus)
    {
        return _frozenTokens[account][tokenId];
    }

    /// @inheritdoc IERC7943NonFungible
    /// @dev The composite view of the {_update} transfer gate: true iff `from` currently owns
    ///      `tokenId` AND may send AND `to` may receive AND the token is not frozen for `from`.
    ///      Never reverts (uses `_ownerOf`, which returns zero for a nonexistent token, so a
    ///      nonexistent id simply yields false) and never writes storage — safe to staticcall.
    function canTransfer(address from, address to, uint256 tokenId)
        public
        view
        virtual
        returns (bool allowed)
    {
        return from != address(0) && _ownerOf(tokenId) == from && canSend(from) && canReceive(to)
            && !_frozenTokens[from][tokenId];
    }

    /*//////////////////////////////////////////////////////////////
                         REFERENCE ALLOWLIST
    //////////////////////////////////////////////////////////////*/

    /// @notice Add/remove `account` on the reference allowlist behind {canSend}/{canReceive}. Only
    ///         {WHITELIST_ROLE}. The zero address is refused so it can never become an allowed
    ///         endpoint (mint/burn touch it only through their role-gated paths).
    /// @param account The account whose allow status changes (non-zero).
    /// @param allowed True to allow sending and receiving, false to block both.
    function setWhitelisted(address account, bool allowed) external onlyRole(WHITELIST_ROLE) {
        if (account == address(0)) revert Access0x1RwaToken__ZeroAddress();
        _whitelisted[account] = allowed;
        emit Whitelisted(account, allowed);
    }

    /// @notice Whether `account` is on the reference allowlist (the raw list — {canSend}/
    ///         {canReceive} are the policy views a consumer should use).
    /// @param account The account to look up.
    /// @return allowed The current allowlist flag.
    function isWhitelisted(address account) external view returns (bool allowed) {
        return _whitelisted[account];
    }

    /*//////////////////////////////////////////////////////////////
                              ENFORCEMENT
    //////////////////////////////////////////////////////////////*/

    /// @dev The single OZ 5.x transfer choke-point — every mint, burn, plain transfer, approved-
    ///      operator transfer, and safe-transfer funnels through here, so the compliance gate cannot
    ///      be side-stepped via an alternate ERC-721 entry point. Branches:
    ///        BURN     (`to == 0`)   — no endpoint rules here; {burn} already gates by
    ///                                 {BURNER_ROLE} and clears the frozen flag.
    ///        MINT     (`from == 0`) — the receiver must clear {canReceive} (no sender exists).
    ///        TRANSFER (both non-0)  — `canSend(from)` + `canReceive(to)` + token NOT frozen for
    ///                                 `from`, reverting with the standard's granular errors.
    ///      {forcedTransfer} does NOT pass through this override — it calls `super._update`
    ///      directly (documented bypass of the sender-side gate + freeze).
    function _update(address to, uint256 tokenId, address auth)
        internal
        virtual
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (to == address(0)) {
            // Burn — authority-gated upstream; nonexistent ids revert inside super (OZ semantics).
        } else if (from == address(0)) {
            // Mint — the new holder must be a compliant receiver.
            if (!canReceive(to)) revert ERC7943CannotReceive(to);
        } else {
            // Wallet-to-wallet transfer — both endpoints allowed, token unfrozen for the sender.
            if (!canSend(from)) revert ERC7943CannotSend(from);
            if (!canReceive(to)) revert ERC7943CannotReceive(to);
            if (_frozenTokens[from][tokenId]) {
                revert ERC7943InsufficientUnfrozenBalance(from, tokenId);
            }
        }
        return super._update(to, tokenId, auth);
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    /// @notice ERC-165 detection: true for {IERC7943NonFungible} (`0xbf1ef5fe` — required by the
    ///         standard), plus everything the OZ bases advertise (IERC721, IERC721Metadata,
    ///         IAccessControl, IERC165).
    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC721, AccessControl, IERC165)
        returns (bool)
    {
        return interfaceId == type(IERC7943NonFungible).interfaceId
            || super.supportsInterface(interfaceId);
    }
}
