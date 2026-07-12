# `abis/` — the committed ABI of every deployed contract

**The law:** the ABI is never missing from any contract we have deployed. A
deployed contract with no committed ABI can't be used by a fresh clone — no
frontend, SDK, subgraph, or script can encode/decode it without rebuilding from
source.

Every `<Contract>.json` here is the full ABI of a contract that appears in a
`deployments/<chainId>.json` manifest (proxies excluded — a proxy shares its
implementation's ABI). Each file is generated verbatim from the compiled Foundry
artifact (`out/<C>.sol/<C>.json` `.abi`), so it is the same ABI that is live
on-chain.

## Regenerate

```sh
make abis          # forge build + regenerate this dir + enforce the law
# or, if out/ is already fresh:
node scripts/sync-deployed-abis.mjs --write
```

`make sync` (run after every deploy) also refreshes this directory, so a newly
deployed contract's ABI lands automatically.

## The enforcement (CI gate)

```sh
node scripts/sync-deployed-abis.mjs      # exit 1 if any deployed contract's ABI is missing, stale, or orphaned
```

CI runs this after `forge build`. It fails if:

- a contract in any `deployments/*.json` has no `abis/<C>.json` (**missing** — a
  new deploy that forgot its ABI),
- a committed ABI differs from the fresh compiled artifact (**stale** — a deployed
  interface changed without regenerating), or
- an `abis/<C>.json` exists for a contract in no deployment manifest (**orphan**).

So the law is structural: you cannot land a deployed contract on `main` without a
current ABI for it.

> Note: `clear-signing/abi/Access0x1Router.abi.json` remains the canonical Router
> ABI for the clear-signing / Ledger path and the curated web+SDK subset check
> (`scripts/sync-abi.mjs`). `abis/Access0x1Router.json` here is the same ABI from
> the same artifact; the two are consistent by construction (both are `forge`
> output).
