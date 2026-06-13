# pragma version ~=0.4.0
# pragma evm-version cancun
# @license MIT
"""
@title NameMath (Vyper conformance demonstrator)
@author Access0x1
@notice ISOLATED, ADDITIVE Vyper port of `src/NameMath.sol`. It reproduces the SAME ENS
        "name -> math" brand layer byte-for-byte: from an ENS namehash (`node`) derive a stable
        brand color AND a unique 5x5 identicon, ON-CHAIN, deterministically, with NO storage and
        NO oracle. Just keccak.

        This is NOT a production replacement. The Solidity `NameMath` library remains canonical in
        the router. This Vyper twin exists ONLY to PROVE the algorithm is reproducible in an
        independent compiler/language and that its output is identical to the Solidity version
        (see `vyper/tests/test_conformance.py`).

@dev    Why Vyper is sound for THIS specifically: the functions are PURE math over a single
        bytes32 input. There is no money, no storage, no external call, no access control -- so the
        blast radius of any compiler difference is nil: a divergence shows up immediately as a
        failed byte-for-byte conformance assertion, never as lost funds.

        ALGORITHM (mirrored EXACTLY from NameMath.sol):

        colorOf(node):
            keccak256(abi.encode("color", node)) then take the HIGH 3 bytes (Solidity `bytes3(...)`
            is the most-significant 3 bytes of the 32-byte hash).
            `abi.encode("color", node)` is the ABI encoding of a (string, bytes32) tuple:
              word0: 0x40                              (offset to the string = 64)
              word1: node                              (the bytes32, inline)
              word2: 0x05                              (string byte-length = 5)
              word3: "color" left-aligned, zero-padded
            We build that 128-byte preimage explicitly with `concat` so the keccak preimage is
            identical to Solidity's, then slice the leading 3 bytes.

        identiconSVG(node):
            seed = keccak256(abi.encode("identicon", node))   (same tuple-encode rule, 9-char tag)
            5x5 grid, vertically symmetric. Columns 0,1,2 are seed-driven; columns 3,4 mirror 1,0.
            on(r,c) = (uint256(seed) >> (r*3 + c)) & 1 == 1.
            background = #F4F4F5; foreground = colorOf(node). Each cell is a 100x100 block in a
            0 0 500 500 viewBox.

            EMIT ORDER (must match Solidity byte-for-byte): per row r, Solidity loops c = 0,1,2 and
            for each "on" half-col emits cell(r,c) then -- if c < 2 -- its mirror cell(r, 4-c). So
            the per-row emission order is (r,0),(r,4),(r,1),(r,3),(r,2), skipping "off" cells. We
            reproduce that order exactly below.
"""

# ─── constants (mirror NameMath.sol) ───────────────────────────────────────────────────────────
# Neutral identicon background (zinc-100). Stored as the 6-hex-char body (no leading '#').
_BG_HEX: constant(String[6]) = "F4F4F5"

# Grid is 5 cells per side; each cell is 100 units in a 500x500 viewBox.
_N: constant(uint256) = 5
_CELL: constant(uint256) = 100
_SIZE: constant(uint256) = 500  # _N * _CELL

# ABI head word for `abi.encode(<string tag>, bytes32)`: the string offset is always 0x40.
_ABI_OFFSET_40: constant(bytes32) = 0x0000000000000000000000000000000000000000000000000000000000000040

# `abi.encode("color", node)` word2 (length 5) and word3 ("color" left-aligned, zero-padded).
_COLOR_LEN: constant(bytes32) = 0x0000000000000000000000000000000000000000000000000000000000000005
_COLOR_TAG: constant(bytes32) = 0x636f6c6f72000000000000000000000000000000000000000000000000000000

# `abi.encode("identicon", node)` word2 (length 9) and word3 ("identicon" left-aligned, padded).
_IDENTICON_LEN: constant(bytes32) = 0x0000000000000000000000000000000000000000000000000000000000000009
_IDENTICON_TAG: constant(bytes32) = 0x6964656e7469636f6e0000000000000000000000000000000000000000000000

