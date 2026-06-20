// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1ProvenanceRegistry } from "../../src/Access0x1ProvenanceRegistry.sol";
import {
    IAccess0x1ProvenanceRegistry
} from "../../src/interfaces/IAccess0x1ProvenanceRegistry.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    OwnableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @notice A trivial v2 implementation used by the upgrade test: a subclass that adds one view function
///         and changes nothing else, so an upgrade to it must preserve all prior state. It deliberately
///         carries no new storage (it would consume from `__gap` if it did), proving the proxy keeps
///         every slot across the implementation swap.
contract Access0x1ProvenanceRegistryV2 is Access0x1ProvenanceRegistry {
    /// @notice A marker the original implementation does not expose — lets the test prove the new logic
    ///         is live after {upgradeToAndCall}.
    /// @return The constant string identifying this as the v2 implementation.
    function version2Marker() external pure returns (string memory) {
        return "v2";
    }
}

/// @notice The Access0x1ProvenanceRegistry unit suite — claim (first-wins + double-claim revert), the
///         per-repo two-step ownership transfer, the direct + relayed (EIP-712) snapshot/release anchors
///         with event + history/latest correctness, and every view. The registry is deployed BEHIND a
///         UUPS proxy (deploy impl → `ERC1967Proxy` with `initialize(...)` calldata → cast the proxy to
///         the type) via the shared {ProxyDeployer}, so every behavioural test exercises the production
///         proxy↔impl shape. Signature paths use `vm.sign` against the contract's own typed-data digest;
///         deadline liveness is driven with `vm.warp`. Tail tests cover the UUPS upgrade + the permanent
///         freeze via `renounceOwnership`.
contract Access0x1ProvenanceRegistryTest is Test, ProxyDeployer {
    Access0x1ProvenanceRegistry internal reg;

    uint256 internal ownerPk;
    address internal owner;
    address internal newOwner = makeAddr("newOwner");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");

    /// @dev The contract (upgrade-admin) owner — the `Ownable2Step` owner, DISTINCT from the per-repo
    ///      owners. Authorizes UUPS upgrades; renouncing it freezes the implementation forever.
    address internal admin = makeAddr("admin");

    bytes32 internal constant REPO = keccak256("github.com/Access0x1/Access0x1");
    bytes32 internal constant ROOT = keccak256("merkle-root-1");
    bytes32 internal constant ROOT2 = keccak256("merkle-root-2");
    string internal constant COMMIT = "a1b2c3d4e5f6";
    string internal constant CID = "bafybeigdyrztexampleexampleexampleexamplecid";
    string internal constant TAG = "v1.0.0";

    uint256 internal deadline;

    function setUp() public {
        // Deploy the implementation, then the ERC1967 proxy that initializes it, then drive the proxy.
        address impl = address(new Access0x1ProvenanceRegistry());
        address proxy = deployProxy(
            impl,
            abi.encodeCall(
                Access0x1ProvenanceRegistry.initialize, ("Access0x1 ProvenanceRegistry", "1", admin)
            )
        );
        reg = Access0x1ProvenanceRegistry(proxy);
        (owner, ownerPk) = makeAddrAndKey("owner");
        deadline = block.timestamp + 1 days;
    }

    function _claim() internal {
        vm.prank(owner);
        reg.claimRepo(REPO);
    }

    /*//////////////////////////////////////////////////////////////
                                  CLAIM
    //////////////////////////////////////////////////////////////*/

    function test_claimRepo_firstWins() public {
        vm.expectEmit(true, true, false, false, address(reg));
        emit IAccess0x1ProvenanceRegistry.RepoClaimed(REPO, owner);
        vm.prank(owner);
        reg.claimRepo(REPO);

        assertEq(reg.repoOwnerOf(REPO), owner);
        assertEq(reg.pendingRepoOwnerOf(REPO), address(0));
    }

    function test_claimRepo_revertAlreadyClaimed() public {
        _claim();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__RepoAlreadyClaimed
                .selector,
                REPO,
                owner
            )
        );
        reg.claimRepo(REPO);
        // The original owner is unchanged.
        assertEq(reg.repoOwnerOf(REPO), owner);
    }

    function test_repoOwnerOf_unclaimed_zero() public view {
        assertEq(reg.repoOwnerOf(keccak256("never")), address(0));
    }

    /*//////////////////////////////////////////////////////////////
                          OWNERSHIP (2-STEP)
    //////////////////////////////////////////////////////////////*/

    function test_proposeAndAccept_transfersOwnership() public {
        _claim();

        vm.expectEmit(true, true, true, false, address(reg));
        emit IAccess0x1ProvenanceRegistry.RepoOwnerProposed(REPO, owner, newOwner);
        vm.prank(owner);
        reg.proposeRepoOwner(REPO, newOwner);
        assertEq(reg.pendingRepoOwnerOf(REPO), newOwner);
        assertEq(reg.repoOwnerOf(REPO), owner); // not yet transferred

        vm.expectEmit(true, true, true, false, address(reg));
        emit IAccess0x1ProvenanceRegistry.RepoOwnerTransferred(REPO, owner, newOwner);
        vm.prank(newOwner);
        reg.acceptRepoOwner(REPO);

        assertEq(reg.repoOwnerOf(REPO), newOwner);
        assertEq(reg.pendingRepoOwnerOf(REPO), address(0)); // cleared
    }

    function test_proposeRepoOwner_revertNotOwner() public {
        _claim();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__NotRepoOwner.selector,
                REPO,
                stranger
            )
        );
        reg.proposeRepoOwner(REPO, newOwner);
    }

    function test_proposeRepoOwner_revertZeroAddress() public {
        _claim();
        vm.prank(owner);
        vm.expectRevert(
            IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__ZeroAddress.selector
        );
        reg.proposeRepoOwner(REPO, address(0));
    }

    function test_proposeRepoOwner_revertRepoNotClaimed() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__RepoNotClaimed.selector,
                REPO
            )
        );
        reg.proposeRepoOwner(REPO, newOwner);
    }

    function test_acceptRepoOwner_revertNotProposed() public {
        _claim();
        vm.prank(owner);
        reg.proposeRepoOwner(REPO, newOwner);

        vm.prank(stranger); // not the proposed owner
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__NotProposedOwner.selector,
                REPO,
                stranger,
                newOwner
            )
        );
        reg.acceptRepoOwner(REPO);
    }

    function test_acceptRepoOwner_revertWhenNonePending() public {
        _claim();
        // No proposal made; pending is address(0), so any caller != address(0) is rejected.
        vm.prank(newOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__NotProposedOwner.selector,
                REPO,
                newOwner,
                address(0)
            )
        );
        reg.acceptRepoOwner(REPO);
    }

    function test_proposeRepoOwner_reproposeOverwrites() public {
        _claim();
        vm.startPrank(owner);
        reg.proposeRepoOwner(REPO, newOwner);
        reg.proposeRepoOwner(REPO, stranger); // overwrite the pending
        vm.stopPrank();
        assertEq(reg.pendingRepoOwnerOf(REPO), stranger);

        // The stale proposed owner can no longer accept.
        vm.prank(newOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__NotProposedOwner.selector,
                REPO,
                newOwner,
                stranger
            )
        );
        reg.acceptRepoOwner(REPO);
    }

    function test_newOwner_canAnchorAfterTransfer() public {
        _claim();
        vm.prank(owner);
        reg.proposeRepoOwner(REPO, newOwner);
        vm.prank(newOwner);
        reg.acceptRepoOwner(REPO);

        // New owner can anchor; old owner cannot.
        vm.prank(newOwner);
        reg.anchorSnapshot(REPO, ROOT, COMMIT);
        assertEq(reg.snapshotCount(REPO), 1);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__NotRepoOwner.selector,
                REPO,
                owner
            )
        );
        reg.anchorSnapshot(REPO, ROOT, COMMIT);
    }

    /*//////////////////////////////////////////////////////////////
                            ANCHOR SNAPSHOT
    //////////////////////////////////////////////////////////////*/

    function test_anchorSnapshot_success_emitsAndStores() public {
        _claim();

        vm.expectEmit(true, true, false, true, address(reg));
        emit IAccess0x1ProvenanceRegistry.SnapshotAnchored(REPO, 0, ROOT, COMMIT);
        vm.prank(owner);
        uint256 index = reg.anchorSnapshot(REPO, ROOT, COMMIT);

        assertEq(index, 0);
        assertEq(reg.snapshotCount(REPO), 1);

        IAccess0x1ProvenanceRegistry.Anchor memory a = reg.getSnapshot(REPO, 0);
        assertEq(a.merkleRoot, ROOT);
        assertEq(a.anchoredAt, uint64(block.timestamp));
        assertEq(a.commit, COMMIT);
        assertEq(a.cid, "");
        assertEq(a.tag, "");
    }

    function test_anchorSnapshot_appendsHistory() public {
        _claim();
        vm.startPrank(owner);
        uint256 i0 = reg.anchorSnapshot(REPO, ROOT, COMMIT);
        uint256 i1 = reg.anchorSnapshot(REPO, ROOT2, "second");
        vm.stopPrank();

        assertEq(i0, 0);
        assertEq(i1, 1);
        assertEq(reg.snapshotCount(REPO), 2);
        assertEq(reg.getSnapshot(REPO, 0).merkleRoot, ROOT);
        assertEq(reg.getSnapshot(REPO, 1).merkleRoot, ROOT2);
        assertEq(reg.getSnapshot(REPO, 1).commit, "second");
    }

    function test_anchorSnapshot_revertNotOwner() public {
        _claim();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__NotRepoOwner.selector,
                REPO,
                stranger
            )
        );
        reg.anchorSnapshot(REPO, ROOT, COMMIT);
    }

    function test_anchorSnapshot_revertRepoNotClaimed() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__RepoNotClaimed.selector,
                REPO
            )
        );
        reg.anchorSnapshot(REPO, ROOT, COMMIT);
    }

    function test_getSnapshot_revertOutOfBounds() public {
        _claim();
        vm.prank(owner);
        reg.anchorSnapshot(REPO, ROOT, COMMIT); // length 1, valid index 0
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__IndexOutOfBounds.selector,
                REPO,
                1,
                1
            )
        );
        reg.getSnapshot(REPO, 1);
    }

    /*//////////////////////////////////////////////////////////////
                            ANCHOR RELEASE
    //////////////////////////////////////////////////////////////*/

    function test_anchorRelease_success_emitsStoresAndLatest() public {
        _claim();

        vm.expectEmit(true, true, false, true, address(reg));
        emit IAccess0x1ProvenanceRegistry.ReleaseAnchored(REPO, 0, CID, TAG, ROOT);
        vm.prank(owner);
        uint256 index = reg.anchorRelease(REPO, CID, TAG, ROOT);

        assertEq(index, 0);
        assertEq(reg.releaseCount(REPO), 1);

        IAccess0x1ProvenanceRegistry.Anchor memory a = reg.getRelease(REPO, 0);
        assertEq(a.merkleRoot, ROOT);
        assertEq(a.cid, CID);
        assertEq(a.tag, TAG);
        assertEq(a.commit, "");
        assertEq(a.anchoredAt, uint64(block.timestamp));

        (string memory cid, string memory tag, bytes32 root, uint256 at) = reg.latestRelease(REPO);
        assertEq(cid, CID);
        assertEq(tag, TAG);
        assertEq(root, ROOT);
        assertEq(at, block.timestamp);
    }

    function test_anchorRelease_latestTracksNewest() public {
        _claim();
        vm.startPrank(owner);
        reg.anchorRelease(REPO, CID, TAG, ROOT);
        reg.anchorRelease(REPO, "cid-2", "v2.0.0", ROOT2);
        vm.stopPrank();

        assertEq(reg.releaseCount(REPO), 2);
        (string memory cid, string memory tag, bytes32 root,) = reg.latestRelease(REPO);
        assertEq(cid, "cid-2");
        assertEq(tag, "v2.0.0");
        assertEq(root, ROOT2);
        // History keeps the first release at index 0.
        assertEq(reg.getRelease(REPO, 0).tag, TAG);
    }

    function test_anchorRelease_revertNotOwner() public {
        _claim();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__NotRepoOwner.selector,
                REPO,
                stranger
            )
        );
        reg.anchorRelease(REPO, CID, TAG, ROOT);
    }

    function test_latestRelease_revertNoRelease() public {
        _claim();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__NoRelease.selector, REPO
            )
        );
        reg.latestRelease(REPO);
    }

    function test_getRelease_revertOutOfBounds() public {
        _claim();
        vm.prank(owner);
        reg.anchorRelease(REPO, CID, TAG, ROOT);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__IndexOutOfBounds.selector,
                REPO,
                5,
                1
            )
        );
        reg.getRelease(REPO, 5);
    }

    /*//////////////////////////////////////////////////////////////
                       RELAYED SNAPSHOT (EIP-712)
    //////////////////////////////////////////////////////////////*/

    function _signSnapshot(
        uint256 pk,
        bytes32 repoId,
        bytes32 root,
        string memory commit,
        uint256 nonce,
        uint256 dl
    ) internal view returns (bytes memory) {
        bytes32 digest = reg.anchorSnapshotDigest(repoId, root, commit, nonce, dl);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_anchorSnapshotWithSig_success_advancesNonce() public {
        _claim();
        bytes memory sig = _signSnapshot(ownerPk, REPO, ROOT, COMMIT, 0, deadline);

        vm.expectEmit(true, true, false, true, address(reg));
        emit IAccess0x1ProvenanceRegistry.SnapshotAnchored(REPO, 0, ROOT, COMMIT);
        vm.prank(relayer); // permissionless relayer submits the owner's signed anchor
        uint256 index = reg.anchorSnapshotWithSig(REPO, ROOT, COMMIT, 0, deadline, sig);

        assertEq(index, 0);
        assertEq(reg.snapshotCount(REPO), 1);
        assertEq(reg.getSnapshot(REPO, 0).commit, COMMIT);
        assertEq(reg.nonceOf(owner), 1); // nonce advanced
    }

    function test_anchorSnapshotWithSig_revertExpired() public {
        _claim();
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _signSnapshot(ownerPk, REPO, ROOT, COMMIT, 0, dl);
        vm.warp(dl + 1); // past the deadline

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__SignatureExpired.selector,
                dl,
                block.timestamp
            )
        );
        reg.anchorSnapshotWithSig(REPO, ROOT, COMMIT, 0, dl, sig);
    }

    function test_anchorSnapshotWithSig_revertReplayedNonce() public {
        _claim();
        bytes memory sig = _signSnapshot(ownerPk, REPO, ROOT, COMMIT, 0, deadline);

        vm.startPrank(relayer);
        reg.anchorSnapshotWithSig(REPO, ROOT, COMMIT, 0, deadline, sig); // consumes nonce 0
        // Replaying the same signature (nonce 0) now reverts: contract expects nonce 1.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__BadNonce.selector,
                owner,
                1,
                0
            )
        );
        reg.anchorSnapshotWithSig(REPO, ROOT, COMMIT, 0, deadline, sig);
        vm.stopPrank();
    }

    function test_anchorSnapshotWithSig_revertWrongSigner() public {
        _claim();
        (, uint256 strangerPk) = makeAddrAndKey("strangerSigner");
        // Stranger signs over the owner's repo; recovered signer != owner.
        bytes memory sig = _signSnapshot(strangerPk, REPO, ROOT, COMMIT, 0, deadline);
        address recovered = vm.addr(strangerPk);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__BadSignature.selector,
                REPO,
                recovered,
                owner
            )
        );
        reg.anchorSnapshotWithSig(REPO, ROOT, COMMIT, 0, deadline, sig);
    }

    function test_anchorSnapshotWithSig_revertTamperedField() public {
        _claim();
        bytes memory sig = _signSnapshot(ownerPk, REPO, ROOT, COMMIT, 0, deadline);
        // Relayer swaps the merkle root; the digest no longer matches → recovered != owner.
        vm.prank(relayer);
        vm.expectRevert(); // BadSignature with a recovered address that isn't the owner
        reg.anchorSnapshotWithSig(REPO, ROOT2, COMMIT, 0, deadline, sig);
    }

    function test_anchorSnapshotWithSig_revertRepoNotClaimed() public {
        bytes memory sig = _signSnapshot(ownerPk, REPO, ROOT, COMMIT, 0, deadline);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__RepoNotClaimed.selector,
                REPO
            )
        );
        reg.anchorSnapshotWithSig(REPO, ROOT, COMMIT, 0, deadline, sig);
    }

    /*//////////////////////////////////////////////////////////////
                        RELAYED RELEASE (EIP-712)
    //////////////////////////////////////////////////////////////*/

    function _signRelease(
        uint256 pk,
        bytes32 repoId,
        string memory cid,
        string memory tag,
        bytes32 root,
        uint256 nonce,
        uint256 dl
    ) internal view returns (bytes memory) {
        bytes32 digest = reg.anchorReleaseDigest(repoId, cid, tag, root, nonce, dl);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_anchorReleaseWithSig_success_advancesNonce() public {
        _claim();
        bytes memory sig = _signRelease(ownerPk, REPO, CID, TAG, ROOT, 0, deadline);

        vm.expectEmit(true, true, false, true, address(reg));
        emit IAccess0x1ProvenanceRegistry.ReleaseAnchored(REPO, 0, CID, TAG, ROOT);
        vm.prank(relayer);
        uint256 index = reg.anchorReleaseWithSig(REPO, CID, TAG, ROOT, 0, deadline, sig);

        assertEq(index, 0);
        assertEq(reg.releaseCount(REPO), 1);
        (string memory cid, string memory tag, bytes32 root,) = reg.latestRelease(REPO);
        assertEq(cid, CID);
        assertEq(tag, TAG);
        assertEq(root, ROOT);
        assertEq(reg.nonceOf(owner), 1);
    }

    function test_anchorReleaseWithSig_revertExpired() public {
        _claim();
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _signRelease(ownerPk, REPO, CID, TAG, ROOT, 0, dl);
        vm.warp(dl + 1);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__SignatureExpired.selector,
                dl,
                block.timestamp
            )
        );
        reg.anchorReleaseWithSig(REPO, CID, TAG, ROOT, 0, dl, sig);
    }

    function test_anchorReleaseWithSig_revertReplayedNonce() public {
        _claim();
        bytes memory sig = _signRelease(ownerPk, REPO, CID, TAG, ROOT, 0, deadline);

        vm.startPrank(relayer);
        reg.anchorReleaseWithSig(REPO, CID, TAG, ROOT, 0, deadline, sig);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__BadNonce.selector,
                owner,
                1,
                0
            )
        );
        reg.anchorReleaseWithSig(REPO, CID, TAG, ROOT, 0, deadline, sig);
        vm.stopPrank();
    }

    function test_anchorReleaseWithSig_revertWrongSigner() public {
        _claim();
        (, uint256 strangerPk) = makeAddrAndKey("strangerSigner");
        bytes memory sig = _signRelease(strangerPk, REPO, CID, TAG, ROOT, 0, deadline);
        address recovered = vm.addr(strangerPk);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__BadSignature.selector,
                REPO,
                recovered,
                owner
            )
        );
        reg.anchorReleaseWithSig(REPO, CID, TAG, ROOT, 0, deadline, sig);
    }

    function test_anchorReleaseWithSig_revertBadNonceFromStart() public {
        _claim();
        // Owner signs nonce 1 while the contract expects nonce 0.
        bytes memory sig = _signRelease(ownerPk, REPO, CID, TAG, ROOT, 1, deadline);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__BadNonce.selector,
                owner,
                0,
                1
            )
        );
        reg.anchorReleaseWithSig(REPO, CID, TAG, ROOT, 1, deadline, sig);
    }

    function test_relayedAnchors_shareOwnerNonce() public {
        _claim();
        // A snapshot (nonce 0) then a release (nonce 1) — one monotonic per-owner counter.
        bytes memory sigSnap = _signSnapshot(ownerPk, REPO, ROOT, COMMIT, 0, deadline);
        vm.prank(relayer);
        reg.anchorSnapshotWithSig(REPO, ROOT, COMMIT, 0, deadline, sigSnap);
        assertEq(reg.nonceOf(owner), 1);

        bytes memory sigRel = _signRelease(ownerPk, REPO, CID, TAG, ROOT2, 1, deadline);
        vm.prank(relayer);
        reg.anchorReleaseWithSig(REPO, CID, TAG, ROOT2, 1, deadline, sigRel);
        assertEq(reg.nonceOf(owner), 2);
    }

    /*//////////////////////////////////////////////////////////////
                            VIEWS / EDGE
    //////////////////////////////////////////////////////////////*/

    function test_counts_unclaimed_zero() public view {
        assertEq(reg.snapshotCount(keccak256("x")), 0);
        assertEq(reg.releaseCount(keccak256("x")), 0);
        assertEq(reg.nonceOf(stranger), 0);
        assertEq(reg.pendingRepoOwnerOf(keccak256("x")), address(0));
    }

    function test_domainSeparator_nonZero() public view {
        assertTrue(reg.domainSeparator() != bytes32(0));
    }

    function test_typehashes_match() public view {
        assertEq(
            reg.ANCHOR_SNAPSHOT_TYPEHASH(),
            keccak256(
                "AnchorSnapshot(bytes32 repoId,bytes32 merkleRoot,string commit,uint256 nonce,uint256 deadline)"
            )
        );
        assertEq(
            reg.ANCHOR_RELEASE_TYPEHASH(),
            keccak256(
                "AnchorRelease(bytes32 repoId,string cid,string tag,bytes32 merkleRoot,uint256 nonce,uint256 deadline)"
            )
        );
    }

    function testFuzz_claim_anyId_onlyOnce(bytes32 id) public {
        vm.prank(owner);
        reg.claimRepo(id);
        assertEq(reg.repoOwnerOf(id), owner);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1ProvenanceRegistry.Access0x1ProvenanceRegistry__RepoAlreadyClaimed
                .selector,
                id,
                owner
            )
        );
        reg.claimRepo(id);
    }

    /*//////////////////////////////////////////////////////////////
                          UUPS UPGRADE / FREEZE
    //////////////////////////////////////////////////////////////*/

    function test_initialize_setsAdminOwner() public view {
        // The contract owner is the upgrade admin set at initialize — independent of any repo owner.
        assertEq(OwnableUpgradeable(address(reg)).owner(), admin);
    }

    function test_initialize_revertOnSecondCall() public {
        // The proxy was already initialized in setUp; a second call must revert (one-time initializer).
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        reg.initialize("x", "1", admin);
    }

    function test_upgrade_preservesStateAndAddsFn() public {
        // Seed state under the v1 implementation: a claimed repo with one snapshot + one release.
        _claim();
        vm.startPrank(owner);
        reg.anchorSnapshot(REPO, ROOT, COMMIT);
        reg.anchorRelease(REPO, CID, TAG, ROOT2);
        vm.stopPrank();

        // The admin (contract owner) upgrades the proxy to v2.
        address v2 = address(new Access0x1ProvenanceRegistryV2());
        vm.prank(admin);
        UUPSUpgradeable(address(reg)).upgradeToAndCall(v2, "");

        // The new logic is live...
        assertEq(Access0x1ProvenanceRegistryV2(address(reg)).version2Marker(), "v2");

        // ...and ALL prior state survived the implementation swap (storage lives in the proxy).
        assertEq(reg.repoOwnerOf(REPO), owner);
        assertEq(reg.snapshotCount(REPO), 1);
        assertEq(reg.getSnapshot(REPO, 0).commit, COMMIT);
        assertEq(reg.releaseCount(REPO), 1);
        (string memory cid, string memory tag, bytes32 root,) = reg.latestRelease(REPO);
        assertEq(cid, CID);
        assertEq(tag, TAG);
        assertEq(root, ROOT2);
        assertEq(OwnableUpgradeable(address(reg)).owner(), admin); // upgrade admin unchanged
    }

    function test_upgrade_revertNonOwner() public {
        address v2 = address(new Access0x1ProvenanceRegistryV2());
        // A non-admin (even a repo owner) cannot upgrade — _authorizeUpgrade is onlyOwner.
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger)
        );
        UUPSUpgradeable(address(reg)).upgradeToAndCall(v2, "");
    }

    function test_freeze_renounceOwnershipBlocksUpgradeForever() public {
        // The admin renounces ownership: the upgrade admin becomes address(0).
        vm.prank(admin);
        OwnableUpgradeable(address(reg)).renounceOwnership();
        assertEq(OwnableUpgradeable(address(reg)).owner(), address(0));

        // With no owner, _authorizeUpgrade reverts for EVERYONE — the implementation is frozen forever.
        address v2 = address(new Access0x1ProvenanceRegistryV2());
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, admin)
        );
        UUPSUpgradeable(address(reg)).upgradeToAndCall(v2, "");
    }
}
