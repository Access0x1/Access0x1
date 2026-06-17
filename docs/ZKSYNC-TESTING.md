# Testing Access0x1 on zkSync (Era / ZK Stack) — the real gotchas

> zkSync Sepolia (chainId **300**) is one of Access0x1's three target chains (Arc, Base Sepolia,
> zkSync Sepolia — see `ChainRegistry` and `HelperConfig`). This doc records the gotchas that bite
> when you test the same contracts on the zkEVM, grounded in `foundry-zksync` reality.

## ⚠️ Deploy gotcha: `--zksync` can't run the env-reading HelperConfig (cheatcodes-in-CREATE)

`make deploy-zksync-sepolia` (`forge script --zksync`) first does a slow zksolc compile of ~199 files
(this is what looks "stuck" — it is not), then **reverts** inside `DeployAll`'s `new HelperConfig()`:

```
ERROR ...: call may fail ... due to empty code target=0x7109…12d   (the cheatcode address)
vm error: Invalid opcode, Not enough gas
```

Root cause (foundry-zksync, confirmed against its docs): **cheatcodes only work at the script ROOT —
never inside a CREATE/CALL dispatched to the zkEVM.** `HelperConfig`'s constructor calls
`vm.envAddress("ZKSYNC_SEPOLIA_PLATFORM_TREASURY")`; under `--zksync` that constructor runs *in the
zkEVM*, so the env cheatcode dies. This is a TOOLING limit, **not a contract bug** — `forge build
--zksync` exits 0 (compiles + size-checks clean for EraVM), and the identical `DeployAll` deploys fine
on every EVM chain (Arc, Base, Ethereum, Optimism Sepolia all live).

**The fix when zkSync is deployed:** read env at the SCRIPT ROOT and pass values in, rather than inside
a `new`'d helper — e.g. a dedicated `DeployAllZkSync` whose `run()` itself does the `vm.envAddress`
reads, then `new Access0x1Router(...)` (product constructors hold no cheatcodes, so they dispatch to
the zkEVM cleanly). Until then, `make deploy-all-testnets` SKIPS zkSync with a note (never stalls on
it); deploy zkSync on its own once that env-at-root script exists.

## The one rule that matters most

**`forge test` runs on the EVM, NOT the zkEVM. EVM-green does NOT mean zkSync-green.**

The default `forge test` / `forge build` compile with **solc** and execute in Foundry's EVM (revm).
zkSync Era is a **different VM** with a **different compiler** (**zksolc**). A suite that is 100% green
under `forge test` can still fail to deploy or behave differently on zkSync. To exercise the zkEVM you
must use the **foundry-zksync** fork and the `--zksync` flag:

```bash
# Install the foundry-zksync fork (separate from upstream foundry):
curl -L https://raw.githubusercontent.com/matter-labs/foundry-zksync/main/install-foundry-zksync | bash
foundryup-zksync

forge build --zksync     # compile with zksolc -> the zkEVM bytecode (catches build/size/opcode issues)
forge test  --zksync     # run the suite IN the zkEVM (catches behavioural divergence)
```

> This repo's `forge` is already the foundry-zksync fork (`forge --version` shows
> `…-foundry-zksync-…`), so `make zksync-build` (= `forge build --zksync`) works here. The normal
> gate (`make gate`) still runs the **EVM** path — that is correct for fast iteration; the `--zksync`
> path is the pre-deploy confirmation lane.
>
> **Verified on this machine (2026-06-13):** `forge build --zksync` compiled `NameMath` with
> `zksolc + solc 0.8.28` successfully in ~0.7s (the zkEVM toolchain + zksolc v1.5.x are installed and
> working). A full `forge build --zksync` of the **whole** estate is slow because `via_ir = true` is
> expensive under zksolc — run `make zksync-build` with patience (or temporarily drop `via_ir` for a
> fast per-contract zkEVM sanity check). The point stands: zksolc compiles these contracts; the
> `--zksync` lane is the one that proves it, and it is NOT what `forge test` exercises.

