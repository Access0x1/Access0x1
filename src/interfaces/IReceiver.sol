// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IReceiver — receives Chainlink Keystone / CRE reports.
/// @author Access0x1
/// @notice Byte-identical signature to Chainlink's canonical keystone IReceiver
///         (contracts/src/v0.8/keystone/interfaces/IReceiver.sol). We re-declare it
///         locally rather than import the Chainlink file because that file pins a versioned
///         OpenZeppelin import path (a version-tagged "contracts" form) which this repo's single,
///         unversioned OZ remapping does not resolve. The selectors are unchanged, so a deployed
///         consumer is wire-compatible with the real KeystoneForwarder.
/// @dev    Implementations must advertise `IReceiver` via ERC-165 (`supportsInterface`); the
///         Forwarder probes this before delivering a report.
interface IReceiver is IERC165 {
    /// @notice Handles an incoming keystone/CRE report.
    /// @dev    If this reverts, the Forwarder may retry with a higher gas limit. The receiver owns
    ///         stale-report discarding.
    /// @param metadata The report's metadata (workflow cid / name / owner / report name).
    /// @param report   The workflow report body.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
