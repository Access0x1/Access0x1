"""Conformance + behaviour: Vyper NameDie.vy.

NameDie is the ENS-name -> DIE twin of NameMath: the SAME keccak-derived brand color (so a name's die
and its identicon are always the same color, INCLUDING NameMath's background-collision nudge), with
RARITY encoded as die sides by NAME LENGTH -- 3 sides (legendary, <=3 chars), 6 (rare, 4 chars),
9 (standard, 5+). Its color path must conform byte-for-byte to NameMath's (the ground truth pinned in
`test_conformance.py`, extracted from the canonical Solidity `src/NameMath.sol`); the die SVG is
checked against a constructed expected (head + tier polygon + brand color + zinc stroke). Because the
color is the SAME derivation, the die and identicon for any name can never disagree.
"""

import random

import pytest

import namemath_ref as ref

# Reuse the canonical Solidity-extracted ground truth + the test vectors from the NameMath suite.
from test_conformance import (
    ALL_NODES,
    EXPECTED_COLOR_HEX,
    EXPECTED_COLOR_OF,
    NODE_A,
    NODE_BG,
)

# ─── die geometry (mirrors NameDie.vy's baked constants) ───────────────────────────────────────
_HEAD = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500">'
    '<rect width="500" height="500" fill="#F4F4F5"/>'
)
_STROKE = "#18181B"
_TRI = "250,50 423,350 77,350"
_HEX = "250,50 423,150 423,350 250,450 77,350 77,150"
_NON = "250,50 379,97 447,215 423,350 318,438 182,438 77,350 53,215 121,97"
_POINTS = {3: _TRI, 6: _HEX, 9: _NON}
_DATA_URI = "data:image/svg+xml;utf8,"


def _die_svg(points: str, color_hex: str) -> str:
    """The exact bytes NameDie._die_raw_svg must emit for a tier polygon + brand color."""
    return (
        _HEAD
        + '<polygon points="'
        + points
        + '" fill="'
        + color_hex
        + '" stroke="'
        + _STROKE
        + '" stroke-width="8" stroke-linejoin="round"/></svg>'
    )


# ─── COLOR conforms to NameMath byte-for-byte (the headline guarantee) ─────────────────────────
@pytest.mark.parametrize("node", ALL_NODES, ids=["A", "B", "ZERO", "BG"])
def test_colorOf_conforms_to_namemath(name_die, node):
    assert bytes(name_die.colorOf(node)) == EXPECTED_COLOR_OF[node]


@pytest.mark.parametrize("node", ALL_NODES, ids=["A", "B", "ZERO", "BG"])
def test_colorHex_conforms_to_namemath(name_die, node):
    out = name_die.colorHex(node)
    assert out == EXPECTED_COLOR_HEX[node]
    assert len(out) == 7 and out[0] == "#"


# ─── SIDES / TIER / TIER-NAME by ENS name length (the inverse-rarity curve) ────────────────────
@pytest.mark.parametrize(
    "char_len,sides,tier,name",
    [
        (3, 3, 0, "LEGENDARY"),  # rarest registrable (3-char .eth)
        (4, 6, 1, "RARE"),
        (5, 9, 2, "STANDARD"),
        (1, 3, 0, "LEGENDARY"),  # <=3 folds to rarest (1/2-char unregistrable in practice)
        (32, 9, 2, "STANDARD"),
    ],
)
def test_sides_tier_name(name_die, char_len, sides, tier, name):
    assert name_die.sidesOf(char_len) == sides
    assert name_die.tierOf(char_len) == tier
    assert name_die.tierName(char_len) == name


# ─── DIE SVG byte-for-byte (head + tier polygon + brand color + stroke) ────────────────────────
@pytest.mark.parametrize("node", ALL_NODES, ids=["A", "B", "ZERO", "BG"])
@pytest.mark.parametrize("char_len", [3, 4, 5])
def test_dieRawSVG_byte_for_byte(name_die, node, char_len):
    sides = name_die.sidesOf(char_len)
    assert name_die.dieRawSVG(node, char_len) == _die_svg(_POINTS[sides], EXPECTED_COLOR_HEX[node])


