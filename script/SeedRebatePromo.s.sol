// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Access0x1Router } from "../src/Access0x1Router.sol";
import { Access0x1Rebates } from "../src/Access0x1Rebates.sol";
import { HelperConfig } from "./HelperConfig.s.sol";

/// @title  SeedRebatePromo
/// @author Access0x1
/// @notice One-broadcast testnet seeding for the {Access0x1Rebates} module: registers a merchant
///         seat on the mirror router (permissionless — the broadcaster becomes the seat owner),
///         configures a promotional rebate program on it, and pre-funds the pool from the
///         broadcaster's balance of the chain's configured USDC. Everything a live end-to-end rebate
///         demo needs, in a single signed run.
/// @dev    TESTNET-ONLY seeding (the promo pool is real money on any chain — this script is for
///         faucet funds). Env knobs, all optional except the module address:
///           REBATES_ADDRESS     the deployed {Access0x1Rebates} proxy (required; the mirror-manifest
///                               address once the pair is broadcast)
///           PROMO_PAYOUT        the seat's payout wallet        (default: the broadcaster)
///           PROMO_REBATE_BPS    rebate share of the gross       (default: 500 = 5%)
///           PROMO_MIN_USD8      qualifying minimum, USD 8-dec   (default: 5e8 = $5)
///           PROMO_DAYS          window length from now, days    (default: 30)
///           PROMO_FUND          pool funding, token decimals    (default: 10e6 = 10 USDC)
///         The pay-in token is the chain's configured USDC (HelperConfig — the same source the
///         deploy uses), so the promo always rides a token the router already allowlists. The run
///         fails fast, BEFORE any state change, if the broadcaster's USDC balance cannot cover the
///         funding (top up from a faucet first).
contract SeedRebatePromo is Script {
    function run() external returns (uint256 merchantId) {
        HelperConfig helperConfig = new HelperConfig();
        HelperConfig.NetworkConfig memory cfg = helperConfig.getConfig();
        require(cfg.usdc != address(0), "SeedRebatePromo: no USDC configured for this chain");

        Access0x1Rebates rebates = Access0x1Rebates(vm.envAddress("REBATES_ADDRESS"));
        Access0x1Router router = rebates.router();

        address payout = vm.envOr("PROMO_PAYOUT", msg.sender);
        uint16 rebateBps = uint16(vm.envOr("PROMO_REBATE_BPS", uint256(500)));
        uint256 minUsd8 = vm.envOr("PROMO_MIN_USD8", uint256(5e8));
        uint256 windowDays = vm.envOr("PROMO_DAYS", uint256(30));
        uint256 fund = vm.envOr("PROMO_FUND", uint256(10e6));

        // Fail fast before any broadcast state change: the pool funding must be coverable.
        uint256 balance = IERC20(cfg.usdc).balanceOf(msg.sender);
        require(balance >= fund, "SeedRebatePromo: broadcaster USDC balance below PROMO_FUND");

        vm.startBroadcast();
        merchantId = router.registerMerchant(
            payout, address(0), 0, keccak256("access0x1.example.rebate-promo")
        );
        rebates.createPromo(
            merchantId,
            cfg.usdc,
            uint64(block.timestamp),
            uint64(block.timestamp + windowDays * 1 days),
            rebateBps,
            minUsd8
        );
        IERC20(cfg.usdc).approve(address(rebates), fund);
        rebates.fundPromo(merchantId, fund);
        vm.stopBroadcast();

        (,, uint64 end,,, uint256 funded) = rebates.promos(merchantId);
        console2.log("merchant seat         :", merchantId);
        console2.log("promo token (USDC)    :", cfg.usdc);
        console2.log("pool funded           :", funded);
        console2.log("window closes (unix)  :", end);
    }
}
