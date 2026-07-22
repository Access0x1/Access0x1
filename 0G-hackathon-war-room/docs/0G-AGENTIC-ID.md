# 0G Agentic ID, INFT & Agent Network — vendored reference

> Compiled 2026-07-22 from open-source 0G docs (`github.com/0glabs/0g-doc`, raw markdown), the `ethereum/ERCs` copy of EIP-8004, the `0gfoundation/0g-agent-nft` reference implementation, `0xgasless/agent-sdk`, and news coverage of the 0G×AIverse launch. **⚠️ = verify against live docs at https://docs.0g.ai** (Cloudflare-gated; not directly fetchable). Interface/code snippets are reproduced verbatim from source. Items marked **⚠️ UNCONFIRMED** could not be verified against a primary source.

---

## 0. TL;DR

- **Agentic ID** is 0G's rebrand of the **INFT ("Intelligent NFT")**. Same standard, same encrypted-metadata transfer model. It tokenizes an AI agent *together with its actual intelligence* (model/weights/state), not just a metadata pointer.
- **ERC-7857** is the token standard behind Agentic IDs: it extends ERC-721 with **encrypted metadata**, **oracle-verified re-encryption on transfer** (TEE or ZKP), **clone**, and **authorized usage**.
- **ERC-8004 ("Trustless Agents")** is a *separate*, complementary Ethereum standard (Draft) — three registries (Identity / Reputation / Validation) giving agents a portable, discoverable on-chain "passport." **0G officially supports it** and has deployed the registries on 0G Chain; Agentic IDs are **ERC-8004 compatible**.
- **0G × AIverse Web 4.0 marketplace** (announced 2026-03-04) makes any agent mintable as an Agentic ID on **0G Aristotle Mainnet**, with **EchoClaw** giving agents wallets, exchange trading, and bonding-curve access.
- **Published SDKs:** first-party `@0glabs/0g-ts-sdk` (Storage) and `@0glabs/0g-serving-broker` (Compute); third-party `@0xgasless/agent` (ERC-8004 identity + x402 payments). **A dedicated first-party "mint an Agentic ID" package is NOT clearly published** — see §5.

---

## 1. Agentic ID

Source: `docs/concepts/agentic-id.md`, `docs/developer-hub/building-on-0g/agentic-id/overview.md` (0glabs/0g-doc).

### 1.1 What it is

> "**Agentic ID** is the new name for what was previously called an **INFT** (Intelligent NFT). Same standard (ERC-7857), same encrypted-metadata transfer model."

Traditional NFTs "only own a pointer to some metadata — not the actual intelligence." An Agentic ID instead **contains the encrypted AI intelligence**; when transferred, "the AI moves with it" and the new owner "gets full access to the AI agent."

Four properties 0G emphasizes:

| Property | Meaning |
|----------|---------|
| **True AI Ownership** | You own the complete intelligence, not just a certificate. |
| **Privacy-First** | AI data stays encrypted throughout the entire lifecycle; only the owner can access it. |
| **Secure Transfers** | Ownership AND encrypted intelligence transfer together. |
| **Decentralized Storage** | Encrypted agent state lives on **0G Storage** (permanent, no central server). |

### 1.2 Lifecycle (how a developer registers/mints an agent identity)

From the overview's "How It Works":

```
1. Create : Build and train your AI agent
2. Encrypt: Secure the AI's intelligence with encryption
3. Mint   : Create an Agentic ID containing the encrypted AI
4. Own    : Have complete ownership and control over the AI agent
```

Concretely (from the Integration Guide, §2 below), minting is:

1. Serialize the agent → `{ model, weights, config, capabilities, version, createdAt }`.
2. Generate a symmetric key; **encrypt** the metadata.
3. **Store** the ciphertext on 0G Storage → get a URI.
4. **Seal** the key for the owner's public key.
5. Compute a `metadataHash` (keccak256).
6. Call `mint(to, encryptedURI, metadataHash)` on the ERC-7857 contract.

### 1.3 Powered by 0G stack

| Component | Role in Agentic IDs |
|-----------|---------------------|
| **0G Storage** | Encrypted metadata storage (owner-only access) |
| **0G Chain** | Smart-contract execution (mint/transfer/authorize) |
| **0G Compute** | Secure/private AI inference (TEE/ZKP) |
| **0G DA** | Transfer-proof / metadata-availability verification |

