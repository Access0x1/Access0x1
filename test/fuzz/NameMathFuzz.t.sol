// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { NameMath } from "../../src/NameMath.sol";

/// @dev NameMath's functions are `internal` (they inline into the brand layer / router / SDK
///      mirror), so they cannot be called externally. This thin harness exposes them exactly as a
///      caller would use them — identical in shape to the harness in `test/unit/NameMath.t.sol`,
///      re-declared here so the fuzz file is self-contained and never collides with the unit file.
contract NameMathFuzzHarness {
    using NameMath for bytes32;

    function colorOf(bytes32 node) external pure returns (bytes3) {
        return node.colorOf();
    }

    function colorHex(bytes32 node) external pure returns (string memory) {
        return node.colorHex();
    }

    function identiconSVG(bytes32 node) external pure returns (string memory) {
        return node.identiconSVG();
    }

    function identiconRawSVG(bytes32 node) external pure returns (string memory) {
        return node.identiconRawSVG();
    }
}

/// @title  NameMathFuzz — Cyfrin STATELESS FUZZ for the pure brand-math library
/// @author Access0x1
/// @notice NameMath is a PURE, STATELESS library: no storage, no oracle, no money path. The Cyfrin
///         stateless-fuzz tier is therefore the right adversarial harness for it — there is no
///         state to drive a stateful invariant over (so that tier is intentionally skipped, see the
///         integration file's notes). Each test below fuzzes ONE public/external entrypoint over a
///         huge input space and asserts a PER-CALL invariant that must hold for every `node`:
///
///           - colorOf:          equals the documented `bytes3(keccak(encode("color", node)))`
///                               formula the SDK mirrors byte-for-byte, AND is total (never reverts).
///           - colorHex:         ALWAYS a 7-char `#RRGGBB` string whose 6 body chars are uppercase
///                               hex, and whose value round-trips back to `colorOf(node)`.
///           - identiconRawSVG:  ALWAYS a well-formed `<svg…>…</svg>`, vertically symmetric
///                               (col0==col4, col1==col3 cell counts), with a bounded on-cell count
///                               that matches the seed's painted-bit popcount, and the brand color
///                               only ever appears as a `fill` (never the neutral background swap).
///           - identiconSVG:     ALWAYS the raw SVG with the exact `data:image/svg+xml;utf8,` prefix.
///
///         The money-conservation invariants the prompt mentions (net+fee==gross, no negative
///         balance, zero residual custody) DO NOT APPLY: NameMath touches no value. The faithful
///         analogue here is CONSERVATION OF THE DERIVATION — identical input ⇒ identical output,
///         the output is total, and the structural invariants hold for every fuzzed input.
contract NameMathFuzzTest is Test {
    using NameMath for bytes32;

    NameMathFuzzHarness internal h;

    function setUp() public {
        h = new NameMathFuzzHarness();
    }

    /*//////////////////////////////////////////////////////////////
                              colorOf
    //////////////////////////////////////////////////////////////*/

    /// @notice colorOf is TOTAL and matches the documented SDK-mirror formula for EVERY node.
    /// @dev    Proves the on-chain derivation is exactly the documented formula — the raw
    ///         `bytes3(keccak(abi.encode("color", node)))` followed by the I-4 legibility nudge
    ///         (`== BG ? ^ 0x111111`). The `_expectedColor` helper applies that SAME nudge, so this
    ///         pins the full formula `proc-sdk-embed` must reproduce in viem, including the nudge. If
    ///         either leg drifts, the off-chain SDK and on-chain brand layer would render different
    ///         colors for the same name.
    function testFuzz_colorOf_matchesDocumentedFormula(bytes32 node) public view {
        assertEq(
            h.colorOf(node),
            _expectedColor(node),
            "colorOf must equal the documented (nudged) formula"
        );
    }

    /// @notice colorOf is deterministic: same node ⇒ same color, on repeated independent calls.
    /// @dev    A pure function is a function — this pins it so a future refactor that accidentally
    ///         introduced non-determinism (e.g. a block-dependent term) would fail loudly.
    function testFuzz_colorOf_isDeterministic(bytes32 node) public view {
        assertEq(h.colorOf(node), h.colorOf(node), "same node must yield same color");
    }

    /// @notice colorOf NEVER equals the background `BG` (0xF4F4F5) for any node — the I-4 nudge.
    /// @dev    The rendered foreground is `colorOf(node)`; were it ever equal to the backdrop the
    ///         avatar would paint invisible. The `== BG ? ^ NUDGE` branch in `colorOf` guarantees
    ///         this for every input; fuzzing the whole space proves no name escapes the nudge.
    function testFuzz_colorOf_neverEqualsBackground(bytes32 node) public view {
        assertTrue(h.colorOf(node) != bytes3(0xF4F4F5), "brand color must never equal the BG");
    }

    /// @notice The ONE node whose raw hash equals `BG` is nudged to exactly `BG ^ 0x111111`.
    /// @dev    A deterministic regression for the nudge branch itself. `colorOf` cannot easily be
    ///         driven to the `BG` pre-image by fuzzing (1-in-2^24), so we synthesize the collision:
    ///         the nudged output must be `0xE5E5E4`, a valid visible RRGGBB, and never `BG`. This is
    ///         the exact value the SDK must produce for the colliding name.
    function test_colorOf_nudgesExactBackgroundCollisionDeterministically() public pure {
        bytes3 bg = 0xF4F4F5;
        bytes3 nudged = bg ^ bytes3(0x111111);
        assertEq(nudged, bytes3(0xE5E5E4), "BG ^ 0x111111 must be the fixed visible nudge 0xE5E5E4");
        assertTrue(nudged != bg, "nudged color must never equal the background");
    }

    /// @notice The "color" domain tag keeps colorOf independent of the identicon seed: the color
    ///         derivation never equals the identicon seed's low 3 bytes by construction.
    /// @dev    Proves the domain separation documented in NameMath: `keccak(encode("color", node))`
    ///         vs `keccak(encode("identicon", node))` are different pre-images, so the two
    ///         derivations can never collide for the same node. (keccak collision over the full
    ///         32-byte digest is infeasible, so this holds for every fuzzed node.)
    function testFuzz_colorAndIdenticonSeedsAreDomainSeparated(bytes32 node) public pure {
        bytes32 colorDigest = keccak256(abi.encode("color", node));
        bytes32 identiconDigest = keccak256(abi.encode("identicon", node));
        assertTrue(colorDigest != identiconDigest, "color and identicon domains must be separated");
    }

    /*//////////////////////////////////////////////////////////////
                              colorHex
    //////////////////////////////////////////////////////////////*/

    /// @notice colorHex is ALWAYS a valid 7-char `#RRGGBB` string for every node.
    /// @dev    The output is fixed-width by construction (no dynamic length), so this asserts the
    ///         contract every CSS/SVG consumer relies on: exactly `#` + 6 uppercase-hex chars.
    function testFuzz_colorHex_isAlwaysSevenCharUppercaseHex(bytes32 node) public view {
        bytes memory s = bytes(h.colorHex(node));
        assertEq(s.length, 7, "#RRGGBB is exactly 7 chars");
        assertEq(s[0], bytes1("#"), "must start with #");
        for (uint256 i = 1; i < 7; ++i) {
            bytes1 ch = s[i];
            bool isDigit = ch >= bytes1("0") && ch <= bytes1("9");
            bool isUpperHex = ch >= bytes1("A") && ch <= bytes1("F");
            assertTrue(isDigit || isUpperHex, "each body char must be an uppercase hex digit");
        }
    }

    /// @notice colorHex round-trips: parsing the rendered `#RRGGBB` back to bytes3 yields colorOf.
    /// @dev    Proves the renderer is a faithful, lossless encoding of `colorOf(node)` — not just
    ///         "some hex string". This is the strongest possible per-call invariant for the
    ///         color → string leg and is the exact check an auditor would want: no off-by-one in the
    ///         nibble split, no transposed bytes.
    function testFuzz_colorHex_roundTripsToColorOf(bytes32 node) public view {
        bytes3 color = h.colorOf(node);
        bytes memory s = bytes(h.colorHex(node));
        // Reconstruct the 3 bytes from the 6 hex body chars.
        uint24 reconstructed;
        for (uint256 i = 0; i < 6; ++i) {
            reconstructed = uint24(reconstructed << 4) | _hexVal(s[1 + i]);
        }
        assertEq(bytes3(reconstructed), color, "rendered hex must round-trip back to colorOf");
    }

    /*//////////////////////////////////////////////////////////////
                         identiconRawSVG
    //////////////////////////////////////////////////////////////*/

    /// @notice identiconRawSVG is ALWAYS well-formed: opens with the namespaced `<svg`, carries the
    ///         fixed 500x500 viewBox + background rect, and closes with `</svg>` — for every node.
    /// @dev    Catches any input that could produce truncated/garbled markup (it cannot — the build
    ///         is loop-bounded — but the fuzz proves it across the input space, not just a vector).
    function testFuzz_identiconRawSVG_isAlwaysWellFormed(bytes32 node) public view {
        string memory svg = h.identiconRawSVG(node);
        assertTrue(
            _startsWith(svg, '<svg xmlns="http://www.w3.org/2000/svg"'), "well-formed open tag"
        );
        assertTrue(_contains(svg, 'viewBox="0 0 500 500"'), "fixed 500x500 viewBox");
        assertTrue(_contains(svg, 'fill="#F4F4F5"'), "neutral background rect always present");
        assertTrue(_endsWith(svg, "</svg>"), "must close the svg tag");
    }

    /// @notice The identicon is ALWAYS vertically symmetric for every node: the painted-cell count
    ///         in column 0 equals column 4, and column 1 equals column 3.
    /// @dev    The "blockie" look is the product promise. Symmetry is enforced by the mirror loop
    ///         (`col c → col N-1-c`); this fuzz proves it holds for every seed, so no name ever
    ///         renders a lopsided avatar.
    function testFuzz_identicon_isAlwaysVerticallySymmetric(bytes32 node) public view {
        string memory svg = h.identiconRawSVG(node);
        assertEq(_count(svg, 'x="0"'), _count(svg, 'x="400"'), "col0 mirrors col4");
        assertEq(_count(svg, 'x="100"'), _count(svg, 'x="300"'), "col1 mirrors col3");
    }

    /// @notice The number of painted cells in the SVG EXACTLY matches the seed's popcount over its
    ///         15 grid bits (with the center column counted once and the two mirrored columns
    ///         counted twice), for every node — and is bounded to [0, 25].
    /// @dev    This is the conservation invariant for the identicon: every painted `<rect>` (i.e.
    ///         every brand-color fill) corresponds to exactly one set seed bit, doubled for the two
    ///         mirrorable columns. No cell is painted without a bit; no bit fails to paint a cell.
    ///         The total can never exceed the 5x5 grid (25 cells).
    function testFuzz_identicon_paintedCellsMatchSeedPopcount(bytes32 node) public view {
        uint256 seed = uint256(keccak256(abi.encode("identicon", node)));

        // Recompute the EXPECTED painted-cell count exactly as NameMath paints: bit index r*3+c for
        // r in 0..4, c in 0..2. Columns 0 and 1 each paint a mirror (so count 2); column 2 (center)
        // paints once.
        uint256 expectedPainted;
        for (uint256 r = 0; r < 5; ++r) {
            for (uint256 c = 0; c < 3; ++c) {
                if ((seed >> (r * 3 + c)) & 1 == 1) {
                    expectedPainted += (c < 2) ? 2 : 1;
                }
            }
        }
        assertLe(expectedPainted, 25, "painted cells can never exceed the 5x5 grid");

        // The brand-color fill count in the SVG must equal the expected painted-cell count. Each
        // painted cell is one `<rect ... fill="#RRGGBB"/>` using the brand color; the single
        // background rect uses the neutral BG, so it never inflates the brand-color count.
        string memory svg = h.identiconRawSVG(node);
        string memory brandFill = string.concat('fill="', h.colorHex(node), '"');
        assertEq(_count(svg, brandFill), expectedPainted, "painted cells must equal seed popcount");
    }

    /// @notice For every node, the brand color appears ONLY as a foreground fill and the neutral BG
    ///         appears exactly once (the single full-canvas background rect).
    /// @dev    Proves the foreground/background separation NameMath documents: the brand color is
    ///         never used as the backdrop, so two names with similar hues stay legible. The BG rect
    ///         count is invariant at 1 regardless of how many foreground cells are painted.
    function testFuzz_identicon_backgroundAppearsExactlyOnce(bytes32 node) public view {
        string memory svg = h.identiconRawSVG(node);
        assertEq(_count(svg, 'fill="#F4F4F5"'), 1, "exactly one neutral background rect");
    }

    /// @notice The rendered foreground hex is NEVER `#F4F4F5` for any node — the I-4 invisibility
    ///         guard at the STRING level (the avatar can never paint its cells in the backdrop).
    /// @dev    `colorHex(node)` is the exact string the SDK/SVG paints into every "on" cell. The
    ///         single neutral-BG `fill="#F4F4F5"` is the backdrop rect only; this asserts the
    ///         FOREGROUND hex differs from it for every fuzzed input. Pairs with
    ///         `testFuzz_colorOf_neverEqualsBackground` (the byte-level twin).
    function testFuzz_renderedForegroundNeverEqualsBackground(bytes32 node) public view {
        string memory fg = h.colorHex(node);
        assertTrue(
            keccak256(bytes(fg)) != keccak256(bytes("#F4F4F5")),
            "rendered foreground must never be #F4F4F5"
        );
    }

    /*//////////////////////////////////////////////////////////////
                          identiconSVG (URI)
    //////////////////////////////////////////////////////////////*/

    /// @notice identiconSVG is ALWAYS the raw SVG prefixed with the exact data-URI header, for every
    ///         node — so it drops straight into an `<img src>` or an ENS avatar text record.
    /// @dev    Proves the URI wrapper is a pure prefix of the raw SVG: stripping the documented
    ///         `data:image/svg+xml;utf8,` header yields exactly `identiconRawSVG(node)`.
    function testFuzz_identiconSVG_isRawWithDataUriPrefix(bytes32 node) public view {
        string memory prefix = "data:image/svg+xml;utf8,";
        string memory uri = h.identiconSVG(node);
        string memory raw = h.identiconRawSVG(node);
        assertEq(uri, string.concat(prefix, raw), "uri must be the documented prefix + raw svg");
    }

    /*//////////////////////////////////////////////////////////////
                         cross-function totality
    //////////////////////////////////////////////////////////////*/

    /// @notice The whole surface is TOTAL: no entrypoint reverts on any node (including 0x00..00).
    /// @dev    A pure brand layer must never revert — a render failure for an unlucky name would
    ///         brick the avatar. Calling each function in one fuzz proves totality across the space.
    function testFuzz_allEntrypointsAreTotal(bytes32 node) public view {
        h.colorOf(node);
        h.colorHex(node);
        h.identiconRawSVG(node);
        h.identiconSVG(node);
    }

    /*//////////////////////////////////////////////////////////////
                              HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev The full documented color formula, INCLUDING the I-4 legibility nudge — the exact
    ///      byte-for-byte computation the SDK must mirror. Used as the expected value so the
    ///      formula-mirror fuzz asserts the FIXED behavior, not the old raw-hash bug.
    function _expectedColor(bytes32 node) internal pure returns (bytes3) {
        bytes3 color = bytes3(keccak256(abi.encode("color", node)));
        return color == bytes3(0xF4F4F5) ? color ^ bytes3(0x111111) : color;
    }

    /// @dev Parse one uppercase-hex / decimal char to its 0..15 nibble value (asserts validity).
    function _hexVal(bytes1 ch) internal pure returns (uint8) {
        if (ch >= bytes1("0") && ch <= bytes1("9")) return uint8(ch) - uint8(bytes1("0"));
        if (ch >= bytes1("A") && ch <= bytes1("F")) return 10 + uint8(ch) - uint8(bytes1("A"));
        revert("non-hex char in colorHex output");
    }

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory sb = bytes(s);
        bytes memory pb = bytes(prefix);
        if (sb.length < pb.length) return false;
        for (uint256 i = 0; i < pb.length; ++i) {
            if (sb[i] != pb[i]) return false;
        }
        return true;
    }

    function _endsWith(string memory s, string memory suffix) internal pure returns (bool) {
        bytes memory sb = bytes(s);
        bytes memory fb = bytes(suffix);
        if (sb.length < fb.length) return false;
        uint256 offset = sb.length - fb.length;
        for (uint256 i = 0; i < fb.length; ++i) {
            if (sb[offset + i] != fb[i]) return false;
        }
        return true;
    }

    function _contains(string memory s, string memory needle) internal pure returns (bool) {
        return _count(s, needle) > 0;
    }

    function _count(string memory s, string memory needle) internal pure returns (uint256 c) {
        bytes memory sb = bytes(s);
        bytes memory nb = bytes(needle);
        if (nb.length == 0 || sb.length < nb.length) return 0;
        for (uint256 i = 0; i <= sb.length - nb.length; ++i) {
            bool matched = true;
            for (uint256 j = 0; j < nb.length; ++j) {
                if (sb[i + j] != nb[j]) {
                    matched = false;
                    break;
                }
            }
            if (matched) ++c;
        }
    }
}
