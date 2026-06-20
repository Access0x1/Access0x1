// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IAccess0x1ProvenanceRegistry
/// @author Rensley R. @vyperpilleddev
/// @notice Surface for Access0x1ProvenanceRegistry — an on-chain code-provenance ledger: an account
///         CLAIMS a repo (first-claim-wins), then ANCHORS immutable, timestamped snapshots (a Merkle
///         root over the repo tree + the source commit) and tagged RELEASES (a content id + tag +
///         Merkle root) under that repo. The chain is the notary: once anchored an entry is permanent
///         and publicly verifiable, so a downstream consumer can prove a given artifact corresponds to
///         exactly the source the repo owner committed to.
/// @dev    A "repo" is keyed by a caller-chosen `repoId` — typically `keccak256("github.com/owner/repo")`
///         — so the registry is host-agnostic and never trusts a string at write time. Ownership uses
///         per-repo two-step transfer (mirroring OpenZeppelin `Ownable2Step`): the current owner
///         PROPOSES a successor and the successor ACCEPTS, so a mistyped address can never strand a repo.
///         The anchor calls have a relayed twin (`anchorSnapshotWithSig` / `anchorReleaseWithSig`): the
///         repo owner signs an EIP-712 typed struct off-chain and any relayer submits it, gating on a
///         per-owner monotonic nonce + a deadline (the CodeQuill-parity delegation surface). The
///         registry holds NO funds — no token, no oracle, no payable function.
interface IAccess0x1ProvenanceRegistry {
    // ──────────────────────── types ────────────────────────

    /// @notice One anchored entry under a repo. Used for BOTH the snapshot history and the release
    ///         history (a snapshot leaves `cid`/`tag` empty; a release fills them).
    /// @param merkleRoot The Merkle root committing to the repo tree at this point (`bytes32`, the
    ///                   provenance fingerprint a consumer re-derives off-chain to verify a file).
    /// @param anchoredAt The `block.timestamp` (unix seconds) the entry was anchored — the notarized time.
    /// @param cid        The content id of the published artifact (e.g. an IPFS CID); empty for a snapshot.
    /// @param tag        The human release tag (e.g. "v1.2.0"); empty for a snapshot.
    /// @param commit     The source commit the entry pins (e.g. a git sha); set on a snapshot, empty on a
    ///                   release (a release is identified by `cid`/`tag`, not a raw commit).
    struct Anchor {
        bytes32 merkleRoot;
        uint64 anchoredAt;
        string cid;
        string tag;
        string commit;
    }

    // ──────────────────────── events ────────────────────────

    /// @notice A repo was claimed for the first time. `repoId` is now owned by `owner` (first-claim-wins).
    /// @param repoId The caller-chosen repo id (e.g. keccak256 of "github.com/owner/repo").
    /// @param owner  The account that claimed it and is now the repo owner.
    event RepoClaimed(bytes32 indexed repoId, address indexed owner);

    /// @notice The current owner proposed a new owner for `repoId` (step 1 of the two-step transfer).
    /// @param repoId         The repo whose ownership transfer was proposed.
    /// @param previousOwner  The current owner that made the proposal.
    /// @param proposedOwner  The account that may now {acceptRepoOwner}.
    event RepoOwnerProposed(
        bytes32 indexed repoId, address indexed previousOwner, address indexed proposedOwner
    );

    /// @notice The proposed owner accepted ownership of `repoId` (step 2 — the transfer completes here).
    /// @param repoId        The repo whose ownership transferred.
    /// @param previousOwner The owner that proposed the transfer.
    /// @param newOwner      The account that accepted and is now the repo owner.
    event RepoOwnerTransferred(
        bytes32 indexed repoId, address indexed previousOwner, address indexed newOwner
    );

    /// @notice A snapshot was anchored under `repoId` at history position `index`.
    /// @param repoId     The repo the snapshot belongs to.
    /// @param index      The snapshot's position in the per-repo snapshot history (0-based, append-only).
    /// @param merkleRoot The Merkle root committing to the repo tree at this snapshot.
    /// @param commit     The source commit the snapshot pins.
    event SnapshotAnchored(
        bytes32 indexed repoId, uint256 indexed index, bytes32 merkleRoot, string commit
    );

    /// @notice A release was anchored under `repoId` at history position `index`, and is now the latest.
    /// @param repoId     The repo the release belongs to.
    /// @param index      The release's position in the per-repo release history (0-based, append-only).
    /// @param cid        The content id of the released artifact (e.g. an IPFS CID).
    /// @param tag        The human release tag (e.g. "v1.2.0").
    /// @param merkleRoot The Merkle root committing to the released tree.
    event ReleaseAnchored(
        bytes32 indexed repoId, uint256 indexed index, string cid, string tag, bytes32 merkleRoot
    );

