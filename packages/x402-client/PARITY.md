# PARITY.md — one contract, two languages

`IAgentPayer` exists twice: the TypeScript `@access0x1/x402-client` and the Python
`access0x1-x402-client`. They are **behaviourally identical**. This document is the
contract both twins are held to. A change to behaviour in one is a bug unless it lands
in the other in the same breath.

The twins differ only where the language forces it (naming case, dataclass vs interface,
sync vs async). None of those differences change *behaviour*.

## 1. The interface

| | TypeScript | Python |
| --- | --- | --- |
| Interface | `IAgentPayer` (interface) | `IAgentPayer` (`Protocol`) |
| Concrete | `Access0x1Payer` | `Access0x1Payer` |
| Core methods | `fetch(url, init?)`, `settle(request)` | `fetch(url, init=None)`, `settle(request)` |
| AP2 extra | `deriveMandate(request)` | `derive_mandate(request)` |
| Async? | `async` (Promises) | sync (blocking) |
| Field case | `pricePerCallUsd` | `price_per_call_usd` → wire `pricePerCallUsd` |

Python attribute names are snake_case for idiom; **every value put on the wire uses the
rail's exact camelCase field name** (`pricePerCallUsd`, `quoteToken`, `sessionId`,
`budgetCap`, `chainId`, `payTo`, …). Nothing is invented on either side — the request
bodies map 1:1 to the real rail endpoints (`/api/agent/pay`, `/api/ap2/mandate`).

## 2. 402 detection (identical)

A response is a payment challenge **iff** its status is `402` **and** its body is a JSON
object carrying a **non-empty `accepts` array** whose entries are objects — the x402 v1
signal (`x402Version` / `accepts` / `error` per the x402 specification).

The parser (`parseChallenge` / `parse_challenge`) guarantees only that `accepts` is
present and non-empty. Individual `PaymentRequirements` fields (`scheme`, `network`,
`maxAmountRequired`, `asset`, `payTo`, `resource`, …) come from an **untrusted** resource
server and are surfaced as-provided, never field-validated.

Anything else at 402 — a plain-text body, empty/missing `accepts`, a non-object entry,
a non-object body — is a **malformed challenge**: the payer raises
`MalformedChallengeError` and **never reaches the rail**. You do not pay a 402 you cannot
recognize.

## 3. Retry semantics (identical)

1. `fetch` makes **exactly one** probe request to the resource (the natural unpaid x402
   request).
2. A **non-402** response is an **unpaid passthrough**: returned as
   `{ paid: false, status, result }`. The payer takes no view on non-payment statuses
   (200, 404, 500, …) — the caller inspects `status`. The rail is **not** called.
3. A **402** triggers **exactly one** settle call to the rail. There is **no automatic
   re-probe, no backoff, no client-side retry loop.** The rail owns the actual x402
   pay-and-retry internally and returns the resource `result`.
4. `settle` maps the rail response to a settlement or throws (§4). `fetch` wraps a
   successful settlement as `{ paid: true, status: 200, result, agent, challenge, settlement }`.

A challenge supplied directly to `settle` is **re-validated** before the rail is called;
a malformed one raises `MalformedChallengeError` with zero rail calls.

## 4. Error taxonomy (identical — never swallowed)

Both twins map the rail's real responses to the same five errors. A money-path failure
is **always** raised, never collapsed into a silent success.

| Condition (rail response) | Error (both twins) | Carries |
| --- | --- | --- |
| 402 body without a valid `accepts` | `MalformedChallengeError` | `body` |
| `402 { error: "BudgetExceeded", spent, cap }` | `BudgetExceededError` | `spent`, `cap` |
| `402 { error: "HumanGateRequired" }` | `HumanGateRequiredError` | — |
| `502 { error: "PaymentRequiredUnresolved" }` | `PaymentUnresolvedError` | `url` |
| any other non-2xx, or `200` without `ok: true` | `PaymentRailError` | `status`, `code`, `detail`, `body` |

`PaymentRailError` is the catch-all for `400 BadRequest`, `401 Unauthorized`,
`500 Internal`, `503 not_configured`, and `502 PrivatePayFailed` (its `code`/`recoverable`
ride in `detail`/`body`). All five errors subclass `X402ClientError`.

## 5. Configuration (identical, explicit)

Constructor args only — **neither twin reads ambient env inside the library**:
`baseUrl` (required), `callerAuth` (→ `x-internal-secret` header, sent only when set),
an injectable transport (`fetchImpl` / `transport`), and `payPath` / `mandatePath`
overrides. The rail's meter is the budget authority; `pricePerCallUsd` is a per-call
ceiling, not a client-held wallet.

## 6. Success-shape mapping

| Rail success | TS field | Python field |
| --- | --- | --- |
| `result` (single) | `settlement.result` | `settlement.result` |
| `results` (nano-loop) | `settlement.results` | `settlement.results` |
| `agent` | `settlement.agent` | `settlement.agent` |
| whole body | `settlement.raw` | `settlement.raw` |

`raw` preserves the full rail body (including forward-compatible fields the typed
surface does not name yet: `rail`, `quote`, `depositTx`, `paymentTx`).

## 7. Test parity

Both suites cover the same behaviours against a mocked transport (no network):

| Behaviour | TS (`test/`) | Python (`tests/`) |
| --- | --- | --- |
| 402 → pay → retry happy path | ✓ | ✓ |
| insufficient-budget surfaced | ✓ | ✓ |
| malformed-402 guard (no rail call) | ✓ | ✓ |
| no-payment-needed passthrough | ✓ | ✓ |
| human-gate / unresolved mapping | ✓ | ✓ |
| nano-loop `count` → `results` | ✓ | ✓ |
| generic rail error (status/code/detail) | ✓ | ✓ |
| supplied malformed challenge refused | ✓ | ✓ |
| challenge parser unit tests | ✓ | ✓ |
| AP2 mandate derive + error | ✓ | ✓ |

Local run at authoring (2026-07-22): **TS 23 passed / 3 files** (vitest 4.1.10),
**Python 26 passed** (pytest 8.4.1, Python 3.9.7). Cite a fresh run at land time.

## 8. When you change one twin

1. Change behaviour in twin A.
2. Update this contract if the behaviour itself changed.
3. Mirror it in twin B **and** its test.
4. Run both suites green before the change is done.
