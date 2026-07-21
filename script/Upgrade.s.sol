// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";

// ── The 20 UUPS-upgradeable modules (every src/ contract that inherits UUPSUpgradeable) ──
import { Access0x1Router } from "../src/Access0x1Router.sol";
import { PaymentLanes } from "../src/PaymentLanes.sol";
import { Access0x1Subscriptions } from "../src/Access0x1Subscriptions.sol";
import { Access0x1Escrow } from "../src/Access0x1Escrow.sol";
import { AutomationGateway } from "../src/AutomationGateway.sol";
import { Access0x1ProvenanceRegistry } from "../src/Access0x1ProvenanceRegistry.sol";
import { Access0x1Bookings } from "../src/Access0x1Bookings.sol";
import { Access0x1GiftCards } from "../src/Access0x1GiftCards.sol";
import { Access0x1Invoices } from "../src/Access0x1Invoices.sol";
import { Access0x1Nft } from "../src/Access0x1Nft.sol";
import { Access0x1SponsorRegistry } from "../src/Access0x1SponsorRegistry.sol";
import { Access0x1Rebates } from "../src/Access0x1Rebates.sol";
import { GaslessPayIn } from "../src/GaslessPayIn.sol";
import { HouseTokenFactory } from "../src/HouseTokenFactory.sol";
import { PriceOracleAdapter } from "../src/PriceOracleAdapter.sol";
import { Receivables } from "../src/Receivables.sol";
import { Refunds } from "../src/Refunds.sol";
import { SessionGrant } from "../src/SessionGrant.sol";
import { SplitSettler } from "../src/SplitSettler.sol";
import { ChainRegistry } from "../src/ChainRegistry.sol";

/// @notice The two proxy-side surfaces this script touches. `upgradeToAndCall` is OZ 5.x UUPS's ONLY
///         upgrade entrypoint (there is no bare `upgradeTo`); `owner` is the Ownable2Step admin that
///         `_authorizeUpgrade`'s `onlyOwner` gate checks. Minimal interfaces keep the cast obvious and
///         avoid depending on any one concrete module type for the call.
interface IUUPS {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}

interface IOwnable {
    function owner() external view returns (address);
}

