# hooks/ — Access0x1's Uniswap v4 hooks

A self-contained Foundry workspace, built from a hardened v4 hook template. It is separate from the main build on purpose: the main build is
solc 0.8.28 with via_ir on, and hooks here are 0.8.30 with via_ir off and the official PoolManager
bytecode in tests. Nothing here imports `../src`; the Router is reached through a five-line interface.

```bash
cd hooks
./install-deps.sh     # libraries at pinned SHAs, checked
forge test            # 19 tests
make context          # the manifest in context/ against the code
```

| File | What it is |
|---|---|
| `src/Access0x1ReceiptHook.sol` | afterSwap receipt for any pool. A merchant claim in hook data is marked verified only when the merchant is active on the Router and its own wallet made the swap. No fee, no funds, no admin; nothing in hook data can fail a swap. |
| `src/Access0x1SwapRouter.sol` | Minimal exact-input router that holds nothing and tells hooks who the user is (`msgSender()`). A merchant trusts it with `setRouterTrust`. |
| `script/DeployHook.s.sol` | Mines a `0x40` address (never `0x91…`), deploys through the CREATE2 deployer, Sepolia / Base Sepolia / Unichain Sepolia only, bound to the Router at `0xe92244e3…5EB5`. |
| `script/handoff/run.sh` | The only way it is sent. Dry run by default; `LIVE=1` needs a terminal and the typed word `SEND`. |
| `context/Access0x1ReceiptHook.json` | What an AI reviewer reads instead of the code; `make context` fails if it drifts. |

Deploy (owner):

```bash
ACCOUNT=<keystore> SENDER=<address> bash hooks/script/handoff/run.sh deploy sepolia
```
