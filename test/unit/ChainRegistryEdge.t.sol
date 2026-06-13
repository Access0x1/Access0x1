// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { ChainRegistry } from "../../src/ChainRegistry.sol";

/// @title  ChainRegistryEdge — boundary / extreme-value unit cases the main unit suite omits
/// @author Access0x1
/// @notice Targeted edge-case unit tests for {ChainRegistry} that complement (do NOT duplicate)
///         `test/unit/ChainRegistry.t.sol`. The main suite proves the happy paths, the live-bit
///         isolation, the not-found reverts, and the flag constants on REPRESENTATIVE values; this
///         file pins the EXTREMES and the easy-to-miss corners a human auditor checks last: the
///         max-width field values (a full `uint256` chainId, `type(uint64).max` selector, the all-bits
///         `uint16` flags word), `chainId == 0` as a real key, the raw public `chains` getter on an
///         unknown id (all-zero, no revert — distinct from `getChain`'s revert), and the "downgrade to
///         invisible" upsert (a real entry overwritten with the all-zero config disappears from the
///         `_exists` view). Every test is arrange-act-assert with one property per function.
contract ChainRegistryEdgeTest is Test {
    ChainRegistry internal registry;

    address internal owner = makeAddr("owner");

    uint16 internal constant FLAG_LIVE = 0x0001;
    uint16 internal constant FLAG_CIRCLE_USDC = 0x0002;
    uint16 internal constant FLAG_CCIP_LANE = 0x0004;
    uint16 internal constant FLAG_TESTNET = 0x0008;

    function setUp() public {
        registry = new ChainRegistry(owner);
    }

    /*//////////////////////////////////////////////////////////////
                       MAX-WIDTH FIELD VALUES
    //////////////////////////////////////////////////////////////*/

    /// @notice A full-width `uint256` chainId is a valid key — the mapping has no id ceiling, so the
    ///         largest possible chain id round-trips exactly like any other (guards against an
    ///         accidental narrower key type somewhere in the read path).
    function test_addChain_maxUint256ChainId_roundTrips() public {
        uint256 maxId = type(uint256).max;
        ChainRegistry.ChainConfig memory cfg = ChainRegistry.ChainConfig({
            usdc: makeAddr("u"), router: makeAddr("r"), ccipSelector: 7, flags: FLAG_TESTNET
        });

        vm.prank(owner);
        registry.addChain(maxId, cfg);

        ChainRegistry.ChainConfig memory got = registry.getChain(maxId);
        assertEq(got.ccipSelector, 7, "max chainId stores its selector");
        assertEq(got.flags, FLAG_TESTNET, "max chainId stores its flags");
        assertFalse(registry.isLive(maxId), "max chainId not-live as written");
    }

    /// @notice The `ccipSelector` is a `uint64`; `type(uint64).max` must store and read back without
    ///         truncation. CCIP chain selectors are large 64-bit values, so the top of the range is the
    ///         realistic worst case — a narrowing bug would corrupt the lane the SDK routes over.
    function test_addChain_maxUint64Selector_noTruncation() public {
        uint64 maxSel = type(uint64).max;
        ChainRegistry.ChainConfig memory cfg = ChainRegistry.ChainConfig({
            usdc: address(0), router: address(0), ccipSelector: maxSel, flags: 0
        });

        vm.prank(owner);
        registry.addChain(84_532, cfg);

        // Even with zero usdc/router/flags, a non-zero selector alone makes the entry exist.
        assertEq(registry.getChain(84_532).ccipSelector, maxSel, "max selector round-trips intact");
    }

    /// @notice The `flags` word is a `uint16`; storing all 16 bits set must round-trip verbatim, and
    ///         because bit 0 is set, `isLive` reads true. Proves the flags field is full-width storage
    ///         (the documented FLAG_* bits are a subset; undocumented high bits are stored, not masked).
    function test_addChain_allFlagBitsSet_roundTripsAndIsLive() public {
        uint16 allBits = type(uint16).max;
        ChainRegistry.ChainConfig memory cfg = ChainRegistry.ChainConfig({
            usdc: address(0), router: address(0), ccipSelector: 0, flags: allBits
        });

        vm.prank(owner);
        registry.addChain(300, cfg);

        assertEq(registry.getChain(300).flags, allBits, "all 16 flag bits stored verbatim");
        assertTrue(registry.isLive(300), "bit 0 set means isLive true");
    }

    /// @notice With every flag bit set, `setChainLive(false)` must clear ONLY bit 0 and leave the other
    ///         15 bits intact — the extreme companion to the unit suite's representative bit-isolation
    ///         test. Proves `&= ~FLAG_LIVE` is a precise single-bit clear at the boundary.
    function test_setChainLive_off_clearsOnlyBitZero_fromAllSet() public {
        uint16 allBits = type(uint16).max;
        vm.startPrank(owner);
        registry.addChain(
            300,
            ChainRegistry.ChainConfig({
                usdc: address(0), router: address(0), ccipSelector: 0, flags: allBits
            })
        );
        registry.setChainLive(300, false);
        vm.stopPrank();

        // Exactly bit 0 cleared; all other bits preserved.
        assertEq(registry.getChain(300).flags, allBits & ~FLAG_LIVE, "only bit 0 cleared");
        assertFalse(registry.isLive(300), "chain reads not-live after clear");
    }

    /*//////////////////////////////////////////////////////////////
                         chainId == 0 AS A KEY
    //////////////////////////////////////////////////////////////*/

    /// @notice `chainId == 0` is a perfectly valid mapping key (it is NOT the "not found" sentinel —
    ///         the sentinel is the all-zero VALUE, not a zero KEY). A non-default config at id 0
    ///         round-trips and is found, guarding against any code that mistakes a zero key for absence.
    function test_addChain_zeroChainIdKey_isValidAndFound() public {
        ChainRegistry.ChainConfig memory cfg = ChainRegistry.ChainConfig({
            usdc: makeAddr("u"), router: address(0), ccipSelector: 0, flags: FLAG_TESTNET
        });

        vm.prank(owner);
        registry.addChain(0, cfg);

        ChainRegistry.ChainConfig memory got = registry.getChain(0);
        assertEq(got.flags, FLAG_TESTNET, "zero-key entry is found and reads its flags");

        // And the live toggle works on the zero key (it exists, so no ChainNotFound).
        vm.prank(owner);
        registry.setChainLive(0, true);
        assertTrue(registry.isLive(0), "zero-key chain can be flagged live");
    }

    /*//////////////////////////////////////////////////////////////
              RAW `chains` PUBLIC GETTER ON AN UNKNOWN ID
    //////////////////////////////////////////////////////////////*/

    /// @notice The auto-generated `chains` getter does NOT run `_exists`, so reading a never-added id
    ///         through it returns the all-zero struct WITHOUT reverting — unlike `getChain`, which
    ///         reverts `ChainNotFound`. This documents the deliberate difference (SDK callers that want
    ///         the revert use `getChain`; raw mapping readers get the zero default) so neither is
    ///         mistaken for the other.
    function test_chainsGetter_unknownId_returnsZeroNoRevert() public view {
        (address u, address r, uint64 sel, uint16 f) = registry.chains(999_999);
        assertEq(u, address(0), "unknown id raw usdc is zero");
        assertEq(r, address(0), "unknown id raw router is zero");
        assertEq(sel, 0, "unknown id raw selector is zero");
        assertEq(f, 0, "unknown id raw flags is zero");
    }

    /*//////////////////////////////////////////////////////////////
            DOWNGRADE-TO-INVISIBLE UPSERT (the _exists corner)
    //////////////////////////////////////////////////////////////*/

    /// @notice A real entry overwritten with the all-zero config becomes INVISIBLE again: `getChain`
    ///         and `setChainLive` revert `ChainNotFound` afterward, and `isLive` reads false. This is
    ///         the inverse of the attack-suite's all-zero-add test — here an EXISTING entry is
    ///         downgraded, proving the `_exists` sentinel is recomputed per read (no "once added,
    ///         always found" caching) so the SDK never relies on a zeroed-out entry being readable.
    function test_upsert_overwriteWithAllZero_makesEntryInvisible() public {
        // First a real entry exists and is found.
        vm.startPrank(owner);
        registry.addChain(
            84_532,
            ChainRegistry.ChainConfig({
                usdc: makeAddr("u"),
                router: makeAddr("r"),
                ccipSelector: 5,
                flags: FLAG_TESTNET | FLAG_LIVE
            })
        );
        assertTrue(registry.isLive(84_532), "entry initially live + found");

        // Overwrite with the all-zero config — the upsert "succeeds" but writes the sentinel.
        registry.addChain(
            84_532,
            ChainRegistry.ChainConfig({
                usdc: address(0), router: address(0), ccipSelector: 0, flags: 0
            })
        );
        vm.stopPrank();

        // Now it reads as never-added everywhere `_exists` gates.
        vm.expectRevert(
            abi.encodeWithSelector(
                ChainRegistry.ChainRegistry__ChainNotFound.selector, uint256(84_532)
            )
        );
        registry.getChain(84_532);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ChainRegistry.ChainRegistry__ChainNotFound.selector, uint256(84_532)
            )
        );
        registry.setChainLive(84_532, true);

        assertFalse(registry.isLive(84_532), "downgraded entry reads not-live, no revert");
    }
}
