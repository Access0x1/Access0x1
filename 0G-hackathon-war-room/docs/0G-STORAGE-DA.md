# 0G Storage & DA — vendored reference

> Compiled 2026-07-22 from the open-source 0G docs (github.com/0glabs/0g-doc) and SDK/node repos, fetched via `raw.githubusercontent.com` because docs.0g.ai is Cloudflare-gated. Lines marked ⚠️ should be re-verified against the live docs at https://docs.0g.ai before relying on them. Contract addresses and endpoints are copied verbatim from source and can change (testnet especially).

---

## 0. Source map

| Topic | Source (raw) |
|---|---|
| Storage concept | `https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/concepts/storage.md` |
| DA concept | `https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/concepts/da.md` |
| Storage SDK (Go + TS) | `https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/developer-hub/building-on-0g/storage/sdk.md` |
| DA integration (client/encoder/retriever) | `https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/developer-hub/building-on-0g/da-integration.md` |
| DA technical deep dive | `https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/developer-hub/building-on-0g/da-deep-dive.md` |
| Testnet overview | `https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/developer-hub/testnet/testnet-overview.md` |
| Mainnet overview | `https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/developer-hub/mainnet/mainnet-overview.md` |
| Log-system design | `https://raw.githubusercontent.com/0glabs/0g-storage-node/main/docs/log-system.md` |
| TS SDK repo README | `https://raw.githubusercontent.com/0glabs/0g-ts-sdk/main/README.md` |
| npm (current) | `https://www.npmjs.com/package/@0gfoundation/0g-storage-ts-sdk` |
| npm (legacy) | `https://www.npmjs.com/package/@0glabs/0g-ts-sdk` |

> ⚠️ **Org/package rename note.** The project has migrated from the `0glabs` GitHub org and the `@0glabs` npm scope to **`0gfoundation`**. Many `github.com/0glabs/*` URLs still resolve (redirect), but the current docs, starter kits, and npm packages all use `0gfoundation`. Both naming schemes appear below where the sources differ.

---

## 1. 0G Storage — overview

0G Storage is a decentralized data storage network with on-chain incentives for storage nodes. It targets high-throughput / low-latency workloads (notably AI datasets), positioning itself as "as fast as AWS S3 but built for Web3."

### 1.1 Two-lane architecture

From the storage-node README and concept doc, 0G Storage consists of two components:

1. **Data Publishing Lane** — ensures fast Merkle tree data-root commitment and verification through 0G Chain. Handles metadata and availability proofs, verified through the 0G Consensus network; enables fast data discovery.
2. **Data Storage Lane** — manages large data transfers and storage using an **erasure-coding** mechanism for redundancy and **sharding** for parallel processing. Per the concept doc: "Even if 30% of nodes fail, your data remains accessible."

Across the two lanes, 0G Storage supports:

- **General-purpose design** — atomic transactions, mutable key-value stores, and archive log systems.
- **Validated incentivization** — the **PoRA (Proof of Random Access)** mining algorithm distributes rewards to nodes that actually store data.

### 1.2 Storage layers

- **Log Layer (immutable / append-only)** — write-once/read-many; optimized for large files (ML datasets, video/image archives, blockchain history). This is the base layer.
- **Key-Value Layer (mutable)** — built on top of the log layer; supports updating existing data and fast key-based retrieval (on-chain databases, user profiles, game state, collaborative docs). Implemented as "0G-KV" / `0g-kv`.

### 1.3 Log-system internals (root-hash addressing, sectors, chunks)

From `0g-storage-node/docs/log-system.md`:

- The storage state is maintained in a **smart contract deployed on the host blockchain (0G Chain)**. Design "fully decouples data creation, reward distribution, and token circulation." The **0G Storage Contract** handles storage-request processing, data-entry creation, and reward distribution.
- **Data storage requests** are submitted by users, each including metadata (data size and commitments) **and the payment for storage service**.
- **Reward distribution** is handled independently through a mining process (storage nodes submit mining proofs to claim rewards). 0G's token circulation is embedded in the host chain as an ERC20 token maintained by a contract called the **ZG ledger**.
- **Granularity**: the log layer is append-only at the granularity of **log entries** (each entry = a storage-request transaction; realized as a filesystem, each log entry = a file). Addressed at the level of fixed-size **sectors of 256 B**. Every log entry is padded to a multiple of sectors.
- **Mining/chunks**: PoRA challenge queries operate on **256 KB chunks (= 1024 sectors)**; storage nodes maintain data at chunk granularity.
- **Data flow**: committed data is organized sequentially into a "data flow" (a sequence of fixed-size sectors) with a universal offset used to sample PoRA challenges. The default flow is the "main flow"; specialized flows give a consecutive address space and can set customized (higher) storage prices for better availability/reliability.

Embedding storage state in the host chain gives simplicity (no separate consensus), safety (inherits host-chain security), accessibility (any host-chain contract can read 0G state directly), and composability (0G tokens transfer like any ERC20).

### 1.4 PoRA + mining economics (concept-level)

- Miners prove they hold specific data via random challenges; valid cryptographic proofs earn storage fees.
- Mining range is **capped at 8 TB per mining operation** to keep small miners competitive; large operators run multiple 8 TB instances.
- FAQ claims (concept doc, marketing figures — ⚠️ verify): "95% lower costs than AWS," "200 MBPS retrieval speed even at network congestion," and "The network fee is fixed. All pricing is transparent and on-chain."

### 1.5 How it differs from typical blob stores

| Solution | Best for | Limitation (per 0G docs) |
|---|---|---|
| **0G Storage** | AI/Web3 apps needing speed + scale | Newer ecosystem |
| **AWS S3** | Traditional apps | Centralized, expensive |
| **Filecoin** | Cold storage archival | Slow retrieval, unstructured only |
| **Arweave** | Permanent storage | Extremely expensive |
| **IPFS** | Small files, hobby projects | Very slow, no guarantees |

0G claims to be the only option supporting **both structured (KV) and unstructured (log) data** with instant access, addressed by **Merkle root hash** rather than a content-address like IPFS CIDs.

---

## 2. TypeScript SDK

### 2.1 Package identity & version

> ⚠️ **Two packages exist. Confirm which you want.**
>
> - **Current (recommended):** `@0gfoundation/0g-storage-ts-sdk` — latest **`1.2.10`** (published 2026-06-04). This is what the current docs (`storage/sdk.md`) and starter kits use.
> - **Legacy/deprecated:** `@0glabs/0g-ts-sdk` — latest **`0.3.3`**, **marked deprecated on npm** ("Package no longer supported"). The task brief references this name; treat it as the old scope.
>
> Both declare a **peer dependency `ethers` (pinned `6.13.1`)** in their latest published manifests.

The repo README (`github.com/0glabs/0g-ts-sdk`, which redirects to the `0gfoundation` org) already shows the new install line. Feature checklist from that README: File Merkle Tree class, Flow contract types, RPC methods, file upload, browser support, file download (tests-for-different-environments still unchecked).

### 2.2 Install

From the current docs (`storage/sdk.md`):

```bash
npm install @0gfoundation/0g-storage-ts-sdk ethers
```

`ethers` is a required peer dependency for blockchain interactions.

### 2.3 Testnet endpoints (Galileo)

```javascript
// Network endpoints — see network overview docs for current values
// Turbo indexer (recommended):
const RPC_URL = 'https://evmrpc-testnet.0g.ai';
const INDEXER_RPC = 'https://indexer-storage-testnet-turbo.0g.ai';
```

> **Turbo vs Standard:** 0G Storage runs two independent networks — **Turbo** (faster, higher fees) and **Standard** (slower, lower fees) — each with a different indexer URL. The SDK auto-discovers the correct Flow contract from the indexer, so you do not hard-code the Flow address in SDK code. (The `evmrpc-testnet.0g.ai` RPC is flagged "Development Only" in the testnet doc — use a 3rd-party RPC for production.)

