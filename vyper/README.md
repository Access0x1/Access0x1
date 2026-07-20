# Vyper conformance demonstrators — NameMath + NameDie

Standalone **Vyper** twins of the canonical Solidity brand layer, proving the ENS "name → math"
algorithms reproduce **byte-for-byte identically** in a second, independent compiler and language:

- **`NameMath.vy`** — port of `src/NameMath.sol`: deterministic brand color + 5×5 identicon SVG.
- **`NameDie.vy`** — the ENS-name → **die** twin: the SAME keccak brand color (so a name's die and
  identicon always match, the background nudge included), with **rarity by name length** as die sides —
  3 (legendary, ≤3 chars), 6 (rare, 4), 9 (standard, 5+) — mirroring ENS's own inverse-length pricing.
  Pure: the VRF "roll" and the off-chain normalized char-length live in the router, so it has no oracle dependency.

This is **additive and isolated**, not a production replacement:

- The Solidity `NameMath` library remains the **canonical** implementation wired into the router.
- This directory lives entirely under `vyper/` so it **cannot** interfere with the Foundry gate:
  `foundry.toml` pins `src = "src"`, so `forge build` / `forge test` never see `vyper/*.vy`.
- Its only job is to demonstrate — and continuously prove via a test — that the algorithm is
  language-independent: same keccak derivation, same `#RRGGBB` color, same identicon SVG bytes.

## Why Vyper is sound for *this* specifically

`NameMath` is **pure math over a single `bytes32`**: no money, no storage, no external calls, no
access control. The blast radius of any compiler difference is therefore **nil** — a divergence
surfaces immediately as a failed byte-for-byte conformance assertion in CI, never as lost funds.
That makes it the ideal, low-risk surface to demonstrate a second toolchain.

## Layout

```
vyper/
  moccasin.toml            # mox project config (src/, out/)
  src/NameMath.vy          # the Vyper port (@external @pure; pragma version ~=0.4.0, evm-version cancun)
  src/NameDie.vy           # the ENS-name → die twin (same brand color, sides by name length)
  tests/
    conftest.py            # boa fixtures that deploy NameMath.vy + NameDie.vy
    test_conformance.py    # NameMath: asserts Vyper output == pinned Solidity output, byte-for-byte
    test_namedie.py        # NameDie: color conforms to NameMath ground truth + die SVG byte-for-byte
  README.md
```

## Toolchain (verified working: Python 3.13, vyper 0.4.3, moccasin 0.4.4, titanoboa 0.2.8)

