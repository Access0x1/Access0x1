// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { Access0x1Router } from "../src/Access0x1Router.sol";
import { Access0x1PaymentResolver } from "../src/ens/Access0x1PaymentResolver.sol";

/// @title  DeployPaymentResolver
/// @author Access0x1
/// @notice Deploys {Access0x1PaymentResolver} as a UUPS impl + `ERC1967Proxy` sidecar (the
///         {DeployChainRegistry} pattern), pointed at the LIVE router on this chain. The proxy runs
///         `initialize(...)` in its constructor (atomic init — OZ 5.x rejects empty proxy data),
///         owned by the broadcaster so the optional post-init owner calls in the same broadcast
///         succeed; ownership then two-steps to `RESOLVER_OWNER` when set.
/// @dev    Sidecar, not mirror: wiring the resolver into `DeployAll._deployUUPS` (CREATE3 mirror
///         address) is the queued post-event cutover step — tonight's deploy is one chain, one
///         script, honestly recorded in `broadcast/`. Keystore-only signing (security.md). All
///         addresses ENV-SOURCED (law #4): the router from this chain's broadcast record, the ENS
///         registry from docs.ens.domains — never guessed, never hardcoded. Run:
///           RESOLVER_ROUTER=0x... ENS_REGISTRY=0x... forge script \
///             script/DeployPaymentResolver.s.sol --rpc-url "$SEPOLIA_RPC_URL" \
///             --account deployer --sender "$DEPLOYER" --broadcast
contract DeployPaymentResolver is Script {
    /// @notice Deploy impl + proxy, optionally arm the strong ENS-registry bind gate, optionally
    ///         hand ownership off (Ownable2Step — the target must `acceptOwnership`).
    /// @return resolver The live resolver proxy, cast to its contract type.
    function run() external returns (Access0x1PaymentResolver resolver) {
        // The audited router this resolver answers from — this chain's broadcast-recorded address.
        address router = vm.envAddress("RESOLVER_ROUTER");
        // Official-docs-confirmed ENS registry, or zero ⇒ the first-claim fallback stays active.
        address ensRegistry = vm.envOr("ENS_REGISTRY", address(0));
        // Optional final admin; unset ⇒ the broadcaster keeps ownership.
        address finalOwner = vm.envOr("RESOLVER_OWNER", address(0));

        vm.startBroadcast();
        // Owned by the broadcaster first so setEnsRegistry lands in this same broadcast; the
        // impl's constructor ran `_disableInitializers()`, so only the proxy is ever initialized.
        address seeder = tx.origin;
        address impl = address(new Access0x1PaymentResolver());
        resolver = Access0x1PaymentResolver(
            address(
                new ERC1967Proxy(
                    impl,
                    abi.encodeCall(
                        Access0x1PaymentResolver.initialize,
                        (seeder, Access0x1Router(payable(router)))
                    )
                )
            )
        );

        // Arm the trust-minimized node-control gate the moment the registry address is confirmed;
        // absent, bindName's first-claim + no-overwrite fallback documents itself on-chain.
        if (ensRegistry != address(0)) resolver.setEnsRegistry(ensRegistry);
        // Ownable2Step: the handoff completes only when `finalOwner` accepts — a deliberate,
        // owner-signed follow-up, exactly like the router's deploy/configure split.
        if (finalOwner != address(0) && finalOwner != seeder) {
            resolver.transferOwnership(finalOwner);
        }
        vm.stopBroadcast();

        console2.log("Access0x1PaymentResolver impl:", impl);
        console2.log("Access0x1PaymentResolver proxy:", address(resolver));
        console2.log("  router:", router);
        console2.log("  ensRegistry:", ensRegistry);
        console2.log("  chainCoinType:", resolver.chainCoinType());
    }
}
