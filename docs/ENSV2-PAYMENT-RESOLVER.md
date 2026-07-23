# ENSv2 Payment Resolver — ENS as a live payment endpoint

> A brand-new way to do ENS, built on the ENSv2 "your name, your registry" model
> ([ENS Blog: A Deeper Dive into the ENSv2 Architecture](https://ens.domains/blog/post/ensv2-architecture)).

## The idea in one line

`pay.<merchant>.eth` is **not a stored address** — it is a **resolver that answers from
the merchant's current on-chain state**. Change your payout on the router and the name
resolves to the new address on the very next query, with **zero re-issuance**.

## Why ENSv2 makes this new

ENSv1 is one flat registry: a name is a static row mapping `name → address`, written once.
ENSv2 gives **every name its own registry and its own resolver**, and resolution **walks the
hierarchy to the deepest resolver**. That lets a merchant own their registry (the "UserRegistry
proxy" in the ENS talk) and point the `pay` label's resolver at the **Access0x1 Payment
Resolver** — turning a name from a *lookup* into a *programmable payment endpoint*.

Contrast with the existing (still-supported) ENS seams in this repo:

| | Old (ENSv1 / Namestone) | New (ENSv2 Payment Resolver) |
| --- | --- | --- |
| Records | **static** text written once via Namestone | **live**, computed from the router at query time |
| Payout | a stored address | `router.merchants(id).payout`, read on every query |
| Update | re-issue the name | none — change the router, the name follows |
| Owner | Namestone parent | the merchant's **own** ENSv2 registry |

## What ships in this repo

- **`src/ens/Access0x1PaymentResolver.sol`** — a custom ENS resolver implementing the standard
  resolution profile (`addr(bytes32)`, `addr(bytes32,uint256)` ENSIP-9/11, `text(bytes32,string)`,
  `resolve(bytes,bytes)` ENSIP-10 wildcard). Every read is a live `router.merchants(id)` lookup.
  A name is bound to a seat with `bindName(node, merchantId)`, authorized **live** against
  `router.merchants(id).owner` — the same consent gate `Access0x1SponsorRegistry` uses, so a name
  can never be bound to a seat its caller does not own. View-only, zero custody, UUPS (the
  `ChainRegistry` template). Tests: `test/unit/Access0x1PaymentResolver.t.sol`.
- **`web/lib/ens/ensv2.ts`** — the off-chain twin: given a settlement chain + merchant seat, it
  reads the live merchant and produces the same `addr` + `com.access0x1.*` text records the
  on-chain resolver computes. Fail-soft: unknown seat / unconfigured chain / RPC error ⇒ `null`,
  never a fabricated address. Tests: `web/lib/ens/__tests__/ensv2.test.ts`.
- **`web/app/api/ens/resolve/route.ts`** — the **CCIP-Read gateway** data endpoint that serves
  those live records over HTTP (for the common case where the ENS name lives on mainnet while
  settlement is on an L2/testnet). Includes a `GET {configured}` capability probe. Tests:
  `web/app/api/ens/resolve/__tests__/route.test.ts`.

## Per-chain money-path guard

The multichain `addr(node, coinType)` answers **only for this chain's ENSIP-11 coinType**
(mainnet ⇒ 60); any other coinType returns empty bytes. A name therefore never hands a client a
payout address that lives on a different chain — mirroring the coinType law in `web/lib/ens.ts`.

## The `com.access0x1.*` schema (one identical set across all three issuers)

`merchantId` · `router` · `chainId` · `pricingCurrency` (always `USD`) · `payout`. Kept in
lockstep between the on-chain resolver's `_KEY_*` constants, `SUBNAME_TEXT_KEYS` in
`web/lib/ens-subnames.ts`, and `PAYMENT_TEXT_KEYS` in `web/lib/ens/ensv2.ts`.

## Configuration (fail-soft)

All env-gated in `.env.example` under the ENS section: `NEXT_PUBLIC_ENSV2_ROOT_REGISTRY`,
`NEXT_PUBLIC_ENSV2_ETH_REGISTRY`, and per-chain `NEXT_PUBLIC_ENSV2_RESOLVER_<chainId>`. Blank ⇒
the ENSv2 seam is OFF and the app falls back to the existing Namestone + Universal-Resolver path.
ENSv2 is **alpha and mainnet-only** (Namechain was cancelled Feb 2026) — every address carries a
"CONFIRM from the ENS docs" note and is never hardcoded.

## Honest scope

The on-chain resolver and the live-records gateway are real code with tests. The **signed
EIP-3668 wrapper** (an `OffchainLookup` answer signed for on-chain verification) is the declared
next rung — it needs an operator signer key and is **not implied live**; the on-chain resolver is
the trust-minimized source of truth.

## AI track — `agent.<merchant>.eth`

Under the merchant's own ENSv2 registry, an `agent.<merchant>.eth` subname gives an AI agent a
verifiable, self-sovereign ENS identity backed by its on-chain `SessionGrant` spend mandate
(`web/lib/agent/ensIdentity.ts`, `agentSubname.ts`, and the AP2 agent card). Identity and spend
authority both anchor on-chain; ENS is the name the agent presents.
