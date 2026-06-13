// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ChainRegistry } from "../../src/ChainRegistry.sol";

/// @notice Adversarial suite for ChainRegistry. The registry holds NO assets — it is owner-gated
///         config storage the SDK/frontend/CCIP sender read — so the threat model is (1) ADMIN ABUSE:
///         a non-owner mutating chain facts, or seizing ownership; and (2) FLAG / ENTRY CORRUPTION:
///         malformed writes that desync `_exists`, clobber the live bit, or smuggle undocumented flag
///         bits. A passing test means the abuse is REJECTED or the corruption is contained/observable.
contract ChainRegistryAttackTest is Test {
    ChainRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal attacker = makeAddr("attacker");

    address internal usdc = makeAddr("usdc");
    address internal router = makeAddr("router");

    uint16 internal constant FLAG_LIVE = 0x0001;
    uint16 internal constant FLAG_CIRCLE_USDC = 0x0002;
    uint16 internal constant FLAG_CCIP_LANE = 0x0004;
    uint16 internal constant FLAG_TESTNET = 0x0008;

    uint256 internal constant BASE_SEPOLIA = 84_532;
    uint256 internal constant ARC_TESTNET = 5_042_002;

    function setUp() public {
        registry = new ChainRegistry(owner);
    }

    function _cfg(uint16 flags) internal view returns (ChainRegistry.ChainConfig memory) {
        return
            ChainRegistry.ChainConfig({
                usdc: usdc, router: router, ccipSelector: 1234, flags: flags
            });
    }

    /*//////////////////////////////////////////////////////////////
                            ATTACK: ADMIN ABUSE
    //////////////////////////////////////////////////////////////*/

    /// @dev An attacker cannot add or upsert a chain entry — only the owner may write config.
    function test_attack_nonOwnerCannotAddChain() public {
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker)
        );
        registry.addChain(BASE_SEPOLIA, _cfg(FLAG_TESTNET));
    }

    /// @dev An attacker cannot flip a chain's live bit — they could otherwise route to a chain the
    ///      operator has not vetted, or kill a live chain (griefing).
    function test_attack_nonOwnerCannotSetChainLive() public {
        vm.prank(owner);
        registry.addChain(BASE_SEPOLIA, _cfg(FLAG_TESTNET));

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker)
        );
        registry.setChainLive(BASE_SEPOLIA, true);
    }

    /// @dev An attacker cannot seize ownership by calling transferOwnership; and even a real pending
    ///      transfer is two-step, so a stranger cannot accept it.
    function test_attack_ownershipHijack_rejected() public {
        // Direct hijack attempt.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker)
        );
        registry.transferOwnership(attacker);

        // Owner starts a transfer to a legit address; the attacker cannot accept it for themselves.
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        registry.transferOwnership(newOwner);
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker)
        );
        registry.acceptOwnership();
        assertEq(registry.owner(), owner); // unchanged until the real pending owner accepts
    }

    /// @dev Transferring to the zero address under Ownable2Step is harmless: it merely sets a zero
    ///      pending owner (which nobody can accept), and the current owner KEEPS control — there is no
    ///      window where the registry is ownerless or seizable. (Two-step is exactly what prevents a
    ///      fat-fingered zero transfer from stranding the contract, unlike one-step Ownable.)
    function test_attack_transferToZero_ownerKeepsControl() public {
        vm.prank(owner);
        registry.transferOwnership(address(0));

        // Owner unchanged; pending is zero — no one can accept it.
        assertEq(registry.owner(), owner);
        assertEq(registry.pendingOwner(), address(0));

        // The attacker still cannot accept ownership.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker)
        );
        registry.acceptOwnership();

        // And the owner can still administer the registry.
        vm.prank(owner);
        registry.addChain(BASE_SEPOLIA, _cfg(FLAG_TESTNET));
        assertEq(registry.getChain(BASE_SEPOLIA).flags, FLAG_TESTNET);
    }

    /*//////////////////////////////////////////////////////////////
                       ATTACK: FLAG / ENTRY CORRUPTION
    //////////////////////////////////////////////////////////////*/

    /// @dev FLAG CORRUPTION via all-zero upsert. `_exists` treats the all-zero entry as "never added",
    ///      so writing a fully-zero config leaves the entry INVISIBLE: getChain/setChainLive revert
    ///      ChainNotFound even though addChain "succeeded". This is the documented `_exists` sentinel
    ///      contract — proven here so the SDK never relies on a zero-config entry being readable.
    function test_attack_allZeroUpsert_isInvisible() public {
        ChainRegistry.ChainConfig memory zero = ChainRegistry.ChainConfig({
            usdc: address(0), router: address(0), ccipSelector: 0, flags: 0
        });
        vm.prank(owner);
        registry.addChain(BASE_SEPOLIA, zero); // "succeeds" but writes the all-zero sentinel

        // The entry reads back as not-found everywhere that depends on _exists.
        vm.expectRevert(
            abi.encodeWithSelector(
                ChainRegistry.ChainRegistry__ChainNotFound.selector, BASE_SEPOLIA
            )
        );
        registry.getChain(BASE_SEPOLIA);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ChainRegistry.ChainRegistry__ChainNotFound.selector, BASE_SEPOLIA
            )
        );
        registry.setChainLive(BASE_SEPOLIA, true);

        assertFalse(registry.isLive(BASE_SEPOLIA)); // view helper: false, no revert
    }

    /// @dev An upsert cannot be used to flip another chain's facts: writes are keyed by chainId, so a
    ///      malformed write to one id never bleeds into another id's slot.
    function test_attack_upsert_doesNotBleedAcrossChainIds() public {
        vm.startPrank(owner);
        registry.addChain(BASE_SEPOLIA, _cfg(FLAG_TESTNET | FLAG_LIVE));
        // Overwrite a DIFFERENT chain with attacker-favorable junk.
        registry.addChain(ARC_TESTNET, _cfg(FLAG_TESTNET | FLAG_CCIP_LANE));
        vm.stopPrank();

        // BASE_SEPOLIA is untouched.
        ChainRegistry.ChainConfig memory base = registry.getChain(BASE_SEPOLIA);
        assertEq(base.flags, FLAG_TESTNET | FLAG_LIVE);
        assertTrue(registry.isLive(BASE_SEPOLIA));
        // ARC is its own entry.
        assertFalse(registry.isLive(ARC_TESTNET));
    }

    /// @dev A re-upsert that CLEARS the live bit must actually take a live chain offline (no stale
    ///      "live" read), and setChainLive(true) afterwards must bring it back precisely. Proves the
    ///      live flag cannot be corrupted into a stuck state via the upsert path.
    function test_attack_upsertCannotStrandLiveFlag() public {
        vm.startPrank(owner);
        registry.addChain(BASE_SEPOLIA, _cfg(FLAG_TESTNET | FLAG_LIVE));
        assertTrue(registry.isLive(BASE_SEPOLIA));

        // Upsert with the live bit cleared — the chain must read as offline immediately.
        registry.addChain(BASE_SEPOLIA, _cfg(FLAG_TESTNET));
        assertFalse(registry.isLive(BASE_SEPOLIA));

        // And the targeted toggle restores exactly the live bit, nothing else.
        registry.setChainLive(BASE_SEPOLIA, true);
        vm.stopPrank();
        assertEq(registry.getChain(BASE_SEPOLIA).flags, FLAG_TESTNET | FLAG_LIVE);
    }

    /// @dev Undocumented high flag bits a caller smuggles in are stored verbatim but never satisfy the
    ///      `isLive` check (only bit 0 is FLAG_LIVE), so junk flags cannot forge a "live" chain.
    function testFuzz_attack_junkFlagsNeverForgeLive(uint16 junk) public {
        // Clear bit 0 so the only way isLive can be true is the real FLAG_LIVE, not the junk. The
        // entry still exists for getChain because `_cfg` sets a non-zero usdc/router/selector.
        uint16 flagsNoLive = junk & ~FLAG_LIVE;
        vm.prank(owner);
        registry.addChain(BASE_SEPOLIA, _cfg(flagsNoLive));
        assertFalse(registry.isLive(BASE_SEPOLIA), "no junk flag may forge a live chain");
        assertEq(registry.getChain(BASE_SEPOLIA).flags, flagsNoLive); // stored verbatim
    }
}
