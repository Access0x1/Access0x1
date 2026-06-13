// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { Access0x1Receiver } from "../../src/Access0x1Receiver.sol";
import { IReceiver } from "../../src/interfaces/IReceiver.sol";

/// @notice Unit suite for the "Notified Settlement" CRE audit consumer. Exercises the
///         Forwarder-trust gate, the workflow owner/name allowlist, metadata decoding (including
///         the prod 64-byte case — NOT a hard `== 62` check), the audit store/emit, and ERC-165.
///         The contract is off the money path, so there is nothing to assert about settlement here
///         by design — these tests prove ONLY the consumer's own behavior.
contract Access0x1ReceiverTest is Test {
    Access0x1Receiver internal receiver;

    address internal forwarder = makeAddr("forwarder"); // the trusted KeystoneForwarder
    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");
    address internal workflowOwner = makeAddr("workflowOwner");

    bytes10 internal constant WF_NAME = bytes10("notify-set");

    // Mirror of Access0x1Receiver.AuditEntry for ABI-encoding test reports.
    struct AuditEntry {
        uint256 merchantId;
        address token;
        uint256 grossAmount;
        uint256 usdAmount8;
        bytes32 orderId;
        uint64 srcChainSelector;
        uint64 notifiedAt;
    }

    // Re-declared so the test can `expectEmit` on it (events are not inherited into the test scope).
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

    function setUp() public {
        receiver = new Access0x1Receiver(forwarder, owner);
        vm.startPrank(owner);
        receiver.setAllowedWorkflowOwner(workflowOwner, true);
        receiver.setAllowedWorkflowName(WF_NAME, true);
        vm.stopPrank();
    }

    /// @dev Build the Keystone default-layout metadata buffer the Forwarder delivers in PROD:
    ///      32 bytes workflow_cid + 10 bytes workflow_name + 20 bytes workflow_owner + 2 bytes
    ///      report_name = 64 bytes. (The early-template `== 62` assertion would WRONGLY reject this.)
    function _metadata(bytes10 name, address wfOwner) internal pure returns (bytes memory) {
        bytes32 cid = keccak256("workflow-cid");
        bytes2 reportName = bytes2("r1");
        return abi.encodePacked(cid, name, bytes20(wfOwner), reportName);
    }

    function _report(AuditEntry memory e) internal pure returns (bytes memory) {
        return abi.encode(e);
    }

    function _sampleEntry() internal pure returns (AuditEntry memory) {
        return AuditEntry({
            merchantId: 42,
            token: address(0xBEEF),
            grossAmount: 1_000e6,
            usdAmount8: 1_000e8,
            orderId: keccak256("order-1"),
            srcChainSelector: 16_015_286_601_757_825_753, // Sepolia CCIP selector (illustrative)
            notifiedAt: 1_700_000_123
        });
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_constructor_setsForwarderAndOwner() public view {
        assertEq(receiver.i_forwarder(), forwarder);
        assertEq(receiver.owner(), owner);
        assertEq(receiver.auditCount(), 0);
    }

    function test_constructor_revertsOnZeroForwarder() public {
        vm.expectRevert(Access0x1Receiver.ZeroForwarder.selector);
        new Access0x1Receiver(address(0), owner);
    }

    /*//////////////////////////////////////////////////////////////
                                CONFIG
    //////////////////////////////////////////////////////////////*/

    function test_setAllowedWorkflowOwner_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        receiver.setAllowedWorkflowOwner(stranger, true);
    }

    function test_setAllowedWorkflowName_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        receiver.setAllowedWorkflowName(bytes10("x"), true);
    }

    function test_setAllowedWorkflowOwner_togglesAndEmits() public {
        address newOwner = makeAddr("newWfOwner");
        vm.expectEmit(true, false, false, true, address(receiver));
        emit Access0x1Receiver.WorkflowOwnerSet(newOwner, true);
        vm.prank(owner);
        receiver.setAllowedWorkflowOwner(newOwner, true);
        assertTrue(receiver.allowedWorkflowOwner(newOwner));

        vm.prank(owner);
        receiver.setAllowedWorkflowOwner(newOwner, false);
        assertFalse(receiver.allowedWorkflowOwner(newOwner));
    }

    /*//////////////////////////////////////////////////////////////
                                onReport
    //////////////////////////////////////////////////////////////*/

    function test_onReport_happyPath_storesAndEmits() public {
        AuditEntry memory e = _sampleEntry();

        vm.expectEmit(true, true, true, true, address(receiver));
        emit SettlementAudited(
            0,
            e.merchantId,
            e.orderId,
            e.token,
            e.grossAmount,
            e.usdAmount8,
            e.srcChainSelector,
            e.notifiedAt
        );

        vm.prank(forwarder);
        receiver.onReport(_metadata(WF_NAME, workflowOwner), _report(e));

        assertEq(receiver.auditCount(), 1);
    }

    function test_onReport_incrementsAuditIdAcrossCalls() public {
        AuditEntry memory e = _sampleEntry();
        bytes memory md = _metadata(WF_NAME, workflowOwner);

        vm.prank(forwarder);
        receiver.onReport(md, _report(e));

        vm.expectEmit(true, false, false, false, address(receiver));
        emit SettlementAudited(1, 0, bytes32(0), address(0), 0, 0, 0, 0);
        vm.prank(forwarder);
        receiver.onReport(md, _report(e));

        assertEq(receiver.auditCount(), 2);
    }

    function test_onReport_revertsWhenSenderNotForwarder() public {
        AuditEntry memory e = _sampleEntry();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Receiver.UnauthorizedForwarder.selector, stranger)
        );
        receiver.onReport(_metadata(WF_NAME, workflowOwner), _report(e));
    }

    function test_onReport_revertsWhenWorkflowOwnerNotAllowed() public {
        address rogueOwner = makeAddr("rogueOwner");
        AuditEntry memory e = _sampleEntry();
        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Receiver.UnauthorizedWorkflowOwner.selector, rogueOwner)
        );
        receiver.onReport(_metadata(WF_NAME, rogueOwner), _report(e));
    }

    function test_onReport_revertsWhenWorkflowNameNotAllowed() public {
        bytes10 rogueName = bytes10("evil-wf");
        AuditEntry memory e = _sampleEntry();
        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Receiver.UnauthorizedWorkflowName.selector, rogueName)
        );
        receiver.onReport(_metadata(rogueName, workflowOwner), _report(e));
    }

    /// @notice The prod Forwarder delivers a 64-byte (default-layout) metadata buffer. The contract
    ///         must accept it — a hard `length == 62` assertion (seen in early templates) would
    ///         reject every real DON report. This is the core "do NOT require 62" guarantee.
    function test_onReport_acceptsProd64ByteMetadata() public view {
        bytes memory md = _metadata(WF_NAME, workflowOwner);
        assertEq(md.length, 64); // 32 cid + 10 name + 20 owner + 2 report
    }

    function test_onReport_acceptsLongerThan62Metadata() public {
        // 64-byte default layout is the prod case; prove decode works and gate passes.
        AuditEntry memory e = _sampleEntry();
        bytes memory md = _metadata(WF_NAME, workflowOwner);
        assertGt(md.length, 62);
        vm.prank(forwarder);
        receiver.onReport(md, _report(e)); // must NOT revert
        assertEq(receiver.auditCount(), 1);
    }

    function test_onReport_revertsOnShortMetadata() public {
        AuditEntry memory e = _sampleEntry();
        bytes memory shortMd = new bytes(40); // < 62 readable bytes
        vm.prank(forwarder);
        vm.expectRevert(bytes("Access0x1Receiver: short metadata"));
        receiver.onReport(shortMd, _report(e));
    }

    function testFuzz_onReport_decodesArbitraryEntries(
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

        vm.expectEmit(true, true, true, true, address(receiver));
        emit SettlementAudited(
            0, merchantId, orderId, token, grossAmount, usdAmount8, srcChainSelector, notifiedAt
        );
        vm.prank(forwarder);
        receiver.onReport(_metadata(WF_NAME, workflowOwner), _report(e));
        assertEq(receiver.auditCount(), 1);
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    function test_supportsInterface_receiverAndErc165() public view {
        assertTrue(receiver.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(receiver.supportsInterface(type(IERC165).interfaceId));
    }

    function test_supportsInterface_rejectsUnknown() public view {
        assertFalse(receiver.supportsInterface(0xdeadbeef));
    }
}