# Single-character decimal digits, sliced by value in `_to_string`.
_DIGITS: constant(Bytes[10]) = b"0123456789"
_HEXCHARS: constant(Bytes[16]) = b"0123456789ABCDEF"


@external
@pure
def colorOf(node: bytes32) -> bytes3:
    """
    @notice The deterministic 24-bit brand color (RRGGBB) for an ENS name.
    @param node The ENS namehash.
    @return The brand color as the HIGH 3 bytes of keccak256(abi.encode("color", node)).
    """
    return self._color_of(node)


@external
@pure
def colorHex(node: bytes32) -> String[7]:
    """
    @notice The brand color rendered as a 7-char `#RRGGBB` string (CSS / SVG ready).
    @param node The ENS namehash.
    @return A `#RRGGBB` string, e.g. `#1A2B3C`.
    """
    return self._hex_color(self._color_of(node))


@external
@pure
def identiconSVG(node: bytes32) -> String[1865]:
    """
    @notice The deterministic identicon as a `data:image/svg+xml` URI string.
    @param node The ENS namehash.
    @return A `data:image/svg+xml;utf8,<svg ...>...</svg>` string.
    """
    return concat("data:image/svg+xml;utf8,", self._identicon_raw_svg(node))


@external
@pure
def identiconRawSVG(node: bytes32) -> String[1841]:
    """
    @notice The raw `<svg>...</svg>` markup for the identicon (no data-URI prefix).
    @param node The ENS namehash.
    @return The `<svg ...>...</svg>` markup string.
    """
    return self._identicon_raw_svg(node)


# ─── internal helpers ─────────────────────────────────────────────────────────────────────────

@internal
@pure
def _color_of(node: bytes32) -> bytes3:
    # Build the EXACT Solidity `abi.encode("color", node)` 128-byte preimage, hash it, take the
    # leading (high) 3 bytes -- matching Solidity's `bytes3(keccak256(...))`.
    h: bytes32 = keccak256(concat(_ABI_OFFSET_40, node, _COLOR_LEN, _COLOR_TAG))
    return convert(slice(h, 0, 3), bytes3)


@internal
@pure
def _identicon_seed(node: bytes32) -> uint256:
    # Same tuple-encode rule as `_color_of`, with the "identicon" domain tag.
    h: bytes32 = keccak256(concat(_ABI_OFFSET_40, node, _IDENTICON_LEN, _IDENTICON_TAG))
    return convert(h, uint256)


@internal
@pure
def _identicon_raw_svg(node: bytes32) -> String[1841]:
    seed: uint256 = self._identicon_seed(node)
    fg: String[7] = self._hex_color(self._color_of(node))

    # Opening tag + full-canvas background rect. Mirrors NameMath.sol's `string.concat`.
    head: String[160] = concat(
        '<svg xmlns="http://www.w3.org/2000/svg" width="',
        self._to_string(_SIZE),
        '" height="',
        self._to_string(_SIZE),
        '" viewBox="0 0 ',
        self._to_string(_SIZE),
        " ",
        self._to_string(_SIZE),
        '"><rect width="',
        self._to_string(_SIZE),
        '" height="',
        self._to_string(_SIZE),
        '" fill="#',
        _BG_HEX,
        '"/>',
    )

    # Build each row's painted cells in the EXACT Solidity emit order: (r,0),(r,4),(r,1),(r,3),(r,2).
    # `_row` returns the row's rects (each "off" cell contributes ""), so the per-row string is at
    # most 5 * 56 = 280 chars; 5 rows -> at most 1400, but a 500x500 grid never paints all 25 at the
    # max 3-digit width, so the 1280 envelope on the full SVG is comfortable. The body is assembled
    # with a SINGLE concat per row + one final concat so Vyper's static bound is computed once.
    body: String[1675] = concat(
        self._row(seed, 0, fg),
        self._row(seed, 1, fg),
        self._row(seed, 2, fg),
        self._row(seed, 3, fg),
        self._row(seed, 4, fg),
    )

    return concat(head, body, "</svg>")


