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
node web/scripts/gen-deployments.mjs     # refresh the web deployments view

# ── re-verify only (a flaky explorer 504'd AFTER the broadcast already landed) ─
make verify-base-sepolia                 # chains with a dedicated target
make verify-chain CHAIN=84532 RPC=$BASE_SEPOLIA_RPC_URL [VERIFIER_URL=<blockscout-api>]   # any chain
RESUME=1 make deploy-base-sepolia        # retry verify against the existing broadcast, no re-deploy
```

**Redeploy these (pre-mirror today, each has a `make deploy-<chain>` target):** `deploy-arc` ·
`deploy-ethereum-sepolia` · `deploy-optimism-sepolia` · `deploy-avalanche-fuji` ·
`deploy-robinhood-testnet` · `deploy-galileo` (run `make bootstrap-createx-galileo` first). Tempo (42431)
and Hoodi (560048) have no Makefile target — deploy them with a direct `forge script script/DeployAll.s.sol
--rpc-url <rpc> --account deployer --sender $DEPLOYER --broadcast`. **Base Sepolia (84532) is already
mirrored — do NOT redeploy it** (its CREATE3 salt is claimed; a redeploy reverts).

## Status at a glance

A chain is only ever called "mirrored" once its committed `broadcast/` record carries the manifest
addresses — **don't trust this table, re-derive it** (see *How to read the live state* below).

| Chain (id) | Deployed | Mirror set | Verified (mirror) | Recorded |
| --- | --- | --- | --- | --- |
| Base Sepolia (84532) | ✅ | ✅ on-chain | ⏳ pending (`make verify-base-sepolia`) | ✅ README mirror table + `web/lib/deployments.ts` |
| Arc (5042002) | ✅ | ⏳ pre-mirror | — | pre-mirror table |
| Ethereum Sepolia (11155111) | ✅ | ⏳ pre-mirror | — | pre-mirror table |
| Optimism Sepolia (11155420) | ✅ | ⏳ pre-mirror | — | pre-mirror table |
| Avalanche Fuji (43113) | ✅ | ⏳ pre-mirror | — | pre-mirror table |
| Robinhood (46630) | ✅ | ⏳ pre-mirror | — | pre-mirror table |
| 0G Galileo (16602) | ✅ | ⏳ pre-mirror | — | pre-mirror table |
| Ethereum Hoodi (560048) | ✅ partial (8/24) | ⏳ pre-mirror | — | — |
| Tempo (42431) | ✅ partial (8/24) | ⏳ pre-mirror | — | — |
| zkSync Sepolia (300) | ⏳ not broadcast | — | — | — |

Only **Base Sepolia** carries the mirror today. The pre-mirror chains still run their own per-chain
address sets (the README "pre-mirror per-chain deploys" table) until cut over.

**Mirror coverage — 13 of 18 deployable contracts.** `DeployAll` mirrors the money spine + the auth +
commerce surface (Router, PaymentLanes, SessionGrant, HouseTokenFactory, Subscriptions, Bookings,
Invoices, GiftCards, Nft, Escrow, AutomationGateway, ProvenanceRegistry, + the Receiver). **NOT yet in
the mirror:** `GaslessPayIn`, `PriceOracleAdapter`, `Receivables`, `Refunds`, `SplitSettler` — all UUPS +
tested in `src/`, but never wired into `DeployAll`, so they have no canonical cross-chain address. Adding
them is **additive** (the existing 13 addresses don't change; regenerate `mirror-manifest.json`) and is
the open task to use CREATE3 to its fullest.

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
5. **Regen the web view** — `node web/scripts/gen-deployments.mjs` rebuilds `web/lib/deployments.ts`;
   the chain now shows the mirror set (each nameless CreateX `additionalContract` is named via
   `script/mirror-manifest.json`).
6. **Update the README** — move the chain's row to **Mirror live ✅** in the cutover-status table in
   [`../README.md`](../README.md) (and drop its now-superseded pre-mirror rows).

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
