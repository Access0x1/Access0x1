# pragma version ~=0.4.0
# pragma evm-version cancun
# @license MIT
"""
@title NameDie (Vyper) -- ENS name -> premium die, tiered by name LENGTH
@author Rensley R. @vyperpilleddev
@notice ISOLATED, ADDITIVE companion to `NameMath`. Where `NameMath` turns an ENS namehash into a
        deterministic brand color + identicon, `NameDie` turns an ENS name into a DIE whose number
        of visible sides encodes RARITY by NAME LENGTH:

            3 characters  -> 3-sided die  (triangle)  = LEGENDARY  (rarest)
            4 characters  -> 6-sided die  (hexagon)   = RARE
            5+ characters -> 9-sided die  (nonagon)   = STANDARD   (common)

        Fewer sides == shorter name == rarer == more premium. This is the EXACT same inverse-rarity
        curve ENS itself uses to price names (see "ENS FINDINGS" below). The die is filled with the
        SAME keccak-derived brand color as NameMath, so a name's die and its identicon always match.

        Like NameMath, this is a PURE, NO-STORAGE, NO-ORACLE math+SVG layer. It is safe in Vyper for
        the same reason: pure functions over fixed inputs, no money, no external calls, no access
        control -> any compiler divergence surfaces as a failed conformance assert, never lost funds.

@dev ────────────────────────────────────────────────────────────────────────────────────────────
     ⚠️  THE CRITICAL CONSTRAINT: namehash does NOT carry length.
     ────────────────────────────────────────────────────────────────────────────────────────────
     An ENS `node` (bytes32 namehash, EIP-137) is a recursive keccak:
         namehash("") = 0x000...0
         namehash(label.parent) = keccak256(namehash(parent) ++ keccak256(label))
     It is a ONE-WAY hash. You CANNOT recover the plaintext, and you CANNOT recover the character
     count from it. Therefore the die tier CANNOT be derived from `node` alone -- the caller MUST
     pass the normalized character length `char_len` explicitly. `node` still drives the COLOR (art);
     `char_len` drives the SIDES (rarity). The two inputs are orthogonal by necessity, not choice.

@dev ────────────────────────────────────────────────────────────────────────────────────────────
     ENS FINDINGS  (written down per request -- including things this file does NOT use)
     ────────────────────────────────────────────────────────────────────────────────────────────
     1. LENGTH-BASED PRICING (the precedent this whole design mirrors). ENS .eth registrar docs:
            • 3-character name : ~$640 / year
            • 4-character name : ~$160 / year
            • 5+ character name: ~$5  / year
        Rationale in ENS's own words: "there are an exponentially less amount of names the shorter
        they become." (docs.ens.domains/registry/eth) -> shorter = scarcer = premium. Our 3/6/9
        side tiers ARE these three price bands.

     2. MINIMUM LENGTH IS 3. "1 & 2 character .eth names cannot be registered."
        (support.ens.domains ENS Pricing). So a real .eth label is ALWAYS >= 3 chars. We still treat
        char_len <= 3 as the legendary (3-side) tier defensively, but in practice the floor is 3.
        => There is no "1 or 2 letter" tier in reality; the rarest registrable name is exactly 3.

     3. LENGTH IS COUNTED IN NORMALIZED UNICODE, NOT BYTES. ENS names are normalized per ENSIP-15
        (UTS-46 + custom rules, ref impl @adraffy/ens-normalize). "Length" = count of normalized
        characters (code points / grapheme-ish), so:
            • an emoji can be ONE visible character but MANY UTF-8 bytes,
            • `.length` on a UTF-8 byte string would OVER-count multibyte chars.
        => `char_len` MUST be the ENSIP-15 normalized character count, computed OFF-CHAIN (on-chain
        UTF-8 grapheme segmentation is impractical and expensive). Garbage-in / garbage-out: if the
        caller passes a byte length, the tier is wrong for non-ASCII names. Documented, not enforced
        (this layer is pure math; the router validates inputs).

     4. ENS ALREADY USES CHAINLINK. The ENS registrar prices rent in USD but charges in ETH, and
        converts using a Chainlink ETH/USD price feed on-chain at registration time. (Mirrors
        Access0x1's own router, which USD-prices via Chainlink Data Feeds.) Noted for symmetry;
        NOT used here -- this file stays oracle-free.

     5. TEMPORARY PREMIUM (unused, noted for a possible future "decay" mechanic). After a name
        expires + a 90-day grace period, it enters a 21-day Dutch auction starting near ~$100M and
        decaying exponentially to $0. A future NameDie could tint or "age" a die by remaining grace,
        but that needs live state and an oracle -> belongs in the router, not this pure twin.

@dev ────────────────────────────────────────────────────────────────────────────────────────────
     RANDOMNESS ("where the sides land") -- intentionally NOT in this file.
     ────────────────────────────────────────────────────────────────────────────────────────────
     The hero idea -- the die is ROLLED and which faces land facing you is random + verifiable -- is
     a CHAINLINK VRF concern. VRF requires an external call and a callback, which are IMPURE and
     would break this conformance twin's pure/no-oracle guarantee. So orientation/roll lives in the
     SOLIDITY ROUTER (the VRF consumer): VRF returns a word, the router picks an orientation index,
     and (optionally) passes an `orientation` selector into a future `dieSVGOriented(...)`. This file
     deliberately renders the die in its CANONICAL (point-up) orientation only, so it stays pure and
     byte-for-byte reproducible. The VRF wiring is a router commit, not a NameDie commit.

     SVG GEOMETRY: regular N-gon, center (250,250), radius 200, in a 500x500 viewBox, vertex-up.
     Vertices are PRE-COMPUTED integer points (no on-chain trig / no floats). Fill = brand color;
     stroke = zinc-900 for a crisp premium edge. Background = zinc-100 (matches NameMath identicon).
"""

