// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Receiver } from "../../src/Access0x1Receiver.sol";

/// @notice A would-be impersonator: a contract that tries to forward a forged report. It is NOT the
///         configured KeystoneForwarder, so every call it makes must be rejected at the Forwarder gate.
contract ForwarderImpersonator {
    Access0x1Receiver internal immutable receiver;

    constructor(Access0x1Receiver receiver_) {
        receiver = receiver_;
    }

    function tryReport(bytes calldata metadata, bytes calldata report) external {
        receiver.onReport(metadata, report);
    }
}

/// @notice Adversarial suite for Access0x1Receiver (the CRE "Notified Settlement" audit consumer).
///         The contract is OFF the money path by construction, so the threat model is integrity of the
///         audit trail itself: (1) FORGED REPORT — only the trusted Forwarder + an allowlisted
///         workflow owner+name may write; (2) WRONG FORWARDER — any other caller (EOA or contract) is
///         rejected; (3) REPLAY — a captured report cannot be re-delivered by a non-Forwarder, and the
///         append-only log's monotonic id behavior is pinned; (4) METADATA LENGTH — short/boundary/
///         malformed metadata is handled exactly (>=62 readable bytes, never a hard ==62). A passing
///         test means the forgery/abuse is REJECTED or its (benign, documented) behavior is proven.
contract Access0x1ReceiverAttackTest is Test {
    Access0x1Receiver internal receiver;

    address internal forwarder = makeAddr("forwarder");
    address internal owner = makeAddr("owner");
    address internal attacker = makeAddr("attacker");
    address internal workflowOwner = makeAddr("workflowOwner");
    address internal rogueWorkflowOwner = makeAddr("rogueWorkflowOwner");

    bytes10 internal constant WF_NAME = bytes10("notify-set");
    bytes10 internal constant ROGUE_NAME = bytes10("evil-wf");

    struct AuditEntry {
        uint256 merchantId;
        address token;
        uint256 grossAmount;
        uint256 usdAmount8;
        bytes32 orderId;
        uint64 srcChainSelector;
        uint64 notifiedAt;
    }

    function setUp() public {
        receiver = new Access0x1Receiver(forwarder, owner);
        vm.startPrank(owner);
        receiver.setAllowedWorkflowOwner(workflowOwner, true);
        receiver.setAllowedWorkflowName(WF_NAME, true);
        vm.stopPrank();
    }

    /// @dev Build the Keystone default-layout metadata: 32 cid + 10 name + 20 owner + 2 report = 64.
    function _metadata(bytes10 name, address wfOwner) internal pure returns (bytes memory) {
        bytes32 cid = keccak256("workflow-cid");
        bytes2 reportName = bytes2("r1");
        return abi.encodePacked(cid, name, bytes20(wfOwner), reportName);
    }

    function _report(AuditEntry memory e) internal pure returns (bytes memory) {
        return abi.encode(e);
    }

    function _entry() internal pure returns (AuditEntry memory) {
        return AuditEntry({
            merchantId: 42,
            token: address(0xBEEF),
            grossAmount: 1_000e6,
            usdAmount8: 1_000e8,
            orderId: keccak256("order-1"),
            srcChainSelector: 16_015_286_601_757_825_753,
            notifiedAt: 1_700_000_123
        });
    }

    /*//////////////////////////////////////////////////////////////
                          ATTACK: WRONG FORWARDER
    //////////////////////////////////////////////////////////////*/

    /// @dev A random EOA cannot write an audit entry — the Forwarder gate rejects it before any decode.
    function test_attack_wrongForwarder_eoa() public {
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Receiver.UnauthorizedForwarder.selector, attacker)
        );
        receiver.onReport(_metadata(WF_NAME, workflowOwner), _report(_entry()));
    }

    /// @dev A CONTRACT impersonating the Forwarder is rejected too — the gate is an address equality on
    ///      the immutable `i_forwarder`, not a code/interface check that could be spoofed.
    function test_attack_wrongForwarder_contract() public {
        ForwarderImpersonator imp = new ForwarderImpersonator(receiver);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Receiver.UnauthorizedForwarder.selector, address(imp))
        );
        imp.tryReport(_metadata(WF_NAME, workflowOwner), _report(_entry()));
        assertEq(receiver.auditCount(), 0); // nothing written
    }

    /// @dev Even the contract OWNER (admin of the allowlist) cannot write a report directly — only the
    ///      Forwarder may. Admin power is over the allowlist, never over the audit-write path.
    function test_attack_ownerCannotForgeReport() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Receiver.UnauthorizedForwarder.selector, owner)
        );
        receiver.onReport(_metadata(WF_NAME, workflowOwner), _report(_entry()));
    }

    /*//////////////////////////////////////////////////////////////
                          ATTACK: FORGED REPORT
    //////////////////////////////////////////////////////////////*/

    /// @dev A report whose metadata names a NON-allowlisted workflow owner is rejected, even when it
    ///      arrives from the real Forwarder with an allowlisted workflow NAME.
    function test_attack_forgedReport_rogueWorkflowOwner() public {
        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Receiver.UnauthorizedWorkflowOwner.selector, rogueWorkflowOwner
            )
        );
        receiver.onReport(_metadata(WF_NAME, rogueWorkflowOwner), _report(_entry()));
    }

    /// @dev A report with an allowlisted owner but a NON-allowlisted workflow name is rejected — both
    ///      dimensions of the allowlist must match.
    function test_attack_forgedReport_rogueWorkflowName() public {
        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Receiver.UnauthorizedWorkflowName.selector, ROGUE_NAME)
        );
        receiver.onReport(_metadata(ROGUE_NAME, workflowOwner), _report(_entry()));
    }

    /// @dev A revoked workflow owner can no longer write: the operator turning off the allowlist bit is
    ///      an instant kill-switch on a compromised workflow.
    function test_attack_revokedWorkflowOwner_cannotWrite() public {
        // First a legit write to confirm the path works.
        vm.prank(forwarder);
        receiver.onReport(_metadata(WF_NAME, workflowOwner), _report(_entry()));
        assertEq(receiver.auditCount(), 1);

        // Operator revokes the workflow owner.
        vm.prank(owner);
        receiver.setAllowedWorkflowOwner(workflowOwner, false);

        // The very next report from the same (now-revoked) workflow is rejected.
        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Receiver.UnauthorizedWorkflowOwner.selector, workflowOwner
            )
        );
        receiver.onReport(_metadata(WF_NAME, workflowOwner), _report(_entry()));
        assertEq(receiver.auditCount(), 1); // no new entry
    }

    /*//////////////////////////////////////////////////////////////
                            ATTACK: REPLAY
    //////////////////////////////////////////////////////////////*/

    /// @dev A captured report cannot be REPLAYED by a non-Forwarder (the gate stops it). This is the
    ///      replay protection that matters: an attacker who sniffs a valid report off-chain cannot
    ///      re-submit it themselves.
    function test_attack_replay_byNonForwarder_rejected() public {
        bytes memory md = _metadata(WF_NAME, workflowOwner);
        bytes memory rep = _report(_entry());

        // Legit delivery once.
        vm.prank(forwarder);
        receiver.onReport(md, rep);
        assertEq(receiver.auditCount(), 1);

        // Attacker captures and replays — rejected at the Forwarder gate.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Receiver.UnauthorizedForwarder.selector, attacker)
        );
        receiver.onReport(md, rep);
        assertEq(receiver.auditCount(), 1); // unchanged
    }

    /// @dev The audit log is append-only by design: even a Forwarder re-delivering the SAME report
    ///      appends a NEW entry with a fresh monotonic id (Keystone may retry; an audit trail records
    ///      every delivery). Crucially this is BENIGN — the contract is off the money path, so a
    ///      duplicate audit entry moves no funds and changes no settlement. We pin the monotonic id.
    function test_replay_byForwarder_appendsMonotonicAuditIds() public {
        bytes memory md = _metadata(WF_NAME, workflowOwner);
        bytes memory rep = _report(_entry());

        vm.startPrank(forwarder);
        receiver.onReport(md, rep);
        receiver.onReport(md, rep); // identical report again
        receiver.onReport(md, rep);
        vm.stopPrank();

        // Three deliveries → three audit entries, ids 0,1,2 (the next id == auditCount).
        assertEq(receiver.auditCount(), 3);
    }

    /*//////////////////////////////////////////////////////////////
                         ATTACK: METADATA LENGTH
    //////////////////////////////////////////////////////////////*/

    /// @dev Metadata shorter than the 62 readable bytes the decoder needs must revert cleanly (not
    ///      read out of bounds / return garbage workflow identity that could slip past the allowlist).
    function test_attack_metadata_tooShort_reverts() public {
        bytes memory shortMd = new bytes(61); // one byte short of the 62-byte floor
        vm.prank(forwarder);
        vm.expectRevert(bytes("Access0x1Receiver: short metadata"));
        receiver.onReport(shortMd, _report(_entry()));
    }

    /// @dev Empty metadata is the degenerate short case — also rejected.
    function test_attack_metadata_empty_reverts() public {
        vm.prank(forwarder);
        vm.expectRevert(bytes("Access0x1Receiver: short metadata"));
        receiver.onReport(new bytes(0), _report(_entry()));
    }

    /// @dev A 62-byte buffer crafted so its [32..42) name + [42..62) owner slice to a NON-allowlisted
    ///      identity is rejected at the allowlist — proving the fixed-offset decode reads the right
    ///      window and a length-only attack cannot forge an allowlisted workflow.
    function test_attack_metadata_exactly62_wrongIdentity_rejected() public {
        // 62 bytes of zero → workflowName = bytes10(0), workflowOwner = address(0): not allowlisted.
        bytes memory md = new bytes(62);
        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Receiver.UnauthorizedWorkflowOwner.selector, address(0))
        );
        receiver.onReport(md, _report(_entry()));
    }

    /// @dev OVERSIZED metadata (well beyond the 64-byte prod layout) must NOT revert on length — the
    ///      decoder slices by fixed offset and ignores the tail. A hard ==62 check would wrongly reject
    ///      this; the contract deliberately uses >=62. The allowlisted identity in the first 62 bytes
    ///      still governs, so a padded buffer cannot smuggle a different workflow.
    function test_attack_metadata_oversized_decodesByOffset() public {
        bytes32 cid = keccak256("cid");
        bytes memory tail = new bytes(128); // arbitrary trailing junk
        bytes memory md = abi.encodePacked(cid, WF_NAME, bytes20(workflowOwner), bytes2("r1"), tail);
        assertGt(md.length, 64);

        vm.prank(forwarder);
        receiver.onReport(md, _report(_entry())); // must NOT revert
        assertEq(receiver.auditCount(), 1);
    }

    /// @dev A metadata buffer whose name/owner window points at an allowlisted identity but with junk
    ///      in the cid prefix still passes — the cid is not part of the trust decision, only name+owner
    ///      are. This pins exactly which bytes the gate trusts (defense against over-trusting the cid).
    function test_attack_metadata_junkCidIgnored() public {
        bytes32 junkCid = bytes32(type(uint256).max);
        bytes memory md = abi.encodePacked(junkCid, WF_NAME, bytes20(workflowOwner), bytes2("r1"));
        vm.prank(forwarder);
        receiver.onReport(md, _report(_entry()));
        assertEq(receiver.auditCount(), 1);
    }
}
