// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ICcipReceiver — the Chainlink CCIP destination-side receiver ABI.
/// @author Access0x1
/// @notice Byte-identical to Chainlink's `IAny2EVMMessageReceiver` and the `Client` structs it
///         carries (chainlink/contracts-ccip: applications/CCIPReceiver.sol, libraries/Client.sol).
///         Re-declared locally for the same reason {IReceiver} is: this repo does not vendor the
///         CCIP package, and pulling it in would add a second OpenZeppelin version to a build whose
///         whole point is one unambiguous remapping set. The selectors are unchanged, so a deployed
///         consumer is wire-compatible with the real CCIP Router.
/// @dev    CONFIRM the Router address and every chain selector from `docs.chain.link/ccip/directory`
///         for the chain you deploy on — this repo never hardcodes either (law #3).
interface ICcipReceiver {
    /// @notice A token amount delivered alongside a CCIP message.
    /// @dev    `token` is the address ON THE DESTINATION chain, not the source chain.
    struct EVMTokenAmount {
        address token;
        uint256 amount;
    }

    /// @notice A message as delivered to the destination chain.
    /// @dev    `sender` is `bytes` because CCIP spans non-EVM families; on an EVM source it is an
    ///         abi-encoded `address` and MUST be decoded as such before being trusted. `data` is
    ///         whatever the source contract encoded — it is attacker-controlled until the sender
    ///         itself is allowlisted, which is why the sender check comes first.
    struct Any2EVMMessage {
        bytes32 messageId;
        uint64 sourceChainSelector;
        bytes sender;
        bytes data;
        EVMTokenAmount[] destTokenAmounts;
    }

    /// @notice Called by the CCIP Router to deliver a cross-chain message.
    /// @dev    ONLY the Router may call this. A revert here does not lose the message: CCIP marks it
    ///         failed and it can be manually re-executed, but a receiver that reverts on ordinary
    ///         business outcomes turns every such outcome into an ops task — prefer recording a
    ///         recoverable credit over reverting.
    /// @param message The delivered message: id, source selector, sender, payload, and any tokens.
    function ccipReceive(Any2EVMMessage calldata message) external;
}
