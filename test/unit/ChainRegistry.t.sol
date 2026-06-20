// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ChainRegistry } from "../../src/ChainRegistry.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @notice Test-only harness that surfaces the registry's `internal` flag constants so the suite can
///         assert their exact bit values. Adds no behaviour; the constants live on `ChainRegistry`
///         and are merely re-exported here. Deployed as a logic implementation and driven behind a
///         proxy exactly like the production contract (its inherited constructor disables initializers).
contract ChainRegistryHarness is ChainRegistry {
    function FLAG_LIVE_() external pure returns (uint16) {
        return FLAG_LIVE;
    }

    function FLAG_CIRCLE_USDC_() external pure returns (uint16) {
        return FLAG_CIRCLE_USDC;
    }

    function FLAG_CCIP_LANE_() external pure returns (uint16) {
        return FLAG_CCIP_LANE;
    }

    function FLAG_TESTNET_() external pure returns (uint16) {
        return FLAG_TESTNET;
    }

    function FLAG_REGISTERED_() external pure returns (uint16) {
        return FLAG_REGISTERED;
    }
}

/// @notice A trivial v2 implementation used by the upgrade test: a {ChainRegistryHarness} subclass that
///         adds one view function and changes nothing else, so an upgrade to it must preserve all prior
///         state. It deliberately carries no new storage (it would consume from `__gap` if it did),
///         proving the proxy keeps every slot across the implementation swap.
contract ChainRegistryHarnessV2 is ChainRegistryHarness {
    /// @notice A marker the original implementation does not expose — lets the test prove the new logic
    ///         is live after {upgradeToAndCall}.
    /// @return The constant string identifying this as the v2 implementation.
    function version2Marker() external pure returns (string memory) {
        return "v2";
    }
}

