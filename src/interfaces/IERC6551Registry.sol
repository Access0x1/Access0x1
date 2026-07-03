// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IERC6551Registry
/// @author Access0x1
/// @notice The ERC-6551 registry interface — the singleton factory that deploys (and computes) the
///         token bound account for any (implementation, salt, chainId, tokenContract, tokenId)
///         tuple. Every NFT gets a deterministic smart-contract account per implementation, with no
///         registration step: the address exists counterfactually before anyone deploys it.
/// @dev    Members are VERBATIM from the EIP-6551 registry interface
///         (https://eips.ethereum.org/EIPS/eip-6551). The canonical singleton lives at
///         `0x000000006551c19487814612e58FE06813775758` on every chain (deployed via Nick's
///         Factory per the EIP) — integrations talk to that address; this interface exists so they
///         can. NOTE: the EIP defines NO ERC-165 interface id for the registry and the reference
///         registry implements no `supportsInterface` — do not probe it with ERC-165.
///         `createAccount` is idempotent by construction: if the account already exists the
///         registry returns its address without deploying (and without emitting the event again).
interface IERC6551Registry {
    /// @notice Emitted upon successful account creation (a real create2 deploy — NOT emitted when
    ///         `createAccount` finds the account already deployed and short-circuits).
    /// @param account        The address of the created token bound account.
    /// @param implementation The account implementation the ERC-1167 proxy delegates to.
    /// @param salt           The salt distinguishing multiple accounts for the same token.
    /// @param chainId        The EIP-155 id of the chain the bound token lives on.
    /// @param tokenContract  The contract address of the bound token.
    /// @param tokenId        The id of the bound token.
    event ERC6551AccountCreated(
        address account,
        address indexed implementation,
        bytes32 salt,
        uint256 chainId,
        address indexed tokenContract,
        uint256 indexed tokenId
    );

    /// @notice The registry MUST revert with this error if the create2 operation fails.
    error AccountCreationFailed();

    /// @notice Creates a token bound account for a non-fungible token. If the account has already
    ///         been created, returns the account address without calling create2.
    /// @dev    Emits {ERC6551AccountCreated} (only on an actual deploy).
    /// @param implementation The account implementation the deployed ERC-1167 proxy delegates to.
    /// @param salt           The salt distinguishing multiple accounts for the same token.
    /// @param chainId        The EIP-155 id of the chain the bound token lives on.
    /// @param tokenContract  The contract address of the bound token.
    /// @param tokenId        The id of the bound token.
    /// @return account The address of the token bound account.
    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external returns (address account);

    /// @notice Returns the computed token bound account address for a non-fungible token — the
    ///         counterfactual create2 address, whether or not the account is deployed yet.
    /// @param implementation The account implementation the proxy delegates to.
    /// @param salt           The salt distinguishing multiple accounts for the same token.
    /// @param chainId        The EIP-155 id of the chain the bound token lives on.
    /// @param tokenContract  The contract address of the bound token.
    /// @param tokenId        The id of the bound token.
    /// @return account The address of the token bound account.
    function account(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external view returns (address account);
}
