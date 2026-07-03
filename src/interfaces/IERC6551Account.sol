// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IERC6551Account
/// @author Access0x1
/// @notice The ERC-6551 token bound account interface: every implementing account is owned by ONE
///         non-fungible token and reports which one (`token`), exposes a `state` value for
///         staleness detection, and answers "may this address act for me?" (`isValidSigner`) with
///         a magic value instead of a boolean.
/// @dev    Members are VERBATIM from the EIP-6551 account interface
///         (https://eips.ethereum.org/EIPS/eip-6551). The ERC-165 identifier for this interface is
///         `0x6faff5f1`. The magic value {isValidSigner} returns for a valid signer is
///         `0x523e3260` — this interface's own `isValidSigner.selector`, NOT the ERC-1271 magic
///         value (implementations must ALSO implement ERC-1271 `isValidSignature` per the EIP; the
///         two functions and their magic values are distinct).
interface IERC6551Account {
    /// @notice Allows the account to receive Ether. Accounts MUST implement a `receive` function
    ///         and MAY perform arbitrary logic to restrict the conditions under which Ether can be
    ///         received.
    receive() external payable;

    /// @notice Returns the identifier of the non-fungible token which owns the account.
    /// @dev    The return value MUST be constant — it MUST NOT change over time.
    /// @return chainId       The EIP-155 id of the chain the token exists on.
    /// @return tokenContract The contract address of the token.
    /// @return tokenId       The id of the token.
    function token() external view returns (uint256 chainId, address tokenContract, uint256 tokenId);

    /// @notice Returns a value that SHOULD be modified each time the account changes state, so
    ///         off-chain actors (marketplaces, order books) can detect that a signed commitment
    ///         about the account's contents may be stale.
    /// @return The current account state.
    function state() external view returns (uint256);

    /// @notice Returns a magic value indicating whether a given signer is authorized to act on
    ///         behalf of the account.
    /// @dev    MUST return the bytes4 magic value `0x523e3260` if the signer is valid. By default,
    ///         the holder of the bound non-fungible token MUST be considered a valid signer;
    ///         accounts MAY add authorization logic that invalidates the holder or grants signing
    ///         permission to non-holders.
    /// @param  signer     The address to check signing authorization for.
    /// @param  context    Additional data used to determine whether the signer is valid.
    /// @return magicValue Magic value indicating whether the signer is valid.
    function isValidSigner(address signer, bytes calldata context)
        external
        view
        returns (bytes4 magicValue);
}
