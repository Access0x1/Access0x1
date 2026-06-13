// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { ISessionGrant } from "./interfaces/ISessionGrant.sol";

/// @title  SessionGrant
/// @author Access0x1
/// @notice An Access0x1-owned implementation of the "sign once → time-bounded, budget-scoped
///         delegated agent session" pattern enabled by ERC-7702 (Final, Pectra), with ERC-6492
///         (Final) validation of grant signatures from wallets that are not yet deployed on-chain.
///         An OWNER authorizes a DELEGATE (an agent / server wallet) to spend up to a fixed budget,
///         on the owner's behalf, until an expiry — without co-signing each spend. After the session
///         is opened, the delegate calls {spend} repeatedly; every spend decrements the remaining
///         budget and is rejected once the budget is exhausted, the session has expired, or the owner
///         has revoked it.
/// @dev    WHY THIS COMPOSES WITH ERC-7702. An EOA that has set its code to an Access0x1 delegate
///         (via a 7702 authorization) can call {openSession} as `msg.sender` — the single 7702 signing
///         act is what lets the EOA "act as a contract" and open the session. Equally, a wallet (EOA,
///         7702-EOA, or ERC-1271 smart account) may sign an EIP-712 {SessionGrant} OFF-CHAIN and have
///         any relayer submit it via {openSessionFor}; the signature is validated against the owner so
///         no on-chain owner tx is required. This is the "zero wallet deploy" property: a brand-new
///         counterfactual smart account can authorize a session before it has any code, because
///         {openSessionFor} accepts ERC-6492-wrapped signatures.
///
///         CUSTODY: NONE. SessionGrant is a pure AUTHORIZATION ledger. It never holds, moves, or
///         escrows funds — {spend} only debits an accounting budget and emits an event. A consuming
///         contract (e.g. an Access0x1 router) is expected to gate value transfer on a successful
///         {spend}, so the budget is the spend CEILING, not a wallet. This isolation is deliberate:
///         the money-path security budget is never spent on this auth primitive (money-safety invariant).
///
///         REPLAY: per-owner monotonic `nonces`. Each signed grant pins a nonce; the nonce is consumed
///         on a successful {openSessionFor}, so a captured grant signature can never open a second
///         session. The session id itself = keccak256(owner, delegate, nonce), so a replayed
///         already-consumed grant collides with the existing session and reverts {SessionExists}.
contract SessionGrant is ISessionGrant, EIP712 {
    /// @notice The EIP-712 typehash for an off-chain session grant.
    /// @dev    keccak256("SessionGrant(address owner,address delegate,uint256 budgetCap,uint64
    ///         expiry,uint256 nonce)"). Pins every session parameter + the replay nonce into the digest
    ///         the owner signs, so a relayer cannot alter any field of the grant it submits.
    bytes32 public constant SESSION_GRANT_TYPEHASH = keccak256(
        "SessionGrant(address owner,address delegate,uint256 budgetCap,uint64 expiry,uint256 nonce)"
    );

    /// @notice The ERC-6492 detection suffix: a wrapped signature ends with this 32-byte magic value.
    /// @dev    0x6492649264926492649264926492649264926492649264926492649264926492 — per ERC-6492. A
    ///         signature whose final 32 bytes equal this is `abi.encode(factory, factoryCalldata, sig)`
    ///         followed by the magic; otherwise it is a plain ECDSA / ERC-1271 signature.
    bytes32 private constant ERC6492_MAGIC =
        0x6492649264926492649264926492649264926492649264926492649264926492;

    /// @notice The ERC-1271 "valid signature" magic return value (`IERC1271.isValidSignature.selector`).
    bytes4 private constant ERC1271_MAGIC = IERC1271.isValidSignature.selector;

    /// @notice owner ⇒ next unconsumed grant nonce. The off-chain-grant replay guard.
    mapping(address owner => uint256 nonce) private _nonces;

    /// @notice session id ⇒ the session record.
    mapping(bytes32 sessionId => Session session) private _sessions;

    /// @notice session id ⇒ the owner that opened it. Kept out of the hot {Session} struct so {spend}
    ///         (the agent hot path) never loads it; only {revoke} reads it.
    mapping(bytes32 sessionId => address owner) private _ownerOf;

    /// @param name    EIP-712 domain name.
    /// @param version EIP-712 domain version.
    constructor(string memory name, string memory version) EIP712(name, version) { }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc ISessionGrant
    function nonces(address owner) external view returns (uint256) {
        return _nonces[owner];
    }

    /// @inheritdoc ISessionGrant
    function sessionOf(bytes32 sessionId) external view returns (Session memory) {
        return _sessions[sessionId];
    }

    /// @inheritdoc ISessionGrant
    /// @dev Returns 0 for any dead session (unknown / expired / revoked / exhausted) so an integrator
    ///      can gate a spend on a single non-zero read without re-deriving liveness.
    function remaining(bytes32 sessionId) external view returns (uint256) {
        Session storage s = _sessions[sessionId];
        if (s.delegate == address(0)) return 0; // unknown
        if (s.revoked) return 0;
        if (block.timestamp > s.expiry) return 0; // expired
        return s.budgetCap - s.spent; // invariant: spent <= budgetCap
    }

    /// @inheritdoc ISessionGrant
    function computeSessionId(address owner, address delegate, uint256 nonce)
        external
        pure
        returns (bytes32)
    {
        return _sessionId(owner, delegate, nonce);
    }

    /// @notice The EIP-712 domain separator (exposed for off-chain signers / ERC-6492 tooling).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice The EIP-712 digest an owner signs to authorize a grant via {openSessionFor}.
    /// @param owner     The granting account.
    /// @param delegate  The delegate.
    /// @param budgetCap The budget cap.
    /// @param expiry    The expiry.
    /// @param nonce     The owner nonce.
    /// @return The typed-data digest to sign.
    function grantDigest(
        address owner,
        address delegate,
        uint256 budgetCap,
        uint64 expiry,
        uint256 nonce
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(SESSION_GRANT_TYPEHASH, owner, delegate, budgetCap, expiry, nonce))
        );
    }

    /*//////////////////////////////////////////////////////////////
                                  OPEN
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc ISessionGrant
    /// @dev Owner-as-caller path. `msg.sender` IS the owner — this is the ERC-7702 entrypoint (a
    ///      7702-delegated EOA can call this directly). The owner nonce is consumed so a later signed
    ///      grant cannot collide with this session id.
    function openSession(address delegate, uint256 budgetCap, uint64 expiry)
        external
        returns (bytes32 sessionId)
    {
        return _open(msg.sender, delegate, budgetCap, expiry);
    }

    /// @inheritdoc ISessionGrant
    /// @dev Relayed-grant path. Validates `signature` against `owner` for the EIP-712 grant digest at
    ///      the owner's CURRENT nonce, accepting raw ECDSA, ERC-1271 (deployed smart account), or
    ///      ERC-6492 (counterfactual / not-yet-deployed smart account). The signature is checked BEFORE
    ///      any state change (CEI-style: validate, then effect); the nonce is consumed inside {_open}.
    function openSessionFor(
        address owner,
        address delegate,
        uint256 budgetCap,
        uint64 expiry,
        bytes calldata signature
    ) external returns (bytes32 sessionId) {
        if (owner == address(0)) revert SessionGrant__ZeroAddress();
        uint256 nonce = _nonces[owner];
        bytes32 digest = grantDigest(owner, delegate, budgetCap, expiry, nonce);
        if (!_isValidSignatureNow(owner, digest, signature)) revert SessionGrant__BadSignature();
        return _open(owner, delegate, budgetCap, expiry);
    }

    /// @dev The shared open path. Validates parameters, consumes the owner nonce (replay guard),
    ///      derives the deterministic session id, rejects a collision, writes the session (effects),
    ///      and emits. No external call after the (already-performed) signature check, so no reentrancy
    ///      surface — this is a pure-bookkeeping write.
    /// @param owner     The granting account (caller in the direct path, signer in the relayed path).
    /// @param delegate  The authorized spender (non-zero, distinct from owner).
    /// @param budgetCap The total spendable budget (non-zero).
    /// @param expiry    The future expiry.
    /// @return sessionId The opened session id.
    function _open(address owner, address delegate, uint256 budgetCap, uint64 expiry)
        private
        returns (bytes32 sessionId)
    {
        if (delegate == address(0)) revert SessionGrant__ZeroAddress();
        if (budgetCap == 0) revert SessionGrant__ZeroBudget();
        if (expiry <= block.timestamp) revert SessionGrant__ExpiryInPast(expiry, block.timestamp);

        uint256 nonce = _nonces[owner];
        sessionId = _sessionId(owner, delegate, nonce);
        // A live or historic session already occupies this id (only possible if the same owner reuses
        // a delegate before the nonce advanced — it cannot, since we bump the nonce here — but guard
        // anyway so a future open path can never silently clobber a session).
        if (_sessions[sessionId].delegate != address(0)) {
            revert SessionGrant__SessionExists(sessionId);
        }

        // Effects: consume the nonce, then write the session.
        unchecked {
            _nonces[owner] = nonce + 1; // a uint256 nonce cannot realistically overflow
        }
        _sessions[sessionId] = Session({
            delegate: delegate, expiry: expiry, budgetCap: budgetCap, spent: 0, revoked: false
        });
        _ownerOf[sessionId] = owner;

        emit SessionOpened(owner, sessionId, delegate, budgetCap, expiry, nonce);
    }

    /*//////////////////////////////////////////////////////////////
                                  SPEND
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc ISessionGrant
    /// @dev The agent hot path. Authorization, liveness, and budget are all checked before the single
    ///      state write; CEI holds trivially (no external call). Expiry is checked with `>` so a spend
    ///      exactly AT `expiry` is still allowed (the session is live through the expiry second).
    function spend(bytes32 sessionId, uint256 amount) external returns (uint256 remainingAfter) {
        if (amount == 0) revert SessionGrant__ZeroAmount();

        Session storage s = _sessions[sessionId];
        if (s.delegate == address(0)) revert SessionGrant__SessionUnknown(sessionId);
        if (msg.sender != s.delegate) revert SessionGrant__NotDelegate(sessionId, msg.sender);
        if (s.revoked) revert SessionGrant__SessionRevoked(sessionId);
        if (block.timestamp > s.expiry) {
            revert SessionGrant__SessionExpired(sessionId, s.expiry, block.timestamp);
        }

        uint256 spentSoFar = s.spent;
        uint256 budget = s.budgetCap;
        uint256 left = budget - spentSoFar; // invariant: spent <= budgetCap
        if (amount > left) revert SessionGrant__BudgetExceeded(sessionId, left, amount);

        // Effect: a single budget write. `spentSoFar + amount <= budgetCap` (checked above), so this
        // can never overflow and the invariant `spent <= budgetCap` is preserved.
        unchecked {
            s.spent = spentSoFar + amount;
            remainingAfter = left - amount;
        }

        emit SessionSpent(sessionId, msg.sender, amount, remainingAfter);
    }

    /*//////////////////////////////////////////////////////////////
                                 REVOKE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc ISessionGrant
    /// @dev Owner-only kill switch. A revoked session is permanently dead — there is no un-revoke — so
    ///      a leaked delegate key is contained the instant the owner reacts, independent of expiry or
    ///      remaining budget. Idempotent-safe: re-revoking reverts {SessionRevoked}, never silently.
    function revoke(bytes32 sessionId) external {
        Session storage s = _sessions[sessionId];
        if (s.delegate == address(0)) revert SessionGrant__SessionUnknown(sessionId);
        if (msg.sender != _ownerOf[sessionId]) {
            revert SessionGrant__NotOwner(sessionId, msg.sender);
        }
        if (s.revoked) revert SessionGrant__SessionRevoked(sessionId);

        s.revoked = true;
        emit SessionRevoked(sessionId, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                          SIGNATURE VALIDATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Validate `signature` over `hash` for `signer`, accepting EOA, ERC-1271, and ERC-6492.
    /// @dev    Exposed so integrators can reuse the exact same predeploy-aware validator Access0x1
    ///         uses to open sessions. See {_isValidSignatureNow}.
    /// @param signer    The claimed signer (EOA / 7702-EOA / smart account, possibly counterfactual).
    /// @param hash      The 32-byte digest that was signed.
    /// @param signature The signature (raw ECDSA, ERC-1271, or ERC-6492-wrapped).
    /// @return True if the signature is valid for `signer` over `hash`.
    function isValidSignatureNow(address signer, bytes32 hash, bytes calldata signature)
        external
        returns (bool)
    {
        return _isValidSignatureNow(signer, hash, signature);
    }

    /// @dev The validation engine. ORDER MATTERS:
    ///      1. ERC-6492: if the signature ends with the magic suffix it is `abi.encode(factory,
    ///         factoryCalldata, innerSig)`. If `signer` has no code yet, call `factory` with
    ///         `factoryCalldata` to deploy/prepare it (the "sign-before-deploy" property), then fall
    ///         through to ERC-1271 with the unwrapped `innerSig`. The deploy call is the ONLY external
    ///         call in the whole contract and it lives behind the 6492 magic, exactly as the standard
    ///         prescribes for a `prepare`/validate flow.
    ///      2. ERC-1271: if `signer` has code, ask it via `isValidSignature` and require the magic.
    ///      3. EOA: otherwise recover with ECDSA and compare to `signer`.
    ///      `tryRecover` (never `recover`) is used so a malformed signature returns false instead of
    ///      reverting, keeping a forged/garbage signature a clean rejection.
    function _isValidSignatureNow(address signer, bytes32 hash, bytes calldata signature)
        private
        returns (bool)
    {
        bytes calldata effectiveSig = signature;

        // 1. ERC-6492 detection: the trailing 32 bytes are the magic suffix.
        if (signature.length >= 32) {
            bytes32 suffix = bytes32(signature[signature.length - 32:]);
            if (suffix == ERC6492_MAGIC) {
                (address factory, bytes memory factoryCalldata, bytes memory innerSig) =
                    abi.decode(signature[:signature.length - 32], (address, bytes, bytes));

                // Only attempt the prepare/deploy if the signer is not yet a contract. If it already
                // has code, the inner ERC-1271 path below validates it directly (a redundant deploy is
                // skipped — and a malicious 6492 wrapper cannot force a call onto an existing account).
                if (signer.code.length == 0 && factory != address(0)) {
                    // Best-effort prepare/deploy. A failed deploy is not fatal here: validation simply
                    // proceeds and will fail at the ERC-1271 step if the account truly is not ready,
                    // surfacing as {BadSignature}. We never bubble the factory's revert.
                    (bool ok,) = factory.call(factoryCalldata);
                    ok; // result intentionally ignored; correctness is decided by the 1271 check below
                }

                // Unwrap to the inner signature for the 1271/EOA checks. ERC-6492 wrapped sigs are
                // always destined for an ERC-1271 account, but we still fall through generically.
                return _validate1271OrEOA(signer, hash, innerSig);
            }
        }

        // 2/3. Not 6492-wrapped: validate the signature as-is.
        return _validate1271OrEOACalldata(signer, hash, effectiveSig);
    }

    /// @dev ERC-1271 (if `signer` has code) else ECDSA EOA recovery — memory-`bytes` variant used
    ///      after a 6492 unwrap (the inner sig is in memory).
    function _validate1271OrEOA(address signer, bytes32 hash, bytes memory sig)
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

    /// @dev Same as {_validate1271OrEOA} but for a calldata signature (the non-wrapped fast path),
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

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev The deterministic session id. `abi.encode` (not packed) so the three legs each occupy a
    ///      full word and no two distinct triples can collide. Pure — recomputable off-chain for free.
    /// @param owner    The granting account leg.
    /// @param delegate The delegate leg.
    /// @param nonce    The owner-nonce leg.
    /// @return The session id.
    function _sessionId(address owner, address delegate, uint256 nonce)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(owner, delegate, nonce));
    }
}