# ─── shared constants (kept identical to NameMath so color output matches byte-for-byte) ─────────
_ABI_OFFSET_40: constant(bytes32) = 0x0000000000000000000000000000000000000000000000000000000000000040
_COLOR_LEN: constant(bytes32) = 0x0000000000000000000000000000000000000000000000000000000000000005
_COLOR_TAG: constant(bytes32) = 0x636f6c6f72000000000000000000000000000000000000000000000000000000
_HEXCHARS: constant(Bytes[16]) = b"0123456789ABCDEF"

# Opening tag + full-canvas zinc-100 background. Fixed (size is constant 500), so baked as one
# literal -- no _toString needed for the die.
_HEAD: constant(String[140]) = '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500"><rect width="500" height="500" fill="#F4F4F5"/>'

# Crisp premium edge (zinc-900).
_STROKE: constant(String[7]) = "#18181B"

# Legibility/conformance nudge (mirrors NameMath.colorOf): when the raw brand color equals the
# zinc-100 background, NameMath XORs a fixed nudge so the mark never vanishes into the backdrop.
# Precomputed (_BG ^ 0x111111) so the die color stays byte-for-byte identical to the identicon.
_BG: constant(bytes3) = 0xF4F4F5
_BG_NUDGED: constant(bytes3) = 0xE5E5E4

# Pre-computed regular-polygon vertices (center 250,250 · radius 200 · vertex-up). Computed offline;
# baked so there is zero runtime trig and the output is byte-for-byte deterministic.
#   triangle (3) : angles -90,30,150
#   hexagon  (6) : angles -90,-30,30,90,150,210
#   nonagon  (9) : angles -90 step 40
_TRI_PTS: constant(String[24]) = "250,50 423,350 77,350"
_HEX_PTS: constant(String[48]) = "250,50 423,150 423,350 250,450 77,350 77,150"
_NON_PTS: constant(String[72]) = "250,50 379,97 447,215 423,350 318,438 182,438 77,350 53,215 121,97"


# ═══ external API ════════════════════════════════════════════════════════════════════════════════

@external
@pure
def sidesOf(char_len: uint256) -> uint256:
    """
    @notice Number of die sides for an ENS name of `char_len` normalized characters.
    @param char_len ENSIP-15 normalized character count of the label (NOT byte length, NOT from node).
    @return 3 (len<=3), 6 (len==4), or 9 (len>=5).
    """
    return self._sides_of(char_len)


@external
@pure
def tierOf(char_len: uint256) -> uint256:
    """
    @notice Rarity tier index. 0 = legendary (3 sides), 1 = rare (6), 2 = standard (9).
    @param char_len ENSIP-15 normalized character count.
    @return 0, 1, or 2 (lower == rarer == shorter name).
    """
    if char_len <= 3:
        return 0
    if char_len == 4:
        return 1
    return 2


