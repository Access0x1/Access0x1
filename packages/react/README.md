# @access0x1/react

A viem/wagmi-native, **zero-custody** React SDK for [Access0x1](https://github.com/Access0x1/Access0x1) — drop a USD-priced crypto payment button into any React app in under five minutes. No contract deployment, no devops, no provider lock-in beyond viem/wagmi.

Every payment is a single on-chain transaction: **buyer → router → merchant + treasury in the same block.** The SDK never holds keys or funds.

## Install

Access0x1 is **git-distributed — not published to any npm registry.** Consume `@access0x1/react`
as a git dependency in your app's `package.json`:

```jsonc
"dependencies": {
  "@access0x1/react": "github:Access0x1/Access0x1#main"   // or pin a commit SHA
}
```

```bash
npm install viem wagmi   # peers your app provides
```

`react`, `viem ^2.35`, and `wagmi ^3` are peer dependencies your app already provides. Wallet/auth (e.g. Dynamic) is always the host app's concern — the SDK is auth-agnostic and reads your viem clients.

> Installing the `github:` ref builds the SDK's `dist/` automatically (its `prepare` script). Prefer to vendor it? Copy `packages/react/` into your repo. Or use the `templates/starter` — its `npm run setup` script packs-and-wires the SDK from a local checkout for you.

## Quick start — `<PayButton>`

```tsx
import { PayButton, clientFromViem } from '@access0x1/react';
import { usePublicClient, useWalletClient } from 'wagmi';

function Checkout() {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const client = clientFromViem(publicClient!, walletClient ?? undefined);

  return (
    <PayButton
      merchantId={42n}
      usdAmount={29.0}
      routerAddress="0x..." // the deployed Access0x1Router on your settlement chain
      client={client}
      onSuccess={(receipt) => console.log('paid', receipt.txHash)}
    />
  );
}
```

No contract code. No seed-phrase UX. The integrator passes `merchantId` (the number from `registerMerchant`) and the router address — never a raw token address.

### `<PayButton>` props

`<PayButton>` is a single `<button>` with no modal — your CSS keeps full layout control via `className`. It shows a spinner during `confirm`/`pending`, an inline confirmation on success, and the typed error on failure.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `merchantId` | `bigint` | — | The merchant to pay. |
| `usdAmount` | `number` | — | Human USD price (e.g. `29.00`). |
| `token` | `Hex` | native | The ERC-20 to pay in; omit for a native payment. |
| `orderId` | `string` | — | A human-readable order reference (bound to the receipt — see `usePayment`). |
| `routerAddress` | `Hex` | — | The deployed `Access0x1Router` (required — never hardcoded). |
| `client` | `Access0x1Client` | — | The viem-backed client driving the payment. |
| `label` | `string` | `"Pay with Crypto"` | Idle-state button label. |
| `className` | `string` | — | Pass-through class for your CSS / Tailwind. |
| `allowedTokens` | `readonly Hex[]` | — | The router's pay-in allowlist as your app already knows it; when set, the button disables itself (`token-not-allowed`) for a token not in the list instead of clicking into a revert. |
| `priceFeedConfigured` | `boolean` | `true` | Pass `false` for a token you know has no configured feed; the button disables itself (`no-feed`). |
| `explorerBaseUrl` | `string` | — | e.g. `https://testnet.arcscan.app`; renders the success receipt's tx hash as a link and threads it into `onSettled`. |
| `disabledLabel` | `string` | reason-specific | Override the disabled-state label. |
| `onQuote` | `(result: QuoteResult) => void` | — | Fires on every quote attempt (resolved gross **or** quote error). |
| `onSettled` | `(result: SettledResult) => void` | — | Fires once the payment settles, with the receipt + a ready explorer URL. |
| `onSuccess` | `(receipt: PaymentReceipt) => void` | — | The receipt on success (kept for back-compat). |
| `onError` | `(err: Access0x1Error) => void` | — | The typed error on failure. |
| `renderSuccess` | `(receipt) => ReactNode` | — | Override the inline success node. |
| `renderDisabled` | `(reason: PayButtonDisabledReason) => ReactNode` | — | Override the disabled node. |

**Graceful degradation.** When the router has no feed or no allowlist entry for the chosen token, paying would revert — so rather than send the buyer into a guaranteed failure, `<PayButton>` renders a *disabled* button with truthful, reason-specific copy. The disabled state is derived from two signals: host-declared config (`allowedTokens`, `priceFeedConfigured`, the presence of a `client`) and the live `quote()` probe surfaced by `usePayment`. The reasons are `no-client`, `no-feed`, `token-not-allowed`, and `quote-unavailable`.

## Quick start — `usePayment` (custom UI)

`<PayButton>` is built on the `usePayment` hook. Use the hook directly when you want your own button, status copy, or layout:

```tsx
import { usePayment, clientFromViem } from '@access0x1/react';
import { usePublicClient, useWalletClient } from 'wagmi';

function PayInUsdc() {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const client = clientFromViem(publicClient!, walletClient ?? undefined);

  const { pay, status, quote, txHash, error } = usePayment({
    merchantId: 42n,
    usdAmount: 29.0,
    token: '0x...',            // the USDC address on your settlement chain; omit for native pay
    orderId: 'order-1042',     // optional; keccak256'd to bytes32 and bound to the receipt
    routerAddress: '0x...',    // the deployed Access0x1Router
    client,
    onSuccess: (receipt) => console.log('paid', receipt.txHash),
  });

  const busy = status === 'quoting' || status === 'confirm' || status === 'pending';

  return (
    <button onClick={pay} disabled={busy}>
      {status === 'idle' && 'Pay with Crypto'}
      {busy && 'Confirming…'}
      {status === 'success' && 'Paid'}
      {status === 'error' && error && `Error: ${error.code}`}
    </button>
  );
}
```

For an ERC-20 the hook approves the **exact gross** (minimum necessary approval) only if the existing allowance is short, then calls `payToken`; native pay carries `msg.value`. The `quote` is the token amount returned by `router.quote()`.

## Hooks

- **`usePayment(options)`** — the engine. Returns `status`, `quote`, `quoteError`, `error`, `pay()`, `txHash`, `receipt`, `reset()`. The lifecycle is `idle → quoting → confirm → pending → success` (or `error` at any step). For an ERC-20 it reads the existing allowance and only sends an `approve` for the **exact gross** (minimum necessary approval) when it is short, then calls `payToken`; native pay carries `msg.value = gross`. See the options table and the receipt-resolution notes below.
- **`useMerchant(routerAddress, merchantId, client?)`** — read the on-chain `Merchant` struct. An unregistered id resolves to an all-zero record (use `isUnregistered()`); the hook never throws on a missing merchant.
- **`usePaymentLanes(lanesAddress, owner, asset?, chainId?, client?)`** — read-only ERC-6909 lane balance. `asset` defaults to the native sentinel and `chainId` defaults to `0n` (let the contract resolve the active chain). It derives the lane's ERC-6909 token id (`laneId`) and reads `balanceOf(owner, laneId)`.

### `usePayment` options

| Option | Type | Required | Meaning |
|---|---|---|---|
| `merchantId` | `bigint` | yes | The merchant to pay (the id returned by `registerMerchant`). |
| `usdAmount` | `number` | yes | Human USD price (e.g. `29.00`); converted to 8-decimal internally. |
| `token` | `Hex` | no | The ERC-20 to pay in; omit (or pass the zero address) for a native payment. |
| `orderId` | `string` | no | A human-readable order reference; `keccak256`'d to bytes32 internally and bound to the resolved receipt (see below). |
| `routerAddress` | `Hex` | yes | The deployed `Access0x1Router` on the settlement chain — never hardcoded. |
| `client` | `Access0x1Client` | no | The viem-backed client. Supply via `clientFromViem` or a wagmi adapter; if omitted, `pay()` fails with `NO_WALLET`. |
| `onSuccess` | `(receipt) => void` | no | Called once with the decoded receipt on success. |
| `onError` | `(err: Access0x1Error) => void` | no | Called with the typed error on failure. |

### Receipt resolution — `orderId`-bound, time-boxed

`usePayment` starts watching `PaymentReceived` **before** it broadcasts, so it can't miss the event. The event filter only matches the indexed `{merchantId, buyer}`, and `orderId` is *not* indexed — so the hook additionally checks the decoded `orderId` against this payment's own order before resolving. That binding matters when the same buyer has a concurrent payment to the same merchant for a **different** order (e.g. a second checkout tab): without it, the hook could resolve with the wrong receipt (wrong order/amount); with it, each `pay()` resolves only on its own settlement. A payment with no `orderId` binds to the zero-bytes32 sentinel.

The receipt watch is also raced against a **120-second ceiling**: if `PaymentReceived` never arrives (or its log can't be decoded), `pay()` rejects with a timeout error and transitions to `error` instead of hanging forever. The watcher is always torn down afterward either way.

## Errors

Reverts surface as a typed `Access0x1Error` with a stable `code` (`UNDERPAID`, `FEE_ON_TRANSFER_TOKEN`, `MERCHANT_INACTIVE`, `MERCHANT_NOT_FOUND`, `TOKEN_NOT_ALLOWED`, `STALE_PRICE`, `INVALID_PRICE`, `ZERO_AMOUNT`, `USER_REJECTED`, `NO_WALLET`, `UNKNOWN`) so your UI can branch without parsing free text. The oracle's L2 sequencer guards (`OracleLib__SequencerDown` / `…GracePeriodNotOver`) also normalize to `STALE_PRICE`.

## Truth in copy

The default label is **"Pay with Crypto"** — it makes no "instant" or "free" claim. Only on a chain where USDC is the native gas token and a paymaster covers gas (Arc) is a "no gas fee" label truthful; do not claim it elsewhere.

## License

MIT
