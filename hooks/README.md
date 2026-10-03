# hooks/ — Access0x1's Uniswap v4 hooks

A self-contained Foundry workspace, built from a hardened v4 hook template. It is separate from the main build on purpose: the main build is
solc 0.8.28 with via_ir on, and hooks here are 0.8.30 with via_ir off and the official PoolManager
bytecode in tests. Nothing here imports `../src`; the Router is reached through a five-line interface.

```bash
cd hooks
./install-deps.sh     # libraries at pinned SHAs, checked
forge test            # 39 tests
make context          # the manifest in context/ against the code
```

| File | What it is |
|---|---|
| `src/Access0x1ReceiptHook.sol` | afterSwap receipt for any pool. A merchant claim in hook data is marked verified only when the merchant is active on the Router and its own wallet made the swap. No fee, no funds, no admin; nothing in hook data can fail a swap. |
| `src/Access0x1MemberFeeHook.sol` | A merchant's dynamic-fee pool where members of its chosen membership tier pay a lower fee (both fees set by the merchant, capped at 10%). Mask `0x2080`. |
| `src/Access0x1SessionBudgetHook.sol` | Caps your own swaps with a SessionGrant budget (delegate = this hook); past the budget, expiry or revocation the swap reverts. Only the session owner can charge it. Mask `0x80`. |
| `src/Access0x1SwapRouter.sol` | Minimal exact-input router that holds nothing and tells hooks who the user is (`msgSender()`). A merchant trusts it with `setRouterTrust`. |
| `script/DeployHook.s.sol` | `DeployHook`, `DeployMemberFeeHook`, `DeploySessionBudgetHook`, `DeploySwapRouter`. Each mines its own mask (never `0x91…`), deploys through the CREATE2 deployer, Sepolia / Base Sepolia / Unichain Sepolia only, bound to the Router at `0xe92244e3…5EB5`. |
| `script/handoff/run.sh` | The only way it is sent. Dry run by default; `LIVE=1` needs a terminal and the typed word `SEND`. |
| `context/*.json` | One per hook: what an AI reviewer reads instead of the code; `make context` fails if it drifts. |

Deploy (owner):

```bash
ACCOUNT=<keystore> SENDER=<address> bash hooks/script/handoff/run.sh deploy sepolia
# the other contracts, dry run:
forge script script/DeployHook.s.sol:DeployMemberFeeHook --rpc-url <testnet rpc>
```

## Deployed (2026-10-02)

All twelve: receipt status 1, source-verified on the chain's explorer. Run records are in
`broadcast/DeployHook.s.sol/<chainId>/`.

| Chain | Contract | Address | Deploy tx |
|---|---|---|---|
| Sepolia | Access0x1ReceiptHook | `0x8dd207ebfc15a2fbc87469100377d965faa38040` | `0xff6434da…` |
| Sepolia | Access0x1MemberFeeHook | `0x35c946ff38e6623d696f96a515d603977cb46080` | `0x0d622976…` |
| Sepolia | Access0x1SessionBudgetHook | `0x47fed9386ceeba91a282eb1e199aaed0c83e4080` | `0x0a89e532…` |
| Sepolia | Access0x1SwapRouter | `0x769e47b3c0fe99a565b991042d1e0448b889611b` | `0x26a1611d…` |
| Base Sepolia | Access0x1ReceiptHook | `0x4087dc2f575d9274e08e23526b5604f6c912c040` | `0x7b34b9aa…` |
| Base Sepolia | Access0x1MemberFeeHook | `0x82c296e7577a24a735740361bf42af8189b3a080` | `0x12e06dab…` |
| Base Sepolia | Access0x1SessionBudgetHook | `0x49a2f3c90ed3ef4f696b0df900dfe3e8e2c88080` | `0xcdfc048c…` |
| Base Sepolia | Access0x1SwapRouter | `0x00ded390f459c739b7841e20153d98cf093d1640` | `0x41cede9d…` |
| Unichain Sepolia | Access0x1ReceiptHook | `0xd858b6d6bd11d12986cc397711caa75e817f8040` | `0x7fa23d43…` |
| Unichain Sepolia | Access0x1MemberFeeHook | `0x37404270bd87641b82c6e7ab4828a172fbc06080` | `0x13fef33b…` |
| Unichain Sepolia | Access0x1SessionBudgetHook | `0x70d3c6ec4ac174a6b1942a188bb64a85396e4080` | `0xf3aae63a…` |
| Unichain Sepolia | Access0x1SwapRouter | `0xe0576eb07283d5065b8dec1d6f1f9023f45b0a88` | `0xf1b019b4…` |
