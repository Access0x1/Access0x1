// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script } from "forge-std/Script.sol";
import { MockV3Aggregator } from "../test/mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../test/mocks/MockUSDC.sol";

/// @title  HelperConfig
/// @author Access0x1
/// @notice Per-chain deploy configuration, resolved from the chain id — NEVER a hardcoded address
///         (security.md). On a local Anvil it deploys fresh mocks so the whole flow is runnable
///         offline; on a live chain it reads every address from the environment, so an unset value
///         fails loudly rather than shipping a wrong/placeholder address.
/// @dev    The router constructor only needs `(owner, treasury, platformFeeBps)`; the feed + token
///         addresses are carried here too so the companion configure step (and the frontend) can
///         wire `setPriceFeed`/`setTokenAllowed` from one source of truth.
contract HelperConfig is Script {
    /// @notice Everything a deploy + first-configure needs for one chain.
    struct NetworkConfig {
        address treasury; // platform fee sink (constructor)
        uint16 platformFeeBps; // initial platform fee (constructor)
        address nativeUsdFeed; // Chainlink native/USD feed (setPriceFeed[address(0)])
        address usdc; // settlement ERC-20 to allowlist
        address usdcUsdFeed; // Chainlink USDC/USD feed
    }

    /// @notice The chain id of a local Anvil/Foundry node.
    uint256 internal constant LOCAL_CHAIN_ID = 31_337;

    /// @notice Default platform fee when `PLATFORM_FEE_BPS` is unset: 100 bps = 1.00%.
    uint16 internal constant DEFAULT_PLATFORM_FEE_BPS = 100;

    /// @notice The resolved config for the chain this script runs against.
    NetworkConfig public activeConfig;

    constructor() {
        activeConfig =
            block.chainid == LOCAL_CHAIN_ID ? _localConfigWithMocks() : _liveConfigFromEnv();
    }

    /// @notice The active network config (treasury, fee, feeds, token).
    function getConfig() external view returns (NetworkConfig memory) {
        return activeConfig;
    }

    /// @dev Live chains (Arc / Base / zkSync …): read every address from the environment so nothing
    ///      is guessed. `treasury` is required; feed/token addresses are optional here and wired by
    ///      the configure step once the booth/docs values are known.
    function _liveConfigFromEnv() internal view returns (NetworkConfig memory) {
        return NetworkConfig({
            treasury: vm.envAddress("PLATFORM_TREASURY"),
            platformFeeBps: uint16(vm.envOr("PLATFORM_FEE_BPS", uint256(DEFAULT_PLATFORM_FEE_BPS))),
            nativeUsdFeed: vm.envOr("NATIVE_USD_FEED", address(0)),
            usdc: vm.envOr("USDC_ADDRESS", address(0)),
            usdcUsdFeed: vm.envOr("USDC_USD_FEED", address(0))
        });
    }

    /// @dev Local Anvil: deploy mock feeds ($2000 native, $1 USDC) + a mock USDC, and use the
    ///      default sender as treasury. Fully self-contained — `forge script` runs end-to-end with
    ///      no RPC, no env, no real addresses.
    function _localConfigWithMocks() internal returns (NetworkConfig memory) {
        vm.startBroadcast();
        MockV3Aggregator nativeFeed = new MockV3Aggregator(8, 2000e8);
        MockV3Aggregator usdcFeed = new MockV3Aggregator(8, 1e8);
        MockUSDC usdc = new MockUSDC();
        vm.stopBroadcast();

        return NetworkConfig({
            treasury: msg.sender,
            platformFeeBps: DEFAULT_PLATFORM_FEE_BPS,
            nativeUsdFeed: address(nativeFeed),
            usdc: address(usdc),
            usdcUsdFeed: address(usdcFeed)
        });
    }
}
