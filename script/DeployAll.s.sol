// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { Access0x1Router } from "../src/Access0x1Router.sol";
import { PaymentLanes } from "../src/PaymentLanes.sol";
import { SessionGrant } from "../src/SessionGrant.sol";
import { Access0x1Receiver } from "../src/Access0x1Receiver.sol";
import { HouseTokenFactory } from "../src/HouseTokenFactory.sol";
import { Access0x1Subscriptions } from "../src/Access0x1Subscriptions.sol";
import { Access0x1Bookings } from "../src/Access0x1Bookings.sol";
import { Access0x1Invoices } from "../src/Access0x1Invoices.sol";
import { Access0x1GiftCards } from "../src/Access0x1GiftCards.sol";
import { Access0x1Nft } from "../src/Access0x1Nft.sol";
import { Access0x1Escrow } from "../src/Access0x1Escrow.sol";
import { AutomationGateway } from "../src/AutomationGateway.sol";
import { Access0x1ProvenanceRegistry } from "../src/Access0x1ProvenanceRegistry.sol";
import { GaslessPayIn } from "../src/GaslessPayIn.sol";
import { PriceOracleAdapter } from "../src/PriceOracleAdapter.sol";
import { Receivables } from "../src/Receivables.sol";
import { Refunds } from "../src/Refunds.sol";
import { SplitSettler } from "../src/SplitSettler.sol";
import {
    IAccess0x1Router,
    IAccess0x1Subscriptions
} from "../src/interfaces/IAccess0x1Subscriptions.sol";
import { ISessionGrant } from "../src/interfaces/ISessionGrant.sol";
import { HelperConfig } from "./HelperConfig.s.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { ICreateX } from "./interfaces/ICreateX.sol";

