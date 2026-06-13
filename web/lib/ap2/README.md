# AP2 / A2A interop seam

This directory is the **interop SURFACE** for Access0x1's agent — the additive, off-the-money-path
layer that lets the outside world (Google-ecosystem agents, AP2-aware merchants/gateways) verify our
agent in the nouns of the open agent stack: **A2A** (Linux Foundation — discovery + signed identity)
and **AP2** (FIDO / Apache-2.0 — bounded user-consent mandates).

It is the HYBRID option from `build-specs/agent-verification.adr.md §4`: **keep our self-sovereign,
on-chain core as the enforcing trust root, and add a thin translation seam at the edge.**

## What is the core (real, enforcing, on-chain) vs this seam (interop view)

| The claim | Our enforcing core (canonical) | This seam (interop view) |
|---|---|---|
| "a **verified human**…" | **World ID** — one-human-per-action nullifier (`web/lib/worldid/*`) | surfaced as the mandate `holder` / human-proof note |
| "a **bounded, revocable** agent…" | **SessionGrant** (`src/SessionGrant.sol`) — on-chain budgetCap + expiry + owner-only `revoke()`, ERC-7702/6492/1271 | **AP2 Intent Mandate** (`mandate.ts`) |
| "…the **payment**…" | **x402 / EIP-3009** `transferWithAuthorization` (`web/lib/x402.ts`, `web/lib/agent/payPerCall.ts`) | **AP2 Payment Mandate** referencing the `ap2-x402` rail |
| "…with an **audit trail**." | on-chain `SessionOpened / SessionSpent / SessionRevoked` events | the hash-chained mandate `boundTo` digests |

The verification **truth stays on-chain.** These VCs and the Agent Card are a *wire format* around the
SessionGrant, never a source of truth. A counterparty who distrusts the VC can always fall back to
reading `SessionGrant.remaining(sessionId)` on Arc.

## How a SessionGrant maps to an AP2 Intent Mandate

`sessionGrantToIntentMandate()` reads a SessionGrant authorization and emits a W3C Verifiable
Credential whose `credentialSubject.spendingScope` is the SessionGrant verbatim:

- `budgetCap` / `spent` / `remaining` ← the on-chain budget (uint256 as decimal strings, never JS numbers)
- `token` + `chainId` ← what the budget is denominated in and where it lives
- `expiry` (+ ISO `expiresAt`) ← the time window
- `revocable: true` ← structural: every SessionGrant has an owner-only `revoke()`
- `holder` ← `did:pkh:eip155:{chainId}:{owner}` (the user who set the scope)
- `credentialSubject.id` ← `did:pkh:eip155:{chainId}:{delegate}` (the agent the mandate authorizes)
- `credentialSubject.onChainMandate` ← provenance pointer back to the canonical `sessionId`

`buildCartMandate()` and `buildPaymentMandate()` extend the chain, each **hash-bound** to the previous
(`boundTo.contentDigest` = sha-256 over the canonical JSON of the bound-to mandate). `verifyChainLinks()`
checks the links with **no key** — tampering at any level breaks the next level's digest. The builders
also enforce the bounds (law #5): a cart whose items don't sum, a cart over the remaining budget, or a
payment that doesn't equal the cart total all **throw**, never silently pass.

## API

`POST /api/ap2/mandate` — given `{ grant, cart?, payment?, options? }`, returns the derived mandate
chain. **Pure derivation: no money moves, no secret is read.** Bound-invariant failures surface as a
structured `400`, never a silent `200`.

`GET /.well-known/agent-card.json` — the A2A Agent Card describing the agent, its skills (pay an x402
endpoint, the nano-loop, derive the AP2 mandate), supported auth, and the AP2 + x402 extensions.

## What is REAL vs BOOTH-GATED (honest)

**Real today (pure, unit-tested, deterministic):**
- the SessionGrant → Intent Mandate mapping and the Cart/Payment builders;
- the hash-chain binding + `verifyChainLinks` (sha-256, not a signature — a counterparty can verify the
  chain integrity with no key);
- the bound-invariant enforcement (sum / budget / charge);
- the derivation route and the static Agent Card descriptor.

**Booth-gated / env-keyed (NOT invented here, NOT committed):**
- **The DID method.** We default to `did:web:access0x1.xyz` for the issuer and `did:pkh:eip155:...` for
  the parties. Whether the final method is `did:web` vs `did:pkh` is a deploy/booth decision —
  `mandate.ts` flags it `BOOTH-CONFIRM` and the choice is a one-line override (`options.issuerDid`).
- **The JWS signing key (the cryptographic proof).** Both the mandate `proof` and the Agent Card
  `signatures` are **unsigned stubs** today (law #4 — we never dress an unsigned VC up as signed). The
  `proof.type` is `Ap2UnsignedProofStub` and carries a `contentDigest` (sha-256 of the credential body)
  so a verifier can confirm the eventual JWS covers exactly this content. At deploy a build step reads
  the env-keyed domain key (e.g. `AGENT_CARD_SIGNING_JWK`) and applies a real **RFC-7515 JWS** /
  `DataIntegrityProof`. No key is read, invented, or committed in this seam.

This mirrors the rest of the repo: every booth-uncertain seam (Dynamic MPC signer, Arc constants) is
isolated and labeled `confirm at booth`, so the unit type-checks and is testable before the live values
are pinned.
