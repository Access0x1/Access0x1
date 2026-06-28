<!--
  FIRST-MERCHANT — the guided "first-time success" tutorial for Access0x1.

  Goal: a brand-new contributor or adopter goes from a fresh clone to *seeing
  their own money move* on a local chain, by hand, and knows exactly what to do
  when each common step fails. It is the narrative, error-walking sibling of the
  two reference docs it leans on — it does NOT restate them:

    - docs/GETTING-STARTED.md  — the three integration paths + the mental model
    - docs/MANUAL-TESTING.md   — the exhaustive per-contract `cast` runbook

  Every command and address-source here is grounded in the shipped Makefile
  targets (`make deploy-local`, `make drive-local`), the local mocks in
  script/HelperConfig.s.sol, and the Router ABI in src/Access0x1Router.sol. No
  address is hardcoded (law #4): you read yours from the deploy output / the
  broadcast record. Public, standard names only (Anvil, USDC, Chainlink).
-->

# Deploy your first merchant — a guided first run

> **What you'll have at the end:** a payments router running on a local chain,
> **your own merchant registered on it by hand**, and **one real USD-priced
> payment** settled — buyer → merchant + treasury in a single transaction, with
> the on-chain receipt and zero-custody proof in front of you. No testnet funds,
> no wallet, no private key of your own. ~10 minutes.

This is the **first-time success** walkthrough. If a step fails, don't guess —
jump to **[Troubleshooting](#troubleshooting--every-error-and-its-fix)**, where
every common error is paired with its fix. Already comfortable and just want the
exhaustive per-contract command reference? That lives in
[`docs/MANUAL-TESTING.md`](./MANUAL-TESTING.md); this doc is the gentle first lap.

**Contents**

- [0. What you need](#0-what-you-need)
- [1. Deploy locally — no keystore](#1-deploy-locally--no-keystore-make-deploy-local)
- [2. Register your merchant with `cast`](#2-register-your-merchant-with-cast)
- [3. Run a payment](#3-run-a-payment)
- [4. Inspect the logs and the on-chain receipt](#4-inspect-the-logs-and-the-on-chain-receipt)
- [5. Verify contract sources on an explorer](#5-verify-contract-sources-on-an-explorer-testnet)
- [Troubleshooting — every error and its fix](#troubleshooting--every-error-and-its-fix)

---

## 0. What you need

Three tools and one clone. (The longer, annotated install with version checks is
in [`MANUAL-TESTING.md` → A1](./MANUAL-TESTING.md#a1-install-foundry).)

| Tool | Why | Install |
| --- | --- | --- |
| [Foundry](https://book.getfoundry.sh/getting-started/installation) | `forge` / `cast` / `anvil` — the deploy + call toolchain | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| [Node.js](https://nodejs.org/) 18+ | resolves `@chainlink/contracts` for the contract build | from nodejs.org |
| [Git](https://git-scm.com/) | clone the repo | from git-scm.com |

```sh
git clone https://github.com/Access0x1/Access0x1.git
cd Access0x1
make install          # forge submodules + npm (@chainlink) + web + SDK, in the right order
make build            # forge build — should end "Compiler run successful"
```

> **Why `make install` and not just `forge build`?** Foundry resolves
> `@chainlink/contracts` from `node_modules` through a remapping, so the npm
> install has to happen first. `make install` orders it for you. If `make build`
> can't find `@chainlink/...`, that's the cause — see
> [Troubleshooting](#build-cannot-find-chainlinkcontracts).

---

## 1. Deploy locally — no keystore (`make deploy-local`)

A fresh [Anvil](https://book.getfoundry.sh/anvil/) node ships ten **unlocked**
dev accounts, so a local deploy needs **no private key and no keystore** — Anvil's
account `#0` signs everything. You'll use two terminals.

**Terminal 1 — start the chain and leave it running:**

```sh
make anvil            # local node on http://localhost:8545, chain id 31337
```

You'll see ten funded accounts printed, each with its address and private key.
Account `#0` is `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` — that's the
deployer, the router owner, and the treasury for this run.

**Terminal 2 — deploy the whole wired stack onto it:**

```sh
make deploy-local
```

On a local chain (id 31337) the deploy script first stands up the mocks a real
chain already has — a **6-decimal mock USDC**, a **mock USDC/USD Chainlink feed
pinned at $1.00**, and a mock native/USD feed — then deploys the money spine
(`Access0x1Router` and the commerce contracts) in one broadcast, and
**allowlists + prices the mock USDC on the router**. (See
[`script/HelperConfig.s.sol`](../script/HelperConfig.s.sol) →
`_localConfigWithMocks`.)

After the `-vvvv` trace, the tail is a block of addresses:

```
Access0x1Router       : 0x...      <- the router (a UUPS proxy) — note this
  ...
  USDC allowlisted    : 0x...      <- the mock USDC — note this
  USDC/USD feed       : 0x...
```

**Note the `Access0x1Router` and the `USDC allowlisted` addresses — you'll paste
them in the next step.** If you scrolled past them, read them back out of the
broadcast record Foundry wrote:

```sh
cat broadcast/DeployAll.s.sol/31337/run-latest.json \
  | jq -r '.transactions[] | select(.transactionType=="CREATE") | "\(.contractName)\t\(.contractAddress)"'
```

> **Proxy vs implementation.** The router is a UUPS proxy, so two `CREATE`
> entries share its name — point `cast` at the **proxy** (the one printed as
> `Access0x1Router` in the deploy log), not the implementation. The mock token's
> contract name in that list is `MockUSDC`.

> **Want the no-keystore promise on a one-liner?** `make drive-local` does the
> whole flow for you (deploy + register + pay) in a single self-contained
> broadcast — handy as a sanity check before you do it by hand. We use it as the
> answer key in [step 3](#3-run-a-payment).

---

## 2. Register your merchant with `cast`

Onboarding is permissionless: a single `registerMerchant` call, and the caller
becomes the merchant owner. Set a few shell variables once, then register.

```sh
export RPC=http://localhost:8545
# Anvil account #0 — the standard, PUBLIC local dev key. Local node only; never a real key.
export ME=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
export PK=0xac0974bec39a17e36ba4a6b4d238ff944bababc08a3bb9c2b9bb1c5c2e5b89b3
# paste the two addresses you noted in step 1:
export ROUTER=<Access0x1Router address from step 1>
export USDC=<MockUSDC address from step 1>
```

Register a merchant. The signature is
`registerMerchant(address payout, address feeRecipient, uint16 feeBps, bytes32 nameHash)`:

- **`payout`** — where your net payments land. Use `$ME` for this run.
- **`feeRecipient`** — where your fee leg lands; `address(0)` falls back to `payout`.
- **`feeBps`** — your optional surcharge in bps (`0` = none).
- **`nameHash`** — an identity commitment; the preimage is **not** stored on-chain.

```sh
cast send $ROUTER \
  "registerMerchant(address,address,uint16,bytes32)" \
  $ME 0x0000000000000000000000000000000000000000 0 \
  $(cast keccak "bean-scene") \
  --rpc-url $RPC --private-key $PK
```

The first merchant gets id `1`. Read the next id back and subtract one, then save it:

```sh
cast call $ROUTER "nextMerchantId()(uint256)" --rpc-url $RPC   # prints 2 after one register
export MID=1
```

Confirm your merchant config is on-chain (payout, owner, fee, active flag):

```sh
cast call $ROUTER \
  "merchants(uint256)(address,address,address,uint16,bool,bytes32)" \
  $MID --rpc-url $RPC
```

You should see your `payout` and `owner` both equal to `$ME`, `feeBps` `0`, and
the active flag `true`.

> Prefer a UI? The hosted **`/onboard`** wizard in the web app makes the same
> `registerMerchant` call from a connected wallet and shows your `merchantId` —
> see [`GETTING-STARTED.md` → Path 1](./GETTING-STARTED.md#path-1--accept-your-first-payment-react-sdk).
> The `cast` path above is the same call, by hand, so you can see exactly what
> goes on-chain.

---

## 3. Run a payment

A payment quotes a human USD price, converts to the token amount via the
Chainlink feed **inside the same transaction**, then splits and settles in one
call. We'll charge a **$5.00 latte**. USD amounts are 8-decimal, so $5.00 is
`500000000` (`5e8`).

**First, a read-only quote** — how many USDC units does $5.00 cost right now? (The
first arg is ignored; it's kept for ABI stability.)

```sh
cast call $ROUTER "quote(uint256,address,uint256)(uint256)" \
  0 $USDC 500000000 --rpc-url $RPC
```

With the feed pinned at $1.00 and 6-decimal USDC, this prints `5000000` (5 USDC).

**Now pay it.** Mint yourself some mock USDC, approve the router to pull it (the
one-time checkout approval), then `payToken`:

```sh
cast send $USDC "mint(address,uint256)" $ME 1000000000 \
  --rpc-url $RPC --private-key $PK
cast send $USDC "approve(address,uint256)" $ROUTER \
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \
  --rpc-url $RPC --private-key $PK
cast send $ROUTER "payToken(uint256,address,uint256,bytes32)" \
  $MID $USDC 500000000 $(cast keccak "order-0001") \
  --rpc-url $RPC --private-key $PK
```

The last `cast send` prints a transaction hash and `status 1 (success)`. That's a
real on-chain payment. Save the hash for the next step:

```sh
export TX=<the transactionHash printed by the payToken cast send>
```

> **Sanity-check against the answer key.** Stop here and run `make drive-local`
> in a scratch terminal — it deploys a throwaway router, registers a shop, and
> settles one $5 USDC payment, printing the same split. If its numbers match
> yours (`gross 5000000`, `net 4950000`, `router USDC bal 0`), your by-hand run
> is correct.

---

## 4. Inspect the logs and the on-chain receipt

**The receipt.** Pull the full transaction receipt — status, gas, and the events
the payment emitted:

```sh
cast receipt $TX --rpc-url $RPC
```

`status` should be `1` (success). The `logs` array holds the `PaymentSettled`
event the router emitted — that's the on-chain record of the split.

**The split, the way it's meant to be read.** Re-derive the numbers from the
quote so you can see the invariant hold:

```sh
# gross = what $5.00 cost in USDC (from the quote in step 3)
cast call $ROUTER "quote(uint256,address,uint256)(uint256)" 0 $USDC 500000000 --rpc-url $RPC
# 5000000  == 5.00 USDC gross
#   - platform fee 1% = 50000   (0.05 USDC)
#   - net to merchant  = 4950000 (4.95 USDC)
#   net + fee == gross   ✅
```

**The zero-custody proof — the headline invariant.** The router is a pass-through,
not a wallet. Its USDC balance after settlement is exactly `0`:

```sh
cast call $USDC "balanceOf(address)(uint256)" $ROUTER --rpc-url $RPC
```

**Expected:** `0`. The money left the router in the same transaction it entered —
nothing to withdraw, nothing to get hacked. (Since on a local run `payout` and
`treasury` are both `$ME`, both legs return to you; on a real merchant they land
in different wallets. The conservation and zero-custody facts are identical.)

For the full per-contract decode (`cast logs`, topic filters, event signatures),
see [`MANUAL-TESTING.md` → B1](./MANUAL-TESTING.md#b1-router--register--quote--pay--conservation--zero-custody).

---

## 5. Verify contract sources on an explorer (testnet)

A local Anvil chain has no block explorer — verification is the step you do once
you've graduated from localhost to a **public testnet**. The flow is:

1. **Deploy to a testnet.** Pick a chain and run its target, e.g.
   `make deploy-base-sepolia` (the full per-chain runbook, including funding a
   keystore, is [`docs/DEPLOY-TESTNETS.md`](./DEPLOY-TESTNETS.md)).
2. **Verify the sources.** Most chains verify automatically during deploy. To
   (re-)verify any deployed chain afterward:

   ```sh
   make verify-chain CHAIN=<chainId> RPC=<rpcUrl> [VERIFIER_URL=<blockscout-api>]
   ```

   Per-chain shortcuts exist too (`make verify-base-sepolia`,
   `make verify-arc`, …) — `make help` lists them.
3. **Confirm on the explorer.** Open the router address on the chain's explorer;
   verified contracts show a green check and a readable **Read/Write Contract**
   tab.

> **Read the address from the canonical source — never a blog post.** Every live
> testnet address, chain id, USDC token, and feed is listed in
> [`docs/CHAIN-ADDRESSES.md`](./CHAIN-ADDRESSES.md), each entry tracing to a
> committed `broadcast/` record. Confirm it on the explorer before pointing any
> value at it. (Law #4: an address that isn't on-chain isn't claimed.)

---

## Troubleshooting — every error and its fix

Work top to bottom; the errors are roughly in the order you'd hit them.

### `make: command not found` / `forge: command not found`

Foundry isn't on your PATH. Re-run `foundryup`, then either restart your shell or
`export PATH="$HOME/.foundry/bin:$PATH"`. The `make` targets prepend Foundry to
PATH themselves, so if `make build` works but a raw `cast` doesn't, this export is
all you need.

### `build` cannot find `@chainlink/contracts`

You ran `forge build` before installing npm deps. Run `make install` (it does the
npm install first, then the forge build), or `npm install` then `make build`.

### `Connection refused` / `error sending request for url (http://localhost:8545)`

Anvil isn't running. Start it in its own terminal with `make anvil` and leave it
up while you work in the second terminal.

### `make deploy-local` ran, but I lost the addresses

They're in the broadcast record. Read them back:

```sh
cat broadcast/DeployAll.s.sol/31337/run-latest.json \
  | jq -r '.transactions[] | select(.transactionType=="CREATE") | "\(.contractName)\t\(.contractAddress)"'
```

Use the **proxy** `Access0x1Router` (the one the deploy log printed) and the
`MockUSDC` address. (No `jq`? `brew install jq`, or scroll up to the address block
in the deploy output.)

### Register/quote/pay reverts with `Access0x1__TokenNotAllowed`

The router can't price that token — either it isn't allowlisted, or it has **no
price feed** configured (the "feed not configured" case). `make deploy-local`
allowlists **and** prices the mock USDC automatically, so if you hit this:

- You're using the wrong `$USDC`. It must be the **`USDC allowlisted`** address
  from the deploy output, not a different token.
- You deployed to a chain with no feed (e.g. a real testnet that lacks a
  Chainlink USDC/USD feed). The fix is to deploy a $1 mock feed and wire it:
  `make deploy-usd-mock-feed RPC=<url>`, then set the chain's `*_USDC_USD_FEED`
  env to the printed address and redeploy. See the Makefile comment above
  `deploy-usd-mock-feed` and [`docs/CHAIN-ADDRESSES.md`](./CHAIN-ADDRESSES.md).

To confirm the feed is set on a local run:

```sh
cast call $ROUTER "priceFeedOf(address)(address)" $USDC --rpc-url $RPC
```

A non-zero address means the feed is configured.

### Pay reverts with `ERC20: transfer amount exceeds allowance` (or `balance`)

You skipped a setup step. `payToken` pulls USDC from you, so you must first
**mint** yourself USDC and **approve** the router:

```sh
cast send $USDC "mint(address,uint256)" $ME 1000000000 --rpc-url $RPC --private-key $PK
cast send $USDC "approve(address,uint256)" $ROUTER \
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \
  --rpc-url $RPC --private-key $PK
```

### `quote` / `pay` reverts with `Access0x1__ZeroAmount`

The USD amount was `0`. Remember USD is 8-decimal: $5.00 is `500000000`, not `5`.

### `cast send` reverts with `Access0x1__MerchantNotFound`

`$MID` points at a merchant that doesn't exist. The first registration is id `1`.
Check the count with `cast call $ROUTER "nextMerchantId()(uint256)" --rpc-url $RPC`
— your highest valid id is that value minus one.

### My split numbers don't match the latte example

Re-check the units: USD is 8-decimal (`5e8`), the mock USDC is 6-decimal, and the
local feed is pinned at exactly $1.00. With those, `$5.00 → 5000000` USDC,
`fee 50000` (1%), `net 4950000`. If you changed the feed price or token decimals,
the amounts scale accordingly — the invariant `net + fee == gross` still holds.

---

## Where to go next

| You want to… | Read |
| --- | --- |
| Drop this into a real React app | [GETTING-STARTED.md → Path 1](./GETTING-STARTED.md#path-1--accept-your-first-payment-react-sdk) |
| The exhaustive per-contract `cast` runbook | [MANUAL-TESTING.md](./MANUAL-TESTING.md) |
| Deploy to a public testnet | [DEPLOY-TESTNETS.md](./DEPLOY-TESTNETS.md) · [CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md) |
| Understand the money spine, line by line | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Make your first code contribution | [CONTRIBUTING.md](../CONTRIBUTING.md) |

Stuck on something not covered here? Open an issue at
[github.com/Access0x1/Access0x1](https://github.com/Access0x1/Access0x1) — except
for vulnerabilities, which follow [SECURITY.md](../SECURITY.md).
