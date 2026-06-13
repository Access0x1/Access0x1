// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { Access0x1Router } from "../src/Access0x1Router.sol";
import { Access0x1Lanes } from "../src/Access0x1Lanes.sol";
import { HelperConfig } from "./HelperConfig.s.sol";

/// @title  DeployAll
/// @author Access0x1
/// @notice Multi-chain deploy entrypoint. Deploys `Access0x1Router` (and optionally the
///         `Access0x1Lanes` ERC-6909 receipt ledger) on the CURRENT chain, then wires the price
///         feeds + USDC allowlist in the SAME broadcast so judges get one replayable path per chain.
///         Chain-aware via `HelperConfig` — run it once per chain with the matching `--rpc-url`; the
///         `block.chainid` ladder in `HelperConfig` picks the right env block automatically.
/// @dev    Additive to `DeployAccess0x1Router.s.sol` (the Arc-only baseline), not a replacement.
///
///         KEYSTORE ONLY — never pass `--private-key` (the harness PreToolUse guard blocks it). Arc:
///           forge script script/DeployAll.s.sol \
///             --rpc-url $ARC_TESTNET_RPC_URL \
///             --account deployer --sender $DEPLOYER \
///             --broadcast --verify \
///             --verifier blockscout --verifier-url $ARC_SCAN_VERIFIER_URL -vvvv
///
///         Base Sepolia (Basescan verify):
///           forge script script/DeployAll.s.sol \
///             --rpc-url $BASE_SEPOLIA_RPC_URL \
///             --account deployer --sender $DEPLOYER \
///             --broadcast --verify --etherscan-api-key $BASESCAN_API_KEY -vvvv
///
///         zkSync Sepolia (drop to shanghai only if cancun bytecode is rejected — booth confirm):
///           forge script script/DeployAll.s.sol --profile zksync \
///             --rpc-url $ZKSYNC_SEPOLIA_RPC_URL --account deployer --sender $DEPLOYER --broadcast -vvvv
///
///         Set `DEPLOY_PAYMENT_LANES=true` to also deploy `Access0x1Lanes` and authorize the router as
///         a lane minter (`lanes.setMinter(router, true)`) in the same broadcast.
///
///         Every feed/USDC address used by the configure step must be in env BEFORE broadcast. A value
///         that resolves to `address(0)` (feed/USDC not yet booth-confirmed) is SKIPPED, never wired —
///         the operator re-runs the configure once confirmed, so a guess never reaches the live router.
///
///         Record every logged address + tx hash in README.md "Deployed addresses". NEVER invent an
///         address — all values come from the broadcast output (`broadcast/<chainId>/run-latest.json`).
contract DeployAll is Script {
    /// @notice The native-token sentinel: the router keys its native/USD feed at `priceFeedOf[0]`.
    address private constant NATIVE = address(0);

    /// @notice Deploy + configure the router (and optionally the lanes ledger) on the current chain.
    /// @return router       The freshly deployed `Access0x1Router`.
    /// @return lanes        The deployed `Access0x1Lanes`, or `address(0)` when `DEPLOY_PAYMENT_LANES`
    ///                      is unset/false.
    /// @return helperConfig The `HelperConfig` that resolved the current chain (carries the cfg used).
    function run()
        external
        returns (Access0x1Router router, Access0x1Lanes lanes, HelperConfig helperConfig)
    {
        helperConfig = new HelperConfig();
        HelperConfig.NetworkConfig memory cfg = helperConfig.getConfig();

        // The Ownable2Step admin — a burner at the event, a multisig in prod. Defaults to the
        // broadcaster so a local run needs no extra env.
        address owner = vm.envOr("ROUTER_OWNER", msg.sender);
        bool deployLanes = vm.envOr("DEPLOY_PAYMENT_LANES", false);

        vm.startBroadcast();

        // 1. Router. Reverts loudly on a zero treasury or a fee > MAX_FEE_BPS (the router's own
        //    custom errors) — a misconfigured env can never deploy a bad router.
        router = new Access0x1Router(owner, cfg.treasury, cfg.platformFeeBps);
        console2.log("Access0x1Router deployed :", address(router));
        console2.log("  chain                  :", block.chainid);
        console2.log("  owner                  :", owner);
        console2.log("  treasury               :", cfg.treasury);
        console2.log("  platformFeeBps         :", cfg.platformFeeBps);

        // 2. Optional lanes ledger (ERC-6909). Authorize the zero-custody router as a minter so the
        //    router may open/credit lanes at settlement. The lanes contract escrows nothing — a lane
        //    token is a transferable receipt of value the router already pushed to the recipient.
        if (deployLanes) {
            lanes = new Access0x1Lanes(owner);
            lanes.setMinter(address(router), true);
            console2.log("Access0x1Lanes deployed  :", address(lanes));
            console2.log("  router authorized minter:", address(router));
        }

        // 3. Configure feeds + allowlist — skip any address(0) (not booth-confirmed yet). These are
        //    owner-only admin calls, NOT on the payNative/payToken CEI path, so there is no CEI/money
        //    concern here. msg.sender (the broadcaster) is the router owner only when owner defaulted
        //    to it; if ROUTER_OWNER is a separate admin, these onlyOwner calls revert by design and
        //    the operator wires feeds from the admin key — fail-loud, never a silent half-config.
        if (cfg.nativeUsdFeed != NATIVE) {
            router.setPriceFeed(NATIVE, cfg.nativeUsdFeed); // address(0) token = native feed slot
            console2.log("  native/USD feed        :", cfg.nativeUsdFeed);
        }
        if (cfg.usdc != address(0)) {
            router.setTokenAllowed(cfg.usdc, true);
            console2.log("  USDC allowlisted       :", cfg.usdc);
        }
        if (cfg.usdcUsdFeed != address(0)) {
            router.setPriceFeed(cfg.usdc, cfg.usdcUsdFeed);
            console2.log("  USDC/USD feed          :", cfg.usdcUsdFeed);
        }

        vm.stopBroadcast();
    }
}
