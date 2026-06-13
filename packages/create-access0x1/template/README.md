# {{PROJECT_NAME}}

A non-custodial, USD-priced (Chainlink) crypto checkout, scaffolded by
[`create-access0x1`](https://www.npmjs.com/package/create-access0x1).

- **Chain:** {{CHAIN_NAME}} (chain id `{{CHAIN_ID}}`)
- **Features:** `{{FEATURES}}`
- **Zero custody.** Buyers pay you directly: buyer → router → your payout + your treasury, in one
  on-chain transaction. Nothing here ever holds keys or funds.
- **USD pricing via Chainlink.** Prices are written in dollars; the router converts to the token
  amount at the live feed price, in the same tx.

```
{{PROJECT_NAME}}/
├── app/            Next.js checkout (uses @access0x1/react <PayButton>)
│   ├── app/page.tsx            the working checkout
│   ├── access0x1.config.ts     chain + router (from env) + sponsor seams
│   ├── public/embed.js         the one-tag embed (paste into any HTML page)
│   └── .env.example            EVERY sponsor seam, as fill-in blanks
└── contracts/      Your own Foundry contracts (the real Access0x1Router)
    ├── src/ script/            Solidity + DeployAll / HelperConfig
    └── DEPLOY.md               deploy-your-own runbook (zero dependency on us)
```

---

## 5-minute quickstart

You need a **router address** for checkout to work. Pick ONE path.

### Path A — Deploy your OWN contracts (recommended)

Own a non-custodial router with zero dependency on us.

```bash
cd contracts
npm install
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge build

# Local dry-run first (no RPC, no env — fresh mocks):
anvil &                         # in another terminal
forge script script/DeployAll.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

Copy the logged `Access0x1Router deployed :` address. Full live-testnet (keystore-only) runbook:
**[`contracts/DEPLOY.md`](./contracts/DEPLOY.md)**.

### Path B — Point at an already-deployed router

If you trust an existing `Access0x1Router` on {{CHAIN_NAME}}, just use its address. (We ship no
default address — **LAW #4: never a guessed/invented address.**)

### Then: run the app

```bash
cd app
npm install
cp .env.example .env.local      # create-access0x1 already did this for you
```

Edit `.env.local` and set your router (and the chain's RPC / USDC, from the booth or your deploy):

```
{{ROUTER_ENV}}=0xYourDeployedRouter
NEXT_PUBLIC_RPC_URL_{{CHAIN_ID}}=        # confirm at booth
NEXT_PUBLIC_USDC_ADDRESS_{{CHAIN_ID}}=   # confirm at Circle booth (blank = pay native)
```

Set your `MERCHANT_ID` and price in `app/app/page.tsx`, then:

```bash
npm run dev
# open http://localhost:3000
```

Connect an injected wallet (MetaMask etc.) and pay. The bundled checkout uses
`@access0x1/react`'s `<PayButton>`, which runs the real **quote → (approve) → pay → receipt** cycle.

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