### 1.4 Relationship to ERC-8004

> "Agentic IDs are compatible with **ERC-8004** … An Agentic ID can carry a corresponding ERC-8004 registration, making the agent discoverable and interoperable across the ERC-8004 ecosystem."

So: **ERC-7857 governs ownership + encrypted intelligence; ERC-8004 governs public discoverability + reputation.** They are layered, not alternatives.

---

## 2. INFT / ERC-7857

Sources: `docs/.../agentic-id/erc7857.md`, `docs/.../agentic-id/overview.md`, and the reference implementation README at `github.com/0gfoundation/0g-agent-nft/tree/eip-7857-draft`. Reference impl branch cited by the docs: **`eip-7857-draft`**. EIP proposal PR: `github.com/ethereum/EIPs/pull/7857`.

### 2.1 What ERC-7857 is

> "ERC-7857 extends ERC-721 to support encrypted metadata, specifically designed for tokenizing AI agents and sensitive digital assets."

| Feature | Benefit |
|---------|---------|
| **Encrypted Metadata** | Protects proprietary AI models |
| **Secure Re-encryption** | Transfer without data exposure |
| **Oracle Verification** (TEE/ZKP) | Ensures transfer integrity |
| **Authorized Usage** | Grant access without ownership (AI-as-a-Service) |

### 2.2 Core interface (verbatim)

From `erc7857.md`:

```solidity
interface IERC7857 is IERC721 {
    // Transfer with metadata re-encryption
    function transfer(
        address from,
        address to,
        uint256 tokenId,
        bytes calldata sealedKey,
        bytes calldata proof
    ) external;

    // Clone token with same metadata
    function clone(
        address to,
        uint256 tokenId,
        bytes calldata sealedKey,
        bytes calldata proof
    ) external returns (uint256 newTokenId);

    // Authorize usage without revealing data
    function authorizeUsage(
        uint256 tokenId,
        address executor,
        bytes calldata permissions
    ) external;
}
```

### 2.3 The transfer / re-encryption model (the heart of the standard)

The canonical description, verbatim from the **reference implementation README** (`0gfoundation/0g-agent-nft`), abstracts proof generation/verification as querying an **ideal oracle**. On a `newDataHash` query the oracle replies with:

> 1. The `oldDataHash` representing the data encrypted from the original metadata with a key held by the sender
> 2. The `newDataHash` representing the data encrypted from the original metadata with a new key
> 3. Whether the receiver can access the data behind the `newDataHash`
> 4. The `sealedKey` containing the new key encrypted with the receiver's public key

> "If the oracle say 'yes', the contract changes the token's owner from sender to receiver, updates the token's `oldDataHash` to `newDataHash`, and publishes the `sealedKey`. The receiver can then access the original metadata using the key decrypted from `sealedKey` with their private key."

Docs' 6-step transfer flow (`overview.md`):

```
1. Encrypt & Commit    →  2. Oracle Processing (TEE decrypts original)
          ↓                           ↓
6. Access Granted      ←  3. Re-encrypt for Receiver (new key, store on 0G Storage)
          ↑                           ↓
5. Verify & Finalize   ←  4. Secure Key Delivery (new key sealed to receiver pubkey)
```

Step 5's smart-contract check verifies: sender's access rights, oracle validation that metadata matches, and receiver's signed acknowledgment. If valid → ownership transfers + receiver gets the encrypted key.

**Two oracle implementations:**

- **TEE (Trusted Execution Environment)** — decrypts, re-encrypts, and generates a **new key securely** inside an enclave; attestation is the proof. TEE *can* generate the new key so the sender never sees it.
- **ZKP (Zero-Knowledge Proof)** — a circuit proves correct re-encryption without revealing keys/data, but **cannot independently generate the new key**, so "the receiver should change their key when next updating the data."

The reference README notes the `authorizeUsage()` "sealed executor" (the entity that processes private metadata without exposing it) "can be implemented using either TEE or FHE."

### 2.4 How encrypted agent state is stored on 0G Storage (verbatim example)

From `erc7857.md`:

