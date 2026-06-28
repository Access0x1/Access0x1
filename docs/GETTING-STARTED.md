# Getting Started with Access0x1

> **What you'll have at the end:** a button in your own app that takes a
> **USD-priced** crypto payment in **one on-chain transaction** — buyer → merchant
> + treasury in the same block, with **zero custody** (the protocol never holds
> your keys or your money).

New to web3 payments? Start at [Path 1](#path-1--accept-your-first-payment-react-sdk).
Want to see the whole machine run on your laptop first? Jump to
[Path 2](#path-2--run-the-whole-thing-locally-no-keys). Already fluent and just
want the contract internals? Skip ahead to
[ARCHITECTURE.md](./ARCHITECTURE.md).

---

## The 60-second mental model

Access0x1 is **one shared, multi-tenant router contract** (`Access0x1Router`)
that every developer integrates with — you do **not** deploy or write any
Solidity to accept payments. A payment is a single call:

```
buyer ──pay()──▶ Access0x1Router ──┬─▶ merchant   (net)
                                   └─▶ treasury   (fee)
        (priced in USD via a Chainlink feed, read *inside* the same tx)
```

Three properties make it safe to build on:

| Property | What it means for you |
| --- | --- |
| **Zero custody** | The router's balance is ~0 after every settlement. It is a pass-through, not a wallet. Nothing to get hacked, nothing to withdraw. |
| **USD-priced in-tx** | You quote a human price (`$29.00`); the router converts to the token amount using a Chainlink feed read *in the same transaction* — no off-chain price oracle to trust or spoof. |
| **Exact fee math** | `net + fee == gross`, always. Fee-on-transfer tokens are rejected by balance-delta check. |

You can read the contract that enforces all of this in
[`src/Access0x1Router.sol`](../src/Access0x1Router.sol); the architecture write-up
walks it line by line in [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Path 1 — Accept your first payment (React SDK)

The fastest integration is the **[`@access0x1/react`](../packages/react)** SDK.
It is viem/wagmi-native and ships a single drop-in component, `<PayButton>`.

### 1. Install

The SDK is at `v0.1.0` and not yet on the public npm registry. The starter
template (Path 3) wires it for you automatically; to add it to an existing app,
pack it locally from a repo checkout:

```sh
# from your clone of Access0x1
cd packages/react && npm pack          # -> access0x1-react-0.1.0.tgz
cd /path/to/your-app
npm install /path/to/access0x1-react-0.1.0.tgz
```

Peer deps: `react`, plus [`viem`](https://viem.sh) and (optionally)
[`wagmi`](https://wagmi.sh) for wallet wiring.

### 2. Drop in `<PayButton>`

Every prop below is real — see
[`PayButtonProps`](../packages/react/src/components/PayButton.tsx). The
`routerAddress` is **required and never hardcoded in the SDK** (LAW #4: the
protocol never ships a guessed address — you pass the one you trust, from
[`docs/CHAIN-ADDRESSES.md`](./CHAIN-ADDRESSES.md)).

```tsx
import { PayButton } from '@access0x1/react';

export function Checkout() {
  return (
    <PayButton
      routerAddress="0xYourRouterFromChainAddresses"  // see docs/CHAIN-ADDRESSES.md
      merchantId={1n}                                  // your registered merchant id
      usdAmount={29.0}                                 // human USD price
      orderId="order-1234"                             // your order reference
      label="Pay with Crypto"
      onSuccess={(receipt) => console.log('paid', receipt.txHash)}
      onError={(err) => console.error(err.code, err.message)}
    />
  );
}
```

To pay in a specific ERC-20 instead of the chain's native asset, pass
`token={'0xTokenAddress'}`. Omit it for native.

### 3. (Optional) Drive it yourself with the hook

Need custom UI? `<PayButton>` is a thin shell over the **`usePayment`** hook,
which exposes the whole state machine:

```tsx
import { usePayment } from '@access0x1/react';

const { status, quote, error, pay, txHash, receipt, reset } = usePayment({
  routerAddress: '0xYourRouter',
  merchantId: 1n,
  usdAmount: 29.0,
  orderId: 'order-1234',
});
// status: 'idle' | 'quoting' | 'confirm' | 'pending' | 'success' | 'error'
//   confirm = awaiting wallet signature(s) (approve and/or pay);
//   pending = tx broadcast, awaiting inclusion
// quote:  the token amount (bigint) the router will charge for $29.00
// pay():  runs approve-if-needed then the single pay tx
```

Other exported hooks: **`useMerchant`** (read a merchant's on-chain config;
`isUnregistered` guards the empty case) and **`usePaymentLanes`** (the ERC-6909
lane balances). Full barrel: [`packages/react/src/index.ts`](../packages/react/src/index.ts).

---

## Path 2 — Run the whole thing locally (no keys)

You don't need testnet funds or a wallet to see money move. A fresh
[Anvil](https://book.getfoundry.sh/anvil/) node ships unlocked dev accounts, so
the local deploy needs **no private key and no keystore**.

**Prerequisites:** [Git](https://git-scm.com/) ·
[Foundry](https://book.getfoundry.sh/getting-started/installation) ·
[Node.js](https://nodejs.org/) 18+.

```sh
git clone https://github.com/Access0x1/Access0x1.git
cd Access0x1
make install           # forge submodules + npm (@chainlink) + web + SDK
make build             # forge build
make test              # the full suite, all green
```

> Why `npm install` before `forge build`? Foundry resolves `@chainlink/contracts`
> from `node_modules` via a remapping. `make install` orders it for you.

Now bring up a local chain and deploy the whole wired surface to it:

```sh
make anvil             # terminal 1 — local node on http://localhost:8545
make deploy-local      # terminal 2 — deploys mock USDC + mock feeds + the full stack
make drive-local       # watch a coffee-shop payment: register → quote USD → pay USDC
```

`make drive-local` proves the invariant end to end: **register a merchant → quote
in USD → pay in USDC → `net + fee == gross`, zero custody.** Want to do that same
flow **by hand** — deploy, register your own merchant, and settle one payment with
`cast`, with every common error and its fix called out? Follow the guided
[`docs/FIRST-MERCHANT.md`](./FIRST-MERCHANT.md). Copy-paste `cast` walkthroughs for
every contract live in [`docs/MANUAL-TESTING.md`](./MANUAL-TESTING.md).

Run the web app too:

```sh
make web-dev           # cd web && npm run dev  →  http://localhost:3000
```

---

## Path 3 — Scaffold a pre-wired starter

Don't want the monorepo — just the stack in your own app? Scaffold a starter
(checkout + one-tag embed + your own Foundry contracts) with
[`degit`](https://github.com/Rich-Harris/degit):

```sh
npx degit Access0x1/Access0x1/templates/starter my-checkout
cd my-checkout
npm run setup          # installs Foundry, packs @access0x1/react locally, builds contracts
npm run dev            # http://localhost:3000 — point it at a router in .env.local
```

`npm run setup` handles the not-yet-on-npm SDK automatically (finds
`packages/react`, runs `npm pack`, wires a local `file:` reference). No Solidity
required — set your name, logo, and a router address in `access0x1.config.ts` /
`.env.local`. It ships **no default address** (LAW #4). The starter's
`contracts/DEPLOY.md` is the runbook if you want your own router.

---

## Going live on a testnet

The protocol is deployed and **Blockscout-verified** on multiple testnets. The
**single source of truth** for every live address, chain id, USDC token, and
Chainlink feed is **[`docs/CHAIN-ADDRESSES.md`](./CHAIN-ADDRESSES.md)** — always
copy the router address from there (or the README **Deployments** table) and
confirm it on the explorer before pointing real value at it. Never reuse an
address from a blog post or an older snapshot.

- **Deploy your own** wired stack to a testnet: [`docs/DEPLOY-TESTNETS.md`](./DEPLOY-TESTNETS.md)
  (and [`docs/ARC-DEPLOY.md`](./ARC-DEPLOY.md) for Arc, [`docs/ZKSYNC-TESTING.md`](./ZKSYNC-TESTING.md) for zkSync).
- **Gas profile:** [`docs/GAS.md`](./GAS.md). **Storage layout** (you're on UUPS proxies): [`docs/STORAGE-LAYOUT.md`](./STORAGE-LAYOUT.md).

---

## Where to go next

| If you want to… | Read |
| --- | --- |
| Understand how the contracts fit together | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| See the full contract surface + Router API | [README.md](../README.md) |
| Look up a live address / chain / feed | [docs/CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md) |
| Contribute a change | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Review the security posture + audit | [SECURITY.md](../SECURITY.md) · [audit/REPORT.md](../audit/REPORT.md) |
| Pay by hand with `cast` | [docs/MANUAL-TESTING.md](./MANUAL-TESTING.md) |

Questions or a bug? Open an issue on
[github.com/Access0x1/Access0x1](https://github.com/Access0x1/Access0x1) — and if
it's a vulnerability, follow [SECURITY.md](../SECURITY.md) instead of filing a
public issue.