@external
@pure
def tierName(char_len: uint256) -> String[9]:
    """
    @notice Human-readable rarity tier for an ENS name of `char_len` characters.
    @param char_len ENSIP-15 normalized character count.
    @return "LEGENDARY" (3-char), "RARE" (4-char), or "STANDARD" (5+).
    """
    if char_len <= 3:
        return "LEGENDARY"
    if char_len == 4:
        return "RARE"
    return "STANDARD"


@external
@pure
def colorOf(node: bytes32) -> bytes3:
    """
    @notice The deterministic 24-bit brand color (high 3 bytes of keccak(abi.encode("color", node))).
    @dev Re-derived here (not imported) so this pure twin is self-contained; identical to NameMath.
    @param node The ENS namehash.
    @return The brand color as bytes3.
    """
    return self._color_of(node)


@external
@pure
def colorHex(node: bytes32) -> String[7]:
    """
    @notice The brand color as a `#RRGGBB` string (CSS / SVG ready).
    @param node The ENS namehash.
    @return e.g. `#1A2B3C`.
    """
    return self._hex_color(self._color_of(node))


@external
@pure
def dieRawSVG(node: bytes32, char_len: uint256) -> String[420]:
    """
    @notice Raw `<svg>...</svg>` of the name's die: a regular N-gon (N = sidesOf(char_len)) filled
            with the name's brand color. Canonical (point-up) orientation -- roll/orientation is a
            Chainlink VRF concern handled by the router, see header.
    @param node The ENS namehash (drives COLOR).
    @param char_len ENSIP-15 normalized character count (drives SIDES / rarity).
    @return The `<svg ...>...</svg>` markup string.
    """
    return self._die_raw_svg(node, char_len)


@external
@pure
def dieSVG(node: bytes32, char_len: uint256) -> String[444]:
    """
    @notice The die as a `data:image/svg+xml;utf8,...` URI (tokenURI-ready image field).
    @param node The ENS namehash (color).
    @param char_len ENSIP-15 normalized character count (sides).
    @return A `data:image/svg+xml;utf8,<svg ...>...</svg>` string.
    """
    return concat("data:image/svg+xml;utf8,", self._die_raw_svg(node, char_len))


# ═══ internal helpers ════════════════════════════════════════════════════════════════════════════

@internal
@pure
def _sides_of(char_len: uint256) -> uint256:
    # 3 / 6 / 9 by length. char_len<=3 folds the (unregistrable) 1- and 2-char cases into the
    # rarest tier defensively; real ENS labels are >= 3 (finding #2).
    if char_len <= 3:
        return 3
    if char_len == 4:
        return 6
    return 9


@internal
@pure
def _polygon_points(char_len: uint256) -> String[72]:
    # Select the pre-computed vertex set for this tier's N-gon.
    s: uint256 = self._sides_of(char_len)
    if s == 3:
        return _TRI_PTS
    if s == 6:
        return _HEX_PTS
    return _NON_PTS


@internal
@pure
def _die_raw_svg(node: bytes32, char_len: uint256) -> String[420]:
    fg: String[7] = self._hex_color(self._color_of(node))
    pts: String[72] = self._polygon_points(char_len)
    # One bounded concat so Vyper's static length is computed once.
    return concat(
        _HEAD,
        '<polygon points="',
        pts,
        '" fill="',
        fg,
        '" stroke="',
        _STROKE,
        '" stroke-width="8" stroke-linejoin="round"/></svg>',
    )


@internal
@pure
def _color_of(node: bytes32) -> bytes3:
    # EXACT Solidity `abi.encode("color", node)` preimage -> keccak -> high 3 bytes. Mirrors NameMath.
    h: bytes32 = keccak256(concat(_ABI_OFFSET_40, node, _COLOR_LEN, _COLOR_TAG))
    c: bytes3 = convert(slice(h, 0, 3), bytes3)
    if c == _BG:
        return _BG_NUDGED
    return c


@internal
@pure
def _hex_color(color: bytes3) -> String[7]:
    # bytes3 -> `#RRGGBB`. Mirrors NameMath._hex_color.
    byte_mask: uint256 = 255
    nibble: uint256 = 15
    v: uint256 = convert(color, uint256)
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
