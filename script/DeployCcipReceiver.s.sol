// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";

import { Access0x1CcipReceiver } from "../src/Access0x1CcipReceiver.sol";
import { CcipConfig } from "./CcipConfig.s.sol";

/// @title  DeployCcipReceiver — stand up the cross-chain pay-in receiver on this chain
/// @author Access0x1
/// @notice Deploys {Access0x1CcipReceiver} and opens the source lanes named in the environment, so
///         standing the rail up on a new chain is a config change rather than a code change.
///
/// @dev    RUN:
///           forge script script/DeployCcipReceiver.s.sol \
///             --rpc-url $BASE_SEPOLIA_RPC_URL --account deployer --broadcast -vvvv
///
///         REQUIRED ENV (see {CcipConfig} — keys are built from the chain id, so a new chain needs
///         no Solidity):
///           CCIP_ROUTER_<chainId>    the CCIP Router here    (CONFIRM: docs.chain.link/ccip/directory)
///           ACCESS0X1_ROUTER         the Access0x1 router to settle through
///         OPTIONAL:
///           CCIP_RECEIVER_OWNER      lane admin (defaults to the broadcaster)
///           CCIP_LANE_SELECTORS      comma-separated source chain selectors
///           CCIP_LANE_SENDERS        comma-separated sender contracts, index-paired with the above
///
///         FAIL-SOFT BY DESIGN, EXCEPT WHERE IT MUST NOT BE. An unconfigured chain (no CCIP Router)
///         is a clean skip — the same doctrine every other seam follows, so this script is safe to
///         include in a multi-chain run. But a MISSING `ACCESS0X1_ROUTER` reverts: deploying a
///         receiver pointed at nothing would produce a contract that can accept cross-chain money
///         and never settle it, which is worse than not deploying at all.
///
///         Keystore-only signing: `vm.startBroadcast()` uses the `--account`/`--sender` passed on the
///         CLI. NO key is ever read from source (security.md).
///
///         TESTNET ONLY. Every lane opened here is an authorization to credit merchants — confirm
///         each selector against Chainlink's directory before adding it to `CCIP_LANE_SELECTORS`.
contract DeployCcipReceiver is Script {
    /// @notice Deploy the receiver and open every configured lane.
    /// @return receiver The deployed receiver, or `address(0)` when this chain has no CCIP Router.
    function run() external returns (Access0x1CcipReceiver receiver) {
        CcipConfig cfg = new CcipConfig();
        CcipConfig.CcipNetworkDetails memory details = cfg.getCcipDetails();

        if (details.router == address(0)) {
            console2.log("CCIP not configured for chain id", block.chainid);
            console2.log("  skipping - set CCIP_ROUTER_<chainId> to deploy here");
            return Access0x1CcipReceiver(address(0));
        }

        // Deliberately `envAddress`, not `envOr`: see the fail-soft note above. A receiver with no
        // router to settle through is a money trap, so this is the one value we refuse to default.
        address access0x1Router = vm.envAddress("ACCESS0X1_ROUTER");

        // Deploy owned by the BROADCASTER so the lane-opening calls below succeed in the same run;
        // ownership moves afterwards if a separate admin is configured. Same deploy/configure split
        // the router and ChainRegistry scripts use.
        address broadcaster = msg.sender;
        address finalOwner = vm.envOr("CCIP_RECEIVER_OWNER", broadcaster);

        CcipConfig.Lane[] memory lanes = cfg.getLanes();

        vm.startBroadcast();

        receiver = new Access0x1CcipReceiver(details.router, access0x1Router, broadcaster);

        for (uint256 i = 0; i < lanes.length; ++i) {
            receiver.setSourceLane(lanes[i].srcChainSelector, lanes[i].sender);
            console2.log("lane opened <- selector", lanes[i].srcChainSelector);
            console2.log("           sender     ", lanes[i].sender);
        }

        // Ownable2Step: the target must `acceptOwnership` as a deliberate, owner-signed follow-up,
        // so the deploying key never has to be the final admin.
        if (finalOwner != broadcaster) receiver.transferOwnership(finalOwner);

        vm.stopBroadcast();

        console2.log("Access0x1CcipReceiver", address(receiver));
        console2.log("  ccip router        ", details.router);
        console2.log("  access0x1 router   ", access0x1Router);
        console2.log("  this chain selector", details.chainSelector);
        console2.log("  lanes opened       ", lanes.length);
        if (finalOwner != broadcaster) {
            console2.log("  ownership OFFERED to", finalOwner);
            console2.log("  -> that address must call acceptOwnership()");
        }
        if (lanes.length == 0) {
            console2.log("  NOTE: no lanes open - the receiver accepts NOTHING until setSourceLane is called");
        }
    }
}
