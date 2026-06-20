// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  ISessionGrant
/// @author Rensley R. @vyperpilleddev
/// @notice Surface for SessionGrant — an Access0x1-owned implementation of the ERC-7702 "sign once,
///         delegate a budget-scoped, time-bounded agent session" pattern, with ERC-6492 signature
///         validation so the granting wallet need not yet be deployed on-chain.
/// @dev    A "session" lets an OWNER (an EOA, an ERC-7702-delegated EOA, or an ERC-1271 smart account)
///         authorize a DELEGATE to spend up to a fixed USD-or-token budget, on the owner's behalf,
///         until an expiry timestamp — without the owner co-signing each spend. The session is opened
///         once (directly by the owner, or by relaying an EIP-712 grant the owner signed off-chain),
///         then the delegate calls {spend} repeatedly; each spend decrements the remaining budget and
///         is rejected once the budget is exhausted or the session has expired or been revoked.
interface ISessionGrant {
    // ──────────────────────── types ────────────────────────

    /// @notice One delegated session. Packed: `delegate` (160) + `expiry` (64) share a slot; `spent`
    ///         and `budgetCap` take one slot each. `revoked` rides in the low byte of a fourth slot.
    /// @param delegate  The address authorized to {spend} against this session (non-zero while live).
    /// @param expiry    Unix second after which the session is dead. `block.timestamp <= expiry` lives.
    /// @param budgetCap The total amount (in the session unit — token base units or USD-8dp) the
    ///                  delegate may cumulatively spend across the session's life.
    /// @param spent     The cumulative amount already spent; `spent <= budgetCap` always holds.
    /// @param revoked   True once the owner has revoked the session early. A revoked session is dead
    ///                  regardless of expiry or remaining budget and can never be revived.
    struct Session {
        address delegate;
        uint64 expiry;
        uint256 budgetCap;
        uint256 spent;
        bool revoked;
    }

    // ──────────────────────── events ────────────────────────

    /// @notice A session was opened for `owner`.
    /// @param owner     The granting account (EOA / 7702-EOA / smart account).
    /// @param sessionId The deterministic id = keccak256(owner, delegate, nonce).
    /// @param delegate  The authorized spender.
    /// @param budgetCap The total spendable budget.
    /// @param expiry    The session expiry (unix seconds).
    /// @param nonce     The owner nonce consumed to open this session (replay guard).
    event SessionOpened(
        address indexed owner,
        bytes32 indexed sessionId,
        address indexed delegate,
        uint256 budgetCap,
        uint64 expiry,
        uint256 nonce
    );

    /// @notice The delegate spent against a live session.
    /// @param sessionId The session spent against.
    /// @param delegate  The spender (always the session's bound delegate).
    /// @param amount    The amount spent on this call.
    /// @param remaining The budget remaining AFTER this spend (`budgetCap - spent`).
    event SessionSpent(
        bytes32 indexed sessionId, address indexed delegate, uint256 amount, uint256 remaining
    );

    /// @notice A session was revoked by its owner before expiry.
    /// @param sessionId The revoked session.
    /// @param owner     The owner that revoked it.
    event SessionRevoked(bytes32 indexed sessionId, address indexed owner);

    // ──────────────────────── errors ────────────────────────

    /// @notice A zero address was supplied where a non-zero one is required.
    error SessionGrant__ZeroAddress();

    /// @notice A zero budget was supplied; a session with no budget is meaningless.
    error SessionGrant__ZeroBudget();

    /// @notice The supplied expiry is not in the future (`expiry <= block.timestamp`).
    error SessionGrant__ExpiryInPast(uint64 expiry, uint256 nowTs);

    /// @notice An attempt to open a session id that already exists (same owner+delegate+nonce).
    error SessionGrant__SessionExists(bytes32 sessionId);

    /// @notice The referenced session does not exist (never opened).
    error SessionGrant__SessionUnknown(bytes32 sessionId);

    /// @notice The session has passed its expiry timestamp.
    error SessionGrant__SessionExpired(bytes32 sessionId, uint64 expiry, uint256 nowTs);

    /// @notice The session has been revoked by its owner.
    error SessionGrant__SessionRevoked(bytes32 sessionId);

    /// @notice The caller is not the session's authorized delegate.
    error SessionGrant__NotDelegate(bytes32 sessionId, address caller);