### 2.4 Setup

```javascript
import { ZgFile, Indexer, MemData } from '@0gfoundation/0g-storage-ts-sdk';
import { ethers } from 'ethers';

// Initialize provider and signer
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet('YOUR_PRIVATE_KEY', provider);

// Initialize indexer — flow contract is auto-discovered
const indexer = new Indexer(INDEXER_RPC);
```

### 2.5 Upload (ZgFile → merkleTree() → rootHash() → indexer.upload)

```javascript
async function uploadFile(filePath) {
  const file = await ZgFile.fromFilePath(filePath);

  // Must call merkleTree() before upload — populates internal state
  const [tree, treeErr] = await file.merkleTree();
  if (treeErr !== null) throw new Error(`Merkle tree error: ${treeErr}`);

  console.log("Root Hash:", tree?.rootHash());

  const [tx, uploadErr] = await indexer.upload(file, RPC_URL, signer);
  if (uploadErr !== null) throw new Error(`Upload error: ${uploadErr}`);

  await file.close(); // Always close when done

  // Handle both single and fragmented (>4GB) responses
  if ('rootHash' in tx) {
    return { rootHash: tx.rootHash, txHash: tx.txHash };
  } else {
    return { rootHashes: tx.rootHashes, txHashes: tx.txHashes };
  }
}
```

**Legacy-README variant** (from `0g-ts-sdk/README.md`, `@0gfoundation/0g-storage-ts-sdk` import; note `[tree, err]` tuple and `exit(1)` pattern):

```js
import { Indexer, ZgFile } from '@0gfoundation/0g-storage-ts-sdk';
import { ethers } from 'ethers';
import { exit } from 'process';

const file = await ZgFile.fromFilePath(<file_path>);
var [tree, err] = await file.merkleTree();
if (err === null) {
  console.log("File Root Hash: ", tree.rootHash());
} else {
  exit(1);
}
await file.close();
```

```js
const evmRpc = 'https://evmrpc-testnet.0g.ai';
const privateKey = ''; // with balance to pay for gas
const indRpc = 'https://indexer-storage-testnet-turbo.0g.ai'; // indexer rpc

const provider = new ethers.JsonRpcProvider(evmRpc);
const signer = new ethers.Wallet(privateKey, provider);

const indexer = new Indexer(indRpc);
// need to pay fees to store data in storage nodes
var [tx, err] = await indexer.upload(file, evmRpc, signer);
```

### 2.6 Upload in-memory data (`MemData`)

```javascript
const data = new TextEncoder().encode('Hello, 0G Storage!');
const memData = new MemData(data);
const [tree, treeErr] = await memData.merkleTree();
const [tx, err] = await indexer.upload(memData, RPC_URL, signer);
```

### 2.7 Download (with proof)

```javascript
async function downloadFromIndexer(rootHash, outputPath) {
  // withProof = true enables Merkle proof verification
  const err = await indexer.download(rootHash, outputPath, true);
  if (err !== null) {
    throw new Error(`Download error: ${err}`);
  }
  console.log("Download successful!");
}
```

> **Save the root hash** returned at upload time — it is the download key. `indexer.download()` uses `fs.appendFileSync` internally and **does not work in browsers**; for browser downloads use `StorageNode.downloadSegmentByTxSeq()` and reassemble in memory (see the TS starter kit `web/src/storage.ts`).

### 2.8 Key-Value storage (`Batcher` + `KvClient`)

Documented in `storage/sdk.md`:

