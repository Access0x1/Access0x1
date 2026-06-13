// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ChainRegistry } from "../../src/ChainRegistry.sol";

/// @notice Test-only harness that surfaces the registry's `internal` flag constants so the suite can
///         assert their exact bit values. Adds no behaviour; the constants live on `ChainRegistry`
///         and are merely re-exported here.
contract ChainRegistryHarness is ChainRegistry {
    constructor(address initialOwner) ChainRegistry(initialOwner) { }

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
}

/// @notice ChainRegistry unit suite — the sidecar chain hash-map: upsert, the targeted live bit
///         flip, found/not-found reads, the flag constants, two-step ownership, and round-trip fuzz.
///         No money path here; every write is owner-gated config, every read is pure storage.
contract ChainRegistryTest is Test {
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

    uint256 internal constant ARC_TESTNET = 5_042_002;
    uint256 internal constant BASE_SEPOLIA = 84_532;
    uint256 internal constant ZKSYNC_SEPOLIA = 300;

    event ChainAdded(uint256 indexed chainId, ChainRegistry.ChainConfig cfg);
    event ChainLiveSet(uint256 indexed chainId, bool live);

    function setUp() public {
        registry = new ChainRegistryHarness(owner);
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

        vm.expectEmit(true, false, false, true, address(registry));
        emit ChainAdded(BASE_SEPOLIA, cfg);

        vm.prank(owner);
        registry.addChain(BASE_SEPOLIA, cfg);

        ChainRegistry.ChainConfig memory got = registry.getChain(BASE_SEPOLIA);
        assertEq(got.usdc, usdc);
        assertEq(got.router, router);
        assertEq(got.ccipSelector, 1234);
        assertEq(got.flags, FLAG_TESTNET);
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

        vm.expectEmit(true, false, false, true, address(registry));
        emit ChainAdded(BASE_SEPOLIA, updated);
        registry.addChain(BASE_SEPOLIA, updated);
        vm.stopPrank();

        ChainRegistry.ChainConfig memory got = registry.getChain(BASE_SEPOLIA);
        assertEq(got.usdc, address(0xBEEF));
        assertEq(got.router, address(0xCAFE));
        assertEq(got.ccipSelector, 9999);
        assertEq(got.flags, FLAG_TESTNET | FLAG_CCIP_LANE);
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
        assertEq(got.flags, FLAG_TESTNET);
    }

    function test_addChain_flagBitsPreserved() public {
        uint16 flags = FLAG_LIVE | FLAG_TESTNET;
        vm.prank(owner);
        registry.addChain(BASE_SEPOLIA, _cfg(flags));
        assertEq(registry.getChain(BASE_SEPOLIA).flags, flags);
    }

    function test_addChain_arcTestnet() public {
        uint16 flags = FLAG_CIRCLE_USDC | FLAG_TESTNET;
        vm.prank(owner);
        registry.addChain(ARC_TESTNET, _cfg(flags));

        ChainRegistry.ChainConfig memory got = registry.getChain(ARC_TESTNET);
        assertEq(got.flags, flags);
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
        vm.startPrank(owner);
        registry.addChain(BASE_SEPOLIA, _cfg(flags));

        registry.setChainLive(BASE_SEPOLIA, true);
        assertEq(registry.getChain(BASE_SEPOLIA).flags, flags | FLAG_LIVE);

        registry.setChainLive(BASE_SEPOLIA, false);
        assertEq(registry.getChain(BASE_SEPOLIA).flags, flags);
        vm.stopPrank();
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
        assertEq(got.flags, cfg.flags);
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
        assertEq(got.flags, fFlags);
    }

    function testFuzz_setChainLive_onlyBit0Changes(uint16 seedFlags, bool live) public {
        // Seed with the live bit cleared so the non-live bits are a stable baseline.
        uint16 baseline = seedFlags & ~FLAG_LIVE;
        // Ensure the entry exists (a never-added id would revert in setChainLive).
        ChainRegistry.ChainConfig memory cfg = ChainRegistry.ChainConfig({
            usdc: usdc, router: address(0), ccipSelector: 0, flags: baseline | FLAG_TESTNET
        });
        uint16 expectedBase = baseline | FLAG_TESTNET;

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
}
