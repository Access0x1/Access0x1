// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IERC5192
/// @author Access0x1
/// @notice The ERC-5192 Minimal Soulbound NFT interface (Final). A single view, {locked}, that MUST
///         return true for every existing token of a permanently non-transferable ("soulbound")
///         collection, plus the {Locked}/{Unlocked} events emitted at mint so indexers can classify a
///         token's transferability without a call.
/// @dev    Members are VERBATIM from EIP-5192, so the ERC-165 interface id is the standard one:
///         `0xb45a3c0e` (== the `locked(uint256)` selector, since the interface has exactly one
///         function). An implementer whose tokens are ALL permanently locked emits {Locked} on mint
///         and never {Unlocked}; this base does exactly that.
interface IERC5192 {
    /// @notice Emitted when the locking status of `tokenId` is set to locked (non-transferable).
    /// @dev    A permanently-soulbound collection emits this once, at mint, and never {Unlocked}.
    /// @param tokenId The token whose transfers are now locked.
    event Locked(uint256 tokenId);

    /// @notice Emitted when the locking status of `tokenId` is set to unlocked (transferable).
    /// @dev    Never emitted by a permanently-soulbound collection — declared for interface parity.
    /// @param tokenId The token whose transfers are now unlocked.
    event Unlocked(uint256 tokenId);

    /// @notice Whether `tokenId` is locked (non-transferable). MUST revert if `tokenId` does not exist.
    /// @param tokenId The token to query.
    /// @return True if the token is locked. A permanently-soulbound token is always locked.
    function locked(uint256 tokenId) external view returns (bool);
}

/// @title  ICredentialSbt
/// @author Access0x1
/// @notice Surface for CredentialSbt — a soulbound (ERC-5192), non-transferable ERC-721 verified-
///         credential badge with LEVELS. An issuer mints a badge to a SUBJECT under a `credentialType`
///         (a caller-chosen `bytes32` key, e.g. `keccak256("business-verified")`), so one contract
///         serves many credential kinds; each badge carries a `uint8 level` the issuer can raise or
///         lower, an optional `expiresAt`, and a revoked flag. Exactly one ACTIVE (unrevoked) badge may
///         exist per (subject, credentialType) pair. Badges are minted directly by an authorized issuer
///         OR claimed gaslessly by the subject from an issuer-signed EIP-712 voucher. A badge is
///         revoked (burned) by the issuer, or self-burned by the subject — a person may always renounce
///         their own credential. Transfers and approvals hard-revert (soulbound).
/// @dev    Custody: NONE — this is a pure attestation registry, no value transfer, no `payable`
///         function. The only external interaction is signature validation on the claim path (EOA,
///         ERC-1271, and ERC-6492 counterfactual smart accounts), which precedes every state change
///         (CEI). BURN-AUTH (ERC-5484 semantics) is expressed as: both the issuer (revocation) and the
///         subject (renunciation) may burn — a fixed policy chosen for a credential primitive rather
///         than a per-token `BurnAuth` enum, keeping the surface lean.
interface ICredentialSbt {
    // ──────────────────────── types ────────────────────────

    /// @notice The stored record backing an issued badge, keyed by tokenId.
    /// @param subject   The holder the credential is about (the ERC-721 owner of the tokenId).
    /// @param credType  The credential kind (caller-chosen key, e.g. keccak256("kyc-attested")).
    /// @param level     The credential level (issuer-defined; 1 = the lowest "verified" rung, higher =
    ///                  stronger). Never 0 for an existing badge — 0 is the "no badge" sentinel.
    /// @param issuedAt  The `block.timestamp` (unix seconds) the badge was minted.
    /// @param expiresAt The expiry (unix seconds); 0 means the badge never expires.
    /// @param revoked   True once the issuer has revoked the badge (a burned badge clears its record, so
    ///                  a live record is `revoked == false`; the flag exists for the transient in-burn
    ///                  read and for defensive validity checks).
    struct Credential {
        address subject;
        bytes32 credType;
        uint8 level;
        uint64 issuedAt;
        uint64 expiresAt;
        bool revoked;
    }