```javascript
// Upload data to 0G-KV
async function uploadToKV(streamId, key, value) {
  const [nodes, err] = await indexer.selectNodes(1);
  if (err !== null) {
    throw new Error(`Error selecting nodes: ${err}`);
  }

  const batcher = new Batcher(1, nodes, flowContract, RPC_URL);

  const keyBytes = Uint8Array.from(Buffer.from(key, 'utf-8'));
  const valueBytes = Uint8Array.from(Buffer.from(value, 'utf-8'));
  batcher.streamDataBuilder.set(streamId, keyBytes, valueBytes);

  const [tx, batchErr] = await batcher.exec();
  if (batchErr !== null) {
    throw new Error(`Batch execution error: ${batchErr}`);
  }

  console.log("KV upload successful! TX:", tx);
}

// Download data from 0G-KV
async function downloadFromKV(streamId, key) {
  const kvClient = new KvClient("http://3.101.147.150:6789");
  const keyBytes = Uint8Array.from(Buffer.from(key, 'utf-8'));
  const value = await kvClient.getValue(streamId, ethers.encodeBase64(keyBytes));
  return value;
}
```

> ⚠️ The KV read endpoint `http://3.101.147.150:6789` is a hard-coded example KV node from the docs. Verify the current KV client address before use; it is plain HTTP (not HTTPS) and may be ephemeral. `Batcher`/`KvClient` are not re-exported in every example's import line — import them from `@0gfoundation/0g-storage-ts-sdk` (the README's KV snippet omits the import). The `flowContract` argument in `new Batcher(...)` is the Flow contract instance (see `getFlowContract` in the README).

The legacy README shows the same flow with `set("0x...", key, val)` on `streamDataBuilder` and reading via:

```js
const KvClientAddr = "http://3.101.147.150:6789"
const streamId = "0x..."
const kvClient = new KvClient(KvClientAddr)
let val = await kvClient.getValue(streamId, ethers.encodeBase64(key1));
```

### 2.9 Browser support

```javascript
import { Blob as ZgBlob, Indexer } from '@0gfoundation/0g-storage-ts-sdk';
import { BrowserProvider } from 'ethers';

// Connect wallet via MetaMask
const provider = new BrowserProvider(window.ethereum);
await provider.send('eth_requestAccounts', []);
const signer = await provider.getSigner();

// Upload a browser File object
const zgBlob = new ZgBlob(fileInput.files[0]);
const [tree, treeErr] = await zgBlob.merkleTree();
const indexer = new Indexer(INDEXER_RPC);
const [tx, err] = await indexer.upload(zgBlob, RPC_URL, signer);
```

**Vite** — the SDK imports Node built-ins (`fs`, `crypto`) at load time, so bundlers need polyfills. From the README:

```ts
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    nodePolyfills({
      include: ['crypto', 'buffer', 'stream', 'util', 'events'],
    }),
  ],
});
```

Then import from the `/browser` entrypoint:

```ts
import { Indexer, Blob } from '@0gfoundation/0g-storage-ts-sdk/browser';
```

(Legacy README also documents importing `zgstorage.esm.js` directly via `<script type="module">` and constructing `new Blob(blob)`.)

### 2.10 Client-side encryption (SDK ≥ v1.2.6)

Files are encrypted client-side before upload; the network never sees plaintext. A compact header (17–50 bytes) is prepended so the SDK auto-detects mode on download.

| Mode | Key material | Header size |
|---|---|---|
| `aes256` | 32-byte symmetric key | 17 bytes |
| `ecies` | secp256k1 keypair | 50 bytes |

```javascript
// AES-256
const key = crypto.randomBytes(32); // save this — no server-side recovery
const file = await ZgFile.fromFilePath('./secret.txt');
const [tx, err] = await indexer.upload(file, rpcUrl, signer, {
  encryption: { type: 'aes256', key },
});
const [blob, dlErr] = await indexer.downloadToBlob(rootHash, {
  proof: true,
  decryption: { symmetricKey: key },
});
```

