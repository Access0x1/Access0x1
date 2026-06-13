// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IReceiver } from "../../src/interfaces/IReceiver.sol";

/// @notice Test-only stand-in for the Chainlink KeystoneForwarder — the DON's on-chain delivery
///         point. The real Forwarder, after the DON reaches consensus on a CRE workflow report,
///         calls the consumer's `onReport(metadata, report)`. `Access0x1Receiver` trusts EXACTLY
///         one address (`i_forwarder`) for that call, so the e2e wires the receiver to trust an
///         instance of THIS contract and drives the audit write through `deliver` — proving the
///         report reaches `onReport` along the same path prod uses (caller == the forwarder),
///         not via a raw `vm.prank`.
/// @dev    `cre workflow simulate --broadcast` uses a sim MockForwarder with this same shape; this
///         is its Foundry analogue. It holds no state and makes one external call.
contract MockForwarder {
    /// @notice Forward a CRE workflow `report` (with its Keystone `metadata`) to a consumer's
    ///         `onReport`, exactly as the KeystoneForwarder does on-chain after DON consensus.
    /// @param consumer The IReceiver consumer (here, Access0x1Receiver).
    /// @param metadata The Keystone default-layout metadata buffer (cid + name + owner + report).
    /// @param report   The ABI-encoded workflow report body (an Access0x1Receiver.AuditEntry).
    function deliver(address consumer, bytes calldata metadata, bytes calldata report) external {
        IReceiver(consumer).onReport(metadata, report);
    }
}
