# 0G Chain — vendored reference

> ⚠️ Vendored snapshot compiled **2026-07-22** from the open-source 0G docs (`github.com/0glabs/0g-doc`, `main` branch, fetched via `raw.githubusercontent.com` because `docs.0g.ai` is Cloudflare-gated). Chain params, RPC URLs, and addresses are copied verbatim. ⚠️ = verify against live docs before relying on it; testnet values are explicitly marked "may change" by the source.

## Sources

- `0glabs/0g-doc` — `docs/concepts/chain.md` (chain architecture)
- `0glabs/0g-doc` — `docs/developer-hub/getting-started.md` (services overview)
- `0glabs/0g-doc` — `docs/developer-hub/testnet/testnet-overview.md` (Galileo testnet)
- `0glabs/0g-doc` — `docs/developer-hub/mainnet/mainnet-overview.md` (mainnet)
- `0glabs/0g-doc` — `docs/developer-hub/building-on-0g/contracts-on-0g/deploy-contracts.md` (deploy guide)
- `0glabs/0g-doc` — `docs/developer-hub/building-on-0g/contracts-on-0g/precompiles/{overview,dasigners,wrappedogbase}.md`
- Live docs portal: <https://docs.0g.ai>

---

## 1. Chain overview

**0G Chain** is an EVM-compatible Layer 1 blockchain purpose-built for AI workloads. The project (0G / "Zero Gravity") bills itself as a decentralized AI operating system; 0G Chain is the settlement/execution layer that ties together the rest of the 0G modular stack: **0G Storage**, **0G DA** (data availability), and **0G Compute** (a decentralized GPU marketplace).

Full EVM compatibility is a headline claim: existing Solidity/Ethereum code is said to deploy without changes, and standard tooling (Hardhat, Foundry, Remix) works as on any EVM chain.

### Modular architecture (consensus/execution separation)

Per `concepts/chain.md`, 0G Chain separates **consensus** from **execution**:

- **Consensus Layer** — validator coordination, block production, security/finality.
- **Execution Layer** — state management, smart-contract execution, EVM compatibility.

Benefits claimed: independent upgradability (execution layer can adopt new EVM features like EIP-4844, account abstraction, new opcodes without touching consensus), focused optimization, and faster iteration.

### Consensus & throughput claims

- Consensus is an **optimized CometBFT** (formerly Tendermint), with tuned block-production intervals and timeouts.
- **11,000 TPS per shard** (stated as current throughput). ⚠️ Marketing/spec figure; verify.
- **Sub-second finality** ("near-instant" confirmation).
- Validator system: PoS — validators stake 0G tokens; CometBFT Byzantine fault tolerance; **VRF** (Verifiable Random Function) for validator selection. Rewards from block production, transaction fees, and staking yield.

### Scaling roadmap (stated as forward-looking)

- **DAG-based consensus** (Directed Acyclic Graph) for parallel transaction processing.
- **Shared security / shared staking** — validators securing multiple services simultaneously.

### How it relates to Storage / DA / Compute

0G markets a "modular infrastructure" where each service is usable independently:

| Service | Role | Key docs entry points |
|---|---|---|
| **0G Chain** | EVM L1 for AI; smart contracts + precompiles | `/concepts/chain`, deploy-contracts |
| **0G Storage** | High-performance storage for large (TB-scale) datasets | Storage SDK / CLI |
| **0G DA** | Scalable data availability for any chain / rollups | DA integration, DASigners precompile |
| **0G Compute** | Decentralized GPU marketplace for AI inference | Compute router / provider |

0G's positioning ("Building on 0G"): services can be added to any EVM chain (Ethereum, Polygon, BNB, Arbitrum), non-EVM chains (Solana, Near, Cosmos), or Web2 apps without migration.

---

## 2. Galileo testnet

Source: `docs/developer-hub/testnet/testnet-overview.md`.

### Network details (verbatim from docs)

