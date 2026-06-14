# @access0x1/react

A viem/wagmi-native, **zero-custody** React SDK for [Access0x1](https://github.com/Access0x1/Access0x1) — drop a USD-priced crypto payment button into any React app in under five minutes. No contract deployment, no devops, no provider lock-in beyond viem/wagmi.

Every payment is a single on-chain transaction: **buyer → router → merchant + treasury in the same block.** The SDK never holds keys or funds.

## Install

```bash
npm install @access0x1/react viem wagmi
```

`react`, `viem ^2.35`, and `wagmi ^3` are peer dependencies your app already provides. Wallet/auth (e.g. Dynamic) is always the host app's concern — the SDK is auth-agnostic and reads your viem clients.

> **Not on npm yet?** Build and install directly from this repo:
> ```bash
> cd packages/react
> npm ci && npm run build && npm pack   # creates access0x1-react-0.1.0.tgz
> # In your app:
> npm install ../path/to/access0x1-react-0.1.0.tgz viem wagmi
> ```
> Or use the `templates/starter` — its `npm run setup` script handles the pack-and-wire step automatically.

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

- **`usePayment(options)`** — the engine: `quote`, `pay()`, `status`, `txHash`, `receipt`, `reset()`. For an ERC-20 it approves the **exact gross** (minimum necessary approval) only if the existing allowance is short, then calls `payToken`; native pay carries `msg.value`.
- **`useMerchant(routerAddress, merchantId, client)`** — read the on-chain `Merchant` struct. An unregistered id resolves to an all-zero record (use `isUnregistered()`); the hook never throws on a missing merchant.
- **`usePaymentLanes(lanesAddress, owner, asset, chainSelector, client)`** — read-only ERC-6909 lane balance.

## Errors

Reverts surface as a typed `Access0x1Error` with a stable `code` (`UNDERPAID`, `FEE_ON_TRANSFER_TOKEN`, `MERCHANT_INACTIVE`, `MERCHANT_NOT_FOUND`, `STALE_PRICE`, `USER_REJECTED`, …) so your UI can branch without parsing free text.

## Truth in copy

The default label is **"Pay with Crypto"** — it makes no "instant" or "free" claim. Only on a chain where USDC is the native gas token and a paymaster covers gas (Arc) is a "no gas fee" label truthful; do not claim it elsewhere.

## License

MIT