/// @notice ChainRegistry unit suite — the sidecar chain hash-map: upsert, the targeted live bit
///         flip, found/not-found reads, the flag constants, two-step ownership, and round-trip fuzz.
///         The registry is deployed BEHIND a UUPS proxy (deploy impl → `ERC1967Proxy` with
///         `initialize(...)` calldata → cast the proxy to the type) via the shared {ProxyDeployer}, so
///         every behavioural test exercises the production proxy↔impl shape. No money path here; every
///         write is owner-gated config, every read is pure storage. Tail tests cover the UUPS upgrade +
///         the permanent freeze via `renounceOwnership`.
contract ChainRegistryTest is Test, ProxyDeployer {
    ChainRegistryHarness internal registry;

    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");

    // Booth/docs-confirmed values are filled at deploy; these are test fixtures only.
    address internal usdc = makeAddr("usdc");
    address internal router = makeAddr("router");

    uint16 internal constant FLAG_LIVE = 0x0001;
    uint16 internal constant FLAG_CIRCLE_USDC = 0x0002;
    uint16 internal constant FLAG_CCIP_LANE = 0x0004;
    uint16 internal constant FLAG_TESTNET = 0x0008;
    // The reserved registration marker (bit 15) addChain always ORs in; stored flags carry it.
    uint16 internal constant FLAG_REGISTERED = 0x8000;

    uint256 internal constant ARC_TESTNET = 5_042_002;
    uint256 internal constant BASE_SEPOLIA = 84_532;
    uint256 internal constant ZKSYNC_SEPOLIA = 300;

    event ChainAdded(uint256 indexed chainId, ChainRegistry.ChainConfig cfg);
    event ChainLiveSet(uint256 indexed chainId, bool live);

    function setUp() public {
        // Deploy the implementation, then the ERC1967 proxy that initializes it, then drive the proxy.
        address impl = address(new ChainRegistryHarness());
        address proxy = deployProxy(impl, abi.encodeCall(ChainRegistry.initialize, (owner)));
        registry = ChainRegistryHarness(proxy);
    }

    function _cfg(uint16 flags) internal view returns (ChainRegistry.ChainConfig memory) {
        return
            ChainRegistry.ChainConfig({
                usdc: usdc, router: router, ccipSelector: 1234, flags: flags
            });
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_constructor_setsOwner() public view {
        assertEq(registry.owner(), owner);
    }

    /*//////////////////////////////////////////////////////////////
                               addChain
    //////////////////////////////////////////////////////////////*/

    function test_addChain_success_emitsChainAdded() public {
        ChainRegistry.ChainConfig memory cfg = _cfg(FLAG_TESTNET);
        // addChain ORs in FLAG_REGISTERED, so both the stored flags and the emitted event carry it.
        ChainRegistry.ChainConfig memory stored = _cfg(FLAG_TESTNET | FLAG_REGISTERED);

        vm.expectEmit(true, false, false, true, address(registry));
        emit ChainAdded(BASE_SEPOLIA, stored);

        vm.prank(owner);
        registry.addChain(BASE_SEPOLIA, cfg);

        ChainRegistry.ChainConfig memory got = registry.getChain(BASE_SEPOLIA);
        assertEq(got.usdc, usdc);
        assertEq(got.router, router);
        assertEq(got.ccipSelector, 1234);
        assertEq(got.flags, FLAG_TESTNET | FLAG_REGISTERED);
    }

    function test_addChain_canUpsert() public {
        vm.startPrank(owner);
        registry.addChain(BASE_SEPOLIA, _cfg(FLAG_TESTNET));

        ChainRegistry.ChainConfig memory updated = ChainRegistry.ChainConfig({
            usdc: address(0xBEEF),
            router: address(0xCAFE),
            ccipSelector: 9999,
            flags: FLAG_TESTNET | FLAG_CCIP_LANE
        });
        // The event mirrors storage: the upserted flags with the registration bit forced on.
        ChainRegistry.ChainConfig memory updatedStored = ChainRegistry.ChainConfig({
            usdc: address(0xBEEF),
            router: address(0xCAFE),
            ccipSelector: 9999,
            flags: FLAG_TESTNET | FLAG_CCIP_LANE | FLAG_REGISTERED
        });

        vm.expectEmit(true, false, false, true, address(registry));
        emit ChainAdded(BASE_SEPOLIA, updatedStored);
        registry.addChain(BASE_SEPOLIA, updated);
        vm.stopPrank();

        ChainRegistry.ChainConfig memory got = registry.getChain(BASE_SEPOLIA);
        assertEq(got.usdc, address(0xBEEF));
        assertEq(got.router, address(0xCAFE));
        assertEq(got.ccipSelector, 9999);
        assertEq(got.flags, FLAG_TESTNET | FLAG_CCIP_LANE | FLAG_REGISTERED);
    }

    function test_addChain_onlyOwner_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        registry.addChain(BASE_SEPOLIA, _cfg(FLAG_TESTNET));
    }

    function test_addChain_zeroUsdc_allowed() public {
        ChainRegistry.ChainConfig memory cfg = ChainRegistry.ChainConfig({
            usdc: address(0), router: address(0), ccipSelector: 0, flags: FLAG_TESTNET
        });

        vm.prank(owner);
        registry.addChain(ZKSYNC_SEPOLIA, cfg);

        ChainRegistry.ChainConfig memory got = registry.getChain(ZKSYNC_SEPOLIA);
        assertEq(got.usdc, address(0));
        assertEq(got.flags, FLAG_TESTNET | FLAG_REGISTERED);
    }

    function test_addChain_flagBitsPreserved() public {
        uint16 flags = FLAG_LIVE | FLAG_TESTNET;
        vm.prank(owner);
        registry.addChain(BASE_SEPOLIA, _cfg(flags));
        // The caller's public bits are preserved; the registration marker is added on top.
        assertEq(registry.getChain(BASE_SEPOLIA).flags, flags | FLAG_REGISTERED);
    }

    function test_addChain_arcTestnet() public {
        uint16 flags = FLAG_CIRCLE_USDC | FLAG_TESTNET;
        vm.prank(owner);
        registry.addChain(ARC_TESTNET, _cfg(flags));

        ChainRegistry.ChainConfig memory got = registry.getChain(ARC_TESTNET);
        assertEq(got.flags, flags | FLAG_REGISTERED);
        assertTrue(got.flags & FLAG_CIRCLE_USDC != 0);
        assertTrue(got.flags & FLAG_TESTNET != 0);
    }

    /*//////////////////////////////////////////////////////////////
                             setChainLive
    //////////////////////////////////////////////////////////////*/

    function test_setChainLive_flipOn_setsFlag() public {
        vm.startPrank(owner);
        registry.addChain(BASE_SEPOLIA, _cfg(FLAG_TESTNET));

        vm.expectEmit(true, false, false, true, address(registry));
        emit ChainLiveSet(BASE_SEPOLIA, true);
        registry.setChainLive(BASE_SEPOLIA, true);
        vm.stopPrank();

        assertTrue(registry.isLive(BASE_SEPOLIA));
        assertTrue(registry.getChain(BASE_SEPOLIA).flags & FLAG_LIVE != 0);
    }

    function test_setChainLive_flipOff_clearsFlag() public {
        vm.startPrank(owner);
        registry.addChain(BASE_SEPOLIA, _cfg(FLAG_TESTNET | FLAG_LIVE));
        assertTrue(registry.isLive(BASE_SEPOLIA));

        vm.expectEmit(true, false, false, true, address(registry));
        emit ChainLiveSet(BASE_SEPOLIA, false);
        registry.setChainLive(BASE_SEPOLIA, false);
        vm.stopPrank();

        assertFalse(registry.isLive(BASE_SEPOLIA));
        assertEq(registry.getChain(BASE_SEPOLIA).flags & FLAG_LIVE, 0);
    }

    function test_setChainLive_notFound_reverts() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ChainRegistry.ChainRegistry__ChainNotFound.selector, ARC_TESTNET)
        );
        registry.setChainLive(ARC_TESTNET, true);
    }

    function test_setChainLive_onlyOwner_reverts() public {
        vm.prank(owner);
        registry.addChain(BASE_SEPOLIA, _cfg(FLAG_TESTNET));

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        registry.setChainLive(BASE_SEPOLIA, true);
    }

    function test_setChainLive_doesNotMutateOtherBits() public {
        uint16 flags = FLAG_TESTNET | FLAG_CIRCLE_USDC | FLAG_CCIP_LANE;
        // Stored flags always carry the registration marker; setChainLive only moves FLAG_LIVE.
        uint16 stored = flags | FLAG_REGISTERED;
        vm.startPrank(owner);
        registry.addChain(BASE_SEPOLIA, _cfg(flags));

        registry.setChainLive(BASE_SEPOLIA, true);
        assertEq(registry.getChain(BASE_SEPOLIA).flags, stored | FLAG_LIVE);

        registry.setChainLive(BASE_SEPOLIA, false);
        assertEq(registry.getChain(BASE_SEPOLIA).flags, stored);
        vm.stopPrank();
    }

    /// @notice L-6 REGRESSION: pausing a `flags`-only entry must NOT delete it. Before the fix,
    ///         `_exists` tested "any field non-zero", so an entry whose only non-zero field was the
    ///         live bit collapsed to the all-zero sentinel when `setChainLive(.., false)` cleared
    ///         FLAG_LIVE — `getChain`/`setChainLive` then reverted ChainNotFound and `isLive` read
    ///         false: a pause silently destroyed the entry. With FLAG_REGISTERED (set by addChain,
    ///         never cleared by setChainLive) as the sole existence signal, the entry survives the
    ///         pause: getChain still returns it and isLive is false, with no revert.
    function test_setChainLive_off_onLiveOnlyEntry_doesNotDeleteEntry() public {
        // The exact L-6 PoC shape: a config whose only non-zero PUBLIC field is the live bit.
        ChainRegistry.ChainConfig memory liveOnly = ChainRegistry.ChainConfig({
            usdc: address(0), router: address(0), ccipSelector: 0, flags: FLAG_LIVE
        });

        vm.startPrank(owner);
        registry.addChain(BASE_SEPOLIA, liveOnly);
        // Pause it — the historically-deleting call.
        registry.setChainLive(BASE_SEPOLIA, false);
        vm.stopPrank();

        // The entry is STILL found (no ChainNotFound) and reads back not-live.
        ChainRegistry.ChainConfig memory got = registry.getChain(BASE_SEPOLIA);
        assertEq(got.usdc, address(0), "usdc unchanged");
        assertEq(got.router, address(0), "router unchanged");
        assertEq(got.ccipSelector, 0, "selector unchanged");
        // Live bit cleared, registration bit intact — that marker is what keeps the entry alive.
        assertEq(got.flags, FLAG_REGISTERED, "only the registration marker remains");
        assertFalse(registry.isLive(BASE_SEPOLIA), "chain reads not-live after pause");

        // And it is still mutable: re-arming it live works (it never became ChainNotFound).
        vm.prank(owner);
        registry.setChainLive(BASE_SEPOLIA, true);
        assertTrue(registry.isLive(BASE_SEPOLIA), "paused entry can be brought back live");
    }

    /*//////////////////////////////////////////////////////////////
                               getChain
    //////////////////////////////////////////////////////////////*/

    function test_getChain_found_returnsConfig() public {
        ChainRegistry.ChainConfig memory cfg = _cfg(FLAG_TESTNET);
        vm.prank(owner);
        registry.addChain(BASE_SEPOLIA, cfg);

        ChainRegistry.ChainConfig memory got = registry.getChain(BASE_SEPOLIA);
        assertEq(got.usdc, cfg.usdc);
        assertEq(got.router, cfg.router);
        assertEq(got.ccipSelector, cfg.ccipSelector);
        // Stored flags are the caller's plus the registration marker addChain forces on.
        assertEq(got.flags, cfg.flags | FLAG_REGISTERED);
    }

    function test_getChain_notFound_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(ChainRegistry.ChainRegistry__ChainNotFound.selector, ARC_TESTNET)
        );
        registry.getChain(ARC_TESTNET);
    }

    /*//////////////////////////////////////////////////////////////
                                isLive
    //////////////////////////////////////////////////////////////*/

    function test_isLive_liveChain_returnsTrue() public {
        vm.prank(owner);
        registry.addChain(BASE_SEPOLIA, _cfg(FLAG_TESTNET | FLAG_LIVE));
        assertTrue(registry.isLive(BASE_SEPOLIA));
    }

    function test_isLive_notLive_returnsFalse() public {
        vm.prank(owner);
        registry.addChain(BASE_SEPOLIA, _cfg(FLAG_TESTNET));
        assertFalse(registry.isLive(BASE_SEPOLIA));
    }

    function test_isLive_notFound_returnsFalse() public view {
        // Never added → zero-value mapping → false, no revert (it is a view helper).
        assertFalse(registry.isLive(ARC_TESTNET));
    }

    /*//////////////////////////////////////////////////////////////
                            FLAG CONSTANTS
    //////////////////////////////////////////////////////////////*/

    function test_constants_flagValues() public view {
        assertEq(registry.FLAG_LIVE_(), 1);
        assertEq(registry.FLAG_CIRCLE_USDC_(), 2);
        assertEq(registry.FLAG_CCIP_LANE_(), 4);
        assertEq(registry.FLAG_TESTNET_(), 8);
        // The reserved registration marker is the high bit, clear of every documented public bit.
        assertEq(registry.FLAG_REGISTERED_(), 0x8000);
    }

    /// @notice FLAG_REGISTERED (bit 15) must not collide with any documented public flag bit
    ///         (`0x0001`-`0x0008`) — a collision would let a public flag accidentally register an
    ///         entry or let registration masquerade as a public fact. Proves the bit budgets are
    ///         disjoint (the L-6 fix relies on it).
    function test_constants_registeredBitIsDisjointFromPublicBits() public view {
        uint16 publicBits = registry.FLAG_LIVE_() | registry.FLAG_CIRCLE_USDC_()
            | registry.FLAG_CCIP_LANE_() | registry.FLAG_TESTNET_();
        assertEq(registry.FLAG_REGISTERED_() & publicBits, 0, "registration bit must not overlap");
    }

    /*//////////////////////////////////////////////////////////////
                       OWNERSHIP (Ownable2Step)
    //////////////////////////////////////////////////////////////*/

    function test_ownership_twoStep() public {
        address newOwner = makeAddr("newOwner");

        vm.prank(owner);
        registry.transferOwnership(newOwner);

        // Still the old owner until the new one accepts; pending owner is recorded.
        assertEq(registry.owner(), owner);
        assertEq(registry.pendingOwner(), newOwner);

        vm.prank(newOwner);
        registry.acceptOwnership();

        assertEq(registry.owner(), newOwner);
        assertEq(registry.pendingOwner(), address(0));
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    function testFuzz_addChain_roundTrip(
        uint256 chainId,
        address fUsdc,
        address fRouter,
        uint64 fSelector,
        uint16 fFlags
    ) public {
        // Constrain to a non-default entry so the "not found" sentinel never trips for a real add.
        vm.assume(fUsdc != address(0) || fRouter != address(0) || fSelector != 0 || fFlags != 0);

        ChainRegistry.ChainConfig memory cfg = ChainRegistry.ChainConfig({
            usdc: fUsdc, router: fRouter, ccipSelector: fSelector, flags: fFlags
        });

        vm.prank(owner);
        registry.addChain(chainId, cfg);

        ChainRegistry.ChainConfig memory got = registry.getChain(chainId);
        assertEq(got.usdc, fUsdc);
        assertEq(got.router, fRouter);
        assertEq(got.ccipSelector, fSelector);
        // The fuzzed flags round-trip exactly, plus the registration marker addChain forces on.
        assertEq(got.flags, fFlags | FLAG_REGISTERED);
    }

    function testFuzz_setChainLive_onlyBit0Changes(uint16 seedFlags, bool live) public {
        // Seed with the live bit cleared so the non-live bits are a stable baseline.
        uint16 baseline = seedFlags & ~FLAG_LIVE;
        // Ensure the entry exists (a never-added id would revert in setChainLive).
        ChainRegistry.ChainConfig memory cfg = ChainRegistry.ChainConfig({
            usdc: usdc, router: address(0), ccipSelector: 0, flags: baseline | FLAG_TESTNET
        });
        // Stored non-live bits = the baseline plus the registration marker addChain forces on.
        uint16 expectedBase = baseline | FLAG_TESTNET | FLAG_REGISTERED;

        vm.startPrank(owner);
        registry.addChain(BASE_SEPOLIA, cfg);
        registry.setChainLive(BASE_SEPOLIA, live);
        vm.stopPrank();

        uint16 after_ = registry.getChain(BASE_SEPOLIA).flags;
        // Every non-live bit is identical to the baseline.
        assertEq(after_ & ~FLAG_LIVE, expectedBase & ~FLAG_LIVE);
        // The live bit matches the requested state.
        assertEq(after_ & FLAG_LIVE, live ? FLAG_LIVE : uint16(0));
    }

    /*//////////////////////////////////////////////////////////////
                          UUPS UPGRADE / FREEZE
    //////////////////////////////////////////////////////////////*/

    function test_initialize_revertOnSecondCall() public {
        // The proxy was already initialized in setUp; a second call must revert (one-time initializer).
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        registry.initialize(owner);
    }

    function test_upgrade_preservesStateAndAddsFn() public {
        // Seed state under the v1 implementation: a registered, live chain entry.
        vm.startPrank(owner);
        registry.addChain(BASE_SEPOLIA, _cfg(FLAG_TESTNET | FLAG_LIVE));
        vm.stopPrank();

        // The owner (upgrade admin) upgrades the proxy to v2.
        address v2 = address(new ChainRegistryHarnessV2());
        vm.prank(owner);
        UUPSUpgradeable(address(registry)).upgradeToAndCall(v2, "");

        // The new logic is live...
        assertEq(ChainRegistryHarnessV2(address(registry)).version2Marker(), "v2");

        // ...and ALL prior state survived the implementation swap (storage lives in the proxy).
        ChainRegistry.ChainConfig memory got = registry.getChain(BASE_SEPOLIA);
        assertEq(got.usdc, usdc);
        assertEq(got.router, router);
        assertEq(got.ccipSelector, 1234);
        assertEq(got.flags, FLAG_TESTNET | FLAG_LIVE | FLAG_REGISTERED);
        assertTrue(registry.isLive(BASE_SEPOLIA));
        assertEq(registry.owner(), owner); // upgrade admin unchanged
    }

    function test_upgrade_revertNonOwner() public {
        address v2 = address(new ChainRegistryHarnessV2());
        // A non-owner cannot upgrade — _authorizeUpgrade is onlyOwner.
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        UUPSUpgradeable(address(registry)).upgradeToAndCall(v2, "");
    }

    function test_freeze_renounceOwnershipBlocksUpgradeForever() public {
        // The owner renounces ownership: the upgrade admin becomes address(0).
        vm.prank(owner);
        registry.renounceOwnership();
        assertEq(registry.owner(), address(0));

        // With no owner, _authorizeUpgrade reverts for EVERYONE — the implementation is frozen forever.
        address v2 = address(new ChainRegistryHarnessV2());
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        UUPSUpgradeable(address(registry)).upgradeToAndCall(v2, "");
    }
}
