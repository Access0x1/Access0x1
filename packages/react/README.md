# @access0x1/react

A viem/wagmi-native, **zero-custody** React SDK for [Access0x1](https://github.com/Access0x1/Access0x1) — drop a USD-priced crypto payment button into any React app in under five minutes. No contract deployment, no devops, no provider lock-in beyond viem/wagmi.

Every payment is a single on-chain transaction: **buyer → router → merchant + treasury in the same block.** The SDK never holds keys or funds.

## Install

```bash
npm install @access0x1/react viem wagmi
```

`react`, `viem ^2.35`, and `wagmi ^3` are peer dependencies your app already provides. Wallet/auth (e.g. Dynamic) is always the host app's concern — the SDK is auth-agnostic and reads your viem clients.

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
