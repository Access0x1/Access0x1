# {{PROJECT_NAME}}

A non-custodial, USD-priced (Chainlink) crypto checkout, scaffolded from the
[Access0x1 starter template](https://github.com/Access0x1/Access0x1/tree/main/templates/starter).

- **Chain:** {{CHAIN_NAME}} (chain id `{{CHAIN_ID}}`)
- **Features:** `{{FEATURES}}`
- **Zero custody.** Buyers pay you directly: buyer → router → your payout + your treasury, in one
  on-chain transaction. Nothing here ever holds keys or funds.
- **USD pricing via Chainlink.** Prices are written in dollars; the router converts to the token
  amount at the live feed price, in the same tx.

```
{{PROJECT_NAME}}/
├── package.json       `npm run setup` (toolchain bootstrap) + dev/build wrappers
├── scripts/setup.mjs  detect/install Foundry → forge install → npm i → forge build
├── app/               Next.js checkout (uses @access0x1/react <PayButton>)
│   ├── app/page.tsx            the working checkout
│   ├── access0x1.config.ts     chain + router (from env) + sponsor seams
│   ├── public/embed.js         the one-tag embed (paste into any HTML page)
│   └── .env.example            EVERY sponsor seam, as fill-in blanks
└── contracts/         Your own Foundry contracts (the real Access0x1Router + the commerce quartet:
    ├── src/ script/            Subscriptions / Bookings / Invoices / GiftCards)
    └── DEPLOY.md               deploy-your-own runbook (zero dependency on us)
```

---

## Get this template

```bash
# Fetch the starter directly (no CLI, no npm install of a scaffolder) — recommended:
npx degit Access0x1/Access0x1/templates/starter my-checkout
cd my-checkout
```

`degit` copies the template verbatim. Replace the `{{...}}` placeholders (`{{PROJECT_NAME}}`,
`{{CHAIN_NAME}}`, `{{CHAIN_ID}}`, `{{ROUTER_ENV}}`, `{{FEATURES}}`) with your own values — or use
the convenience CLI from a checkout of this repo (`node packages/create-access0x1/bin/index.mjs
my-app --chain {{CHAIN}} --yes`), which substitutes them for you.

---

## Quickstart

### 1. Bootstrap the toolchain (once)

```bash
npm run setup
```

This detects Foundry (installs it via `foundryup` if missing), `forge install`s the Solidity
submodules, `npm install`s the contract + app deps (`@chainlink/contracts`, Next.js,
`@access0x1/react`), and runs `forge build` to prove the vendored contracts compile. It installs
TOOLING only — it never deploys and never writes an address.

### 2. Point at a router — pick ONE path

You need a **router address** for checkout to work.

#### Path A — No-deploy (default): run against a configured router

The fastest way to a working checkout, and the path this app defaults to. If you trust an existing
`Access0x1Router` on {{CHAIN_NAME}} (your own from a previous deploy, a teammate's, or one confirmed
at a sponsor booth), just paste its address into `.env.local` — no Foundry run needed:

```
{{ROUTER_ENV}}=0xYourTrustedRouter
```

We ship **no default address** — **LAW #4: never a guessed/invented address.** The app reads the
router from env and runs the real quote → (approve) → pay → receipt cycle against it.

#### Path B — Deploy your OWN contracts (advanced)

Own a non-custodial router with zero dependency on anyone. `npm run setup` already built the
contracts; deploy them:

```bash
cd contracts

# Local dry-run first (no RPC, no env — fresh mocks):
anvil &                                                  # in another terminal
forge script script/DeployAll.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

`DeployAll` deploys the `Access0x1Router` plus the optional spine (SessionGrant, PaymentLanes,
Receiver, HouseTokenFactory) and the commerce quartet (Subscriptions / Bookings / Invoices /
GiftCards). Copy the logged `Access0x1Router deployed :` address into `.env.local`. Full
live-testnet (keystore-only) runbook: **[`contracts/DEPLOY.md`](./contracts/DEPLOY.md)**.

### 3. Fill the env + run

```bash
cd app
cp .env.example .env.local      # the scaffolder/CLI may have done this already
```

Edit `.env.local` and set your router (and the chain's RPC / USDC, from the booth or your deploy):

```
{{ROUTER_ENV}}=0xYourRouter
NEXT_PUBLIC_RPC_URL_{{CHAIN_ID}}=        # confirm at booth
NEXT_PUBLIC_USDC_ADDRESS_{{CHAIN_ID}}=   # confirm at Circle booth (blank = pay native)
```

Set your `MERCHANT_ID` and price in `app/app/page.tsx`, then from the project root:

```bash
npm run dev
# open http://localhost:3000
```

Connect an injected wallet (MetaMask etc.) and pay. The bundled checkout uses
`@access0x1/react`'s `<PayButton>`, which runs the real **quote → (approve) → pay → receipt** cycle.
With no router configured the page shows a clear "set {{ROUTER_ENV}}" message instead of crashing.

---

## How the checkout is wired

`app/app/page.tsx` renders `<PayButton>` from `@access0x1/react`:

```tsx
<PayButton
  merchantId={1n}
  usdAmount={29.0}
  token={getUsdcAddress()}          // undefined → pay in native token (USDC on Arc)
  routerAddress={getRouterAddress()} // from {{ROUTER_ENV}} — never hardcoded
  client={client}                    // built from your viem public + injected wallet client
  onSuccess={(receipt) => { /* ... */ }}
/>
```

`access0x1.config.ts` reads every address from env (`getRouterAddress`, `getUsdcAddress`,
`getRpcUrl`) so no contract address is ever baked into source.

### One-tag embed

`app/public/embed.js` is the no-build, no-npm embed. Paste into any HTML page:

```html
<script src="https://your-host/embed.js" data-merchant="1" data-amount-usd="29.00"></script>
```

It shows a live, gas-free quote (one `eth_call`) and opens your hosted checkout on click. Addresses
are `__PLACEHOLDER__` tokens replaced at build time from your `NEXT_PUBLIC_*` env — never hardcoded.

---

## Truth-in-copy (LAW #4)

- The "Pay with USDC — no gas fee" label is shown **only on Arc**, where USDC is the native gas
  token. On every other chain the button keeps the neutral "Pay with Crypto".
- Every address slot in `.env.example` is **blank on purpose**. Fill it from your own deploy or a
  sponsor booth — never a guess.

## License

MIT
