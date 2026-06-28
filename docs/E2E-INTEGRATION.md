# End-to-end integration — one merchant, one buyer, one receipt

This is the whole loop in one page: a **merchant onboards and gets a `merchantId`**,
a **developer drops a pay button** into a React app pointed at a real router, a
**buyer connects a wallet and pays** in native or USDC, and the **on-chain receipt
is decoded and confirmed**. Every snippet below is copied from a real file in this
repo — the link under each one is the source of truth.

If you have never touched the SDK, read
[GETTING-STARTED.md](./GETTING-STARTED.md) first (it has the three copy-paste
on-ramps); this doc threads those pieces into a single, error-handled flow.

> **No address is ever guessed (LAW #4).** Every router address in this doc is a
> placeholder you must replace with one you read from
> [CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md) (or the README **Deployments** table)
> and confirm on the block explorer. An address that isn't on-chain isn't claimed.

```
 (1) registerMerchant            (2) <PayButton routerAddress=…>
   merchant ──────────▶ merchantId ──────────▶ developer's React app
                                                        │
                                          (3) buyer connects wallet, pays
                                                        ▼
   Access0x1Router ──┬─▶ merchant (net)      (4) PaymentReceived → receipt
                     └─▶ treasury (fee)          decoded + confirmed on-chain
        (USD→token priced via a Chainlink feed, in the same tx)
```

---

## Stage 1 — the merchant registers and gets a `merchantId`

A merchant is just a row in the shared router: `registerMerchant(payout,
feeRecipient, feeBps, nameHash)` is **permissionless**, and the new id comes back
in the `MerchantRegistered` event. The caller becomes the merchant owner. There
are two equivalent paths to that id.

### 1a. The no-code path — `/onboard`

The web app's `/onboard` screen is the non-coder on-ramp: a wallet sign-in plus a
"Make it yours" branding form (name, one-line description, logo) that yields a
branded checkout link and embed tag. The on-chain registration that mints the
`merchantId` is the **Advanced** path, reachable from the dashboard — see
[`web/components/pages/OnboardView.tsx`](../web/components/pages/OnboardView.tsx)
and the on-chain
[`web/components/RegisterForm.tsx`](../web/components/RegisterForm.tsx).

`RegisterForm` is exactly the in-app version of the call below — it submits
`registerMerchant`, then parses the `merchantId` out of the receipt:

```ts
// web/lib/contracts.ts — registerMerchant(): send the tx, then read the event.
const { merchantId, txHash } = await registerMerchant(walletClient, publicClient, routerAddress, {
  payout,                         // where the merchant's net lands (the connected address)
  feeRecipient: effectiveFeeRecipient, // 0x0 falls back to payout at pay time
  feeBps: 0,                      // optional merchant surcharge in basis points
  nameHash: keccak256(toHex(trimmedName)), // an identity commitment, not the plaintext name
});
```
→ [`registerMerchant`](../web/components/RegisterForm.tsx#L153) ·
[`web/lib/contracts.ts`](../web/lib/contracts.ts) parses `MerchantRegistered` and
throws `registerMerchant: MerchantRegistered event not found in receipt` if the
event is missing — so a silent/no-op registration can never resolve to a bogus id.

### 1b. The hand path — `cast`

Want it without a UI? Register straight from the keystore and confirm the id on
the explorer. This is the same flow [MANUAL-TESTING.md](./MANUAL-TESTING.md)
drives end to end:

```bash
# Register: payout = you, feeRecipient = 0 (falls back to payout), feeBps = 0.
cast send $ROUTER \
  "registerMerchant(address,address,uint16,bytes32)" \
  $ME 0x0000000000000000000000000000000000000000 0 \
  $(cast keccak "acme-coffee") \
  --rpc-url $RPC --account deployer

# The first merchant id is 1. nextMerchantId() returns 2 → your id is 1.
cast call $ROUTER "nextMerchantId()(uint256)" --rpc-url $RPC
```
→ [MANUAL-TESTING.md → B1](./MANUAL-TESTING.md#b1-router--register--quote--pay--conservation--zero-custody)

**Hold onto two values for Stage 2:** the `merchantId` (a `bigint`) and the
`routerAddress` you registered against.

---

## Stage 2 — the developer adds `<PayButton>` to a React app

`@access0x1/react` is viem/wagmi-native and ships a single drop-in component.
Install it (it is `v0.1.0`; pack it locally from a repo checkout until it lands on
npm — see [GETTING-STARTED.md → Path 1](./GETTING-STARTED.md#1-install)):

```bash
npm install @access0x1/react viem wagmi
```

Pass the `merchantId` from Stage 1 and the `routerAddress` you read from
[CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md). The button is auth-agnostic — it reads
the viem clients your app already provides (wallet/auth, e.g. Dynamic, is always
the host app's concern):

```tsx
import { PayButton, clientFromViem } from '@access0x1/react';
import { usePublicClient, useWalletClient } from 'wagmi';

function Checkout() {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const client = clientFromViem(publicClient!, walletClient ?? undefined);

  return (
    <PayButton
      merchantId={1n}                          // from Stage 1
      usdAmount={29.0}                          // human USD price
      orderId="order-1042"                      // your order reference; bound to the receipt
      routerAddress="0xYourRouterFromChainAddresses" // see docs/CHAIN-ADDRESSES.md (never hardcoded)
      client={client}
      explorerBaseUrl="https://sepolia.basescan.org" // renders the receipt tx as a link
      onSettled={({ receipt, explorerUrl }) =>
        console.log('settled', receipt.txHash, explorerUrl)
      }
      onError={(err) => console.error(err.code, err.message)} // typed; see Stage 4
    />
  );
}
```
→ [`packages/react/README.md`](../packages/react/README.md) ·
[`PayButtonProps`](../packages/react/src/components/PayButton.tsx#L40)

**To pay in USDC instead of the chain's native coin**, pass the USDC `token` for
your settlement chain (read it from
[CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md)). Omit `token` for native:

```tsx
<PayButton
  merchantId={1n}
  usdAmount={29.0}
  token="0x036CbD53842c5426634e7929541eC2318f3dCF7e" // USDC on Base Sepolia, from CHAIN-ADDRESSES.md
  routerAddress="0xYourRouterFromChainAddresses"
  client={client}
  allowedTokens={['0x036CbD53842c5426634e7929541eC2318f3dCF7e']} // the router's pay-in allowlist
/>
```

**Error handling at this stage is graceful degradation, not a thrown error.** If
the router has no price feed for the chosen token, or the token is not in the
`allowedTokens` allowlist, `<PayButton>` renders a **disabled** button with
truthful, reason-specific copy instead of letting the buyer click into a
guaranteed on-chain revert. The reasons are `no-client`, `no-feed`,
`token-not-allowed`, and `quote-unavailable` — override the copy with
`renderDisabled`:

```tsx
<PayButton
  /* …props… */
  priceFeedConfigured={false}  // you know this token has no feed → button disables with `no-feed`
  renderDisabled={(reason) =>
    reason === 'no-feed'
      ? <span>Card-only for now — crypto pricing isn't live for this item.</span>
      : <span>Checkout unavailable.</span>
  }
/>
```
→ [`PayButtonDisabledReason`](../packages/react/src/types.ts#L122)

---

## Stage 3 — the buyer connects a wallet and pays

Wallet connection is the host app's job (the SDK never holds keys); once a
`walletClient` exists, the buyer clicks the button and the SDK runs the whole
state machine: `idle → quoting → confirm → pending → success`. Concretely:

1. **Quote.** The SDK calls `router.quote(merchantId, token, usdAmount8)` to price
   `$29.00` into a token amount via the Chainlink feed — read *in the same
   transaction*, never passed in by the client.
2. **Approve (ERC-20 only).** For a token payment the SDK reads the existing
   allowance and sends a single `approve` for the **exact gross** only if the
   current allowance is short. Native pay skips this and carries `msg.value =
   gross`.
3. **Pay.** One on-chain call (`payToken` or `payNative`): buyer → router →
   merchant (net) + treasury (fee), in the same block. The router holds nothing
   after — zero custody.

If you want your own button, status copy, or layout, drive the same machine with
the `usePayment` hook directly:

```tsx
import { usePayment, clientFromViem } from '@access0x1/react';
import { usePublicClient, useWalletClient } from 'wagmi';

function PayInUsdc() {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const client = clientFromViem(publicClient!, walletClient ?? undefined);

  const { pay, status, quote, txHash, receipt, error } = usePayment({
    merchantId: 1n,
    usdAmount: 29.0,
    token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // USDC, from CHAIN-ADDRESSES.md; omit for native
    orderId: 'order-1042',
    routerAddress: '0xYourRouterFromChainAddresses',
    client,
    onError: (err) => console.error(err.code, err.message),
  });

  const busy = status === 'quoting' || status === 'confirm' || status === 'pending';

  return (
    <button onClick={pay} disabled={busy || client == null}>
      {status === 'idle' && 'Pay with Crypto'}
      {status === 'quoting' && quote != null && `Pay ${quote} (quoted)`}
      {busy && 'Confirming…'}
      {status === 'success' && 'Paid ✓'}
      {status === 'error' && error && `Error: ${error.code}`}
    </button>
  );
}
```
→ [`usePayment`](../packages/react/src/hooks/usePayment.ts) ·
[`packages/react/README.md`](../packages/react/README.md)

**Error handling at this stage** is the typed `Access0x1Error` the hook surfaces in
`error` (and the `onError` callback). A wallet that is on the wrong chain, or a
buyer who rejects the prompt, never throws raw into your UI:

| Code | When it happens | What to tell the buyer |
| --- | --- | --- |
| `USER_REJECTED` | The buyer dismissed the wallet prompt | "Payment cancelled — tap Pay to try again." |
| `WRONG_NETWORK` | The wallet is on a different chain than the router | "Switch your wallet to the payment network." |
| `NO_WALLET` | `pay()` ran without a connected `client` | "Connect a wallet to continue." |

The other codes (`UNDERPAID`, `STALE_PRICE`, `TOKEN_NOT_ALLOWED`, …) are
revert-derived and covered in Stage 4.

---

## Stage 4 — the receipt is decoded and confirmed on-chain

`usePayment` starts watching `PaymentReceived` **before** it broadcasts, so it
can't miss the event. The decoded receipt is the canonical on-chain record of the
settlement, and it is bound to *this* payment's `orderId` — so a concurrent
checkout by the same buyer to the same merchant for a different order can never
resolve the wrong receipt. The watch is also raced against a **120-second
ceiling**: if `PaymentReceived` never arrives (or its log can't be decoded),
`pay()` rejects with a timeout error and transitions to `error` instead of hanging
forever.

On success the SDK hands you a fully-decoded `PaymentReceipt`:

```ts
// The decoded PaymentReceived event — the on-chain receipt (packages/react/src/types.ts).
interface PaymentReceipt {
  merchantId: bigint;   // the merchant that was paid
  buyer: Hex;           // the payer
  token: Hex;           // NATIVE_TOKEN ('0x0…0') for a native payment
  grossAmount: bigint;  // pulled from the buyer, in the token's own decimals
  feeAmount: bigint;    // platform + merchant surcharge
  netAmount: bigint;    // what landed at the merchant payout
  usdAmount8: bigint;   // the USD price it settled at, 8-decimal ($29.00 = 2_900_000_000n)
  orderId: Hex;         // echoed from the request; ZERO_BYTES32 if none was supplied
  srcChainSelector: bigint; // 0n for a same-chain payment (the only kind this SDK initiates)
  txHash: Hex;          // the settlement transaction hash
  blockNumber: bigint;  // the block it settled in
}
```
→ [`PaymentReceipt`](../packages/react/src/types.ts#L53)

Use it to confirm the payment and (optionally) link to the explorer. The
conservation invariant `netAmount + feeAmount == grossAmount` holds by
construction — assert it if you want a belt-and-suspenders check:

```tsx
<PayButton
  merchantId={1n}
  usdAmount={29.0}
  routerAddress="0xYourRouterFromChainAddresses"
  client={client}
  explorerBaseUrl="https://sepolia.basescan.org"
  onSettled={({ receipt, explorerUrl }) => {
    // Invariant: net + fee == gross, always (zero custody — the router keeps nothing).
    console.assert(receipt.netAmount + receipt.feeAmount === receipt.grossAmount);
    fulfillOrder({
      orderId: receipt.orderId,
      txHash: receipt.txHash,
      block: receipt.blockNumber,
      explorerUrl, // ready-to-open link, or null if no explorerBaseUrl was given
    });
  }}
  onError={(err) => showCheckoutError(err.code, err.message)}
/>
```
→ [`SettledResult`](../packages/react/src/types.ts#L156)

**Error handling at this stage** is the revert-derived branch of `Access0x1Error`.
A reverted settlement surfaces as a stable `code` so your UI can branch without
parsing free text:

| Code | Meaning |
| --- | --- |
| `UNDERPAID` | The payment was below the quoted amount (the price moved) — try again. |
| `STALE_PRICE` | The Chainlink feed is stale, or an L2 sequencer guard tripped — try again shortly. |
| `INVALID_PRICE` | The feed returned an invalid price. |
| `TOKEN_NOT_ALLOWED` | The pay-in token isn't on the router's allowlist. |
| `MERCHANT_INACTIVE` / `MERCHANT_NOT_FOUND` | The merchant isn't accepting payments / isn't registered. |
| `FEE_ON_TRANSFER_TOKEN` | The token takes a fee on transfer (rejected by the balance-delta check). |
| `ZERO_AMOUNT` | A zero-amount payment was attempted. |
| `UNKNOWN` | Anything the SDK couldn't classify (the original error is on `.cause`). |

→ [`Access0x1ErrorCode`](../packages/react/src/errors.ts#L13)

To **confirm a settlement independently** (e.g. server-side, from a webhook or a
job), read the merchant record or re-derive the receipt from the tx hash with
viem — the on-chain event is the source of truth, not the client callback. The
`useMerchant` hook reads the same `merchants(id)` record the contract exposes:

```tsx
import { useMerchant, isUnregistered } from '@access0x1/react';

const { merchant, isLoading, error } = useMerchant(routerAddress, 1n, client);
// An unregistered id resolves to an all-zero record — guard it, never throw:
if (merchant && isUnregistered(merchant)) { /* show "merchant not found" */ }
```
→ [`useMerchant`](../packages/react/src/hooks/useMerchant.ts)

---

## The whole loop, in one breath

| Stage | Who | Call | Result |
| --- | --- | --- | --- |
| 1 | Merchant | `registerMerchant(payout, feeRecipient, feeBps, nameHash)` | a `merchantId` (from the `MerchantRegistered` event) |
| 2 | Developer | `<PayButton merchantId routerAddress … />` | a drop-in checkout, no contracts written |
| 3 | Buyer | click → `quote` → (approve) → `payToken` / `payNative` | one on-chain tx: buyer → merchant + treasury |
| 4 | Both | decode `PaymentReceived` | a typed `PaymentReceipt`; `net + fee == gross`, zero custody |

## Where to go next

| If you want to… | Read |
| --- | --- |
| The three copy-paste on-ramps (install, hook, scaffold) | [GETTING-STARTED.md](./GETTING-STARTED.md) |
| The full `<PayButton>` / hook prop tables | [`packages/react/README.md`](../packages/react/README.md) |
| Drive every contract by hand with `cast` | [MANUAL-TESTING.md](./MANUAL-TESTING.md) |
| A live router address / chain id / USDC / feed | [CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md) |
| Add subscriptions / bookings / invoices / gift cards | [RECIPES.md](./RECIPES.md) |
| How the contracts enforce all of this | [ARCHITECTURE.md](./ARCHITECTURE.md) |