    // ──────────────────────── events ────────────────────────

    /// @notice A badge was issued to `subject` under `credType` at `level`, as tokenId `tokenId`.
    /// @param tokenId   The soulbound tokenId that now carries the credential.
    /// @param subject   The holder the credential is about.
    /// @param credType  The credential kind.
    /// @param level     The initial level.
    /// @param expiresAt The expiry (unix seconds); 0 = never expires.
    /// @param issuer    The account that authorized the issuance (the caller on the direct path, the
    ///                  recovered signer on the voucher path).
    event CredentialIssued(
        uint256 indexed tokenId,
        address indexed subject,
        bytes32 indexed credType,
        uint8 level,
        uint64 expiresAt,
        address issuer
    );

    /// @notice The level of an existing badge changed from `oldLevel` to `newLevel`.
    /// @param tokenId  The badge whose level changed.
    /// @param oldLevel The prior level.
    /// @param newLevel The new level (non-zero).
    event LevelChanged(uint256 indexed tokenId, uint8 oldLevel, uint8 newLevel);

    /// @notice A badge was revoked by the issuer (the tokenId is burned).
    /// @param tokenId  The revoked badge.
    /// @param subject  The holder the credential was about.
    /// @param credType The credential kind.
    event CredentialRevoked(
        uint256 indexed tokenId, address indexed subject, bytes32 indexed credType
    );

    /// @notice A subject renounced (self-burned) their own badge.
    /// @param tokenId  The renounced badge.
    /// @param subject  The holder that renounced it.
    /// @param credType The credential kind.
    event CredentialRenounced(
        uint256 indexed tokenId, address indexed subject, bytes32 indexed credType
    );

    // ──────────────────────── errors ────────────────────────

    /// @notice A zero address was supplied where a non-zero one is required.
    error CredentialSbt__ZeroAddress();

    /// @notice A level of 0 was supplied; 0 is the "no badge" sentinel and can never be a live level.
    error CredentialSbt__ZeroLevel();

    /// @notice `subject` already holds an active badge of `credType` (one active badge per pair).
    error CredentialSbt__AlreadyIssued(address subject, bytes32 credType, uint256 tokenId);

    /// @notice `tokenId` does not correspond to a live badge (never issued, revoked, or burned).
    error CredentialSbt__UnknownCredential(uint256 tokenId);

    /// @notice The caller is not the subject of `tokenId` (self-burn is subject-only).
    error CredentialSbt__NotSubject(uint256 tokenId, address caller);

    /// @notice The badge is soulbound: transfers and approvals are permanently disabled.
    error CredentialSbt__Soulbound();

    /// @notice The voucher signature did not validate against `issuer` (EOA/ERC-1271/ERC-6492).
    error CredentialSbt__BadSignature();

    /// @notice The voucher deadline has passed (`deadline` < now).
    error CredentialSbt__VoucherExpired(uint256 deadline, uint256 nowTs);

    /// @notice The voucher `subject` does not match the account claiming it.
    error CredentialSbt__SubjectMismatch(address voucherSubject, address caller);

    /// @notice The voucher's `nonce` was already consumed (replay guard).
    error CredentialSbt__NonceUsed(address issuer, uint256 nonce);

    // ──────────────────────── views ────────────────────────

    /// @notice The full credential record for `tokenId`.
    /// @param tokenId The badge to look up.
    /// @return The {Credential} record (all-zero for a nonexistent tokenId).
    function credentialOf(uint256 tokenId) external view returns (Credential memory);

    /// @notice The tokenId of `subject`'s active badge of `credType`, or 0 if none.
    /// @param subject  The holder to look up.
    /// @param credType The credential kind.
    /// @return tokenId The active badge id, or 0 if the subject has no active badge of that type.
    function tokenOfSubject(address subject, bytes32 credType)
        external
        view
        returns (uint256 tokenId);

    /// @notice Whether `subject` currently holds a VALID (issued, not revoked, not expired) badge of
    ///         `credType` — the single read an integrator gates on.
    /// @param subject  The holder to check.
    /// @param credType The credential kind.
    /// @return True if a valid badge exists for the pair.
    function hasValidCredential(address subject, bytes32 credType) external view returns (bool);

