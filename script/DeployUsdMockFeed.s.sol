// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { MockV3Aggregator } from "../test/mocks/MockV3Aggregator.sol";

/// @title  DeployUsdMockFeed
/// @notice Any-chain generalization of {DeployArcUsdFeed}: deploys a minimal MockV3Aggregator to serve
///         as a **USDC/USD** price feed on a testnet where Chainlink publishes no USDC/USD feed but a
///         REAL Circle USDC token exists (Linea / Unichain / World Chain / Celo / Optimism Sepolia —
///         see docs/CHAIN-ADDRESSES.md). The router keeps accepting REAL USDC (the "no demo token" law
///         is intact); this stands in ONLY for the missing *price feed*, pegged to $1.00 because USDC is
///         a dollar stablecoin. Without it those chains allowlist USDC but `payToken` reverts (no quote).
///
///         Defaults are $1.00 at the 8-decimal Chainlink scale; both are env-overridable so the same
///         script can stand in for any stablecoin feed if ever needed:
///           MOCK_FEED_DECIMALS (uint8, default 8) · MOCK_FEED_ANSWER (int, default 1e8 = $1.00)
///
///         Minimal by design (no oracle-committee security) — TESTNET ONLY, appropriate where the peg is
///         an assumption of the demo, never for mainnet (law #5: mainnet is audit-gated, real funds).
///
/// @dev    Usage — ONE-TIME, on the chain that lacks a USDC/USD feed, BEFORE its `make deploy-<chain>`:
///
///           forge script script/DeployUsdMockFeed.s.sol \
///             --rpc-url $LINEA_SEPOLIA_RPC_URL \
///             --account deployer --sender $DEPLOYER --broadcast -vvvv
///           # or: make deploy-usd-mock-feed RPC=$LINEA_SEPOLIA_RPC_URL
///
///         Then set the printed address as that chain's USDC/USD feed in .env, e.g.
///           LINEA_SEPOLIA_USDC_USD_FEED=<printed address>
///         and run `make deploy-linea-sepolia` — HelperConfig wires it via `setPriceFeed(usdc, feed)`.
///         (Leaving it blank stays safe — DeployAll just skips the configure call; USDC then unpriced.)
contract DeployUsdMockFeed is Script {
    /// @dev 1e8 = $1.00 at the 8-decimal Chainlink scale (the default USDC peg).
    int256 internal constant DEFAULT_ANSWER = 1e8;
    uint8 internal constant DEFAULT_DECIMALS = 8;

    function run() external returns (address feed) {
        uint8 decimals = uint8(vm.envOr("MOCK_FEED_DECIMALS", uint256(DEFAULT_DECIMALS)));
        int256 answer = vm.envOr("MOCK_FEED_ANSWER", DEFAULT_ANSWER);

        vm.startBroadcast();
        MockV3Aggregator usdcUsdFeed = new MockV3Aggregator(decimals, answer);
        vm.stopBroadcast();

        feed = address(usdcUsdFeed);

        console2.log("==> USDC/USD mock feed deployed at:", feed);
        console2.log("    decimals :", decimals);
        console2.log("    answer   : ", vm.toString(answer), " (1e8 == $1.00)");
        console2.log("");
        console2.log("    Set it as this chain's USDC/USD feed in .env, e.g.:");
        console2.log("      <CHAIN>_USDC_USD_FEED=", feed);
        console2.log("    then run: make deploy-<chain>");
    }
}
