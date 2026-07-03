// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IERC6551Executable
/// @author Access0x1
/// @notice The ERC-6551 execution interface: a single `execute` entry point through which a valid
///         signer makes the token bound account act — call a contract, move its assets, spend its
///         Ether.
/// @dev    Members are VERBATIM from the EIP-6551 execution interface
///         (https://eips.ethereum.org/EIPS/eip-6551). The ERC-165 identifier for this interface is
///         `0x51945447`. The EIP requires accounts implementing this interface to accept operation
///         values 0 = CALL, 1 = DELEGATECALL, 2 = CREATE, 3 = CREATE2 — but also allows an account
///         to RESTRICT a signer's ability to execute certain operations, which is exactly what the
///         EIP's own minimal reference account does (CALL only, everything else reverts).
interface IERC6551Executable {
    /// @notice Executes a low-level operation if the caller is a valid signer on the account.
    /// @dev    Reverts and bubbles up the error verbatim if the operation fails. Operation values:
    ///         0 = CALL, 1 = DELEGATECALL, 2 = CREATE, 3 = CREATE2; accounts MAY support additional
    ///         operations or restrict which of these a signer may execute.
    /// @param to        The target address of the operation.
    /// @param value     The Ether value to be sent to the target.
    /// @param data      The encoded operation calldata.
    /// @param operation A value indicating the type of operation to perform.
    /// @return The result of the operation.
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory);
}
