// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    Ownable2StepUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {
    EIP712Upgradeable
} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IAccess0x1ProvenanceRegistry } from "./interfaces/IAccess0x1ProvenanceRegistry.sol";

/// @title  Access0x1ProvenanceRegistry
/// @author Rensley R. @vyperpilleddev
/// @notice An on-chain code-provenance ledger — the CodeQuill-parity primitive. An account CLAIMS a
///         repo (first-claim-wins), then ANCHORS immutable, timestamped entries under it: SNAPSHOTS (a
///         Merkle root over the repo tree + the source commit) and tagged RELEASES (a content id + tag
///         + Merkle root). The chain is the notary — once anchored, an entry is permanent and publicly
///         verifiable, so a downstream consumer can prove a published artifact corresponds to exactly
///         the source the repo owner committed to. Repo ownership is per-repo two-step (mirroring OZ
///         `Ownable2Step`): the owner PROPOSES a successor and the successor ACCEPTS, so a mistyped
///         address can never strand a repo. Both anchor calls have a relayed twin (EIP-712 delegation):
///         the owner signs a typed struct off-chain and any relayer submits it, gated on a per-owner
///         nonce + deadline.
/// @dev    CUSTODY: NONE. This is a pure provenance ledger — no token, no oracle, no `payable` function,
///         no value transfer. Append-only histories grow but are never reordered or deleted, so an
///         anchored fingerprint is immutable. The ONLY external interaction anywhere is `ECDSA.recover`
///         on the relayed paths (a pure precompile call, no re-entrancy surface); even so the delegated
///         functions follow CEI — validate the signature, then consume the nonce, then write + emit.
///         `repoId` is a CALLER-CHOSEN id (typically `keccak256("github.com/owner/repo")`), so the
///         registry is host-agnostic and never parses a string at write time.
///
///         UPGRADEABILITY (the Access0x1 UUPS TEMPLATE — every other system contract follows this exact
///         shape): the contract is deployed behind an `ERC1967Proxy`; storage lives in the proxy, logic
///         in this implementation. State is set once via {initialize} (the constructor-replacement,
///         `initializer`-guarded); the implementation's own constructor calls `_disableInitializers()`
///         so the logic contract can never be initialized or hijacked directly. Upgrades route through
///         {upgradeToAndCall} and are authorized by {_authorizeUpgrade} (contract-`owner`-only — the
///         `Ownable2StepUpgradeable` owner, which is the UPGRADE ADMIN and is DISTINCT from the per-repo
///         owners). Calling `renounceOwnership()` permanently freezes the implementation (no owner ⇒ no
///         authorized upgrade ⇒ immutable forever). A trailing `__gap` reserves slots for safe future
///         storage appends.
contract Access0x1ProvenanceRegistry is
    IAccess0x1ProvenanceRegistry,
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    EIP712Upgradeable
{
    /// @notice The EIP-712 typehash for a relayed snapshot anchor.
    /// @dev    keccak256("AnchorSnapshot(bytes32 repoId,bytes32 merkleRoot,string commit,uint256
    ///         nonce,uint256 deadline)"). Pins every snapshot field + the replay nonce + the deadline
    ///         into the digest the owner signs, so a relayer cannot alter any field of the anchor it
    ///         submits. The `string commit` leg is hashed as `keccak256(bytes(commit))` per EIP-712.
    bytes32 public constant ANCHOR_SNAPSHOT_TYPEHASH = keccak256(
        "AnchorSnapshot(bytes32 repoId,bytes32 merkleRoot,string commit,uint256 nonce,uint256 deadline)"
    );

    /// @notice The EIP-712 typehash for a relayed release anchor.
    /// @dev    keccak256("AnchorRelease(bytes32 repoId,string cid,string tag,bytes32 merkleRoot,uint256
    ///         nonce,uint256 deadline)"). The `string` legs (`cid`, `tag`) are hashed as
    ///         `keccak256(bytes(...))` per EIP-712.
    bytes32 public constant ANCHOR_RELEASE_TYPEHASH = keccak256(
        "AnchorRelease(bytes32 repoId,string cid,string tag,bytes32 merkleRoot,uint256 nonce,uint256 deadline)"
    );

    /// @notice repoId ⇒ its current owner. address(0) means never claimed — the existence signal used by
    ///         every repo-scoped guard.
    mapping(bytes32 repoId => address owner) private _repoOwner;

    /// @notice repoId ⇒ the pending proposed owner (step 1 of the two-step transfer). Cleared to
    ///         address(0) the instant the transfer completes or a fresh proposal overwrites it.
    mapping(bytes32 repoId => address proposed) private _pendingRepoOwner;

    /// @notice repoId ⇒ its append-only snapshot history. Index = position; never reordered or deleted.
    mapping(bytes32 repoId => Anchor[] snapshots) private _snapshots;

    /// @notice repoId ⇒ its append-only release history. The LATEST release is the last element.
    mapping(bytes32 repoId => Anchor[] releases) private _releases;

    /// @notice owner ⇒ next unconsumed relayed-anchor nonce. The replay guard for the signed paths;
    ///         per-OWNER (not per-repo) so one monotonic counter covers every repo an account owns.
    mapping(address owner => uint256 nonce) private _nonces;

    /// @dev Reserved storage slots so future versions can APPEND new state without shifting the layout
    ///      above (UUPS storage-collision safety). Each new variable added in a later version consumes
    ///      one slot from the head of this gap; shrink `__gap` by exactly the number of slots added so
    ///      the total stays 50. NEVER reorder or insert a variable above this gap — only append.
    uint256[50] private __gap;

    /// @dev The implementation is the logic half of a UUPS pair; its OWN storage is never used in
    ///      production (the proxy holds state). `_disableInitializers()` burns the implementation's
    ///      initializer so it can never be initialized — and therefore never owned or upgraded — directly,
    ///      closing the classic uninitialized-implementation takeover. Runs at implementation-deploy time.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time initializer — the constructor-replacement for the proxy. Sets the EIP-712 domain
    ///         and the contract (upgrade-admin) owner. Guarded by `initializer`, so it runs exactly once
    ///         per proxy; the typical deploy is `new ERC1967Proxy(impl, abi.encodeCall(initialize, ...))`.
    /// @dev    Wires every base in inheritance order: EIP-712 domain, Ownable + its 2-step extension, and
    ///         the UUPS machinery. `initialOwner` becomes the UPGRADE ADMIN (the `Ownable2Step` owner) —
    ///         distinct from the per-repo owners; it must be non-zero (`__Ownable_init` reverts on zero).
    /// @param name         EIP-712 domain name.
    /// @param version      EIP-712 domain version.
    /// @param initialOwner The contract owner / upgrade admin (non-zero).
    function initialize(string memory name, string memory version, address initialOwner)
        external
        initializer
    {
        __EIP712_init(name, version);
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        // No `__UUPSUpgradeable_init()`: in OZ 5.x `UUPSUpgradeable` re-exports the non-upgradeable
        // contract (it holds no initializable storage), so there is no such initializer to call.
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1ProvenanceRegistry
    function repoOwnerOf(bytes32 repoId) external view returns (address owner) {
        return _repoOwner[repoId];
    }

    /// @inheritdoc IAccess0x1ProvenanceRegistry
    function pendingRepoOwnerOf(bytes32 repoId) external view returns (address proposed) {
        return _pendingRepoOwner[repoId];
    }

    /// @inheritdoc IAccess0x1ProvenanceRegistry
    function latestRelease(bytes32 repoId)
        external
        view
        returns (string memory cid, string memory tag, bytes32 merkleRoot, uint256 anchoredAt)
    {
        Anchor[] storage history = _releases[repoId];
        uint256 len = history.length;
        if (len == 0) revert Access0x1ProvenanceRegistry__NoRelease(repoId);
        Anchor storage latest = history[len - 1];
        return (latest.cid, latest.tag, latest.merkleRoot, latest.anchoredAt);
    }

    /// @inheritdoc IAccess0x1ProvenanceRegistry
    function releaseCount(bytes32 repoId) external view returns (uint256 count) {
        return _releases[repoId].length;
    }

    /// @inheritdoc IAccess0x1ProvenanceRegistry
    function getRelease(bytes32 repoId, uint256 index) external view returns (Anchor memory entry) {
        Anchor[] storage history = _releases[repoId];
        uint256 len = history.length;
        if (index >= len) revert Access0x1ProvenanceRegistry__IndexOutOfBounds(repoId, index, len);
        return history[index];
    }

    /// @inheritdoc IAccess0x1ProvenanceRegistry
    function snapshotCount(bytes32 repoId) external view returns (uint256 count) {
        return _snapshots[repoId].length;
    }

    /// @inheritdoc IAccess0x1ProvenanceRegistry
    function getSnapshot(bytes32 repoId, uint256 index)
        external
        view
        returns (Anchor memory entry)
    {
        Anchor[] storage history = _snapshots[repoId];
        uint256 len = history.length;
        if (index >= len) revert Access0x1ProvenanceRegistry__IndexOutOfBounds(repoId, index, len);
        return history[index];
    }

    /// @inheritdoc IAccess0x1ProvenanceRegistry
    function nonceOf(address owner) external view returns (uint256 nonce) {
        return _nonces[owner];
    }

    /// @notice The EIP-712 domain separator (exposed for off-chain signers / verification tooling).
    /// @return The domain separator for this contract.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice The EIP-712 digest the repo owner signs to authorize a relayed {anchorSnapshotWithSig}.
    /// @param repoId     The repo to anchor under.
    /// @param merkleRoot The Merkle root committing to the repo tree.
    /// @param commit     The source commit the snapshot pins.
    /// @param nonce      The signer's anchor nonce.
    /// @param deadline   The signature deadline (unix seconds).
    /// @return The typed-data digest to sign.
    function anchorSnapshotDigest(
        bytes32 repoId,
        bytes32 merkleRoot,
        string calldata commit,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ANCHOR_SNAPSHOT_TYPEHASH,
                    repoId,
                    merkleRoot,
                    keccak256(bytes(commit)),
                    nonce,
                    deadline
                )
            )
        );
    }

    /// @notice The EIP-712 digest the repo owner signs to authorize a relayed {anchorReleaseWithSig}.
    /// @param repoId     The repo to anchor under.
    /// @param cid        The content id of the released artifact.
    /// @param tag        The release tag.
    /// @param merkleRoot The Merkle root committing to the released tree.
    /// @param nonce      The signer's anchor nonce.
    /// @param deadline   The signature deadline (unix seconds).
    /// @return The typed-data digest to sign.
    function anchorReleaseDigest(
        bytes32 repoId,
        string calldata cid,
        string calldata tag,
        bytes32 merkleRoot,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ANCHOR_RELEASE_TYPEHASH,
                    repoId,
                    keccak256(bytes(cid)),
                    keccak256(bytes(tag)),
                    merkleRoot,
                    nonce,
                    deadline
                )
            )
        );
    }

    /*//////////////////////////////////////////////////////////////
                                  CLAIM
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1ProvenanceRegistry
    /// @dev First-claim-wins: a non-zero `_repoOwner[repoId]` means the id is taken. The caller becomes
    ///      the owner; there is no admin override, so claiming is permissionless and final.
    function claimRepo(bytes32 repoId) external {
        address current = _repoOwner[repoId];
        if (current != address(0)) {
            revert Access0x1ProvenanceRegistry__RepoAlreadyClaimed(repoId, current);
        }
        _repoOwner[repoId] = msg.sender;
        emit RepoClaimed(repoId, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                          OWNERSHIP (2-STEP)
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1ProvenanceRegistry
    /// @dev Step 1: the current owner records a pending successor. A zero `newOwner` is rejected (use a
    ///      fresh proposal to a real address to change the pending owner; there is no "cancel to zero"
    ///      footgun that could be mistaken for a transfer). Re-proposing overwrites any prior pending.
    function proposeRepoOwner(bytes32 repoId, address newOwner) external {
        if (newOwner == address(0)) revert Access0x1ProvenanceRegistry__ZeroAddress();
        address owner = _ownerOrRevert(repoId);
        if (msg.sender != owner) {
            revert Access0x1ProvenanceRegistry__NotRepoOwner(repoId, msg.sender);
        }
        _pendingRepoOwner[repoId] = newOwner;
        emit RepoOwnerProposed(repoId, owner, newOwner);
    }

    /// @inheritdoc IAccess0x1ProvenanceRegistry
    /// @dev Step 2: only the pending proposed owner may accept; the transfer completes and the pending
    ///      slot is cleared (so the same proposal cannot be replayed). CEI: state is written before the
    ///      event; there is no external call.
    function acceptRepoOwner(bytes32 repoId) external {
        address proposed = _pendingRepoOwner[repoId];
        if (msg.sender != proposed) {
            revert Access0x1ProvenanceRegistry__NotProposedOwner(repoId, msg.sender, proposed);
        }
        address previousOwner = _repoOwner[repoId];
        _repoOwner[repoId] = proposed;
        delete _pendingRepoOwner[repoId];
        emit RepoOwnerTransferred(repoId, previousOwner, proposed);
    }

    /*//////////////////////////////////////////////////////////////
                                 ANCHOR
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1ProvenanceRegistry
    /// @dev Owner-only direct path. Appends to the snapshot history; the assigned index is the prior
    ///      length. No external call — CEI holds trivially.
    function anchorSnapshot(bytes32 repoId, bytes32 merkleRoot, string calldata commit)
        external
        returns (uint256 index)
    {
        address owner = _ownerOrRevert(repoId);
        if (msg.sender != owner) {
            revert Access0x1ProvenanceRegistry__NotRepoOwner(repoId, msg.sender);
        }
        return _appendSnapshot(repoId, merkleRoot, commit);
    }

    /// @inheritdoc IAccess0x1ProvenanceRegistry
    /// @dev Owner-only direct path. Appends to the release history (the new last element is the latest
    ///      release). No external call — CEI holds trivially.
    function anchorRelease(
        bytes32 repoId,
        string calldata cid,
        string calldata tag,
        bytes32 merkleRoot
    ) external returns (uint256 index) {
        address owner = _ownerOrRevert(repoId);
        if (msg.sender != owner) {
            revert Access0x1ProvenanceRegistry__NotRepoOwner(repoId, msg.sender);
        }
        return _appendRelease(repoId, cid, tag, merkleRoot);
    }

    /*//////////////////////////////////////////////////////////////
                         ANCHOR (RELAYED / EIP-712)
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1ProvenanceRegistry
    /// @dev Relayed snapshot path. CEI: validate the deadline, the nonce, and the signature (recovered
    ///      signer == the CURRENT repo owner) BEFORE any state change; then consume the nonce (replay
    ///      guard) and append. `ECDSA.recover` is the only external interaction and it precedes every
    ///      write, so there is no re-entrancy surface.
    function anchorSnapshotWithSig(
        bytes32 repoId,
        bytes32 merkleRoot,
        string calldata commit,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 index) {
        address owner = _ownerOrRevert(repoId);
        bytes32 digest = anchorSnapshotDigest(repoId, merkleRoot, commit, nonce, deadline);
        _verifyRelayed(repoId, owner, digest, nonce, deadline, signature);
        return _appendSnapshot(repoId, merkleRoot, commit);
    }

    /// @inheritdoc IAccess0x1ProvenanceRegistry
    /// @dev Relayed release path. Same CEI ordering as {anchorSnapshotWithSig}: signature checks first,
    ///      then nonce consumption, then the append.
    function anchorReleaseWithSig(
        bytes32 repoId,
        string calldata cid,
        string calldata tag,
        bytes32 merkleRoot,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 index) {
        address owner = _ownerOrRevert(repoId);
        bytes32 digest = anchorReleaseDigest(repoId, cid, tag, merkleRoot, nonce, deadline);
        _verifyRelayed(repoId, owner, digest, nonce, deadline, signature);
        return _appendRelease(repoId, cid, tag, merkleRoot);
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @notice Authorize a UUPS upgrade. Restricted to the contract `owner` (the upgrade admin) — the
    ///         single gate {upgradeToAndCall} consults before swapping the implementation.
    /// @dev    Empty body: the `onlyOwner` modifier IS the policy. Once `renounceOwnership()` sets the
    ///         owner to address(0), every call here reverts, so the implementation becomes permanently
    ///         immutable (the on-chain "freeze"). `newImplementation` is intentionally unnamed — no
    ///         per-target allow-listing; the owner is fully trusted to vet the target off-chain.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }

    /// @dev Resolve `repoId`'s owner or revert if the repo was never claimed. The shared existence guard
    ///      for every repo-scoped action.
    /// @param repoId The repo id.
    /// @return owner The current repo owner (guaranteed non-zero on return).
    function _ownerOrRevert(bytes32 repoId) private view returns (address owner) {
        owner = _repoOwner[repoId];
        if (owner == address(0)) revert Access0x1ProvenanceRegistry__RepoNotClaimed(repoId);
    }

    /// @dev Shared relayed-anchor verifier: deadline, nonce match, signature-recovers-to-owner, then the
    ///      nonce is CONSUMED (the sole state change here). Ordered deadline → nonce → signature so a
    ///      relayer learns the cheapest disqualifier first; the nonce is bumped only once everything
    ///      passes, so a failed call leaves the nonce untouched and the owner can retry.
    /// @param repoId    The repo the relayed anchor targets (for the {BadSignature} context).
    /// @param owner     The current repo owner (must be the recovered signer).
    /// @param digest    The EIP-712 digest the owner is expected to have signed.
    /// @param nonce     The nonce the signature pinned (must equal the owner's current nonce).
    /// @param deadline  The signature deadline (must be >= now).
    /// @param signature The owner's ECDSA signature over `digest`.
    function _verifyRelayed(
        bytes32 repoId,
        address owner,
        bytes32 digest,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) private {
        if (block.timestamp > deadline) {
            revert Access0x1ProvenanceRegistry__SignatureExpired(deadline, block.timestamp);
        }
        uint256 expected = _nonces[owner];
        if (nonce != expected) {
            revert Access0x1ProvenanceRegistry__BadNonce(owner, expected, nonce);
        }
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != owner) {
            revert Access0x1ProvenanceRegistry__BadSignature(repoId, recovered, owner);
        }
        // Effect: consume the nonce (a uint256 counter cannot realistically overflow).
        unchecked {
            _nonces[owner] = expected + 1;
        }
    }

    /// @dev Append a snapshot to `repoId`'s history and emit. The assigned index is the prior length.
    /// @param repoId     The repo to anchor under.
    /// @param merkleRoot The Merkle root committing to the repo tree.
    /// @param commit     The source commit the snapshot pins.
    /// @return index The snapshot's position in the per-repo history.
    function _appendSnapshot(bytes32 repoId, bytes32 merkleRoot, string calldata commit)
        private
        returns (uint256 index)
    {
        Anchor[] storage history = _snapshots[repoId];
        index = history.length;
        history.push(
            Anchor({
                merkleRoot: merkleRoot,
                anchoredAt: uint64(block.timestamp),
                cid: "",
                tag: "",
                commit: commit
            })
        );
        emit SnapshotAnchored(repoId, index, merkleRoot, commit);
    }

    /// @dev Append a release to `repoId`'s history (the new last element is the latest release) and emit.
    ///      The assigned index is the prior length.
    /// @param repoId     The repo to anchor under.
    /// @param cid        The content id of the released artifact.
    /// @param tag        The release tag.
    /// @param merkleRoot The Merkle root committing to the released tree.
    /// @return index The release's position in the per-repo history.
    function _appendRelease(
        bytes32 repoId,
        string calldata cid,
        string calldata tag,
        bytes32 merkleRoot
    ) private returns (uint256 index) {
        Anchor[] storage history = _releases[repoId];
        index = history.length;
        history.push(
            Anchor({
                merkleRoot: merkleRoot,
                anchoredAt: uint64(block.timestamp),
                cid: cid,
                tag: tag,
                commit: ""
            })
        );
        emit ReleaseAnchored(repoId, index, cid, tag, merkleRoot);
    }
}
