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

## Status: honest scope

This integration is real code, env-gated, and dormant. Both rails go live only once the operator
sets `UNISWAP_TRADING_API_URL` (and, where needed, `UNISWAP_TRADING_API_KEY`); absent that env the
rail resolves to `undefined` and the payout worker degrades to a clean no-op — the merchant simply
keeps their settled USDC. **No live Trading API transaction has been sent yet.** The capture script
[`web/scripts/capture-payout-swap.mts`](web/scripts/capture-payout-swap.mts) drives one real
Base-Sepolia payout-swap through this exact wiring the moment credentials and a confirmed endpoint
exist; the tx hash it prints becomes the first live proof, and this document gets updated to point
at it.
