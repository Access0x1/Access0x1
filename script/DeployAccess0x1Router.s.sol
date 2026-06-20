// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { Access0x1Router } from "../src/Access0x1Router.sol";
import { HelperConfig } from "./HelperConfig.s.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title  DeployAccess0x1Router
/// @author Access0x1
/// @notice Deploys the router from `HelperConfig`. Single responsibility — it deploys the contract
///         only; wiring the price feeds + token allowlist is a deliberate, owner-signed follow-up
///         (`setPriceFeed` / `setTokenAllowed`), so the deployer key never needs to equal the admin.
/// @dev    Keystore-only signing: `vm.startBroadcast()` uses the `--account`/`--sender` (or
///         `--private-key`) passed on the CLI — NO key is ever read from source (security.md). Run:
///           forge script script/DeployAccess0x1Router.s.sol \
///             --rpc-url $ARC_TESTNET_RPC_URL --account deployer --broadcast --verify
contract DeployAccess0x1Router is Script {
    function run() external returns (Access0x1Router router, HelperConfig helperConfig) {
        helperConfig = new HelperConfig();
        HelperConfig.NetworkConfig memory cfg = helperConfig.getConfig();

        // The admin (Ownable2Step): a burner at the event, a multisig in production. Defaults to the
        // broadcaster so a local run needs no extra env.
        address owner = vm.envOr("ROUTER_OWNER", msg.sender);

        vm.startBroadcast();
        // UUPS: deploy the logic implementation, then put an ERC1967 proxy in front of it and run
        // `initialize(...)` in the same tx. The proxy address is the router every caller uses (state
        // lives in the proxy, logic in the impl); the impl ran `_disableInitializers()` in its
        // constructor so it can never be initialized directly.
        address impl = address(new Access0x1Router());
        address proxy = address(
            new ERC1967Proxy(
                impl,
                abi.encodeCall(
                    Access0x1Router.initialize, (owner, cfg.treasury, cfg.platformFeeBps)
                )
            )
        );
        router = Access0x1Router(proxy);
        vm.stopBroadcast();

        console2.log("Access0x1Router deployed:", address(router));
        console2.log("  owner:    ", owner);
        console2.log("  treasury: ", cfg.treasury);
        console2.log("  feeBps:   ", cfg.platformFeeBps);
    }
}
