<!--
  SDK-REFERENCE — the complete API surface of `@access0x1/react`.

  The counterpart to QUICKSTART: QUICKSTART teaches the 5-minute happy path;
  this file is the exhaustive reference for every export in
  packages/react/src/index.ts — types, hooks, the client factory, the chain
  registry, the typed errors, and the clear-signing helpers.

  House rules honored here:
  - Grounded in the shipped barrel (packages/react/src/index.ts). Every signature
    and field below is read from source, not paraphrased from memory.
  - Addresses are NOT restated by hand. The SDK never hardcodes a router address
    (guardrail #7); examples that need one cite docs/CHAIN-ADDRESSES.md / the
    README Deployments table. (LAW #4: an address that isn't on-chain isn't claimed.)
  - Truth-in-copy: no "instant" claim, and no claim that the payment costs nothing — no
    "no-gas" / zero-gas framing anywhere, including Arc, because that promise isn't
    reliably deliverable.

  New file — does not modify any existing docs/*.md content (only adds a row to
  the START-HERE doc map).
-->

# SDK reference — `@access0x1/react`

The complete API surface of the React SDK. If you just want a working payment in five
minutes, start with [QUICKSTART.md](./QUICKSTART.md); come back here when you need the
exact signature of a hook, the shape of a type, or the full list of error codes.

`@access0x1/react` is a **viem/wagmi-native, zero-custody** payment SDK. You drop
[`<PayButton>`](#paybutton) into a React app to accept USD-priced crypto in a single
on-chain transaction (buyer → router → merchant + treasury, same block). **The SDK never
holds keys or funds**, and it **never hardcodes a router address** — you always pass your
settlement chain's `Access0x1Router` in as a prop.

- **Source of truth:** [`packages/react/src/index.ts`](../packages/react/src/index.ts) — the public barrel. Everything documented here is exported from there.
- **Peer dependencies:** `react` (`^18 || ^19`), `viem` (`^2.35`), and `wagmi` (`^3`, optional — you can pass viem clients directly).
- **No SDK config / env of its own.** Every value is a component or hook prop.

## Contents

- [Install](#install)
- [Exports at a glance](#exports-at-a-glance)
- [Components](#components) — [`<PayButton>`](#paybutton)
- [Hooks](#hooks) — [`usePayment`](#usepayment) · [`useMerchant`](#usemerchant) · [`usePaymentLanes`](#usepaymentlanes)
- [The client seam](#the-client-seam) — [`clientFromViem`](#clientfromviem) · [`Access0x1Client`](#access0x1client)
- [Types](#types) — [`PaymentReceipt`](#paymentreceipt) · [`MerchantInfo`](#merchantinfo) · [`PaymentStatus`](#paymentstatus) · [callback payloads](#paybutton-callback-payloads) · [constants](#constants)
- [Errors](#errors) — [`Access0x1Error`](#access0x1error) · [`Access0x1ErrorCode`](#access0x1errorcode) · [`toAccess0x1Error`](#toaccess0x1error) · [error-handling flows](#error-handling-flows)
- [The chain registry](#the-chain-registry) — [`CHAINS`](#chains) · [`getChainConfig`](#getchainconfig) · [`ChainConfig`](#chainconfig)
- [ABI fragments](#abi-fragments)
- [Clear signing (ERC-8213)](#clear-signing-erc-8213)

---

## Install

Access0x1 is **not published to any npm registry** — consume `@access0x1/react` as a git dependency:

```jsonc
// package.json
"dependencies": {
  "@access0x1/react": "github:Access0x1/Access0x1#main"   // or pin a commit SHA
}
```

```bash
npm install viem wagmi   # peers your app provides
```

Prefer to vendor it? Copy `packages/react/` in. See the
[QUICKSTART install note](./QUICKSTART.md#install) for details.

---

## Exports at a glance

Everything below is a named export of `@access0x1/react` (`value` = runtime export,
`type` = type-only export):

| Export | Kind | What it is |
| --- | --- | --- |
| [`PayButton`](#paybutton) | value | The drop-in payment button component. |
| [`PayButtonProps`](#paybutton) | type | Its props. |
| [`usePayment`](#usepayment) | value | The core quote → (approve) → pay → receipt hook. |
| `UsePaymentOptions`, `UsePaymentReturn` | type | Its options + return shape. |
| [`useMerchant`](#usemerchant), [`isUnregistered`](#usemerchant) | value | Read the on-chain `Merchant` record; test for the unregistered sentinel. |
| `UseMerchantReturn` | type | Its return shape. |
| [`usePaymentLanes`](#usepaymentlanes) | value | Read an ERC-6909 lane balance. |
| `UsePaymentLanesReturn` | type | Its return shape. |
| [`clientFromViem`](#clientfromviem) | value | Build the SDK client from viem public + wallet clients. |
| [`Access0x1Client`](#access0x1client), `MinimalPublicClient`, `MinimalWalletClient` | type | The client seam + the minimal viem shapes it accepts. |
| [`Access0x1Error`](#access0x1error), [`toAccess0x1Error`](#toaccess0x1error) | value | The typed error class + the normalizer. |
| [`Access0x1ErrorCode`](#access0x1errorcode) | type | The switchable error-code union. |
| [`CHAINS`](#chains), [`getChainConfig`](#getchainconfig) | value | The settlement-chain registry + a by-id lookup. |
| [`ChainConfig`](#chainconfig), `ChainKey` | type | A chain entry + the registry key union. |
| [`PaymentReceipt`](#paymentreceipt), [`MerchantInfo`](#merchantinfo), [`PaymentStatus`](#paymentstatus), `Hex` | type | The on-chain shapes + the address/hash alias. |
| [`NATIVE_TOKEN`, `ZERO_BYTES32`](#constants) | value | The native-token sentinel + the empty-`orderId` sentinel. |
| [`ROUTER_ABI`, `ERC20_ABI`, `LANES_ABI`](#abi-fragments) | value | Raw ABI fragments for fully custom integrations. |
| [`calldataDigest`, `encodePaymentCalldata`, `paymentCalldataDigest`](#clear-signing-erc-8213) | value | ERC-8213 clear-signing helpers. |
| `PaymentCalldataParams` | type | The payment intent the clear-signing helpers digest. |

> Not exported from the barrel but referenced in callbacks: `QuoteResult`, `SettledResult`,
> and `PayButtonDisabledReason` are part of the `<PayButton>` surface (declared in
> [`types.ts`](../packages/react/src/types.ts)) — documented under
> [callback payloads](#paybutton-callback-payloads).

---

## Components

### `<PayButton>`

The drop-in payment button — a thin UI shell over [`usePayment`](#usepayment). It is a
single `<button>` with no modal or bundled CSS; the host app keeps full layout control via
`className`. It shows a spinner while confirming, an inline confirmation on success, and a
typed error message on failure.

For the full integration walkthrough and the live prop snippets, see
[QUICKSTART → React SDK](./QUICKSTART.md#1--react-sdk-access0x1react). The complete prop list:

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| `merchantId` | `bigint` | ✅ | The id from `registerMerchant`. |
| `usdAmount` | `number` | ✅ | Human USD price, e.g. `29.0`. |
| `routerAddress` | `Hex` | ✅ | The deployed `Access0x1Router` on your settlement chain — **never hardcoded by the SDK**, always your prop. |
| `client` | [`Access0x1Client`](#access0x1client) | — | From [`clientFromViem`](#clientfromviem). Omit and the button disables itself (reason `no-client`). |
| `token` | `Hex` | — | ERC-20 (e.g. USDC) to pay in; omit for native pay. |
| `orderId` | `string` | — | Your human-readable order reference (`keccak256`'d to bytes32 internally). |
| `label` | `string` | — | Idle-state label. Default `"Pay with Crypto"`. |
| `className` | `string` | — | Your CSS / Tailwind class. |
| `allowedTokens` | `readonly Hex[]` | — | The router's pay-in allowlist as the host already knows it. If set and `token` is absent from it, the button disables itself (reason `token-not-allowed`) instead of clicking into a revert. |
| `priceFeedConfigured` | `boolean` | — | Defaults to `true`. Pass `false` for a token the host knows has no configured feed → disables (reason `no-feed`). |
| `explorerBaseUrl` | `string` | — | Block-explorer base URL; threads into [`SettledResult.explorerUrl`](#paybutton-callback-payloads) and renders the success tx hash as a link. |
| `disabledLabel` | `string` | — | Override the disabled-state copy. Defaults to a reason-specific message. |
| `onQuote` | `(result: QuoteResult) => void` | — | Fires on every quote attempt (success or failure). See [`QuoteResult`](#paybutton-callback-payloads). |
| `onSettled` | `(result: SettledResult) => void` | — | Fires once the payment settles, with the receipt + a ready explorer URL. |
| `onSuccess` | `(receipt: PaymentReceipt) => void` | — | The decoded [`PaymentReceipt`](#paymentreceipt) on success. |
| `onError` | `(err: Access0x1Error) => void` | — | The typed [`Access0x1Error`](#access0x1error) on failure. |
| `renderSuccess` | `(receipt) => ReactNode` | — | Override the inline success node. |
| `renderDisabled` | `(reason) => ReactNode` | — | Override the disabled node. |

**Graceful degradation.** The drop-in promise is that a click never dead-ends in a
guaranteed revert. When the host declares (via `allowedTokens` / `priceFeedConfigured`)
or a live `quote()` probe reveals that paying would revert, `<PayButton>` renders a
*disabled* button with truthful, reason-specific copy. The reasons are the
`PayButtonDisabledReason` union — see [callback payloads](#paybutton-callback-payloads).

---

## Hooks

All three hooks take an optional [`Access0x1Client`](#access0x1client). When `client` is
`undefined`, a read hook stays idle (no read fired) and `usePayment.pay()` fails fast with a
`NO_WALLET` error — so you can render before the wallet is ready without guarding every call.

### `usePayment`

The engine behind `<PayButton>`. Use it directly to build a fully custom checkout UI.
It drives one same-chain payment end-to-end: **quote → (approve, ERC-20 only) → pay → watch
receipt**, and is zero-custody by construction (the only writes it issues are `approve` for
the exact gross to the router, and `payNative` / `payToken`).

```ts
function usePayment(options: UsePaymentOptions): UsePaymentReturn;
```

**`UsePaymentOptions`**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `merchantId` | `bigint` | ✅ | The id from `registerMerchant`. |
| `usdAmount` | `number` | ✅ | Human USD price (e.g. `29.0`); converted to 8-decimal internally. |
| `routerAddress` | `Hex` | ✅ | The deployed `Access0x1Router` (required — never hardcoded). |
| `token` | `Hex` | — | The ERC-20 to pay in; omit for native pay. |
| `orderId` | `string` | — | A human order reference; `keccak256`'d to bytes32. |
| `client` | [`Access0x1Client`](#access0x1client) | — | The viem-backed client. Without it, `pay()` fails with `NO_WALLET`. |
| `onSuccess` | `(receipt: PaymentReceipt) => void` | — | Called once with the decoded receipt. |
| `onError` | `(err: Access0x1Error) => void` | — | Called with the typed error on any failure. |

**`UsePaymentReturn`**

| Field | Type | Notes |
| --- | --- | --- |
| `status` | [`PaymentStatus`](#paymentstatus) | The current lifecycle state. |
| `quote` | `bigint \| null` | The quoted token amount from `router.quote()`; `null` before the first quote. |
| `quoteError` | [`Access0x1Error`](#access0x1error) `\| null` | A quote-specific error (feed stale, token not allowed). |
| `error` | [`Access0x1Error`](#access0x1error) `\| null` | A general error for any failed step. |
| `pay` | `() => Promise<void>` | Run the full pay flow. Stable identity (safe to use in deps). |
| `txHash` | `Hex \| null` | The settlement tx hash, once broadcast. |
| `receipt` | [`PaymentReceipt`](#paymentreceipt) `\| null` | The decoded `PaymentReceived` receipt, once settled. |
| `reset` | `() => void` | Reset back to `idle` (clears `txHash`, `receipt`, errors). |

**Two safety properties worth knowing:**

1. **The receipt is bound to *this* payment's `orderId`.** The `PaymentReceived` event filter
   can only match the indexed `merchantId` + buyer, and `orderId` is not indexed — so without
   this bind, a concurrent same-buyer/same-merchant payment for a *different* order (e.g. a
   second checkout tab) could resolve the wrong receipt. The hook checks `orderId` exactly
   before resolving.
2. **The receipt watch races a 120-second timeout.** If the event never arrives or its log
   can't be decoded, the flow fails loud (a normalized error) instead of hanging forever; the
   watcher is always torn down.

```tsx
import { usePayment, clientFromViem } from '@access0x1/react';
import { usePublicClient, useWalletClient } from 'wagmi';

function Checkout() {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const client = clientFromViem(publicClient!, walletClient ?? undefined);

  const { pay, status, quote, txHash, receipt, error, reset } = usePayment({
    merchantId: 42n,
    usdAmount: 29.0,
    // routerAddress (and the optional `token`) come from YOUR chain — read them from
    // docs/CHAIN-ADDRESSES.md / the README Deployments table; the SDK never hardcodes one.
    routerAddress: process.env.NEXT_PUBLIC_ROUTER_ADDRESS as `0x${string}`,
    client,
    onSuccess: (r) => console.log('paid', r.txHash),
    onError: (e) => console.error(e.code, e.message),
  });

  const busy = status === 'quoting' || status === 'confirm' || status === 'pending';
  return (
    <button onClick={() => void pay()} disabled={busy}>
      {status === 'idle' && 'Pay with Crypto'}
      {busy && 'Confirming…'}
      {status === 'success' && 'Paid'}
      {status === 'error' && error && `Error: ${error.code}`}
    </button>
  );
}
```

### `useMerchant`

Read-only. Fetches the on-chain `Merchant` record via the router's public `merchants(id)`
getter and maps it to a [`MerchantInfo`](#merchantinfo). An unregistered id resolves to an
all-zero struct — surfaced faithfully (`owner === address(0)`) **without throwing**, so you can
render a clean "merchant not found" state.

```ts
function useMerchant(
  routerAddress: Hex,
  merchantId: bigint,
  client?: Access0x1Client,
): UseMerchantReturn;
```

**`UseMerchantReturn`**

| Field | Type | Notes |
| --- | --- | --- |
| `merchant` | [`MerchantInfo`](#merchantinfo) `\| null` | The mapped record, or `null` while loading / before the first read. |
| `isLoading` | `boolean` | `true` while the read is in flight. |
| `error` | [`Access0x1Error`](#access0x1error) `\| null` | A typed error if the read failed (network / decode) — **not** for an unregistered id. |

Pair it with the exported **`isUnregistered(merchant: MerchantInfo): boolean`** helper to
detect the all-zero sentinel:

```tsx
import { useMerchant, isUnregistered } from '@access0x1/react';

function MerchantBadge({ routerAddress, merchantId, client }) {
  const { merchant, isLoading, error } = useMerchant(routerAddress, merchantId, client);
  if (isLoading) return <span>Loading…</span>;
  if (error) return <span>Couldn’t load merchant: {error.code}</span>;
  if (!merchant || isUnregistered(merchant)) return <span>Merchant not found</span>;
  return <span>Paying merchant #{merchant.id.toString()} {merchant.active ? '' : '(inactive)'}</span>;
}
```

### `usePaymentLanes`

Optional, read-only. Given a credited asset + recipient + chain id, it derives the ERC-6909
lane token id (`laneId`, a pure on-chain function) and reads `balanceOf(owner, id)` from the
`PaymentLanes` contract. It issues **no writes** — lane credits are minted by the
router / cross-chain receiver, never the SDK.

```ts
function usePaymentLanes(
  lanesAddress: Hex,
  owner: Hex,
  asset?: Hex,      // default: NATIVE_TOKEN
  chainId?: bigint, // default: 0n → the contract resolves the active chain
  client?: Access0x1Client,
): UsePaymentLanesReturn;
```

**`UsePaymentLanesReturn`**

| Field | Type | Notes |
| --- | --- | --- |
| `laneId` | `bigint \| null` | The derived ERC-6909 lane token id, or `null` before the first read. |
| `balance` | `bigint \| null` | The recipient's balance in that lane, or `null` before the first read. |
| `isLoading` | `boolean` | `true` while either read is in flight. |
| `error` | [`Access0x1Error`](#access0x1error) `\| null` | A typed error if a read failed. |

---

## The client seam

The hooks never reach into a wagmi config at call time. Instead they consume one narrow
interface — [`Access0x1Client`](#access0x1client) — which you build from your viem clients
with [`clientFromViem`](#clientfromviem). This keeps the SDK auth-agnostic (your wallet/auth
stack stays your concern) and 100% unit-testable with plain object mocks.

### `clientFromViem`

```ts
function clientFromViem(
  publicClient: MinimalPublicClient,
  walletClient?: MinimalWalletClient,
): Access0x1Client;
```

Build an [`Access0x1Client`](#access0x1client) from a viem public client (reads, event
watching, receipt waiting) and an optional wallet client (the connected signer). Omit the
wallet client for read-only usage. With wagmi, pass `usePublicClient()` and
`useWalletClient().data` — a real viem `PublicClient` / `WalletClient` satisfies the minimal
shapes structurally.

```tsx
import { clientFromViem } from '@access0x1/react';
import { usePublicClient, useWalletClient } from 'wagmi';

const publicClient = usePublicClient();
const { data: walletClient } = useWalletClient();
const client = clientFromViem(publicClient!, walletClient ?? undefined);
```

**Chain-sync built in.** Before any write, `clientFromViem` makes the wallet's active chain
match the settlement chain the wallet client is bound to (`walletClient.chain.id`). A buyer on
the wrong network gets a one-tap `wallet_switchEthereumChain` prompt (adding the chain first
via `wallet_addEthereumChain` if the wallet doesn't know it, EIP-1193 code `4902`) instead of a
`ChainMismatchError` dead-end. It's best-effort: if the client can't report or switch its chain,
viem's own guard still applies, and a user-rejected switch surfaces as a typed error.

### `Access0x1Client`

The narrow chain surface the hooks use. Every method maps 1:1 to a viem action — supply a
concrete implementation (from `clientFromViem`) or a mock in tests.

| Member | Signature | Notes |
| --- | --- | --- |
| `account` | `readonly Hex \| undefined` | The connected payer address, if a wallet is connected. |
| `readContract` | `<T>(args: ReadArgs) => Promise<T>` | Read a view/pure function. |
| `writeContract` | `(args: WriteArgs) => Promise<Hex>` | Send a tx; resolves with the tx hash. |
| `waitForTransactionReceipt` | `(args: { hash: Hex }) => Promise<{ blockNumber: bigint }>` | Wait for inclusion. |
| `watchContractEvent` | `(args: WatchArgs) => () => void` | Subscribe to an event; returns an unsubscribe fn. |

The exported `MinimalPublicClient` and `MinimalWalletClient` types describe the smallest viem
shapes `clientFromViem` accepts — handy if you build your own client without wagmi.

---

## Types

All exported from [`packages/react/src/types.ts`](../packages/react/src/types.ts). Every value
that crosses the chain boundary is a `bigint` (token / USD amounts) or a 0x-prefixed hex string
(addresses, hashes) — never a lossy JavaScript `number`.

`Hex` is the shared alias: `type Hex = `0x${string}``.

### `PaymentReceipt`

A decoded `PaymentReceived` event — the canonical on-chain receipt for a settled payment. Field
names and decimals match the router event exactly.

| Field | Type | Notes |
| --- | --- | --- |
| `merchantId` | `bigint` | The merchant that was paid. |
| `buyer` | `Hex` | The buyer (payer) address. |
| `token` | `Hex` | The pay-in token; [`NATIVE_TOKEN`](#constants) for a native payment. |
| `grossAmount` | `bigint` | Gross amount pulled from the buyer, in the token's own decimals. |
| `feeAmount` | `bigint` | Total fee leg (platform + merchant surcharge). |
| `netAmount` | `bigint` | Net amount that landed at the merchant payout. |
| `usdAmount8` | `bigint` | The USD price it settled at, 8-decimal (`$29.00` = `2_900_000_000n`). |
| `orderId` | `Hex` | The opaque order reference echoed from the request; [`ZERO_BYTES32`](#constants) if none. |
| `srcChainSelector` | `bigint` | CCIP-style source chain selector; `0n` for a same-chain payment (the only kind this SDK initiates). |
| `txHash` | `Hex` | The settlement transaction hash. |
| `blockNumber` | `bigint` | The block the payment settled in. |

### `MerchantInfo`

The on-chain `Merchant` record, as returned by the router's `merchants(id)` getter. An
unregistered id resolves to an all-zero struct — treat `owner === address(0)` as "not found"
(use [`isUnregistered`](#usemerchant)).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `bigint` | The merchant id this record was read for. |
| `payout` | `Hex` | Where the merchant's net payments land. |
| `owner` | `Hex` | The only address allowed to update this merchant. |
| `feeRecipient` | `Hex` | Where the fee leg lands; `address(0)` falls back to `payout` at pay time. |
| `feeBps` | `number` | The merchant's optional surcharge in basis points (`50` = 0.50%). |
| `active` | `boolean` | `false` means new payments to this merchant revert. |
| `nameHash` | `Hex` | An identity commitment (no preimage stored on-chain). |

### `PaymentStatus`

The lifecycle of a single payment, surfaced by [`usePayment`](#usepayment):

```ts
type PaymentStatus = 'idle' | 'quoting' | 'confirm' | 'pending' | 'success' | 'error';
```

`idle → quoting → confirm → pending → success` is the happy path; any step may transition to
`error`. `confirm` is the window where the wallet is asking the user to approve the tx;
`pending` is after broadcast, waiting for inclusion.

### `<PayButton>` callback payloads

These are part of the `<PayButton>` surface (declared in `types.ts`); they reach you through the
component's callbacks rather than the barrel:

- **`PayButtonDisabledReason`** — why a disabled button is disabled:
  `'no-client'` (no viem/wagmi client), `'no-feed'` (host declared no Chainlink feed backs this
  token), `'token-not-allowed'` (token absent from `allowedTokens`), `'quote-unavailable'` (a
  live `quote()` probe failed). Used to render truthful disabled copy.
- **`QuoteResult`** — handed to `onQuote` on every quote attempt: `{ merchantId, token, usdAmount8, grossAmount: bigint | null, error: Access0x1Error | null }`. Exactly one of `grossAmount` / `error` is non-null.
- **`SettledResult`** — handed to `onSettled` on settlement: `{ receipt: PaymentReceipt, explorerUrl: string | null }` (the URL is non-null only when you passed `explorerBaseUrl`).

### Constants

| Constant | Type | Value | Notes |
| --- | --- | --- | --- |
| `NATIVE_TOKEN` | `Hex` | `0x0000…0000` (20-byte zero) | The native-coin sentinel: `address(0)` means the chain's native coin (e.g. ETH, or USDC on Arc, where USDC is the native gas token). |
| `ZERO_BYTES32` | `Hex` | `0x0000…0000` (32-byte zero) | The bytes32 zero used for an absent `orderId`. |

---

## Errors

The SDK normalizes every router revert and wallet error into one typed class, so your UI can
branch on a stable, switchable `code` instead of parsing unstructured text. All exported from
[`packages/react/src/errors.ts`](../packages/react/src/errors.ts).

### `Access0x1Error`

```ts
class Access0x1Error extends Error {
  readonly code: Access0x1ErrorCode; // a stable, switchable code
  readonly cause: unknown;           // the original thrown value, for debugging
}
```

Every error the hooks surface (`error`, `quoteError`, the `onError` payload) is an
`Access0x1Error`. Branch on `.code`; show `.message` (a friendly, buyer-safe string); inspect
`.cause` when debugging.

### `Access0x1ErrorCode`

The complete set of codes the SDK recognizes:

| Code | Meaning | Typical fix |
| --- | --- | --- |
| `UNDERPAID` | Payment was below the quoted amount (price moved). | Let the SDK quote first; don't override the amount. |
| `FEE_ON_TRANSFER_TOKEN` | The token deducts a fee on transfer (rejected by design). | Pay in a standard token (USDC). |
| `MERCHANT_INACTIVE` | The merchant exists but isn't accepting payments. | The merchant owner re-activates it. |
| `MERCHANT_NOT_FOUND` | The id isn't registered on that router/chain. | Register on the same chain as `routerAddress`; check [`isUnregistered`](#usemerchant). |
| `TOKEN_NOT_ALLOWED` | The pay-in token isn't on the router's allowlist. | Pay in an allowlisted token (USDC). |
| `STALE_PRICE` | The Chainlink feed is stale, or the L2 sequencer is down / in its grace period. | Try again shortly; or pick a token with a live feed on that chain. |
| `INVALID_PRICE` | The feed returned an invalid price. | Try again shortly. |
| `ZERO_AMOUNT` | A payment amount of zero is not allowed. | Use a positive `usdAmount`. |
| `USER_REJECTED` | The buyer dismissed the wallet prompt. | Expected — surface a "try again"; call `reset()`. |
| `WRONG_NETWORK` | The wallet is on a different chain than `routerAddress`. | Switch to the settlement chain (`clientFromViem` prompts this automatically). |
| `NO_WALLET` | No wallet client / no connected account. | Connect a wallet before calling `pay()`. |
| `UNKNOWN` | Anything not matched above (the original message is preserved). | Inspect `.cause`. |

> The three sequencer guards (`OracleLib__SequencerDown`,
> `OracleLib__SequencerGracePeriodNotOver`) and `OracleLib__StalePrice` all normalize to the
> single `STALE_PRICE` code with a guard-specific `.message` — so you branch on one code but
> can still show the buyer exactly why pricing paused.

### `toAccess0x1Error`

```ts
function toAccess0x1Error(err: unknown): Access0x1Error;
```

The normalizer the hooks use internally. It maps a viem custom-error revert
(`data.errorName`), a user rejection (EIP-1193 `4001`), or a chain mismatch
(`ChainMismatchError`) to a typed `Access0x1Error`; anything else becomes `UNKNOWN` with the
original message preserved. Call it yourself if you drive the router outside the hooks (e.g. via
the [ABI fragments](#abi-fragments)) and want the same typed surface:

```ts
import { toAccess0x1Error } from '@access0x1/react';

try {
  await client.writeContract({ /* a raw router call */ });
} catch (raw) {
  const err = toAccess0x1Error(raw); // → Access0x1Error with a stable .code
  if (err.code === 'USER_REJECTED') return; // benign
  showToast(err.message);
}
```

### Error-handling flows

**1. Branch on `.code` in `onError` (the `<PayButton>` path):**

```tsx
<PayButton
  merchantId={42n}
  usdAmount={29.0}
  routerAddress={routerAddress} // your chain's router — see docs/CHAIN-ADDRESSES.md
  client={client}
  onError={(err) => {
    switch (err.code) {
      case 'USER_REJECTED':                 return;            // benign — let them retry
      case 'WRONG_NETWORK':                 return promptSwitchNetwork();
      case 'MERCHANT_NOT_FOUND':
      case 'MERCHANT_INACTIVE':             return showSetupHint(err.message);
      case 'STALE_PRICE':
      case 'INVALID_PRICE':                 return showRetryLater(err.message);
      default:                              return showError(err.message);
    }
  }}
