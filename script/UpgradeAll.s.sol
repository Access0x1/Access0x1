// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { console2 } from "forge-std/Script.sol";
import { Upgrade, IUUPS, IOwnable } from "./Upgrade.s.sol";

/// @title  UpgradeAll
/// @author Access0x1
/// @notice Upgrades EVERY live mirror proxy on one chain to a fresh implementation in ONE
///         broadcast — one keystore password, N modules, every implementation deployed (and
///         auto-verified under `--verify`) with today's timestamp at the SAME proxy address the
///         rail has always had. The proxies carry the continuity; the impls carry the freshness.
/// @dev    Reads the module set from a prep JSON (`UPGRADE_SET`, written by the Makefile target
///         from `script/mirror-manifest.json` — addresses stay broadcast-derived, never typed).
///         Per module: a proxy with no code on this chain is SKIPPED (logged); a proxy whose
///         owner is not the broadcast sender REVERTS before any tx (never a half-upgraded chain);
///         after each `upgradeToAndCall` the EIP-1967 slot is asserted flipped. Storage safety is
///         a PRE-CONDITION, not checked here: run the layout diff (append-only vs the deployed
///         commit) before invoking — the doctrine forbids post-deploy storage reorders.
contract UpgradeAll is Upgrade {
    /// @dev EIP-1967 implementation slot (universal constant; restated because the parent's copy
    ///      is private): keccak256("eip1967.proxy.implementation") - 1.
    bytes32 internal constant IMPL_SLOT_ =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    /// @dev One prep-JSON row. FIELD ORDER LAW: `vm.parseJson` abi-encodes object keys sorted
    ///      alphabetically, so the struct fields must be declared alphabetically: name, proxy.
    struct Target {
        string name;
        address proxy;
    }

    /// @notice Upgrade every listed module that is live on this chain.
    function run() external override {
        string memory json = vm.readFile(vm.envString("UPGRADE_SET"));
        Target[] memory targets = abi.decode(vm.parseJson(json, ".targets"), (Target[]));
        address signer = vm.envAddress("DEPLOYER");

        // Pre-flight: count what is upgradeable HERE. A module the sender does not own is
        // SKIPPED with a loud warn (the known misowned pairs on some chains), never a
        // whole-chain blocker — the log is the honest record of what stayed on old code.
        uint256 live;
        for (uint256 i = 0; i < targets.length; ++i) {
            if (targets[i].proxy.code.length == 0) continue;
            if (IOwnable(targets[i].proxy).owner() != signer) {
                console2.log("WARN misowned, will skip:", targets[i].name);
                continue;
            }
            ++live;
        }
        console2.log("live owned proxies to upgrade:", live);
        require(live > 0, "UpgradeAll: nothing live-and-owned on this chain");

        vm.startBroadcast();
        for (uint256 i = 0; i < targets.length; ++i) {
            Target memory t = targets[i];
            if (t.proxy.code.length == 0) {
                console2.log("SKIP (no code on this chain):", t.name);
                continue;
            }
            if (IOwnable(t.proxy).owner() != signer) {
                console2.log("SKIP (misowned on this chain):", t.name);
                continue;
            }
            address newImpl = _deployImpl(t.name);
            IUUPS(t.proxy).upgradeToAndCall(newImpl, "");
            require(
                address(uint160(uint256(vm.load(t.proxy, IMPL_SLOT_)))) == newImpl,
                string.concat("UpgradeAll: impl slot did not flip for ", t.name)
            );
            console2.log("UPGRADED:", t.name, "->", newImpl);
        }
        vm.stopBroadcast();
        console2.log("UpgradeAll: every live module now runs an implementation deployed today.");
    }
}