```javascript
// ECIES (encrypt-to-self uses your wallet's secp256k1 key)
const recipientPubKey = ethers.SigningKey.computePublicKey(
  wallet.signingKey.publicKey, true  // true = compressed 33-byte key
);
const [tx, err] = await indexer.upload(file, rpcUrl, signer, {
  encryption: { type: 'ecies', recipientPubKey },
});
const [blob, dlErr] = await indexer.downloadToBlob(rootHash, {
  proof: true,
  decryption: { privateKey },
});
```

```javascript
// Detect mode: null = plaintext; version 1 = aes256; version 2 = ecies
const [header, err] = await indexer.peekHeader(rootHash);
```

Notes from the docs: a wrong key does **not** throw — `downloadToBlob` silently returns raw ciphertext, so call `peekHeader` first if unsure. `indexer.download()` does **not** support decryption; use `indexer.downloadToBlob()` for encrypted files (large files are fully buffered in memory).

### 2.11 Go SDK (for reference)

There is also a Go SDK: `go get github.com/0gfoundation/0g-storage-client`, using `indexer.NewClient`, `indexerClient.SelectNodes(...)`, `indexerClient.SplitableUpload(...)`, `core.MerkleRoot(filePath)`, and `indexerClient.Download(ctx, rootHex, outputPath, withProof)`. Starter kits: `0g-storage-ts-starter-kit` and `0g-storage-go-starter-kit` (both under the `0gfoundation` org).

---

## 3. Storage fees / cost model

**What the docs confirm:**

- Storage is paid at **upload time**: the storage-request transaction to the **Flow contract** includes "the payment for storage service" (log-system doc). The SDK comment states plainly: `// need to pay fees to store data in storage nodes`, and `indexer.upload(...)` also requires a signer whose account holds gas.
- Payment funds a reward pool; storage nodes claim rewards separately via **PoRA mining proofs**. Token circulation is an embedded ERC20 (the "ZG ledger").
- The **Turbo** network charges higher fees than **Standard** (two independent networks, different indexers).
- Marketing FAQ states "The network fee is fixed. All pricing is transparent and on-chain" and "~95% lower cost than AWS."

> ⚠️ **UNCONFIRMED — exact price formula.** The fetched Markdown docs do **not** give a concrete per-byte / per-sector storage price, a fee constant, or a pricing endpoint for the Storage Flow contract. The precise price is set on-chain in the Flow/market contracts and (per the log-system doc) can differ per data flow (specialized flows charge "significantly higher than the floor price of the default flow"). Read the actual fee from the Flow/market contract on-chain, or check the live docs/`0g-storage-contracts` repo. Do not assume a fixed number here. (Contrast with **DA**, whose fee constant `BLOB_PRICE` is documented — see §4.4.)

---

## 4. 0G Data Availability (DA)

### 4.1 What it is

0G DA is a horizontally scalable Data Availability Layer. Users submit a **DA blob**; the client's proxy redundantly erasure-codes it, splits it into slices, and distributes slices to **DA nodes**. DA nodes gain eligibility by **staking**, verify and BLS-sign their slice; once **>2/3 aggregated signatures** are on-chain, the data behind the hash is considered decentrally published.

Distinctive design points vs other DALs (concept doc):
- Built-in storage system (data lives in 0G Storage) rather than depending on external storage.
- Horizontally scalable consensus — can keep adding consensus networks; throughput scales rather than being bounded by the slowest node.
- **DA nodes are chosen via a VRF** (Verifiable Random Function) to prevent collusion; they work in **quorums** under an honest-majority assumption using **sampling-based** verification.
- Security via **shared staking** — validators stake 0G on a primary network (Ethereum), inheriting Ethereum's economic security; slashable events on connected networks slash on the main network.
- Claimed **50 Gbps** throughput on the Galileo testnet (marketing figure — ⚠️ verify).

### 4.2 Relationship to Storage and the chain

- **DA nodes ≠ 0G validators.** DA nodes ensure availability and sign; separate **0G Consensus validators** verify and finalize the proofs on-chain.
- DA blobs' underlying data uses the **same erasure-coding + Storage-node distribution** as 0G Storage; the DA "data root" is defined as a 0G Storage submission input root (see §4.5). So DA and Storage share the encoding/addressing substrate, and DA availability proofs land on 0G Chain.

