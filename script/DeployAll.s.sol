// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { Access0x1Router } from "../src/Access0x1Router.sol";
import { PaymentLanes } from "../src/PaymentLanes.sol";
import { SessionGrant } from "../src/SessionGrant.sol";
import { Access0x1Receiver } from "../src/Access0x1Receiver.sol";
import { HouseTokenFactory } from "../src/HouseTokenFactory.sol";
import { Access0x1Subscriptions } from "../src/Access0x1Subscriptions.sol";
import { Access0x1Bookings } from "../src/Access0x1Bookings.sol";
import { Access0x1Invoices } from "../src/Access0x1Invoices.sol";
import { Access0x1GiftCards } from "../src/Access0x1GiftCards.sol";
import { IAccess0x1Router } from "../src/interfaces/IAccess0x1Subscriptions.sol";
import { ISessionGrant } from "../src/interfaces/ISessionGrant.sol";
import { HelperConfig } from "./HelperConfig.s.sol";

/// @title  DeployAll
/// @author Access0x1
/// @notice ONE-COMMAND, multi-chain deploy of the WHOLE first-party surface, wired together in a
///         single broadcast so judges (and the owner) get one replayable path per chain. From the
///         money spine outward, on the CURRENT chain it deploys:
///
///           1. {Access0x1Router}       — the shared, zero-custody money spine (fee-split + in-tx quote).
///           2. {SessionGrant}          — the ERC-7702/6492 "sign once" agent-authorization ledger.
///           3. {PaymentLanes}          — the ERC-6909 receipt ledger (optional; wired into the router).
///           4. {Access0x1Receiver}     — the Chainlink-CRE audit consumer (optional; off the money path).
///           5. {HouseTokenFactory}     — the non-custodial house-ERC-20 factory (deploys {HouseToken}s).
///           6. {Access0x1Subscriptions}— recurring USD billing over the Router + SessionGrant spine.
///           7. {Access0x1Bookings}     — deposit-escrow with a never-blockable refund, over the spine.
///           8. {Access0x1Invoices}     — pay-once USD payment requests over the Router.
///           9. {Access0x1GiftCards}    — prepaid USD balances + coupons over the Router.
///
///         The commerce quartet (6–9) COMPOSES the spine: each is constructed with the freshly
///         deployed Router (and, for Subscriptions/Bookings, the SessionGrant), so `net + fee == gross`,
///         the OracleLib staleness guard, the never-negative meter, and tenant isolation are all
///         inherited from the audited spine, never re-derived. They need NO router-side registration —
///         the Router's merchant registry is their single source of truth for owner-authorization.
///
///         {ChainRegistry} is the twelfth first-party contract; it is a read-only SDK/cross-chain
///         sidecar deployed once per chain by {DeployChainRegistry} and carried here in
///         `HelperConfig.chainRegistry` so its address is logged alongside the rest (re-deploying it
///         from here would fork the registry the SDK already points at). {OracleLib} is an internal
///         library inlined into the Router — it has no standalone address.
/// @dev    Additive to `DeployAccess0x1Router.s.sol` (the Arc-only router baseline), not a replacement.
///         Chain-aware via `HelperConfig` — run it once per chain with the matching `--rpc-url`; the
///         `block.chainid` ladder in `HelperConfig` picks the right env block automatically.
///
///         KEYSTORE ONLY — never pass `--private-key` (the harness PreToolUse guard blocks it). Arc:
///           make deploy-arc            (or the explicit forge invocation below)
///           forge script script/DeployAll.s.sol \
///             --rpc-url $ARC_TESTNET_RPC_URL \
///             --account deployer --sender $DEPLOYER \
///             --broadcast --verify \
///             --verifier blockscout --verifier-url $ARC_SCAN_VERIFIER_URL -vvvv
///
///         Base Sepolia (Basescan verify): `make deploy-base`. zkSync Sepolia: `make deploy-zksync`.
///
///         FLAGS / ENV (all optional; safe defaults keep a bare local/dry run working):
///           - `ROUTER_OWNER`          — Ownable2Step admin for every owned contract; defaults to the
///                                       broadcaster, so a local/burner run self-wires the owner-only
///                                       steps (lanes authorize/wire). With a SEPARATE admin those
///                                       owner-only calls revert by design and the admin finishes the
///                                       wiring from its own key — fail-loud, never a silent half-wire.
///           - `DEPLOY_PAYMENT_LANES`  — `true` to also deploy + wire {PaymentLanes} (default false).
///           - `SESSION_GRANT_NAME` / `SESSION_GRANT_VERSION` — the EIP-712 domain for {SessionGrant}
///                                       (default "Access0x1 SessionGrant" / "1", matching the suite).
///           - `<chain>_SUBS_GRACE_FAILS` — the Subscriptions dunning threshold (HelperConfig; default 3).
///           - `<chain>_CRE_FORWARDER`    — the Chainlink CRE KeystoneForwarder (HelperConfig);
///                                       address(0) ⇒ the off-money-path {Access0x1Receiver} is SKIPPED.
///
///         Every feed/USDC/forwarder address that resolves to `address(0)` (not booth-confirmed yet) is
///         SKIPPED, never wired — the operator re-runs once confirmed, so a guess never reaches a live
///         contract. Record every logged address + tx hash in README.md "Deployments". NEVER invent an
///         address — all values come from the broadcast output (`broadcast/<chainId>/run-latest.json`).
contract DeployAll is Script {
    /// @notice The native-token sentinel: the router keys its native/USD feed at `priceFeedOf[0]`.
    address private constant NATIVE = address(0);

    /// @notice The default EIP-712 domain name for {SessionGrant} (matches the test suite + SDK).
    string private constant DEFAULT_SESSION_GRANT_NAME = "Access0x1 SessionGrant";

    /// @notice The default EIP-712 domain version for {SessionGrant}.
    string private constant DEFAULT_SESSION_GRANT_VERSION = "1";

    /// @notice The rest of the first-party surface, recorded as public state so a test / the SDK / the
    ///         frontend can read every wired address after `run()` without widening the return tuple
    ///         (the tuple stays `(router, lanes, helperConfig)` — the historical shape downstream relies
    ///         on). `receiver` is `address(0)` when no CRE forwarder was configured.
    SessionGrant public sessionGrant;
    Access0x1Receiver public receiver;
    HouseTokenFactory public houseFactory;
    Access0x1Subscriptions public subscriptions;
    Access0x1Bookings public bookings;
    Access0x1Invoices public invoices;
    Access0x1GiftCards public giftCards;

    /// @notice Deploy + wire the full first-party surface (and optionally the lanes ledger + the CRE
    ///         consumer) on the current chain. The commerce quartet, the SessionGrant, the house-token
    ///         factory, and (when configured) the CRE consumer are recorded in this contract's public
    ///         state (read them after the run); the tuple keeps its historical `(router, lanes, cfg)`
    ///         shape so existing callers are unaffected.
    /// @return router       The freshly deployed `Access0x1Router` (the money spine).
    /// @return lanes        The deployed `PaymentLanes`, or `address(0)` when `DEPLOY_PAYMENT_LANES`
    ///                      is unset/false.
    /// @return helperConfig The `HelperConfig` that resolved the current chain (carries the cfg used).
    function run()
        external
        returns (Access0x1Router router, PaymentLanes lanes, HelperConfig helperConfig)
    {
        helperConfig = new HelperConfig();
        HelperConfig.NetworkConfig memory cfg = helperConfig.getConfig();

        // The Ownable2Step admin — a burner at the event, a multisig in prod. Defaults to the
        // broadcaster so a local run needs no extra env.
        address owner = vm.envOr("ROUTER_OWNER", msg.sender);
        bool deployLanes = vm.envOr("DEPLOY_PAYMENT_LANES", false);
        string memory sgName = vm.envOr("SESSION_GRANT_NAME", DEFAULT_SESSION_GRANT_NAME);
        string memory sgVersion = vm.envOr("SESSION_GRANT_VERSION", DEFAULT_SESSION_GRANT_VERSION);

        vm.startBroadcast();

        // 1. Router. Reverts loudly on a zero treasury or a fee > MAX_FEE_BPS (the router's own
        //    custom errors) — a misconfigured env can never deploy a bad router.
        router = new Access0x1Router(owner, cfg.treasury, cfg.platformFeeBps);
        console2.log("Access0x1Router       :", address(router));
        console2.log("  chain               :", block.chainid);
        console2.log("  owner               :", owner);
        console2.log("  treasury            :", cfg.treasury);
        console2.log("  platformFeeBps      :", cfg.platformFeeBps);

        // 2. SessionGrant — the recurring/agent authorization ledger. Holds NO funds (pure accounting),
        //    so it has no owner and nothing to custody; the commerce quartet spends against it but can
        //    only spend, never bypass the budget cap (the never-negative meter lives here).
        sessionGrant = new SessionGrant(sgName, sgVersion);
        console2.log("SessionGrant          :", address(sessionGrant));

        // 3. Optional lanes ledger (ERC-6909). Authorize the zero-custody router on the ledger, then
        //    wire it into the router so `payToken` mints a lane receipt at settlement. The lanes
        //    contract escrows nothing — a lane token is a transferable receipt of value. Order matters:
        //    authorize FIRST (`setRouter`), then wire (`setPaymentLanes`), so the credit leg is live.
        //    Both are `onlyOwner` calls; they execute when `owner` defaulted to the broadcaster (a local
        //    or burner run). With a separate `ROUTER_OWNER` they revert by design and the admin wires
        //    the lanes from its own key — fail-loud, never a silent half-wire.
        if (deployLanes) {
            lanes = new PaymentLanes(owner);
            lanes.setRouter(address(router), true);
            router.setPaymentLanes(address(lanes));
            console2.log("PaymentLanes          :", address(lanes));
            console2.log("  router auth+wired   :", address(router));
        }

        // 4. Optional CRE audit consumer — OFF the money path by construction (a revert here can never
        //    touch a payment). Only deploys when a KeystoneForwarder is configured; a zero forwarder
        //    means the CRE booth value is not confirmed yet, so skip rather than ship a bad forwarder.
        if (cfg.creForwarder != address(0)) {
            receiver = new Access0x1Receiver(cfg.creForwarder, owner);
            console2.log("Access0x1Receiver     :", address(receiver));
            console2.log("  CRE forwarder       :", cfg.creForwarder);
        }

        // 5. House-token factory — no constructor args, no owner, no custody. Businesses deploy their
        //    own ERC-20 THROUGH it later; recorded here so the SDK can trust house-token provenance.
        houseFactory = new HouseTokenFactory();
        console2.log("HouseTokenFactory     :", address(houseFactory));

        // 6-9. The commerce quartet — each COMPOSES the spine above. They take the freshly deployed
        //      Router (and, for Subscriptions/Bookings, the SessionGrant) so the fee-split, the in-tx
        //      USD quote (OracleLib staleness guard), the never-negative budget, and tenant isolation
        //      are all inherited, never re-derived. No router-side registration is needed: the Router's
        //      merchant registry is their single source of truth for owner-authorization.
        subscriptions = new Access0x1Subscriptions(
            owner,
            IAccess0x1Router(address(router)),
            ISessionGrant(address(sessionGrant)),
            cfg.graceFailThreshold
        );
        console2.log("Access0x1Subscriptions:", address(subscriptions));
        console2.log("  router (spine)      :", address(router));
        console2.log("  sessionGrant        :", address(sessionGrant));
        console2.log("  graceFailThreshold  :", cfg.graceFailThreshold);

        bookings = new Access0x1Bookings(owner, address(router), address(sessionGrant));
        console2.log("Access0x1Bookings     :", address(bookings));
        console2.log("  router (spine)      :", address(router));
        console2.log("  sessionGrant        :", address(sessionGrant));

        invoices = new Access0x1Invoices(router);
        console2.log("Access0x1Invoices     :", address(invoices));
        console2.log("  router (spine)      :", address(router));

        giftCards = new Access0x1GiftCards(owner, router);
        console2.log("Access0x1GiftCards    :", address(giftCards));
        console2.log("  router (spine)      :", address(router));

        // ChainRegistry is deployed once per chain by DeployChainRegistry; log its carried address so
        // the full 12-contract surface appears in one place (re-deploying it here would fork the SDK's
        // reference). address(0) ⇒ not deployed/seeded yet on this chain.
        console2.log("ChainRegistry (carried):", cfg.chainRegistry);

        // 10. Configure feeds + allowlist — skip any address(0) (not booth-confirmed yet). These are
        //     owner-only admin calls, NOT on the payNative/payToken CEI path, so there is no CEI/money
        //     concern here. msg.sender (the broadcaster) is the router owner only when owner defaulted
        //     to it; if ROUTER_OWNER is a separate admin, these onlyOwner calls revert by design and
        //     the operator wires feeds from the admin key — fail-loud, never a silent half-config.
        if (cfg.nativeUsdFeed != NATIVE) {
            router.setPriceFeed(NATIVE, cfg.nativeUsdFeed); // address(0) token = native feed slot
            console2.log("  native/USD feed     :", cfg.nativeUsdFeed);
        }
        if (cfg.usdc != address(0)) {
            router.setTokenAllowed(cfg.usdc, true);
            console2.log("  USDC allowlisted    :", cfg.usdc);
        }
        if (cfg.usdcUsdFeed != address(0)) {
            router.setPriceFeed(cfg.usdc, cfg.usdcUsdFeed);
            console2.log("  USDC/USD feed       :", cfg.usdcUsdFeed);
        }

        // 11. Multi-token checkout: allowlist + price-feed the EXTRA pay tokens a buyer may settle in
        //     (WETH/LINK/UNI/ENS/DAI/WBTC), each USD-priced via its own Chainlink <token>/USD feed.
        //     Env-driven, NEVER hardcoded: each `TOKEN_<SYM>_ADDR` + `TOKEN_<SYM>_USD_FEED` pair is read
        //     from env and SKIPPED whenever the address resolves to address(0) (not booth-confirmed yet),
        //     mirroring the USDC handling above. The Router already supports `payToken(any allowlisted
        //     token)` + `setTokenAllowed` + `setPriceFeed`; this wires the token SET. USDC stays the
        //     default and is handled above (its own confirmed vars) — it is NOT re-listed here.
        _configureExtraPayTokens(router);

        vm.stopBroadcast();
    }

    /// @notice The non-USDC pay-token symbols whose env pairs (`TOKEN_<SYM>_ADDR` / `TOKEN_<SYM>_USD_FEED`)
    ///         the deploy reads — the same set the buyer-facing picker offers (lib/tokens.ts), minus USDC
    ///         (its own confirmed vars handle USDC above). PUBLIC tokens/standards — allowlisted only when
    ///         env-confirmed for the chain.
    function _payTokenSymbols() private pure returns (string[6] memory) {
        return ["WETH", "LINK", "UNI", "ENS", "DAI", "WBTC"];
    }

    /// @notice Allowlist + price-feed each env-configured extra pay token on the Router. For each symbol,
    ///         reads `TOKEN_<SYM>_ADDR` and `TOKEN_<SYM>_USD_FEED` (both default to address(0)); a token
    ///         is wired ONLY when its address is non-zero. The feed is set only when ALSO non-zero — an
    ///         allowlisted-but-unfed token would revert at `quote()` (Access0x1__InvalidPrice), surfacing
    ///         loudly rather than mispricing, so a half-configured token never silently settles wrong.
    ///
    ///         Owner-only calls (`setTokenAllowed` / `setPriceFeed`), NOT on the payNative/payToken CEI
    ///         path — no money-path/CEI concern. They execute when `owner` defaulted to the broadcaster;
    ///         with a separate ROUTER_OWNER they revert by design and the admin re-runs from its own key
    ///         (fail-loud, never a silent half-config — same contract as the USDC block above).
    /// @param  router The freshly deployed Router to configure.
    function _configureExtraPayTokens(Access0x1Router router) private {
        string[6] memory syms = _payTokenSymbols();
        for (uint256 i = 0; i < syms.length; i++) {
            address tokenAddr = vm.envOr(string.concat("TOKEN_", syms[i], "_ADDR"), address(0));
            if (tokenAddr == address(0)) continue; // not booth-confirmed on this chain — skip, never guess.

            router.setTokenAllowed(tokenAddr, true);
            console2.log(string.concat("  ", syms[i], " allowlisted    :"), tokenAddr);

            address feed = vm.envOr(string.concat("TOKEN_", syms[i], "_USD_FEED"), address(0));
            if (feed != address(0)) {
                router.setPriceFeed(tokenAddr, feed);
                console2.log(string.concat("  ", syms[i], "/USD feed       :"), feed);
            }
        }
    }
}