```javascript
// Store encrypted AI agent metadata
const metadata = {
    model: aiAgent.serializedModel,
    weights: aiAgent.trainedWeights,
    config: aiAgent.configuration
};

const encrypted = await encryptMetadata(metadata, ownerPublicKey);
const storageResult = await ogStorage.store(encrypted, {
    redundancy: 3,
    durability: '99.999%'
});

console.log(`Metadata stored at: ${storageResult.uri}`);
```

Recommended crypto (docs "Security Considerations"): **AES-256-GCM** symmetric, **RSA-4096 or ECC-P384** for key sealing, always include auth tags; 90-day key rotation; store ciphertext on 0G Storage. Metadata size cap in the sample `MetadataManager` is **10 MB**.

### 2.5 Reference contract skeleton (verbatim, from `erc7857.md`)

```solidity
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract ERC7857 is ERC721, Ownable, ReentrancyGuard {
    // State variables
    mapping(uint256 => bytes32) private _metadataHashes;
    mapping(uint256 => string) private _encryptedURIs;
    mapping(uint256 => mapping(address => bytes)) private _authorizations;

    // Oracle configuration
    address public oracle;
    uint256 public constant PROOF_VALIDITY_PERIOD = 1 hours;

    // Events
    event MetadataUpdated(uint256 indexed tokenId, bytes32 newHash);
    event UsageAuthorized(uint256 indexed tokenId, address indexed executor);
    event OracleUpdated(address oldOracle, address newOracle);

    modifier validProof(bytes calldata proof) {
        require(oracle != address(0), "Oracle not set");
        require(IOracle(oracle).verifyProof(proof), "Invalid proof");
        _;
    }

    function transfer(
        address from,
        address to,
        uint256 tokenId,
        bytes calldata sealedKey,
        bytes calldata proof
    ) external nonReentrant validProof(proof) {
        require(ownerOf(tokenId) == from, "Not owner");
        require(to != address(0), "Invalid recipient");

        // Update metadata access for new owner
        _updateMetadataAccess(tokenId, to, sealedKey, proof);

        // Transfer NFT ownership
        _transfer(from, to, tokenId);

        emit MetadataUpdated(tokenId, keccak256(sealedKey));
    }

    function _updateMetadataAccess(
        uint256 tokenId,
        address newOwner,
        bytes calldata sealedKey,
        bytes calldata proof
    ) internal {
        // Verify proof contains correct metadata hash
        bytes32 expectedHash = _extractHashFromProof(proof);
        _metadataHashes[tokenId] = expectedHash;

        // Store new encrypted URI if provided
        string memory newURI = _extractURIFromProof(proof);
        if (bytes(newURI).length > 0) {
            _encryptedURIs[tokenId] = newURI;
        }
    }
}
```

> **⚠️ Note:** The Solidity/JS in the docs is *illustrative* (uses `_extractHashFromProof`, `IOracle`, `_mint(to)` without a tokenId in `clone`, `createCipher` with an IV, etc.). Treat as pedagogical, **not audit-grade**. The authoritative code is the `0gfoundation/0g-agent-nft` repo (`eip-7857-draft` branch). Security-audit reports are marked "coming soon" in the docs.

### 2.6 Advanced functions (verbatim)

```solidity
function clone(
    address to,
    uint256 tokenId,
    bytes calldata sealedKey,
    bytes calldata proof
) external returns (uint256) {
    require(canClone(tokenId, msg.sender), "Not authorized");

    uint256 newTokenId = _mint(to);
    _copyMetadata(tokenId, newTokenId, sealedKey, proof);

    return newTokenId;
}

function authorizeUsage(
    uint256 tokenId,
    address executor,
    bytes calldata permissions
) external {
    require(ownerOf(tokenId) == msg.sender, "Not owner");

    _authorizations[tokenId][executor] = permissions;

    emit UsageAuthorized(tokenId, executor);
}
```

- **`clone()`** — creates a new token with the same metadata; preserves the original (useful for agent templates / distribution).
- **`authorizeUsage()`** — grants usage rights **without ownership transfer**; a "sealed executor" runs the metadata securely → enables AI-as-a-Service, subscriptions, per-call billing.

---

