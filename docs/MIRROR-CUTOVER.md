# Mirror cutover — operator guide

Access0x1's whole first-party surface deploys at **one address on every chain** via CREATE3 (the
[CreateX](https://github.com/pcaversaccio/createx) factory at `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`).
The salt is `keccak256(namespace ‖ label)` tagged with the **deployer EOA**, never `block.chainid`, so the
same `Access0x1Router` proxy — **`0xe92244e3368561faf21648146511DeDE3a475EB5`** — resolves on every chain
the mirror has been cut over to. The canonical set is computed (not deployed) once and pinned in
[`../script/mirror-manifest.json`](../script/mirror-manifest.json), self-checked by
[`../script/mirror-manifest.sh`](../script/mirror-manifest.sh) (`make mirror-manifest`).

This guide is the runbook for rolling that set out chain by chain, and for keeping the README + the web
deployments view honest as each chain lands.

## The commands (deploy one chain at a time)

On this branch **`make deploy-<chain>` IS the CREATE3 mirror deploy** — `DeployAll.s.sol` deploys the
whole surface through CreateX, so there is no separate "create3" step. Deploy one chain, verify, refresh
the web view, repeat. (Full chain list: `make help`.)

```sh
# ── one-time prep ─────────────────────────────────────────────────────────────
cast wallet list            # `deployer` MUST resolve to the canonical mirror EOA — the salt embeds the
                            # signer, so a different key lands a DIFFERENT address set:
                            #   0xA121e1eF31BbF0826aa67dc01e7977e80Af58D73
# in .env:
#   DEPLOYER=0xA121e1eF31BbF0826aa67dc01e7977e80Af58D73
#   ENFORCE_MIRROR_DEPLOYER=true   # halt LOUD if the signer is wrong (can't fork the address set)
#   <CHAIN>_RPC_URL=...            # Alchemy/Tenderly (public RPCs are defaulted)
#   ETHERSCAN_API_KEY=...          # ONE Etherscan V2 key verifies every Etherscan-family explorer
#   <CHAIN>_VERIFIER_URL=...       # only for Blockscout chains (arc, mantle, galileo, …)
make mirror-manifest        # print/verify the deterministic addresses (no deploy)
make deploy-pick            # per-chain gas + which chains are already mirrored

# ── deploy ONE chain (mirror + inline verify) ─────────────────────────────────
make deploy-base-sepolia                 # swap base-sepolia for any chain
make sync                                # refresh ALL derived docs+data (web maps + README status)

# ── re-verify only (a flaky explorer 504'd AFTER the broadcast already landed) ─
make verify-base-sepolia                 # chains with a dedicated target
make verify-chain CHAIN=84532 RPC=$BASE_SEPOLIA_RPC_URL [VERIFIER_URL=<blockscout-api>]   # any chain
RESUME=1 make deploy-base-sepolia        # retry verify against the existing broadcast, no re-deploy
```

**Every chain now has a first-class `make deploy-<chain>` target** — including the two former
hold-outs, `deploy-hoodi` (560048) and `deploy-tempo` (42431 — TIP-20 stablecoin fees, see the caveat
on the target + `docs/CHAIN-ADDRESSES.md`) — so the raw `forge script` fallback is no longer needed.
Re-derive the live pre-mirror list from the table below (or `make deploy-pick`); 0G Galileo still
needs `make bootstrap-createx-galileo` once before its first deploy. **Base Sepolia (84532) is already
mirrored — do NOT redeploy it** (its CREATE3 salt is claimed; a redeploy reverts).

## Status at a glance

A chain is only ever called "mirrored" once its committed `broadcast/` record carries the manifest
addresses — **don't trust this table, re-derive it** (see *How to read the live state* below).

| Chain (id) | Deployed | Mirror set | Recorded |
| --- | --- | --- | --- |
| Arc (5042002) | ✅ | ✅ on-chain | ✅ broadcast + README mirror table |
| Base Sepolia (84532) | ✅ | ✅ on-chain | ✅ broadcast + README mirror table + `web/lib/deployments.ts` |
| Ethereum Sepolia (11155111) | ✅ | ✅ on-chain | ✅ broadcast + README mirror table |
| Optimism Sepolia (11155420) | ✅ | ✅ on-chain | ✅ broadcast + README mirror table |
| Avalanche Fuji (43113) | ✅ | ✅ on-chain | ✅ broadcast + README mirror table |
| Robinhood (46630) | ✅ | ✅ on-chain | ✅ broadcast + README mirror table |
| Arbitrum Sepolia (421614) | ✅ | ✅ on-chain | ✅ broadcast + README mirror table |
| Celo Sepolia (11142220) | ✅ | ✅ on-chain | ✅ broadcast + README mirror table |
| 0G Galileo (16602) | ✅ | ⏳ pre-mirror | pre-mirror table |
| Ethereum Hoodi (560048) | ✅ partial (pre-mirror set) | ⏳ pre-mirror | README MIRROR-STATUS (pre-mirror) |
| Tempo (42431) | ✅ partial (pre-mirror set) | ⏳ pre-mirror | README MIRROR-STATUS (pre-mirror) |
| zkSync Sepolia (300) | ⏳ not broadcast | — | — |

Per-chain **source-verification** status lives in the README Deployments section (seven of the
eight mirrored chains are explorer-verified as of 2026-07-01); this table tracks deploy/mirror
state only.

The mirror is **rolling out across the testnets** — the `MIRROR-STATUS` table in the README (regenerated
from the broadcasts by `make sync`) is the live per-chain source of truth. Chains still showing
`⏳ pre-mirror` run their own per-chain address sets until cut over.

> **Mirrored ≠ usable everywhere.** A chain showing `✅ mirror` means the contracts are *deployed* at the
> mirror addresses — a merchant still needs `registerMerchant` run on that chain's mirror before it can
> settle there. As of **2026-07-08 the mirror carries real merchants + settled native payments on Base
> Sepolia (`nextMerchantId` = 3) and Arc (`nextMerchantId` = 2)**; the other mirrored chains are still at
> `nextMerchantId` = 1 (deployed, no merchant yet). Registration is a keystore-signed, owner-run tx.
> Re-derive the live count per chain — never hand-claim it:
> `cast call 0xe92244e3368561faf21648146511DeDE3a475EB5 "nextMerchantId()(uint256)" --rpc-url <CHAIN_RPC>`.

**Mirror coverage — 20 of 20 deployable contracts.** `DeployAll` mirrors the FULL first-party
surface: the money spine + auth + commerce set (Router, PaymentLanes, SessionGrant, HouseTokenFactory,
Subscriptions, Bookings, Invoices, GiftCards, Nft, Escrow, AutomationGateway, ProvenanceRegistry, +
the Receiver), the five settlement extensions — `GaslessPayIn`, `PriceOracleAdapter`, `Receivables`,
`Refunds`, `SplitSettler` — AND the two sponsor-economics modules `Access0x1Rebates` +
`Access0x1SponsorRegistry`, each deployed impl→`ERC1967Proxy` through the same CREATE3 path (uniform
owner + mirror-Router init args; salts from the deployer + label, never `block.chainid`).
`script/mirror-manifest.json` pins all 39 addresses (19 impl+proxy pairs + the Receiver) and
`make mirror-manifest` re-derives it byte-identical. Every addition was **additive** — earlier mirror
addresses never moved. **Per-chain truth — re-derive with `cast code <proxy-addr> --rpc-url <RPC>`, NOT
a broadcast grep (see the record-gap note): Base Sepolia (84532) is now the MOST complete chain**, live
on-chain with the full 20-set (all five extensions + Rebates + SponsorRegistry). The open follow-up
flips direction from the old backlog: the OTHER seven mirrored chains (Arc, Ethereum Sepolia, OP Sepolia,
Fuji, Robinhood, Arbitrum Sepolia, Celo Sepolia) still lack the `Access0x1Rebates` +
`Access0x1SponsorRegistry` pair — backfill them with the idempotent skip-existing `make deploy-<chain>`
re-run (the `_create3` guard skips already-live contracts; never a redeploy).

> **Broadcast-record gap on 84532.** The five-extension backfill is live on Base Sepolia but has **no
> committed broadcast** documenting it (Rebates + SponsorRegistry ARE recorded via their own runs; the
> five-extension quintet is not — it was executed from a machine whose broadcast never landed in this
> repo). So the durable re-derive for the extensions is `cast code <proxy-addr>` at the manifest address,
> NOT a `grep` of `run-latest.json` — 84532's `run-latest.json` is a config-only run and greps 0 for the
> extension proxies (a false negative). Recovering the record is owner-run (commit the missing broadcast,
> or capture the Basescan creation txs).

## How to read the live state (don't trust the table — verify)

Each axis is derivable from committed artifacts, so a fresh clone can confirm it:

```sh
# Deployed?  — does the chain have a broadcast record?
ls broadcast/DeployAll.s.sol/<id>/run-latest.json

# Mirror set on-chain? — the manifest router proxy appears in the chain's broadcast,
# OR cast reads non-empty code at it on that chain's RPC:
grep -qi e92244e3368561faf21648146511dede3a475eb5 broadcast/DeployAll.s.sol/<id>/run-latest.json && echo mirror
cast code 0xe92244e3368561faf21648146511DeDE3a475EB5 --rpc-url <CHAIN_RPC>   # non-empty ⇒ live

# Mirror status across all target chains at once (gas + MIRRORED probe):
make deploy-pick

# Recorded? — the mirror address is in the README + the web view:
grep -ri e92244e3 README.md web/lib/deployments.ts
```

## The cutover sequence (per chain)

1. **CreateX present?** Most chains already carry the canonical CreateX factory. 0G Galileo (16602) does
   not yet — `make bootstrap-createx-galileo` prints the keyless pre-signed-tx runbook (owner funds the
   CreateX signer once).
2. **Pick** — `make deploy-pick` shows per-chain gas + whether the mirror is already `MIRRORED`.
3. **Deploy** — land the whole surface at the mirror addresses, with the guard ON:
   ```sh
   ENFORCE_MIRROR_DEPLOYER=true make deploy-<chain>     # e.g. deploy-base-sepolia
   ```
   This writes `deployments/<id>.json` (a name→address manifest) alongside the broadcast.
4. **Verify** — source-verify every deployed contract by address (works regardless of the CREATE3
   factory-CALL shape — the verifier enumerates `deployments/<id>.json`, else the broadcast's
   `additionalContracts`):
   ```sh
   make verify-<chain>                                  # e.g. verify-base-sepolia
   # or, generically:
   make verify-chain CHAIN=<id> RPC=<url> [VERIFIER_URL=<blockscout-api>]
   ```
5. **Refresh all derived docs + data** — `make sync` rebuilds `web/lib/deployments.ts` (the chain now
   shows the mirror set — each nameless CreateX `additionalContract` is named via
   `script/mirror-manifest.json`) AND regenerates the README's MIRROR-STATUS table, flipping the chain
   to **✅ mirror** automatically. No hand-editing — `node web/scripts/sync-readme-status.mjs --check`
   asserts the README is in sync.
6. **Commit the broadcast + the regenerated data:**
   `git add broadcast web/lib/deployments.ts web/lib/currentBytecode.ts README.md && git commit && git push`.
   (Do NOT `git add deployments/` — that dir is gitignored; the committed broadcast is the durable record.)
   Re-running an already-mirrored chain reverts with `CreateCollision` — that just means it's already done.

## Verify it landed

- `cast code 0xe92244e3368561faf21648146511DeDE3a475EB5 --rpc-url <chain>` is non-empty.
- The chain appears with `.proxy` / `.impl` labels in `web/lib/deployments.ts`.
- `npx vitest run __tests__/gen-deployments.test.ts` and the web build stay green.

## The mirror-deployer guard (why the set can silently diverge)

The CREATE3 salts embed the **signer**, so a deploy signed by a *different* keystore EOA lands cleanly at
a **different** address set — no revert — silently diverging from the published manifest. For a real
cutover, always set `ENFORCE_MIRROR_DEPLOYER=true` (override the expected EOA with `MIRROR_DEPLOYER`); a
wrong signer then fails loud with `DeployAll: signer != canonical mirror EOA`. It is **off by default** so
local/test runs and ad-hoc experiments deploy under any signer. See the guard note in the README's
*Deploy · multi-chain* section.

## Adding a new chain to the mirror

1. Add the chain's env block (RPC, `USDC_ADDRESS`, feeds, …) — see [`../.env.example`](../.env.example).
2. Add `deploy-<chain>` + `verify-<chain>` Makefile targets (mirror an existing pair).
3. Ensure CreateX (`0xba5Ed0…`) is deployed there; bootstrap if not.
4. Run the cutover sequence above.
