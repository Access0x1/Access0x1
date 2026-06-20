// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ChainRegistry } from "../../src/ChainRegistry.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @title  ChainRegistryFuzz — stateless (per-call) fuzz suite for the chain hash-map sidecar
/// @author Access0x1
/// @notice The Cyfrin STATELESS-FUZZ layer for {ChainRegistry}: every public/external function is
///         fuzzed in isolation with `bound()`-constrained inputs, and the per-call PROPERTY that must
///         hold for ALL inputs is asserted (not a single hand-picked example). The registry holds NO
///         assets — there is no `net + fee == gross` money invariant — so the analogue here is the
///         storage/identity contract: a write round-trips byte-for-byte, the `_exists` sentinel is
///         the exact boundary between found and not-found, the live bit is the ONLY bit `setChainLive`
///         touches, and distinct chain ids never alias. The inline `testFuzz_*` in
///         `test/unit/ChainRegistry.t.sol` cover round-trip + the live-bit isolation on a FIXED id;
///         this file is the dedicated, distinct fuzz surface that closes the remaining per-function
///         properties (arbitrary-id reads, the existence boundary, idempotent re-toggle, cross-id
///         independence, and the owner gate under a fuzzed caller).
/// @dev    No handler / no state continuity — this is the stateless tier (one constrained call per
///         run), deliberately separate from the stateful invariant tier. Owner-gated writes are
///         pranked as `owner`; reads need no prank.
contract ChainRegistryFuzzTest is Test, ProxyDeployer {
    ChainRegistry internal registry;

    address internal owner = makeAddr("owner");

    // Mirror of the contract's internal flag scheme (the unit suite asserts these exact values).
    uint16 internal constant FLAG_LIVE = 0x0001;
    uint16 internal constant FLAG_CIRCLE_USDC = 0x0002;
    uint16 internal constant FLAG_CCIP_LANE = 0x0004;
    uint16 internal constant FLAG_TESTNET = 0x0008;
    // The reserved registration marker (bit 15) addChain always ORs into the stored flags word.
    uint16 internal constant FLAG_REGISTERED = 0x8000;

    function setUp() public {
        // Deploy the implementation, then the ERC1967 proxy that initializes it, then drive the proxy.
        address impl = address(new ChainRegistry());
        address proxy = deployProxy(impl, abi.encodeCall(ChainRegistry.initialize, (owner)));
        registry = ChainRegistry(proxy);
    }

    /// @dev Build a config with at least one PUBLIC field non-zero so the round-trip fuzzes assert a
    ///      meaningful struct (not the bare registration marker). Post-L-6 the registry registers
    ///      every add regardless of `cfg`, so this is a fixture-shaping convenience, not an existence
    ///      requirement (the all-zero-add corner has its own test, `testFuzz_exists_addAlwaysRegisters`).
    function _nonDefault(address u, address r, uint64 sel, uint16 f)
        internal
        pure
        returns (ChainRegistry.ChainConfig memory cfg)
    {
        cfg = ChainRegistry.ChainConfig({ usdc: u, router: r, ccipSelector: sel, flags: f });
        // If the fuzzer handed us the all-zero struct, set FLAG_TESTNET so the fixture is non-trivial.
        if (u == address(0) && r == address(0) && sel == 0 && f == 0) {
            cfg.flags = FLAG_TESTNET;
        }
    }

    /*//////////////////////////////////////////////////////////////
                       addChain — STORAGE ROUND-TRIP
    //////////////////////////////////////////////////////////////*/

    /// @notice PROPERTY: `addChain` is a faithful upsert — for ANY chainId and ANY non-default config,
    ///         the four fields read back through both the public `chains` mapping getter AND `getChain`
    ///         byte-for-byte, with no truncation, reordering, or cross-field contamination. This is the
    ///         "a write is exactly what you wrote" property across the full input space.
    function testFuzz_addChain_roundTripsThroughBothGetters(
        uint256 chainId,
        address u,
        address r,
        uint64 sel,
        uint16 f
    ) public {
        ChainRegistry.ChainConfig memory cfg = _nonDefault(u, r, sel, f);

        vm.prank(owner);
        registry.addChain(chainId, cfg);

        // The non-flag fields round-trip verbatim; flags round-trip plus the registration marker.
        uint16 expectedFlags = cfg.flags | FLAG_REGISTERED;

        // getChain view path.
        ChainRegistry.ChainConfig memory got = registry.getChain(chainId);
        assertEq(got.usdc, cfg.usdc, "usdc must round-trip");
        assertEq(got.router, cfg.router, "router must round-trip");
        assertEq(got.ccipSelector, cfg.ccipSelector, "ccipSelector must round-trip");
        assertEq(got.flags, expectedFlags, "flags must round-trip with registration marker");

        // The public auto-generated `chains` getter returns the same tuple (same storage).
        (address pu, address pr, uint64 psel, uint16 pf) = registry.chains(chainId);
        assertEq(pu, cfg.usdc, "public getter usdc must match");
        assertEq(pr, cfg.router, "public getter router must match");
        assertEq(psel, cfg.ccipSelector, "public getter selector must match");
        assertEq(pf, expectedFlags, "public getter flags must match");
    }

    /// @notice PROPERTY: the LAST write wins for a given id. A second `addChain` to the same id fully
    ///         replaces the first config (it is an upsert, not a merge) — no field of the old config
    ///         survives unless the new config repeats it. Fuzzed over two independent configs.
    function testFuzz_addChain_upsertIsLastWriteWins(
        uint256 chainId,
        address u1,
        uint64 sel1,
        uint16 f1,
        address u2,
        address r2,
        uint64 sel2,
        uint16 f2
    ) public {
        ChainRegistry.ChainConfig memory first = _nonDefault(u1, address(0), sel1, f1);
        ChainRegistry.ChainConfig memory second = _nonDefault(u2, r2, sel2, f2);

        vm.startPrank(owner);
        registry.addChain(chainId, first);
        registry.addChain(chainId, second);
        vm.stopPrank();

        ChainRegistry.ChainConfig memory got = registry.getChain(chainId);
        assertEq(got.usdc, second.usdc, "upsert must overwrite usdc");
        assertEq(got.router, second.router, "upsert must overwrite router");
        assertEq(got.ccipSelector, second.ccipSelector, "upsert must overwrite selector");
        // The second write's flags win, carrying the registration marker addChain forces on.
        assertEq(got.flags, second.flags | FLAG_REGISTERED, "upsert must overwrite flags");
    }

    /// @notice PROPERTY: `addChain` is owner-gated for EVERY non-owner caller. Fuzzing the caller
    ///         proves the gate is universal, not just rejecting one hard-coded stranger.
    function testFuzz_addChain_revertsForAnyNonOwner(address caller, uint256 chainId) public {
        vm.assume(caller != owner);
        ChainRegistry.ChainConfig memory cfg = _nonDefault(address(0), address(0), 0, FLAG_TESTNET);

        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        registry.addChain(chainId, cfg);
    }

    /*//////////////////////////////////////////////////////////////
                  _exists SENTINEL — THE FOUND/NOT-FOUND EDGE
    //////////////////////////////////////////////////////////////*/

    /// @notice PROPERTY (L-6 fixed boundary): existence is decided SOLELY by {FLAG_REGISTERED}, which
    ///         `addChain` always ORs in — so ANY add makes the entry found, even an all-zero `cfg`.
    ///         For any config (including the all-zero one) `getChain` returns and reads back the input
    ///         flags with the registration marker set; the registry never deletes-by-write. Fuzzing
    ///         all four fields, including the all-zero corner that USED to collapse to "not found",
    ///         pins the new boundary. (A never-added id reverting is covered by
    ///         `testFuzz_getChain_unknownIdReverts`.)
    function testFuzz_exists_addAlwaysRegisters(
        uint256 chainId,
        address u,
        address r,
        uint64 sel,
        uint16 f
    ) public {
        ChainRegistry.ChainConfig memory cfg = ChainRegistry.ChainConfig({
            usdc: u, router: r, ccipSelector: sel, flags: f
        });

        vm.prank(owner);
        registry.addChain(chainId, cfg);

        // Found for every input — the all-zero cfg no longer vanishes (the L-6 fix).
        ChainRegistry.ChainConfig memory got = registry.getChain(chainId);
        assertEq(got.usdc, u, "usdc round-trips");
        assertEq(got.router, r, "router round-trips");
        assertEq(got.ccipSelector, sel, "selector round-trips");
        assertEq(
            got.flags, f | FLAG_REGISTERED, "found entry reads its flags + registration marker"
        );
        // The registration marker is always present after an add, so _exists is satisfied.
        assertTrue(got.flags & FLAG_REGISTERED != 0, "every added entry is registered");
    }

    /*//////////////////////////////////////////////////////////////
                       getChain — UNKNOWN-ID READS
    //////////////////////////////////////////////////////////////*/

    /// @notice PROPERTY: reading ANY never-added id reverts `ChainRegistry__ChainNotFound(chainId)`
    ///         with that exact id in the error. A fresh registry was just deployed, so every id is
    ///         unknown — fuzzing the id proves the revert is universal and carries the right argument.
    function testFuzz_getChain_unknownIdReverts(uint256 chainId) public {
        vm.expectRevert(
            abi.encodeWithSelector(ChainRegistry.ChainRegistry__ChainNotFound.selector, chainId)
        );
        registry.getChain(chainId);
    }

    /*//////////////////////////////////////////////////////////////
                       isLive — VIEW HELPER (NO REVERT)
    //////////////////////////////////////////////////////////////*/

    /// @notice PROPERTY: `isLive` is a pure read of bit 0 — it NEVER reverts (even on an unknown id),
    ///         and it is true iff `flags & FLAG_LIVE != 0`. Fuzzing the flags word proves the helper
    ///         agrees with the bit-mask definition for every possible flag combination, and that a junk
    ///         high bit cannot make a non-live chain read live.
    function testFuzz_isLive_matchesBitZero(uint256 chainId, uint16 f) public {
        // Force the entry to exist regardless of f (so the test is about the bit math, not existence).
        ChainRegistry.ChainConfig memory cfg = ChainRegistry.ChainConfig({
            usdc: makeAddr("u"), router: address(0), ccipSelector: 0, flags: f
        });
        vm.prank(owner);
        registry.addChain(chainId, cfg);

        bool expected = (f & FLAG_LIVE) != 0;
        assertEq(registry.isLive(chainId), expected, "isLive must equal flags-bit-0");
    }

    /// @notice PROPERTY: `isLive` returns false for ANY never-added id, with no revert — it is the
    ///         caller-friendly read (vs. getChain's revert). Fuzzed over arbitrary unknown ids.
    function testFuzz_isLive_unknownIdIsFalseNoRevert(uint256 chainId) public view {
        assertFalse(registry.isLive(chainId), "unknown id must read not-live, never revert");
    }

    /*//////////////////////////////////////////////////////////////
              setChainLive — ONLY BIT 0 MOVES, AND IDEMPOTENCE
    //////////////////////////////////////////////////////////////*/

    /// @notice PROPERTY: `setChainLive` mutates ONLY bit 0. For any seed flags and any target state,
    ///         every non-live bit is byte-identical before and after, and bit 0 equals the requested
    ///         state. This is the per-call "surgical toggle" property across the whole flags space.
    function testFuzz_setChainLive_movesOnlyLiveBit(uint256 chainId, uint16 seedFlags, bool live)
        public
    {
        // Seed must make the entry exist; OR in FLAG_TESTNET so even seedFlags==0 is a real add.
        uint16 seed = seedFlags | FLAG_TESTNET;
        ChainRegistry.ChainConfig memory cfg = ChainRegistry.ChainConfig({
            usdc: address(0), router: address(0), ccipSelector: 0, flags: seed
        });
        vm.startPrank(owner);
        registry.addChain(chainId, cfg);
        registry.setChainLive(chainId, live);
        vm.stopPrank();

        uint16 after_ = registry.getChain(chainId).flags;
        // Non-live bits are untouched — including the registration marker addChain forced on.
        uint16 storedNonLive = (seed | FLAG_REGISTERED) & ~FLAG_LIVE;
        assertEq(after_ & ~FLAG_LIVE, storedNonLive, "non-live bits must be preserved");
        // Live bit reflects the request exactly.
        assertEq(after_ & FLAG_LIVE, live ? FLAG_LIVE : uint16(0), "live bit must match request");
        assertEq(registry.isLive(chainId), live, "isLive must agree with setChainLive");
    }

    /// @notice PROPERTY: `setChainLive` is IDEMPOTENT — calling it twice with the same target leaves
    ///         the same flags as calling it once. (`|=` / `&= ~` are idempotent bit ops.) Fuzzed over
    ///         seed flags and the target state.
    function testFuzz_setChainLive_isIdempotent(uint256 chainId, uint16 seedFlags, bool live)
        public
    {
        uint16 seed = seedFlags | FLAG_TESTNET;
        ChainRegistry.ChainConfig memory cfg = ChainRegistry.ChainConfig({
            usdc: address(0), router: address(0), ccipSelector: 0, flags: seed
        });
        vm.startPrank(owner);
        registry.addChain(chainId, cfg);
        registry.setChainLive(chainId, live);
        uint16 once = registry.getChain(chainId).flags;
        registry.setChainLive(chainId, live);
        uint16 twice = registry.getChain(chainId).flags;
        vm.stopPrank();
        assertEq(once, twice, "a repeated same-state toggle must be a no-op on the flags");
    }

    /// @notice PROPERTY: `setChainLive` is owner-gated for EVERY non-owner caller, even on an existing
    ///         entry (the owner check precedes any state change). Fuzzed over the caller.
    function testFuzz_setChainLive_revertsForAnyNonOwner(address caller, uint256 chainId) public {
        vm.assume(caller != owner);
        // Seed the entry as the owner so the failure is the OWNER gate, not ChainNotFound.
        ChainRegistry.ChainConfig memory cfg = ChainRegistry.ChainConfig({
            usdc: makeAddr("u"), router: address(0), ccipSelector: 0, flags: FLAG_TESTNET
        });
        vm.prank(owner);
        registry.addChain(chainId, cfg);

        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        registry.setChainLive(chainId, true);
    }

    /// @notice PROPERTY: `setChainLive` on a never-added id reverts `ChainNotFound(chainId)` for ANY
    ///         id — the existence guard fires before the bit flip. Fuzzed over unknown ids (registry
    ///         is fresh, so every id is unknown).
    function testFuzz_setChainLive_unknownIdReverts(uint256 chainId, bool live) public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ChainRegistry.ChainRegistry__ChainNotFound.selector, chainId)
        );
        registry.setChainLive(chainId, live);
    }

    /*//////////////////////////////////////////////////////////////
                   CROSS-ID INDEPENDENCE (NO ALIASING)
    //////////////////////////////////////////////////////////////*/

    /// @notice PROPERTY: two DISTINCT chain ids are fully independent storage slots — writing one never
    ///         disturbs the other, in either field values or the live flag. Fuzzing both ids and both
    ///         configs proves the mapping never aliases two keys (the SDK reads each id in isolation).
    function testFuzz_distinctIds_doNotAlias(uint256 idA, uint256 idB, uint16 flagsA, uint16 flagsB)
        public
    {
        vm.assume(idA != idB);
        ChainRegistry.ChainConfig memory cfgA = ChainRegistry.ChainConfig({
            usdc: makeAddr("usdcA"),
            router: makeAddr("routerA"),
            ccipSelector: 11,
            flags: flagsA | FLAG_TESTNET
        });
        ChainRegistry.ChainConfig memory cfgB = ChainRegistry.ChainConfig({
            usdc: makeAddr("usdcB"),
            router: makeAddr("routerB"),
            ccipSelector: 22,
            flags: flagsB | FLAG_TESTNET
        });

        vm.startPrank(owner);
        registry.addChain(idA, cfgA);
        registry.addChain(idB, cfgB);
        // Toggle A's live bit; B must be unaffected.
        registry.setChainLive(idA, true);
        vm.stopPrank();

        ChainRegistry.ChainConfig memory gotA = registry.getChain(idA);
        ChainRegistry.ChainConfig memory gotB = registry.getChain(idB);

        // A is exactly cfgA plus the registration marker plus the live bit; B is cfgA-untouched.
        assertEq(gotA.usdc, cfgA.usdc, "A.usdc isolated");
        assertEq(
            gotA.flags,
            (flagsA | FLAG_TESTNET) | FLAG_REGISTERED | FLAG_LIVE,
            "A flags = cfgA | registered | live"
        );
        assertEq(gotB.usdc, cfgB.usdc, "B.usdc isolated");
        assertEq(
            gotB.flags, (flagsB | FLAG_TESTNET) | FLAG_REGISTERED, "B flags untouched by A's writes"
        );
        assertTrue(registry.isLive(idA), "A is live");
        assertEq(
            registry.isLive(idB), ((flagsB | FLAG_TESTNET) & FLAG_LIVE) != 0, "B liveness intact"
        );
    }
}
