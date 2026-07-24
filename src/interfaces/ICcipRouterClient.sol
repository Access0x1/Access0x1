// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ICcipReceiver } from "./ICcipReceiver.sol";

/// @title ICcipRouterClient — the source-side CCIP Router surface a sender needs.
/// @author Access0x1
/// @notice Byte-identical to Chainlink's `IRouterClient` + the send-side `Client` structs
///         (chainlink-ccip: interfaces/IRouterClient.sol, libraries/Client.sol). Re-declared
///         locally for the same reason {ICcipReceiver} is — this repo does not vendor the CCIP
///         package. Signatures verified against the source 2026-07-24; selectors unchanged, so a
///         caller is wire-compatible with the real Router.
interface ICcipRouterClient {
    /// @notice A message from this chain to any destination family.
    /// @dev    `receiver` is `bytes` (abi-encoded address for an EVM destination). `feeToken`
    ///         `address(0)` means the fee is paid in native, sent as `msg.value` with {ccipSend}.
    struct EVM2AnyMessage {
        bytes receiver;
        bytes data;
        ICcipReceiver.EVMTokenAmount[] tokenAmounts;
        address feeToken;
        bytes extraArgs;
    }

    /// @notice Whether CCIP can currently reach `destChainSelector` from this chain.
    function isChainSupported(uint64 destChainSelector) external view returns (bool supported);

    /// @notice The fee, in `message.feeToken` (native when zero), to deliver `message`.
    function getFee(uint64 destinationChainSelector, EVM2AnyMessage memory message)
        external
        view
        returns (uint256 fee);

    /// @notice Submit a cross-chain message. Returns the message id.
    /// @dev    Payable for native-fee sends. Chainlink documents that OVERPAYMENT IS ACCEPTED
    ///         WITHOUT REFUND — the caller must quote with {getFee} and send exactly that.
    function ccipSend(uint64 destinationChainSelector, EVM2AnyMessage calldata message)
        external
        payable
        returns (bytes32);
}