## 3. ERC-7857 Integration Guide (developer walkthrough)

Source: `docs/.../agentic-id/integration.md`. This is the closest thing to a first-party "build an Agentic ID" tutorial.

### 3.1 Environment (verbatim)

```bash
npm install @0gfoundation/0g-storage-ts-sdk @openzeppelin/contracts ethers hardhat
npm install --save-dev @nomicfoundation/hardhat-toolbox
npx hardhat init
```

```bash
PRIVATE_KEY=your_private_key_here
OG_RPC_URL=https://evmrpc-testnet.0g.ai
OG_STORAGE_URL=https://storage-testnet.0g.ai
OG_COMPUTE_URL=https://compute-testnet.0g.ai
```

> **⚠️ Package-name discrepancy:** the integration guide installs **`@0gfoundation/0g-storage-ts-sdk`**, but the canonical, npm-published 0G Storage SDK (per `0g-agent-skills` and npmjs) is **`@0glabs/0g-ts-sdk`** (`^0.3.3`). `@0gfoundation/0g-storage-ts-sdk` could not be confirmed on npm — **⚠️ UNCONFIRMED**; prefer `@0glabs/0g-ts-sdk` unless the live docs say otherwise.

### 3.2 The contract the guide deploys — `AgenticID.sol` (verbatim, abridged to the parts that matter)

```solidity
// contracts/AgenticID.sol
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface IOracle {
    function verifyProof(bytes calldata proof) external view returns (bool);
}

contract AgenticID is ERC721, Ownable, ReentrancyGuard {
    mapping(uint256 => bytes32) private _metadataHashes;
    mapping(uint256 => string) private _encryptedURIs;
    mapping(uint256 => mapping(address => bytes)) private _authorizations;

    address public oracle;
    uint256 private _nextTokenId = 1;

    event MetadataUpdated(uint256 indexed tokenId, bytes32 newHash);
    event UsageAuthorized(uint256 indexed tokenId, address indexed executor);

    constructor(string memory name, string memory symbol, address _oracle)
        ERC721(name, symbol) { oracle = _oracle; }

    function mint(address to, string calldata encryptedURI, bytes32 metadataHash)
        external onlyOwner returns (uint256)
    {
        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        _encryptedURIs[tokenId] = encryptedURI;
        _metadataHashes[tokenId] = metadataHash;
        return tokenId;
    }

    function transfer(
        address from, address to, uint256 tokenId,
        bytes calldata sealedKey, bytes calldata proof
    ) external nonReentrant {
        require(ownerOf(tokenId) == from, "Not owner");
        require(IOracle(oracle).verifyProof(proof), "Invalid proof");
        _updateMetadataAccess(tokenId, to, sealedKey, proof);
        _transfer(from, to, tokenId);
        emit MetadataUpdated(tokenId, keccak256(sealedKey));
    }

    function authorizeUsage(uint256 tokenId, address executor, bytes calldata permissions)
        external
    {
        require(ownerOf(tokenId) == msg.sender, "Not owner");
        _authorizations[tokenId][executor] = permissions;
        emit UsageAuthorized(tokenId, executor);
    }

    function getMetadataHash(uint256 tokenId) external view returns (bytes32) {
        return _metadataHashes[tokenId];
    }
    function getEncryptedURI(uint256 tokenId) external view returns (string memory) {
        return _encryptedURIs[tokenId];
    }
}
```

Deploy target network name in the guide: `og-testnet` (`npx hardhat run scripts/deploy.js --network og-testnet`), deploying a `MockOracle` for local testing.

### 3.3 Mint flow (verbatim, from the guide's `MetadataManager`)

```javascript
const metadata = {
    model: aiModelData.model,
    weights: aiModelData.weights,
    config: aiModelData.config,
    capabilities: aiModelData.capabilities,
    version: '1.0',
    createdAt: Date.now()
};
const encryptionKey = crypto.randomBytes(32);
const encryptedData = await this.encryption.encrypt(JSON.stringify(metadata), encryptionKey);
const storageResult = await this.storage.store(encryptedData);        // → 0G Storage URI
const sealedKey = await this.encryption.sealKey(encryptionKey, ownerPublicKey);
const metadataHash = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(JSON.stringify(metadata))
);
// then: contract.mint(recipient, storageResult.uri, metadataHash)
```

