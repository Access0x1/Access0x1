// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { PriceRelaySender } from "../src/PriceRelaySender.sol";
import { PriceRelayReceiver } from "../src/PriceRelayReceiver.sol";

/// @title  DeployPriceRelaySender
/// @author Access0x1
/// @notice Deploys {PriceRelaySender} on the SOURCE chain — the one where Chainlink actually publishes
///         the feed (Ethereum Sepolia for USDC/USD). Run this FIRST is wrong; run it SECOND. The
///         receiver must exist before the sender can be pointed at it, so the order is: deploy the
///         receiver on the destination, deploy this with the receiver's address to hand, wire both
///         directions, then relay once.
///
/// @dev    ENV (all REQUIRED except LINK and the owner):
///           RELAY_SRC_CCIP_ROUTER    (address) the CCIP Router on the SOURCE chain
///           RELAY_SOURCE_FEED        (address) the REAL Chainlink aggregator to republish
///           RELAY_SRC_LINK           (address, default 0) LINK on the source chain
///           RELAY_MAX_SOURCE_AGE     (uint, default 86400) max age of a source answer to forward
///           RELAY_OWNER              (address, default the broadcaster)
///           RELAY_DEST_SELECTOR      (uint64, default 0) wire the destination in this same broadcast
///           RELAY_DEST_RECEIVER      (address, default 0) the receiver on the destination chain
///
///         CONFIRM EVERY ADDRESS FIRST. The Router and the destination selector come from
///         `docs.chain.link/ccip/directory`; the source feed comes from
///         `docs.chain.link/data-feeds/price-feeds/addresses` for the SOURCE chain. This repo hardcodes
///         none of them (law #3), and a wrong source feed is a wrong price for every payment
///         downstream, not a typo.
///
///         THE DEFAULT WINDOW is a day, because Chainlink's USDC/USD feeds run a slow heartbeat with a
///         deviation trigger — a flat hour would reject answers that are perfectly valid. That window
///         governs what may be RELAYED. How long a relayed answer stays USABLE is a separate decision,
///         owned by the router's own per-token staleness setting.
contract DeployPriceRelaySender is Script {
    /// @dev One day, matching the slow heartbeat of Chainlink's stablecoin feeds.
    uint256 internal constant DEFAULT_MAX_SOURCE_AGE = 86_400;

    /// @notice Deploy the sender and optionally wire its destination in the same broadcast.
    /// @return relaySender The deployed {PriceRelaySender}.
    function run() external returns (address relaySender) {
        address ccipRouter = vm.envAddress("RELAY_SRC_CCIP_ROUTER");
        address sourceFeed = vm.envAddress("RELAY_SOURCE_FEED");
        address link = vm.envOr("RELAY_SRC_LINK", address(0));
        uint256 maxSourceAge = vm.envOr("RELAY_MAX_SOURCE_AGE", DEFAULT_MAX_SOURCE_AGE);
        address owner = vm.envOr("RELAY_OWNER", msg.sender);
        uint64 destSelector = uint64(vm.envOr("RELAY_DEST_SELECTOR", uint256(0)));
        address destReceiver = vm.envOr("RELAY_DEST_RECEIVER", address(0));

        vm.startBroadcast();
        PriceRelaySender deployed =
            new PriceRelaySender(ccipRouter, sourceFeed, link, maxSourceAge, owner);
        // Wiring in the same broadcast keeps the window in which the sender exists with no destination
        // down to zero blocks. Skipped when the broadcaster is not the owner it just set.
        if (destSelector != 0 && destReceiver != address(0) && owner == msg.sender) {
            deployed.setDestination(destSelector, destReceiver);
        }
        vm.stopBroadcast();

        relaySender = address(deployed);

        console2.log("==> PriceRelaySender deployed at:", relaySender);
        console2.log("    ccip router    :", ccipRouter);
        console2.log("    source feed    :", sourceFeed);
        console2.log("    link           :", link);
        console2.log("    max source age :", maxSourceAge, "s");
        console2.log("    owner          :", owner);
        console2.log("    destination    :", destReceiver);
        console2.log("");
        console2.log("    Next: open the lane on the DESTINATION receiver, naming this address,");
        console2.log("    then quote a fee to confirm the Router accepts a data-only message:");
        console2.log("      make relay-quote SENDER=", relaySender);
    }
}

