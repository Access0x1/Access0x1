// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script } from "forge-std/Script.sol";
import { MockV3Aggregator } from "../test/mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../test/mocks/MockUSDC.sol";
import { ChainRegistry } from "../src/ChainRegistry.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

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

    /// @notice Ethereum Sepolia (L1 testnet). Native = ETH (18 dec). Circle USDC + Chainlink ETH/USD + USDC/USD all live.
    uint256 internal constant SEPOLIA_CHAIN_ID = 11_155_111;

    /// @notice Arbitrum Sepolia (Arbitrum L2 testnet). Native = ETH (18 dec). Circle USDC + Chainlink ETH/USD + USDC/USD all live.
    uint256 internal constant ARBITRUM_SEPOLIA_CHAIN_ID = 421_614;

    /// @notice Optimism Sepolia (OP Stack L2 testnet). Native = ETH (18 dec). Circle USDC + Chainlink ETH/USD live; no USDC/USD feed.
    uint256 internal constant OPTIMISM_SEPOLIA_CHAIN_ID = 11_155_420;

    /// @notice zkSync Sepolia (Era, ZK Stack). Native = ETH (18 dec); USDC + feed addresses are booth confirms.
    uint256 internal constant ZKSYNC_SEPOLIA_CHAIN_ID = 300;

    /// @notice Polygon Amoy (PoS testnet). Native = POL (18 dec). Circle USDC + Chainlink feeds exist — confirm.
    uint256 internal constant POLYGON_AMOY_CHAIN_ID = 80_002;

    /// @notice Avalanche Fuji (C-Chain testnet). Native = AVAX (18 dec). Circle USDC + feeds exist — confirm.
    uint256 internal constant AVALANCHE_FUJI_CHAIN_ID = 43_113;

    /// @notice BNB Smart Chain testnet. Native = tBNB (18 dec). USDC + BNB/USD feed addresses are confirms.
    uint256 internal constant BNB_TESTNET_CHAIN_ID = 97;

    /// @notice Scroll Sepolia (zkEVM L2). Native = ETH (18 dec). USDC + feed addresses are booth/docs confirms.
    uint256 internal constant SCROLL_SEPOLIA_CHAIN_ID = 534_351;

    /// @notice Linea Sepolia (Consensys zkEVM L2). Native = ETH (18 dec). USDC + feed addresses are confirms.
    uint256 internal constant LINEA_SEPOLIA_CHAIN_ID = 59_141;

    /// @notice Mantle Sepolia (OP-stack L2). Native = MNT (18 dec). Blockscout verifier; USDC + feeds confirms.
    uint256 internal constant MANTLE_SEPOLIA_CHAIN_ID = 5_003;

    /// @notice Blast Sepolia (OP-stack L2). Native = ETH (18 dec). USDC + feed addresses are booth/docs confirms.
    uint256 internal constant BLAST_SEPOLIA_CHAIN_ID = 168_587_773;

    /// @notice Unichain Sepolia (OP-stack L2). Native = ETH (18 dec). USDC + feed addresses are confirms.
    uint256 internal constant UNICHAIN_SEPOLIA_CHAIN_ID = 1_301;

    /// @notice Zora Sepolia (OP-stack L2). Native = ETH (18 dec). Blockscout verifier; USDC + feeds confirms.
    uint256 internal constant ZORA_SEPOLIA_CHAIN_ID = 999_999_999;

    /// @notice Filecoin Calibration (FEVM testnet). Native = tFIL (18 dec). Blockscout verifier; USDC + feeds confirms.
    uint256 internal constant FILECOIN_CALIBRATION_CHAIN_ID = 314_159;

    /// @notice Gnosis Chiado (testnet). Native = XDAI (18 dec, ≈ $1). Blockscout verifier; USDC + feeds confirms.
    uint256 internal constant GNOSIS_CHIADO_CHAIN_ID = 10_200;

    /// @notice ApeChain Curtis (Arbitrum-Orbit testnet). Native = APE (18 dec). Blockscout verifier; USDC + feeds confirms.
    uint256 internal constant APECHAIN_CURTIS_CHAIN_ID = 33_111;

    /// @notice World Chain Sepolia (OP-stack L2). Native = ETH (18 dec, NOT WLD as gas). Worldscan verifier; confirms.
    uint256 internal constant WORLDCHAIN_SEPOLIA_CHAIN_ID = 4_801;

    /// @notice Zircuit Garfield (testnet). Native = ETH (18 dec). Sourcify verifier; USDC + feeds confirms.
    uint256 internal constant ZIRCUIT_GARFIELD_CHAIN_ID = 48_898;

    /// @notice Citrea testnet (Bitcoin zk-rollup). Native = cBTC (18 dec). Blockscout verifier; USDC + feeds confirms.
    uint256 internal constant CITREA_TESTNET_CHAIN_ID = 5_115;

    /// @notice Flow EVM testnet. Native = FLOW (18 dec). Blockscout verifier; USDC + feeds confirms.
    uint256 internal constant FLOW_EVM_TESTNET_CHAIN_ID = 545;

    /// @notice Celo Sepolia (testnet). Native = CELO (18 dec). Celoscan (etherscan-v2) verifier; USDC + feeds confirms.
    uint256 internal constant CELO_SEPOLIA_CHAIN_ID = 11_142_220;

    /// @notice Robinhood Chain testnet (Arbitrum Orbit L2, chainId 46630). Native = ETH (18 dec).
    ///         Chainlink CCIP selector 2032988798112970440 IS registered (official chain-selectors) and a
    ///         LINK faucet is live, but Chainlink Data Feeds are NOT yet deployed here — so `nativeUsdFeed`
    ///         stays address(0), DeployAll skips wiring it, and same-chain USD `quote()` is unavailable
    ///         until a feed lands (verify on docs.chain.link first; NEVER invent one). Role today: a CCIP
    ///         cross-chain LANE endpoint (a payment quotes on its SOURCE chain). No confirmed ERC-20 USDC
    ///         on the testnet yet either — `usdc` stays blank. Blockscout explorer.
    uint256 internal constant ROBINHOOD_TESTNET_CHAIN_ID = 46_630;

    /// @notice 0G Galileo testnet (0G's V3 testnet, chainId 16602). Native gas token = 0G (18 dec) — NOT
    ///         USDC, so there is no native-gas peg to a dollar. Chainlink Data Feeds are NOT deployed on
    ///         0G, so `nativeUsdFeed` stays address(0) and same-chain native `quote()` is unavailable
    ///         (NEVER invent a 0G/USD feed). Where a REAL ERC-20 USDC exists, deploy a $1.00 USDC/USD
    ///         MockV3Aggregator first (`make deploy-usd-mock-feed RPC=$GALILEO_RPC_URL`, the Arc pattern)
    ///         and set `GALILEO_USDC_USD_FEED` — the router then prices REAL USDC (the "no demo token" law
    ///         holds). Blockscout-style explorer (chainscan-galileo.0g.ai). Confirmed live via cast 2026-06-20.
    uint256 internal constant GALILEO_TESTNET_CHAIN_ID = 16_602;

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // MAINNET chain ids — AUDIT-GATED, NOT DEPLOYED.
    //
    // These ids exist so each chain has BOTH a testnet and a mainnet config PROFILE. They change
    // NOTHING about what is live: this repo is testnet-only and unaudited, and there is NO mainnet
    // deployment and NO mainnet claim anywhere. Every mainnet branch below reads ALL of its addresses
    // from `<CHAIN>_MAINNET_*` env (default address(0)) exactly like the testnet branches, so nothing
    // is ever hardcoded — a real USDC/feed address here would imply a deployment we have not made and
    // is therefore forbidden (law #4). A mainnet target is reachable ONLY by an explicit, audit-gated
    // `make deploy-<chain>-mainnet` (each of those targets carries a loud "do not run until audited"
    // banner). The constructor arms below sit ABOVE the `_liveConfigFromEnv()` fallback purely so the
    // RIGHT env prefix is read per chain; selecting a branch never broadcasts anything by itself.
    // ─────────────────────────────────────────────────────────────────────────────────────────────

    /// @notice Ethereum mainnet (chainId 1). AUDIT-GATED config profile only — no deployment exists.
    uint256 internal constant ETHEREUM_MAINNET_CHAIN_ID = 1;

    /// @notice Base mainnet (Coinbase L2, chainId 8453). AUDIT-GATED config profile only — not deployed.
    uint256 internal constant BASE_MAINNET_CHAIN_ID = 8_453;

    /// @notice Arbitrum One (chainId 42161). AUDIT-GATED config profile only — not deployed.
    uint256 internal constant ARBITRUM_MAINNET_CHAIN_ID = 42_161;

    /// @notice Optimism mainnet (OP Mainnet, chainId 10). AUDIT-GATED config profile only — not deployed.
    uint256 internal constant OPTIMISM_MAINNET_CHAIN_ID = 10;

    /// @notice Polygon mainnet (PoS, chainId 137). Native = POL (18 dec). AUDIT-GATED — not deployed.
    uint256 internal constant POLYGON_MAINNET_CHAIN_ID = 137;

    /// @notice Avalanche C-Chain mainnet (chainId 43114). Native = AVAX (18 dec). AUDIT-GATED — not deployed.
    uint256 internal constant AVALANCHE_MAINNET_CHAIN_ID = 43_114;

    /// @notice BNB Smart Chain mainnet (chainId 56). Native = BNB (18 dec). AUDIT-GATED — not deployed.
    uint256 internal constant BNB_MAINNET_CHAIN_ID = 56;

    /// @notice Scroll mainnet (zkEVM L2, chainId 534352). Native = ETH (18 dec). AUDIT-GATED — not deployed.
    uint256 internal constant SCROLL_MAINNET_CHAIN_ID = 534_352;

    /// @notice Linea mainnet (Consensys zkEVM, chainId 59144). Native = ETH (18 dec). AUDIT-GATED — not deployed.
    uint256 internal constant LINEA_MAINNET_CHAIN_ID = 59_144;

    /// @notice Mantle mainnet (OP-stack L2, chainId 5000). Native = MNT (18 dec). AUDIT-GATED — not deployed.
    uint256 internal constant MANTLE_MAINNET_CHAIN_ID = 5_000;

    /// @notice Blast mainnet (OP-stack L2, chainId 81457). Native = ETH (18 dec). AUDIT-GATED — not deployed.
    uint256 internal constant BLAST_MAINNET_CHAIN_ID = 81_457;

    /// @notice Unichain mainnet (OP-stack L2, chainId 130). Native = ETH (18 dec). AUDIT-GATED — not deployed.
    uint256 internal constant UNICHAIN_MAINNET_CHAIN_ID = 130;

    /// @notice zkSync Era mainnet (ZK Stack, chainId 324). Native = ETH (18 dec). AUDIT-GATED — not deployed.
    uint256 internal constant ZKSYNC_MAINNET_CHAIN_ID = 324;

    /// @notice Zora mainnet (OP-stack L2, chainId 7777777). Native = ETH (18 dec). AUDIT-GATED — not deployed.
    uint256 internal constant ZORA_MAINNET_CHAIN_ID = 7_777_777;

    /// @notice Filecoin mainnet (FEVM, chainId 314). Native = FIL (18 dec). AUDIT-GATED — not deployed.
    uint256 internal constant FILECOIN_MAINNET_CHAIN_ID = 314;

    /// @notice Gnosis Chain (chainId 100). Native = XDAI (18 dec, ≈ $1). AUDIT-GATED — not deployed.
    uint256 internal constant GNOSIS_MAINNET_CHAIN_ID = 100;

    /// @notice ApeChain (Arbitrum-Orbit, chainId 33139). Native = APE (18 dec). AUDIT-GATED — not deployed.
    uint256 internal constant APECHAIN_MAINNET_CHAIN_ID = 33_139;

    /// @notice World Chain (OP-stack L2, chainId 480). Native = ETH (18 dec). AUDIT-GATED — not deployed.
    uint256 internal constant WORLDCHAIN_MAINNET_CHAIN_ID = 480;

    /// @notice Zircuit mainnet (chainId 48900). Native = ETH (18 dec). AUDIT-GATED — not deployed.
    uint256 internal constant ZIRCUIT_MAINNET_CHAIN_ID = 48_900;

    /// @notice Citrea mainnet (Bitcoin zk-rollup, chainId 4114). Native = cBTC (18 dec). AUDIT-GATED — not deployed.
    uint256 internal constant CITREA_MAINNET_CHAIN_ID = 4_114;

    /// @notice Flow EVM mainnet (chainId 747). Native = FLOW (18 dec). AUDIT-GATED — not deployed.
    uint256 internal constant FLOW_EVM_MAINNET_CHAIN_ID = 747;

    /// @notice Celo mainnet (chainId 42220). Native = CELO (18 dec). AUDIT-GATED — not deployed.
    uint256 internal constant CELO_MAINNET_CHAIN_ID = 42_220;

    /// @notice Arc MAINNET is NOT launched (Arc is testnet-only today), so its chain id is UNKNOWN and
    ///         MUST NOT be invented. The Arc-mainnet branch is selected ONLY when the operator sets
    ///         `ARC_MAINNET_CHAIN_ID` to the real id at launch; until then this resolves to 0, which can
    ///         never equal a live `block.chainid`, so the branch is unreachable and claims nothing. This
    ///         is read at construction (not a compile-time constant) precisely because the id is TBD.
    /// @dev    CANDIDATE (verified Jun 16, 2026, NOT yet operational): the canonical EVM registry
    ///         `ethereum-lists/chains` pre-registers `eip155-5042.json` (shortName "arc-mainnet", native
    ///         USDC) — so the likely id is **5042** — but that entry has EMPTY rpc[]/explorers[] and the
    ///         network is still public testnet (Circle targets "mainnet beta, summer 2026"). It stays a
    ///         hint, NOT a default: the env still defaults to 0 (dormant). Set `ARC_MAINNET_CHAIN_ID=5042`
    ///         only once Circle publishes a live mainnet RPC (the registry entry will gain rpc/explorer
    ///         URLs as the corroborating signal). Testnet id `5042002` is confirmed + live.
    function _arcMainnetChainId() internal view returns (uint256) {
        return vm.envOr("ARC_MAINNET_CHAIN_ID", uint256(0));
    }

    /// @notice Default platform fee when `*_PLATFORM_FEE_BPS` is unset: 100 bps = 1.00%.
    uint16 internal constant DEFAULT_PLATFORM_FEE_BPS = 100;

    /// @notice Default dunning grace for `Access0x1Subscriptions` when `*_SUBS_GRACE_FAILS` is unset:
    ///         a PAST_DUE subscription demotes to UNPAID after 3 failed renewals (mirrors the
    ///         a typical SaaS grace window). Must be non-zero — the Subscriptions constructor reverts on 0.
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
        } else if (block.chainid == SEPOLIA_CHAIN_ID) {
            activeConfig = _ethereumSepoliaConfig();
        } else if (block.chainid == ARBITRUM_SEPOLIA_CHAIN_ID) {
            activeConfig = _arbitrumSepoliaConfig();
        } else if (block.chainid == OPTIMISM_SEPOLIA_CHAIN_ID) {
            activeConfig = _optimismSepoliaConfig();
        } else if (block.chainid == ZKSYNC_SEPOLIA_CHAIN_ID) {
            activeConfig = _zkSyncSepoliaConfig();
        } else if (block.chainid == POLYGON_AMOY_CHAIN_ID) {
            activeConfig = _polygonAmoyConfig();
        } else if (block.chainid == AVALANCHE_FUJI_CHAIN_ID) {
            activeConfig = _avalancheFujiConfig();
        } else if (block.chainid == BNB_TESTNET_CHAIN_ID) {
            activeConfig = _bnbTestnetConfig();
        } else if (block.chainid == SCROLL_SEPOLIA_CHAIN_ID) {
            activeConfig = _scrollSepoliaConfig();
        } else if (block.chainid == LINEA_SEPOLIA_CHAIN_ID) {
            activeConfig = _lineaSepoliaConfig();
        } else if (block.chainid == MANTLE_SEPOLIA_CHAIN_ID) {
            activeConfig = _mantleSepoliaConfig();
        } else if (block.chainid == BLAST_SEPOLIA_CHAIN_ID) {
            activeConfig = _blastSepoliaConfig();
        } else if (block.chainid == UNICHAIN_SEPOLIA_CHAIN_ID) {
            activeConfig = _unichainSepoliaConfig();
        } else if (block.chainid == ZORA_SEPOLIA_CHAIN_ID) {
            activeConfig = _zoraSepoliaConfig();
        } else if (block.chainid == FILECOIN_CALIBRATION_CHAIN_ID) {
            activeConfig = _filecoinCalibrationConfig();
        } else if (block.chainid == GNOSIS_CHIADO_CHAIN_ID) {
            activeConfig = _gnosisChiadoConfig();
        } else if (block.chainid == APECHAIN_CURTIS_CHAIN_ID) {
            activeConfig = _apechainCurtisConfig();
        } else if (block.chainid == WORLDCHAIN_SEPOLIA_CHAIN_ID) {
            activeConfig = _worldchainSepoliaConfig();
        } else if (block.chainid == ZIRCUIT_GARFIELD_CHAIN_ID) {
            activeConfig = _zircuitGarfieldConfig();
        } else if (block.chainid == CITREA_TESTNET_CHAIN_ID) {
            activeConfig = _citreaTestnetConfig();
        } else if (block.chainid == FLOW_EVM_TESTNET_CHAIN_ID) {
            activeConfig = _flowEvmTestnetConfig();
        } else if (block.chainid == CELO_SEPOLIA_CHAIN_ID) {
            activeConfig = _celoSepoliaConfig();
        } else if (block.chainid == ROBINHOOD_TESTNET_CHAIN_ID) {
            activeConfig = _robinhoodTestnetConfig();
        } else if (block.chainid == GALILEO_TESTNET_CHAIN_ID) {
            activeConfig = _galileoTestnetConfig();
        } else if (block.chainid == ETHEREUM_MAINNET_CHAIN_ID) {
            // ── MAINNET arms (AUDIT-GATED, NOT DEPLOYED) — each reads only its own `<CHAIN>_MAINNET_*`
            //    env (default address(0)); selecting a branch never deploys. See the mainnet-id block.
            activeConfig = _ethereumMainnetConfig();
        } else if (block.chainid == BASE_MAINNET_CHAIN_ID) {
            activeConfig = _baseMainnetConfig();
        } else if (block.chainid == ARBITRUM_MAINNET_CHAIN_ID) {
            activeConfig = _arbitrumMainnetConfig();
        } else if (block.chainid == OPTIMISM_MAINNET_CHAIN_ID) {
            activeConfig = _optimismMainnetConfig();
        } else if (block.chainid == POLYGON_MAINNET_CHAIN_ID) {
            activeConfig = _polygonMainnetConfig();
        } else if (block.chainid == AVALANCHE_MAINNET_CHAIN_ID) {
            activeConfig = _avalancheMainnetConfig();
        } else if (block.chainid == BNB_MAINNET_CHAIN_ID) {
            activeConfig = _bnbMainnetConfig();
        } else if (block.chainid == SCROLL_MAINNET_CHAIN_ID) {
            activeConfig = _scrollMainnetConfig();
        } else if (block.chainid == LINEA_MAINNET_CHAIN_ID) {
            activeConfig = _lineaMainnetConfig();
        } else if (block.chainid == MANTLE_MAINNET_CHAIN_ID) {
            activeConfig = _mantleMainnetConfig();
        } else if (block.chainid == BLAST_MAINNET_CHAIN_ID) {
            activeConfig = _blastMainnetConfig();
        } else if (block.chainid == UNICHAIN_MAINNET_CHAIN_ID) {
            activeConfig = _unichainMainnetConfig();
        } else if (block.chainid == ZKSYNC_MAINNET_CHAIN_ID) {
            activeConfig = _zkSyncMainnetConfig();
        } else if (block.chainid == ZORA_MAINNET_CHAIN_ID) {
            activeConfig = _zoraMainnetConfig();
        } else if (block.chainid == FILECOIN_MAINNET_CHAIN_ID) {
            activeConfig = _filecoinMainnetConfig();
        } else if (block.chainid == GNOSIS_MAINNET_CHAIN_ID) {
            activeConfig = _gnosisMainnetConfig();
        } else if (block.chainid == APECHAIN_MAINNET_CHAIN_ID) {
            activeConfig = _apechainMainnetConfig();
        } else if (block.chainid == WORLDCHAIN_MAINNET_CHAIN_ID) {
            activeConfig = _worldchainMainnetConfig();
        } else if (block.chainid == ZIRCUIT_MAINNET_CHAIN_ID) {
            activeConfig = _zircuitMainnetConfig();
        } else if (block.chainid == CITREA_MAINNET_CHAIN_ID) {
            activeConfig = _citreaMainnetConfig();
        } else if (block.chainid == FLOW_EVM_MAINNET_CHAIN_ID) {
            activeConfig = _flowEvmMainnetConfig();
        } else if (block.chainid == CELO_MAINNET_CHAIN_ID) {
            activeConfig = _celoMainnetConfig();
        } else if (_isArcMainnet()) {
            // Arc MAINNET — id is TBD (not launched), so this matches ONLY when the operator has set
            // `ARC_MAINNET_CHAIN_ID` to the real id AND the node reports it. Unreachable until then.
            activeConfig = _arcMainnetConfig();
        } else {
            activeConfig = _liveConfigFromEnv();
        }
    }

    /// @dev True only when the operator has set a NON-ZERO `ARC_MAINNET_CHAIN_ID` env AND it matches the
    ///      live `block.chainid`. The zero guard is essential: an unset env resolves to 0, and matching
    ///      `block.chainid == 0` could mis-select Arc-mainnet on a misconfigured node — so we never match
    ///      on 0. This keeps the Arc-mainnet branch dormant until Arc mainnet actually exists and the id
    ///      is known (the id is never invented in code).
    function _isArcMainnet() internal view returns (bool) {
        uint256 id = _arcMainnetChainId();
        return id != 0 && block.chainid == id;
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

    /// @dev Ethereum Sepolia (chainId 11155111, L1 testnet). Reads only `SEPOLIA_`-prefixed env. Native
    ///      = ETH (18 dec). Circle USDC (6 dec) + Chainlink ETH/USD + USDC/USD feeds are all live on
    ///      Sepolia (see docs/CHAIN-ADDRESSES.md). `treasury` required; addresses skipped until set.
    function _ethereumSepoliaConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("SEPOLIA_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("SEPOLIA_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("SEPOLIA_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("SEPOLIA_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("SEPOLIA_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("SEPOLIA_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("SEPOLIA_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("SEPOLIA_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Arbitrum Sepolia (chainId 421614, Arbitrum L2 testnet). Reads only `ARBITRUM_SEPOLIA_`-prefixed
    ///      env. Native = ETH (18 dec). Circle USDC (6 dec) + Chainlink ETH/USD + USDC/USD feeds all live.
    ///      `treasury` required; feed/USDC addresses optional and skipped until set.
    function _arbitrumSepoliaConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("ARBITRUM_SEPOLIA_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("ARBITRUM_SEPOLIA_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("ARBITRUM_SEPOLIA_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("ARBITRUM_SEPOLIA_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("ARBITRUM_SEPOLIA_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("ARBITRUM_SEPOLIA_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("ARBITRUM_SEPOLIA_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("ARBITRUM_SEPOLIA_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Optimism Sepolia (chainId 11155420, OP Stack L2 testnet). Reads only `OPTIMISM_SEPOLIA_`-prefixed
    ///      env. Native = ETH (18 dec). Circle USDC (6 dec) + Chainlink ETH/USD + USDC/USD are all live
    ///      (verified against the Chainlink RDD + on-chain 2026-06-17). `treasury` required; rest skipped until set.
    function _optimismSepoliaConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("OPTIMISM_SEPOLIA_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("OPTIMISM_SEPOLIA_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("OPTIMISM_SEPOLIA_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("OPTIMISM_SEPOLIA_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("OPTIMISM_SEPOLIA_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("OPTIMISM_SEPOLIA_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("OPTIMISM_SEPOLIA_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("OPTIMISM_SEPOLIA_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Polygon Amoy (chainId 80002, PoS testnet). Reads only `POLYGON_AMOY_`-prefixed env. Native
    ///      = POL (18 dec). Circle USDC (6 dec) + Chainlink POL/USD + USDC/USD feeds exist on Amoy — fill
    ///      from Circle docs + docs.chain.link/data-feeds. `treasury` required; everything else optional
    ///      and skipped (address(0)) until confirmed, so a partial broadcast never wires a guess.
    function _polygonAmoyConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("POLYGON_AMOY_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("POLYGON_AMOY_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("POLYGON_AMOY_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("POLYGON_AMOY_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("POLYGON_AMOY_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("POLYGON_AMOY_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("POLYGON_AMOY_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("POLYGON_AMOY_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Avalanche Fuji (chainId 43113, C-Chain testnet). Reads only `AVALANCHE_FUJI_`-prefixed env.
    ///      Native = AVAX (18 dec). Circle USDC (6 dec) + Chainlink AVAX/USD + USDC/USD feeds exist on
    ///      Fuji. `treasury` required; feed/USDC addresses optional and skipped until confirmed.
    function _avalancheFujiConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("AVALANCHE_FUJI_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("AVALANCHE_FUJI_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("AVALANCHE_FUJI_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("AVALANCHE_FUJI_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("AVALANCHE_FUJI_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("AVALANCHE_FUJI_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("AVALANCHE_FUJI_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("AVALANCHE_FUJI_CRE_FORWARDER", address(0))
        });
    }

    /// @dev BNB Smart Chain testnet (chainId 97). Reads only `BNB_TESTNET_`-prefixed env. Native =
    ///      tBNB (18 dec). USDC + Chainlink BNB/USD + USDC/USD feeds exist on BSC testnet — confirm the
    ///      USDC address (peg-token vs Circle) from docs. `treasury` required; the rest skipped until set.
    function _bnbTestnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("BNB_TESTNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("BNB_TESTNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("BNB_TESTNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("BNB_TESTNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("BNB_TESTNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("BNB_TESTNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("BNB_TESTNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("BNB_TESTNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Scroll Sepolia (chainId 534351, zkEVM L2). Reads only `SCROLL_SEPOLIA_`-prefixed env. Native
    ///      = ETH (18 dec). USDC + Chainlink ETH/USD + USDC/USD feed availability are booth/docs confirms
    ///      — leave blank until verified. `treasury` required; anything unconfirmed is skipped, not wired.
    function _scrollSepoliaConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("SCROLL_SEPOLIA_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("SCROLL_SEPOLIA_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("SCROLL_SEPOLIA_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("SCROLL_SEPOLIA_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("SCROLL_SEPOLIA_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("SCROLL_SEPOLIA_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("SCROLL_SEPOLIA_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("SCROLL_SEPOLIA_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Linea Sepolia (chainId 59141, Consensys zkEVM L2). Reads only `LINEA_SEPOLIA_`-prefixed env.
    ///      Native = ETH (18 dec). USDC + Chainlink ETH/USD + USDC/USD feed availability are docs confirms
    ///      — leave blank until verified. `treasury` required; everything else optional/skipped.
    function _lineaSepoliaConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("LINEA_SEPOLIA_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("LINEA_SEPOLIA_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("LINEA_SEPOLIA_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("LINEA_SEPOLIA_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("LINEA_SEPOLIA_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("LINEA_SEPOLIA_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("LINEA_SEPOLIA_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("LINEA_SEPOLIA_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Mantle Sepolia (chainId 5003, OP-stack L2). Reads only `MANTLE_SEPOLIA_`-prefixed env. Native
    ///      = MNT (18 dec) — NOT ETH, so the native/USD feed is an MNT/USD feed; confirm it exists before
    ///      wiring. Verifier is Blockscout (no Etherscan key). USDC + feeds are confirms; `treasury` req.
    function _mantleSepoliaConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("MANTLE_SEPOLIA_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("MANTLE_SEPOLIA_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("MANTLE_SEPOLIA_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("MANTLE_SEPOLIA_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("MANTLE_SEPOLIA_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("MANTLE_SEPOLIA_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("MANTLE_SEPOLIA_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("MANTLE_SEPOLIA_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Blast Sepolia (chainId 168587773, OP-stack L2). Reads only `BLAST_SEPOLIA_`-prefixed env.
    ///      Native = ETH (18 dec). USDC + Chainlink ETH/USD + USDC/USD feed availability are confirms —
    ///      leave blank until verified. `treasury` required; unconfirmed addresses are skipped, not wired.
    function _blastSepoliaConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("BLAST_SEPOLIA_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("BLAST_SEPOLIA_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("BLAST_SEPOLIA_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("BLAST_SEPOLIA_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("BLAST_SEPOLIA_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("BLAST_SEPOLIA_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("BLAST_SEPOLIA_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("BLAST_SEPOLIA_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Unichain Sepolia (chainId 1301, OP-stack L2). Reads only `UNICHAIN_SEPOLIA_`-prefixed env.
    ///      Native = ETH (18 dec). USDC + Chainlink ETH/USD + USDC/USD feed availability are confirms —
    ///      leave blank until verified. `treasury` required; everything else optional/skipped.
    function _unichainSepoliaConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("UNICHAIN_SEPOLIA_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("UNICHAIN_SEPOLIA_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("UNICHAIN_SEPOLIA_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("UNICHAIN_SEPOLIA_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("UNICHAIN_SEPOLIA_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("UNICHAIN_SEPOLIA_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("UNICHAIN_SEPOLIA_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("UNICHAIN_SEPOLIA_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Robinhood Chain testnet (chainId 46630, Arbitrum Orbit L2). Reads only `ROBINHOOD_TESTNET_`-
    ///      prefixed env. Native = ETH (18 dec). Chainlink Data Feeds are NOT live here yet, so
    ///      `nativeUsdFeed`/`usdcUsdFeed` stay address(0) — DeployAll skips wiring them and same-chain USD
    ///      `quote()` is unavailable until a feed lands (NEVER invent a feed address). The CCIP selector
    ///      2032988798112970440 is registered, so the router deploys as a cross-chain LANE endpoint. No
    ///      confirmed ERC-20 USDC on the testnet yet — `usdc` stays blank. `treasury` required.
    function _robinhoodTestnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("ROBINHOOD_TESTNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("ROBINHOOD_TESTNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("ROBINHOOD_TESTNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("ROBINHOOD_TESTNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("ROBINHOOD_TESTNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("ROBINHOOD_TESTNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("ROBINHOOD_TESTNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("ROBINHOOD_TESTNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev 0G Galileo testnet (chainId 16602, 0G V3 testnet). Reads only `GALILEO_`-prefixed env. Native
    ///      gas token = 0G (18 dec) — NOT USDC, so there is no native-gas dollar peg and no native/USD
    ///      feed exists; `nativeUsdFeed` stays address(0), DeployAll skips wiring it, and same-chain native
    ///      `quote()` is unavailable (NEVER invent a 0G/USD feed). 0G has NO Chainlink Data Feeds at all,
    ///      so the USDC/USD feed must be a $1.00 MockV3Aggregator deployed FIRST (the Arc pattern:
    ///      `make deploy-usd-mock-feed RPC=$GALILEO_RPC_URL`, then set `GALILEO_USDC_USD_FEED`). The token
    ///      stays REAL ERC-20 USDC where one exists (the "no demo token" law holds — the mock is only the
    ///      missing PRICE feed); leave `GALILEO_USDC_ADDRESS` blank until confirmed. Blockscout verifier.
    ///      `treasury` required; everything else skipped (address(0)) until set.
    function _galileoTestnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("GALILEO_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("GALILEO_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("GALILEO_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("GALILEO_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("GALILEO_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("GALILEO_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("GALILEO_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("GALILEO_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Zora Sepolia (chainId 999999999, OP-stack L2). Reads only `ZORA_SEPOLIA_`-prefixed env.
    ///      Native = ETH (18 dec). Blockscout verifier. ETH/USD + USDC + USDC/USD feed availability are
    ///      docs confirms — leave blank until verified; `treasury` required, the rest skipped if unset.
    function _zoraSepoliaConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("ZORA_SEPOLIA_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("ZORA_SEPOLIA_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("ZORA_SEPOLIA_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("ZORA_SEPOLIA_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("ZORA_SEPOLIA_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("ZORA_SEPOLIA_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("ZORA_SEPOLIA_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("ZORA_SEPOLIA_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Filecoin Calibration (chainId 314159, FEVM testnet). Reads only `FILECOIN_CALIBRATION_`-
    ///      prefixed env. Native = tFIL (18 dec) — native/USD is a FIL/USD feed; confirm it exists.
    ///      Blockscout verifier. `treasury` required; USDC + feeds skipped (address(0)) until confirmed.
    function _filecoinCalibrationConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("FILECOIN_CALIBRATION_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("FILECOIN_CALIBRATION_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("FILECOIN_CALIBRATION_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("FILECOIN_CALIBRATION_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("FILECOIN_CALIBRATION_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("FILECOIN_CALIBRATION_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("FILECOIN_CALIBRATION_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("FILECOIN_CALIBRATION_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Gnosis Chiado (chainId 10200, testnet). Reads only `GNOSIS_CHIADO_`-prefixed env. Native =
    ///      XDAI (18 dec, ≈ $1) — native/USD is an XDAI/USD feed; confirm. Blockscout verifier. `treasury`
    ///      required; USDC + feeds skipped until confirmed, so a partial broadcast never wires a guess.
    function _gnosisChiadoConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("GNOSIS_CHIADO_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("GNOSIS_CHIADO_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("GNOSIS_CHIADO_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("GNOSIS_CHIADO_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("GNOSIS_CHIADO_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("GNOSIS_CHIADO_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("GNOSIS_CHIADO_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("GNOSIS_CHIADO_CRE_FORWARDER", address(0))
        });
    }

    /// @dev ApeChain Curtis (chainId 33111, Arbitrum-Orbit testnet). Reads only `APECHAIN_CURTIS_`-
    ///      prefixed env. Native = APE (18 dec) — native/USD is an APE/USD feed; confirm. Blockscout
    ///      verifier. `treasury` required; USDC + feeds skipped (address(0)) until confirmed.
    function _apechainCurtisConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("APECHAIN_CURTIS_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("APECHAIN_CURTIS_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("APECHAIN_CURTIS_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("APECHAIN_CURTIS_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("APECHAIN_CURTIS_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("APECHAIN_CURTIS_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("APECHAIN_CURTIS_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("APECHAIN_CURTIS_CRE_FORWARDER", address(0))
        });
    }

    /// @dev World Chain Sepolia (chainId 4801, OP-stack L2). Reads only `WORLDCHAIN_SEPOLIA_`-prefixed
    ///      env. Native = ETH (18 dec) — NOT WLD as gas (CONFIRM 4801 + RPC at the World docs). Worldscan
    ///      (etherscan-family) verifier. `treasury` required; USDC + feeds skipped until confirmed.
    function _worldchainSepoliaConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("WORLDCHAIN_SEPOLIA_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("WORLDCHAIN_SEPOLIA_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("WORLDCHAIN_SEPOLIA_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("WORLDCHAIN_SEPOLIA_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("WORLDCHAIN_SEPOLIA_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("WORLDCHAIN_SEPOLIA_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("WORLDCHAIN_SEPOLIA_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("WORLDCHAIN_SEPOLIA_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Zircuit Garfield (chainId 48898, testnet). Reads only `ZIRCUIT_GARFIELD_`-prefixed env.
    ///      Native = ETH (18 dec). Sourcify verifier (no API key / URL). `treasury` required; USDC +
    ///      ETH/USD + USDC/USD feeds are docs confirms, skipped (address(0)) until verified.
    function _zircuitGarfieldConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("ZIRCUIT_GARFIELD_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("ZIRCUIT_GARFIELD_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("ZIRCUIT_GARFIELD_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("ZIRCUIT_GARFIELD_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("ZIRCUIT_GARFIELD_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("ZIRCUIT_GARFIELD_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("ZIRCUIT_GARFIELD_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("ZIRCUIT_GARFIELD_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Citrea testnet (chainId 5115, Bitcoin zk-rollup). Reads only `CITREA_TESTNET_`-prefixed env.
    ///      Native = cBTC (18 dec, ≈ BTC) — native/USD is a BTC/USD feed; confirm. Blockscout verifier.
    ///      `treasury` required; USDC + feeds skipped (address(0)) until confirmed.
    function _citreaTestnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("CITREA_TESTNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("CITREA_TESTNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("CITREA_TESTNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("CITREA_TESTNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("CITREA_TESTNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("CITREA_TESTNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("CITREA_TESTNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("CITREA_TESTNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Flow EVM testnet (chainId 545). Reads only `FLOW_EVM_TESTNET_`-prefixed env. Native = FLOW
    ///      (18 dec) — native/USD is a FLOW/USD feed; confirm. Blockscout verifier. `treasury` required;
    ///      USDC + feeds skipped (address(0)) until confirmed.
    function _flowEvmTestnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("FLOW_EVM_TESTNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("FLOW_EVM_TESTNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("FLOW_EVM_TESTNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("FLOW_EVM_TESTNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("FLOW_EVM_TESTNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("FLOW_EVM_TESTNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("FLOW_EVM_TESTNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("FLOW_EVM_TESTNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Celo Sepolia (chainId 11142220, testnet). Reads only `CELO_SEPOLIA_`-prefixed env. Native =
    ///      CELO (18 dec) — native/USD is a CELO/USD feed; confirm. Celoscan (etherscan-v2) verifier.
    ///      `treasury` required; USDC + feeds skipped (address(0)) until confirmed.
    function _celoSepoliaConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("CELO_SEPOLIA_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("CELO_SEPOLIA_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("CELO_SEPOLIA_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("CELO_SEPOLIA_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("CELO_SEPOLIA_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("CELO_SEPOLIA_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("CELO_SEPOLIA_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("CELO_SEPOLIA_CRE_FORWARDER", address(0))
        });
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // MAINNET config helpers — AUDIT-GATED, NOT DEPLOYED.
    //
    // Each helper mirrors its testnet twin exactly: it reads ONLY its `<CHAIN>_MAINNET_`-prefixed env,
    // requires `<CHAIN>_MAINNET_PLATFORM_TREASURY` (fails loud via `vm.envAddress` ONLY when that branch
    // is actually selected on the live chain), and resolves every feed/USDC/registry/forwarder address
    // from env with an address(0) default. address(0) ⇒ DeployAll SKIPS that configure call, so an
    // unconfirmed (or deliberately blank, pre-audit) value is never wired. NOTHING here is hardcoded:
    // a guessed real mainnet USDC/feed address would imply a deployment this repo has NOT made and is
    // forbidden (law #4). The `make deploy-<chain>-mainnet` targets that reach these branches are all
    // banner-gated "do not run until a third-party audit is complete".
    // ─────────────────────────────────────────────────────────────────────────────────────────────

    /// @dev Ethereum mainnet (chainId 1). AUDIT-GATED, NOT DEPLOYED. Reads only `ETHEREUM_MAINNET_`-
    ///      prefixed env. Native = ETH (18 dec). Fill ETH/USD + Circle USDC + USDC/USD from the canonical
    ///      docs ONLY after audit; blank ⇒ skipped, never a guessed address.
    function _ethereumMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("ETHEREUM_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("ETHEREUM_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("ETHEREUM_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("ETHEREUM_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("ETHEREUM_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("ETHEREUM_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("ETHEREUM_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("ETHEREUM_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Base mainnet (chainId 8453, Coinbase L2). AUDIT-GATED, NOT DEPLOYED. Reads only
    ///      `BASE_MAINNET_`-prefixed env. Native = ETH (18 dec). Addresses post-audit only; blank ⇒ skipped.
    function _baseMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("BASE_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("BASE_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("BASE_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("BASE_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("BASE_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("BASE_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("BASE_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("BASE_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Arbitrum One (chainId 42161). AUDIT-GATED, NOT DEPLOYED. Reads only `ARBITRUM_MAINNET_`-
    ///      prefixed env. Native = ETH (18 dec). Addresses post-audit only; blank ⇒ skipped.
    function _arbitrumMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("ARBITRUM_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("ARBITRUM_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("ARBITRUM_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("ARBITRUM_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("ARBITRUM_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("ARBITRUM_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("ARBITRUM_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("ARBITRUM_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Optimism mainnet (OP Mainnet, chainId 10). AUDIT-GATED, NOT DEPLOYED. Reads only
    ///      `OPTIMISM_MAINNET_`-prefixed env. Native = ETH (18 dec). Addresses post-audit only; blank ⇒ skipped.
    function _optimismMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("OPTIMISM_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("OPTIMISM_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("OPTIMISM_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("OPTIMISM_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("OPTIMISM_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("OPTIMISM_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("OPTIMISM_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("OPTIMISM_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Polygon mainnet (PoS, chainId 137). AUDIT-GATED, NOT DEPLOYED. Reads only `POLYGON_MAINNET_`-
    ///      prefixed env. Native = POL (18 dec) — native/USD is a POL/USD feed. Addresses post-audit only.
    function _polygonMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("POLYGON_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("POLYGON_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("POLYGON_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("POLYGON_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("POLYGON_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("POLYGON_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("POLYGON_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("POLYGON_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Avalanche C-Chain mainnet (chainId 43114). AUDIT-GATED, NOT DEPLOYED. Reads only
    ///      `AVALANCHE_MAINNET_`-prefixed env. Native = AVAX (18 dec). Addresses post-audit only; blank ⇒ skipped.
    function _avalancheMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("AVALANCHE_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("AVALANCHE_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("AVALANCHE_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("AVALANCHE_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("AVALANCHE_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("AVALANCHE_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("AVALANCHE_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("AVALANCHE_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev BNB Smart Chain mainnet (chainId 56). AUDIT-GATED, NOT DEPLOYED. Reads only `BNB_MAINNET_`-
    ///      prefixed env. Native = BNB (18 dec). USDC may be a peg-token vs Circle — confirm post-audit.
    function _bnbMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("BNB_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("BNB_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("BNB_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("BNB_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("BNB_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("BNB_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("BNB_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("BNB_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Scroll mainnet (zkEVM L2, chainId 534352). AUDIT-GATED, NOT DEPLOYED. Reads only
    ///      `SCROLL_MAINNET_`-prefixed env. Native = ETH (18 dec). Addresses post-audit only; blank ⇒ skipped.
    function _scrollMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("SCROLL_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("SCROLL_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("SCROLL_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("SCROLL_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("SCROLL_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("SCROLL_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("SCROLL_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("SCROLL_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Linea mainnet (Consensys zkEVM, chainId 59144). AUDIT-GATED, NOT DEPLOYED. Reads only
    ///      `LINEA_MAINNET_`-prefixed env. Native = ETH (18 dec). Addresses post-audit only; blank ⇒ skipped.
    function _lineaMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("LINEA_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("LINEA_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("LINEA_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("LINEA_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("LINEA_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("LINEA_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("LINEA_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("LINEA_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Mantle mainnet (OP-stack L2, chainId 5000). AUDIT-GATED, NOT DEPLOYED. Reads only
    ///      `MANTLE_MAINNET_`-prefixed env. Native = MNT (18 dec) — native/USD is an MNT/USD feed.
    ///      Verifier is Blockscout. Addresses post-audit only; blank ⇒ skipped.
    function _mantleMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("MANTLE_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("MANTLE_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("MANTLE_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("MANTLE_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("MANTLE_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("MANTLE_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("MANTLE_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("MANTLE_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Blast mainnet (OP-stack L2, chainId 81457). AUDIT-GATED, NOT DEPLOYED. Reads only
    ///      `BLAST_MAINNET_`-prefixed env. Native = ETH (18 dec). Addresses post-audit only; blank ⇒ skipped.
    function _blastMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("BLAST_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("BLAST_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("BLAST_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("BLAST_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("BLAST_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("BLAST_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("BLAST_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("BLAST_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Unichain mainnet (OP-stack L2, chainId 130). AUDIT-GATED, NOT DEPLOYED. Reads only
    ///      `UNICHAIN_MAINNET_`-prefixed env. Native = ETH (18 dec). Addresses post-audit only; blank ⇒ skipped.
    function _unichainMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("UNICHAIN_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("UNICHAIN_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("UNICHAIN_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("UNICHAIN_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("UNICHAIN_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("UNICHAIN_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("UNICHAIN_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("UNICHAIN_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev zkSync Era mainnet (ZK Stack, chainId 324). AUDIT-GATED, NOT DEPLOYED. Reads only
    ///      `ZKSYNC_MAINNET_`-prefixed env. Native = ETH (18 dec). Broadcast needs the `--zksync` flag +
    ///      foundry-zksync (EVM-green != zkSync-green). Addresses post-audit only; blank ⇒ skipped.
    function _zkSyncMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("ZKSYNC_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("ZKSYNC_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("ZKSYNC_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("ZKSYNC_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("ZKSYNC_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("ZKSYNC_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("ZKSYNC_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("ZKSYNC_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Zora mainnet (OP-stack L2, chainId 7777777). AUDIT-GATED, NOT DEPLOYED. Reads only
    ///      `ZORA_MAINNET_`-prefixed env. Native = ETH (18 dec). Addresses post-audit only; blank ⇒ skipped.
    function _zoraMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("ZORA_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("ZORA_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("ZORA_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("ZORA_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("ZORA_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("ZORA_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("ZORA_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("ZORA_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Filecoin mainnet (FEVM, chainId 314). AUDIT-GATED, NOT DEPLOYED. Reads only `FILECOIN_MAINNET_`-
    ///      prefixed env. Native = FIL (18 dec) — native/USD is a FIL/USD feed. Addresses post-audit only.
    function _filecoinMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("FILECOIN_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("FILECOIN_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("FILECOIN_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("FILECOIN_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("FILECOIN_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("FILECOIN_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("FILECOIN_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("FILECOIN_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Gnosis Chain (chainId 100). AUDIT-GATED, NOT DEPLOYED. Reads only `GNOSIS_MAINNET_`-prefixed
    ///      env. Native = XDAI (18 dec, ≈ $1) — native/USD is an XDAI/USD feed. Addresses post-audit only.
    function _gnosisMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("GNOSIS_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("GNOSIS_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("GNOSIS_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("GNOSIS_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("GNOSIS_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("GNOSIS_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("GNOSIS_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("GNOSIS_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev ApeChain (Arbitrum-Orbit, chainId 33139). AUDIT-GATED, NOT DEPLOYED. Reads only
    ///      `APECHAIN_MAINNET_`-prefixed env. Native = APE (18 dec) — native/USD is an APE/USD feed.
    function _apechainMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("APECHAIN_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("APECHAIN_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("APECHAIN_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("APECHAIN_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("APECHAIN_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("APECHAIN_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("APECHAIN_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("APECHAIN_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev World Chain (OP-stack L2, chainId 480). AUDIT-GATED, NOT DEPLOYED. Reads only
    ///      `WORLDCHAIN_MAINNET_`-prefixed env. Native = ETH (18 dec). Addresses post-audit only; blank ⇒ skipped.
    function _worldchainMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("WORLDCHAIN_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("WORLDCHAIN_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("WORLDCHAIN_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("WORLDCHAIN_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("WORLDCHAIN_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("WORLDCHAIN_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("WORLDCHAIN_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("WORLDCHAIN_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Zircuit mainnet (chainId 48900). AUDIT-GATED, NOT DEPLOYED. Reads only `ZIRCUIT_MAINNET_`-
    ///      prefixed env. Native = ETH (18 dec). Sourcify verifier. Addresses post-audit only; blank ⇒ skipped.
    function _zircuitMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("ZIRCUIT_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("ZIRCUIT_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("ZIRCUIT_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("ZIRCUIT_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("ZIRCUIT_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("ZIRCUIT_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("ZIRCUIT_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("ZIRCUIT_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Citrea mainnet (Bitcoin zk-rollup, chainId 4114). AUDIT-GATED, NOT DEPLOYED. Reads only
    ///      `CITREA_MAINNET_`-prefixed env. Native = cBTC (18 dec, ≈ BTC) — native/USD is a BTC/USD feed.
    function _citreaMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("CITREA_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("CITREA_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("CITREA_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("CITREA_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("CITREA_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("CITREA_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("CITREA_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("CITREA_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Flow EVM mainnet (chainId 747). AUDIT-GATED, NOT DEPLOYED. Reads only `FLOW_EVM_MAINNET_`-
    ///      prefixed env. Native = FLOW (18 dec) — native/USD is a FLOW/USD feed. Addresses post-audit only.
    function _flowEvmMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("FLOW_EVM_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("FLOW_EVM_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("FLOW_EVM_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("FLOW_EVM_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("FLOW_EVM_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("FLOW_EVM_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("FLOW_EVM_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("FLOW_EVM_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Celo mainnet (chainId 42220). AUDIT-GATED, NOT DEPLOYED. Reads only `CELO_MAINNET_`-prefixed
    ///      env. Native = CELO (18 dec) — native/USD is a CELO/USD feed. Addresses post-audit only.
    function _celoMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("CELO_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("CELO_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("CELO_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("CELO_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("CELO_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("CELO_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("CELO_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("CELO_MAINNET_CRE_FORWARDER", address(0))
        });
    }

    /// @dev Arc MAINNET — NOT launched, id is TBD, AUDIT-GATED, NOT DEPLOYED. Reachable only when the
    ///      operator sets a real `ARC_MAINNET_CHAIN_ID` (see `_isArcMainnet`). Reads only `ARC_MAINNET_`-
    ///      prefixed env. Arc trap carries over: native USDC is 18-dec while an ERC-20 USDC (if any) is
    ///      6-dec — never hardcode either; confirm both post-launch + post-audit. Addresses default to
    ///      address(0) ⇒ skipped, never a guess.
    function _arcMainnetConfig() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("ARC_MAINNET_PLATFORM_TREASURY"),
            platformFeeBps: uint16(
                vm.envOr("ARC_MAINNET_PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))
            ),
            nativeUsdFeed: vm.envOr("ARC_MAINNET_NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("ARC_MAINNET_USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("ARC_MAINNET_USDC_USD_FEED", address(0)),
            chainRegistry: vm.envOr("ARC_MAINNET_CHAIN_REGISTRY", address(0)),
            graceFailThreshold: uint16(
                vm.envOr("ARC_MAINNET_SUBS_GRACE_FAILS", uint256(DEFAULT_SUBS_GRACE_FAILS))
            ),
            creForwarder: vm.envOr("ARC_MAINNET_CRE_FORWARDER", address(0))
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
        // UUPS: deploy the registry impl, then an ERC1967 proxy that runs `initialize(msg.sender)` in
        // the same broadcast block, so the local deployment owns a fully initialized registry (state in the
        // proxy, logic in the impl); the impl ran `_disableInitializers()` in its constructor.
        address chainRegistryImpl = address(new ChainRegistry());
        ChainRegistry chainRegistry = ChainRegistry(
            address(
                new ERC1967Proxy(
                    chainRegistryImpl, abi.encodeCall(ChainRegistry.initialize, (msg.sender))
                )
            )
        );
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