/>
```

**2. Drive the hook and read `error` / `quoteError` (the custom-UI path):**

```tsx
const { pay, status, error, quoteError, reset } = usePayment({ /* … */ });

// `quoteError` is the quote-specific failure (feed stale, token not allowed) — useful
// for disabling the pay affordance before the buyer ever signs.
if (quoteError) return <Banner tone="warn">{quoteError.message}</Banner>;

if (status === 'error' && error) {
  return (
    <>
      <Banner tone="error">{error.message}</Banner>
      {error.code === 'USER_REJECTED' && <button onClick={reset}>Try again</button>}
    </>
  );
}
```

**3. Pre-empt the dead-end with graceful degradation.** Rather than catching a revert after the
fact, hand `<PayButton>` what the host already knows (`allowedTokens`, `priceFeedConfigured`)
and it renders a *disabled* button with truthful copy (`token-not-allowed` / `no-feed`) before
any click. See [`<PayButton>` graceful degradation](#paybutton).

---

## The chain registry

A self-contained registry of the settlement chains the SDK knows about, with their well-known
Circle USDC addresses. It holds **chain metadata only** — never a router address (guardrail #7;
the router is always a prop you supply). Exported from
[`packages/react/src/chains.ts`](../packages/react/src/chains.ts).

> **The single source of truth for any address is [docs/CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md)**
> (each entry traces to a committed `broadcast/` record). The `usdc` values in `CHAINS` are
> the Circle-issued tokens, and are `undefined` wherever an address is not yet booth-confirmed —
> never an invented or mock address (LAW #4). There are **no mainnet entries** — Access0x1 is
> testnet-only.

### `ChainConfig`

```ts
interface ChainConfig {
  readonly name: string;            // human-readable chain name
  readonly chainId: number;         // EVM chain id
  readonly usdc: Hex | undefined;   // Circle USDC, or undefined until booth-confirmed
  readonly usdcIsNativeGas: boolean; // true only on Arc (USDC pays gas directly)
}
```

`usdcIsNativeGas` flags where the settlement token and the gas token are the same asset — it is
`true` **only on Arc**, where USDC pays gas directly. That flag alone doesn't make a "no gas"
claim safe to ship: on every chain, avoid copy that claims the payment costs nothing.

### `CHAINS`

A `const` record keyed by [`ChainKey`](#the-chain-registry). The lead (deployed) set is
`arcTestnet`, `baseSepolia`, and `zksyncSepolia`; the remaining keys (`zeroGGalileo`,
`monadTestnet`, `berachainBepolia`, `seiTestnet`, `megaethTestnet`) are **known-but-not-yet-deployed**
targets — config-only, deploy pending, with `usdc: undefined` until a Circle token is confirmed.

| Key | Name | chainId | `usdc` | `usdcIsNativeGas` |
| --- | --- | --- | --- | --- |
| `arcTestnet` | Arc Testnet | `5042002` | native USDC system contract | `true` |
| `baseSepolia` | Base Sepolia | `84532` | Circle USDC | `false` |
| `zksyncSepolia` | zkSync Sepolia | `300` | `undefined` (host supplies via env) | `false` |
| `zeroGGalileo` | 0G Galileo Testnet | `16602` | `undefined` | `false` |
| `monadTestnet` | Monad Testnet | `10143` | `undefined` | `false` |
| `berachainBepolia` | Berachain Bepolia | `80069` | `undefined` | `false` |
| `seiTestnet` | Sei Testnet (atlantic-2) | `1328` | `undefined` | `false` |
| `megaethTestnet` | MegaETH Testnet | `6342` | `undefined` | `false` |

> The exact `usdc` address strings live in [`chains.ts`](../packages/react/src/chains.ts) and
> are cross-checked against [docs/CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md) — read them from
> there, never hand-copy them here.

### `getChainConfig`

```ts
function getChainConfig(chainId: number): ChainConfig | undefined;
```

Look up a [`ChainConfig`](#chainconfig) by EVM chain id (e.g. the connected wallet's chain),
or `undefined` if the chain isn't in the registry.

```ts
import { getChainConfig } from '@access0x1/react';