The guide also sketches a **marketplace** (`listAgent`/`purchaseAgent`), an **AI-as-a-Service** subscription layer (`authorizeUsage` + `ogCompute.executeSecure({ ..., verificationMode: 'TEE' })`), and **multi-agent composition** (mint a new "composite" Agentic ID over several agent tokenIds). These are illustrative patterns, not shipped contracts.

---

## 4. ERC-8004 (Trustless Agents)

Sources: `ethereum/ERCs` → `ERCS/erc-8004.md` (canonical spec text), `docs/.../agentic-id/erc8004.md` (0G's support page), `eips.ethereum.org/EIPS/eip-8004`.

### 4.1 Metadata & status (verbatim from the EIP front-matter)

```
eip: 8004
title: Trustless Agents
description: Discover agents and establish trust through reputation and validation
author: Marco De Rossi (@MarcoMetaMask), Davide Crapis (@dcrapis) <davide@ethereum.org>,
        Jordan Ellis <jordanellis@google.com>, Erik Reppel <erik.reppel@coinbase.com>
status: Draft
type: Standards Track
category: ERC
created: 2025-08-13
requires: 155, 712, 721, 1271
```

> **Status: Draft.** Discussion: `ethereum-magicians.org/t/erc-8004-trustless-agents/25098`. Abstract goal: "**discover, choose, and interact with agents across organizational boundaries** without pre-existing trust." Trust models are pluggable: reputation, stake-secured re-execution, zkML proofs, or TEE oracles. Deployed as **per-chain singletons**. Payments are explicitly out of scope (x402 shown only as an example).

### 4.2 The three registries

| Registry | Role |
|----------|------|
| **Identity Registry** | ERC-721 (+ URIStorage) — the agent "passport." Assigns a global `agentId` (= ERC-721 `tokenId`) and an `agentURI` (= `tokenURI`) resolving to the registration file. |
| **Reputation Registry** | Post/fetch signed feedback signals (on-chain for composability, off-chain for sophisticated scoring). |
| **Validation Registry** | Generic hooks for independent validator checks (re-execution, zkML, TEE oracles, trusted judges). |

**Global identifier** (verbatim concept): an agent is identified by `agentRegistry` = `{namespace}:{chainId}:{identityRegistry}` (e.g. `eip155:1:0x742...`) plus the incremental `agentId`. In ERC-721 terms, `tokenId → agentId`, `tokenURI → agentURI`. The `agentId` counter is **global/shared per registry**, not per-project.

### 4.3 The Agent Registration File ("agent card") — verbatim structure

```jsonc
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "myAgentName",
  "description": "A natural language description of the Agent...",
  "image": "https://example.com/agentimage.png",
  "services": [
    { "name": "web", "endpoint": "https://web.agentxyz.com/" },
    { "name": "A2A", "endpoint": "https://agent.example/.well-known/agent-card.json", "version": "0.3.0" },
    { "name": "MCP", "endpoint": "https://mcp.agent.eth/", "version": "2025-06-18" },
    { "name": "OASF", "endpoint": "ipfs://{cid}", "version": "0.8", "skills": [], "domains": [] },
    { "name": "ENS", "endpoint": "vitalik.eth", "version": "v1" },
    { "name": "DID", "endpoint": "did:method:foobar", "version": "v1" },
    { "name": "email", "endpoint": "mail@myagent.com" }
  ],
  "x402Support": false,
  "active": true,
  "registrations": [
    { "agentId": 22, "agentRegistry": "{namespace}:{chainId}:{identityRegistry}" }
  ],
  "supportedTrust": [ "reputation", "crypto-economic", "tee-attestation" ]
}
```

Endpoints combine AI primitives (A2A, MCP, OASF) with Web3 primitives (ENS, DID, wallets). `supportedTrust` is OPTIONAL — if absent, the ERC is used for discovery only.

### 4.4 Identity Registry interface (verbatim)

```solidity
struct MetadataEntry { string metadataKey; bytes metadataValue; }

function register(string agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId)
function register(string agentURI) external returns (uint256 agentId)
function register() external returns (uint256 agentId)   // agentURI added later via setAgentURI()

function setAgentURI(uint256 agentId, string calldata newURI) external

function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory)
function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external

// Reserved key `agentWallet` — where the agent receives payments; must be proven via EIP-712/ERC-1271:
function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external
function getAgentWallet(uint256 agentId) external view returns (address)
function unsetAgentWallet(uint256 agentId) external
```

Events: `Registered(uint256 indexed agentId, string agentURI, address indexed owner)`, `URIUpdated(...)`, `MetadataSet(...)`. On transfer, `agentWallet` is auto-cleared and must be re-verified by the new owner.

### 4.5 Reputation Registry interface (verbatim, key functions)

```solidity
function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2,
                      string endpoint, string feedbackURI, bytes32 feedbackHash) external
function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external
function appendResponse(uint256 agentId, address clientAddress, uint64 feedbackIndex,
                        string responseURI, bytes32 responseHash) external
function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2)
    external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
    external view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)
```

Feedback is a signed fixed-point `value` (`int128`) + `valueDecimals` (0–18) + optional tags/URIs. The submitter MUST NOT be the agent owner/operator. `initialize(address identityRegistry_)` wires it to the Identity Registry.

### 4.6 Validation Registry interface (verbatim)

```solidity
function validationRequest(address validatorAddress, uint256 agentId,
                           string requestURI, bytes32 requestHash) external
function validationResponse(bytes32 requestHash, uint8 response,
                            string responseURI, bytes32 responseHash, string tag) external
function getValidationStatus(bytes32 requestHash) external view
    returns (address validatorAddress, uint256 agentId, uint8 response,
             bytes32 responseHash, string tag, uint256 lastUpdate)
function getSummary(uint256 agentId, address[] validatorAddresses, string tag)
    external view returns (uint64 count, uint8 averageResponse)
```

`response` is 0–100 (usable as binary 0/100 or a spectrum). Incentives/slashing are out of scope for the registry itself.

### 4.7 0G's ERC-8004 support & registry addresses (verbatim from 0G docs)

> "0G officially supports **ERC-8004** … 0G's ERC-8004 registry deployment is listed in the official [`erc-8004-contracts`](https://github.com/erc-8004/erc-8004-contracts) repository."

**0G Mainnet — Aristotle (chain ID `16661`)**

| Registry | Address |
|----------|---------|
| Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Reputation Registry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |

**0G Galileo Testnet (chain ID `16602`)**

| Registry | Address |
|----------|---------|
| Identity Registry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Reputation Registry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

> Explorers: `chainscan.0g.ai` (mainnet), `chainscan-galileo.0g.ai` (testnet). The docs' 0G tables list Identity + Reputation only (no Validation Registry address given). Verify each address on-chain before use — **⚠️ addresses are copied from docs, not independently verified**.

**Discovery:** registered agents appear on **[8004scan.io](https://8004scan.io)** (an ERC-8004 agent explorer) — `agentId`, chain, endpoints, reputation.

### 4.8 How Agentic ID relates to ERC-8004

- **ERC-7857 (Agentic ID)** = ownership + *encrypted* intelligence + secure transfer.
- **ERC-8004** = public identity + discoverability + reputation/validation.
- An Agentic ID **can carry a corresponding ERC-8004 registration**, so a 0G agent is discoverable across the ecosystem while its intelligence stays governed by ERC-7857. They are complementary layers, and 0G positions itself as supporting both natively.

---

## 5. SDKs & packages for building/minting agents

| Package / repo | Owner | Purpose | Status |
|----------------|-------|---------|--------|
| `@0glabs/0g-ts-sdk` (`^0.3.3`) | 0G (0glabs) | 0G **Storage** SDK (ZgFile, Merkle, upload/download) | ✅ Published (npm) |
| `@0glabs/0g-serving-broker` (`^0.6.5`) | 0G (0glabs) | 0G **Compute** SDK (inference broker, TEE) | ✅ Published (npm) |
| `github.com/0gfoundation/0g-agent-nft` (branch `eip-7857-draft`) | 0G | **Reference implementation of ERC-7857** (the INFT/Agentic ID contracts + oracle scheme) | ✅ Repo exists; branch = draft |
| `github.com/0gfoundation/0g-agent-skills` | 0G | Agent "skills" pack that turns Claude Code / Cursor / Copilot into 0G experts (14 skills, Storage/Compute/Chain). **Not an Agentic-ID minting SDK.** | ✅ Repo exists |
| `@0xgasless/agent` (repo `0xgasless/agent-sdk`) | 0xgasless (3rd party) | **ERC-8004** on-chain identity + **x402** gasless USDC payments for agents; server-managed wallets | ✅ Published (npm) — see §5.1 |
| `@0gfoundation/0g-storage-ts-sdk` | (per integration guide) | Storage SDK used in the Agentic-ID tutorial | **⚠️ UNCONFIRMED on npm** — likely should be `@0glabs/0g-ts-sdk` |
| A dedicated first-party **"mint an Agentic ID"** npm package | — | — | **⚠️ NOT clearly published.** The docs tell you to write/deploy your own ERC-7857 contract (§3) and note "direct minting integrations coming soon." Do not assume a turnkey mint SDK exists. |

> **Do not invent package names.** The only 0G-official, npm-verifiable packages found are `@0glabs/0g-ts-sdk` and `@0glabs/0g-serving-broker`. Everything Agentic-ID-specific is currently repo/reference code, not a released "agent NFT" SDK.

### 5.1 `@0xgasless/agent` (third party) — API surface (verbatim excerpt)

Chain-agnostic TS SDK; gives agents a **server-managed stablecoin wallet**, **x402** per-call USDC payments, and a **gas-sponsored ERC-8004 identity**. Chains: Avalanche, Fuji, Base (USDC). Not 0G-specific.

```ts
client.agents.create(input)              // POST /v1/agent/create
client.agents.getBalance(agentId, opts?) // GET  /v1/agent/balance
client.policy.enableX402()
client.x402.pay(input)                   // sign + settle
client.identity.link({ agentId, chain }) // POST /v1/agent/identity/link  (ERC-8004 mint, gas sponsored)
client.identity.info()                   // facilitator: chains + sponsor addresses
```

> Note: this is the v2 package `@0xgasless/agent`. A legacy `@0xgasless/agent-sdk@0.1.x` (wallet abstraction, LangChain wrappers, CLI) is a **different package**. Related: `@0xgasless/agentkit`.

---

## 6. 0G Agent Network / Marketplace (0G × AIverse "Web 4.0")

Sources: GlobeNewswire press release "**Decentralized AI Company 0G And AIverse Introduce The First Web 4.0 Marketplace – Where AI Agents Own, Trade, and Evolve On-Chain**" (2026-03-04) and its mirrors (Manila Times, Yahoo Finance, StreetInsider, IT Business Net). **⚠️ All press mirrors are Cloudflare-gated; the details below come from search-engine extracts of that release, not a directly fetched page — verify wording against the original.**

### 6.1 What was announced (status: **announced 2026-03-04; on Aristotle Mainnet**)

- 0G + **AIverse** introduced what they call the **first "Web 4.0" marketplace** — "where AI agents **own, trade, and evolve on-chain**."
- It runs on **0G Aristotle Mainnet** and "makes **any AI agent instantly mintable** using cryptographic **Agentic ID (iNFT)** — a digital asset that carries the agent's actual intelligence." (Uses **ERC-7857**.)
- Positioned as bridging "Web3 and Web 4.0": 0G is described as "the first protocol to connect AI developer tools directly to an on-chain ownership layer."
- **⚠️ "Live" status is ambiguous:** the release frames it as an introduction/launch on mainnet; a community post claimed "Web 4.0 … went live" around the same window. Treat as **launched/announced on mainnet 2026-03-04**; confirm current availability before relying on it.

### 6.2 EchoClaw

From the release extracts:

> "**EchoClaw**, 0G's integration, gives agents economic capabilities: their own **wallets**, the ability to **trade on 0G exchanges**, and access to **token bonding curves**. From there, agents can **trade, hold assets, and tokenize Agentic IDs** on the 0G network."

So EchoClaw is the **economic-capability layer** for agents (added, per the release, via "a second command"): agent wallets + exchange trading + bonding-curve access + Agentic-ID tokenization. **⚠️** EchoClaw's exact packaging (CLI command, SDK, or hosted service) is **UNCONFIRMED** from primary docs.

### 6.3 Agent wallets, tokenizing & trading agents

- Each agent can hold its **own wallet**, hold assets, and transact.
- Agents are **tokenized as Agentic IDs** (ERC-7857) — "the token standard 0G developed specifically for AI agent ownership — with **direct minting integrations coming soon**."
- Bonding curves provide a trading/price-discovery mechanism for agent tokens.

### 6.4 Coding-assistant integrations

> "0G's tools plug directly into the most popular AI coding assistants — including **Claude Code, Cursor, Windsurf, and Codex** — connecting them to decentralized AI infrastructure."

This aligns with the open-source **`0g-agent-skills`** repo (Claude Code / Cursor / Copilot integration for 0G Storage/Compute/Chain).

### 6.5 "AgentPad"?

- **No product literally named "AgentPad" was confirmed** in any primary 0G source. **⚠️ UNCONFIRMED.**
- 0G *does* appear to run an **"Agent Launchpad"** — a catalog at `app.0g.ai/agent-launchpad` (surfaced via search; the SPA itself is not directly fetchable, so its exact scope/one-click-deploy claims are **⚠️ UNCONFIRMED**).
- Bottom line: if you saw "AgentPad," it is most plausibly a colloquial reference to **0G Agent Launchpad**; do not treat "AgentPad" as an official product name without confirmation.

### 6.6 What AIverse is

**⚠️ UNCONFIRMED / thin:** the release names **AIverse** as 0G's launch partner for the marketplace but the extracts do not give a crisp definition. Described only as a co-introducer of the Web 4.0 agent marketplace. Verify against the original release / AIverse's own site.

---

## 7. Network reference (for building)

| Network | RPC | Chain ID | Explorer |
|---------|-----|----------|----------|
| Testnet (Galileo) | `https://evmrpc-testnet.0g.ai` | **16602** | `https://chainscan-galileo.0g.ai` |
| Mainnet (Aristotle) | `https://evmrpc.0g.ai` | **16661** | `https://chainscan.0g.ai` |

Testnet faucet: `https://faucet.0g.ai`. Storage SDK `@0glabs/0g-ts-sdk` `^0.3.3`; Compute SDK `@0glabs/0g-serving-broker` `^0.6.5`; `ethers` v6 only. (Source: `0g-agent-skills` README.)

---

## 8. Sources

- 0G docs (raw markdown, `github.com/0glabs/0g-doc`, `main`):
  - `docs/concepts/agentic-id.md`
  - `docs/developer-hub/building-on-0g/agentic-id/overview.md`
  - `docs/developer-hub/building-on-0g/agentic-id/integration.md`
  - `docs/developer-hub/building-on-0g/agentic-id/erc7857.md`
  - `docs/developer-hub/building-on-0g/agentic-id/erc8004.md`
- ERC-7857 reference implementation: `github.com/0gfoundation/0g-agent-nft` (branch `eip-7857-draft`, README) · EIP PR `github.com/ethereum/EIPs/pull/7857`
- ERC-8004 spec: `github.com/ethereum/ERCs` → `ERCS/erc-8004.md` (Draft, created 2025-08-13) · `eips.ethereum.org/EIPS/eip-8004` · reference contracts `github.com/erc-8004/erc-8004-contracts` · explorer `8004scan.io`
- `github.com/0gfoundation/0g-agent-skills` (README)
- `github.com/0xgasless/agent-sdk` (`@0xgasless/agent` README)
- Marketplace: GlobeNewswire release 2026-03-04 "0G And AIverse Introduce The First Web 4.0 Marketplace" (globenewswire.com/news-release/2026/03/04/3249474; mirrors: manilatimes.net, finance.yahoo.com, streetinsider.com, itbusinessnet.com) — **accessed via search extracts only (pages Cloudflare-gated)**
- 0G blog "0G Introducing ERC-7857" (`0g.ai/blog/0g-introducing-erc-7857`) — **Cloudflare-gated (403), not fetched**; content cross-covered by the reference-impl README and docs above.

*End of vendored reference. Anything marked ⚠️ must be reverified against live sources before production use.*
