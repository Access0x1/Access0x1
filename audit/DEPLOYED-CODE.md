# Deployed-code attestation — the live contracts ARE this repo's source

**Claim.** Every contract live on Arc Testnet (`5042002`) and Base Sepolia (`84532`) is the
bytecode produced by compiling *this* repository — same source, same compiler settings — with
nothing changed but the per-deployment addresses the constructors wire in.

This is independent of the block-explorer "verified" badges: it is a direct, reproducible
bytecode comparison anyone can re-run.

## How to reproduce

`foundry.toml` pins a deterministic build — `solc 0.8.28`, `evm_version = "cancun"`, `via_ir`,
`optimizer_runs = 200`, and crucially **`bytecode_hash = "none"`** (no per-build metadata hash),
so a clean compile is reproducible byte-for-byte.

```sh
forge build
# for each (contract, address, chain):
diff <(cast code <ADDRESS> --rpc-url <RPC>) <(forge inspect <CONTRACT> deployedBytecode)
```

On-chain runtime code is compared to the locally compiled `deployedBytecode`. Foundry zeroes every
`immutable` slot in the local artifact, so the *only* legitimate differences are the immutable
values the constructor sets at deploy time (wired contract addresses, the EIP-712 domain cache).
A difference anywhere else would be a logic difference — there are none.

## Result (verified 2026-06-17, both chains)

Runtime byte-length is **identical** for all 17 deployed instances. Two outcomes, both proving identity:

| Outcome | Contracts | What the diff is |
|---|---|---|
| **EXACT** — byte-for-byte identical, incl. metadata tail | `Access0x1Router` · `PaymentLanes` · `HouseTokenFactory` | none (these take no constructor immutables) |
| **Immutable-only** — 100% of differing bytes land on the artifact's zero-placeholder slots; metadata tail identical | `SessionGrant` · `Access0x1Subscriptions` · `Access0x1Bookings` · `Access0x1Invoices` · `Access0x1GiftCards` · `MockV3Aggregator` (Arc feed) | the constructor-wired `Access0x1Router` / `SessionGrant` addresses, the EIP-712 domain cache (`address(this)`, `chainId`, domain separator), and the feed's `decimals` |

For the immutable-only set, **every** differing position was confirmed to sit on a `0x00` slot in
the local artifact (e.g. `Access0x1Bookings`: 312 differing nibbles on Base, **100%** on zero-slots;
each differing run reconstructs to the Base `Access0x1Router` / `SessionGrant` address). No executable
opcode differs. The unchanged metadata tail (with `bytecode_hash = "none"`) further confirms the source
and compiler settings are byte-identical to this tree.

## Conclusion

The live deployment is this repo's audited source — the no-immutable contracts match exactly, and the
rest differ only in the addresses they were wired to at deploy. Whatever a judge audits here is what is
running on Arc and Base Sepolia. Addresses + tx hashes: [`../README.md` → Deployments](../README.md);
raw broadcast proof: [`../broadcast/DeployAll.s.sol/`](../broadcast/DeployAll.s.sol/).
