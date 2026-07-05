// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { ICredentialSbt, IERC5192 } from "./interfaces/ICredentialSbt.sol";

/// @title  CredentialSbt
/// @author Access0x1
/// @notice A VANILLA, CLONEABLE soulbound (ERC-5192) verified-credential badge with LEVELS. A plain OZ
///         ERC-721 underneath, made permanently non-transferable (soulbound) and extended with an
///         attestation surface: an ISSUER mints a badge to a SUBJECT under a caller-chosen `credType`
///         (`bytes32`, e.g. `keccak256("business-verified")`), so ONE contract serves many credential
///         kinds. Each badge carries a `uint8 level` the issuer can raise or lower, an optional
///         `expiresAt`, and a revoked flag; exactly one ACTIVE badge may exist per (subject, credType).
///         Badges are minted directly by an authorized issuer ({issue}) OR claimed gaslessly by the
///         subject from an issuer-signed EIP-712 voucher ({claim}, relayer-friendly). A badge is revoked
///         (burned) by the issuer ({revoke}) or self-burned by the subject ({renounce}) — a person may
///         always renounce their own credential. Transfers and approvals hard-revert (soulbound).
/// @dev    REUSABLE-BASE RULES (nothing privileged, nothing hardcoded):
///           - The admin is a CONSTRUCTOR PARAM. It receives only `DEFAULT_ADMIN_ROLE` and from there
///             grants {ISSUER_ROLE} to whatever attestor set a deployment chooses. No address is baked
///             in; every clone configures its own authority set.
///           - `credType` is a CALLER-CHOSEN key, so the contract is domain-agnostic and never encodes
///             an estate-specific credential name — a deployment picks its own type keys.
///
///         SOULBOUND (ERC-5192): {locked} returns true for EVERY existing token and {Locked} is emitted
///         once at mint (never {Unlocked}). Enforcement lives in {_update}, the single OZ 5.x transfer
///         choke-point: a MINT (`from == 0`) and a BURN (`to == 0`) are allowed, but any wallet-to-wallet
///         move reverts {CredentialSbt__Soulbound}. The ERC-721 approval entry points ({approve},
///         {setApprovalForAll}) also hard-revert, since an approval can only ever enable a (forbidden)
///         transfer — closing every path to a transfer, not just the direct one.
///
///         CUSTODY: NONE — a pure attestation registry, no value transfer, no `payable` function. The
///         only external interaction is signature validation on the {claim} path (EOA, ERC-1271 deployed
///         smart account, and ERC-6492 counterfactual smart account), which precedes every state change
///         (CEI): validate the deadline, the nonce, and the signature, THEN consume the nonce and mint.
///         The 6492 factory `prepare` call is the sole external CALL and is fired before any write, so a
///         re-entrant claimer cannot double-spend a nonce (the nonce is marked used before the mint, and
///         a replayed voucher reverts {CredentialSbt__NonceUsed}).
///
///         BURN-AUTH (ERC-5484 semantics): both the issuer (revocation) and the subject (renunciation)
///         may burn — a fixed policy chosen for a credential primitive rather than a per-token `BurnAuth`
///         enum, keeping the surface lean. A burn deletes the record and frees the (subject, credType)
///         slot so a fresh badge can be issued later.
///
///         TESTNET-ONLY framing: like the rest of this kit, this base is for testnet demonstration;
///         mainnet use is owner-gated and out of scope here.
contract CredentialSbt is ICredentialSbt, IERC5192, ERC721, AccessControl, EIP712 {
    /*//////////////////////////////////////////////////////////////
                                 ROLES
    //////////////////////////////////////////////////////////////*/

    /// @notice May {issue}/{setLevel}/{revoke} badges and is the signer authority for {claim} vouchers.
    ///         Granted by `DEFAULT_ADMIN_ROLE`; a deployment may grant it to many attestors.
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    /*//////////////////////////////////////////////////////////////
                                TYPEHASH
    //////////////////////////////////////////////////////////////*/

    /// @notice The EIP-712 typehash for a gasless credential voucher.
    /// @dev    keccak256("Credential(address subject,bytes32 credType,uint8 level,uint64
    ///         expiresAt,uint256 nonce,uint256 deadline)"). Pins every badge parameter + the replay nonce
    ///         + the deadline into the digest the issuer signs, so a relayer cannot alter any field of the
    ///         voucher it submits.
    bytes32 public constant CREDENTIAL_TYPEHASH = keccak256(
        "Credential(address subject,bytes32 credType,uint8 level,uint64 expiresAt,uint256 nonce,uint256 deadline)"
    );

    /// @notice The ERC-5192 ERC-165 interface id (`0xb45a3c0e` == the `locked(uint256)` selector).
    bytes4 private constant ERC5192_INTERFACE_ID = 0xb45a3c0e;

    /// @notice The ERC-6492 detection suffix: a wrapped signature ends with this 32-byte magic value.
    /// @dev    Per ERC-6492. A signature whose final 32 bytes equal this is
    ///         `abi.encode(factory, factoryCalldata, sig)` followed by the magic; otherwise it is a plain
    ///         ECDSA / ERC-1271 signature.
    bytes32 private constant ERC6492_MAGIC =
        0x6492649264926492649264926492649264926492649264926492649264926492;

    /// @notice The ERC-1271 "valid signature" magic return value (`IERC1271.isValidSignature.selector`).
    bytes4 private constant ERC1271_MAGIC = IERC1271.isValidSignature.selector;

    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice The monotonic id of the next badge to mint. Starts at 1 so 0 is always the "no badge"
    ///         sentinel returned by {tokenOfSubject}.
    uint256 private _nextId = 1;

    /// @notice tokenId ⇒ its credential record. A burned/nonexistent id maps to an all-zero record.
    mapping(uint256 tokenId => Credential cred) private _creds;

    /// @notice (subject, credType) ⇒ the tokenId of the active badge for that pair, or 0 if none. Frees
    ///         back to 0 on burn, so the one-active-badge-per-pair invariant is enforced on {issue}/
    ///         {claim} and a later re-issue is possible after a revoke/renounce.
    mapping(address subject => mapping(bytes32 credType => uint256 tokenId)) private _activeToken;

    /// @notice issuer ⇒ nonce ⇒ consumed. The per-issuer voucher replay guard: a claimed voucher marks
    ///         its (issuer, nonce) pair used, so the same voucher can never mint twice.
    mapping(address issuer => mapping(uint256 nonce => bool used)) private _nonceUsed;

    /// @notice issuer ⇒ the lowest nonce not yet KNOWN-consumed by {nextNonce}. A pure convenience cursor
    ///         for off-chain voucher issuance; the authoritative replay guard is {_nonceUsed}. Advanced
    ///         lazily on {claim} only when the consumed nonce equals the current cursor, so out-of-order
    ///         claims never strand the cursor behind a gap (it simply stays put until the gap is filled).
    mapping(address issuer => uint256 nonce) private _nextNonce;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploy a fresh credential-badge registry. `admin_` is the ONLY configured authority: it
    ///         holds `DEFAULT_ADMIN_ROLE` and grants/revokes {ISSUER_ROLE} per its own governance. The
    ///         deployer keeps nothing unless it IS the admin.
    /// @param name_    The ERC-721 collection name (also the EIP-712 domain name).
    /// @param symbol_  The ERC-721 collection symbol.
    /// @param version_ The EIP-712 domain version (e.g. "1") — pins the voucher domain across deployments.
    /// @param admin_   The role admin (non-zero). Receives `DEFAULT_ADMIN_ROLE` only — {ISSUER_ROLE} is
    ///                 granted explicitly so separation of duties is a choice, not a leak.
    constructor(string memory name_, string memory symbol_, string memory version_, address admin_)
        ERC721(name_, symbol_)
        EIP712(name_, version_)
    {
        if (admin_ == address(0)) revert CredentialSbt__ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc ICredentialSbt
    function credentialOf(uint256 tokenId) external view returns (Credential memory) {
        return _creds[tokenId];
    }

    /// @inheritdoc ICredentialSbt
    function tokenOfSubject(address subject, bytes32 credType)
        external
        view
        returns (uint256 tokenId)
    {
        return _activeToken[subject][credType];
    }

    /// @inheritdoc ICredentialSbt
    /// @dev The single read an integrator gates on: true iff the subject holds an active badge of the
    ///      type AND that badge {isValid} (not revoked, not expired). Never reverts.
    function hasValidCredential(address subject, bytes32 credType) external view returns (bool) {
        return _isValid(_activeToken[subject][credType]);
    }

    /// @inheritdoc ICredentialSbt
    function isValid(uint256 tokenId) external view returns (bool) {
        return _isValid(tokenId);
    }

    /// @inheritdoc ICredentialSbt
    function levelOf(uint256 tokenId) external view returns (uint8) {
        return _creds[tokenId].level;
    }

    /// @inheritdoc IERC5192
    /// @dev Every existing badge is permanently locked (soulbound); a nonexistent id reverts per the
    ///      standard. `_requireOwned` reverts `ERC721NonexistentToken` for an unknown/burned id.
    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    /// @inheritdoc ICredentialSbt
    function nextNonce(address issuer) external view returns (uint256) {
        return _nextNonce[issuer];
    }

    /// @inheritdoc ICredentialSbt
    function isNonceUsed(address issuer, uint256 nonce) external view returns (bool) {
        return _nonceUsed[issuer][nonce];
    }

    /// @notice The EIP-712 domain separator (exposed for off-chain signers / ERC-6492 tooling).
    /// @return The domain separator for this contract.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @inheritdoc ICredentialSbt
    function claimDigest(
        address subject,
        bytes32 credType,
        uint8 level,
        uint64 expiresAt,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CREDENTIAL_TYPEHASH, subject, credType, level, expiresAt, nonce, deadline
                )
            )
        );
    }

    /*//////////////////////////////////////////////////////////////
                                 ISSUE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc ICredentialSbt
    /// @dev Direct issuer path. Only {ISSUER_ROLE}; `msg.sender` is recorded as the issuer. No external
    ///      call — CEI holds trivially.
    function issue(address subject, bytes32 credType, uint8 level, uint64 expiresAt)
        external
        onlyRole(ISSUER_ROLE)
        returns (uint256 tokenId)
    {
        return _mintBadge(subject, credType, level, expiresAt, msg.sender);
    }

    /// @inheritdoc ICredentialSbt
    /// @dev Gasless voucher path. Any caller (typically the subject, but any relayer may submit) supplies
    ///      the voucher fields + the issuer signature; the recovered/validated signer MUST hold
    ///      {ISSUER_ROLE}. CEI: validate the deadline → the nonce → the signature BEFORE any state change,
    ///      then mark the nonce used (replay guard) and mint. The `subject` in the voucher is the
    ///      receiver, so a relayer cannot redirect the badge. Signature validation may make ONE external
    ///      call (the ERC-6492 factory prepare); it happens before the nonce/mint writes, and the nonce is
    ///      marked used before the mint, so a re-entrant claim reverts {CredentialSbt__NonceUsed}.
    function claim(
        address issuer,
        address subject,
        bytes32 credType,
        uint8 level,
        uint64 expiresAt,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 tokenId) {
        if (issuer == address(0)) revert CredentialSbt__ZeroAddress();
        if (block.timestamp > deadline) {
            revert CredentialSbt__VoucherExpired(deadline, block.timestamp);
        }
        if (_nonceUsed[issuer][nonce]) revert CredentialSbt__NonceUsed(issuer, nonce);
        // The recovered signer must be the named issuer AND hold the issuer role. Checking against the
        // named `issuer` first lets the per-issuer nonce guard above be read without recovering.
        if (!hasRole(ISSUER_ROLE, issuer)) revert CredentialSbt__BadSignature();

        // Effect BEFORE interaction (checks-effects-interactions): consume the nonce NOW, before signature
        // validation. `_isValidSignatureNow` is the ONLY external-call site (the ERC-6492 factory `prepare`,
        // whose factory + calldata are UNSIGNED wrapper legs any submitter chooses), so a re-entrant claim
        // on the same (issuer, nonce) hits this already-set guard and reverts {CredentialSbt__NonceUsed} —
        // one nonce can mint at most once. If validation then fails, the whole tx reverts and this flag
        // rolls back with it, so a bad signature leaves the nonce unused (legitimate claims unaffected).
        _nonceUsed[issuer][nonce] = true;

        bytes32 digest = claimDigest(subject, credType, level, expiresAt, nonce, deadline);
        if (!_isValidSignatureNow(issuer, digest, signature)) {
            revert CredentialSbt__BadSignature();
        }

        // Advance the convenience cursor past the used run, then mint.
        uint256 cursor = _nextNonce[issuer];
        if (nonce == cursor) {
            // Walk the cursor forward over any already-used run so the next off-chain nonce is fresh.
            uint256 next = cursor + 1;
            while (_nonceUsed[issuer][next]) {
                unchecked {
                    ++next;
                }
            }
            _nextNonce[issuer] = next;
        }

        return _mintBadge(subject, credType, level, expiresAt, issuer);
    }

    /*//////////////////////////////////////////////////////////////
                                 LEVEL
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc ICredentialSbt
    /// @dev Issuer-only re-level. The badge must exist (a burned id has a zero record ⇒
    ///      {CredentialSbt__UnknownCredential}). `newLevel` may be higher or lower than the current level
    ///      but must be non-zero (0 is the sentinel). A re-level does NOT reset expiry.
    function setLevel(uint256 tokenId, uint8 newLevel) external onlyRole(ISSUER_ROLE) {
        if (newLevel == 0) revert CredentialSbt__ZeroLevel();
        Credential storage cred = _creds[tokenId];
        uint8 oldLevel = cred.level;
        if (oldLevel == 0) revert CredentialSbt__UnknownCredential(tokenId);

        cred.level = newLevel;
        emit LevelChanged(tokenId, oldLevel, newLevel);
    }

    /*//////////////////////////////////////////////////////////////
                                 BURN
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc ICredentialSbt
    /// @dev Issuer-only revocation. Burns the badge, clears the record, and frees the (subject, credType)
    ///      slot so a fresh badge can be issued later. The token must exist.
    function revoke(uint256 tokenId) external onlyRole(ISSUER_ROLE) {
        Credential storage cred = _creds[tokenId];
        address subject = cred.subject;
        if (subject == address(0)) revert CredentialSbt__UnknownCredential(tokenId);
        bytes32 credType = cred.credType;

        _clearBadge(tokenId, subject, credType);
        emit CredentialRevoked(tokenId, subject, credType);
    }

    /// @inheritdoc ICredentialSbt
    /// @dev Subject-only renunciation — a person may always burn their OWN badge, independent of the
    ///      issuer. The caller must be the subject (== the ERC-721 owner) of the badge.
    function renounce(uint256 tokenId) external {
        Credential storage cred = _creds[tokenId];
        address subject = cred.subject;
        if (subject == address(0)) revert CredentialSbt__UnknownCredential(tokenId);
        if (msg.sender != subject) revert CredentialSbt__NotSubject(tokenId, msg.sender);
        bytes32 credType = cred.credType;

        _clearBadge(tokenId, subject, credType);
        emit CredentialRenounced(tokenId, subject, credType);
    }

    /*//////////////////////////////////////////////////////////////
                          SOULBOUND ENFORCEMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Soulbound: approvals are permanently disabled (an approval can only enable a transfer).
    /// @dev Overrides {ERC721.approve} to hard-revert; the `to`/`tokenId` params are unused.
    function approve(address, uint256) public pure override {
        revert CredentialSbt__Soulbound();
    }

    /// @notice Soulbound: operator approvals are permanently disabled.
    /// @dev Overrides {ERC721.setApprovalForAll} to hard-revert; the params are unused.
    function setApprovalForAll(address, bool) public pure override {
        revert CredentialSbt__Soulbound();
    }

    /// @dev The single OZ 5.x transfer choke-point. A MINT (`from == 0`) and a BURN (`to == 0`) pass
    ///      through; any wallet-to-wallet move (both endpoints non-zero) reverts
    ///      {CredentialSbt__Soulbound}, so no ERC-721 entry point (plain, approved-operator, or safe) can
    ///      move a badge. The {Locked} event is emitted by {_mintBadge} at mint, not here, to keep this
    ///      hot path minimal.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert CredentialSbt__Soulbound();
        return super._update(to, tokenId, auth);
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    /// @notice ERC-165 detection: true for ERC-5192 (`0xb45a3c0e`), plus everything the OZ bases
    ///         advertise (IERC721, IERC721Metadata, IAccessControl, IERC165).
    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return interfaceId == ERC5192_INTERFACE_ID || super.supportsInterface(interfaceId);
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev Shared mint path for {issue} and {claim}. Validates the subject, level, and the
    ///      one-active-badge-per-pair invariant, assigns the next tokenId, writes the record, mints the
    ///      soulbound token, and emits {Locked} (ERC-5192) + {CredentialIssued}.
    /// @param subject   The holder the credential is about (non-zero).
    /// @param credType  The credential kind.
    /// @param level     The initial level (non-zero).
    /// @param expiresAt The expiry (unix seconds); 0 = never expires.
    /// @param issuer    The authorizing issuer (caller on {issue}, recovered signer on {claim}).
    /// @return tokenId  The newly minted badge id.
    function _mintBadge(
        address subject,
        bytes32 credType,
        uint8 level,
        uint64 expiresAt,
        address issuer
    ) private returns (uint256 tokenId) {
        if (subject == address(0)) revert CredentialSbt__ZeroAddress();
        if (level == 0) revert CredentialSbt__ZeroLevel();
        uint256 existing = _activeToken[subject][credType];
        if (existing != 0) {
            revert CredentialSbt__AlreadyIssued(subject, credType, existing);
        }

        tokenId = _nextId;
        unchecked {
            _nextId = tokenId + 1; // a uint256 id cannot realistically overflow
        }

        _creds[tokenId] = Credential({
            subject: subject,
            credType: credType,
            level: level,
            issuedAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            revoked: false
        });
        _activeToken[subject][credType] = tokenId;

        // _mint routes through _update (from == 0 ⇒ the soulbound gate lets the mint through).
        _mint(subject, tokenId);

        emit Locked(tokenId); // ERC-5192: the badge is permanently non-transferable from birth.
        emit CredentialIssued(tokenId, subject, credType, level, expiresAt, issuer);
    }

    /// @dev Shared burn path for {revoke} and {renounce}. Frees the (subject, credType) slot, deletes the
    ///      record, and burns the ERC-721 token (routes through {_update} with `to == 0` ⇒ allowed).
    /// @param tokenId  The badge to clear.
    /// @param subject  The badge subject (== ERC-721 owner).
    /// @param credType The credential kind.
    function _clearBadge(uint256 tokenId, address subject, bytes32 credType) private {
        delete _activeToken[subject][credType];
        delete _creds[tokenId];
        _burn(tokenId);
    }

    /// @dev A badge is valid iff it exists, is not revoked, and is not expired. `expiresAt == 0` means
    ///      "never expires"; otherwise the badge is valid THROUGH `expiresAt` (checked with `>`), so a
    ///      badge is still valid exactly at its expiry second. Never reverts (a zero id / burned id has a
    ///      zero record ⇒ false).
    /// @param tokenId The badge to check.
    /// @return True if the badge is live and unexpired.
    function _isValid(uint256 tokenId) private view returns (bool) {
        Credential storage cred = _creds[tokenId];
        if (cred.subject == address(0)) return false; // nonexistent / burned
        if (cred.revoked) return false;
        if (cred.expiresAt != 0 && block.timestamp > cred.expiresAt) return false;
        return true;
    }

    /*//////////////////////////////////////////////////////////////
                          SIGNATURE VALIDATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Decode an ERC-6492 wrapper body into its `(factory, factoryCalldata, innerSig)` legs.
    /// @dev    Exists ONLY as the external `try` target of {_isValidSignatureNow}: a magic-suffixed but
    ///         malformed-ABI body makes `abi.decode` revert with a Panic, so the engine calls this
    ///         externally and `catch`es the revert to return `false` rather than propagating it. Pure +
    ///         self-call: it touches no state and is reachable only via the engine's `try this.…`.
    /// @param body The 6492 wrapper minus its trailing 32-byte magic suffix.
    /// @return f     The factory address leg.
    /// @return fc    The factory-calldata leg.
    /// @return inner The inner (ERC-1271 / EOA) signature leg.
    function tryDecode6492(bytes calldata body)
        external
        pure
        returns (address f, bytes memory fc, bytes memory inner)
    {
        (f, fc, inner) = abi.decode(body, (address, bytes, bytes));
    }

    /// @dev The validation engine — the same predeploy-aware validator this kit uses everywhere. ORDER:
    ///      1. ERC-6492: if the signature ends with the magic suffix it is `abi.encode(factory,
    ///         factoryCalldata, innerSig)`. If `signer` has no code yet, best-effort call `factory` with
    ///         `factoryCalldata` to deploy/prepare it (the "sign-before-deploy" property), then fall
    ///         through to ERC-1271 with the unwrapped `innerSig`. The deploy call is the ONLY external
    ///         call and lives behind the 6492 magic, exactly as the standard prescribes.
    ///      2. ERC-1271: if `signer` has code, ask it via `isValidSignature` and require the magic.
    ///      3. EOA: otherwise recover with ECDSA (`tryRecover*`, never `recover`) and compare, so a
    ///         malformed signature is a clean `false` instead of a revert.
    function _isValidSignatureNow(address signer, bytes32 hash, bytes calldata signature)
        private
        returns (bool)
    {
        // 1. ERC-6492 detection: the trailing 32 bytes are the magic suffix.
        if (signature.length >= 32) {
            bytes32 suffix = bytes32(signature[signature.length - 32:]);
            if (suffix == ERC6492_MAGIC) {
                // GUARD: a body that ends in the magic but is NOT a valid `(address,bytes,bytes)` encoding
                // makes `abi.decode` revert with a Panic. Decode behind an external `try` self-call so a
                // malformed wrapper yields a clean `false` instead of propagating the revert.
                address factory;
                bytes memory factoryCalldata;
                bytes memory innerSig;
                try this.tryDecode6492(signature[:signature.length - 32]) returns (
                    address f, bytes memory fc, bytes memory inner
                ) {
                    factory = f;
                    factoryCalldata = fc;
                    innerSig = inner;
                } catch {
                    return false;
                }

                // Only attempt the prepare/deploy if the signer is not yet a contract. If it already has
                // code, the inner ERC-1271 path below validates it directly (a redundant deploy is
                // skipped — and a malicious wrapper cannot force a call onto an existing account).
                if (signer.code.length == 0 && factory != address(0)) {
                    // Best-effort prepare/deploy. A failed deploy is not fatal: validation proceeds and
                    // fails at the ERC-1271 step if the account truly is not ready, surfacing as
                    // {BadSignature}. We never bubble the factory's revert.
                    (bool ok,) = factory.call(factoryCalldata);
                    ok; // result intentionally ignored; correctness is decided by the 1271 check below
                }

                return _validate1271OrEOAMemory(signer, hash, innerSig);
            }
        }

        // 2/3. Not 6492-wrapped: validate the calldata signature as-is.
        return _validate1271OrEOACalldata(signer, hash, signature);
    }

    /// @dev ERC-1271 (if `signer` has code) else ECDSA EOA recovery — memory-`bytes` variant used after a
    ///      6492 unwrap (the inner sig is in memory).
    function _validate1271OrEOAMemory(address signer, bytes32 hash, bytes memory sig)
        private
        view
        returns (bool)
    {
        if (signer.code.length > 0) {
            (bool ok, bytes memory ret) =
                signer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (hash, sig)));
            return ok && ret.length == 32 && abi.decode(ret, (bytes4)) == ERC1271_MAGIC;
        }
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, sig);
        return err == ECDSA.RecoverError.NoError && recovered == signer && recovered != address(0);
    }

    /// @dev Same as {_validate1271OrEOAMemory} but for a calldata signature (the non-wrapped fast path),
    ///      avoiding an extra memory copy on the common case.
    function _validate1271OrEOACalldata(address signer, bytes32 hash, bytes calldata sig)
        private
        view
        returns (bool)
    {
        if (signer.code.length > 0) {
            (bool ok, bytes memory ret) =
                signer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (hash, sig)));
            return ok && ret.length == 32 && abi.decode(ret, (bytes4)) == ERC1271_MAGIC;
        }
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, sig);
        return err == ECDSA.RecoverError.NoError && recovered == signer && recovered != address(0);
    }
}