### 4.3 How developers submit / retrieve blobs

There is **no first-party TypeScript DA SDK** in these docs. Integration is via **running nodes + gRPC**:

- To **submit** data you run a **DA Client** node (interfaces with an **Encoder** for encoding) and to **read** you run/point at a **Retriever**.
- The submission protobuf (disperser) is the integration surface: `https://github.com/0gfoundation/0g-da-example-rust/blob/main/src/disperser.proto`. Example integrations: `github.com/0gfoundation/0g-da-example-rust`.
- **Max blob size: 32,505,852 bytes.** Larger inputs must be split by the caller.

**DA Client node** (Docker) — key env from `da-integration.md`:

```bash
git clone https://github.com/0gfoundation/0g-da-client.git
cd 0g-da-client
docker build -t 0g-da-client -f combined.Dockerfile .
```

```bash
# envfile.env (excerpt)
COMBINED_SERVER_CHAIN_RPC=https://evmrpc-testnet.0g.ai
COMBINED_SERVER_PRIVATE_KEY=YOUR_PRIVATE_KEY
ENTRANCE_CONTRACT_ADDR=0x857C0A28A8634614BB2C96039Cf4a20AFF709Aa9
DISPERSER_SERVER_GRPC_PORT=51001
BATCHER_DASIGNERS_CONTRACT_ADDRESS=0x0000000000000000000000000000000000001000
BATCHER_FINALIZER_INTERVAL=20s
BATCHER_CONFIRMER_NUM=3
BATCHER_ENCODER_ADDRESS=DA_ENCODER_SERVER
# ... (full BATCHER_* tuning set in source)
```

```bash
docker run -d --env-file envfile.env --name 0g-da-client -v ./run:/runtime -p 51001:51001 0g-da-client combined
```

- **DA Encoder**: Rust build; requires nightly `nightly-2024-02-04`, `protobuf-compiler`; optional `cuda` feature (tested on NVIDIA driver 12.04 / RTX 4090). Serves gRPC on **port 34000**. Public params built from perpetual-powers-of-tau `challenge_0084`. Verification helper crate: `zg-encoder = { git = "https://github.com/0gfoundation/0g-da-encoder.git" }`, function `zg_encoder::EncodedSlice::verify`.
- **DA Retriever**: `git clone https://github.com/0gfoundation/0g-da-retriever.git`; Docker on **port 34005**; config `run/config.toml` needs `eth_rpc_endpoint`, `grpc_listen_address`, `log_level`.

**Hardware:** DA Client / DA Retriever each ~8 GB RAM, 2 cores, 100 MBps; DA Encoder needs an NVIDIA GPU (RTX 4090, driver 12.04).

### 4.4 DA fee model (better-specified than Storage)

- Users pay **`BLOB_PRICE`** when submitting DA blob metadata to the DA contract.
- A system **service fee** is charged as a proportion of user DA fees via `SERVICE_FEE_RATE_BP`.
- Rewards come not from signing but from **DA Sampling** (a lottery); DA nodes must store their slice to claim.

Documented default parameters (from `DAEntrance.sol` links in `da-deep-dive.md` — note testnet defaults are largely **0**):

| Parameter | Default |
|---|---|
| `MAX_PODAS_TARGET` | 2^256 / 128 − 1 |
| `TARGET_SUBMITS` | 20 |
| `EPOCH_WINDOW_SIZE` | 300 (~3 months) |
| `SAMPLE_PERIOD` | 30 blocks (~1.5 min) |
| `BASE_REWARD` | 0 |
| `BLOB_PRICE` | 0 |
| `SERVICE_FEE_RATE_BP` | 0 |
| `REWARD_RATIO` | 1,200,000 |