| Parameter | Value |
|---|---|
| **Network Name** | 0G Galileo Testnet |
| **Chain ID** | **16602** |
| **Token Symbol** | **0G** |
| **Native currency decimals** | 18 (from the docs' Add-to-MetaMask component) |
| **Block Explorer** | `https://chainscan-galileo.0g.ai` |
| **Faucet** | `https://faucet.0g.ai` |
| **Faucet (Google Cloud)** | `https://cloud.google.com/application/web3/faucet/0g/galileo` |

> **Chain ID note:** The **current** Galileo chain ID is **16602**. The **old** chain ID was **16601** — still visible in some third-party URL slugs (e.g. ThirdWeb's `0g-galileo-testnet-16601`). Configure wallets/tooling with **16602**.

> **Token symbol note:** The docs consistently write the native gas token as **`0G`** (zero-G), not `OG`. The task brief referenced `OG`; treat `0G` as authoritative per current docs. ⚠️ Verify against live docs if the exact symbol string matters for your integration.

### RPC endpoints

- **Development RPC (docs, "development only — not for production"):** `https://evmrpc-testnet.0g.ai`
- **3rd-party RPCs (recommended for production):**
  - QuickNode — <https://www.quicknode.com/chains/0g>
  - ThirdWeb — <https://thirdweb.com/0g-galileo-testnet-16601>
  - Ankr — <https://www.ankr.com/rpc/0g/>
  - dRPC NodeCloud — <https://drpc.org/chainlist/0g-galileo-testnet-rpc>

### Explorers

- **Chain Explorer:** `https://chainscan-galileo.0g.ai` — transactions, blocks, contracts
- **Storage Explorer:** `https://storagescan-galileo.0g.ai` — storage operations/metrics
- **Unified activity explorer:** `https://explorer.0g.ai/testnet/home`

### Faucet

- Official faucet `https://faucet.0g.ai` or Google Cloud faucet `https://cloud.google.com/application/web3/faucet/0g/galileo`.
- **Daily limit: 0.1 0G per wallet** (docs say sufficient for most testing). For more, request in the [0G Discord](https://discord.com/invite/0glabs).

### Published contract addresses (testnet)

> ⚠️ The docs carry a caution: **"Addresses may change during testnet."**

**0G Storage**
- Flow: `0x22E03a6A89B950F1c82ec5e74F8eCa321a105296`
- Mine: `0x00A9E9604b0538e06b268Fb297Df333337f9593b`
- Reward: `0xA97B57b4BdFEA2D0a25e535bd849ad4e6C440A69`

**0G DA**
- DAEntrance: `0xE75A073dA5bb7b0eC622170Fd268f35E675a957B`

**Precompiles (fixed addresses; see §3):**
- DASigners: `0x0000000000000000000000000000000000001000`
- Wrapped0GBase: `0x0000000000000000000000000000000000001002`
- Wrapped 0G (W0G) ERC20 token: `0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c`

### USDC / stablecoin / standard token addresses

**NONE published.** The 0G docs do **not** list any USDC, stablecoin, or canonical ERC-20 token address for the Galileo testnet. The only addresses in the testnet reference are the 0G Storage / 0G DA system contracts and the precompile addresses above. Do not assume or invent a testnet USDC address — verify on-chain or via the block explorer if you need one.

---

## 3. Deploying contracts on 0G Chain

Source: `docs/developer-hub/building-on-0g/contracts-on-0g/deploy-contracts.md`. 0G Chain is treated as a standard EVM chain — deploy exactly as you would on Ethereum.

### Stated benefits / EVM support

- **11,000 TPS per shard**, low fees, sub-second finality (repeated marketing claims).
- **EVM upgrade support:** "Pectra & Cancun-Deneb Support." The docs recommend compiling with **`--evm-version cancun`**.
- Tooling: Hardhat, Foundry, Remix, Truffle.

### Prerequisites

- Node.js 16+ (Hardhat/Truffle)
- Rust (Foundry)
- A wallet funded with testnet 0G ([faucet](https://faucet.0g.ai))
- Basic Solidity knowledge

### Step 1 — Example contract

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract MyToken {
    mapping(address => uint256) public balances;
    uint256 public totalSupply;

    constructor(uint256 _initialSupply) {
        totalSupply = _initialSupply;
        balances[msg.sender] = _initialSupply;
    }

    function transfer(address to, uint256 amount) public returns (bool) {
        require(balances[msg.sender] >= amount, "Insufficient balance");
        balances[msg.sender] -= amount;
        balances[to] += amount;
        return true;
    }
}
```

### Step 2 — Compile (target `cancun`)

**solc directly:**
```bash
solc --evm-version cancun --bin --abi MyToken.sol
```

**Hardhat (`hardhat.config.js`):**
```javascript
module.exports = {
  solidity: {
    version: "0.8.19",
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
    },
  },
};
```

**Foundry (`foundry.toml`):**
```toml
[profile.default]
evm_version = "cancun"
```

### Step 3 — Network configuration

**Hardhat:**
```javascript
networks: {
  "testnet": {
    url: "https://evmrpc-testnet.0g.ai",
    chainId: 16602,
    accounts: [process.env.PRIVATE_KEY]
  },
  "mainnet": {
    url: "https://evmrpc.0g.ai",
    chainId: 16661,
    accounts: [process.env.PRIVATE_KEY]
  }
}
```

**Foundry:**
```toml
[rpc_endpoints]
0g_testnet = "https://evmrpc-testnet.0g.ai"
0g_mainnet = "https://evmrpc.0g.ai"
```

### Deploy commands

**Hardhat** (`scripts/deploy.js`):
```javascript
async function main() {
  const MyToken = await ethers.getContractFactory("MyToken");
  const token = await MyToken.deploy(1000000); // 1M initial supply
  await token.deployed();
  console.log("Token deployed to:", token.address);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
```
```bash
npx hardhat run scripts/deploy.js --network 0g-testnet
```

**Foundry:**
```bash
forge create --rpc-url https://evmrpc-testnet.0g.ai \
  --private-key $PRIVATE_KEY \
  --evm-version cancun \
  src/MyToken.sol:MyToken \
  --constructor-args 1000000
```

**Truffle** (`migrations/2_deploy_token.js`):
```javascript
module.exports = function (deployer) {
  deployer.deploy(MyToken, 1000000);
};
```
```bash
truffle migrate --network 0g-testnet
```

> Official worked examples: **0G Deployment Scripts** — <https://github.com/0gfoundation/0g-deployment-scripts>
> (⚠️ The docs link `0gfoundation/0g-deployment-scripts`; some search results reference `0glabs/0g-deployment-scripts`. Verify the correct org before cloning.)

### Step 4 — Contract verification (0G Chain Scan)

**Hardhat** — install `@nomicfoundation/hardhat-verify` (+ viem toolbox, dotenv). Recommended compiler settings include `evmVersion: "cancun"`, optimizer runs 200, `viaIR: true` (if inline assembly), `metadata.bytecodeHash: "none"`.

Etherscan-style config with custom chains:
```javascript
etherscan: {
  apiKey: {
    testnet: "YOUR_API_KEY", // placeholder OK
    mainnet: "YOUR_API_KEY"
  },
  customChains: [
    {
      network: "testnet",
      chainId: 16602,
      urls: {
        apiURL: "https://chainscan-galileo.0g.ai/open/api",
        browserURL: "https://chainscan-galileo.0g.ai",
      },
    },
    {
      network: "mainnet",
      chainId: 16661,
      urls: {
        apiURL: "https://chainscan.0g.ai/open/api",
        browserURL: "https://chainscan.0g.ai",
      },
    },
  ],
}
```
```bash
npx hardhat verify DEPLOYED_CONTRACT_ADDRESS --network <Network>
```

**Foundry (`forge verify-contract`)** — verifier API URLs:

| Network | Verifier URL |
|---|---|
| Testnet | `https://chainscan-galileo.0g.ai/open/api` |
| Mainnet | `https://chainscan.0g.ai/open/api` |

```bash
forge verify-contract \
  --chain-id <CHAIN_ID> \
  --num-of-optimizations <NUM_OPTIMIZATIONS> \
  --verifier custom \
  --verifier-api-key "PLACEHOLDER" \
  --compiler-version <COMPILER_VERSION> \
  <CONTRACT_ADDRESS> \
  src/Counter.sol:Counter \
  --verifier-url <VERIFIER_URL>
```

### 0G-specific precompiles & gotchas

0G Chain adds specialized precompiles (native contracts at fixed addresses, ~10–100x cheaper than Solidity equivalents) beyond standard Ethereum precompiles:

| Precompile | Address | Purpose |
|---|---|---|
| **DASigners** | `0x0000000000000000000000000000000000001000` | Data-availability signatures (wraps the `x/dasigners` chain module) |
| **Wrapped0GBase** | `0x0000000000000000000000000000000000001002` | Wrapped native 0G token / DeFi (wraps `x/wrapped-og-base`) |
| Staking | `0x0000000000000000000000000000000000001001` | ⚠️ Referenced but **commented out / not yet released** in docs — treat as unconfirmed |

**DASigners** (`0x…1000`) — read/query the `x/dasigners` module from EVM: `epochNumber()`, `quorumCount(epoch)`, `isSigner(addr)`, `getSigner(addr[])`, `getQuorum(epoch, quorumId)`, `getQuorumRow(...)`, `getAggPkG1(...)`, `params()`, plus state-changing `registerSigner(...)`, `registerNextEpoch(...)`, `updateSocket(...)`. Uses BN254 G1/G2 points. Common use: verifying data availability on-chain.

**Wrapped0GBase** (`0x…1002`) — quota-based mint/burn of native 0G behind an ERC20 wrapper (W0G). Functions: `getWA0GI()`, `minterSupply(minter)`, `mint(minter, amount)`, `burn(minter, amount)` — mint/burn restricted to the W0G contract; quotas set by governance. The **W0G ERC20 token** for direct transfers/approvals is at `0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c`.

**Gotchas:**
- **"invalid opcode" errors** — if using experimental opcodes from unreleased Ethereum upgrades, compile with `--evm-version cancun` or downgrade the Solidity compiler (e.g. 0.8.26 → 0.8.19).
- **RPC connection issues** — fall back to a 3rd-party RPC (QuickNode / ThirdWeb / Ankr / dRPC).

---

## 4. Mainnet params

Source: `docs/developer-hub/mainnet/mainnet-overview.md`. The mainnet is referred to elsewhere as **"0G Aristotle"** (e.g. ThirdWeb `0g-aristotle`); the docs table simply calls it "0G Mainnet."

| Parameter | Value |
|---|---|
| **Network Name** | 0G Mainnet |
| **Chain ID** | **16661** |
| **Token Symbol** | **0G** |
| **Native currency decimals** | 18 (from docs' Add-to-MetaMask component) |
| **RPC URL** | `https://evmrpc.0g.ai` |
| **Storage Indexer** | `https://indexer-storage-turbo.0g.ai` |
| **Block Explorer** | `https://chainscan.0g.ai` |
| **Unified explorer** | `https://explorer.0g.ai/mainnet/home` |
| **Verifier API** | `https://chainscan.0g.ai/open/api` |

**3rd-party RPCs (production):** QuickNode <https://www.quicknode.com/chains/0g>, ThirdWeb <https://thirdweb.com/0g-aristotle>, Ankr <https://www.ankr.com/rpc/0g/>.

**Contract addresses — 0G Storage (mainnet):**
- Flow: `0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526`
- Mine: `0xCd01c5Cd953971CE4C2c9bFb95610236a7F414fe`
- Reward: `0x457aC76B58ffcDc118AABD6DbC63ff9072880870`

> ⚠️ The docs' mainnet page lists only the 0G Storage contracts. No DA Entrance, USDC/stablecoin, or other token addresses are published for mainnet in this doc — verify separately if needed. Precompile addresses (`0x…1000`, `0x…1002`) are chain-level and apply on mainnet as well, but confirm against live docs.

---

## 5. Wallet setup (MetaMask "Add network")

The docs provide "Add to MetaMask" / "Add to OKX" buttons rather than a manual parameter table; the values below are the exact params those components pass, suitable for manual entry under **MetaMask → Settings → Networks → Add network manually**.

> Testnet note from docs: **Remove any old 0G testnet configuration (e.g. the deprecated "Newton" testnet / chain ID 16601) before adding Galileo (16602)** to avoid conflicts.

### Galileo Testnet

| Field | Value |
|---|---|
| Network Name | 0G Galileo Testnet |
| New RPC URL | `https://evmrpc-testnet.0g.ai` |
| Chain ID | `16602` |
| Currency Symbol | `0G` |
| Decimals | `18` |
| Block Explorer URL | `https://chainscan-galileo.0g.ai` |

### Mainnet (0G / "Aristotle")

| Field | Value |
|---|---|
| Network Name | 0G Mainnet |
| New RPC URL | `https://evmrpc.0g.ai` |
| Chain ID | `16661` |
| Currency Symbol | `0G` |
| Decimals | `18` |
| Block Explorer URL | `https://chainscan.0g.ai` |

(These decimals/symbol values come from the docs' MetaMask button props: `tokenName="0G"`, `tokenSymbol="0G"`, `tokenDecimals={18}`.)

---

## Quick-reference summary

| | Galileo Testnet | Mainnet |
|---|---|---|
| Chain ID | **16602** (old: 16601) | **16661** |
| Symbol / decimals | 0G / 18 | 0G / 18 |
| RPC (official) | `https://evmrpc-testnet.0g.ai` (dev only) | `https://evmrpc.0g.ai` |
| Explorer | `https://chainscan-galileo.0g.ai` | `https://chainscan.0g.ai` |
| Verifier API | `https://chainscan-galileo.0g.ai/open/api` | `https://chainscan.0g.ai/open/api` |
| Faucet | `https://faucet.0g.ai` (0.1 0G/day) + GCP faucet | — |
| Storage Flow | `0x22E03a6A89B950F1c82ec5e74F8eCa321a105296` | `0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526` |
| Storage Mine | `0x00A9E9604b0538e06b268Fb297Df333337f9593b` | `0xCd01c5Cd953971CE4C2c9bFb95610236a7F414fe` |
| Storage Reward | `0xA97B57b4BdFEA2D0a25e535bd849ad4e6C440A69` | `0x457aC76B58ffcDc118AABD6DbC63ff9072880870` |
| DA Entrance | `0xE75A073dA5bb7b0eC622170Fd268f35E675a957B` | ⚠️ not published in mainnet doc |
| DASigners precompile | `0x0000000000000000000000000000000000001000` | same |
| Wrapped0GBase precompile | `0x0000000000000000000000000000000000001002` | same |
| W0G ERC20 token | `0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c` | ⚠️ verify per-network |
| USDC / stablecoin | **NONE published** | **NONE published** |
