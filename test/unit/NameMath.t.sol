// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { NameMath } from "../../src/NameMath.sol";

/// @dev NameMath's functions are `internal` (inlined into the brand layer), so they cannot be
///      called externally. This thin harness exposes them exactly as a caller would use them.
contract NameMathHarness {
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

contract NameMathTest is Test {
    NameMathHarness internal h;

    // namehash("merchant.access0x1.eth") is irrelevant to the math — any two distinct bytes32
    // exercise it. We use stable, named vectors so failures are legible.
    bytes32 internal constant NODE_A = keccak256("merchant.access0x1.eth");
    bytes32 internal constant NODE_B = keccak256("alice.merchant.access0x1.eth");

    function setUp() public {
        h = new NameMathHarness();
    }

    // ─── determinism ─────────────────────────────────────────────────────────────────────────

    function test_colorIsDeterministic() public view {
        assertEq(h.colorOf(NODE_A), h.colorOf(NODE_A), "same node must yield same color");
        assertEq(h.identiconSVG(NODE_A), h.identiconSVG(NODE_A), "same node must yield same svg");
    }

    function testFuzz_colorIsDeterministic(bytes32 node) public view {
        assertEq(h.colorOf(node), h.colorOf(node));
        assertEq(h.identiconSVG(node), h.identiconSVG(node));
    }

    // ─── the derivation matches the documented formula (SDK mirror contract) ───────────────────

    function test_colorMatchesDocumentedFormula() public view {
        // This is the EXACT formula the SDK (`proc-sdk-embed`) must reproduce in viem.
        bytes3 expected = bytes3(keccak256(abi.encode("color", NODE_A)));
        assertEq(
            h.colorOf(NODE_A), expected, "colorOf must equal bytes3(keccak(encode('color',node)))"
        );
    }

    function testFuzz_colorMatchesDocumentedFormula(bytes32 node) public view {
        assertEq(h.colorOf(node), bytes3(keccak256(abi.encode("color", node))));
    }

    function test_colorHexMatchesColorOf() public view {
        bytes3 c = h.colorOf(NODE_A);
        string memory expected =
            string.concat("#", _byteHex(uint8(c[0])), _byteHex(uint8(c[1])), _byteHex(uint8(c[2])));
        assertEq(h.colorHex(NODE_A), expected, "colorHex must render colorOf as #RRGGBB");
    }

    function test_colorHexIsSevenChars() public view {
        bytes memory hexStr = bytes(h.colorHex(NODE_A));
        assertEq(hexStr.length, 7, "#RRGGBB is exactly 7 chars");
        assertEq(hexStr[0], "#", "must start with #");
    }

    // ─── distinctness ──────────────────────────────────────────────────────────────────────────

    function test_differentNodesDifferentColor() public view {
        assertTrue(h.colorOf(NODE_A) != h.colorOf(NODE_B), "distinct names must differ in color");
    }

    function test_differentNodesDifferentSVG() public view {
        assertTrue(
            keccak256(bytes(h.identiconSVG(NODE_A))) != keccak256(bytes(h.identiconSVG(NODE_B))),
            "distinct names must differ in identicon"
        );
    }

    function testFuzz_differentNodesDifferentColor(bytes32 a, bytes32 b) public view {
        vm.assume(a != b);
        // keccak is collision-resistant; over 24 bits a clash is astronomically unlikely but not
        // impossible, so we only assert the function is a function (handled by determinism tests)
        // and that the typical case differs. Use a soft check: at least one of color/svg differs.
        bool colorDiffers = h.colorOf(a) != h.colorOf(b);
        bool svgDiffers = keccak256(bytes(h.identiconSVG(a))) != keccak256(bytes(h.identiconSVG(b)));
        assertTrue(colorDiffers || svgDiffers, "distinct nodes should differ in color or identicon");
    }

    // ─── valid SVG structure ─────────────────────────────────────────────────────────────────

    function test_svgIsDataUriReady() public view {
        string memory svg = h.identiconSVG(NODE_A);
        assertTrue(_startsWith(svg, "data:image/svg+xml;utf8,<svg"), "must be a data-URI-ready SVG");
        assertTrue(_endsWith(svg, "</svg>"), "must close the svg tag");
    }

    function test_rawSvgStructure() public view {
        string memory svg = h.identiconRawSVG(NODE_A);
        assertTrue(
            _startsWith(svg, '<svg xmlns="http://www.w3.org/2000/svg"'), "well-formed open tag"
        );
        assertTrue(_contains(svg, 'viewBox="0 0 500 500"'), "fixed 500x500 viewBox");
        assertTrue(_contains(svg, "<rect"), "must contain rects");
        assertTrue(_endsWith(svg, "</svg>"), "must close");
        // foreground brand color must appear (it is used as a fill at least on the symmetric grid;
        // the background rect is always present and uses the neutral BG color).
        assertTrue(_contains(svg, "fill=\"#F4F4F5\""), "neutral background present");
    }

    function test_svgContainsBrandColor() public view {
        // The identicon paints "on" cells in the brand color. NODE_A's seed has on-cells (verified
        // by the structure test painting rects), so the brand color string must appear.
        string memory svg = h.identiconRawSVG(NODE_A);
        string memory color = h.colorHex(NODE_A);
        assertTrue(
            _contains(svg, string.concat("fill=\"", color, "\"")), "brand color is used as a fill"
        );
    }

    // ─── vertical symmetry (the blockie look) ──────────────────────────────────────────────────

    function test_identiconIsVerticallySymmetric() public view {
        // For every painted cell in a left column (x in {0,100}), its mirror (x in {400,300})
        // must also be painted. We verify by counting: cells at x=0 == cells at x=400, and
        // cells at x=100 == cells at x=300.
        string memory svg = h.identiconRawSVG(NODE_A);
        assertEq(
            _countOccurrences(svg, 'x="0"'), _countOccurrences(svg, 'x="400"'), "col0 mirrors col4"
        );
        assertEq(
            _countOccurrences(svg, 'x="100"'),
            _countOccurrences(svg, 'x="300"'),
            "col1 mirrors col3"
        );
    }

    // ─── gas bound (WOW visual must stay cheap enough to read on-chain) ──────────────────────────

    function test_gasBounded() public view {
        uint256 g0 = gasleft();
        h.identiconSVG(NODE_A);
        uint256 used = g0 - gasleft();
        // Pure string building of a 5x5 SVG; comfortably under this ceiling. Catches accidental
        // unbounded growth (e.g. a loop blow-up) without being flaky.
        assertLt(used, 2_000_000, "identicon render must stay gas-bounded");
    }

    // ─── helpers ─────────────────────────────────────────────────────────────────────────────

    function _byteHex(uint8 b) internal pure returns (string memory) {
        bytes memory hexChars = "0123456789ABCDEF";
        bytes memory out = new bytes(2);
        out[0] = hexChars[b >> 4];
        out[1] = hexChars[b & 0x0f];
        return string(out);
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
        return _countOccurrences(s, needle) > 0;
    }

    function _countOccurrences(string memory s, string memory needle)
        internal
        pure
        returns (uint256 count)
    {
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
            if (matched) ++count;
        }
    }
}
