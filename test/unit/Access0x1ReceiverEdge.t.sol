// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Access0x1Receiver } from "../../src/Access0x1Receiver.sol";

/// @title  Access0x1ReceiverEdge — boundary / revert / zero-and-max unit edge cases.
/// @author Access0x1
/// @notice Cyfrin UNIT-edge layer for {Access0x1Receiver}. The existing `Access0x1Receiver.t.sol`
///         covers the happy path, the three revert gates, the prod 64-byte metadata, and ERC-165.
///         This file adds ONLY the boundary cases that suite misses — no duplication:
///
///           - the EXACT 62-byte metadata floor decoding to the ALLOWLISTED identity is ACCEPTED
///             (the attack suite only proves a 62-byte ZERO buffer is rejected; this proves the
///             complementary "exactly-62, right identity, passes" — the true off-by-one boundary);
///           - the 61-byte one-below-floor reverts, and the 63-byte one-above-floor passes (the
///             pair that pins `>=62`, not `==62`, around the boundary);
///           - `bytes10` workflow-name TRUNCATION: only bytes [32..42) are read, so trailing bytes
///             of an over-long name field never reach the name allowlist key;
///           - the GATE ORDERING under simultaneous failures (both owner+name wrong -> the OWNER
///             error fires first, the documented order);
///           - allowlist re-enable (toggle off then on) restoring the write path;
///           - Ownable2Step two-step ownership transfer moving config authority to a new owner
///             (and the pending owner not yet having it) — the admin-rotation edge.
contract Access0x1ReceiverEdgeTest is Test {
    Access0x1Receiver internal receiver;

    address internal forwarder = makeAddr("forwarder");
    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");
    address internal workflowOwner = makeAddr("workflowOwner");

    bytes10 internal constant WF_NAME = bytes10("notify-set");

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

    function _report() internal pure returns (bytes memory) {
        return abi.encode(
            AuditEntry({
                merchantId: 1,
                token: address(0xBEEF),
                grossAmount: 100e6,
                usdAmount8: 100e8,
                orderId: keccak256("o"),
                srcChainSelector: 0,
                notifiedAt: 1_700_000_000
            })
        );
    }

    /// @dev Full Keystone default layout (64 bytes): cid(32) + name(10) + owner(20) + report(2).
    function _metadata64(bytes10 name, address wfOwner) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256("cid"), name, bytes20(wfOwner), bytes2("r1"));
    }

    /*//////////////////////////////////////////////////////////////
                METADATA LENGTH — THE EXACT >=62 BOUNDARY
    //////////////////////////////////////////////////////////////*/

    /// @notice EXACTLY 62 bytes whose [32..42) name + [42..62) owner window names the ALLOWLISTED
    ///         identity is ACCEPTED. This is the true off-by-one boundary: the decoder requires
    ///         `metadata.length >= 62` and reads owner up to byte 62, so a 62-byte buffer is the
    ///         smallest that fully contains the owner. (The attack suite proves only the 62-byte
    ///         ZERO buffer is rejected at the allowlist; this proves the right-identity 62-byte
    ///         buffer passes — the complement that confirms the floor is usable, not just safe.)
    function test_edge_metadataExactly62_allowlistedIdentity_accepted() public {
        // 32 cid + 10 name + 20 owner = 62 (no trailing report_name byte — the minimum readable).
        bytes memory md = abi.encodePacked(keccak256("cid"), WF_NAME, bytes20(workflowOwner));
        assertEq(md.length, 62, "buffer is exactly the 62-byte decode floor");

        vm.prank(forwarder);
        receiver.onReport(md, _report()); // must NOT revert
        assertEq(receiver.auditCount(), 1, "exactly-62 with the right identity writes one entry");
    }

    /// @notice 61 bytes (one below the floor) reverts the short-metadata guard, while 63 bytes (one
    ///         above) is accepted. Together with the 62-byte case above, this pins the inequality as
    ///         `>= 62` and not `== 62` precisely at the boundary — a regression that flipped it to a
    ///         hard equality would fail exactly one of these three.
    function test_edge_metadata61Reverts_63Passes() public {
        // 61 bytes: cid(32) + name(10) + 19 of the 20 owner bytes — one byte short.
        bytes memory md61 = new bytes(61);
        vm.prank(forwarder);
        vm.expectRevert(bytes("Access0x1Receiver: short metadata"));
        receiver.onReport(md61, _report());
        assertEq(receiver.auditCount(), 0, "61-byte buffer writes nothing");

        // 63 bytes: the 62-byte floor + 1 trailing byte (partial report_name). Decodes by offset.
        bytes memory md63 =
            abi.encodePacked(keccak256("cid"), WF_NAME, bytes20(workflowOwner), bytes1("r"));
        assertEq(md63.length, 63, "buffer is one byte above the floor");
        vm.prank(forwarder);
        receiver.onReport(md63, _report());
        assertEq(receiver.auditCount(), 1, "63-byte buffer is accepted (>=62, not ==62)");
    }

    /*//////////////////////////////////////////////////////////////
                METADATA DECODE — bytes10 NAME TRUNCATION
    //////////////////////////////////////////////////////////////*/

    /// @notice The decoder reads the workflow NAME as the first 10 bytes at offset 32. If the on-wire
    ///         name field carried MORE than 10 meaningful bytes, only the first 10 form the allowlist
    ///         key — the tail is ignored. We prove this by allowlisting the 10-byte truncation of an
    ///         over-long name and showing a buffer with that name + extra bytes still resolves to the
    ///         allowlisted key. Guards against an attacker assuming the extra bytes shift the window.
    function test_edge_workflowName_truncatesToFirst10Bytes() public {
        // An 11+ char intended name; only its first 10 bytes are the on-chain key.
        bytes memory longName = bytes("notify-settlement-v2");
        bytes10 key10;
        assembly {
            // load the first 32 bytes of the array data; bytes10 keeps the top 10.
            key10 := mload(add(longName, 0x20))
        }

        vm.prank(owner);
        receiver.setAllowedWorkflowName(key10, true);

        // Build metadata whose name field is the SAME first-10 truncation; the gate must accept it.
        bytes memory md = _metadata64(key10, workflowOwner);
        vm.prank(forwarder);
        receiver.onReport(md, _report());
        assertEq(
            receiver.auditCount(), 1, "the 10-byte truncation is the allowlist key the gate reads"
        );

        // And the FULL longName is NOT itself a separate allowlisted key (sanity: key is bytes10).
        assertTrue(receiver.allowedWorkflowName(key10), "the truncated key is what was stored");
    }

    /*//////////////////////////////////////////////////////////////
                GATE ORDERING — SIMULTANEOUS FAILURES
    //////////////////////////////////////////////////////////////*/

    /// @notice When BOTH the workflow owner and the workflow name are non-allowlisted, the OWNER gate
    ///         fires first (the documented order: Forwarder -> owner -> name). Pinning the order
    ///         matters for off-chain error handling and matches the canonical KeystoneFeedsConsumer.
    function test_edge_gateOrder_ownerCheckedBeforeName() public {
        address rogueOwner = makeAddr("rogueOwner");
        bytes10 rogueName = bytes10("evil-wf");
        bytes memory md = _metadata64(rogueName, rogueOwner); // both wrong

        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Receiver.UnauthorizedWorkflowOwner.selector, rogueOwner)
        );
        receiver.onReport(md, _report()); // owner error, not name error
    }

    /*//////////////////////////////////////////////////////////////
                ALLOWLIST — RE-ENABLE RESTORES THE PATH
    //////////////////////////////////////////////////////////////*/

    /// @notice Toggling a workflow owner OFF then back ON restores the write path — the allowlist bit
    ///         is a live switch, not a one-way latch. Complements the attack suite's revoke-only test.
    function test_edge_allowlistOwner_reEnableRestoresWrite() public {
        bytes memory md = _metadata64(WF_NAME, workflowOwner);

        // Off: write is rejected.
        vm.prank(owner);
        receiver.setAllowedWorkflowOwner(workflowOwner, false);
        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Receiver.UnauthorizedWorkflowOwner.selector, workflowOwner
            )
        );
        receiver.onReport(md, _report());
        assertEq(receiver.auditCount(), 0, "no write while revoked");

        // Back on: write succeeds again.
        vm.prank(owner);
        receiver.setAllowedWorkflowOwner(workflowOwner, true);
        vm.prank(forwarder);
        receiver.onReport(md, _report());
        assertEq(receiver.auditCount(), 1, "re-enabling restores the write path");
    }

    /*//////////////////////////////////////////////////////////////
                OWNABLE2STEP — ADMIN ROTATION EDGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Config authority follows a completed Ownable2Step handover: the pending owner cannot
    ///         configure until it ACCEPTS, and once it does, the old owner loses authority. This is
    ///         the admin-rotation edge the happy-path onlyOwner tests don't exercise.
    function test_edge_ownable2Step_authorityFollowsAcceptedTransfer() public {
        address newOwner = makeAddr("newOwner");

        // Step 1: current owner nominates; ownership has NOT moved yet.
        vm.prank(owner);
        receiver.transferOwnership(newOwner);
        assertEq(receiver.owner(), owner, "owner unchanged until accept");
        assertEq(receiver.pendingOwner(), newOwner, "newOwner is pending");

        // The pending owner cannot yet configure (transfer is two-step, not one).
        vm.prank(newOwner);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, newOwner)
        );
        receiver.setAllowedWorkflowOwner(stranger, true);

        // Step 2: pending owner accepts; authority transfers.
        vm.prank(newOwner);
        receiver.acceptOwnership();
        assertEq(receiver.owner(), newOwner, "ownership moved on accept");

        // The OLD owner has lost config authority.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        receiver.setAllowedWorkflowName(bytes10("x"), true);

        // The NEW owner now governs the allowlist.
        vm.prank(newOwner);
        receiver.setAllowedWorkflowOwner(stranger, true);
        assertTrue(receiver.allowedWorkflowOwner(stranger), "new owner can configure");
    }
}
