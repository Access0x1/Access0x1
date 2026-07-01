"""Byte-for-byte conformance: Vyper NameMath.vy == Solidity src/NameMath.sol.

The EXPECTED_* constants below are the GROUND-TRUTH outputs of the canonical Solidity
`src/NameMath.sol`, extracted by running the real Solidity library under Foundry (a throwaway
`forge script` that called the test harness and logged `colorOf`, `colorHex`, `identiconRawSVG`, and
`identiconSVG` for each vector). They are pinned here verbatim. If the Vyper port ever diverges from
the Solidity contract — in the keccak derivation, the color hex, the SVG bytes, the emit order, or
the data-URI prefix — one of these assertions fails. That is the whole point: this file PROVES the
two compilers/languages produce identical output, so the Vyper twin can never silently drift from
the production Solidity version.

Vectors (the same nodes the Solidity test uses, plus the zero node as an edge case):
  NODE_A    = keccak256("merchant.access0x1.eth")
  NODE_B    = keccak256("alice.merchant.access0x1.eth")
  NODE_ZERO = bytes32(0)

CANCUN: NameMath.vy carries `# pragma evm-version cancun`; `test_compiles_targeting_cancun`
recompiles it with an explicit cancun target and asserts the compiler accepted it, so a drift to
vyper 0.4.x's Prague default is caught here rather than slipping through.
"""

import random

import pytest
from eth_utils import keccak
from vyper import compile_code
from vyper.compiler.settings import Settings

import namemath_ref as ref

# ─── vectors ─────────────────────────────────────────────────────────────────────────────────
NODE_A = keccak(text="merchant.access0x1.eth")
NODE_B = keccak(text="alice.merchant.access0x1.eth")
NODE_ZERO = b"\x00" * 32

# BACKGROUND-COLLISION vector (audit I-4 / nudge branch): the ~1-in-2^24 namehash whose RAW brand
# color `bytes3(keccak(abi.encode("color", node)))` equals the neutral background `0xF4F4F5`.
# Solidity `colorOf` XORs a fixed nudge (`^ 0x111111 == 0xE5E5E4`) so the mark is never invisible;
# the Vyper twin MUST do the same. This node was found by brute-forcing the 3-byte collision
# (node = 0x…195cef ⇒ raw color 0xF4F4F5). NONE of NODE_A/B/ZERO exercise this branch, so before it
# was pinned the nudge path in the Vyper `NameMath.vy` was never differentially checked — and it had
# in fact drifted (returned the un-nudged 0xF4F4F5). This vector is the regression that pins the fix.
NODE_BG = (0x195CEF).to_bytes(32, "big")

