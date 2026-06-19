// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Access0x1Receiver } from "../../src/Access0x1Receiver.sol";
import { IReceiver } from "../../src/interfaces/IReceiver.sol";

/// @title  Access0x1ReceiverFuzz — STATELESS fuzz suite for the CRE "Notified Settlement" consumer.
/// @author Access0x1
/// @notice Cyfrin stateless-fuzz layer: every public/external entrypoint of {Access0x1Receiver} is
///         fuzzed with `bound()`-constrained inputs and the contract's per-call invariants are
///         asserted on EACH run. The contract is OFF the money path by construction (it never moves
///         funds and the router never calls it), so the properties under fuzz are the integrity of
///         the AUDIT TRAIL, not a money conservation law:
///
///           - GATE EXCLUSIVITY  : `onReport` reverts for every sender != i_forwarder, and reverts
///                                 for every workflow owner/name not on BOTH allowlists.
///           - APPEND-ONLY METER : an ACCEPTED `onReport` increments `auditCount` by EXACTLY 1; the
///                                 emitted `auditId` equals the pre-call count; a REJECTED `onReport`
///                                 leaves `auditCount` unchanged (the meter is monotonic, never
///                                 decremented, never skips). This is the receiver's analogue of the
///                                 money suite's "net + fee == gross / no negative balance".
///           - DECODE WINDOW     : the gate reads workflow name+owner from a FIXED metadata window
///                                 ([32..42) name, [42..62) owner); arbitrary cid prefix + arbitrary
///                                 trailing bytes never change the trust decision.
///           - SETTER FIDELITY   : the owner-only allowlist setters store exactly the bool written,
///                                 for any address / bytes10, and revert for any non-owner.
///           - ERC-165           : `supportsInterface` is true for exactly IReceiver + IERC165 and
///                                 false for every other fuzzed selector.
///
/// @dev    Mirrors the repo style: a local `AuditEntry` struct re-declaration for ABI-encoding test
///         reports, a Keystone default-layout `_metadata` builder, and re-declared events for
///         `expectEmit`. Distinct file name so it never collides with the existing unit/attack suites.
contract Access0x1ReceiverFuzzTest is Test {
    Access0x1Receiver internal receiver;

    address internal forwarder = makeAddr("forwarder"); // the trusted KeystoneForwarder
    address internal owner = makeAddr("owner");
    address internal workflowOwner = makeAddr("workflowOwner");

    bytes10 internal constant WF_NAME = bytes10("notify-set");

    // Mirror of Access0x1Receiver.AuditEntry for ABI-encoding fuzzed reports.
    struct AuditEntry {
        uint256 merchantId;
        address token;
        uint256 grossAmount;
        uint256 usdAmount8;
        bytes32 orderId;
        uint64 srcChainSelector;
        uint64 notifiedAt;
    }

    // Re-declared so the fuzz tests can `expectEmit` on them (events are not inherited into scope).
    event SettlementAudited(
        uint256 indexed auditId,
        uint256 indexed merchantId,
        bytes32 indexed orderId,
        address token,
        uint256 grossAmount,
        uint256 usdAmount8,
        uint64 srcChainSelector,
        uint64 notifiedAt
    );

    event WorkflowOwnerSet(address indexed workflowOwner, bool allowed);
    event WorkflowNameSet(bytes10 indexed workflowName, bool allowed);

    function setUp() public {
        receiver = new Access0x1Receiver(forwarder, owner);
        vm.startPrank(owner);
        receiver.setAllowedWorkflowOwner(workflowOwner, true);
        receiver.setAllowedWorkflowName(WF_NAME, true);
        vm.stopPrank();
    }

    /// @dev Keystone default-layout metadata: 32 cid + 10 name + 20 owner + 2 report = 64 bytes.
    function _metadata(bytes10 name, address wfOwner) internal pure returns (bytes memory) {
        bytes32 cid = keccak256("workflow-cid");
        bytes2 reportName = bytes2("r1");
        return abi.encodePacked(cid, name, bytes20(wfOwner), reportName);
    }

    function _report(AuditEntry memory e) internal pure returns (bytes memory) {
        return abi.encode(e);
    }

    /*//////////////////////////////////////////////////////////////
                    CONSTRUCTOR — FORWARDER FIDELITY
    //////////////////////////////////////////////////////////////*/

    /// @notice For ANY non-zero forwarder + ANY initial owner, the constructor pins both exactly and
    ///         starts the audit meter at zero. Proves the trust anchor is whatever was passed in (no
    ///         hidden default), the kernel guarantee every later gate check depends on.
    function testFuzz_constructor_pinsForwarderAndOwner(address fwd, address initialOwner) public {
        vm.assume(fwd != address(0)); // the zero case is a dedicated revert, asserted below
        vm.assume(initialOwner != address(0)); // Ownable rejects the zero owner

        Access0x1Receiver r = new Access0x1Receiver(fwd, initialOwner);
        assertEq(r.i_forwarder(), fwd, "forwarder pinned to the constructor arg");
        assertEq(r.owner(), initialOwner, "owner pinned to the constructor arg");
        assertEq(r.auditCount(), 0, "audit meter starts at zero");
    }

    /// @notice A zero forwarder ALWAYS reverts ZeroForwarder, regardless of the initial owner — the
    ///         trust anchor can never be the null address (which would make `msg.sender == 0` the
    ///         only authorized caller, an unreachable/footgun config).
    function testFuzz_constructor_revertsOnZeroForwarder(address initialOwner) public {
        vm.assume(initialOwner != address(0));
        vm.expectRevert(Access0x1Receiver.ZeroForwarder.selector);
        new Access0x1Receiver(address(0), initialOwner);
    }

    /*//////////////////////////////////////////////////////////////
                    onReport — APPEND-ONLY METER (ACCEPT)
    //////////////////////////////////////////////////////////////*/

    /// @notice For ANY entry payload delivered through the trusted Forwarder with an allowlisted
    ///         owner+name, `onReport` increments `auditCount` by EXACTLY 1 and emits the next
    ///         monotonic auditId (== the pre-call count). This is the receiver's append-only
    ///         invariant: every accepted write advances the meter by one, never more, never less.
    function testFuzz_onReport_accept_incrementsMeterByExactlyOne(
        uint256 merchantId,
        address token,
        uint256 grossAmount,
        uint256 usdAmount8,
        bytes32 orderId,
        uint64 srcChainSelector,
        uint64 notifiedAt
    ) public {
        AuditEntry memory e = AuditEntry({
            merchantId: merchantId,
            token: token,
            grossAmount: grossAmount,
            usdAmount8: usdAmount8,
            orderId: orderId,
            srcChainSelector: srcChainSelector,
            notifiedAt: notifiedAt
        });

        uint256 before = receiver.auditCount();

        // The emitted auditId must equal the pre-call count (the "id of the next entry" contract).
        vm.expectEmit(true, true, true, true, address(receiver));
        emit SettlementAudited(
            before,
            merchantId,
            orderId,
            token,
            grossAmount,
            usdAmount8,
            srcChainSelector,
            notifiedAt
        );

        vm.prank(forwarder);
        receiver.onReport(_metadata(WF_NAME, workflowOwner), _report(e));

        assertEq(receiver.auditCount(), before + 1, "accepted write advances meter by exactly one");
    }

    /// @notice Across an arbitrary (bounded) number of accepted deliveries, `auditCount` equals the
    ///         number of deliveries exactly — the meter is a faithful, gap-free counter of writes.
    ///         A single fuzz body that loops is the stateless analogue of pinning the monotonic id
    ///         across calls without standing up a full stateful handler.
    function testFuzz_onReport_accept_meterEqualsDeliveryCount(uint8 deliveries) public {
        uint256 n = bound(deliveries, 1, 32); // keep the run cheap; 32 deliveries proves monotonicity
        bytes memory md = _metadata(WF_NAME, workflowOwner);
        bytes memory rep = _report(
            AuditEntry({
                merchantId: 1,
                token: address(0xBEEF),
                grossAmount: 100e6,
                usdAmount8: 100e8,
                orderId: keccak256("o"),
                srcChainSelector: 0,
                notifiedAt: uint64(block.timestamp)
            })
        );

        for (uint256 i = 0; i < n; ++i) {
            assertEq(receiver.auditCount(), i, "auditId of the i-th write is i (next-id == count)");
            vm.prank(forwarder);
            receiver.onReport(md, rep);
        }
        assertEq(receiver.auditCount(), n, "meter == number of accepted deliveries, no gaps");
    }

    /*//////////////////////////////////////////////////////////////
                    onReport — GATE EXCLUSIVITY (REJECT)
    //////////////////////////////////////////////////////////////*/

    /// @notice For ANY sender that is not the trusted Forwarder, `onReport` reverts at the gate and
    ///         the meter is untouched — the Forwarder is the SOLE authorized caller. The gate is an
    ///         address equality, so even a fuzzed contract/EOA cannot spoof it.
    function testFuzz_onReport_reject_wrongForwarder(address sender) public {
        vm.assume(sender != forwarder);

        uint256 before = receiver.auditCount();
        vm.prank(sender);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Receiver.UnauthorizedForwarder.selector, sender)
        );
        receiver.onReport(_metadata(WF_NAME, workflowOwner), _report(_anyEntry()));
        assertEq(receiver.auditCount(), before, "rejected write leaves the meter unchanged");
    }

    /// @notice For ANY workflow owner not on the allowlist (delivered by the real Forwarder with an
    ///         allowlisted name), `onReport` reverts UnauthorizedWorkflowOwner and the meter holds.
    ///         The owner dimension of the two-key allowlist is independently enforced.
    function testFuzz_onReport_reject_rogueWorkflowOwner(address rogueOwner) public {
        vm.assume(rogueOwner != workflowOwner); // the allowlisted owner would pass

        uint256 before = receiver.auditCount();
        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Receiver.UnauthorizedWorkflowOwner.selector, rogueOwner)
        );
        receiver.onReport(_metadata(WF_NAME, rogueOwner), _report(_anyEntry()));
        assertEq(receiver.auditCount(), before, "rejected write leaves the meter unchanged");
    }

    /// @notice For ANY workflow name not on the allowlist (delivered by the Forwarder with an
    ///         allowlisted owner), `onReport` reverts UnauthorizedWorkflowName and the meter holds.
    ///         The name dimension is independently enforced — BOTH keys must match to write.
    function testFuzz_onReport_reject_rogueWorkflowName(bytes10 rogueName) public {
        vm.assume(rogueName != WF_NAME); // the allowlisted name would pass

        uint256 before = receiver.auditCount();
        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Receiver.UnauthorizedWorkflowName.selector, rogueName)
        );
        receiver.onReport(_metadata(rogueName, workflowOwner), _report(_anyEntry()));
        assertEq(receiver.auditCount(), before, "rejected write leaves the meter unchanged");
    }

    /*//////////////////////////////////////////////////////////////
                    onReport — METADATA DECODE WINDOW
    //////////////////////////////////////////////////////////////*/

    /// @notice For ANY cid prefix and ANY length of trailing bytes (>=0), a metadata buffer whose
    ///         fixed [32..42)/[42..62) window names the allowlisted name+owner is ACCEPTED — proving
    ///         the gate trusts ONLY that window. cid and tail are outside the trust decision, so a
    ///         padded/garbage-prefixed buffer cannot smuggle a different workflow nor be rejected on
    ///         length (the contract uses >=62, never a hard ==62). This is the "do NOT require 62"
    ///         guarantee, fuzzed across buffer shapes.
    function testFuzz_onReport_decodeWindow_ignoresCidAndTail(bytes32 cid, uint8 tailLen) public {
        uint256 tn = bound(tailLen, 0, 200); // 0..200 trailing junk bytes
        bytes memory tail = new bytes(tn);
        bytes memory md = abi.encodePacked(cid, WF_NAME, bytes20(workflowOwner), bytes2("r1"), tail);
        assertGe(md.length, 62, "buffer is at least the 62-byte decode floor");

        uint256 before = receiver.auditCount();
        vm.prank(forwarder);
        receiver.onReport(md, _report(_anyEntry())); // must NOT revert for any cid/tail
        assertEq(
            receiver.auditCount(), before + 1, "accepted regardless of cid prefix / trailing bytes"
        );
    }

    /// @notice For ANY metadata strictly shorter than the 62-byte decode floor, `onReport` reverts
    ///         cleanly with the "short metadata" guard and never reads out of bounds — a length-only
    ///         attack cannot coax a garbage workflow identity past the allowlist.
    function testFuzz_onReport_shortMetadata_reverts(uint8 len) public {
        uint256 n = bound(len, 0, 61); // [0, 62) — strictly below the floor
        bytes memory shortMd = new bytes(n);

        uint256 before = receiver.auditCount();
        vm.prank(forwarder);
        vm.expectRevert(Access0x1Receiver.ShortMetadata.selector);
        receiver.onReport(shortMd, _report(_anyEntry()));
        assertEq(receiver.auditCount(), before, "short metadata never writes an entry");
    }

    /*//////////////////////////////////////////////////////////////
                    SETTERS — FIDELITY + OWNER GATE
    //////////////////////////////////////////////////////////////*/

    /// @notice For ANY address + ANY bool, the owner-only owner-allowlist setter stores exactly the
    ///         bool written and emits the matching event — no clamping, no coupling to other keys.
    function testFuzz_setAllowedWorkflowOwner_storesExactBool(address wfOwner, bool allowed)
        public
    {
        vm.expectEmit(true, false, false, true, address(receiver));
        emit WorkflowOwnerSet(wfOwner, allowed);
        vm.prank(owner);
        receiver.setAllowedWorkflowOwner(wfOwner, allowed);
        assertEq(receiver.allowedWorkflowOwner(wfOwner), allowed, "stored bool == written bool");
    }

    /// @notice For ANY bytes10 + ANY bool, the owner-only name-allowlist setter stores exactly the
    ///         bool written and emits the matching event.
    function testFuzz_setAllowedWorkflowName_storesExactBool(bytes10 name, bool allowed) public {
        vm.expectEmit(true, false, false, true, address(receiver));
        emit WorkflowNameSet(name, allowed);
        vm.prank(owner);
        receiver.setAllowedWorkflowName(name, allowed);
        assertEq(receiver.allowedWorkflowName(name), allowed, "stored bool == written bool");
    }

    /// @notice For ANY non-owner caller, BOTH allowlist setters revert with Ownable's unauthorized
    ///         error and write nothing — config authority is the owner's alone.
    function testFuzz_setters_revertForNonOwner(address caller, address wfOwner, bytes10 name)
        public
    {
        vm.assume(caller != owner);

        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        receiver.setAllowedWorkflowOwner(wfOwner, true);

        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        receiver.setAllowedWorkflowName(name, true);
    }

    /*//////////////////////////////////////////////////////////////
                              ERC-165
    //////////////////////////////////////////////////////////////*/

    /// @notice For ANY selector other than IReceiver/IERC165, `supportsInterface` is false; for the
    ///         two advertised ids it is true. The Forwarder probes this before delivery, so the set
    ///         of advertised interfaces must be exactly these two and nothing else.
    function testFuzz_supportsInterface_onlyReceiverAndErc165(bytes4 selector) public view {
        bytes4 receiverId = type(IReceiver).interfaceId;
        bytes4 erc165Id = 0x01ffc9a7; // type(IERC165).interfaceId
        if (selector == receiverId || selector == erc165Id) {
            assertTrue(receiver.supportsInterface(selector), "advertised interface must be true");
        } else {
            assertFalse(receiver.supportsInterface(selector), "any other selector must be false");
        }
    }

    /*//////////////////////////////////////////////////////////////
                              HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev A fixed, valid entry for the reject/decode fuzzers where the payload is irrelevant.
    function _anyEntry() internal pure returns (AuditEntry memory) {
        return AuditEntry({
            merchantId: 7,
            token: address(0xBEEF),
            grossAmount: 500e6,
            usdAmount8: 500e8,
            orderId: keccak256("fuzz-order"),
            srcChainSelector: 0,
            notifiedAt: 1_700_000_000
        });
    }
}