---

## The gotchas, with concrete guidance for THIS repo

### 1. zksolc vs solc are different compilers

`zksolc` consumes solc's Yul/IR and emits zkEVM bytecode. Consequences:

- **Some optimizations and IR behaviours differ.** This repo already pins `via_ir = true`,
  `solc 0.8.28`, `evm_version = "cancun"` (`foundry.toml`) — chosen to be zksolc-safe. Re-run
  `forge build --zksync` after any compiler/optimizer change; do not assume the solc build transfers.
- **No separate library deployment / linking.** zksolc is hostile to external library `delegatecall`
  linking. This repo deliberately keeps `OracleLib` as an `internal` library that **inlines** into the
  router (see its NatSpec) — exactly to avoid a link step on zkSync. Keep new libraries `internal`.

### 2. CREATE / CREATE2 address derivation is DIFFERENT on zkSync

This is the biggest correctness trap. On the EVM, a contract address is
`keccak256(rlp(deployer, nonce))` (CREATE) or `keccak256(0xff, deployer, salt, keccak256(initcode))`
(CREATE2). **zkSync derives addresses differently** — it uses the contract's **bytecode hash** and
`factory_deps`, not the init-code hash, and CREATE2 uses a different formula. Implications:

- **Any code that pre-computes a deployment address off the EVM CREATE/CREATE2 formula WILL be wrong
  on zkSync.** Audit for `vm.computeCreateAddress`, hand-rolled CREATE2 address math, or an off-chain
  deployer that assumes the EVM address.
- **For Access0x1 specifically:** `HouseTokenFactory.deployHouseToken` uses plain `new HouseToken(...)`
  (CREATE) and returns the address from the deployment itself — it never *predicts* the address, so it
  is safe on zkSync. **If you ever add a CREATE2 "counterfactual" address (e.g. to pre-fund a wallet),
  it must be computed the zkSync way under `--zksync`, and an EVM-derived prediction test must be
  marked zkSync-skip** (see the skip helper below).
- The **ERC-6492 / counterfactual smart-account** path in `SessionGrant` calls a factory by address
  passed in the wrapped signature — it does not derive the address itself, so it is unaffected. But the
  *factory* used in a zkSync test must itself be a zkSync-deployed contract.

### 3. The gas model is different

zkSync does not price opcodes the way the EVM does (it meters by a different resource model;
pubdata/calldata costs dominate). Therefore:

- **Do not assert exact gas numbers under `--zksync`.** The `.gas-snapshot` in this repo is an **EVM**
  snapshot — treat it as EVM-only. A gas-exact test (`assertEq(gasUsed, …)`) must be EVM-only or
  zkSync-skipped.