/// @title  Upgrade
/// @author Access0x1
/// @notice Generic, storage-safe UUPS upgrade of ONE first-party module on ONE chain.
/// @dev    Env-driven (a 5-person team runs it the same way every time):
///           MODULE  the contract name, e.g. `Access0x1Escrow` (selects which impl to deploy).
///           PROXY   that module's proxy address (the Makefile resolves it from
///                   script/mirror-manifest.json via script/proxy-of.mjs; override with PROXY=0x...).
///
///         FLOW: read the current EIP-1967 implementation, fail fast unless the broadcasting `--sender`
///         is the module's on-chain `owner()` (so the misowned (module,chain) pairs surface BEFORE a
///         wasted impl deploy), deploy a FRESH implementation with plain `new` (see below), then call
///         `proxy.upgradeToAndCall(newImpl, "")` and assert the impl slot flipped.
///
///         WHY plain `new` and NOT CreateX: only the PROXY needs the cross-chain-identical mirror
///         address; the implementation is merely the code the proxy delegatecalls to, and its address
///         is per-chain state stored in the proxy's EIP-1967 slot. Re-using the original salt
///         `access0x1.v1.<C>.impl` would hit DeployAll._create3's idempotent skip (that address already
///         has code) and return the OLD impl — a silent no-op upgrade. A fresh `new Impl()` also shows
///         up as a normal top-level CREATE, so forge's inline `--verify` auto-verifies it.
///
///         EMPTY init data: no module uses a reinitializer (highest init version = 1 across all 20), so
///         `upgradeToAndCall(newImpl, "")` performs NO re-initialization. A future impl that adds
///         storage needing setup must add a `reinitializer(2)` function and this script must be run with
///         calldata (see docs/UPGRADING.md) — do NOT re-encode `initialize` (it would revert).
///
///         SAFETY THAT IS NOT THIS SCRIPT'S JOB: storage-layout compatibility is enforced BEFORE the
///         broadcast by `make upgrade-guard` (scripts/sync-storage-layouts.mjs). OZ itself checks the
///         new impl's `proxiableUUID` inside `upgradeToAndCall`, rejecting a non-UUPS implementation.
///
///         KEYSTORE ONLY — the Makefile passes `--account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER)`,
///         identical to every deploy target; never `--private-key`.
contract Upgrade is Script {
    /// @notice The canonical EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1.
    bytes32 private constant IMPL_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function run() external {
        string memory module = vm.envString("MODULE");
        address proxy = vm.envAddress("PROXY");
        // The broadcaster — set via `--sender`. During both simulation and broadcast this is the
        // address the onlyOwner upgrade call will run as.
        address signer = msg.sender;

        require(proxy.code.length > 0, "Upgrade: PROXY has no code on this chain (wrong chain/address?)");

        address currentImpl = _impl(proxy);
        require(currentImpl != address(0), "Upgrade: proxy reports zero implementation (not a proxy?)");

        // Fail LOUD and EARLY if this signer cannot upgrade this module on this chain. The on-chain
        // gate (`_authorizeUpgrade onlyOwner`) would revert anyway, but checking first avoids deploying
        // a throwaway implementation and gives a precise message — this is exactly what flags the
        // known misowned pairs (SponsorRegistry / Rebates on OP / Arbitrum / Fuji).
        address owner = IOwnable(proxy).owner();
        require(
            signer == owner,
            string.concat(
                "Upgrade: --sender is not owner() of this module on this chain. owner=",
                vm.toString(owner),
                " sender=",
                vm.toString(signer)
            )
        );

        console2.log("module           :", module);
        console2.log("proxy            :", proxy);
        console2.log("owner / signer   :", owner);
        console2.log("current impl     :", currentImpl);

        vm.startBroadcast();
        address newImpl = _deployImpl(module);
        require(newImpl != currentImpl, "Upgrade: new impl == current impl (nothing to do)");
        IUUPS(proxy).upgradeToAndCall(newImpl, "");
        vm.stopBroadcast();

        address afterImpl = _impl(proxy);
        console2.log("new impl         :", newImpl);
        console2.log("impl slot now    :", afterImpl);
        require(afterImpl == newImpl, "Upgrade: EIP-1967 impl slot did not flip to the new impl");
        console2.log("UPGRADE OK       : verify the new impl on the explorer + read a preserved value");
    }

    /// @notice Read the proxy's EIP-1967 implementation address directly from its storage slot.
    function _impl(address proxy) private view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPL_SLOT))));
    }

    /// @notice Deploy a FRESH implementation for `module`. Every module's constructor runs
    ///         `_disableInitializers()` (so the impl can never be initialized directly) and takes no
    ///         args, so `new C()` is all that is needed. keccak dispatch keeps it a pure lookup.
    function _deployImpl(string memory module) private returns (address) {
        bytes32 k = keccak256(bytes(module));
        if (k == keccak256("Access0x1Router")) return address(new Access0x1Router());
        if (k == keccak256("PaymentLanes")) return address(new PaymentLanes());
        if (k == keccak256("Access0x1Subscriptions")) return address(new Access0x1Subscriptions());
        if (k == keccak256("Access0x1Escrow")) return address(new Access0x1Escrow());
        if (k == keccak256("AutomationGateway")) return address(new AutomationGateway());
        if (k == keccak256("Access0x1ProvenanceRegistry")) {
            return address(new Access0x1ProvenanceRegistry());
        }
        if (k == keccak256("Access0x1Bookings")) return address(new Access0x1Bookings());
        if (k == keccak256("Access0x1GiftCards")) return address(new Access0x1GiftCards());
        if (k == keccak256("Access0x1Invoices")) return address(new Access0x1Invoices());
        if (k == keccak256("Access0x1Nft")) return address(new Access0x1Nft());
        if (k == keccak256("Access0x1SponsorRegistry")) return address(new Access0x1SponsorRegistry());
        if (k == keccak256("Access0x1Rebates")) return address(new Access0x1Rebates());
        if (k == keccak256("GaslessPayIn")) return address(new GaslessPayIn());
        if (k == keccak256("HouseTokenFactory")) return address(new HouseTokenFactory());
        if (k == keccak256("PriceOracleAdapter")) return address(new PriceOracleAdapter());
        if (k == keccak256("Receivables")) return address(new Receivables());
        if (k == keccak256("Refunds")) return address(new Refunds());
        if (k == keccak256("SessionGrant")) return address(new SessionGrant());
        if (k == keccak256("SplitSettler")) return address(new SplitSettler());
        if (k == keccak256("ChainRegistry")) return address(new ChainRegistry());
        revert(string.concat("Upgrade: unknown MODULE '", module, "' (see script/Upgrade.s.sol dispatch)"));
    }
}