    /// @notice The caller is not the session's owner.
    error SessionGrant__NotOwner(bytes32 sessionId, address caller);

    /// @notice A spend would push cumulative spend past the budget cap.
    error SessionGrant__BudgetExceeded(bytes32 sessionId, uint256 remaining, uint256 requested);

    /// @notice A spend amount of zero was requested.
    error SessionGrant__ZeroAmount();

    /// @notice The supplied grant signature failed validation (EOA / ERC-1271 / ERC-6492).
    error SessionGrant__BadSignature();

    /// @notice The owner nonce moved between signature validation and the session write — the only way
    ///         this happens is a re-entrant open during the ERC-6492 factory prepare. Refusing pins each
    ///         authorization to the exact nonce it signed for, so one grant opens exactly one session.
    error SessionGrant__NonceMismatch(address owner, uint256 expectedNonce, uint256 actualNonce);

    // ──────────────────────── views ────────────────────────

    /// @notice The next unconsumed grant nonce for `owner` (used to open the next signed session).
    /// @param owner The granting account.
    /// @return The next nonce.
    function nonces(address owner) external view returns (uint256);

    /// @notice Read a session by id.
    /// @param sessionId The session id.
    /// @return The full {Session} record (zeroed if it never existed).
    function sessionOf(bytes32 sessionId) external view returns (Session memory);

    /// @notice The account that opened a session (its owner). Zero for an unknown session.
    /// @dev    Lets a consuming contract bind an action to the session's authorizing owner — e.g. a
    ///         subscriptions layer keying a subscriber to `ownerOf(sessionId)` so a stranger cannot
    ///         spend against a victim's session budget.
    /// @param sessionId The session id.
    /// @return The owner that opened the session (address(0) if it never existed).
    function ownerOf(bytes32 sessionId) external view returns (address);

    /// @notice The amount still spendable on a session right now (0 if dead for any reason).
    /// @param sessionId The session id.
    /// @return remaining The live remaining budget, or 0 if expired / revoked / unknown / exhausted.
    function remaining(bytes32 sessionId) external view returns (uint256 remaining);

    /// @notice The deterministic id of a session.
    /// @param owner    The granting account.
    /// @param delegate The delegate.
    /// @param nonce    The owner nonce.
    /// @return The session id = keccak256(abi.encode(owner, delegate, nonce)).
    function computeSessionId(address owner, address delegate, uint256 nonce)
        external
        pure
        returns (bytes32);

    // ──────────────────────── mutating ────────────────────────

    /// @notice Open a session where the caller IS the owner (EOA / 7702-delegated EOA path).
    /// @param delegate  The address authorized to {spend}.
    /// @param budgetCap The total spendable budget (non-zero).
    /// @param expiry    The unix-second expiry (must be in the future).
    /// @return sessionId The id of the opened session.
    function openSession(address delegate, uint256 budgetCap, uint64 expiry)
        external
        returns (bytes32 sessionId);

    /// @notice Open a session on behalf of `owner` by relaying an EIP-712 grant `owner` signed
    ///         off-chain. Validates `signature` against `owner` via EOA / ERC-1271 / ERC-6492, so the
    ///         owner may be a not-yet-deployed smart account (ERC-6492). Permissionless relayer.
    /// @param owner     The granting account the grant was signed by.
    /// @param delegate  The address authorized to {spend}.
    /// @param budgetCap The total spendable budget (non-zero).
    /// @param expiry    The unix-second expiry (must be in the future).
    /// @param signature The owner's grant signature (raw ECDSA, ERC-1271, or ERC-6492-wrapped).
    /// @return sessionId The id of the opened session.
    function openSessionFor(
        address owner,
        address delegate,
        uint256 budgetCap,
        uint64 expiry,
        bytes calldata signature
    ) external returns (bytes32 sessionId);

    /// @notice Spend `amount` against a live session. Only the session's delegate may call.
    /// @param sessionId The session to spend against.
    /// @param amount    The amount to spend (non-zero, within remaining budget).
    /// @return remainingAfter The budget remaining after this spend.
    function spend(bytes32 sessionId, uint256 amount) external returns (uint256 remainingAfter);

    /// @notice Revoke a session early. Only the session's owner may call.
    /// @param sessionId The session to revoke.
    function revoke(bytes32 sessionId) external;
}