- The native send pattern (`to.call{value:…}("")` in the router's `_pushNativeOrQueue`) is correct on
  both, but the gas forwarded differs — never rely on a fixed 2300-gas assumption (this repo already
  avoids `.transfer`, which is the right call for zkSync smart-account payees).

### 4. System contracts & bootloader

zkSync has **system contracts** (the bootloader, `ContractDeployer`, `NonceHolder`, `L1Messenger`,
etc.) at well-known addresses. `msg.sender`/account-abstraction semantics flow through them. Most of
this repo is plain application logic and unaffected, but:

- **Native account abstraction is the default on zkSync** — every account can be a smart account.
  `SessionGrant`'s ERC-1271 / ERC-6492 validation is a good fit, but a test that assumes an EOA's
  `msg.sender` has no code may behave differently when run as an AA tx. Prefer explicit `vm.prank` of
  a known address over assumptions about code-at-sender.

### 5. Bytecode / contract-size + is-system / force-deploy

- zkSync measures **bytecode size in 32-byte words** and rejects bytecode whose word-length is even
  (among other constraints) — a different limit shape than the EVM's EIP-170 24576-byte rule. Run
  `forge build --zksync` (which surfaces zksolc size errors) **in addition to** `make sizes` (the EVM
  EIP-170 check). Passing EIP-170 does not guarantee a valid zkSync bytecode size.
- `is-system` / `force-deploy` flags are for system-level deploys; application contracts here do not
  use them. Do not set them for the Access0x1 contracts.

### 6. Some cheatcodes behave differently under `--zksync`

`foundry-zksync` reimplements cheatcodes against the zkEVM. Known divergences to watch:

- `vm.expectRevert` revert-data matching can differ for system-level reverts.
- `vm.etch` / `vm.load` / `vm.store` operate on the zkEVM state model — low-level state pokes that work
  on the EVM may not map 1:1.
- `vm.deal` / balance manipulation works but interacts with the AA/nonce model.
- **Guidance:** the unit + scenario suites here use only high-level cheatcodes (`prank`, `warp`,
  `expectRevert`, `expectEmit`, `deal`-equivalents via mints) — these are well-supported. Keep
  zkSync-run tests on high-level cheatcodes; quarantine any low-level state-poke test as EVM-only.

---

## The zkSync-aware skip pattern for this repo

Mirroring fund-me's `ZkSyncChainChecker`, add a small helper a test can use to **skip the
zkSync-incompatible cases when not actually on the zkEVM** (or to skip EVM-only assertions when on
zkSync). The detection works off the zkSync `SystemContext` / known system-contract code, with a
codesize probe as the portable fallback:

```solidity
// test/helpers/ZkSyncSkip.sol  (sketch — add when the first zkSync-divergent test lands)
abstract contract ZkSyncSkip {
    // The zkSync system-context / known-system-contract address (ContractDeployer is at 0x8006).
    address internal constant CONTRACT_DEPLOYER = 0x0000000000000000000000000000000000008006;

    /// @return True when running on a zkSync/Era VM (a system contract has code at 0x8006).
    function onZkSync() internal view returns (bool) {
        return CONTRACT_DEPLOYER.code.length > 0;
    }

    /// @notice Skip a test that relies on EVM CREATE/CREATE2 address derivation or exact gas when the
    ///         run IS on zkSync (those assumptions are EVM-only).
    modifier skipOnZkSync() {
        if (onZkSync()) return;
        _;
    }

    /// @notice Skip a test that only makes sense under --zksync (zkEVM-specific behaviour) when running
    ///         on the plain EVM.
    modifier onlyOnZkSync() {
        if (!onZkSync()) return;
        _;
    }
}
```

Usage:

```solidity
contract HouseTokenFactoryZkTest is Test, ZkSyncSkip {
    // An EVM-CREATE-address prediction is only valid off-zkSync.
    function test_predictsDeploymentAddress_evmOnly() public skipOnZkSync {
        // vm.computeCreateAddress(...) etc. — EVM CREATE formula, wrong on zkSync.
    }
}
```

> Today this repo has **no** test that asserts an EVM-derived deploy address or exact gas, so no test
> needs the skip yet — `HouseTokenFactory` returns the real deployed address and never predicts it.
> The helper is documented here so the moment a counterfactual-address or gas-exact test is added, it
> is quarantined correctly instead of silently passing on the EVM and failing on zkSync.

---

## The pre-zkSync-deploy checklist (run before `make deploy-zksync-sepolia`)

1. `make zksync-build` — `forge build --zksync` is green (zksolc compiles + sizes are valid).
2. `forge test --zksync` — the suite is green **in the zkEVM** (not just the EVM gate).
3. No test asserts an EVM CREATE/CREATE2 address or an exact gas number on the zkSync run (use the
   skip helper).
4. `foundry.toml` `[profile.zksync]` fallback (`evm_version = shanghai`) is available if a Cancun
   opcode (e.g. PUSH0) is rejected by the target — **confirm at the zkSync booth**, never make it the
   default.
5. Deploy is keystore-only (`make deploy-zksync-sepolia` uses `--account deployer`); never `--private-key`.
