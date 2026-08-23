# Feedback: building a payout-swap rail on the Uniswap Trading API

This is developer feedback from wiring the Uniswap Trading API into Access0x1 as a payout
leg. I am the integrator who wrote the rail, so everything below is grounded in the code
that shipped rather than a survey. The rail lives at
[`web/lib/payout-swap/rails/uniswapTradingApi.ts`](web/lib/payout-swap/rails/uniswapTradingApi.ts)
(Base) and
[`web/lib/payout-swap/rails/uniswapClassic.ts`](web/lib/payout-swap/rails/uniswapClassic.ts)
(zkSync Era classic `/swap`).

## Context: where the Trading API sits for us

Access0x1 settles every payment in USDC on-chain, then an async, off-settlement worker
optionally swaps that settled USDC into whatever coin the merchant chose to be paid in — same
chain, non-custodial, the merchant's own wallet signs. The Trading API is the Base rail for
that swap: `POST /quote` for an expected output, then either the gasless UniswapX `POST /order`
(the default) or the classic `POST /swap`. The worker calls `quote` first and enforces a
slippage floor before any execute, so a bad quote costs nothing.

## What worked well

**The gasless UniswapX `/order` shape fits a payout leg almost exactly.** A payout is a
back-office step that runs after money already settled, so a merchant should not have to hold
native gas just to receive their preferred coin. A filler-paid order removes that gas
requirement, and UniswapX running its own auction means the swap is MEV-protected without me
building anything — I default `preferGasless: true` and fall back to classic `/swap` only where
UniswapX has no coverage. For a "receive in any coin" feature that is the difference between a
rail I can turn on for every merchant and one that needs a per-payout gas top-up step.

**Zero-added-fee was a first-class option, not a fight.** Our only monetization is the on-chain
router fee-split, so the swap leg must add nothing on top. I send `customFeeBps: 0` on the
order/swap body and that is the whole story — no minimum, no revenue-share to work around in
code. A rail that lets an integrator take zero fee cleanly is rare, and it mattered here.

**One quote-then-execute shape covered both routes.** `/quote` returns an `amountOut` plus an
opaque `quoteId` that I carry straight into `/order` or `/swap`. Threading one routing id
through both legs kept the rail down to two methods and let me unit-test the request shaping and
the `customFeeBps: 0` assertion fully offline against a mocked transport
([`web/lib/payout-swap/__tests__/rails.test.ts`](web/lib/payout-swap/__tests__/rails.test.ts)).

## What was hard

**No public request/response field reference.** This was the real cost. I wired `/quote`,
`/order`, and `/swap` against an *assumed* body shape — `/quote` as
`{ chainId, tokenIn, tokenOut, amountIn, swapper }` returning `{ amountOut, quoteId }`, and
`/order` | `/swap` as `{ quoteId, swapper, minAmountOut, customFeeBps }` returning `{ txHash }` —
because I could not find a first-party page that pins the exact field names and types. The rail
file carries an `@warn` that marks the base URL, the request body field names, and the `/quote`
vs `/order` vs `/swap` selection as **assumed and unverified**, pending a confirmed schema. I
would rather delete that warning against a published reference than keep guessing.

**The `/order` lifecycle is ambiguous from the outside.** My rail reads a `txHash` off the
`/order` response and treats it as the landed swap. A gasless order that runs an auction is
plausibly asynchronous — submitted, then filled — so a single `txHash` field may be an order
hash to poll rather than a final transaction. I could not confirm which from docs, so the
shipped rail assumes the simplest contract and documents that assumption in place.

**Testnet coverage was hard to confirm.** Our whole build is testnet-only, and I could not find
a clear statement of which testnets the Trading API serves, or how to target Base Sepolia
specifically (base URL, chain-id handling). That gap is the reason the rail stays dormant: I
have the code, not a confirmed testnet endpoint to point it at.

**Auth/key docs were thin.** I inject the key as an `x-api-key` header (see
[`web/lib/payout-swap/deps-from-env.ts`](web/lib/payout-swap/deps-from-env.ts), `makeKeyedFetch`),
which is a guess at the header name. I keep the key strictly server-side and never in the browser
bundle, but I had to assume the header name, whether `/quote` needs the key as well as
`/order` | `/swap`, and how a key maps to an environment or a rate limit.

## Concrete requests

1. A published request/response field reference for `/quote`, `/order`, and `/swap`: exact JSON
   field names, types, and whether amounts (`amountIn`, `amountOut`, `minAmountOut`) are atomic
   integer strings in the token's own decimals. That one page deletes my in-code warning.
2. The canonical base URL per environment plus an explicit list of supported testnets —
   specifically, whether Base Sepolia is served and how a caller targets it.
3. The `/order` response contract and lifecycle: whether the returned hash is a final
   transaction or an order id to poll, and the shape of the "filled" signal.
4. The auth header name and semantics: confirm `x-api-key`, whether `/quote` requires it, and how
   a key maps to environment and rate limits.