# ─── GROUND TRUTH from src/NameMath.sol (Foundry-extracted, pinned verbatim) ───────────────────
EXPECTED_COLOR_OF = {
    NODE_A: bytes.fromhex("a5258b"),
    NODE_B: bytes.fromhex("f4a325"),
    NODE_ZERO: bytes.fromhex("bbb14f"),
    # NODE_BG's RAW color is 0xF4F4F5 (== BG); the I-4 nudge maps it to 0xE5E5E4 (BG ^ 0x111111).
    NODE_BG: bytes.fromhex("e5e5e4"),
}
EXPECTED_COLOR_HEX = {
    NODE_A: "#A5258B",
    NODE_B: "#F4A325",
    NODE_ZERO: "#BBB14F",
    NODE_BG: "#E5E5E4",
}
EXPECTED_RAW_SVG = {
    NODE_A: (
        '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500">'
        '<rect width="500" height="500" fill="#F4F4F5"/>'
        '<rect x="100" y="0" width="100" height="100" fill="#A5258B"/>'
        '<rect x="300" y="0" width="100" height="100" fill="#A5258B"/>'
        '<rect x="100" y="100" width="100" height="100" fill="#A5258B"/>'
        '<rect x="300" y="100" width="100" height="100" fill="#A5258B"/>'
        '<rect x="200" y="100" width="100" height="100" fill="#A5258B"/>'
        '<rect x="0" y="200" width="100" height="100" fill="#A5258B"/>'
        '<rect x="400" y="200" width="100" height="100" fill="#A5258B"/>'
        '<rect x="100" y="200" width="100" height="100" fill="#A5258B"/>'
        '<rect x="300" y="200" width="100" height="100" fill="#A5258B"/>'
        '<rect x="200" y="200" width="100" height="100" fill="#A5258B"/>'
        '<rect x="0" y="300" width="100" height="100" fill="#A5258B"/>'
        '<rect x="400" y="300" width="100" height="100" fill="#A5258B"/>'
        '<rect x="100" y="400" width="100" height="100" fill="#A5258B"/>'
        '<rect x="300" y="400" width="100" height="100" fill="#A5258B"/>'
        '<rect x="200" y="400" width="100" height="100" fill="#A5258B"/>'
        "</svg>"
    ),
    NODE_B: (
        '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500">'
        '<rect width="500" height="500" fill="#F4F4F5"/>'
        '<rect x="0" y="0" width="100" height="100" fill="#F4A325"/>'
        '<rect x="400" y="0" width="100" height="100" fill="#F4A325"/>'
        '<rect x="200" y="0" width="100" height="100" fill="#F4A325"/>'
        '<rect x="0" y="100" width="100" height="100" fill="#F4A325"/>'
        '<rect x="400" y="100" width="100" height="100" fill="#F4A325"/>'
        '<rect x="100" y="100" width="100" height="100" fill="#F4A325"/>'
        '<rect x="300" y="100" width="100" height="100" fill="#F4A325"/>'
        '<rect x="200" y="100" width="100" height="100" fill="#F4A325"/>'
        '<rect x="0" y="200" width="100" height="100" fill="#F4A325"/>'
        '<rect x="400" y="200" width="100" height="100" fill="#F4A325"/>'
        '<rect x="100" y="200" width="100" height="100" fill="#F4A325"/>'
        '<rect x="300" y="200" width="100" height="100" fill="#F4A325"/>'
        '<rect x="200" y="200" width="100" height="100" fill="#F4A325"/>'
        '<rect x="0" y="300" width="100" height="100" fill="#F4A325"/>'
        '<rect x="400" y="300" width="100" height="100" fill="#F4A325"/>'
        '<rect x="100" y="300" width="100" height="100" fill="#F4A325"/>'
        '<rect x="300" y="300" width="100" height="100" fill="#F4A325"/>'
        '<rect x="200" y="300" width="100" height="100" fill="#F4A325"/>'
        '<rect x="0" y="400" width="100" height="100" fill="#F4A325"/>'
        '<rect x="400" y="400" width="100" height="100" fill="#F4A325"/>'
        '<rect x="200" y="400" width="100" height="100" fill="#F4A325"/>'
        "</svg>"
    ),
    NODE_ZERO: (
        '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500">'
        '<rect width="500" height="500" fill="#F4F4F5"/>'
        '<rect x="100" y="0" width="100" height="100" fill="#BBB14F"/>'
        '<rect x="300" y="0" width="100" height="100" fill="#BBB14F"/>'
        '<rect x="200" y="0" width="100" height="100" fill="#BBB14F"/>'
        '<rect x="200" y="100" width="100" height="100" fill="#BBB14F"/>'
        '<rect x="0" y="200" width="100" height="100" fill="#BBB14F"/>'
        '<rect x="400" y="200" width="100" height="100" fill="#BBB14F"/>'
        '<rect x="200" y="200" width="100" height="100" fill="#BBB14F"/>'
        '<rect x="200" y="300" width="100" height="100" fill="#BBB14F"/>'
        '<rect x="100" y="400" width="100" height="100" fill="#BBB14F"/>'
        '<rect x="300" y="400" width="100" height="100" fill="#BBB14F"/>'
        "</svg>"
    ),
    # NODE_BG paints in the NUDGED brand color #E5E5E4 (never the un-nudged #F4F4F5 == BG). This is
    # the identicon-side proof that the nudge propagates from colorOf → colorHex → every painted cell.
    NODE_BG: (
        '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500">'
        '<rect width="500" height="500" fill="#F4F4F5"/>'
        '<rect x="0" y="0" width="100" height="100" fill="#E5E5E4"/>'
        '<rect x="400" y="0" width="100" height="100" fill="#E5E5E4"/>'
        '<rect x="100" y="0" width="100" height="100" fill="#E5E5E4"/>'
        '<rect x="300" y="0" width="100" height="100" fill="#E5E5E4"/>'
        '<rect x="200" y="0" width="100" height="100" fill="#E5E5E4"/>'
        '<rect x="100" y="100" width="100" height="100" fill="#E5E5E4"/>'
        '<rect x="300" y="100" width="100" height="100" fill="#E5E5E4"/>'
        '<rect x="200" y="100" width="100" height="100" fill="#E5E5E4"/>'
        '<rect x="200" y="200" width="100" height="100" fill="#E5E5E4"/>'
        '<rect x="200" y="300" width="100" height="100" fill="#E5E5E4"/>'
        '<rect x="0" y="400" width="100" height="100" fill="#E5E5E4"/>'
        '<rect x="400" y="400" width="100" height="100" fill="#E5E5E4"/>'
        '<rect x="100" y="400" width="100" height="100" fill="#E5E5E4"/>'
        '<rect x="300" y="400" width="100" height="100" fill="#E5E5E4"/>'
        '<rect x="200" y="400" width="100" height="100" fill="#E5E5E4"/>'
        "</svg>"
    ),
}
_DATA_URI = "data:image/svg+xml;utf8,"

