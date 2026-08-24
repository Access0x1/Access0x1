// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { OperatorFeed } from "../src/OperatorFeed.sol";

/// @title  DeployArcOperatorFeed
/// @author Access0x1
/// @notice Deploys the guarded {OperatorFeed} that replaces the unguarded `MockV3Aggregator` currently
///         serving USDC/USD on Arc testnet (5042002). Same shape as {DeployArcUsdFeed} — 8 decimals,
///         $1.00 — with three differences that are the whole point: writes are access-controlled, the
///         answer is confined to a deploy-time band, and the feed declares its own refresh cadence so a
///         keeper can hold it fresh.
///
///         WHY A STAND-IN AT ALL. Chainlink publishes no USDC/USD Data Feed and no Data Streams verifier
///         on Arc (confirmed against docs.chain.link, 2026-08-23 — zero entries for Arc or 5042002 in
///         either registry), so the router has no DON-backed source to price USDC against there. This is
///         a labelled development stand-in for that gap. It is NOT a Chainlink product and the
///         `description` string says so on-chain. The Chainlink-backed replacement is {PriceRelaySender}
///         plus {PriceRelayReceiver}, which carry Ethereum Sepolia's real USDC/USD feed across the live
///         Arc↔Sepolia CCIP lane.
///
/// @dev    ENV, all optional except the band defaults being deliberate:
///           ARC_OPERATOR_FEED_ANSWER     (int,     default 1e8      = $1.00)
///           ARC_OPERATOR_FEED_MIN        (uint,    default 0.95e8   = $0.95)
///           ARC_OPERATOR_FEED_MAX        (uint,    default 1.05e8   = $1.05)
///           ARC_OPERATOR_FEED_HEARTBEAT  (uint,    default 1800     = 30 min)
///           ARC_OPERATOR_FEED_OWNER      (address, default the broadcaster)
///           ARC_OPERATOR_FEED_OPERATOR   (address, default unset — owner-only writes). Honoured
///                                        ONLY while the broadcaster is also the owner, since
///                                        `setOperator` is `onlyOwner`. The printed `operator` line
///                                        reads the deployed feed back, so it always shows the
///                                        address that was actually granted.
///
///         THE BAND. ±5% around the peg. A dollar stablecoin that has genuinely left that range is not a
///         thing this rail should keep quoting against, so the band failing closed is the correct
///         outcome rather than a limitation. It is IMMUTABLE — widening it means a new deployment and a
///         fresh `setPriceFeed`, which is the visibility this deserves.
///
///         THE HEARTBEAT. 1800s against the router's 3600s `OracleLib.TIMEOUT` default for this token.
///         Half the window is deliberate slack: a keeper that misses one tick still leaves the feed
///         inside the router's window, and only a keeper that has stopped for a full hour reaches the
///         cliff — at which point `quote()` reverts and nothing settles. See `docs/ARC-PRICING.md`.
///
///         BROADCASTS. Run it with a keystore; the owner executes, never an agent. The exact command
///         list lives in `docs/ARC-PRICING.md`.
contract DeployArcOperatorFeed is Script {
    /// @dev 1e8 = $1.00 at the 8-decimal Chainlink scale.
    int256 internal constant DEFAULT_ANSWER = 1e8;

    /// @dev The default accepted band, ±5% around the peg.
    uint256 internal constant DEFAULT_MIN = 0.95e8;
    uint256 internal constant DEFAULT_MAX = 1.05e8;

    /// @dev 30 minutes — half the router's default 1h staleness window, so one missed tick is survivable.
    uint256 internal constant DEFAULT_HEARTBEAT = 1800;

    /// @dev The Chainlink USD convention.
    uint8 internal constant FEED_DECIMALS = 8;

    /// @dev The on-chain provenance label. A block-explorer reader sees the origin without opening
    ///      the source, and no reader can mistake this for a Chainlink aggregator.
    string internal constant FEED_DESCRIPTION = "USDC/USD (Access0x1 operator feed, not Chainlink)";

    /// @notice Deploy the feed and print the wiring + keeper commands.
    /// @return feed The deployed {OperatorFeed}.
    function run() external returns (address feed) {
        int256 answer = vm.envOr("ARC_OPERATOR_FEED_ANSWER", DEFAULT_ANSWER);
        uint256 minAnswer = vm.envOr("ARC_OPERATOR_FEED_MIN", DEFAULT_MIN);
        uint256 maxAnswer = vm.envOr("ARC_OPERATOR_FEED_MAX", DEFAULT_MAX);
        uint256 heartbeat = vm.envOr("ARC_OPERATOR_FEED_HEARTBEAT", DEFAULT_HEARTBEAT);
        address keeper = vm.envOr("ARC_OPERATOR_FEED_OPERATOR", address(0));

        // Default the owner to whoever broadcasts, matching every other deploy script in this repo.
        address owner = vm.envOr("ARC_OPERATOR_FEED_OWNER", msg.sender);

        // `setOperator` is `onlyOwner`, so the broadcaster can only name the keeper while it IS the
        // owner. A handover deployment (ARC_OPERATOR_FEED_OWNER set to a colder address) therefore
        // leaves the grant to that owner, as its own later transaction.
        bool operatorSet = keeper != address(0) && owner == msg.sender;

        vm.startBroadcast();
        OperatorFeed deployed = new OperatorFeed(
            FEED_DECIMALS, FEED_DESCRIPTION, answer, minAnswer, maxAnswer, heartbeat, owner
        );
        // Naming the keeper in the same broadcast keeps the window in which the feed exists with no
        // authorized refresher down to zero blocks. An unset env leaves writes owner-only.
        if (operatorSet) deployed.setOperator(keeper);
        vm.stopBroadcast();

        feed = address(deployed);

        console2.log("==> Arc USDC/USD OperatorFeed deployed at:", feed);
        console2.log("    decimals  : 8");
        console2.log("    answer    :", vm.toString(answer));
        console2.log("    band      :", vm.toString(minAnswer), "..", vm.toString(maxAnswer));
        console2.log("    heartbeat :", heartbeat, "s");
        console2.log("    owner     :", owner);
        // Print what HAPPENED, never what was requested. An unconditional "operator: <keeper>" line
        // reads as a completed grant, so an owner-handover deploy would leave the reader believing a
        // keeper is authorized when writes are still owner-only and the cron cannot post at all.
        console2.log("    operator  :", deployed.operator());
        console2.log(
            "    operator grant:", operatorSet ? "SET in this broadcast" : "NOT set - owner-only"
        );
        console2.log("");
        console2.log("    1. Set in .env:  ARC_USDC_USD_FEED=", feed);
        console2.log("    2. Point the router at it (owner key):");
        console2.log("       make wire-arc-operator-feed FEED=", feed);
        console2.log("    3. Grant the keeper (owner key) when the line above says NOT set:");
        console2.log("       cast send <feed> \"setOperator(address)\" $KEEPER_ADDRESS");
        console2.log("    4. Start the keeper cron:  make refresh-operator-feed-arc");
        console2.log("       The cron NEEDS a price source. See docs/ARC-PRICING.md - the keeper");
        console2.log("       posts NO default, because an unmeasured peg underpays the merchant.");
    }
}