@pytest.mark.parametrize("node", ALL_NODES, ids=["A", "B", "ZERO", "BG"])
def test_dieSVG_data_uri_wrapper(name_die, node):
    assert name_die.dieSVG(node, 4) == _DATA_URI + _die_svg(_HEX, EXPECTED_COLOR_HEX[node])


# ─── invariants: determinism + the rarity tiers actually render differently ────────────────────
def test_determinism(name_die):
    assert name_die.dieRawSVG(NODE_A, 3) == name_die.dieRawSVG(NODE_A, 3)


def test_tiers_render_distinct_dice(name_die):
    legendary = name_die.dieRawSVG(NODE_A, 3)
    rare = name_die.dieRawSVG(NODE_A, 4)
    standard = name_die.dieRawSVG(NODE_A, 5)
    assert legendary != rare != standard != legendary


# ─── DIFFERENTIAL FUZZ: NameDie color path == NameMath reference over the random input space ─────
# NameDie re-derives the brand color itself (it does not import NameMath). The headline guarantee is
# that this independent re-derivation is byte-for-byte identical to NameMath's — INCLUDING the I-4
# nudge — so a name's die and identicon can never disagree. We prove it against the same faithful
# Solidity reference the NameMath fuzz uses, over a large deterministic-random node sample.
_FUZZ_SEED = 0xD1E5EED
_FUZZ_N = 256

_EDGE_NODES = [
    b"\x00" * 32,
    b"\xff" * 32,
    NODE_BG,  # background-collision node: NameDie must nudge exactly like NameMath (0xE5E5E4)
    NODE_A,
]


def _fuzz_nodes():
    rng = random.Random(_FUZZ_SEED)
    yield from _EDGE_NODES
    for _ in range(_FUZZ_N):
        yield rng.getrandbits(256).to_bytes(32, "big")


@pytest.mark.parametrize("node", list(_fuzz_nodes()))
def test_namedie_colorOf_conforms_to_reference(name_die, node):
    assert bytes(name_die.colorOf(node)) == ref.color_of(node)


@pytest.mark.parametrize("node", list(_fuzz_nodes()))
def test_namedie_colorHex_conforms_to_reference(name_die, node):
    assert name_die.colorHex(node) == ref.color_hex(node)


def test_namedie_color_never_equals_background(name_die):
    # Same I-4 guarantee as NameMath: the die fill can never be the neutral background for any node.
    bg = bytes.fromhex("f4f4f5")
    for node in list(_fuzz_nodes()):
        assert bytes(name_die.colorOf(node)) != bg


# ─── DIE SVG differential over color x tier: die fill == NameMath color, geometry == baked tier ──
@pytest.mark.parametrize("node", list(_fuzz_nodes())[:32])
@pytest.mark.parametrize("char_len", [3, 4, 5, 1, 2, 6, 32, 0])
def test_namedie_dieRawSVG_differential(name_die, node, char_len):
    sides = name_die.sidesOf(char_len)
    assert name_die.dieRawSVG(node, char_len) == _die_svg(_POINTS[sides], ref.color_hex(node))


# ─── sides/tier/tierName totality across a wide char_len range (boundary enumeration) ────────────
@pytest.mark.parametrize("char_len", list(range(0, 12)) + [63, 255, 2**256 - 1])
def test_namedie_tier_boundaries_total(name_die, char_len):
    sides = name_die.sidesOf(char_len)
    tier = name_die.tierOf(char_len)
    name = name_die.tierName(char_len)
    # Exhaustive expected mapping mirrors the documented inverse-rarity curve.
    if char_len <= 3:
        assert (sides, tier, name) == (3, 0, "LEGENDARY")
    elif char_len == 4:
        assert (sides, tier, name) == (6, 1, "RARE")
    else:
        assert (sides, tier, name) == (9, 2, "STANDARD")