# The 3 original vectors PLUS the background-collision node that pins the I-4 nudge branch.
ALL_NODES = [NODE_A, NODE_B, NODE_ZERO, NODE_BG]


# ─── colorOf ─────────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("node", ALL_NODES, ids=["A", "B", "ZERO", "BG"])
def test_colorOf_matches_solidity(name_math, node):
    assert bytes(name_math.colorOf(node)) == EXPECTED_COLOR_OF[node]


def test_colorOf_matches_documented_formula(name_math):
    # The documented Solidity formula, INCLUDING the I-4 nudge:
    #   c = bytes3(keccak256(abi.encode("color", node)));  return c == BG ? c ^ NUDGE : c
    # We rebuild the exact ABI-encoded (string, bytes32) preimage in Python, take the HIGH 3 bytes,
    # then apply the SAME nudge. For NODE_A/B/ZERO the nudge is a no-op (raw != BG); for NODE_BG it
    # fires (raw == 0xF4F4F5 -> 0xE5E5E4). The `ref.color_of` helper is the single source of that
    # formula and is itself pinned against the Foundry ground truth by the test below.
    for node in ALL_NODES:
        offset = (64).to_bytes(32, "big")
        length = (5).to_bytes(32, "big")
        tag = b"color".ljust(32, b"\x00")
        digest = keccak(offset + node + length + tag)
        raw = digest[:3]
        expected = raw
        if raw == bytes.fromhex("f4f4f5"):
            expected = bytes(a ^ b for a, b in zip(raw, bytes.fromhex("111111")))
        assert bytes(name_math.colorOf(node)) == expected
        # and it agrees with the shared reference oracle used by the differential fuzz
        assert bytes(name_math.colorOf(node)) == ref.color_of(node)


# ─── colorHex ────────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("node", ALL_NODES, ids=["A", "B", "ZERO", "BG"])
def test_colorHex_matches_solidity(name_math, node):
    out = name_math.colorHex(node)
    assert out == EXPECTED_COLOR_HEX[node]
    assert len(out) == 7
    assert out[0] == "#"


# ─── identiconRawSVG ─────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("node", ALL_NODES, ids=["A", "B", "ZERO", "BG"])
def test_identiconRawSVG_matches_solidity_byte_for_byte(name_math, node):
    assert name_math.identiconRawSVG(node) == EXPECTED_RAW_SVG[node]


# ─── identiconSVG (data-URI wrapper) ───────────────────────────────────────────────────────────
@pytest.mark.parametrize("node", ALL_NODES, ids=["A", "B", "ZERO", "BG"])
def test_identiconSVG_matches_solidity_byte_for_byte(name_math, node):
    assert name_math.identiconSVG(node) == _DATA_URI + EXPECTED_RAW_SVG[node]


# ─── invariants the Solidity test also checks (determinism, distinctness, symmetry) ────────────
def test_determinism(name_math):
    assert name_math.colorOf(NODE_A) == name_math.colorOf(NODE_A)
    assert name_math.identiconSVG(NODE_A) == name_math.identiconSVG(NODE_A)


def test_distinct_nodes_differ(name_math):
    assert name_math.colorOf(NODE_A) != name_math.colorOf(NODE_B)
    assert name_math.identiconSVG(NODE_A) != name_math.identiconSVG(NODE_B)


def test_to_string_four_digit_branch_is_provably_unreachable(name_math):
    # COVERAGE HONESTY: boa's coverage.py plugin reports NameMath.vy at 92% — the ONLY uncovered
    # statements are the 4-digit (num >= 1000) branch of the internal `_to_string`. That branch is
    # DEAD by construction: `_to_string` is only ever called on grid coordinates, whose maximum is
    # `_SIZE` = 500 (canvas) or `4 * _CELL` = 400 (cells) — never >= 1000, so the 4-digit path can
    # never execute through the public API. It is kept only as a totality guard for the `String[4]`
    # return envelope; deleting it to chase 100% would be removing defensive code from a leaf
    # primitive, which is the wrong trade. This test PINS the reason: every decimal token emitted in
    # any identicon SVG is one of {0,100,200,300,400,500} — all <= 3 digits — across the fuzz sample.
    import re

    allowed = {"0", "100", "200", "300", "400", "500"}
    for node in list(_fuzz_nodes()):
        svg = name_math.identiconRawSVG(node)
        # every x=".."/y=".." coordinate + width/height in the markup
        nums = re.findall(r'(?:x|y|width|height)="(\d+)"', svg)
        assert nums, "svg should contain numeric attributes"
        for n in nums:
            assert n in allowed, f"unexpected coordinate {n} (would need >3 digits)"
            assert len(n) <= 3


