// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { Access0x1Router } from "../src/Access0x1Router.sol";
import { MockV3Aggregator } from "../test/mocks/MockV3Aggregator.sol";

/// @title  DriveMerchant
/// @author Access0x1
/// @notice BE A MERCHANT on the LIVE Access0x1 mirror and settle ONE real USD-priced payment — the
///         end-to-end "we use our own rail" proof. Registers a merchant on the mirror router
///         (permissionless), ensures a native price feed is wired, then settles a real `payNative`
///         in the chain's NATIVE token so NO ERC-20 faucet is needed: the broadcaster pays from the
///         gas balance it already holds (ETH on Base Sepolia, native USDC on Arc). Logs the split
///         (net → merchant, fee → treasury, zero router custody) and the `PaymentReceived` receipt.
/// @dev    TESTNET ONLY. The broadcaster must be the router OWNER (so `setPriceFeed` is authorized)
///         — the canonical mirror deployer `0xA121…8D73`. Chain-branched on `block.chainid`:
///
///           Base Sepolia (84532): native ETH/USD feed already exists on-chain (Chainlink
///             0x4aDC67…7cb1, verified). If the router's native slot is unset, this wires it.
///           Arc testnet (5042002): USDC IS the native gas token, $1-pegged, and Arc has no
///             Chainlink feed — so this deploys a $1.00 MockV3Aggregator (the documented Arc
///             pattern, DeployArcUsdFeed.s.sol) and wires it as the native feed.
///
///         SIMULATE FIRST (no key, no broadcast — validates against the live chain fork):
///           forge script script/DriveMerchant.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL \
///             --sender 0xA121e1eF31BbF0826aa67dc01e7977e80Af58D73 -vvv
///         THEN broadcast (one keystore password):
///           forge script script/DriveMerchant.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL \
///             --account default --sender 0xA121e1eF31BbF0826aa67dc01e7977e80Af58D73 --broadcast -vvv
///         (swap $BASE_SEPOLIA_RPC_URL → $ARC_TESTNET_RPC_URL for the Arc run.)
///
///         Env overrides (optional): MERCHANT_PAYOUT (default: broadcaster — set a DISTINCT address
///         for a cleaner demo where net lands somewhere other than the payer), PAY_USD8 (default
///         1e8 = $1.00).
contract DriveMerchant is Script {
    /// @notice The CREATE3 mirror router — identical on every chain.
    Access0x1Router internal constant ROUTER =
        Access0x1Router(payable(0xe92244e3368561faf21648146511DeDE3a475EB5));

    /// @notice The native sentinel (address(0)) — the pay-in asset for `payNative`.
    address internal constant NATIVE = address(0);

    /// @notice Chainlink ETH/USD on Base Sepolia (verified on-chain: "ETH / USD", 8 dp).
    address internal constant BASE_SEPOLIA_ETH_USD = 0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1;

    uint256 internal constant BASE_SEPOLIA = 84_532;
    uint256 internal constant ARC_TESTNET = 5_042_002;

    function run() external {
        address broadcaster = msg.sender;
        address payout = vm.envOr("MERCHANT_PAYOUT", broadcaster);
        uint256 usd8 = vm.envOr("PAY_USD8", uint256(1e8)); // $1.00 default

        console2.log("=== Access0x1 - be a merchant + settle one native payment ===");
        console2.log("chainid        :", block.chainid);
        console2.log("router (mirror):", address(ROUTER));
        console2.log("broadcaster    :", broadcaster);
        console2.log("owner()        :", ROUTER.owner());
        require(broadcaster == ROUTER.owner(), "broadcaster must be the router owner");

        vm.startBroadcast();

        // 1. Ensure a NATIVE price feed is wired (owner-only). Idempotent: skip if already set.
        if (ROUTER.priceFeedOf(NATIVE) == address(0)) {
            address feed;
            if (block.chainid == BASE_SEPOLIA) {
                feed = BASE_SEPOLIA_ETH_USD; // real Chainlink ETH/USD
            } else if (block.chainid == ARC_TESTNET) {
                // Arc has no Chainlink feed; native USDC is $1-pegged by chain design.
                feed = address(new MockV3Aggregator(8, 1e8));
                console2.log("Arc $1 native feed deployed:", feed);
            } else {
                revert("unsupported chain - Base Sepolia (84532) or Arc (5042002) only");
            }
            ROUTER.setPriceFeed(NATIVE, feed);
            console2.log("native feed wired:", feed);
        } else {
            console2.log("native feed already set:", ROUTER.priceFeedOf(NATIVE));
        }

        // 2. BE A MERCHANT — register a seat on the mirror (permissionless; caller becomes owner).
        uint256 merchantId =
            ROUTER.registerMerchant(payout, address(0), 0, keccak256("access0x1.example.merchant"));
        console2.log("merchant registered, id:", merchantId);
        console2.log("  payout       :", payout);

        // 3. Settle ONE real payment in the NATIVE token (no faucet — pays from the gas balance).
        uint256 gross = ROUTER.quote(merchantId, NATIVE, usd8);
        console2.log("quote (native wei):", gross);
        require(broadcaster.balance >= gross, "insufficient native balance to settle the payment");

        bytes32 orderId = keccak256(abi.encodePacked("access0x1-drive-", block.chainid, merchantId));
        ROUTER.payNative{ value: gross }(merchantId, usd8, orderId);

        vm.stopBroadcast();

        // 4. Show the split the receipt encodes (net → payout, fee → treasury, zero router custody).
        uint16 feeBps = ROUTER.platformFeeBps();
        uint256 fee = (gross * feeBps) / 10_000;
        console2.log("=== settled - PaymentReceived emitted ===");
        console2.log("usd priced     :", usd8, "(8dp)");
        console2.log("gross (native) :", gross);
        console2.log("platform fee   :", fee, "-> treasury");
        console2.log("net (native)   :", gross - fee, "-> merchant payout");
        console2.log("treasury       :", ROUTER.platformTreasury());
        console2.log("router custody :", address(ROUTER).balance, "(native held; expect ~0)");
        console2.log("orderId        :");
        console2.logBytes32(orderId);
    }
}
