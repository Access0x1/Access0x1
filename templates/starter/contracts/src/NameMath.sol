// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title NameMath
/// @author Access0x1
/// @notice The ENS "name → math" brand layer: from an ENS namehash (`node`), derive a stable
///         brand color AND a unique identicon — ON-CHAIN, deterministically, with NO storage and
///         NO oracle. Just keccak. The business never picks a color or uploads an avatar; its
///         NAME sets both, automatically and at no extra cost. (See `linkEvent/ENS.md` — the name is data + math.)
/// @dev    Pure functions only: identical `node` ⇒ identical color + SVG, forever, on any chain.
///         Deliberately a `library` with `internal` functions so the body inlines into any caller
///         (router / brand layer / resolver) with NO separate deployment and NO link step — the
///         same single-responsibility, no-link discipline as `OracleLib` (zksolc is hostile to
///         library linking).
///
///         ─────────────────────────────────────────────────────────────────────────────────────
///         ALGORITHM (mirrored EXACTLY in the SDK — `proc-sdk-embed` must match byte-for-byte):
///
///         colorOf(node):
///             return uint24( keccak256( abi.encode("color", node) ) )   // low 3 bytes = bytes3
///             // Solidity `abi.encode("color", node)` = ABI-encode of a (string, bytes32) tuple:
///             //   word0: 0x40                              (offset to the string, = 64)
///             //   word1: node                              (the bytes32, inline)
///             //   word2: 0x05                              (string byte-length = 5)
///             //   word3: "color" left-aligned, zero-padded (0x636f6c6f720000…00)
///             // SDK MUST use viem `encodeAbiParameters([{type:'string'},{type:'bytes32'}],
///             //   ['color', node])` then keccak256 then take the LOW 3 bytes (& 0xffffff).
///
///         identiconSVG(node):
///             seed = keccak256( abi.encode("identicon", node) )   // same tuple-encode rule
///             // 5x5 grid, vertically symmetric (GitHub-blockie style). Columns 0,1,2 are
///             // derived from the seed; columns 3,4 MIRROR columns 1,0. A cell is "on" (painted
///             // in the brand color) when the seed bit for its (row, col<3) index is 1.
///             // bit index for (row r in 0..4, col c in 0..2) = r*3 + c   (15 bits, 1 per cell)
///             // on(r,c) = (uint256(seed) >> (r*3 + c)) & 1 == 1
///             // background = #F4F4F5 (neutral zinc-100); foreground = colorOf(node).
///             // Each cell is a 100x100 unit block in a 0 0 500 500 viewBox.
///         ─────────────────────────────────────────────────────────────────────────────────────
library NameMath {
    /// @notice Neutral identicon background (zinc-100). The brand color is the FOREGROUND only,
    ///         so two names with similar hues stay legible against the same backdrop.
    bytes3 private constant BG = 0xF4F4F5;

    /// @notice Grid is 5 cells per side; each cell is `CELL` units in a `SIZE`x`SIZE` viewBox.
    uint256 private constant N = 5;
    uint256 private constant CELL = 100;
    uint256 private constant SIZE = 500; // N * CELL

    /// @notice The deterministic brand color for an ENS name.
    /// @dev    `bytes3(keccak256(abi.encode("color", node)))` — the low 3 bytes of the domain-
    ///         separated hash. Domain tag `"color"` keeps it independent of the identicon seed so
    ///         the two derivations never collide. Pure: no storage, no oracle.
    /// @param  node The ENS namehash.
    /// @return The 24-bit brand color (RRGGBB).
    function colorOf(bytes32 node) internal pure returns (bytes3) {
        return bytes3(keccak256(abi.encode("color", node)));
    }

    /// @notice The brand color rendered as a 7-char `#RRGGBB` hex string (CSS / SVG ready).
    /// @param  node The ENS namehash.
    /// @return A `#RRGGBB` string, e.g. `#1A2B3C`.
    function colorHex(bytes32 node) internal pure returns (string memory) {
        return _hexColor(colorOf(node));
    }

    /// @notice The deterministic identicon for an ENS name as a data-URI-ready SVG string.
    /// @dev    Seeds a 5x5 vertically-symmetric grid from `keccak256(abi.encode("identicon",
    ///         node))` and paints "on" cells in the brand color. Returns a `data:image/svg+xml`
    ///         URI so it drops straight into an `<img src>` or an ENS avatar text record. Pure.
    /// @param  node The ENS namehash.
    /// @return A `data:image/svg+xml;utf8,<svg ...>...</svg>` string.
    function identiconSVG(bytes32 node) internal pure returns (string memory) {
        return string.concat("data:image/svg+xml;utf8,", identiconRawSVG(node));
    }

    /// @notice The raw `<svg>...</svg>` markup for the identicon (no data-URI prefix).
    /// @dev    Split out so callers that embed in HTML directly (no URI wrapper) can reuse it, and
    ///         so the test suite can assert on clean SVG structure without stripping a prefix.
    /// @param  node The ENS namehash.
    /// @return The `<svg ...>...</svg>` markup string.
    function identiconRawSVG(bytes32 node) internal pure returns (string memory) {
        uint256 seed = uint256(keccak256(abi.encode("identicon", node)));
        string memory fg = colorHex(node);

        // Opening tag + full-canvas background rect.
        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="',
            _toString(SIZE),
            '" height="',
            _toString(SIZE),
            '" viewBox="0 0 ',
            _toString(SIZE),
            " ",
            _toString(SIZE),
            '"><rect width="',
            _toString(SIZE),
            '" height="',
            _toString(SIZE),
            '" fill="',
            _hexColor(BG),
            '"/>'
        );

        // Paint the "on" cells. Columns 0,1,2 are seed-driven; columns 3,4 mirror 1,0 → a
        // vertically symmetric avatar. One bit per (row, half-col): index = r*3 + c.
        for (uint256 r = 0; r < N; ++r) {
            for (uint256 c = 0; c < 3; ++c) {
                if ((seed >> (r * 3 + c)) & 1 == 1) {
                    svg = string.concat(svg, _cell(r, c, fg));
                    if (c < 2) {
                        // mirror column c → column (N-1-c): col1→col3, col0→col4
                        svg = string.concat(svg, _cell(r, N - 1 - c, fg));
                    }
                }
            }
        }

        return string.concat(svg, "</svg>");
    }

    /// @dev One painted `<rect>` at grid position (row, col) in the brand color.
    function _cell(uint256 row, uint256 col, string memory fill)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            '<rect x="',
            _toString(col * CELL),
            '" y="',
            _toString(row * CELL),
            '" width="',
            _toString(CELL),
            '" height="',
            _toString(CELL),
            '" fill="',
            fill,
            '"/>'
        );
    }

    /// @dev `bytes3` → `#RRGGBB`. Fixed 7-char output; no dynamic length, no oracle.
    function _hexColor(bytes3 color) private pure returns (string memory) {
        bytes memory hexChars = "0123456789ABCDEF";
        bytes memory out = new bytes(7);
        out[0] = "#";
        for (uint256 i = 0; i < 3; ++i) {
            uint8 b = uint8(color[i]);
            out[1 + i * 2] = hexChars[b >> 4];
            out[2 + i * 2] = hexChars[b & 0x0f];
        }
        return string(out);
    }

    /// @dev Minimal uint → decimal string (values here are bounded: 0..500). No external dep.
    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            ++digits;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            buffer[--digits] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
        return string(buffer);
    }
}
