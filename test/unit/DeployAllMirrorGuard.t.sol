// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { DeployAll } from "../../script/DeployAll.s.sol";

/// @notice Unit-tests the opt-in mirror-deployer guard (`DeployAll._assertCanonicalDeployer`): the rail
///         that stops a real mirror deploy signed by the WRONG key from silently landing at a different,
///         undocumented CREATE3 address set than the published `script/mirror-manifest.json`.
/// @dev    Tested via a harness, NOT a live `run()`, on purpose: `ENFORCE_MIRROR_DEPLOYER` is a GLOBAL
///         env key EVERY `run()` reads, and Foundry runs test contracts in parallel over the shared OS
///         env (see the note in DeployAll.t.sol). Driving it through `vm.setEnv` would race the
///         `DeployAllTest` parallel `run()` calls and make THEM flaky. The guard is pure + signer-
///         injected, so the harness exercises every branch deterministically with zero global state.
contract GuardHarness is DeployAll {
    /// @dev Thin external wrapper so a test can call the internal guard directly.
    function check(bool enforce, address mirrorDeployer, address signer) external pure {
        _assertCanonicalDeployer(enforce, mirrorDeployer, signer);
    }
}

contract DeployAllMirrorGuardTest is Test {
    GuardHarness private harness;

    /// @dev The canonical mirror deployer EOA the manifest + the proven Router proxy were computed for.
    address private constant CANONICAL = 0xA121e1eF31BbF0826aa67dc01e7977e80Af58D73;

    function setUp() public {
        harness = new GuardHarness();
    }

    /// REVERT path: enforcing + a signer that is NOT the configured mirror deployer → loud revert,
    /// so a wrong-key mirror deploy can never silently diverge from the manifest.
    function test_guard_revertsOnWrongSignerWhenEnforced() public {
        vm.expectRevert(bytes("DeployAll: signer != canonical mirror EOA"));
        harness.check(true, CANONICAL, makeAddr("wrongSigner"));
    }

    /// PASS path: enforcing + the signer IS the configured mirror deployer → no revert, deploy proceeds.
    function test_guard_passesOnMatchingSignerWhenEnforced() public view {
        harness.check(true, CANONICAL, CANONICAL); // must not revert
    }

    /// DEFAULT-OFF: the flag unset/false accepts ANY signer (local/test + ad-hoc testnet experiments are
    /// unaffected) — the rail is loud-but-OPTIONAL, never a hard block.
    function test_guard_offByDefaultAcceptsAnySigner() public {
        harness.check(false, CANONICAL, makeAddr("anyoneElse")); // must not revert despite signer != canonical
    }
}