const cfg = getChainConfig(walletChainId);
if (!cfg) showUnsupportedChainNotice();
else if (cfg.usdc == null) showUsdcNotConfiguredNotice(cfg.name);
```

---

## ABI fragments

For fully custom integrations that call the contracts directly, the SDK re-exports the raw ABI
fragments it uses internally: **`ROUTER_ABI`**, **`ERC20_ABI`**, and **`LANES_ABI`** (from
[`packages/react/src/abi.ts`](../packages/react/src/abi.ts)). Feed them to viem's
`readContract` / `writeContract` / `encodeFunctionData`. You still supply your own router
address — the ABIs carry no address.

---

## Clear signing (ERC-8213)

The SDK ships an [ERC-7730](https://github.com/ethereum/ERCs) descriptor so a wallet renders
**"Pay $29.00 to merchant #7 (order 0x…)"** instead of blind hex. ERC-7730 makes the calldata
*readable*; [ERC-8213](https://erc8213.eth.limo) is the weaker-but-universal guarantee that
makes it *verifiable* — a short, deterministic fingerprint of the exact calldata the buyer
signs, so they can cross-check it on a second device. These pure helpers (no client, no network)
compute it from the same intent [`usePayment`](#usepayment) sends:

| Export | Signature | Notes |
| --- | --- | --- |
| `calldataDigest` | `(calldata: Hex) => Hex` | The ERC-8213 digest of arbitrary calldata: `keccak256(uint256(len) ‖ calldata)`. `chainId` is intentionally excluded. |
| `encodePaymentCalldata` | `(params: PaymentCalldataParams) => Hex` | The exact `payNative` / `payToken` calldata the SDK would broadcast for an intent. |
| `paymentCalldataDigest` | `(params: PaymentCalldataParams) => Hex` | Convenience: `calldataDigest(encodePaymentCalldata(params))` — the digest a checkout shows the buyer. |

**`PaymentCalldataParams`** is the intent in the router's normalized units:
`{ merchantId: bigint, usdAmount8: bigint, orderId: Hex, token?: Hex }` (`usdAmount8` is
8-decimal USD, e.g. `$29.00` = `2_900_000_000n`; omit `token` or pass `NATIVE_TOKEN` for a
native payment). Change any field and the digest changes.

```ts
import { paymentCalldataDigest, NATIVE_TOKEN, ZERO_BYTES32 } from '@access0x1/react';

const digest = paymentCalldataDigest({
  merchantId: 42n,
  usdAmount8: 2_900_000_000n, // $29.00
  orderId: ZERO_BYTES32,
  token: NATIVE_TOKEN,        // native payment
});
// Show `digest` next to the wallet prompt; the buyer confirms the two match.
```

---

## See also

- [QUICKSTART.md](./QUICKSTART.md) — the 5-minute happy path (React SDK · one-tag embed · hosted link).
- [docs/CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md) — the single source of truth for every live router / USDC / feed address.
- [`packages/react/src/index.ts`](../packages/react/src/index.ts) — the public barrel this reference documents.
- [README Deployments table](../README.md#deployments) — the broadcast-derived live router addresses.

Found a gap between this reference and the source? Open an issue at
<https://github.com/Access0x1/Access0x1/issues>.