def test_vertically_symmetric(name_math):
    # The blockie look: col0 (x="0") mirrors col4 (x="400"); col1 (x="100") mirrors col3 (x="300").
    svg = name_math.identiconRawSVG(NODE_A)
    assert svg.count('x="0"') == svg.count('x="400"')
    assert svg.count('x="100"') == svg.count('x="300"')


# ─── reference oracle is itself faithful to the pinned Solidity ground truth ────────────────────
def test_reference_matches_pinned_solidity():
    # The differential fuzz below trusts `namemath_ref` as the Solidity oracle. Keep it honest: the
    # reference MUST reproduce the Foundry-extracted ground truth for the pinned vectors exactly. If
    # the reference itself drifts, this fails — so it can never silently mask a real Vyper divergence.
    for node in ALL_NODES:
        assert ref.color_of(node) == EXPECTED_COLOR_OF[node]
        assert ref.color_hex(node) == EXPECTED_COLOR_HEX[node]
        assert ref.identicon_raw_svg(node) == EXPECTED_RAW_SVG[node]
        assert ref.identicon_svg(node) == _DATA_URI + EXPECTED_RAW_SVG[node]


# ─── DIFFERENTIAL FUZZ: Vyper output == Solidity-formula reference for many random nodes ─────────
# This is the completeness step: every PUBLIC function of NameMath.vy (colorOf, colorHex,
# identiconRawSVG, identiconSVG) is checked byte-for-byte against the faithful Solidity reference
# over a large deterministic-random sample of the bytes32 input space (seeded so failures are
# reproducible). The 3 pinned vectors only cover 3 points; this proves the twins agree everywhere,
# including edge inputs (all-zero, all-ones, low bytes only, high bytes only).
_FUZZ_SEED = 0xACCE5501
_FUZZ_N = 512

_EDGE_NODES = [
    b"\x00" * 32,  # zero
    b"\xff" * 32,  # all ones
    (1).to_bytes(32, "big"),  # smallest nonzero
    (2**256 - 1).to_bytes(32, "big"),  # max
    NODE_BG,  # the background-collision node (nudge branch)
    keccak(text="a.eth"),
    keccak(text="éé.eth"),  # multibyte label
]


def _fuzz_nodes():
    rng = random.Random(_FUZZ_SEED)
    yield from _EDGE_NODES
    for _ in range(_FUZZ_N):
        yield rng.getrandbits(256).to_bytes(32, "big")


@pytest.mark.parametrize("node", list(_fuzz_nodes()))
def test_differential_colorOf(name_math, node):
    assert bytes(name_math.colorOf(node)) == ref.color_of(node)


@pytest.mark.parametrize("node", list(_fuzz_nodes()))
def test_differential_colorHex(name_math, node):
    assert name_math.colorHex(node) == ref.color_hex(node)


@pytest.mark.parametrize("node", list(_fuzz_nodes()))
def test_differential_identiconRawSVG(name_math, node):
    assert name_math.identiconRawSVG(node) == ref.identicon_raw_svg(node)


@pytest.mark.parametrize("node", list(_fuzz_nodes()))
def test_differential_identiconSVG(name_math, node):
    assert name_math.identiconSVG(node) == ref.identicon_svg(node)


def test_colorOf_never_equals_background(name_math):
    # The whole point of the I-4 nudge: colorOf must NEVER return the neutral background for ANY
    # node (else the avatar paints invisible). Assert it across the fuzz sample + the known collision.
    bg = bytes.fromhex("f4f4f5")
    for node in list(_fuzz_nodes()):
        assert bytes(name_math.colorOf(node)) != bg


# ─── cancun pin (recompile with an explicit cancun target and assert it is accepted) ───────────
def test_compiles_targeting_cancun():
    # Resolve relative to THIS file, not the CWD, so the suite passes from any
    # working dir (pytest run from repo root or from vyper/, and in CI).
    import os

    _src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "NameMath.vy")
    with open(_src) as f:
        source = f.read()
    # The source pragma already pins cancun; passing evm_version explicitly proves it compiles for
    # cancun (vyper 0.4.x otherwise defaults to Prague, which this repo does NOT target).
    out = compile_code(
        source, output_formats=["bytecode"], settings=Settings(evm_version="cancun")
    )
    assert out["bytecode"].startswith("0x")
    assert len(out["bytecode"]) > 2
