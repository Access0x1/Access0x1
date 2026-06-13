// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { DeployAccess0x1Router } from "../../script/DeployAccess0x1Router.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";

/// @notice Proves the deploy script + HelperConfig run end-to-end on the local (Anvil) branch and
///         hand back a correctly-parameterised router wired to mock feeds — the script is a
///         deliverable, so it gets a test like every other unit.
contract DeployAccess0x1RouterTest is Test {
    function test_deployProducesConfiguredRouter() public {
        DeployAccess0x1Router deployer = new DeployAccess0x1Router();
        (Access0x1Router router, HelperConfig helperConfig) = deployer.run();
        HelperConfig.NetworkConfig memory cfg = helperConfig.getConfig();

        // Constructor wiring matches the local config; the router is live and unowned-by-nobody.
        assertTrue(address(router) != address(0));
        assertEq(router.platformTreasury(), cfg.treasury);
        assertEq(router.platformFeeBps(), cfg.platformFeeBps);
        assertEq(router.nextMerchantId(), 1);
        assertTrue(router.owner() != address(0));

        // The local branch deployed live mock feeds + a mock USDC for the configure step (no
        // placeholder zeros), and they are owner-wired separately — never guessed.
        assertTrue(cfg.nativeUsdFeed != address(0));
        assertTrue(cfg.usdc != address(0));
        assertTrue(cfg.usdcUsdFeed != address(0));
    }
}
