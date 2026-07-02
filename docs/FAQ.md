# FAQ — common questions & objections

The questions a developer, a merchant, or a skeptical reviewer asks before they
trust Access0x1 with a payment. Answers are scoped to **what's actually in this
repo** — every claim links to the file or doc that backs it (law #4: if it isn't
on-chain or in the code, it isn't claimed).

New here? Read [GETTING-STARTED.md](./GETTING-STARTED.md) first, then come back
for the edge cases. Onboarding a store step by step?
[INTEGRATION-CHECKLIST.md](./INTEGRATION-CHECKLIST.md) is the runbook.

---

## What is this, in one sentence?

One shared, multi-tenant [`Access0x1Router`](../src/Access0x1Router.sol) contract
that takes a **USD-priced** crypto payment in a single on-chain transaction and
splits it buyer → merchant + treasury in the same block, with **zero custody** —
plus a [`@access0x1/react`](../packages/react) SDK and a one-tag `embed.js` so you
never write Solidity to accept money. See [ARCHITECTURE.md](./ARCHITECTURE.md).

## Why would I use this instead of a hosted payment processor?

Different trade, not a drop-in replacement. A hosted processor holds the funds,
owns the dashboard, and can freeze or claw back an account. Access0x1 is
**non-custodial by construction** — the router's steady-state balance is ~0, the
net lands in *your* payout address inside the settlement tx, and there is nothing
in the contract for anyone (including us) to withhold. You trade a managed account
for self-custody and an open, forkable, MIT-licensed stack. If you need chargeback
mediation, fiat rails, and a support line, a hosted processor is the right tool;
if you want USD-priced crypto settlement you fully control, this is.

## Why not just build the contract myself?

You can — it's MIT and the source is right here. What this saves you is the part
that's easy to get subtly wrong: exact fee math (`net + fee == gross`, always),
the Chainlink staleness + L2-sequencer-uptime guards, fee-on-transfer-token
rejection, the never-blockable refund leg in [Bookings](../src/Access0x1Bookings.sol),
and a test suite + audit pass over all of it (see the
[security posture](../README.md#security-posture) and [audit/](../audit)). The
[ARCHITECTURE.md](./ARCHITECTURE.md) walk-through exists precisely so you can read
every line before you trust it.

## Can I run this on mainnet?

**Not from this repo as published.** This is an **ETHGlobal NY 2026 testnet build**
— the contracts are deployed and verified on testnets only, and there are **no
mainnet deployments and no mainnet claims** (see the banner at the top of the
[README](../README.md)). Nothing in the code hard-blocks a mainnet deploy — it's
standard Solidity behind UUPS proxies — but doing so is **on you**, and you should
not until you've commissioned your own independent audit, set real treasury/feed
config for that chain, and re-run the full gate. The maintainers do not publish or
endorse mainnet addresses.

## What if the Chainlink price feed goes down or returns a stale price?

Settlement **reverts** — it never prices off a bad number. `quote()` reads the
feed through [`OracleLib`](../src/libraries/OracleLib.sol), which:

- rejects an answer older than the per-feed staleness window (default 1h
  `TIMEOUT`; a per-feed `maxStaleness` for slow-heartbeat feeds like USDC/USD),
- rejects a round that never completed (`updatedAt == 0`) or a carried-over answer
  (`answeredInRound < roundId`),
- on L2s with a configured Sequencer Uptime feed, rejects pricing while the
  sequencer is down or inside its 1h post-restart grace window.

A reverted payment takes no funds — the buyer simply retries once the feed is
healthy. The **refund** legs (e.g. [Bookings `claimRefund`](../src/Access0x1Bookings.sol))
are deliberately oracle-free, so a stale feed can never block a refund. See the
[oracle staleness guard](./GLOSSARY.md#oracle-staleness-guard) glossary entry.

## Where do I get the router address? Can I trust the one in a tutorial?

Always read it from **[CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md)** (the single
source of truth — each entry traces to a committed `broadcast/` record) or the
README **Deployments** table, and confirm it on the block explorer before pointing
real value at it. The SDK and the starter template ship **no default address** by
design (law #4) — you pass the one you trust. Never reuse an address from a blog
post or an old snapshot.

## Can I fork the router (or any contract)?

Yes — it's [MIT](../LICENSE). Fork it, deploy your own instance, change the fee
model, swap the oracle. If you do, please keep the attribution the license
requires and read [STORAGE-LAYOUT.md](./STORAGE-LAYOUT.md) first — the contracts
are UUPS-upgradeable with append-only storage behind a `uint256[50]` gap, so the
one rule that bites forkers is **never reorder existing storage slots**. For
changes you'd like upstreamed instead, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Is there a testnet-to-prod runbook?

There's a **testnet-to-testnet cutover** runbook — [MIRROR-CUTOVER.md](./MIRROR-CUTOVER.md)
— covering the CREATE3 mirror (one address on every chain), the per-chain
`make deploy-<chain>` → verify → `make sync` sequence, and the mirror-deployer
guard. To stand up your own wired stack on a fresh testnet, follow
[DEPLOY-TESTNETS.md](./DEPLOY-TESTNETS.md) (and [ARC-DEPLOY.md](./ARC-DEPLOY.md) /
[ZKSYNC-TESTING.md](./ZKSYNC-TESTING.md) for the chain-specific paths). There is
**no published mainnet runbook** — see "Can I run this on mainnet?" above.

## Does the protocol ever hold my money?

No. Settlement is atomic — pull → split → push, all in one tx — and the router's
steady-state balance is zero. The one exception is value owed *back*: if a payee
contract rejects the net push, the receipt still stands and the funds are
reclaimable via `claimRescue` — they are never stuck and never silently kept. This
is the [zero-custody](./GLOSSARY.md#zero-custody) guarantee.

## What stops the platform from taking a huge fee?

The total fee (platform cut + your optional surcharge) is hard-capped at
`MAX_FEE_BPS = 1000` bps (**10%**), enforced on every payment — a fee change can
never push an existing surcharge past the cap. The platform cut always lands at
the treasury and a merchant can never redirect it; your surcharge always lands at
your fee recipient. See [`MAX_FEE_BPS`](./GLOSSARY.md#basis-points-bps--max_fee_bps).

## Do my buyers need crypto or a browser wallet?

Not necessarily. The web layer integrates an embedded-wallet sign-in so a buyer
who has never held crypto can complete a checkout, and the app defaults to a
gas-free USDC path on Arc (where USDC is the native gas token). Both are
**off the money path** — the on-chain settlement is the same `payNative` /
`payToken` call either way. See the [Built on](../README.md#built-on) section for
the exact integrations and their fail-soft behavior.

## How do I register a merchant and start taking payments?

Once: a permissionless
`registerMerchant(payout, feeRecipient, feeBps, nameHash)` call returns your
`merchantId` and makes you the merchant owner. Then point any of the three
drop-ins (React `<PayButton>`, `embed.js`, or the hosted checkout) at that id.
The full step-by-step is in [INTEGRATION-CHECKLIST.md](./INTEGRATION-CHECKLIST.md);
the SDK paths are in [QUICKSTART.md](./QUICKSTART.md).

## I found a security bug. Where do I report it?

**Not** in a public issue or PR. Follow the private disclosure process in
[SECURITY.md](../SECURITY.md).

---

Question not here? Open an issue at
[github.com/Access0x1/Access0x1](https://github.com/Access0x1/Access0x1) — except
vulnerabilities, which follow [SECURITY.md](../SECURITY.md).
