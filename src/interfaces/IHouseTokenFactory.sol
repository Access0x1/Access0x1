// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IHouseTokenFactory
/// @author Rensley R. @vyperpilleddev
/// @notice The minimal surface of the non-custodial House Token factory. A business deploys its OWN
///         ERC-20 THROUGH Access0x1 and OWNS it in its own wallet (loyalty / credit / closed-loop
///         payments) — "their access onchain". The factory NEVER holds the keys or the supply: token
///         ownership AND the full initial mint go to the caller-chosen owner in the SAME deploy tx,
///         and the factory retains no admin authority over any deployed token.
/// @dev    The `Deployed(owner, token)` event shape is a pre-deploy-locked seam (SPEC.md "Payout token
///         + House token"): it MUST stay (owner indexed, token indexed) so off-chain indexers and the
///         router can resolve every house token an owner controls from logs alone, with no enumeration.
interface IHouseTokenFactory {
    // ──────────────────────── types ────────────────────────

    /// @notice The on-chain provenance record kept for every house token the factory deploys — the
    ///         single-`tokenRecord` answer to "who owns this token, when was it deployed, on which
    ///         chain", with NO log-scraping. Written once inside {deployHouseToken}, never mutated.
    /// @dev    Packed into ONE 32-byte storage slot: `owner` (20 bytes) + `deployedAt` (8 bytes) +
    ///         `chainId` (8 bytes) = 36 bytes... so the two `uint64`s sit in the upper 16 bytes and the
    ///         struct occupies exactly one and a half slots — the solc layout places `owner`+`deployedAt`
    ///         in slot N (20+8=28 ≤ 32) and `chainId` in slot N+1. `deployedAt` is the deploy
    ///         `block.timestamp` (good past year 2^64) and `chainId` is `block.chainid` at deploy, so a
    ///         record read off one chain still names the chain it was minted on (the shared-router world).
    /// @param owner      The address that received ownership AND the full initial supply at deploy.
    /// @param deployedAt The `block.timestamp` of the deploy (seconds; uint64 is overflow-safe past 2554).
    /// @param chainId    The `block.chainid` at deploy — the chain this token actually lives on.
    struct TokenRecord {
        address owner;
        uint64 deployedAt;
        uint64 chainId;
    }

    // ──────────────────────── events ────────────────────────

    /// @notice Emitted once per house token deployed through the factory.
    /// @dev    LOCKED INDEXED SHAPE — `owner`, `token`, `caller` stay indexed and in this order (pre-deploy
    ///         seam) so an indexer can filter by any of them. The trailing DATA fields are append-only:
    ///         `decimals` and `chainId` were added so a consumer can render an amount (it needs the
    ///         decimals) and place the token on its chain WITHOUT an extra `eth_call` — the event alone
    ///         is enough to index a token end-to-end. The factory is `caller`-agnostic: `owner` is the
    ///         address that receives ownership AND supply, which the caller chooses (may be the caller
    ///         itself or any business wallet it nominates).
    /// @param owner       The address that received token ownership AND the full initial supply.
    /// @param token       The freshly deployed HouseToken contract address.
    /// @param caller      The address that invoked {deployHouseToken} (the deployer of record).
    /// @param name        The ERC-20 name of the deployed token.
    /// @param symbol      The ERC-20 symbol of the deployed token.
    /// @param decimals    The ERC-20 decimals of the deployed token (so an amount renders from logs alone).
    /// @param initialSupply The full supply minted to `owner` at deploy (in the token's smallest unit).
    /// @param chainId     The `block.chainid` the token was deployed on (so an indexer never guesses it).
    event Deployed(
        address indexed owner,
        address indexed token,
        address indexed caller,
        string name,
        string symbol,
        uint8 decimals,
        uint256 initialSupply,
        uint256 chainId
    );

    // ──────────────────────── errors ────────────────────────

    /// @notice The chosen owner / supply recipient is the zero address. The factory will not deploy a
    ///         token it would implicitly own (supply minted nowhere, ownership renounced by accident).
    error HouseTokenFactory__ZeroOwner();

    /// @notice An empty token name or symbol was supplied — a house token must be identifiable.
    error HouseTokenFactory__EmptyMetadata();

    /// @notice `decimals` exceeded 18. A house token settles through the Access0x1 router, whose USD
    ///         `quote()` scales by the token's decimals; a >18-decimal token breaks that scaling (a
    ///         money-path footgun), so the factory refuses to mint one rather than ship a token that
    ///         cannot price correctly.
    /// @param decimals The rejected decimals value (> 18).
    error HouseTokenFactory__BadDecimals(uint8 decimals);

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

    /// @notice Every house token `owner` has deployed through the factory, in deploy order. The on-chain
    ///         answer to "which tokens does business X own?" — no log-scraping, one call.
    /// @dev    ⚠️ UNBOUNDED: returns the owner's WHOLE list in one read. `owner` is caller-supplied, so a
    ///         third party can grow ANY address's list by deploying tokens to it ({deployHouseToken} is
    ///         permissionless and the recipient never consents) — an attacker can inflate a victim's array
    ///         until this view exceeds the block gas limit (a gas-griefing / index-poisoning DoS on the
    ///         convenience read). Kept for the small-list common case and ABI stability; for any
    ///         attacker-influenced or large owner, page with {tokensOfLength} + {tokenOfOwnerAt} instead,
    ///         which load one entry at a time and CANNOT be griefed into reverting.
    /// @param owner The owner / supply recipient to look up.
    /// @return tokens The owner's deployed token addresses (empty if it has deployed none).
    function tokensOf(address owner) external view returns (address[] memory tokens);

    /// @notice The number of house tokens deployed to `owner` — the length of its owner-index, so a caller
    ///         can page the list with {tokenOfOwnerAt} for `0 .. tokensOfLength(owner)-1` WITHOUT loading
    ///         the whole (caller-influenceable, unbounded) array {tokensOf} returns.
    /// @param owner The owner / supply recipient to look up.
    /// @return The count of tokens deployed to `owner` (0 if it has deployed none).
    function tokensOfLength(address owner) external view returns (uint256);

    /// @notice The `i`-th house token deployed to `owner`, in deploy order. The O(1), gas-bounded
    ///         alternative to {tokensOf}: pair with {tokensOfLength} to page over an owner's tokens one at
    ///         a time, so a poisoned (attacker-inflated) owner index can never gas-DoS the read.
    /// @param owner The owner / supply recipient to look up.
    /// @param i     The zero-based index (must be `< tokensOfLength(owner)` or this reverts on out-of-bounds).
    /// @return The token address at index `i` in `owner`'s deploy-ordered list.
    function tokenOfOwnerAt(address owner, uint256 i) external view returns (address);

    /// @notice The number of house tokens the factory has ever deployed — the length of the global
    ///         enumeration ({tokenAt} is valid for `0 .. allTokensLength()-1`). Equals {deployedCount}.
    /// @return The total token count.
    function allTokensLength() external view returns (uint256);

    /// @notice The `i`-th house token in the global deploy-ordered enumeration. Pair with
    ///         {allTokensLength} to page over every token the factory has minted.
    /// @param i The zero-based index (must be `< allTokensLength()` or this reverts on out-of-bounds).
    /// @return The token address at index `i`.
    function tokenAt(uint256 i) external view returns (address);

    /// @notice The full provenance record for `token` — its owner-at-deploy, deploy timestamp, and the
    ///         chain it was deployed on. A zeroed record means the factory never deployed `token`.
    /// @param token The token address to look up.
    /// @return The {TokenRecord} for `token`.
    function tokenRecord(address token) external view returns (TokenRecord memory);
}