/// @title  DeployAll
/// @author Access0x1
/// @notice ONE-COMMAND, multi-chain deploy of the WHOLE first-party surface, wired together in a
///         single broadcast so judges (and the owner) get one replayable path per chain. From the
///         money spine outward, on the CURRENT chain it deploys:
///
///           1.  {Access0x1Router}        — the shared, zero-custody money spine (fee-split + in-tx quote).
///           2.  {SessionGrant}           — the ERC-7702/6492 "sign once" agent-authorization ledger.
///           3.  {PaymentLanes}           — the ERC-6909 receipt ledger (optional; wired into the router).
///           4.  {Access0x1Receiver}      — the Chainlink-CRE audit consumer (optional; off the money path).
///           5.  {HouseTokenFactory}      — the non-custodial house-ERC-20 factory (deploys {HouseToken}s).
///           6.  {Access0x1ProvenanceRegistry} — the EIP-712 signed-attestation/provenance ledger (no deps).
///           7.  {Access0x1Escrow}        — milestone deposit-escrow that mirrors the Router's live fee-split.
///           8.  {Access0x1Subscriptions} — recurring USD billing over the Router + SessionGrant spine.
///           9.  {AutomationGateway}      — the permissionless keeper front door driving Subscriptions.renew.
///           10. {Access0x1Bookings}      — deposit-escrow with a never-blockable refund, over the spine.
///           11. {Access0x1Invoices}      — pay-once USD payment requests over the Router.
///           12. {Access0x1GiftCards}     — prepaid USD balances + coupons over the Router.
///           13. {Access0x1Nft}           — merchant NFT minting paid through the Router.
///           14. {GaslessPayIn}           — gasless "first-dollar" pay-in from one off-chain signature.
///           15. {Refunds}                — time-boxed, merchant-authorized refunds / chargebacks by orderId.
///           16. {SplitSettler}           — one USD payment fanned out to N payees by basis points.
///           17. {Receivables}            — tokenized, factorable invoices (an ERC-721 the holder is paid on).
///           18. {PriceOracleAdapter}     — a swappable ERC-7726 price-oracle surface (standalone, owner-only).
///
///         The commerce + settlement surface (8–17) plus {Access0x1Escrow} COMPOSES the spine: each is constructed
///         with the freshly deployed Router (and, for Subscriptions/Bookings, the SessionGrant), so
///         `net + fee == gross`, the OracleLib staleness guard, the never-negative meter, and tenant
///         isolation are all inherited from the audited spine, never re-derived. {AutomationGateway}
///         composes {Access0x1Subscriptions} (its permissionless renew driver). They need NO router-side
///         registration — the Router's merchant registry is their single source of truth for
///         owner-authorization. {Access0x1ProvenanceRegistry} + {PriceOracleAdapter} have no on-chain
///         deps (standalone surfaces the SDK reads). {GaslessPayIn}, {Refunds}, {SplitSettler}, and
///         {Receivables} likewise compose the Router, so they mirror on the same uniform init args.
///
///         {ChainRegistry} is the twelfth first-party contract; it is a read-only SDK/cross-chain
///         sidecar deployed once per chain by {DeployChainRegistry} and carried here in
///         `HelperConfig.chainRegistry` so its address is logged alongside the rest (re-deploying it
///         from here would fork the registry the SDK already points at). {OracleLib} is an internal
///         library inlined into the Router — it has no standalone address.
///
///         ── THE MIRROR (same address on every chain) ───────────────────────────────────────────────
///         Every contract is deployed through {ICreateX} CREATE3, so each one lands at the SAME address
///         on every chain — the "one shared router" architecture made literal, and PERMANENTLY: CREATE3
///         derives the address from the salt ALONE (not the init code, not block.chainid), so it survives
///         a future recompile/upgrade and the per-chain USDC/feed config is free to differ without moving
///         the address. The salt is `_mirrorSalt(label)`: the broadcaster's address (20 bytes) ‖ `0x00` ‖
///         an 11-byte tag from the label. That CreateX "permissioned, redeploy-protection-OFF" shape is
///         the ONLY one that is simultaneously (a) identical across chains — the guard excludes
///         `block.chainid` — and (b) front-run-protected — only the broadcaster EOA can claim the address
///         (CreateX requires `salt[0:20] == msg.sender`). Each UUPS proxy carries its `initialize(...)` in
///         its CONSTRUCTOR (OZ 5.x `ERC1967Proxy` reverts `ERC1967ProxyUninitialized()` on empty data),
///         so it is initialized atomically; CREATE3 keeps the address salt-only regardless of that init
///         data. Because the addresses are identical on every chain, they are recorded ONCE in
///         README.md "Deployments". Bump the version segment of {SALT_NAMESPACE} to mint a fresh,
///         non-colliding mirror set.
/// @dev    Chain-aware via `HelperConfig` — run it once per chain with the matching `--rpc-url`; the
///         `block.chainid` ladder in `HelperConfig` picks the right env block automatically. CreateX
///         (`0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`) must be present on the target chain; it is on
///         every Access0x1 testnet except 0G Galileo, where it is bootstrapped once
///         (`make bootstrap-createx-galileo`) via the canonical CREATE2 deployer before this script runs.
///         Local/test EVMs etch CreateX in (see test/helpers/CreateXEtch.sol).
///
///         KEYSTORE ONLY — never pass `--private-key` (the harness PreToolUse guard blocks it). Arc:
///           make deploy-arc            (or the explicit forge invocation)
///           forge script script/DeployAll.s.sol --rpc-url $ARC_TESTNET_RPC_URL \
///             --account deployer --sender $DEPLOYER --broadcast ... -vvvv
///
///         FLAGS / ENV (all optional; safe defaults keep a bare local/dry run working):
///           - `ROUTER_OWNER`          — Ownable2Step admin for every owned contract; defaults to the
///                                       broadcaster. It is baked into every proxy's init code, so for
///                                       the mirror it MUST be the same on every chain.
///           - `DEPLOY_PAYMENT_LANES`  — `true` to also deploy + wire {PaymentLanes} (default false).
///           - `SESSION_GRANT_NAME` / `SESSION_GRANT_VERSION` — the EIP-712 domain for {SessionGrant}.
///           - `<chain>_SUBS_GRACE_FAILS` — the Subscriptions dunning threshold (HelperConfig; default 3).
///           - `<chain>_CRE_FORWARDER`    — the Chainlink CRE KeystoneForwarder (HelperConfig);
///                                       address(0) ⇒ the off-money-path {Access0x1Receiver} is SKIPPED.
///
///         Every feed/USDC/forwarder address that resolves to `address(0)` (not booth-confirmed yet) is
///         SKIPPED, never wired. Each contract's MIRROR address is logged; because they are identical on
///         every chain they are recorded ONCE in README.md. NEVER invent an address — the logged value is
///         reproducible off-chain via `computeCreate3Address`.
contract DeployAll is Script {
    /// @notice The canonical CreateX factory — same address on every EVM chain it is deployed to.
    ICreateX private constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);

    /// @notice The native-token sentinel: the router keys its native/USD feed at `priceFeedOf[0]`.
    address private constant NATIVE = address(0);

    /// @notice Per-feed staleness window for the USDC/USD feed: its 24h (86400s) Chainlink heartbeat
    ///         plus a 1h ingestion margin. The Router's default 1h window would falsely revert
    ///         `quote()` during a quiet stretch even though the price is valid — so USDC/USD is wired
    ///         via the 3-arg `setPriceFeed`. ETH/USD (a 1h-heartbeat feed) keeps the tight 1h default.
    uint256 private constant USDC_FEED_STALENESS = 86_400 + 3600;

    /// @notice The default EIP-712 domain name for {SessionGrant} (matches the test suite + SDK).
    string private constant DEFAULT_SESSION_GRANT_NAME = "Access0x1 SessionGrant";

    /// @notice The default EIP-712 domain version for {SessionGrant}.
    string private constant DEFAULT_SESSION_GRANT_VERSION = "1";

    /// @notice The EIP-712 domain name for {Access0x1ProvenanceRegistry} (matches its own initializer
    ///         default + the test suite, so a signed attestation verifies under one stable domain).
    string private constant PROVENANCE_REGISTRY_NAME = "Access0x1ProvenanceRegistry";

    /// @notice The EIP-712 domain version for {Access0x1ProvenanceRegistry}.
    string private constant PROVENANCE_REGISTRY_VERSION = "1";

    /// @notice ERC-721 collection name / symbol / EIP-7572 contract-URI for the {Receivables} invoice NFT.
    ///         Passed as init args (CREATE3 ignores init code, so the mirror address is unaffected); the
    ///         contract-URI stays empty — collection metadata is set on-chain later, never an invented link.
    string private constant RECEIVABLES_NAME = "Access0x1 Receivables";
    string private constant RECEIVABLES_SYMBOL = "ACXRCV";
    string private constant RECEIVABLES_CONTRACT_URI = "";

    /// @notice The salt-namespace tag. Bump the version segment to mint a NEW mirror address set (e.g.
    ///         a from-scratch redeploy that must not collide with the previous live addresses).
    string private constant SALT_NAMESPACE = "access0x1.v1.";

    /// @notice The canonical mirror deployer EOA the published `script/mirror-manifest.json` addresses
    ///         (and the proven Router proxy 0xe92244…5EB5) were computed for. CREATE3 salts embed the
    ///         signer, so ONLY this EOA reproduces those addresses. The opt-in {_assertCanonicalDeployer}
    ///         guard in {run} checks the broadcaster against this, so a real mirror deploy can never
    ///         SILENTLY land at a different, undocumented address set under the wrong key.
    address private constant CANONICAL_MIRROR_DEPLOYER = 0xA121e1eF31BbF0826aa67dc01e7977e80Af58D73;

    /// @notice The rest of the first-party surface, recorded as public state so a test / the SDK / the
    ///         frontend can read every wired address after `run()` without widening the return tuple
    ///         (the tuple stays `(router, lanes, helperConfig)`). `receiver` is `address(0)` when no CRE
    ///         forwarder was configured.
    SessionGrant public sessionGrant;
    Access0x1Receiver public receiver;
    HouseTokenFactory public houseFactory;
    Access0x1Subscriptions public subscriptions;
    Access0x1Bookings public bookings;
    Access0x1Invoices public invoices;
    Access0x1GiftCards public giftCards;
    Access0x1Nft public nft;
    Access0x1Escrow public escrow;
    AutomationGateway public automationGateway;
    Access0x1ProvenanceRegistry public provenanceRegistry;

    /// @notice The broadcaster captured for the lifetime of the run — the ONLY address allowed to claim
    ///         these CREATE3 salts (CreateX's permissioned-salt guard requires `salt[0:20] == msg.sender`).
    address private deployer;

    /// @notice Build the cross-chain-IDENTICAL, front-run-protected CreateX salt for `label`.
    /// @dev    Shape: `deployer (20 bytes) ‖ 0x00 ‖ bytes11(keccak256(SALT_NAMESPACE ‖ label))`. This is
    ///         CreateX's "permissioned + redeploy-protection-OFF" mode: the guard hashes only
    ///         `(msg.sender, salt)` (NO `block.chainid`), so the SAME EOA gets the SAME address on every
    ///         chain, and `salt[0:20] == msg.sender` stops anyone else from occupying it.
    /// @param  label The contract's unique salt label (e.g. "Access0x1Router.proxy").
    /// @return The 32-byte salt to hand `deployCreate3`.
    function _mirrorSalt(string memory label) private view returns (bytes32) {
        bytes11 tag = bytes11(keccak256(abi.encodePacked(SALT_NAMESPACE, label)));
        return bytes32(abi.encodePacked(deployer, bytes1(0x00), tag));
    }

    /// @notice Deployment manifest accumulated during run() — (contract name, address) for EVERY
    ///         contract deployed. Written to deployments/<chainId>.json at the end so verify-*.sh can
    ///         verify each BY ADDRESS: CREATE3 deploys are factory CALLs (to CreateX), so the contracts
    ///         NEVER appear as top-level CREATEs in the broadcast — this manifest is the reliable source.
    string[] private _manifestNames;
    address[] private _manifestAddrs;

    /// @dev Record a (name, address) pair for the manifest. `name` is the VERIFIABLE contract name
    ///      ("Access0x1Router" for an impl, "ERC1967Proxy" for a proxy) so verify-lib.sh resolves its
    ///      source path.
    function _record(string memory name, address addr) private {
        _manifestNames.push(name);
        _manifestAddrs.push(addr);
    }

    /// @notice Write deployments/<chainId>.json — a JSON array of {name, address} for every deployed
    ///         contract — so the verify scripts verify each by address regardless of the CREATE3
    ///         factory-CALL deploy shape. A cheatcode (no tx); runs after the broadcast.
    function _writeManifest() private {
        // Persist the manifest ONLY during a real `forge script` run (dry-run / broadcast / resume).
        // During `forge test`, many suites call run() concurrently at chainid 31337 and would RACE on
        // the shared deployments/<chainid>.json file — the manifest, like the broadcast, is a DEPLOY
        // artifact, never a test artifact.
        if (!vm.isContext(VmSafe.ForgeContext.ScriptGroup)) {
            return;
        }
        string memory json = "[";
        for (uint256 i = 0; i < _manifestNames.length; i++) {
            json = string.concat(
                json,
                i == 0 ? "" : ",",
                "{\"name\":\"",
                _manifestNames[i],
                "\",\"address\":\"",
                vm.toString(_manifestAddrs[i]),
                "\"}"
            );
        }
        json = string.concat(json, "]");
        vm.createDir("deployments", true);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeFile(path, json);
        console2.log("manifest             :", path);
    }

    /// @notice Opt-in guard: revert when `enforce` is set and the broadcasting `signer` is not the
    ///         configured mirror deployer. A wrong signer otherwise deploys cleanly (NO revert) to a
    ///         DIFFERENT mirror address set — CREATE3 salts embed the signer (see {_mirrorSalt}) — and
    ///         silently diverges from the published `mirror-manifest.json`. Pure + signer-injected so
    ///         the pass AND revert paths are unit-testable with zero env / global state. Default OFF, so
    ///         local/test runs and ad-hoc testnet experiments deploy under any signer; set
    ///         `ENFORCE_MIRROR_DEPLOYER=true` for a real mirror deploy to make a wrong key fail LOUD.
    /// @param  enforce        From `ENFORCE_MIRROR_DEPLOYER` (default false — a loud-but-OPTIONAL rail).
    /// @param  mirrorDeployer From `MIRROR_DEPLOYER` (default {CANONICAL_MIRROR_DEPLOYER}).
    /// @param  signer         The actual broadcaster (`msg.sender` in {run}).
    function _assertCanonicalDeployer(bool enforce, address mirrorDeployer, address signer)
        internal
        pure
    {
        require(!enforce || signer == mirrorDeployer, "DeployAll: signer != canonical mirror EOA");
    }

    /// @notice CREATE3-deploy a UUPS implementation + its `ERC1967Proxy` at MIRROR addresses. Both land
    ///         at the same address on every chain (CREATE3 ignores init code). The proxy carries its
    ///         `initialize(...)` in its constructor (so it is initialized atomically and never left
    ///         uninitialized — OZ 5.x rejects empty proxy data); CREATE3 keeps its address salt-only
    ///         regardless of that chain-specific init data. The impl ran `_disableInitializers()` in its
    ///         constructor, so it can never be initialized directly.
    /// @param  label        The contract's salt label (impl uses `<label>.impl`, proxy `<label>.proxy`).
    /// @param  implInitCode The implementation's full creation code (`type(C).creationCode`).
    /// @param  initCalldata The ABI-encoded initializer (`abi.encodeCall(C.initialize, (..))`).
    /// @return proxy        The deployed `ERC1967Proxy` mirror address — cast it to the contract type.
    function _deployUUPS(string memory label, bytes memory implInitCode, bytes memory initCalldata)
        private
        returns (address proxy)
    {
        address impl =
            CREATEX.deployCreate3(_mirrorSalt(string.concat(label, ".impl")), implInitCode);
        _record(label, impl); // the implementation — verified AS <label> (its real source)
        bytes memory proxyInitCode =
            abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(impl, initCalldata));
        proxy = CREATEX.deployCreate3(_mirrorSalt(string.concat(label, ".proxy")), proxyInitCode);
        _record("ERC1967Proxy", proxy); // the proxy — verified AS ERC1967Proxy (ctor: impl, initData)
    }

    /// @notice Deploy + wire the full first-party surface (and optionally the lanes ledger + the CRE
    ///         consumer) on the current chain, all at MIRROR addresses. The commerce quintet, the
    ///         SessionGrant, the house-token factory, and (when configured) the CRE consumer are recorded
    ///         in this contract's public state; the tuple keeps its historical `(router, lanes, cfg)`
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

        // The broadcaster — the ONLY address that can claim these salts, and the default Ownable2Step
        // admin. `msg.sender` here is the `--sender` EOA.
        deployer = msg.sender;

        // Opt-in mirror-deployer guard: MIRROR_DEPLOYER defaults to the canonical EOA the manifest was
        // computed for; ENFORCE_MIRROR_DEPLOYER=true makes a wrong signer fail LOUD on a real mirror
        // deploy instead of silently landing at a divergent address set. Off by default (no behavior
        // change for local/test runs + ad-hoc testnet experiments).
        _assertCanonicalDeployer(
            vm.envOr("ENFORCE_MIRROR_DEPLOYER", false),
            vm.envOr("MIRROR_DEPLOYER", CANONICAL_MIRROR_DEPLOYER),
            msg.sender
        );

        address owner = vm.envOr("ROUTER_OWNER", msg.sender);
        bool deployLanes = vm.envOr("DEPLOY_PAYMENT_LANES", false);
        string memory sgName = vm.envOr("SESSION_GRANT_NAME", DEFAULT_SESSION_GRANT_NAME);
        string memory sgVersion = vm.envOr("SESSION_GRANT_VERSION", DEFAULT_SESSION_GRANT_VERSION);

        vm.startBroadcast();

        // 1. Router. Reverts loudly on a zero treasury or a fee > MAX_FEE_BPS (the router's own
        //    custom errors) — a misconfigured env can never deploy a bad router.
        router = Access0x1Router(
            _deployUUPS(
                "Access0x1Router",
                type(Access0x1Router).creationCode,
                abi.encodeCall(
                    Access0x1Router.initialize, (owner, cfg.treasury, cfg.platformFeeBps)
                )
            )
        );
        console2.log("Access0x1Router       :", address(router));
        console2.log("  chain               :", block.chainid);
        console2.log("  owner               :", owner);
        console2.log("  treasury            :", cfg.treasury);
        console2.log("  platformFeeBps      :", cfg.platformFeeBps);

        // 2. SessionGrant — the recurring/agent authorization ledger. Holds NO funds (pure accounting),
        //    so it custodies nothing; the commerce quartet spends against it but can only spend, never
        //    bypass the budget cap (the never-negative meter lives here). Its `owner` exists solely to
        //    authorize a UUPS upgrade (`_authorizeUpgrade`), not to touch any balance.
        sessionGrant = SessionGrant(
            _deployUUPS(
                "SessionGrant",
                type(SessionGrant).creationCode,
                abi.encodeCall(SessionGrant.initialize, (sgName, sgVersion, owner))
            )
        );
        console2.log("SessionGrant          :", address(sessionGrant));

        // 3. Optional lanes ledger (ERC-6909). Authorize the zero-custody router on the ledger, then
        //    wire it into the router so `payToken` mints a lane receipt at settlement. Order matters:
        //    authorize FIRST (`setRouter`), then wire (`setPaymentLanes`). Both are `onlyOwner`; they
        //    execute when `owner` defaulted to the broadcaster. With a separate `ROUTER_OWNER` they
        //    revert by design and the admin wires the lanes from its own key — never a silent half-wire.
        if (deployLanes) {
            lanes = PaymentLanes(
                _deployUUPS(
                    "PaymentLanes",
                    type(PaymentLanes).creationCode,
                    abi.encodeCall(PaymentLanes.initialize, (owner))
                )
            );
            lanes.setRouter(address(router), true);
            router.setPaymentLanes(address(lanes));
            console2.log("PaymentLanes          :", address(lanes));
            console2.log("  router auth+wired   :", address(router));
        }

        // 4. Optional CRE audit consumer — OFF the money path by construction. Only deploys when a
        //    KeystoneForwarder is configured. Deployed via CREATE3 too, so it shares the mirror address
        //    even though its constructor takes the chain-specific forwarder (CREATE3 ignores init code).
        if (cfg.creForwarder != address(0)) {
            receiver = Access0x1Receiver(
                CREATEX.deployCreate3(
                    _mirrorSalt("Access0x1Receiver"),
                    abi.encodePacked(
                        type(Access0x1Receiver).creationCode, abi.encode(cfg.creForwarder, owner)
                    )
                )
            );
            _record("Access0x1Receiver", address(receiver));
            console2.log("Access0x1Receiver     :", address(receiver));
            console2.log("  CRE forwarder       :", cfg.creForwarder);
        }

        // 5. House-token factory — no custody. Businesses deploy their own ERC-20 THROUGH it later;
        //    recorded here so the SDK can trust house-token provenance. Its `owner` exists solely to
        //    authorize a UUPS upgrade; it never touches a token or a balance.
        houseFactory = HouseTokenFactory(
            _deployUUPS(
                "HouseTokenFactory",
                type(HouseTokenFactory).creationCode,
                abi.encodeCall(HouseTokenFactory.initialize, (owner))
            )
        );
        console2.log("HouseTokenFactory     :", address(houseFactory));

        // 6. Provenance registry — the EIP-712 signed-attestation ledger. No deps: a standalone
        //    identity/provenance surface the SDK reads, on its own stable EIP-712 domain. Holds no
        //    funds; its `owner` exists solely to authorize a UUPS upgrade.
        provenanceRegistry = Access0x1ProvenanceRegistry(
            _deployUUPS(
                "Access0x1ProvenanceRegistry",
                type(Access0x1ProvenanceRegistry).creationCode,
                abi.encodeCall(
                    Access0x1ProvenanceRegistry.initialize,
                    (PROVENANCE_REGISTRY_NAME, PROVENANCE_REGISTRY_VERSION, owner)
                )
            )
        );
        console2.log("Access0x1ProvenanceRegistry:", address(provenanceRegistry));

        // 7. Escrow — milestone deposit-escrow that COMPOSES the Router (constructed with the freshly
        //    deployed Router proxy) so the release leg mirrors the audited live fee-split. Deployed
        //    AFTER the Router so the dependency exists. Reverts loudly on a zero router.
        escrow = Access0x1Escrow(
            _deployUUPS(
                "Access0x1Escrow",
                type(Access0x1Escrow).creationCode,
                abi.encodeCall(Access0x1Escrow.initialize, (owner, router))
            )
        );
        console2.log("Access0x1Escrow       :", address(escrow));
        console2.log("  router (spine)      :", address(router));

        // 8-12. The commerce quintet — each COMPOSES the spine above. They take the freshly deployed
        //      Router (and, for Subscriptions/Bookings, the SessionGrant) so the fee-split, the in-tx
        //      USD quote, the never-negative budget, and tenant isolation are all inherited. Because the
        //      router + sessionGrant are themselves at mirror addresses, these init args stay uniform
        //      across chains, so the commerce contracts mirror too.
        subscriptions = Access0x1Subscriptions(
            _deployUUPS(
                "Access0x1Subscriptions",
                type(Access0x1Subscriptions).creationCode,
                abi.encodeCall(
                    Access0x1Subscriptions.initialize,
                    (
                        owner,
                        IAccess0x1Router(address(router)),
                        ISessionGrant(address(sessionGrant)),
                        cfg.graceFailThreshold
                    )
                )
            )
        );
        console2.log("Access0x1Subscriptions:", address(subscriptions));
        console2.log("  router (spine)      :", address(router));
        console2.log("  sessionGrant        :", address(sessionGrant));
        console2.log("  graceFailThreshold  :", cfg.graceFailThreshold);

        // AutomationGateway — the permissionless keeper front door that drives Subscriptions.renew. It
        // COMPOSES Subscriptions (constructed with the freshly deployed Subscriptions proxy), deployed
        // AFTER step 8 once that dependency exists. Holds no funds. Reverts loudly on a zero subscriptions.
        automationGateway = AutomationGateway(
            _deployUUPS(
                "AutomationGateway",
                type(AutomationGateway).creationCode,
                abi.encodeCall(
                    AutomationGateway.initialize,
                    (owner, IAccess0x1Subscriptions(address(subscriptions)))
                )
            )
        );
        console2.log("AutomationGateway     :", address(automationGateway));
        console2.log("  subscriptions       :", address(subscriptions));

        bookings = Access0x1Bookings(
            _deployUUPS(
                "Access0x1Bookings",
                type(Access0x1Bookings).creationCode,
                abi.encodeCall(
                    Access0x1Bookings.initialize, (owner, address(router), address(sessionGrant))
                )
            )
        );
        console2.log("Access0x1Bookings     :", address(bookings));
        console2.log("  router (spine)      :", address(router));
        console2.log("  sessionGrant        :", address(sessionGrant));

        invoices = Access0x1Invoices(
            _deployUUPS(
                "Access0x1Invoices",
                type(Access0x1Invoices).creationCode,
                abi.encodeCall(Access0x1Invoices.initialize, (router, owner))
            )
        );
        console2.log("Access0x1Invoices     :", address(invoices));
        console2.log("  router (spine)      :", address(router));

        giftCards = Access0x1GiftCards(
            _deployUUPS(
                "Access0x1GiftCards",
                type(Access0x1GiftCards).creationCode,
                abi.encodeCall(Access0x1GiftCards.initialize, (owner, router))
            )
        );
        console2.log("Access0x1GiftCards    :", address(giftCards));
        console2.log("  router (spine)      :", address(router));

        nft = Access0x1Nft(
            _deployUUPS(
                "Access0x1Nft",
                type(Access0x1Nft).creationCode,
                abi.encodeCall(Access0x1Nft.initialize, (owner, router))
            )
        );
        console2.log("Access0x1Nft          :", address(nft));
        console2.log("  router (spine)      :", address(router));

        // 13-17. Settlement extensions — each composes the spine (or is standalone), so they mirror too.
        //        Their init args are uniform across chains (owner + the mirror Router), so they land at
        //        the same address everywhere. Captured as locals: nothing downstream wires them, and
        //        _deployUUPS already records each in the manifest.
        address gaslessPayIn = _deployUUPS(
            "GaslessPayIn",
            type(GaslessPayIn).creationCode,
            abi.encodeCall(GaslessPayIn.initialize, (owner, router))
        );
        console2.log("GaslessPayIn          :", gaslessPayIn);

        address refunds = _deployUUPS(
            "Refunds",
            type(Refunds).creationCode,
            abi.encodeCall(Refunds.initialize, (owner, router))
        );
        console2.log("Refunds               :", refunds);

        address splitSettler = _deployUUPS(
            "SplitSettler",
            type(SplitSettler).creationCode,
            abi.encodeCall(SplitSettler.initialize, (owner, router))
        );
        console2.log("SplitSettler          :", splitSettler);

        address receivables = _deployUUPS(
            "Receivables",
            type(Receivables).creationCode,
            abi.encodeCall(
                Receivables.initialize,
                (router, owner, RECEIVABLES_NAME, RECEIVABLES_SYMBOL, RECEIVABLES_CONTRACT_URI)
            )
        );
        console2.log("Receivables           :", receivables);

        // PriceOracleAdapter — the swappable ERC-7726 oracle surface; standalone (owner only, no router).
        address priceOracleAdapter = _deployUUPS(
            "PriceOracleAdapter",
            type(PriceOracleAdapter).creationCode,
            abi.encodeCall(PriceOracleAdapter.initialize, (owner))
        );
        console2.log("PriceOracleAdapter    :", priceOracleAdapter);

        // ChainRegistry is deployed once per chain by DeployChainRegistry; log its carried address so
        // the full first-party surface appears in one place. address(0) ⇒ not deployed/seeded yet.
        console2.log("ChainRegistry (carried):", cfg.chainRegistry);

        // 10. Configure feeds + allowlist — skip any address(0) (not booth-confirmed yet). These are
        //     owner-only admin calls, NOT on the payNative/payToken CEI path, and the chain-SPECIFIC
        //     config deliberately kept OUT of the init args (so it never moves a mirror address).
        //     msg.sender (the broadcaster) is the router owner only when owner defaulted to it.
        if (cfg.nativeUsdFeed != NATIVE) {
            router.setPriceFeed(NATIVE, cfg.nativeUsdFeed); // address(0) token = native feed slot
            console2.log("  native/USD feed     :", cfg.nativeUsdFeed);
        }
        if (cfg.usdc != address(0)) {
            router.setTokenAllowed(cfg.usdc, true);
            console2.log("  USDC allowlisted    :", cfg.usdc);
        }
        // Guard on the USDC TOKEN too: with usdc == address(0), setPriceFeed(address(0), ...) would
        // write the USDC/USD aggregator into the NATIVE feed slot (token address(0) IS the native slot),
        // mispricing native at ~$1 instead of its real ~$3000. Only wire the USDC feed when the USDC
        // token itself is booth-confirmed. The native feed above is set on its own, independently.
        if (cfg.usdc != address(0) && cfg.usdcUsdFeed != address(0)) {
            // USDC/USD publishes on a 24h heartbeat, so it needs a wider-than-default staleness window
            // (the 3-arg overload); the 1h default would falsely revert quote() during a quiet stretch.
            router.setPriceFeed(cfg.usdc, cfg.usdcUsdFeed, USDC_FEED_STALENESS);
            console2.log("  USDC/USD feed       :", cfg.usdcUsdFeed);
            console2.log("  USDC/USD staleness  :", USDC_FEED_STALENESS);
        }

        // 11. Multi-token checkout: allowlist + price-feed the EXTRA pay tokens a buyer may settle in
        //     (WETH/LINK/UNI/ENS/DAI/WBTC), each USD-priced via its own Chainlink <token>/USD feed.
        //     Env-driven, NEVER hardcoded: each `TOKEN_<SYM>_ADDR` + `TOKEN_<SYM>_USD_FEED` pair is read
        //     from env and SKIPPED whenever the address resolves to address(0). USDC stays the default
        //     and is handled above (its own confirmed vars) — it is NOT re-listed here.
        _configureExtraPayTokens(router);

        vm.stopBroadcast();

        // Emit the address manifest the verify-*.sh scripts read. CREATE3 deploys are factory CALLs, so
        // the contracts never appear as top-level CREATEs in the broadcast — this name->address map is
        // what makes `make verify-<chain>` able to find + verify every contract.
        _writeManifest();
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
    ///         path. They execute when `owner` defaulted to the broadcaster; with a separate ROUTER_OWNER
    ///         they revert by design and the admin re-runs from its own key (never a silent half-config).
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
