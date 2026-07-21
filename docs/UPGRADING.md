# Upgrading an Access0x1 module (UUPS)

Every first-party module is a UUPS proxy: a permanent `ERC1967Proxy` at a cross-chain-identical mirror
address, delegatecalling to a swappable implementation. Upgrading means **deploy a new implementation,
then point the proxy at it** via `upgradeToAndCall`. The proxy address, and all state, are preserved.

> Authority: every module's `_authorizeUpgrade` is `onlyOwner` (OpenZeppelin `Ownable2Step`). The
> upgrade tx MUST be sent by the module's current `owner()` on that chain — the canonical mirror
> deployer `0xA121e1eF31BbF0826aa67dc01e7977e80Af58D73` for the mirror set. There is **no timelock and
> no multisig at the contract level**: whoever holds `owner()` can upgrade. Guard that key accordingly.

Tooling:
- `script/Upgrade.s.sol` — generic, driven by `MODULE` + `PROXY`.
- `scripts/sync-storage-layouts.mjs` — the storage-layout guard (`make upgrade-guard`).
- Makefile: `make upgrade-snapshot`, `make upgrade-guard`, `make upgrade-dry`, `make upgrade-<chain>`.

---

## 0. One-time setup (per repo)

Seed the committed layout snapshots the guard diffs against, then commit them:

```bash
make build
make upgrade-snapshot     # writes storage-layouts/<Module>.json for all 20 modules
git add storage-layouts && git commit -m "chore: seed storage-layout upgrade snapshots"
```

---

## 1. Pre-flight — BEFORE any broadcast

### 1a. Storage-layout guard (the one irreversible check)

An incompatible storage layout **permanently corrupts a live proxy** — no later upgrade can undo it.
The guard blocks it structurally, INCLUDING member-level changes inside a struct / array / mapping value
(the dominant pattern here, e.g. the `Escrow` behind `mapping(uint256 => Escrow)`):

```bash
make upgrade-guard                          # full-fleet CHECK (all 20 modules)
MODULE=Access0x1Escrow make upgrade-guard   # scope to one module (what the broadcast targets run)
```

Green means: for every checked module, no pre-existing slot moved/retyped/was removed at any depth, and
each `__gap`'s end slot is unchanged (new storage only carved from the gap). If you intentionally added
storage, do it the safe way (append before `__gap`, shrink `__gap` by the same count), re-run
`make upgrade-snapshot`, review, and commit — then re-run the guard.

> Optional deeper check: OpenZeppelin foundry-upgrades `Upgrades.validateUpgrade` compares the NEW impl
> against the DEPLOYED one semantically. It is **not** wired in because it needs `ffi` + `build_info` +
> the `@openzeppelin/upgrades-core` package and is unproven on this repo's foundry-zksync fork. The
> snapshot guard above is the always-on gate; add validateUpgrade only if you move to vanilla foundry.

### 1b. Dry-run the swap against the live chain (no keys)

Simulates against live proxy state: reads the current impl, deploys the new impl in simulation, and
simulates `upgradeToAndCall` as the owner — so a wrong owner, or a module **not deployed on that chain**,
fails here, not on-chain. `DEPLOYER` must be set so the simulated `--sender` is the real owner:

```bash
DEPLOYER=0xA121e1eF31BbF0826aa67dc01e7977e80Af58D73 \
  make upgrade-dry MODULE=Access0x1Escrow RPC=$BASE_SEPOLIA_RPC_URL
```

Expected tail:
```
current impl     : 0x…(old)
new impl         : 0x…(fresh)
impl slot now    : 0x…(fresh)   # == new impl in simulation
```

Two distinct early failures tell you *why* a run can't proceed:
- `PROXY has no code on this chain` → the module isn't deployed there (see §2 coverage table). Nothing
  to upgrade.
- `--sender is not owner()` → the module IS deployed but the signer doesn't hold `owner()` there.

---

## 2. Broadcast — one command per chain

Signs with the keystore (`--account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER)`), identical to the deploy
targets. `PROXY` is auto-resolved from `script/mirror-manifest.json`; override with `PROXY=0x…`. The
new impl is a plain `new` deploy (a top-level CREATE), so the inline verify clause auto-verifies it.
Each broadcast target runs the storage guard (scoped to `MODULE`) first.

```bash
# Base Sepolia
make upgrade-base-sepolia     MODULE=Access0x1Escrow
# Ethereum Sepolia
make upgrade-ethereum-sepolia MODULE=Access0x1Escrow
# Arbitrum Sepolia
make upgrade-arbitrum-sepolia MODULE=Access0x1Escrow
# OP Sepolia
make upgrade-optimism-sepolia MODULE=Access0x1Escrow
# Avalanche Fuji
make upgrade-avalanche-fuji   MODULE=Access0x1Escrow
# Arc testnet (Blockscout verify)
make upgrade-arc              MODULE=Access0x1Escrow
# Celo Sepolia
make upgrade-celo-sepolia     MODULE=Access0x1Escrow
# Robinhood testnet (Blockscout verify)
make upgrade-robinhood-testnet MODULE=Access0x1Escrow
# zkSync Era Sepolia — PLAIN EVM path, NO --zksync (see note below)
make upgrade-zksync-sepolia   MODULE=Access0x1Escrow
```

