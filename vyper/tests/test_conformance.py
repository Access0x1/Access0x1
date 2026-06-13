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

import pytest
from eth_utils import keccak
from vyper import compile_code
from vyper.compiler.settings import Settings

# ─── vectors ─────────────────────────────────────────────────────────────────────────────────
NODE_A = keccak(text="merchant.access0x1.eth")
NODE_B = keccak(text="alice.merchant.access0x1.eth")
NODE_ZERO = b"\x00" * 32

# ─── GROUND TRUTH from src/NameMath.sol (Foundry-extracted, pinned verbatim) ───────────────────
EXPECTED_COLOR_OF = {
    NODE_A: bytes.fromhex("a5258b"),
    NODE_B: bytes.fromhex("f4a325"),
    NODE_ZERO: bytes.fromhex("bbb14f"),
}
EXPECTED_COLOR_HEX = {
    NODE_A: "#A5258B",
    NODE_B: "#F4A325",
    NODE_ZERO: "#BBB14F",
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
}
_DATA_URI = "data:image/svg+xml;utf8,"

ALL_NODES = [NODE_A, NODE_B, NODE_ZERO]


# ─── colorOf ─────────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("node", ALL_NODES, ids=["A", "B", "ZERO"])
def test_colorOf_matches_solidity(name_math, node):
    assert bytes(name_math.colorOf(node)) == EXPECTED_COLOR_OF[node]


def test_colorOf_matches_documented_formula(name_math):
    # The exact formula the Solidity test asserts: bytes3(keccak256(abi.encode("color", node))).
    # We rebuild the same ABI-encoded (string, bytes32) preimage in Python and take the HIGH 3 bytes.
    for node in ALL_NODES:
        offset = (64).to_bytes(32, "big")
        length = (5).to_bytes(32, "big")
        tag = b"color".ljust(32, b"\x00")
        digest = keccak(offset + node + length + tag)
        assert bytes(name_math.colorOf(node)) == digest[:3]


# ─── colorHex ────────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("node", ALL_NODES, ids=["A", "B", "ZERO"])
def test_colorHex_matches_solidity(name_math, node):
    out = name_math.colorHex(node)
    assert out == EXPECTED_COLOR_HEX[node]
    assert len(out) == 7
    assert out[0] == "#"


# ─── identiconRawSVG ─────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("node", ALL_NODES, ids=["A", "B", "ZERO"])
def test_identiconRawSVG_matches_solidity_byte_for_byte(name_math, node):
    assert name_math.identiconRawSVG(node) == EXPECTED_RAW_SVG[node]


# ─── identiconSVG (data-URI wrapper) ───────────────────────────────────────────────────────────
@pytest.mark.parametrize("node", ALL_NODES, ids=["A", "B", "ZERO"])
def test_identiconSVG_matches_solidity_byte_for_byte(name_math, node):
    assert name_math.identiconSVG(node) == _DATA_URI + EXPECTED_RAW_SVG[node]


# ─── invariants the Solidity test also checks (determinism, distinctness, symmetry) ────────────
def test_determinism(name_math):
    assert name_math.colorOf(NODE_A) == name_math.colorOf(NODE_A)
    assert name_math.identiconSVG(NODE_A) == name_math.identiconSVG(NODE_A)


def test_distinct_nodes_differ(name_math):
    assert name_math.colorOf(NODE_A) != name_math.colorOf(NODE_B)
    assert name_math.identiconSVG(NODE_A) != name_math.identiconSVG(NODE_B)


def test_vertically_symmetric(name_math):
    # The blockie look: col0 (x="0") mirrors col4 (x="400"); col1 (x="100") mirrors col3 (x="300").
    svg = name_math.identiconRawSVG(NODE_A)
    assert svg.count('x="0"') == svg.count('x="400"')
    assert svg.count('x="100"') == svg.count('x="300"')


# ─── cancun pin (recompile with an explicit cancun target and assert it is accepted) ───────────
def test_compiles_targeting_cancun():
    with open("src/NameMath.vy") as f:
        source = f.read()
    # The source pragma already pins cancun; passing evm_version explicitly proves it compiles for
    # cancun (vyper 0.4.x otherwise defaults to Prague, which this repo does NOT target).
    out = compile_code(
        source, output_formats=["bytecode"], settings=Settings(evm_version="cancun")
    )
    assert out["bytecode"].startswith("0x")
    assert len(out["bytecode"]) > 2