Install with [`uv`](https://docs.astral.sh/uv/) so the tools get their own **Python 3.13**
environments:

```bash
uv tool install moccasin        # provides `mox` (bundles titanoboa) — runs the conformance test
uv tool install vyper           # provides the `vyper` CLI — for a standalone compile
```

Confirm:

```bash
vyper --version                 # 0.4.3+commit...
mox --version                   # Moccasin CLI v0.4.4
```

### Caveats you MUST honor

1. **Python 3.13, not the macOS system 3.9.** `uv tool install` gives the tools a 3.13 env. The
   system `python3.9` backtracks to a broken `titanoboa 0.1.6` that fails to import — do not run the
   suite under it. If you build a venv by hand, use `uv venv --python 3.13`.
2. **Target cancun, always.** vyper 0.4.3 defaults to the **Prague** EVM, but this repo pins
   **cancun**. Both `.vy` files carry `# pragma evm-version cancun`, which is **authoritative AND
   hard**: the compiler raises `settings conflict!` if you pass a *different* `--evm-version` (e.g.
   `shanghai`), so the leaf can never be silently compiled for the wrong target. The conformance
   suite also recompiles with an explicit cancun target and asserts it. When compiling by hand, pass
   `--evm-version cancun` (or nothing — the pragma decides).

> If a `pip`/venv install (rather than `uv`) is used, create it explicitly on 3.13:
> `python3.13 -m venv .venv && .venv/bin/pip install titanoboa pytest coverage`, then
> `.venv/bin/python -m pytest tests -q`. This is what the orchestrator's gate uses.

## Run it

Compile only (emits bytecode + ABI):

```bash
vyper --evm-version cancun vyper/src/NameMath.vy          # bytecode
vyper --evm-version cancun -f abi vyper/src/NameMath.vy   # abi
```

Run the byte-for-byte conformance test (Vyper output == Solidity output):

```bash
cd vyper && mox test
# or, equivalently, a plain titanoboa pytest from this dir:
#   pytest tests/
```

From the repo root, the guarded Makefile targets also work (they no-op with a clear message if the
snake toolchain is not installed, so they never break a Solidity-only checkout):

```bash
make vyper-build
make vyper-test
```

## What the conformance test proves

`tests/test_conformance.py` pins the **ground-truth outputs of `src/NameMath.sol`** (extracted by
running the real Solidity library under Foundry) for four vectors:

| vector      | node                                          | what it exercises |
|-------------|-----------------------------------------------|-------------------|
| `NODE_A`    | `keccak256("merchant.access0x1.eth")`         | typical name |
| `NODE_B`    | `keccak256("alice.merchant.access0x1.eth")`   | typical name |
| `NODE_ZERO` | `bytes32(0)`                                   | zero edge |
| `NODE_BG`   | `0x…195cef` (brute-found)                      | **I-4 nudge branch** — raw color == background `0xF4F4F5`, must nudge to `0xE5E5E4` |

For each, it asserts the Vyper `colorOf`, `colorHex`, `identiconRawSVG`, and `identiconSVG` match
the Solidity output **exactly** — same color bytes, same `#RRGGBB` string, same SVG markup (down to
the `<rect>` emit order and the `data:image/svg+xml;utf8,` prefix).

### Differential fuzz (the completeness step)

`test_conformance.py` and `test_namedie.py` also run a **differential fuzz**: every public function
is checked byte-for-byte against a faithful pure-Python Solidity reference (`tests/namemath_ref.py`)
over a large deterministic-random sample of the `bytes32` input space (seeded, so any failure is
reproducible) plus explicit edge nodes (all-zero, all-ones, min, max, the BG-collision node). The
reference is itself kept honest — `test_reference_matches_pinned_solidity` asserts it reproduces the
Foundry-extracted ground truth for the pinned vectors, so a bug in the reference cannot mask a real
Vyper divergence. This is the safety argument for the Vyper leaf: the twins are proven identical
*everywhere sampled*, not only at 3–4 points.

> **Regression note (fixed here).** Before this hardening, `NameMath.vy._color_of` was **missing the
> I-4 legibility nudge** that the canonical Solidity `colorOf` carries (`color == BG ? color ^ 0x111111
> : color`). None of the original 3 vectors hit the ~1-in-2²⁴ background collision, so the gap was
> invisible. On the colliding node it returned the un-nudged `0xF4F4F5` while Solidity (and the
> `NameDie.vy` twin, which *did* nudge) returned `0xE5E5E4` — a real, silent twin divergence. The
> nudge is now mirrored in `NameMath.vy`, `NODE_BG` pins it, and the differential fuzz proves the
> whole surface conforms. (A negative-control run — strip the nudge → 7 tests fail on exactly
> `0x…195cef` — confirms the tests actually catch it.)

## Measured coverage (honest)

Measured with **boa's coverage.py plugin** (`coverage run --rcfile … -m pytest`, `plugins =
boa.coverage`):

| file            | stmts | cover | uncovered |
|-----------------|-------|-------|-----------|
| `NameDie.vy`    | 57    | **100%** | — |
| `NameMath.vy`   | 93    | **92%**  | the 4-digit (`num >= 1000`) branch of the internal `_to_string` |
| **total**       | 150   | **95%**  | |

The only uncovered lines are **provably unreachable**: `_to_string` is only ever called on grid
coordinates, whose maximum is `_SIZE == 500` — never ≥ 1000 — so the 4-digit branch cannot execute
through the public API. It is kept as a totality guard for the `String[4]` envelope; deleting it to
chase 100% would remove defensive code from a leaf primitive (the wrong trade). The test
`test_to_string_four_digit_branch_is_provably_unreachable` pins the reason (every decimal token in
any identicon SVG is one of `{0,100,200,300,400,500}`, all ≤ 3 digits).

## Turnkey recipe — adding the next Vyper leaf (ADR-compliant)

Per the accepted ADR, Vyper is for **isolated pure/leaf primitives whose compiler-bug blast radius
is $0** — never money, storage, OZ, signatures, or custody. To add one:

1. **Confirm it qualifies:** `@external @pure` only; no storage, no external call, no access control,
   no value. If it touches any of those, it stays Solidity (the ADR forbids the port).
2. **Copy the pragmas verbatim** into the new `vyper/src/Foo.vy`:
   `# pragma version ~=0.4.0` + `# pragma evm-version cancun`. The cancun pin is authoritative and
   **hard** — the compiler raises `settings conflict!` if anything tries to override it, so the leaf
   can never be silently emitted for a different EVM target.
3. **Mirror the Solidity twin byte-for-byte**, especially any post-hash adjustment (like the I-4
   nudge). Replicate `abi.encode(...)` preimages explicitly with `concat` and truncate/slice exactly
   as the Solidity does.
4. **Add a differential test** reusing `tests/namemath_ref.py`'s pattern: a faithful Python reference
   validated against Foundry ground truth, then a seeded fuzz asserting `vyper_out == reference` for
   every public function — *including a vector that drives each branch* (brute-force a collision if a
   branch is 1-in-N, as `NODE_BG` does).
5. **Gate:** `python3.13 -m pytest vyper/tests` green; measure coverage with the boa plugin and
   document any intentionally-unreachable defensive lines honestly.