> ⚠️ These are the admin-adjustable defaults shown in the docs (many are `0` on testnet). Read live values from the `DAEntrance` contract. Reward per valid response = `1 / REWARD_RATIO` of the epoch reward pool.

### 4.5 DA processing flow (deep dive)

Input ≤ 32,505,852 bytes is processed:

1. **Padding & size encoding** — zero-pad to 32,505,852 bytes; append a little-endian 4-byte integer of the original size.
2. **Matrix formation** — slice into a 1024×1024 matrix, 31 bytes per element, then pad each element with 1 zero byte → 32 bytes.
3. **Redundant encoding** — expand to a **3072×1024** matrix via redundancy coding; compute the **erasure commitment** and **data root**.
4. **Submission** — submit erasure commitment + data root to the **DA contract** and **pay the fee**; the contract assigns an epoch and quorum.
5. **Distribution** — send commitment, data root, each matrix row, and correctness proofs to the corresponding DA nodes.
6. **Signature aggregation** — >2/3 of DA nodes BLS-sign (BN254 curve); aggregate signature submitted on-chain.

**Erasure commitment** = KZG commitment of a degree-`2^20−1` polynomial `f` over the BN254 scalar field, `f(τ)·G` using the perpetual-powers-of-tau `τ`. **Data root** = the 0G Storage submission input root over the 1024×3072 32-byte elements (16384-element + 8192-element sector arrays). Slice verification uses Merkle proofs (vs data root) and KZG/AMT proofs (vs erasure commitment; AMT optimization from LVMT).

**DA Sampling / PoDAS** (reward lottery), every `SAMPLE_PERIOD` blocks, seed = parent block hash:

```python
lineQuality = keccak256(sampleSeed, epoch, quorumId, dataRoot, lineIndex);
dataQuality = keccak256(lineQuality, sublineIndex, data);
podasQuality = lineQuality + dataQuality
```

A sub-line is a valid response if `podasQuality < podasTarget` and `epoch ∈ [currentEpoch − EPOCH_WINDOW_SIZE, currentEpoch)`. At most `TARGET_SUBMITS × 2` responses are rewarded per period. Difficulty adjusts:

```python
podasTarget -= podasTarget * (actualSubmits - TARGET_SUBMITS) / TARGET_SUBMITS / 8
```

DA epoch ≈ **8 hours**; within a quorum, nodes are numbered 0–3071; a node may occupy multiple quorums by staking weight.

### 4.6 Running a DA node (signer)

- **Testnet stake to run a DA node: 10 OG** (from faucet or node rewards).
- Being a **signer** requires delegations ≥ `TokensPerVote` (**30 OG per vote** on testnet); each delegated `TokensPerVote` = one vote, up to `MaxVotesPerSigner`; votes are randomly ordered into quorums each epoch.
- Register via `registerSigner` (address, node socket, BLS G1/G2 public key, BLS signature) and `registerNextEpoch` each epoch.
- DA node `config.toml` essentials:
  - `grpc_listen_address = "0.0.0.0:34000"`
  - `eth_rpc_endpoint = "https://evmrpc-testnet.0g.ai"`
  - `da_entrance_address = "0x857C0A28A8634614BB2C96039Cf4a20AFF709Aa9"` (testnet)
- **DASigners precompile** contract: `0x0000000000000000000000000000000000001000` (BN254 BLS). Interface in `github.com/0gfoundation/0g-da-contract`.

---

## 5. Network endpoints & contract addresses

### 5.1 Testnet — 0G Galileo

| Parameter | Value |
|---|---|
| Network Name | 0G Galileo Testnet |
| **Chain ID** | **16602** |
| Token Symbol | 0G |
| EVM RPC (dev only) | `https://evmrpc-testnet.0g.ai` |
| Storage Indexer (Turbo) | `https://indexer-storage-testnet-turbo.0g.ai` |
| Block Explorer | `https://chainscan-galileo.0g.ai` |
| Storage Explorer | `https://storagescan-galileo.0g.ai` |
| Faucet | `https://faucet.0g.ai` (0.1 0G/day) |
| Faucet (Google Cloud) | `https://cloud.google.com/application/web3/faucet/0g/galileo` |
| Testnet explorer (portal) | `https://explorer.0g.ai/testnet/home` |

