# access0x1 — the EVM-native Agent OS

> ## Bots a business can run for the rest of its life — trustless and permissionless.

**Own your agent stack on any EVM chain. No new blockchain. No vendor chain.
Storage, identity, payments, ownership — yours.** This folder is the war room for
the build: the brief, the pitch, the protocol, and the shipped state. Positioning is
**competitor-silent** — we never name or compare; we state what we are.

---

## The thesis

Trust in autonomous AI agents is low. We fix that by making every agent action
provable across five pillars — all built from access0x1's own shipped code:

| Pillar | Meaning | Built from |
| --- | --- | --- |
| **Identified** | who the agent is / that a human backs it | World ID gate + `CredentialSbt` + ERC-6551 accounts |
| **Private** | verifiable, provider-independent inference | provider seam (any backend, incl. TEE-attested ones) |
| **Paid** | it earns AND spends, verifiably | x402 seller (`withGateway`) + buyer (`/api/agent/pay`) |
| **Bounded** | it stayed within limits | AP2 mandates + session caps + human-in-the-loop |
| **Un-extractable** | it wasn't front-run / sandwiched | MEV-safe, fail-closed settlement |

**The payoff:** an agent that is all five is an **asset, not a session** — it earns
(x402), its memory + track record are content-addressed and on-chain-anchored, and
ownership rides access0x1's RWA rails (`Receivables`, `RwaShareVault`,
`Access0x1Nft`, ProvenanceRegistry). A business **owns** it and runs it for life —
no gatekeeper can switch it off, no vendor account holds its state.

## The Agent-OS capability map (all shipped in-repo)

| OS primitive | access0x1 syscall | Where |
| --- | --- | --- |
| identity / process owner | World ID gate + SBT + ERC-6551 | `src/CredentialSbt.sol`, `src/Access0x1Account.sol`, `web/lib/agent/identity.ts` |
| permissions / capabilities | AP2 mandates · session caps · HITL | `web/lib/ap2/`, `web/lib/worldid/` |
| I/O — get paid / pay | x402 seller + buyer (USDC, any configured EVM chain) | `web/lib/x402.ts`, `web/app/api/agent/pay/` |
| persistent memory | Walrus blobs (content-addressed) + on-chain anchor | `web/lib/walrus.ts`, `web/lib/agent/stateAnchor.ts` |
| audit / provenance | ProvenanceRegistry (`anchorRelease`) | `src/Access0x1ProvenanceRegistry.sol` |
| model backend | provider-neutral gateway — swap with one env var | `web/lib/ai/aiGateway.ts` |
| wallets (human + agent) | Dynamic — merchant auth + agent MPC server wallet | `web/lib/dynamic.ts`, `web/lib/agent/dynamicAgentWallet.ts` |
| ownership / trade | income-claim NFTs + ERC-4626 shares | `src/Receivables.sol`, `src/RwaShareVault.sol` |

**Runs on any EVM chain** — chain choice is env config
(`NEXT_PUBLIC_X402_*_<chainId>`), not a platform decision.

## Shipped (this branch, gate green at every step)

1. **`e2ce33f` — earn → store → own.** `web/lib/agent/stateAnchor.ts`: after a
   settled x402 payment the receipt is published to Walrus (`blobId`), hashed
   (keccak256 of the exact bytes), and anchored on the ProvenanceRegistry.
   `/api/agent/pay` responses carry `stateAnchor { blobId, blobUrl, contentHash,
   anchorTx, anchored }`. Fail-soft: storage can never block money. OFF by default
   (`AGENT_STATE_ANCHOR=true` + env to enable).
2. **`06d43e4` — the agent's Dynamic MPC wallet is LIVE.** Pinned
   `@dynamic-labs-wallet/node-evm@1.0.81`; `web/lib/agent/dynamicBoot.ts` adapts
   the real SDK (TWO_OF_TWO create, by-address lookup — `AGENT_WALLET_ID` is the
   0x address — metadata-based signing) and builds the paying fetch on Circle's
   `BatchEvmScheme` so the agent signs EIP-3009 against the exact Gateway domain
   the seller verifies. `web/instrumentation.ts` wires it at boot, fail-soft.
3. **`b477d7e` — Dynamic JWT on every tenant write.** `web/lib/authedFetch.ts` +
   the four branding write clients now send `authorization: Bearer <session>` —
   production writes no longer fail closed.

Tests: **1,592 passing** (23 added across the three commits). Full gate
(`typecheck · lint · test · build`) green at each commit.

## Remaining (needs live creds — desktop session)

- **Agent SBT identity:** issue a `CredentialSbt` to the agent's Dynamic wallet
  address (`computeAgentId` binding). Contract + issue/claim flow exist; this is an
  on-chain op, not code.
- **Live e2e:** with real `DYNAMIC_*` env — first boot prints the agent address →
  set `AGENT_WALLET_ID` → a paid call settles, and with `AGENT_STATE_ANCHOR=true`
  the response shows `blobId` + `anchorTx`. Claim `AGENT_REPO_ID` on the registry
  first (admin page).
- **Demo page polish:** surface the agent's Dynamic address + the stateAnchor
  receipt in the UI; drive it headless (Playwright) per BUILD-PROTOCOL.

## The demo loop (what we show)

```
User pays the agent (x402 seller, USDC)      →  the agent earns
Agent pays a priced tool (x402 buyer)        →  the agent spends
Receipt → Walrus blobId → on-chain anchor    →  the agent REMEMBERS, verifiably
Dynamic MPC wallet + SBT identity            →  the agent is SOMEONE
Mandates + caps + optional human approval    →  the agent is BOUNDED
```

One response carries the whole story: `PAYMENT-RESPONSE` + `stateAnchor` +
the agent's address. That's an autonomous economic actor with a provable history —
on plain EVM, with no platform between you and it.

## Honest lines for the stage

- "Your agent's memory is content-addressed on decentralized storage and anchored
  on-chain — verifiable by anyone, owned by you."
- "Your agent has an identity (soulbound), a wallet (Dynamic MPC), an income (x402),
  and a provable history. That's an asset, not a session."
- "It runs on any EVM chain you configure. We didn't build a blockchain — you don't
  need a new one."
- "Swap the model backend with one env var. The OS doesn't care whose model it is."

## Folder guide

- `PRESENTATION.md` — the 3-minute pitch (timed script + slides + fallbacks)
- `BUILD-PROTOCOL.md` — the law: one thing at a time · verify · headless Chrome ·
  explain back
- `EVENT-NOTES.md` — field notes + confirmed facts (✅/⚠️)
- `0G-TOKEN.md` — ecosystem token price snapshot (context only; demo runs on testnet)
- `PLAN.md` — the current approved plan
- `docs/` — vendored protocol/SDK reference material (research, not endorsement)
