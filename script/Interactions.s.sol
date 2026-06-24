// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { Access0x1Router } from "../src/Access0x1Router.sol";
import { MockUSDC } from "../test/mocks/MockUSDC.sol";
import { MockV3Aggregator } from "../test/mocks/MockV3Aggregator.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title  Interactions — drive the coffee-shop money flow against a LOCAL anvil
/// @author Access0x1
/// @notice The FundMe-style "deploy + drive" harness: a single, self-contained broadcast that stands
///         up a throwaway deployment (Router + a mock 6-dec USDC + a mock $1.00 Chainlink feed), onboards a
///         merchant, and settles ONE real `payToken` — then logs the split so you can SEE the money
///         move on a chain (not just in a unit test). It is the local-anvil sibling of
///         `test/scenario/CoffeeShopPayment.scenario.t.sol`: same flow, but executed as on-chain
///         transactions against `http://localhost:8545`.
///
///         WHY a script and not just the test: the scenario tests prove the LOGIC in the EVM; this
///         proves the DEPLOY + CALL path works against a node (the thing the SDK/frontend actually
///         does). Run it after `make anvil`:
///
///           make anvil                 # in one terminal — starts the local node
///           make drive-local           # in another — runs this script with --broadcast
///
///         It uses anvil's first default account as the broadcaster (the unlocked dev key), which is
///         the standard local-only pattern — NEVER used against a real chain (no real key is touched).
/// @dev    Everything is deployed fresh in the broadcast, so there is no address to resolve and no env
///         to set. The native/USD feed is unused here (USDC-only flow), kept minimal on purpose.
contract DriveCoffeeShopLocal is Script {
    /// @notice The platform fee for this local run: 1.00% (the default).
    uint16 internal constant PLATFORM_FEE_BPS = 100;

    /// @notice A $5.00 latte in the suite's 8-decimal USD unit.
    uint256 internal constant LATTE_USD8 = 5e8;

    /// @notice Deploy a throwaway deployment and settle one $5 USDC payment, logging the proof. Intended to
    ///         run with `--broadcast` against a local anvil; the broadcaster is anvil's dev account.
    function run() external {
        vm.startBroadcast();

        address operator = msg.sender; // the broadcaster doubles as treasury + merchant for a local run

        // 1. Stand up the spine + a mock token and feed (6-dec USDC at $1.00, like Base/Arc). The
        //    router is UUPS: deploy the impl, then an ERC1967 proxy that runs `initialize(...)` in the
        //    same broadcast; drive the proxy from here on (state in the proxy, logic in the impl).
        address routerImpl = address(new Access0x1Router());
        Access0x1Router router = Access0x1Router(
            address(
                new ERC1967Proxy(
                    routerImpl,
                    abi.encodeCall(
                        Access0x1Router.initialize, (operator, operator, PLATFORM_FEE_BPS)
                    )
                )
            )
        );
        MockUSDC usdc = new MockUSDC();
        MockV3Aggregator usdcFeed = new MockV3Aggregator(8, 1e8);

        // 2. Allowlist + price USDC (the broadcaster is the router owner on a local run).
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));

        // 3. Onboard the coffee shop. The broadcaster registers itself as the merchant owner + payout.
        uint256 merchantId =
            router.registerMerchant(operator, address(0), 0, keccak256("bean-scene-local"));

        // 4. Fund the broadcaster with USDC and approve the router (the one-time checkout approval).
        usdc.mint(operator, 1_000e6);
        usdc.approve(address(router), type(uint256).max);

        // 5. Settle a $5 latte. The router prices it live, splits the 1% fee, and pays the merchant —
        //    all in this one transaction. Since operator == merchant == treasury locally, the net + fee
        //    both return to the broadcaster, so we read the split off the quote rather than balances.
        uint256 gross = router.quote(merchantId, address(usdc), LATTE_USD8);
        uint256 platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        uint256 net = gross - platformFee;

        router.payToken(merchantId, address(usdc), LATTE_USD8, keccak256("order-local-0001"));

        vm.stopBroadcast();

        // 6. The proof, logged so you can read it in the anvil/script output.
        console2.log("=== Access0x1 local coffee-shop drive ===");
        console2.log("Access0x1Router :", address(router));
        console2.log("MockUSDC        :", address(usdc));
        console2.log("merchantId      :", merchantId);
        console2.log("gross  (USDC)   :", gross); // 5_000_000 == 5 USDC
        console2.log("platformFee     :", platformFee); // 50_000 == 0.05 USDC (1%)
        console2.log("net    (USDC)   :", net); // 4_950_000 == 4.95 USDC
        console2.log("net+fee==gross  :", net + platformFee == gross);
        console2.log("router USDC bal :", usdc.balanceOf(address(router))); // 0 == zero custody
    }
}
