// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IHouseTokenFactory
/// @author Access0x1
/// @notice The minimal surface of the non-custodial House Token factory. A business deploys its OWN
///         ERC-20 THROUGH Access0x1 and OWNS it in its own wallet (loyalty / credit / closed-loop
///         payments) — "their access onchain". The factory NEVER holds the keys or the supply: token
///         ownership AND the full initial mint go to the caller-chosen owner in the SAME deploy tx,
///         and the factory retains no admin authority over any deployed token.
/// @dev    The `Deployed(owner, token)` event shape is a pre-deploy-locked seam (SPEC.md "Payout token
///         + House token"): it MUST stay (owner indexed, token indexed) so off-chain indexers and the
///         router can resolve every house token an owner controls from logs alone, with no enumeration.
interface IHouseTokenFactory {
    // ──────────────────────── events ────────────────────────

    /// @notice Emitted once per house token deployed through the factory.
    /// @dev    LOCKED SHAPE — do not reorder/retype (pre-deploy seam). `owner` and `token` are both
    ///         indexed so an indexer can filter by either. The factory is `caller`-agnostic: `owner`
    ///         is the address that receives ownership AND supply, which the caller chooses (may be the
    ///         caller itself or any business wallet it nominates).
    /// @param owner       The address that received token ownership AND the full initial supply.
    /// @param token       The freshly deployed HouseToken contract address.
    /// @param caller      The address that invoked {deployHouseToken} (the deployer of record).
    /// @param name        The ERC-20 name of the deployed token.
    /// @param symbol      The ERC-20 symbol of the deployed token.
    /// @param initialSupply The full supply minted to `owner` at deploy (in the token's smallest unit).
    event Deployed(
        address indexed owner,
        address indexed token,
        address indexed caller,
        string name,
        string symbol,
        uint256 initialSupply
    );

    // ──────────────────────── errors ────────────────────────

    /// @notice The chosen owner / supply recipient is the zero address. The factory will not deploy a
    ///         token it would implicitly own (supply minted nowhere, ownership renounced by accident).
    error HouseTokenFactory__ZeroOwner();

    /// @notice An empty token name or symbol was supplied — a house token must be identifiable.
    error HouseTokenFactory__EmptyMetadata();

    // ──────────────────────── functions ────────────────────────

    /// @notice Deploy a fresh ERC-20 house token whose ownership AND full initial supply are assigned
    ///         to `owner` in this same transaction. Access0x1 keeps NO key and NO balance.
    /// @param owner         The business wallet that will own the token and hold the initial supply.
    /// @param name          The ERC-20 token name (non-empty).
    /// @param symbol        The ERC-20 token symbol (non-empty).
    /// @param decimals      The ERC-20 decimals (e.g. 18 for a standard token, 6 to mirror USDC).
    /// @param initialSupply The supply minted to `owner` at deploy, in the token's smallest unit
    ///                      (may be 0 — the owner can mint later via the token's own {mint}).
    /// @return token        The deployed HouseToken address.
    function deployHouseToken(
        address owner,
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        uint256 initialSupply
    ) external returns (address token);

    /// @notice The total number of house tokens this factory has deployed. A monotonic counter — never
    ///         a registry the factory can mutate after the fact.
    function deployedCount() external view returns (uint256);

    /// @notice Whether `token` was deployed by THIS factory. Lets the router trust a house token's
    ///         provenance without trusting the factory with any authority over it.
    function isHouseToken(address token) external view returns (bool);
}