If the explorer 504'd the verify poll after the tx landed, re-verify without re-deploying:
`RESUME=1 make upgrade-base-sepolia MODULE=Access0x1Escrow`.

> **zkSync gotcha (do not deviate):** `upgrade-zksync-sepolia` uses the SAME plain-EVM path as
> `deploy-zksync-sepolia` — **NO `--zksync` flag.** The mirror proxies on zkSync were deployed under
> Era's EVM interpreter with standard EVM bytecode. Compiling the impl with `--zksync` (zksolc) produces
> native-EraVM bytecode; pointing an EVM-interpreter proxy at an EraVM impl breaks delegatecall/bytecode
> semantics and can hard-brick the proxy. Always upgrade zkSync with the plain path.

### Where each module actually lives (deploy truth, 2026-07-21)

There are **no ownership gaps** — every module that is deployed on a chain is owned by the canonical
deployer and is upgradeable by it. What differs is *which* chains a module was deployed to. Two modules
are NOT on the full mirror set:

| Module | Deployed on | NOT deployed on |
|---|---|---|
| `Access0x1SponsorRegistry` | Base Sepolia, Ethereum Sepolia, zkSync Sepolia (300), Robinhood (46630) | OP · Arbitrum · Fuji · Celo · Arc |
| `Access0x1Rebates` | Base Sepolia, Ethereum Sepolia, zkSync Sepolia (300), Robinhood (46630) | OP · Arbitrum · Fuji · Celo · Arc |
| all other mirror modules | every live mirror chain | — |

On a chain where a module isn't deployed, its mirror address has no code, so `make upgrade-<chain>` fails
fast with `PROXY has no code on this chain` — nothing to upgrade there, by design. (Re-derive this table
from ground truth after any new deploy: `cast code <proxy>` / `cast call <proxy> "owner()(address)"` per
chain — never hand-carry it.)

> **`ChainRegistry` is special:** it is a real 20th UUPS module but is **not** in
> `script/mirror-manifest.json` (it's deployed separately with a per-chain-DISTINCT address), so
> `proxy-of.mjs` cannot resolve it and the "same address on every chain" assumption does NOT hold for it.
> Upgrade it by passing the chain's actual proxy explicitly: `PROXY=0x… make upgrade-<chain>
> MODULE=ChainRegistry`, after confirming `owner()` on that chain.

---

## 3. Post-upgrade verification (per chain)

1. **EIP-1967 impl slot now = the new impl:**
   ```bash
   cast storage <PROXY> \
     0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc \
     --rpc-url $RPC
   # right-most 20 bytes == the "new impl" the script printed
   ```
2. **Preserved-state sanity read** — confirm existing state survived. Read something set before the
   upgrade, e.g. for `Access0x1Escrow`:
   ```bash
   cast call <PROXY> "owner()(address)"       --rpc-url $RPC   # unchanged owner
   cast call <PROXY> "nextEscrowId()(uint256)" --rpc-url $RPC   # unchanged counter
   ```
   For the Router, read `platformTreasury()` / `platformFeeBps()`; the values must match pre-upgrade.
3. **Explorer verify** — the inline verify clause usually handles it. If not, verify by address:
   ```bash
   forge verify-contract <NEW_IMPL> src/Access0x1Escrow.sol:Access0x1Escrow \
     --chain <chainId> --watch --etherscan-api-key $ETHERSCAN_API_KEY
   ```
   The proxy itself is already verified as `ERC1967Proxy` and does not change.
4. **Refresh committed artifacts:** `make sync` (ABIs, README status, badges). The ABI only needs
   re-commit if the module's interface changed.

---

## 4. Rollback reality

There is **no automatic rollback**. UUPS only moves forward — but "forward to the previous logic" is a
valid move: deploy the OLD implementation's source again and `upgradeToAndCall` the proxy to it (a
normal `make upgrade-<chain>` run with the prior source checked out). That restores the prior behavior;
it does **not** undo any storage a bad upgrade already wrote. This is exactly why the storage-layout
guard (step 1a) is mandatory and non-negotiable: layout corruption cannot be rolled back, so it must be
prevented, never repaired.

### Reinitializers (future)

No module currently uses a reinitializer (all at init version 1), so upgrades pass empty data
(`upgradeToAndCall(newImpl, "")`). If a future impl adds storage needing setup, add a
`reinitializer(2)` function to it and upgrade WITH calldata — do not re-encode `initialize` (it
reverts on an already-initialized proxy). Extend `script/Upgrade.s.sol` to pass that calldata instead
of `""` for that module/version.
