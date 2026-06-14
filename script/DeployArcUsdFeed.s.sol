// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { MockV3Aggregator } from "../test/mocks/MockV3Aggregator.sol";

/// @title  DeployArcUsdFeed
/// @notice Deploys a $1.00 MockV3Aggregator (8 decimals, answer = 1e8) on Arc testnet to serve
///         as the USDC/USD price feed. On Arc, USDC IS the native gas token, pegged $1 — no
///         published Chainlink USDC/USD feed exists on Arc testnet. This script gives the operator
///         a deployable, verifiable stand-in that the router's OracleLib will accept.
///
///         The feed is intentionally minimal (no oracle-committee security), appropriate only for
///         Arc testnet where USDC peg is an invariant of the chain design, not a market rate.
///
/// @dev    Usage — ONE-TIME before `make deploy-arc` or the full `DeployAll` broadcast:
///
///           # 1. Fund the deployer wallet with Arc USDC (native gas) via faucet.circle.com
///           # 2. Run this script to deploy the feed:
///           forge script script/DeployArcUsdFeed.s.sol \
///             --rpc-url $ARC_TESTNET_RPC_URL \
///             --account deployer --sender $DEPLOYER \
///             --broadcast --verify --verifier blockscout \
///             --verifier-url https://testnet.arcscan.app/api? \
///             --gas-price 20000000000 \
///             -vvvv
///
///           # 3. Copy the printed feed address, then set it in .env:
///           #    ARC_USDC_USD_FEED=<printed address>
///
///           # 4. Deploy the full protocol stack:
///           make deploy-arc
///
///         The Makefile `deploy-arc` target reads ARC_USDC_USD_FEED via HelperConfig._arcTestnetConfig()
///         and wires it into the router via `setPriceFeed(usdc, feed)`. Leaving it blank is safe —
///         DeployAll skips the configure call and logs a warning, so you can re-run just
///         `DeployArcUsdFeed` + `DeployAll` after the feed is known without re-deploying everything.
contract DeployArcUsdFeed is Script {
    /// @dev 1e8 = $1.00 at 8-decimal Chainlink scale.
    int256 internal constant USDC_USD_ANSWER = 1e8;
    uint8 internal constant FEED_DECIMALS = 8;

    function run() external returns (address feed) {
        vm.startBroadcast();
        MockV3Aggregator usdcUsdFeed = new MockV3Aggregator(FEED_DECIMALS, USDC_USD_ANSWER);
        vm.stopBroadcast();

        feed = address(usdcUsdFeed);

        console2.log("==> Arc USDC/USD feed deployed at:", feed);
        console2.log("    decimals : 8");
        console2.log("    answer   : $1.00 (1e8)");
        console2.log("");
        console2.log("    Set in .env:");
        console2.log("      ARC_USDC_USD_FEED=", feed);
        console2.log("");
        console2.log("    Then run: make deploy-arc");
    }
}
