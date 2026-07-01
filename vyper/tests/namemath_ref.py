"""Pure-Python reference oracle for the CANONICAL Solidity `src/NameMath.sol`.

This is a byte-for-byte reimplementation of the Solidity library's algorithm — INCLUDING the I-4
legibility nudge (`colorOf` returns `color ^ 0x111111` when the raw hash equals the neutral
background `0xF4F4F5`). Its ONLY job is to be the differential oracle for the fuzz in
`test_conformance.py`: for any `node`, the Vyper contract's output must equal this reference's,
so the conformance is proven across a large random input space rather than only the 3 pinned
vectors.

The reference is itself validated against the pinned, Foundry-extracted Solidity ground truth
(NODE_A/NODE_B/NODE_ZERO in `test_conformance.py`) by `test_reference_matches_pinned_solidity`, so
a bug in THIS file cannot silently mask a Vyper divergence — the pinned vectors keep it honest.

Everything here is derived from the documented Solidity algorithm:
  colorOf(node)        = let c = bytes3(keccak(abi.encode("color", node)));  c == BG ? c ^ NUDGE : c
  colorHex(node)       = "#" + uppercase-hex(colorOf(node))
  identiconRawSVG(node)= 5x5 vertically-symmetric grid seeded by keccak(abi.encode("identicon",node))
  identiconSVG(node)   = "data:image/svg+xml;utf8," + identiconRawSVG(node)
"""

from eth_utils import keccak

_BG = bytes.fromhex("f4f4f5")
_NUDGE = bytes.fromhex("111111")
_DATA_URI = "data:image/svg+xml;utf8,"


def _abi_encode_string_bytes32(tag: str, node: bytes) -> bytes:
    """Reproduce Solidity `abi.encode(<string>, bytes32)` for a (string, bytes32) tuple:
    word0 = offset to string (always 0x40), word1 = node inline, word2 = string byte-length,
    word3 = the tag left-aligned + zero-padded to 32 bytes.
    """
    tag_bytes = tag.encode()
    return (
        (64).to_bytes(32, "big")
        + node
        + (len(tag_bytes)).to_bytes(32, "big")
        + tag_bytes.ljust(32, b"\x00")
    )


def color_of(node: bytes) -> bytes:
    """The 24-bit brand color (bytes3), with the I-4 nudge applied — mirrors Solidity `colorOf`."""
    c = keccak(_abi_encode_string_bytes32("color", node))[:3]
    if c == _BG:
        return bytes(a ^ b for a, b in zip(c, _NUDGE))
    return c


def color_hex(node: bytes) -> str:
    """`#RRGGBB` uppercase string for the brand color — mirrors Solidity `colorHex`."""
    return "#" + color_of(node).hex().upper()


def _cell(row: int, col: int, fg: str) -> str:
    return (
        f'<rect x="{col * 100}" y="{row * 100}" '
        f'width="100" height="100" fill="{fg}"/>'
    )


def identicon_raw_svg(node: bytes) -> str:
    """The raw `<svg>...</svg>` identicon markup — mirrors Solidity `identiconRawSVG`, including the
    exact per-row emit order (r,0),(r,4),(r,1),(r,3),(r,2)."""
    seed = int.from_bytes(keccak(_abi_encode_string_bytes32("identicon", node)), "big")
    fg = color_hex(node)
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" '
        'viewBox="0 0 500 500"><rect width="500" height="500" fill="#F4F4F5"/>'
    )
    for r in range(5):
        for c in range(3):
            if (seed >> (r * 3 + c)) & 1 == 1:
                svg += _cell(r, c, fg)
                if c < 2:
                    svg += _cell(r, 4 - c, fg)
    return svg + "</svg>"


def identicon_svg(node: bytes) -> str:
    """The data-URI-wrapped identicon — mirrors Solidity `identiconSVG`."""
    return _DATA_URI + identicon_raw_svg(node)
