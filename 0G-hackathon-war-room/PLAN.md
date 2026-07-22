# The EVM-native Agent OS — access0x1 stands alone

## Context

You deployed the first build, went to the event, and came back with the real
positioning: **access0x1 is everyone's way to replace an AI-chain platform — the
half that matters — without building a blockchain.** Just EVM. Recon confirmed ~2/3
of what those platforms sell already exists in this repo, shipped and tested. The
pitch is **competitor-silent**: we never name or compare — we state what we are.

> **"Own your agent stack on any EVM chain. No new blockchain. No vendor chain.
> Storage, identity, payments, ownership — yours."**

That's "getting away from decentralized in a more decentralized way": a vendor L1 is
a silo wearing a decentralization costume; portable contracts on plain EVM are the
open version. And Dynamic — the company you want to get right — is the wallet layer
throughout: their server wallet signs the agent's x402 payments (already wired in
`web/lib/agent/dynamicAgentWallet.ts`).

Rule for all copy and code comments: **no competitor names, no comparisons.** We
don't slow down to punch; we just ship.

## The Agent-OS capability map (competitor-silent; all EXISTS unless marked NEW)

| Agent-OS capability | access0x1-native provider | Where |
| --- | --- | --- |
| Blob storage, content-addressed | **Walrus** → `publish()` → `blobId` | `web/lib/walrus.ts` |
| On-chain commitment / audit anchor | **ProvenanceRegistry** — `anchorRelease(repoId, cid, tag, merkleRoot)` | `src/Access0x1ProvenanceRegistry.sol` + `web/lib/admin/provenanceRegistry.ts` |
| Agent identity | **SBT** (`CredentialSbt`) + **ERC-6551 token-bound account** (`Access0x1Account`) + `computeAgentId` | `src/CredentialSbt.sol`, `src/Access0x1Account.sol`, `web/lib/agent/identity.ts` |
| Inference (any model backend) | provider-neutral gateway; model call = ~15 isolated lines | `web/lib/ai/aiGateway.ts`; seam in `web/app/api/ai/chat/route.ts` |
| Payments (earn + spend) | **x402** seller (`withGateway`) + buyer (`/api/agent/pay`) in USDC on any configured EVM chain | `web/lib/x402.ts`, `web/app/api/agent/pay/` |
| Agent as tradeable asset | **Receivables** (income claim NFT) + **RwaShareVault** (ERC-4626 shares) | `src/Receivables.sol`, `src/RwaShareVault.sol` |
| Verification / integrity | OracleLib staleness checks + EOA/1271/6492 sig verification + per-agent verification profiles | `src/libraries/OracleLib.sol`, `web/lib/verification/store.ts` |
| Wallets (human + agent) | **Dynamic** — merchant auth (live) + agent MPC server wallet (stub → Thing 2 wires it live) | `web/lib/dynamic.ts`, `web/lib/agent/dynamicAgentWallet.ts` |

**Runs on any EVM chain.** No new blockchain, no vendor L1 — chain choice is env
config (`NEXT_PUBLIC_X402_*_<chainId>`, `SUPPORTED_CHAINS`).

Net-new glue (small): (a) an **agent-state anchor** flow (write receipt/state to
Walrus, anchor `blobId`+hash via ProvenanceRegistry), (b) a tiny **Merkle/hash
helper** (keccak256 of the blob is enough for v1), (c) optional agent-state NFT
wrapper later — NOT in the one-day scope.

## The one-day build (strict one-thing-at-a-time, per BUILD-PROTOCOL.md)

**Thing 1 — CORE: the earn → store → own loop (agent memory, access0x1-native).**
After a settled x402 request in the agent path, persist the receipt/state:
`walrus.publish(receiptJson)` → `blobId`; `keccak256` the payload; anchor via the
existing ProvenanceRegistry client (`anchorRelease(agentRepoId, blobId, tag, hash)`).
Fail-soft best-effort, mirroring `recordPayment` in `web/lib/x402.ts` — a storage
error never blocks the money path. New module `web/lib/agent/stateAnchor.ts`; call it
from the agent route(s). Env: `AGENT_STATE_ANCHOR=true`, `AGENT_REPO_ID`. Tests mock
Walrus + the registry client. **Demo receipt: paid (x402) + stored (blobId) +
anchored (tx) in one response.**

