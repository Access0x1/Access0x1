// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script } from "forge-std/Script.sol";
import { MockV3Aggregator } from "../test/mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../test/mocks/MockUSDC.sol";
import { ChainRegistry } from "../src/ChainRegistry.sol";

/// @title  HelperConfig
/// @author Access0x1
/// @notice Per-chain deploy configuration, resolved from the chain id — NEVER a hardcoded address
///         (security.md). On a local Anvil it deploys fresh mocks so the whole flow is runnable
///         offline; on a live chain it reads every address from the environment, so an unset value
///         fails loudly rather than shipping a wrong/placeholder address.
/// @dev    The router constructor only needs `(owner, treasury, platformFeeBps)`; the feed + token
///         addresses are carried here too so the companion configure step (and the frontend) can
///         wire `setPriceFeed`/`setTokenAllowed` from one source of truth.
contract HelperConfig is Script {
    /// @notice Everything a deploy + first-configure needs for one chain.
    /// @dev    The first six fields drive the router + its configure step (unchanged). The trailing
    ///         three are the CONSOLIDATION block: they let `DeployAll` deploy + wire the full
    ///         first-party surface (the commerce quartet over the SessionGrant + Router spine, and the
    ///         off-money-path CRE consumer) in one broadcast. All three carry safe defaults so the
    ///         local + existing-chain flows are unchanged when their env vars are unset.
    struct NetworkConfig {
        address treasury; // platform fee sink (constructor)
        uint16 platformFeeBps; // initial platform fee (constructor)
        address nativeUsdFeed; // Chainlink native/USD feed (setPriceFeed[address(0)])
        address usdc; // settlement ERC-20 to allowlist
        address usdcUsdFeed; // Chainlink USDC/USD feed
        address chainRegistry; // the ChainRegistry sidecar for SDK/cross-chain reads (additive)
        uint16 graceFailThreshold; // Access0x1Subscriptions dunning grace (non-zero; constructor)
        address creForwarder; // Chainlink CRE KeystoneForwarder for Access0x1Receiver; 0 ⇒ skip the consumer
    }

    /// @notice The chain id of a local Anvil/Foundry node.
    uint256 internal constant LOCAL_CHAIN_ID = 31_337;

    /// @notice Arc testnet (Circle). Native gas is USDC-denominated; ERC-20 USDC support is a booth confirm.
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5_042_002;

    /// @notice Base Sepolia (Coinbase L2). Standard 6-dec Circle USDC + Chainlink feeds available.
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84_532;

    /// @notice zkSync Sepolia (Era, ZK Stack). Native = ETH (18 dec); USDC + feed addresses are booth confirms.
    uint256 internal constant ZKSYNC_SEPOLIA_CHAIN_ID = 300;

    /// @notice Default platform fee when `*_PLATFORM_FEE_BPS` is unset: 100 bps = 1.00%.
    uint16 internal constant DEFAULT_PLATFORM_FEE_BPS = 100;

    /// @notice Default dunning grace for `Access0x1Subscriptions` when `*_SUBS_GRACE_FAILS` is unset:
    ///         a PAST_DUE subscription demotes to UNPAID after 3 failed renewals (mirrors a typical
    ///         grace window). Must be non-zero — the Subscriptions constructor reverts on 0.
    uint16 internal constant DEFAULT_SUBS_GRACE_FAILS = 3;

    /// @notice The resolved config for the chain this script runs against.
    NetworkConfig public activeConfig;

    /// @dev One O(1) `if/else if` ladder over `block.chainid` (no loops, no arrays). Local gets fresh
    ///      mocks; each named event testnet reads its OWN prefixed env vars so a second chain never
    ///      reuses the first's addresses; anything else falls through to the generic env block. Every
    ///      branch is additive — the local + catch-all behaviour is unchanged.
    constructor() {
        if (block.chainid == LOCAL_CHAIN_ID) {
            activeConfig = _localConfigWithMocks();
        } else if (block.chainid == ARC_TESTNET_CHAIN_ID) {
            activeConfig = _arcTestnetConfig();
        } else if (block.chainid == BASE_SEPOLIA_CHAIN_ID) {
            activeConfig = _baseSepoliaConfig();
        } else if (block.chainid == ZKSYNC_SEPOLIA_CHAIN_ID) {
            activeConfig = _zkSyncSepoliaConfig();
        } else {
            activeConfig = _liveConfigFromEnv();
        }
    }

    /// @notice The active network config (treasury, fee, feeds, token).
    function getConfig() external view returns (NetworkConfig memory) {
        return activeConfig;
    }

    /// @dev Live chains (Arc / Base / zkSync …): read every address from the environment so nothing
    ///      is guessed. `treasury` is required; feed/token/registry addresses are optional here and
    ///      wired by the configure step once the booth/docs values are known. `CHAIN_REGISTRY` is
    ///      the already-deployed `ChainRegistry` (from `DeployChainRegistry`) on this chain.
    ///      CONSOLIDATION env (all optional, safe defaults): `SUBS_GRACE_FAILS` (the Subscriptions
    ///      dunning threshold, defaults to 3 — never 0) and `CRE_FORWARDER` (the Chainlink CRE
    ///      KeystoneForwarder; unset ⇒ DeployAll skips the off-money-path `Access0x1Receiver`, the
    ///      commerce quartet + money spine still deploy). Named chains read the `<PREFIX>_`-prefixed
    ///      form of each (e.g. `ARC_SUBS_GRACE_FAILS`, `BASE_SEPOLIA_CRE_FORWARDER`).
    function _liveConfigFromEnv() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("PLATFORM_TREASURY"),
            platformFeeBps: uint16(vm.envOr("PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))),
            nativeUsdFeed: vm.envOr("NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("CRE_FORWARDER", address(0))
        });
    }

    /// @dev Arc testnet (chainId 5042002). Reads only `ARC_`-prefixed env so it never collides with
    ///      another chain's values. `treasury` is required (fails loud via `vm.envAddress`); the fee
    ///      and feed/USDC addresses are optional and default to address(0) when not yet confirmed.
    ///      Arc trap: Arc's native gas is USDC-denominated (18 dec) while an ERC-20 USDC, if one is
    ///      deployed, is 6 dec — never hardcode either; CONFIRM the ERC-20 USDC address at the Circle
    ///      booth and the native/USD + USDC/USD feeds at the Chainlink/Arc booth. Leave any unconfirmed
    ///      address blank: DeployAll skips the matching configure call rather than wiring a guess.
    function _arcTestnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("ARC_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("ARC_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("ARC_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("ARC_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("ARC_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("ARC_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("ARC_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("ARC_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Base Sepolia (chainId 84532). Reads only `BASE_SEPOLIA_`-prefixed env. Standard Circle
    ///      USDC (6 dec) and Chainlink ETH/USD + USDC/USD feeds are available — fill the addresses from
    ///      Circle docs + docs.chain.link/data-feeds. `treasury` is required; everything else optional.
    function _baseSepoliaConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("BASE_SEPOLIA_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("BASE_SEPOLIA_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("BASE_SEPOLIA_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("BASE_SEPOLIA_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("BASE_SEPOLIA_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("BASE_SEPOLIA_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("BASE_SEPOLIA_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("BASE_SEPOLIA_CRE_FORWARDER", address(0))
        });
    }

    /// @dev zkSync Sepolia (chainId 300, ZK Stack / Era). Reads only `ZKSYNC_SEPOLIA_`-prefixed env.
    ///      Native token = ETH (18 dec). No Circle App Kit / CCTP and (CONFIRM) no CCIP lane here.
    ///      USDC ERC-20 + Chainlink feed availability on zkSync Sepolia are booth/docs confirms — leave
    ///      blank until verified. Broadcast may require `[profile.zksync]` if `forge script` can't emit
    ///      ZK-Stack-valid bytecode with solc 0.8.28 + cancun (see foundry.toml). `treasury` required.
    function _zkSyncSepoliaConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("ZKSYNC_SEPOLIA_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("ZKSYNC_SEPOLIA_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("ZKSYNC_SEPOLIA_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("ZKSYNC_SEPOLIA_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("ZKSYNC_SEPOLIA_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("ZKSYNC_SEPOLIA_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("ZKSYNC_SEPOLIA_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("ZKSYNC_SEPOLIA_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Local Anvil: deploy mock feeds ($2000 native, $1 USDC) + a mock USDC + a fresh
    ///      `ChainRegistry` (owned by the sender) in the same broadcast block, so the whole flow is
    ///      self-contained — `forge script` runs end-to-end with no RPC, no env, no real addresses.
    function _localConfigWithMocks() internal returns (NetworkConfig memory) {
        vm.startBroadcast();
        MockV3Aggregator nativeFeed = new MockV3Aggregator(8, 2000e8);
        MockV3Aggregator usdcFeed = new MockV3Aggregator(8, 1e8);
        MockUSDC usdc = new MockUSDC();
        ChainRegistry chainRegistry = new ChainRegistry(msg.sender);
        vm.stopBroadcast();

        return NetworkConfig({
            treasury: msg.sender,
            platformFeeBps: DEFAULT_PLATFORM_FEE_BPS,
            nativeUsdFeed: address(nativeFeed),
            usdc: address(usdc),
            usdcUsdFeed: address(usdcFeed),
            chainRegistry: address(chainRegistry),
            graceFailThreshold: DEFAULT_SUBS_GRACE_FAILS,
            // No real KeystoneForwarder on a local node: address(0) makes DeployAll SKIP the CRE
            // consumer (it is off the money path; the full commerce + spine surface still deploys).
            creForwarder: address(0)
        });
    }
}