/// @title  DeployPriceRelayReceiver
/// @author Access0x1
/// @notice Deploys {PriceRelayReceiver} on the DESTINATION chain — the one Chainlink does not serve
///         (Arc testnet, 5042002). Deploy this FIRST, because the sender needs its address.
///
///         The deployed contract is itself an `AggregatorV3Interface`, so wiring it into the rail is
///         the ordinary `router.setPriceFeed(usdc, receiver)` call and nothing else. Wire that only
///         AFTER a first price has actually landed — a receiver with no price reverts
///         `PriceRelayReceiver__NoPriceYet`, which would close the rail on that token until the first
///         relay arrives.
///
/// @dev    ENV:
///           RELAY_DEST_CCIP_ROUTER   (address, REQUIRED) the CCIP Router on the DESTINATION chain
///           RELAY_DECIMALS           (uint8,  default 8)      the scale every report must arrive at
///           RELAY_MIN_ANSWER         (uint,   default 0.95e8)  the immutable band floor
///           RELAY_MAX_ANSWER         (uint,   default 1.05e8)  the immutable band ceiling
///           RELAY_MAX_SOURCE_AGE     (uint,   default 86400)   admission limit on age at arrival
///           RELAY_OWNER              (address, default the broadcaster)
///           RELAY_SRC_SELECTOR       (uint64, default 0) open the lane in this same broadcast
///           RELAY_SRC_SENDER         (address, default 0) the sender on the source chain
///
///         THE BAND is ±5% around the dollar peg, immutable. Widening it means a new deployment and a
///         fresh `setPriceFeed` — the visibility a change to the accepted price range deserves.
contract DeployPriceRelayReceiver is Script {
    uint8 internal constant DEFAULT_DECIMALS = 8;
    uint256 internal constant DEFAULT_MIN = 0.95e8;
    uint256 internal constant DEFAULT_MAX = 1.05e8;
    uint256 internal constant DEFAULT_MAX_SOURCE_AGE = 86_400;

    /// @dev The on-chain provenance label: a reader sees where the number came from and how it got
    ///      here, without opening the source.
    string internal constant FEED_DESCRIPTION =
        "USDC/USD (Chainlink on Ethereum Sepolia, relayed via CCIP)";

    /// @notice Deploy the receiver and optionally open its source lane in the same broadcast.
    /// @return relayReceiver The deployed {PriceRelayReceiver}.
    function run() external returns (address relayReceiver) {
        address ccipRouter = vm.envAddress("RELAY_DEST_CCIP_ROUTER");
        uint8 decimals = uint8(vm.envOr("RELAY_DECIMALS", uint256(DEFAULT_DECIMALS)));
        uint256 minAnswer = vm.envOr("RELAY_MIN_ANSWER", DEFAULT_MIN);
        uint256 maxAnswer = vm.envOr("RELAY_MAX_ANSWER", DEFAULT_MAX);
        uint256 maxSourceAge = vm.envOr("RELAY_MAX_SOURCE_AGE", DEFAULT_MAX_SOURCE_AGE);
        address owner = vm.envOr("RELAY_OWNER", msg.sender);
        uint64 srcSelector = uint64(vm.envOr("RELAY_SRC_SELECTOR", uint256(0)));
        address srcSender = vm.envOr("RELAY_SRC_SENDER", address(0));

        vm.startBroadcast();
        PriceRelayReceiver deployed = new PriceRelayReceiver(
            ccipRouter, FEED_DESCRIPTION, decimals, minAnswer, maxAnswer, maxSourceAge, owner
        );
        if (srcSelector != 0 && srcSender != address(0) && owner == msg.sender) {
            deployed.setSourceLane(srcSelector, srcSender);
        }
        vm.stopBroadcast();

        relayReceiver = address(deployed);

        console2.log("==> PriceRelayReceiver deployed at:", relayReceiver);
        console2.log("    ccip router    :", ccipRouter);
        console2.log("    decimals       :", decimals);
        console2.log("    band           :", vm.toString(minAnswer), "..", vm.toString(maxAnswer));
        console2.log("    max source age :", maxSourceAge, "s");
        console2.log("    owner          :", owner);
        console2.log("    source sender  :", srcSender);
        console2.log("");
        console2.log("    Next: deploy the sender on the SOURCE chain pointing here, relay once,");
        console2.log("    CONFIRM a price landed, and only then point the router at it:");
        console2.log("      cast call", relayReceiver, "latestRoundData()");
    }
}
