// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { Access0x1Router } from "../src/Access0x1Router.sol";
import { MockUSDCGasless } from "../test/mocks/MockUSDCGasless.sol";
import { MockV3Aggregator } from "../test/mocks/MockV3Aggregator.sol";

/// @title  Seed0GGasless
/// @author Access0x1
/// @notice Arms 0G Galileo (16602) for a REAL x402/EIP-3009 settlement on the mirror rail — the
///         Arc posture, disclosed: 0G publishes no Chainlink feed and no Circle USDC, so this
///         deploys the test-only `MockUSDCGasless` (FiatTokenV2_2-faithful EIP-3009 surfaces) and
///         a `$1.00` MockV3Aggregator, wires both into the LIVE mirror router (owner calls),
///         registers the demo merchant seat, and funds the buyer burner. Every quote against this
///         pair is a mock-priced `$1` read and is ALWAYS stated as such — never a real-feed claim.
/// @dev    Broadcaster must be the mirror router's owner (the canonical deployer). One broadcast:
///           X402_BUYER=0x... forge script script/Seed0GGasless.s.sol \
///             --rpc-url https://evmrpc-testnet.0g.ai --account deployer --sender "$DEPLOYER" \
///             --broadcast --priority-gas-price 2000000000 -vvvv
///         After this run, X402Drive.s.sol settles with burner keys only — no owner involved.
contract Seed0GGasless is Script {
    /// @notice The CREATE3 mirror router — identical on every mirrored chain, live on Galileo.
    Access0x1Router internal constant ROUTER =
        Access0x1Router(payable(0xe92244e3368561faf21648146511DeDE3a475EB5));

    function run() external {
        require(block.chainid == 16_602, "Seed0GGasless: Galileo (16602) only");
        address buyer = vm.envAddress("X402_BUYER");
        address payout = vm.envOr("MERCHANT_PAYOUT", msg.sender);
        require(msg.sender == ROUTER.owner(), "broadcaster must be the router owner");

        vm.startBroadcast();
        // Test-only USDC stand-in with the real EIP-3009 typehashes + a $1.00 mock feed —
        // the documented no-feed-chain pattern (Arc precedent), stated wherever quoted.
        MockUSDCGasless usdc = new MockUSDCGasless();
        MockV3Aggregator feed = new MockV3Aggregator(8, 1e8);
        ROUTER.setTokenAllowed(address(usdc), true);
        ROUTER.setPriceFeed(address(usdc), address(feed));
        uint256 merchantId =
            ROUTER.registerMerchant(payout, payout, 0, keccak256("atlas-prints.0g"));
        // Fund the buyer burner: $1,000 of 6-decimal test USDC — enough for many x402 runs.
        usdc.mint(buyer, 1_000e6);
        // Gas for the relayer burner: it submits the settlement tx, so it needs native 0G.
        address relayer = vm.envAddress("X402_RELAYER");
        payable(relayer).transfer(0.3 ether);
        vm.stopBroadcast();

        console2.log("mock USDC (EIP-3009):", address(usdc));
        console2.log("mock $1 feed        :", address(feed));
        console2.log("merchantId          :", merchantId);
        console2.log("buyer funded        :", buyer);
        console2.log("Seed0GGasless: 0G is armed for x402 -- run X402Drive next (burner keys).");
    }
}