**Testnet contract addresses** (⚠️ "Addresses may change during testnet"):

- **0G Storage**
  - Flow: `0x22E03a6A89B950F1c82ec5e74F8eCa321a105296`
  - Mine: `0x00A9E9604b0538e06b268Fb297Df333337f9593b`
  - Reward: `0xA97B57b4BdFEA2D0a25e535bd849ad4e6C440A69`
- **0G DA**
  - DAEntrance: `0xE75A073dA5bb7b0eC622170Fd268f35E675a957B`
- **DASigners precompile** (chain module): `0x0000000000000000000000000000000000001000`

> ⚠️ Discrepancy to be aware of: the DA-node/DA-client docs use `ENTRANCE_CONTRACT_ADDR` / `da_entrance_address = 0x857C0A28A8634614BB2C96039Cf4a20AFF709Aa9`, while the testnet overview lists **DAEntrance = `0xE75A073dA5bb7b0eC622170Fd268f35E675a957B`**. The node docs label their value "testnet config … see testnet page for the latest info," so the testnet-overview value is the more authoritative current one. Verify against the live testnet page before wiring either in.

### 5.2 Mainnet — 0G Mainnet

| Parameter | Value |
|---|---|
| Network Name | 0G Mainnet |
| **Chain ID** | **16661** |
| Token Symbol | 0G |
| EVM RPC | `https://evmrpc.0g.ai` |
| Storage Indexer (Turbo) | `https://indexer-storage-turbo.0g.ai` |
| Block Explorer | `https://chainscan.0g.ai` |
| Mainnet explorer (portal) | `https://explorer.0g.ai/mainnet/home` |

**Mainnet contract addresses:**

- **0G Storage**
  - Flow: `0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526`
  - Mine: `0xCd01c5Cd953971CE4C2c9bFb95610236a7F414fe`
  - Reward: `0x457aC76B58ffcDc118AABD6DbC63ff9072880870`

> ⚠️ The mainnet overview does **not** list a mainnet **DA / DAEntrance** address or a Standard (non-turbo) indexer URL. Treat mainnet DA endpoints/addresses as **UNCONFIRMED** here — check the live mainnet docs. For production RPC, 0G recommends 3rd-party providers (QuickNode, ThirdWeb, Ankr, dRPC) over the public endpoints.

---

## 6. Quick reference — gotchas

- **Package rename**: use `@0gfoundation/0g-storage-ts-sdk` (v1.2.10). `@0glabs/0g-ts-sdk` (v0.3.3) is **deprecated**. `ethers@6.13.1` is the pinned peer dep.
- **Always call `file.merkleTree()` before `indexer.upload()`** — it populates internal state — and **save the root hash** for download.
- **Turbo vs Standard** are separate networks with separate indexer URLs and different fees; the SDK auto-discovers the Flow contract from the indexer.
- **Browser**: alias `Blob as ZgBlob`; `indexer.download()` doesn't work in-browser (use `StorageNode.downloadSegmentByTxSeq()`); bundlers need node polyfills.
- **Encryption ≥ v1.2.6**: wrong key returns ciphertext silently; use `downloadToBlob()` (not `download()`) and `peekHeader()` to detect.
- **Storage price**: not numerically specified in docs — read on-chain. **DA price** = `BLOB_PRICE` (0 on testnet default).
- **DA has no TS SDK** — integrate via DA Client/Encoder/Retriever nodes + gRPC (`disperser.proto`); max blob **32,505,852 bytes**.
- Verify every ⚠️ line and all contract addresses against the live docs at https://docs.0g.ai (Cloudflare-gated; use the GitHub raw sources in §0).
