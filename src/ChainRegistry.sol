// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title  ChainRegistry — Access0x1 multi-chain reference
/// @author Access0x1
/// @notice The canonical, on-chain hash-map of per-chain facts (native USDC, the local router,
///         the Chainlink CCIP selector, and a packed flag word) keyed by `chainId`. It is a READ
///         reference for the SDK, the frontend, the (future) CCIP sender, and `HelperConfig` —
///         one source of truth the operator updates with `addChain`, so a new chain needs no SDK
///         redeploy.
/// @dev    A deliberate SIDECAR, not a router field. `Access0x1Router` is the audited, zero-custody
///         money path; it settles SAME-CHAIN payments and never needs remote-chain facts at pay
///         time, so this config does not belong in it (adding a `chains` mapping there would force a
///         money-path re-audit and add SLOAD cost to a contract that has no use for it). This
///         contract holds NO assets — no escrow, no payable functions, no token movement — so there
///         is no CEI or reentrancy concern; it is `Ownable2Step` config storage only.
contract ChainRegistry is Ownable2Step {
    /// @notice One chain's facts. `usdc` is the native (Circle) USDC and default payout token on
    ///         that chain; `router` is the `Access0x1Router` deployed there (`address(0)` until one
    ///         is wired); `ccipSelector` is the Chainlink CCIP chain selector (`0` = no live lane);
    ///         `flags` packs the boolean facts (see the `FLAG_*` constants).
    /// @dev    Layout note (honest, per CHAINS.md): `usdc` (20B) fills slot 0 and `router` (20B)
    ///         fills slot 1 — two addresses cannot share a slot — and `ccipSelector` (8B) + `flags`
    ///         (2B) pack into slot 2. So a full entry is three storage slots / one mapping read; the
    ///         "two slots" figure in CHAINS.md is the packed-tail intent, not achievable for two
    ///         independent addresses without manual assembly we deliberately avoid.
    struct ChainConfig {
        address usdc;
        address router;
        uint64 ccipSelector;
        uint16 flags;
    }

    /// @notice Flag bit 0: the chain is live (the operator has switched it on for routing).
    uint16 internal constant FLAG_LIVE = 0x0001;

    /// @notice Flag bit 1: the chain uses Circle-native USDC (vs. a bridged representation).
    /// @dev    Part of the documented public flag scheme: written into `flags` by the operator/SDK
    ///         and the deploy script, read off-chain — not consumed inside this storage-only sidecar,
    ///         so slither's `unused-state` is by-design.
    // slither-disable-next-line unused-state
    uint16 internal constant FLAG_CIRCLE_USDC = 0x0002;

    /// @notice Flag bit 2: a Chainlink CCIP lane exists for this chain (`ccipSelector` is then set).
    /// @dev    Documented public flag scheme (see {FLAG_CIRCLE_USDC}); off-chain-consumed by design.
    // slither-disable-next-line unused-state
    uint16 internal constant FLAG_CCIP_LANE = 0x0004;

    /// @notice Flag bit 3: this is a TESTNET chain id (every seeded entry sets this). The seed chain
    ///         ids themselves (Arc 5042002, Base Sepolia 84532, zkSync Sepolia 300) live in
    ///         `DeployChainRegistry.s.sol`, where they are the keys passed to `addChain` — the
    ///         registry stores any `chainId` and holds no opinion about which exist, by design.
    /// @dev    Documented public flag scheme (see {FLAG_CIRCLE_USDC}); off-chain-consumed by design.
    // slither-disable-next-line unused-state
    uint16 internal constant FLAG_TESTNET = 0x0008;

    /// @notice chainId ⇒ its config. Public getter for the SDK/frontend; a never-added id reads back
    ///         as the all-zero `ChainConfig` (treated as "not found" by {getChain}/{setChainLive}).
    mapping(uint256 chainId => ChainConfig cfg) public chains;

    /// @notice A chain entry was added or upserted.
    /// @param  chainId The chain id keyed.
    /// @param  cfg     The full config now stored for `chainId`.
    event ChainAdded(uint256 indexed chainId, ChainConfig cfg);

    /// @notice The `FLAG_LIVE` bit of a chain was flipped.
    /// @param  chainId The chain id whose live flag changed.
    /// @param  live    The new state of the live bit.
    event ChainLiveSet(uint256 indexed chainId, bool live);

    /// @notice Thrown when a `chainId` that was never added is read or mutated.
    /// @param  chainId The unknown chain id.
    error ChainRegistry__ChainNotFound(uint256 chainId);

    /// @notice Reserved for callers that require a non-zero address invariant. The registry itself
    ///         allows a zero `usdc`/`router` (a chain may have neither wired yet), so this is the
    ///         shared error for any consumer that wants to enforce non-zero before use.
    error ChainRegistry__ZeroAddress();

    /// @notice Deploy the registry owned by `initialOwner` (the deployer, a burner at the event, or
    ///         a multisig in production). Two-step ownership transfer applies thereafter.
    /// @param  initialOwner The first owner; reverts via OZ `Ownable` if it is the zero address.
    constructor(address initialOwner) Ownable(initialOwner) { }

    /// @notice Upsert a chain entry. Owner-only. Calling again for the same `chainId` overwrites the
    ///         stored config (so a single tx can correct any field) and emits a fresh `ChainAdded`.
    ///         A zero `cfg.usdc` is allowed — a chain may not have native USDC wired yet.
    /// @dev    Law #4 (truth): CONFIRM every address and CCIP selector from your chain's official
    ///         official docs (e.g. docs.chain.link/ccip/directory) before calling this on a LIVE
    ///         chain. Never pass a value invented from memory. Three storage slots are written.
    /// @param  chainId The chain id to key.
    /// @param  cfg     The full config to store.
    function addChain(uint256 chainId, ChainConfig calldata cfg) external onlyOwner {
        chains[chainId] = cfg;
        emit ChainAdded(chainId, cfg);
    }

    /// @notice Flip only the `FLAG_LIVE` bit for `chainId`, leaving every other flag untouched, so
    ///         the operator can switch a chain on/off in one tx without re-sending the full struct.
    ///         Owner-only. Reverts `ChainRegistry__ChainNotFound` if the chain was never added.
    /// @param  chainId The chain id to toggle.
    /// @param  live    True to set the live bit, false to clear it.
    function setChainLive(uint256 chainId, bool live) external onlyOwner {
        if (!_exists(chainId)) revert ChainRegistry__ChainNotFound(chainId);
        if (live) {
            chains[chainId].flags |= FLAG_LIVE;
        } else {
            chains[chainId].flags &= ~FLAG_LIVE;
        }
        emit ChainLiveSet(chainId, live);
    }

    /// @notice Read the full config for `chainId`. Reverts `ChainRegistry__ChainNotFound` if the id
    ///         was never added (the all-zero entry is the "not found" sentinel — see {_exists}).
    /// @param  chainId The chain id to read.
    /// @return cfg The stored config.
    function getChain(uint256 chainId) external view returns (ChainConfig memory cfg) {
        if (!_exists(chainId)) revert ChainRegistry__ChainNotFound(chainId);
        return chains[chainId];
    }

    /// @notice True iff the `FLAG_LIVE` bit is set for `chainId`. A view helper, so a never-added id
    ///         simply returns false (no revert) — callers that need the distinction use {getChain}.
    /// @param  chainId The chain id to check.
    /// @return live Whether the chain is flagged live.
    function isLive(uint256 chainId) external view returns (bool live) {
        return chains[chainId].flags & FLAG_LIVE != 0;
    }

    /// @dev "Exists" iff the entry is not the all-zero default. A real add always sets at least one
    ///      of `usdc`, `router`, `ccipSelector`, or `flags` to a non-zero value (every seeded chain
    ///      sets `FLAG_TESTNET`), so an all-zero read is unambiguously a never-added id.
    /// @param chainId The chain id to test.
    /// @return exists Whether a non-default entry is stored.
    function _exists(uint256 chainId) internal view returns (bool exists) {
        ChainConfig storage c = chains[chainId];
        return c.usdc != address(0) || c.router != address(0) || c.ccipSelector != 0 || c.flags != 0;
    }
}