    // ──────────────────────── errors ────────────────────────

    /// @notice A zero address was supplied where a non-zero one is required (e.g. proposing owner 0).
    error Access0x1ProvenanceRegistry__ZeroAddress();

    /// @notice {claimRepo} was called for a `repoId` that is already owned.
    /// @param repoId The repo id already claimed.
    /// @param owner  Its current owner.
    error Access0x1ProvenanceRegistry__RepoAlreadyClaimed(bytes32 repoId, address owner);

    /// @notice A repo-scoped action referenced a `repoId` that has never been claimed.
    /// @param repoId The unknown repo id.
    error Access0x1ProvenanceRegistry__RepoNotClaimed(bytes32 repoId);

    /// @notice The caller (or the recovered signer) is not the current owner of `repoId`.
    /// @param repoId  The repo whose owner was required.
    /// @param caller  The account that attempted the owner-only action.
    error Access0x1ProvenanceRegistry__NotRepoOwner(bytes32 repoId, address caller);

    /// @notice {acceptRepoOwner} was called by an account that is not the pending proposed owner.
    /// @param repoId   The repo whose transfer was being accepted.
    /// @param caller   The account that attempted the accept.
    /// @param proposed The account that is actually allowed to accept (address(0) if none pending).
    error Access0x1ProvenanceRegistry__NotProposedOwner(
        bytes32 repoId, address caller, address proposed
    );

    /// @notice A history index was out of range for the repo's snapshot or release history.
    /// @param repoId The repo queried.
    /// @param index  The out-of-range index requested.
    /// @param length The current history length (valid indices are `[0, length)`).
    error Access0x1ProvenanceRegistry__IndexOutOfBounds(
        bytes32 repoId, uint256 index, uint256 length
    );

    /// @notice The repo has no latest release yet (no release has ever been anchored under it).
    /// @param repoId The repo queried.
    error Access0x1ProvenanceRegistry__NoRelease(bytes32 repoId);

    /// @notice A relayed (signed) anchor was submitted past its `deadline`.
    /// @param deadline The signature's deadline (unix seconds).
    /// @param nowTs    The current block timestamp.
    error Access0x1ProvenanceRegistry__SignatureExpired(uint256 deadline, uint256 nowTs);

    /// @notice A relayed (signed) anchor reused a nonce that has already been consumed.
    /// @param owner    The repo owner whose nonce was reused.
    /// @param expected The nonce the contract currently expects.
    /// @param supplied The nonce carried by the (replayed) signature.
    error Access0x1ProvenanceRegistry__BadNonce(address owner, uint256 expected, uint256 supplied);

    /// @notice The recovered signer of a relayed anchor is not the repo's current owner.
    /// @param repoId    The repo the relayed anchor targeted.
    /// @param recovered The address recovered from the signature.
    /// @param owner     The repo's current owner (who must have signed).
    error Access0x1ProvenanceRegistry__BadSignature(
        bytes32 repoId, address recovered, address owner
    );

    // ──────────────────────── views ────────────────────────

    /// @notice The current owner of `repoId`, or address(0) if it has never been claimed.
    /// @param repoId The repo id.
    /// @return owner The repo owner (address(0) when unclaimed).
    function repoOwnerOf(bytes32 repoId) external view returns (address owner);

    /// @notice The account proposed as the next owner of `repoId` (address(0) if none pending).
    /// @param repoId The repo id.
    /// @return proposed The pending proposed owner.
    function pendingRepoOwnerOf(bytes32 repoId) external view returns (address proposed);

    /// @notice The latest release anchored under `repoId`. Reverts {Access0x1ProvenanceRegistry__NoRelease}
    ///         if no release exists yet.
    /// @param repoId The repo id.
    /// @return cid        The content id of the latest release.
    /// @return tag        The latest release tag.
    /// @return merkleRoot The latest release's Merkle root.
    /// @return anchoredAt The unix second the latest release was anchored.
    function latestRelease(bytes32 repoId)
        external
        view
        returns (string memory cid, string memory tag, bytes32 merkleRoot, uint256 anchoredAt);

    /// @notice The number of releases anchored under `repoId` (0 if none / unclaimed).
    /// @param repoId The repo id.
    /// @return count The release-history length.
    function releaseCount(bytes32 repoId) external view returns (uint256 count);

    /// @notice Read a release from `repoId`'s history by position. Reverts
    ///         {Access0x1ProvenanceRegistry__IndexOutOfBounds} if `index >= releaseCount`.
    /// @param repoId The repo id.
    /// @param index  The 0-based history position.
    /// @return entry The release {Anchor} at `index`.
    function getRelease(bytes32 repoId, uint256 index) external view returns (Anchor memory entry);