5. The fee parameter's exact name and semantics: confirm that a zero-fee value (I send
   `customFeeBps: 0`) is honored as "no additional fee".
6. The signing model per route: what the merchant wallet signs for a gasless `/order` (permit /
   EIP-712 payload) versus a classic `/swap` (raw calldata), and whether the API returns an
   unsigned payload to sign or submits on the caller's behalf.

## Update 2026-07-25: five of the six requests, answered — by docs and a live probe

Everything above was written while integrating **blind**. This week two things changed: the
official reference material became available to us (the published quickstart plus the
`swap-integration` agent skill from `uniswap/uniswap-ai`, now vendored under
[`.agents/skills/swap-integration/`](.agents/skills/swap-integration/SKILL.md)), and we ran a
**live read-only probe** of `POST /quote` with a real key. The rail was then rewritten to the
verified shapes ([`uniswapTradingApi.ts`](web/lib/payout-swap/rails/uniswapTradingApi.ts) —
the in-code `@warn` is now an `@verified`). Scoring my own request list:

1. **Field reference — ANSWERED.** The canonical `/quote` body is
   `{swapper, tokenIn, tokenOut, tokenInChainId, tokenOutChainId, amount, type,
   routingPreference, …}` with the chain ids as **strings** and amounts as atomic integer
   strings; the response nests the output under `quote.output.amount` (CLASSIC) or
   `quote.orderInfo.outputs[]` (UniswapX), with the routing type deciding the execute
   endpoint. Live probe: **HTTP 200, CLASSIC routing, Base mainnet** (read-only; no funds
   moved). My original assumed shape 4xxes — exactly why request #1 mattered.
2. **Base URL + testnets — ANSWERED, with a better outcome than we first thought.**
   `https://trade-api.gateway.uniswap.org/v1` confirmed. Coverage turned out to be
   **per-chain**: our first testnet probe (Base Sepolia, 84532) returned
   `ResourceNotFound: "No quotes available"` for the canonical USDC→WETH pair — but the
   same request on **Ethereum Sepolia (11155111) returned HTTP 200, CLASSIC routing, a
   priced one-hop route and a gas estimate**. So a real testnet surface EXISTS, and it is
   the chain our deployed app calls home. The narrowed ask: a published per-chain
   testnet-coverage list (and, if feasible, Base Sepolia routing) — we found Ethereum
   Sepolia support by probing, not by reading it anywhere.
3. **`/order` lifecycle — PARTLY ANSWERED.** The quickstart confirms: sign and submit the
   order payload, then poll `GET /orders` for status. The exact shape of the "filled" signal
   is still the part we'd like pinned in the reference.
4. **Auth — ANSWERED, plus one gotcha worth documenting.** `x-api-key` confirmed, required on
   `/quote` too, alongside `x-universal-router-version: 2.0` on every call. The gotcha: the
   API's Cloudflare front **rejects some non-browser client signatures with error 1010** —
   a Python `urllib` caller is blocked outright while `curl` and an explicit product
   User-Agent pass. Server-side integrators will hit this; one sentence in the docs would
   save each of them an hour.
5. **Fee semantics — RETIRED.** The canonical body has no integrator-fee field to zero out;
   my `customFeeBps: 0` assumption is gone from the rail. Zero-added-fee is simply the
   default — which is the right default.
6. **Signing model — ANSWERED.** `/swap` returns a **ready-to-sign transaction**
   (`{swap: {to, data, value, chainId, gasLimit}}`) that the caller signs and broadcasts;
   UniswapX orders sign the `permitData` locally and submit the signed order. The rail now
   surfaces that unsigned transaction truthfully instead of pretending a landed hash.

## Status: honest scope

**The full loop is live-proven on Ethereum Sepolia (2026-07-25).** Through the exact
production wiring — `buildPayoutSwapDeps()` → the Trading API rail → `runPayoutSwap()` →
the wallet-owner leg — a real 1-USDC → WETH swap landed:
[`0x936acc13…a24e69`](https://sepolia.etherscan.io/tx/0x936acc13fd35032da86aa7075608131f3c39addb9198d7d5877e54ff51a24e69),
with the fill matching the quoted `amountOut` **to the wei** (533936675387574). Quote legs
are additionally verified read-only on Base + Ethereum mainnet.

One more integration lesson the live run taught, worth a docs sentence: `/check_approval`
covers only the ERC20→Permit2 leg. A funded, ERC20-approved wallet still reverts at the
Universal Router unless the **Permit2→Router** grant exists — normally the signed
`permitData`. For integrators whose signing seam is transaction-based,
`generatePermitAsTransaction: true` on `/quote` returns that grant as a ready-to-sign
`permitTransaction` — landing it before the swap fixed our revert on the first try. The
docs describe the field; connecting it to that exact revert would save the next integrator
the debugging session.

Both rails stay env-gated and fail-soft; absent env, the payout worker degrades to a clean
no-op and the merchant keeps their settled USDC.