@internal
@pure
def _row(seed: uint256, r: uint256, fg: String[7]) -> String[335]:
    # Emit the painted cells of row r in Solidity's exact order: (r,0),(r,4),(r,1),(r,3),(r,2).
    # Half-col source bits: c0 -> bit r*3+0, c1 -> bit r*3+1, c2 -> bit r*3+2. Columns 4 and 3
    # mirror columns 0 and 1 (same source bit). A single concat keeps the static bound fixed.
    return concat(
        self._cell_if(seed, r, 0, 0, fg),  # (r,0) from bit r*3+0
        self._cell_if(seed, r, 4, 0, fg),  # (r,4) mirrors col0 -> bit r*3+0
        self._cell_if(seed, r, 1, 1, fg),  # (r,1) from bit r*3+1
        self._cell_if(seed, r, 3, 1, fg),  # (r,3) mirrors col1 -> bit r*3+1
        self._cell_if(seed, r, 2, 2, fg),  # (r,2) from bit r*3+2 (center, no mirror)
    )


@internal
@pure
def _cell_if(seed: uint256, row: uint256, col: uint256, src_c: uint256, fg: String[7]) -> String[67]:
    # Paint (row, col) iff the seed bit at index row*3 + src_c is 1; otherwise contribute nothing.
    if (seed >> (row * 3 + src_c)) & 1 == 1:
        return self._cell(row, col, fg)
    return ""


@internal
@pure
def _cell(row: uint256, col: uint256, fill: String[7]) -> String[67]:
    # One painted `<rect>` at grid position (row, col) in the brand color.
    return concat(
        '<rect x="',
        self._to_string(col * _CELL),
        '" y="',
        self._to_string(row * _CELL),
        '" width="',
        self._to_string(_CELL),
        '" height="',
        self._to_string(_CELL),
        '" fill="',
        fill,
        '"/>',
    )


@internal
@pure
def _hex_color(color: bytes3) -> String[7]:
    # `bytes3` -> `#RRGGBB`. Fixed 7-char output. The 24-bit color is the high 3 bytes; read each
    # byte's nibbles and look them up in _HEXCHARS. Single concat keeps Vyper's bound exact.
    byte_mask: uint256 = 255
    nibble: uint256 = 15
    v: uint256 = convert(color, uint256)  # bytes3 right-aligns to 0x..RRGGBB in the low 24 bits
    r: uint256 = (v >> 16) & byte_mask
    g: uint256 = (v >> 8) & byte_mask
    b: uint256 = v & byte_mask
    out: Bytes[7] = concat(
        b"#",
        slice(_HEXCHARS, r >> 4, 1),
        slice(_HEXCHARS, r & nibble, 1),
        slice(_HEXCHARS, g >> 4, 1),
        slice(_HEXCHARS, g & nibble, 1),
        slice(_HEXCHARS, b >> 4, 1),
        slice(_HEXCHARS, b & nibble, 1),
    )
    return convert(out, String[7])


@internal
@pure
def _to_string(num: uint256) -> String[4]:
    # Minimal uint -> decimal string. Values here are bounded 0..500 (max 3 digits). Mirrors
    # NameMath.sol._toString. Built with one bounded concat per branch (no loop accumulation, which
    # Vyper's static bound analysis rejects).
    if num == 0:
        return "0"
    if num < 10:
        return convert(slice(_DIGITS, num, 1), String[4])
    if num < 100:
        return convert(
            concat(slice(_DIGITS, num // 10, 1), slice(_DIGITS, num % 10, 1)), String[4]
        )
    if num < 1000:
        return convert(
            concat(
                slice(_DIGITS, num // 100, 1),
                slice(_DIGITS, (num // 10) % 10, 1),
                slice(_DIGITS, num % 10, 1),
            ),
            String[4],
        )
    # 1000..9999 (not reached by NameMath's 0..500 inputs, but kept total for the 4-char envelope).
    return convert(
        concat(
            slice(_DIGITS, num // 1000, 1),
            slice(_DIGITS, (num // 100) % 10, 1),
            slice(_DIGITS, (num // 10) % 10, 1),
            slice(_DIGITS, num % 10, 1),
        ),
        String[4],
    )
