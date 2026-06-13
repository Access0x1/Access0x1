// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IReceiver } from "./interfaces/IReceiver.sol";

/// @title Access0x1Receiver — Forwarder-trusting CRE audit consumer ("Notified Settlement")
/// @author Access0x1
/// @notice The on-chain half of the "Notified Settlement" feature. A Chainlink CRE workflow
///         (EVM-log trigger on the router's `PaymentReceived`) HTTP-notifies the merchant and
///         then writes an immutable audit entry HERE via `evmClient.writeReport` → the
///         KeystoneForwarder → this contract's `onReport`. The write is what clears the CRE
///         judging bar: an orchestration layer integrating a blockchain with an external API.
/// @dev    OFF THE MONEY PATH BY CONSTRUCTION. This contract never calls, imports, or is called
///         by `Access0x1Router`. The router only EMITS `PaymentReceived` (fire-and-forget); it
///         never awaits, blocks on, or rolls back for CRE. Settlement is byte-for-byte identical
///         whether this contract exists or not — so a revert here can never touch a payment.
///
///         Trust model (mirrors Chainlink's `KeystoneFeedsConsumer`): `onReport` accepts a write
///         ONLY from the configured KeystoneForwarder (`i_forwarder`) AND only when the report's
///         metadata names an allowlisted workflow owner + workflow name. The Forwarder is the DON's
///         on-chain delivery point; gating on it is the canonical Keystone receiver pattern.
contract Access0x1Receiver is IReceiver, Ownable2Step {
    /// @notice The trusted KeystoneForwarder — the only address allowed to call `onReport`.
    /// @dev    Immutable: set once at construction. On Arc Testnet (prod) this is
    ///         `0x76c9cf548b4179F8901cda1f8623568b58215E62`; in `cre workflow simulate --broadcast`
    ///         it is the sim MockForwarder. Either way `onReport` trusts exactly this address.
    address public immutable i_forwarder;

    /// @notice Monotonic count of audit entries written, also the id of the next entry.
    uint256 public auditCount;

    /// @notice Allowlisted CRE workflow owners (the address that registered the workflow on the DON).
    mapping(address workflowOwner => bool allowed) public allowedWorkflowOwner;

    /// @notice Allowlisted CRE workflow names (`bytes10`, the on-DON workflow identifier).
    mapping(bytes10 workflowName => bool allowed) public allowedWorkflowName;

    /// @notice The decoded payload the CRE workflow writes for each notified settlement.
    /// @dev    Mirrors the salient fields of the router's `PaymentReceived` event so an auditor can
    ///         tie an on-chain audit entry back to the exact settlement that triggered it. The CRE
    ///         workflow ABI-encodes one of these as the `report` body.
    struct AuditEntry {
        uint256 merchantId; // the merchant the payment settled to
        address token; // the pay-in token (address(0) = native)
        uint256 grossAmount; // gross paid, in `token` decimals
        uint256 usdAmount8; // USD value at settle time, 8-decimal (Chainlink-priced)
        bytes32 orderId; // the merchant's order reference
        uint64 srcChainSelector; // CCIP chain selector of the pay-in source
        uint64 notifiedAt; // CRE `runtime.now()` (seconds) when the merchant was HTTP-notified
    }

    /// @notice Emitted once per audit entry written by the CRE workflow via the Forwarder.
    /// @dev    `merchantId` and `orderId` are indexed so an indexer/merchant dashboard can filter
    ///         the audit trail by merchant or reconcile a single order.
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

    /// @notice A workflow owner was added to / removed from the allowlist.
    event WorkflowOwnerSet(address indexed workflowOwner, bool allowed);

    /// @notice A workflow name was added to / removed from the allowlist.
    event WorkflowNameSet(bytes10 indexed workflowName, bool allowed);

    /// @notice `onReport` was called by an address other than the trusted Forwarder.
    error UnauthorizedForwarder(address sender);

    /// @notice The report's metadata names a workflow owner that is not allowlisted.
    error UnauthorizedWorkflowOwner(address workflowOwner);

    /// @notice The report's metadata names a workflow name that is not allowlisted.
    error UnauthorizedWorkflowName(bytes10 workflowName);

    /// @notice The constructor was given the zero address for the Forwarder.
    error ZeroForwarder();

    /// @param forwarder The KeystoneForwarder address this consumer will trust for `onReport`.
    /// @param initialOwner The owner that may manage the workflow allowlist (Ownable2Step).
    constructor(address forwarder, address initialOwner) Ownable(initialOwner) {
        if (forwarder == address(0)) revert ZeroForwarder();
        i_forwarder = forwarder;
    }

    /// @notice Allow or disallow a CRE workflow owner from writing audit entries.
    /// @dev    Owner-gated config; mirrors `KeystoneFeedsConsumer.setConfig`'s owner allowlist but
    ///         kept granular (one setter per dimension) so it composes cleanly with tests + scripts.
    function setAllowedWorkflowOwner(address workflowOwner, bool allowed) external onlyOwner {
        allowedWorkflowOwner[workflowOwner] = allowed;
        emit WorkflowOwnerSet(workflowOwner, allowed);
    }

    /// @notice Allow or disallow a CRE workflow name from writing audit entries.
    function setAllowedWorkflowName(bytes10 workflowName, bool allowed) external onlyOwner {
        allowedWorkflowName[workflowName] = allowed;
        emit WorkflowNameSet(workflowName, allowed);
    }

    /// @inheritdoc IReceiver
    /// @notice Handle a CRE workflow report: validate the sender + workflow, then store/emit the
    ///         settlement audit entry. Called by the Forwarder after the DON reaches consensus.
    /// @dev    Reverting here is safe (Keystone retries with more gas) and CANNOT affect settlement:
    ///         the router never calls this contract. Gating order — Forwarder, then workflow owner,
    ///         then workflow name — matches the canonical `KeystoneFeedsConsumer`.
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != i_forwarder) revert UnauthorizedForwarder(msg.sender);

        (bytes10 workflowName, address workflowOwner) = _decodeMetadata(metadata);
        if (!allowedWorkflowOwner[workflowOwner]) revert UnauthorizedWorkflowOwner(workflowOwner);
        if (!allowedWorkflowName[workflowName]) revert UnauthorizedWorkflowName(workflowName);

        AuditEntry memory entry = abi.decode(report, (AuditEntry));

        uint256 auditId = auditCount;
        unchecked {
            auditCount = auditId + 1;
        }

        emit SettlementAudited(
            auditId,
            entry.merchantId,
            entry.orderId,
            entry.token,
            entry.grossAmount,
            entry.usdAmount8,
            entry.srcChainSelector,
            entry.notifiedAt
        );
    }

    /// @inheritdoc IERC165
    /// @dev The Forwarder probes `supportsInterface(type(IReceiver).interfaceId)` before delivery.
    function supportsInterface(bytes4 interfaceId) public pure override returns (bool) {
        return
            interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// @notice Slice the KeystoneForwarder report metadata into its workflow name + owner.
    /// @dev    Layout fixed by Keystone (`KeystoneFeedDefaultMetadataLib`):
    ///           [0..32)  length prefix    [32..64) workflow_cid
    ///           [64..74) workflow_name    [74..94) workflow_owner    [94..96) report_name
    ///         IMPORTANT: we do NOT assert `metadata.length == 62`. The historic 62-byte assertion
    ///         (seen in some early templates) is WRONG for production: the Forwarder delivers a
    ///         length-prefixed buffer of 64+ bytes (32 prefix + 32 cid + 10 name + 20 owner + 2
    ///         report = 96 in the default layout). A hard length check rejects real DON reports.
    ///         We only require enough bytes to read name+owner, then slice by fixed offset.
    function _decodeMetadata(bytes calldata metadata)
        internal
        pure
        returns (bytes10 workflowName, address workflowOwner)
    {
        // Need bytes [32..94): cid(32) + name(10) + owner(20) past the implicit length prefix.
        // calldata `bytes` has no in-memory length prefix, so offsets are 0-based here: name at
        // [32..42), owner at [42..62). Require at least 62 readable bytes (NOT exactly 62).
        require(metadata.length >= 62, "Access0x1Receiver: short metadata");
        assembly {
            // workflow_name: 10 bytes at calldata offset 32 (after the 32-byte workflow_cid).
            workflowName := calldataload(add(metadata.offset, 32))
            // workflow_owner: 20 bytes at calldata offset 42; right-shift 12 bytes to right-align.
            workflowOwner := shr(96, calldataload(add(metadata.offset, 42)))
        }
    }
}
