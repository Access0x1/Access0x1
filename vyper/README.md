# NameMath.vy — isolated Vyper conformance demonstrator

A standalone **Vyper** port of the canonical Solidity `src/NameMath.sol`, proving the ENS
"name → math" brand layer (deterministic brand color + 5×5 identicon SVG) reproduces **byte-for-byte
identically** in a second, independent compiler and language.

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
  tests/
    conftest.py            # boa fixture that deploys NameMath.vy
    test_conformance.py    # asserts Vyper output == pinned Solidity output, byte-for-byte
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
   **cancun**. The `.vy` file carries `# pragma evm-version cancun` (authoritative for the
   compile), and the conformance suite recompiles with an explicit cancun target and asserts it, so
   a drift to the Prague default fails the test rather than slipping through. When compiling by
   hand, pass `--evm-version cancun`.

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
running the real Solidity library under Foundry) for three vectors:

| vector      | node                                          |
|-------------|-----------------------------------------------|
| `NODE_A`    | `keccak256("merchant.access0x1.eth")`         |
| `NODE_B`    | `keccak256("alice.merchant.access0x1.eth")`   |
| `NODE_ZERO` | `bytes32(0)`                                   |

For each, it asserts the Vyper `colorOf`, `colorHex`, `identiconRawSVG`, and `identiconSVG` match
the Solidity output **exactly** — same color bytes, same `#RRGGBB` string, same SVG markup (down to
the `<rect>` emit order and the `data:image/svg+xml;utf8,` prefix). It also re-derives `colorOf`
from the documented `bytes3(keccak256(abi.encode("color", node)))` formula in Python, and checks the
determinism / distinctness / vertical-symmetry invariants the Solidity test checks.