    /// @notice The number of snapshots anchored under `repoId` (0 if none / unclaimed).
    /// @param repoId The repo id.
    /// @return count The snapshot-history length.
    function snapshotCount(bytes32 repoId) external view returns (uint256 count);

    /// @notice Read a snapshot from `repoId`'s history by position. Reverts
    ///         {Access0x1ProvenanceRegistry__IndexOutOfBounds} if `index >= snapshotCount`.
    /// @param repoId The repo id.
    /// @param index  The 0-based history position.
    /// @return entry The snapshot {Anchor} at `index`.
    function getSnapshot(bytes32 repoId, uint256 index) external view returns (Anchor memory entry);

    /// @notice The next unconsumed relayed-anchor nonce for `owner` (used by the next signed anchor).
    /// @param owner The repo owner.
    /// @return nonce The next nonce.
    function nonceOf(address owner) external view returns (uint256 nonce);

    // ──────────────────────── mutating ────────────────────────

    /// @notice Claim `repoId` for `msg.sender` (first-claim-wins). Reverts
    ///         {Access0x1ProvenanceRegistry__RepoAlreadyClaimed} if it is already owned.
    /// @param repoId The caller-chosen repo id (e.g. keccak256 of "github.com/owner/repo").
    function claimRepo(bytes32 repoId) external;

    /// @notice Propose `newOwner` as the next owner of `repoId` (step 1 of the two-step transfer). Only
    ///         the current repo owner may call.
    /// @param repoId   The repo to transfer.
    /// @param newOwner The proposed successor (non-zero).
    function proposeRepoOwner(bytes32 repoId, address newOwner) external;

    /// @notice Accept ownership of `repoId` (step 2 — completes the two-step transfer). Only the account
    ///         previously proposed via {proposeRepoOwner} may call.
    /// @param repoId The repo whose ownership to accept.
    function acceptRepoOwner(bytes32 repoId) external;

    /// @notice Anchor a snapshot under `repoId` (append-only history). Only the current repo owner.
    /// @param repoId     The repo to anchor under.
    /// @param merkleRoot The Merkle root committing to the repo tree.
    /// @param commit     The source commit the snapshot pins.
    /// @return index The snapshot's position in the per-repo history.
    function anchorSnapshot(bytes32 repoId, bytes32 merkleRoot, string calldata commit)
        external
        returns (uint256 index);

    /// @notice Anchor a release under `repoId`: store it as the latest release AND append it to the
    ///         release history. Only the current repo owner.
    /// @param repoId     The repo to anchor under.
    /// @param cid        The content id of the released artifact (e.g. an IPFS CID).
    /// @param tag        The release tag (e.g. "v1.2.0").
    /// @param merkleRoot The Merkle root committing to the released tree.
    /// @return index The release's position in the per-repo history.
    function anchorRelease(
        bytes32 repoId,
        string calldata cid,
        string calldata tag,
        bytes32 merkleRoot
    ) external returns (uint256 index);

    /// @notice Relayed twin of {anchorSnapshot}: the repo owner signs an EIP-712 {AnchorSnapshot} struct
    ///         off-chain and any relayer submits it here. Gated on the owner's nonce + a deadline; reverts
    ///         on an expired deadline, a reused nonce, or a recovered signer that is not the repo owner.
    /// @param repoId     The repo to anchor under.
    /// @param merkleRoot The Merkle root committing to the repo tree.
    /// @param commit     The source commit the snapshot pins.
    /// @param nonce      The signer's anchor nonce (must equal the owner's current nonce).
    /// @param deadline   The signature's deadline (unix seconds; must be >= now).
    /// @param signature  The repo owner's EIP-712 signature over the {AnchorSnapshot} struct.
    /// @return index The snapshot's position in the per-repo history.
    function anchorSnapshotWithSig(
        bytes32 repoId,
        bytes32 merkleRoot,
        string calldata commit,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 index);

    /// @notice Relayed twin of {anchorRelease}: the repo owner signs an EIP-712 {AnchorRelease} struct
    ///         off-chain and any relayer submits it here. Gated on the owner's nonce + a deadline; reverts
    ///         on an expired deadline, a reused nonce, or a recovered signer that is not the repo owner.
    /// @param repoId     The repo to anchor under.
    /// @param cid        The content id of the released artifact (e.g. an IPFS CID).
    /// @param tag        The release tag (e.g. "v1.2.0").
    /// @param merkleRoot The Merkle root committing to the released tree.
    /// @param nonce      The signer's anchor nonce (must equal the owner's current nonce).
    /// @param deadline   The signature's deadline (unix seconds; must be >= now).
    /// @param signature  The repo owner's EIP-712 signature over the {AnchorRelease} struct.
    /// @return index The release's position in the per-repo history.
    function anchorReleaseWithSig(
        bytes32 repoId,
        string calldata cid,
        string calldata tag,
        bytes32 merkleRoot,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 index);
}