    /// @notice Whether `tokenId` is currently valid: it exists, is not revoked, and is not expired.
    /// @param tokenId The badge to check.
    /// @return True if the badge is live and unexpired.
    function isValid(uint256 tokenId) external view returns (bool);

    /// @notice The level of `tokenId` (0 if the badge does not exist).
    /// @param tokenId The badge to query.
    /// @return The credential level.
    function levelOf(uint256 tokenId) external view returns (uint8);

    /// @notice The next unconsumed voucher nonce for `issuer` (the claim-path replay guard is a
    ///         per-issuer bitmap; this returns the lowest un-used nonce for convenience/off-chain use).
    /// @param issuer The issuer whose nonce to read.
    /// @return The lowest nonce not yet consumed by a claim.
    function nextNonce(address issuer) external view returns (uint256);

    /// @notice Whether `nonce` has already been consumed for `issuer`.
    /// @param issuer The issuer.
    /// @param nonce  The voucher nonce.
    /// @return True if the nonce was used (a claim consumed it).
    function isNonceUsed(address issuer, uint256 nonce) external view returns (bool);

    /// @notice The EIP-712 digest an issuer signs to authorize a gasless {claim}.
    /// @param subject   The subject the badge is for.
    /// @param credType  The credential kind.
    /// @param level     The initial level (non-zero).
    /// @param expiresAt The badge expiry (0 = never).
    /// @param nonce     The issuer's voucher nonce.
    /// @param deadline  The voucher deadline (unix seconds) — the signature is only usable until then.
    /// @return The typed-data digest to sign.
    function claimDigest(
        address subject,
        bytes32 credType,
        uint8 level,
        uint64 expiresAt,
        uint256 nonce,
        uint256 deadline
    ) external view returns (bytes32);

    // ──────────────────────── mutating ────────────────────────

    /// @notice Issue a badge directly (issuer path). Only an account with the issuer role.
    /// @param subject   The holder the credential is about (non-zero).
    /// @param credType  The credential kind.
    /// @param level     The initial level (non-zero).
    /// @param expiresAt The expiry (unix seconds); 0 = never expires.
    /// @return tokenId The newly minted soulbound badge id.
    function issue(address subject, bytes32 credType, uint8 level, uint64 expiresAt)
        external
        returns (uint256 tokenId);

    /// @notice Claim a badge from an issuer-signed voucher (gasless path). The caller (typically the
    ///         subject, but any relayer may submit) supplies the voucher fields + the issuer signature;
    ///         the recovered signer must hold the issuer role.
    /// @param issuer    The account that signed the voucher (must hold the issuer role).
    /// @param subject   The subject the voucher is for (must equal the token receiver).
    /// @param credType  The credential kind.
    /// @param level     The initial level (non-zero).
    /// @param expiresAt The expiry (unix seconds); 0 = never expires.
    /// @param nonce     The issuer's voucher nonce (single-use).
    /// @param deadline  The voucher deadline (unix seconds).
    /// @param signature The issuer's signature over {claimDigest} (EOA / ERC-1271 / ERC-6492).
    /// @return tokenId The newly minted soulbound badge id.
    function claim(
        address issuer,
        address subject,
        bytes32 credType,
        uint8 level,
        uint64 expiresAt,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 tokenId);

    /// @notice Raise or lower the level of an existing badge. Only an account with the issuer role.
    /// @param tokenId  The badge to re-level.
    /// @param newLevel The new level (non-zero; may be higher or lower than the current level).
    function setLevel(uint256 tokenId, uint8 newLevel) external;

    /// @notice Revoke (burn) a badge. Only an account with the issuer role.
    /// @param tokenId The badge to revoke.
    function revoke(uint256 tokenId) external;

    /// @notice Renounce (self-burn) your own badge. Only the badge's subject.
    /// @param tokenId The badge to renounce.
    function renounce(uint256 tokenId) external;
}