**Thing 2 — get Dynamic RIGHT: wire the agent's server wallet live.** Recon verdict:
client-side Dynamic (merchant auth via `@dynamic-labs/sdk-react-core` 4.93.0, JWT
verification with issuer/audience pinning in `web/lib/branding/tenant.ts`) is solid
and tested — but the agent's **MPC server wallet is a stub**: `@dynamic-labs-wallet/
node-evm` is NOT installed and `setDynamicClientFactory` has no production caller
(tests only), so `/api/agent/pay` throws `ConfigMissing` in any real deployment.
The fix (small, precise):
1. `npm install @dynamic-labs-wallet/node-evm` (pin it) in `web/`.
2. Add a boot module (`web/instrumentation.ts`) that injects the real client factory
   via `setDynamicClientFactory(...)` and the real `x402-fetch` wrapper via
   `setWrapFetchWithPayment(...)` — turning `dynamicAgentWallet.ts` + `x402Signer.ts`
   from mocked seams into a live Dynamic MPC wallet that signs EIP-3009.
3. Verify the "BOOTH-CONFIRM" method names (`authenticateApiToken`,
   `createWalletAccount`, `getWalletAccount`, `signTypedData`) against the installed
   SDK; adjust the narrow `DynamicEvmWalletClient` interface if they drifted.
4. Surface the agent's Dynamic-provisioned address in the demo UI next to receipts.
Env needed: `DYNAMIC_ENVIRONMENT_ID`, `DYNAMIC_AUTH_TOKEN`, `WALLET_PASSWORD`,
(`AGENT_WALLET_ID` after first boot). Existing tests keep passing (they inject mocks).

**Thing 2b (fast follow, same day if time) — thread the Dynamic JWT through write
clients.** `web/lib/branding/client.ts` (saveBranding / saveCheckoutMode /
attachOnChain / uploadLogo) posts with no Authorization header, so production writes
fail closed (`BRANDING_REQUIRE_VERIFIED_WRITES` defaults on). Add a shared
`authedFetch` that attaches `getAuthToken()` (pattern already proven in
`GatewayBalanceCard.tsx`) and use it in those clients. This makes the Dynamic auth
integration production-true, not booth-only.

**Thing 3 — identity: mint the agent's SBT.** Issue a `CredentialSbt` credential to
the agent's Dynamic wallet address (`computeAgentId` as the subject binding) so every
receipt traces to an identified agent. Reuse the existing issue/claim flow; no new
contract.

**Thing 4 (stretch) — provider freedom, silently.** The `AI_PROVIDER` seam stays:
any OpenAI-compatible or Anthropic backend plugs in per-request. No competitor named
anywhere; the demo line is simply "swap the model backend with one env var — the OS
doesn't care." TEE-attested inference remains available through the seam for whoever
provides it; we don't build one and we don't advertise anyone's.

Each thing: gate green (`npm run typecheck && npm run lint && npm test && npm run
build`), behavior proven (headless Chrome for UI), one focused commit, explain-back,
then next.

## Reuse (do NOT rebuild)

- x402 seller/buyer: `web/lib/x402.ts` (`withGateway`), `web/app/api/agent/pay/`
- Walrus client: `web/lib/walrus.ts` (`publish`, `read`, `urlFor`)
- Registry client: `web/lib/admin/provenanceRegistry.ts` (claim/anchor via wallet)
- Agent identity: `web/lib/agent/identity.ts`, `src/CredentialSbt.sol`
- Dynamic agent wallet: `web/lib/agent/dynamicAgentWallet.ts`
- Meters/fail-soft patterns: `web/app/api/docs-ask/route.ts`

## War room updates (same branch, `0G-hackathon-war-room/`)

- `README.md`: reframe competitor-silent — headline becomes *"Own your agent stack
  on any EVM chain. No new blockchain. No vendor chain."* Replace the 0G-centric
  sections with the Agent-OS capability map above. Keep the vendored `docs/` (they
  remain useful reference; reference material is not endorsement).
- `PRESENTATION.md`: demo beats = the Thing-1 loop (paid → stored → anchored in one
  response) + the agent's Dynamic wallet address on screen; no competitor mentions.
- `PLAN.md`: refresh to this plan.

## Verification (updated for the Things)

1. Gate green in `web/` after each Thing (`typecheck · lint · test · build`).
2. **Thing 1 e2e:** settled x402 request returns a receipt containing `blobId` +
   anchor tx; `walrus.read(blobId)` round-trips; `latestRelease(agentRepoId)` shows
   the anchor. Headless-Chrome pass on the demo page.
3. **Thing 2 e2e:** with real `DYNAMIC_*` env, `agentAddress()` resolves a live MPC
   wallet address; `/api/agent/pay` completes a real x402 settle signed by the
   Dynamic wallet (testnet). Unit tests (mock-injected) stay green.
4. **Thing 2b:** a branding write with a logged-in Dynamic session succeeds in
   production mode (`BRANDING_REQUIRE_VERIFIED_WRITES=true`).
5. Push each Thing to `claude/lisbon-0g-ai-builder-plan-vnt3q8` as one focused commit.

## Honest lines for the stage (competitor-silent)

- "Your agent's memory is content-addressed on decentralized storage and anchored
  on-chain — verifiable by anyone, owned by you."
- "Your agent has an identity (soulbound), a wallet (Dynamic MPC), an income (x402),
  and a provable history. That's an asset, not a session."
- "It runs on any EVM chain you configure. We didn't build a blockchain — you don't
  need a new one."
- "Swap the model backend with one env var. The OS doesn't care whose model it is."
