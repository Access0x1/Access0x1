// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";

import { DeployAll } from "../../script/DeployAll.s.sol";
import { CreateXEtch } from "../helpers/CreateXEtch.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { NameMath } from "../../src/NameMath.sol";

/// @title  NameMathIntegration — NameMath proven through the REAL deploy + the live merchant registry
/// @author Access0x1
/// @notice The Cyfrin INTEGRATION tier: instead of a hand-wired `setUp`, this deploys the WHOLE
///         first-party surface through the REAL `DeployAll` script + `HelperConfig` (the same path
///         judges/the owner run), so the deploy script itself is exercised. It then proves NameMath
///         in its REAL composition: a merchant registers on the freshly-deployed `Access0x1Router`
///         with an ENS-style `nameHash`, and that on-chain identity commitment is the SOLE input to
///         the brand layer — `NameMath.colorOf(nameHash)` and `NameMath.identiconSVG(nameHash)`.
///
///         This is the end-to-end story NameMath exists for (see `linkEvent/ENS.md`): the business
///         NEVER picks a color or uploads an avatar; its NAME — committed on-chain at registration —
///         sets both, deterministically, for free, with no storage and no oracle. The test asserts
///         the brand math derived from the LIVE registry's stored `nameHash` is identical to the
///         math derived from the off-chain commitment, i.e. the brand layer and the SDK agree.
///
/// @dev    `using NameMath for bytes32` mirrors exactly how the brand layer / SDK calls it
///         (NameMath is an inlined library of `internal pure` functions — no separate address).
///         The deploy runs against `LOCAL_CHAIN_ID` (31337) so `HelperConfig._localConfigWithMocks`
///         provisions fresh mocks and the script runs offline with no RPC, no env, no real address.
contract NameMathIntegrationTest is Test {
    using NameMath for bytes32;

    /// @dev Mirror of `HelperConfig.LOCAL_CHAIN_ID` — the chainid the deploy script branches on to
    ///      provision local mocks. Setting `block.chainid` to this makes `DeployAll` fully offline.
    uint256 internal constant LOCAL_CHAIN_ID = 31_337;

    /// @dev Foundry's broadcast default sender — the address `vm.startBroadcast()` (no arg) pranks
    ///      as. Mirrored from `test/unit/DeployAll.t.sol`. In a real `forge script --sender $DEPLOYER`
    ///      run `msg.sender` inside `run()` equals the broadcaster, so `owner` (defaulting to
    ///      `msg.sender`) can sign the `onlyOwner` configure calls. Under a unit-test
    ///      `vm.startBroadcast()` the broadcaster is this default sender while `run()`'s `msg.sender`
    ///      is the test contract — so we pin `ROUTER_OWNER` to the broadcaster to reproduce the real
    ///      run's owner-default match, exactly as the DeployAll unit suite does.
    address internal constant BROADCASTER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    Access0x1Router internal router;

    // namehash("acme.access0x1.eth") — the merchant's ENS-style identity commitment, the SAME
    // vector the EndToEnd flow uses. This single bytes32 is the only input to the brand math.
    bytes32 internal constant NAME_HASH = keccak256("acme.access0x1.eth");
    // A second merchant identity, to prove distinct names render distinct brands through the registry.
    bytes32 internal constant NAME_HASH_2 = keccak256("globex.access0x1.eth");

    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient");

    /// @notice Deploy the full estate through the REAL `DeployAll` script (so the deploy is tested,
    ///         not re-implemented here), then capture the live router for the brand-math assertions.
    function setUp() public {
        CreateXEtch.enable(vm);
        // Run on the local chain id so HelperConfig provisions mocks and DeployAll runs offline.
        vm.chainId(LOCAL_CHAIN_ID);
        // A non-zero, stable timestamp (matches the EndToEnd setup convention).
        vm.warp(1_700_000_000);
        // Pin the router owner to the broadcaster so the in-broadcast configure calls are authorized
        // (reproduces the `--sender $DEPLOYER` real-run match where owner defaults to the signer).
        vm.setEnv("ROUTER_OWNER", vm.toString(BROADCASTER));

        // The real one-command deploy. We need only the router for NameMath, but running the whole
        // script proves NameMath composes inside a system that actually stands up end-to-end.
        DeployAll deployer = new DeployAll();
        (Access0x1Router deployedRouter,,) = deployer.run();
        router = deployedRouter;
    }

    /*//////////////////////////////////////////////////////////////
            NAME → BRAND, THROUGH THE LIVE REGISTRY (THE STORY)
    //////////////////////////////////////////////////////////////*/

    /// @notice The merchant's on-chain `nameHash` (read back from the LIVE registry) is the sole
    ///         input to its brand color — the deployed system and the brand layer agree byte-for-byte.
    /// @dev    Proves the integration contract: registration stores the commitment, and the brand
    ///         layer derives the color from THAT stored value via the documented formula. No color is
    ///         ever stored; the registry's `nameHash` is the single source of truth.
    function test_integration_brandColorDerivedFromLiveRegistryNameHash() public {
        // Register through the freshly-deployed router (permissionless; caller becomes owner).
        vm.prank(merchantOwner);
        uint256 merchantId = router.registerMerchant(payout, feeRecipient, 50, NAME_HASH);

        // Read the committed nameHash straight back from the live registry storage.
        (,,,,, bytes32 storedNameHash) = router.merchants(merchantId);
        assertEq(storedNameHash, NAME_HASH, "registry must commit to exactly the ENS nameHash");

        // The brand color derived from the STORED commitment equals the documented SDK-mirror formula.
        bytes3 brandColor = storedNameHash.colorOf();
        assertEq(
            brandColor,
            bytes3(keccak256(abi.encode("color", NAME_HASH))),
            "brand color must equal NameMath.colorOf(stored nameHash)"
        );

        // And the human-facing #RRGGBB the frontend renders is derived from the same stored value.
        string memory brandHex = storedNameHash.colorHex();
        assertEq(bytes(brandHex).length, 7, "#RRGGBB is exactly 7 chars");
        assertEq(bytes(brandHex)[0], bytes1("#"), "CSS-ready hex");
    }

    /// @notice The merchant's identicon — the avatar an ENS resolver / wallet shows — is derived end
    ///         to end from the live registry's `nameHash`, with NO upload and NO stored avatar.
    /// @dev    Renders the full data-URI SVG from the stored commitment and asserts it is the
    ///         data-URI-ready, well-formed artifact a consumer drops into an `<img src>`.
    function test_integration_identiconDerivedFromLiveRegistryNameHash() public {
        vm.prank(merchantOwner);
        uint256 merchantId = router.registerMerchant(payout, feeRecipient, 50, NAME_HASH);
        (,,,,, bytes32 storedNameHash) = router.merchants(merchantId);

        string memory uri = storedNameHash.identiconSVG();
        assertTrue(_startsWith(uri, "data:image/svg+xml;utf8,<svg"), "data-URI-ready identicon");
        assertTrue(_endsWith(uri, "</svg>"), "closes the svg tag");
        // The brand color must paint into the identicon (the avatar IS the brand color foreground).
        assertTrue(
            _contains(uri, string.concat('fill="', storedNameHash.colorHex(), '"')),
            "identicon foreground uses the merchant's brand color"
        );
    }

    /// @notice Two DIFFERENT merchants registered on the SAME deployed router get DIFFERENT brands —
    ///         no two names collide in color or identicon through the real registration path.
    /// @dev    The product promise at the system level: the name alone disambiguates the brand, so
    ///         the registry never needs a color/avatar column and two tenants are visually distinct.
    function test_integration_distinctMerchantsGetDistinctBrands() public {
        vm.prank(merchantOwner);
        uint256 id1 = router.registerMerchant(payout, feeRecipient, 50, NAME_HASH);

        address owner2 = makeAddr("owner2");
        vm.prank(owner2);
        uint256 id2 = router.registerMerchant(payout, feeRecipient, 50, NAME_HASH_2);

        (,,,,, bytes32 n1) = router.merchants(id1);
        (,,,,, bytes32 n2) = router.merchants(id2);
        assertTrue(n1 != n2, "two merchants committed two distinct names");

        // Distinct names ⇒ distinct color OR distinct identicon (keccak distinctness in practice).
        bool colorDiffers = n1.colorOf() != n2.colorOf();
        bool svgDiffers = keccak256(bytes(n1.identiconSVG())) != keccak256(bytes(n2.identiconSVG()));
        assertTrue(colorDiffers || svgDiffers, "distinct tenants must differ in color or identicon");
    }

    /// @notice The brand is STABLE across the merchant's lifecycle: updating mutable config never
    ///         changes the immutable `nameHash`, so the brand color/identicon are pinned forever.
    /// @dev    `nameHash` is immutable post-registration (the Router documents owner+nameHash as
    ///         immutable). A merchant can re-point its payout/feeRecipient, but its brand — being a
    ///         pure function of the immutable name — must not move. This is the "forever" guarantee.
    function test_integration_brandIsStableAcrossMerchantConfigUpdate() public {
        vm.prank(merchantOwner);
        uint256 merchantId = router.registerMerchant(payout, feeRecipient, 50, NAME_HASH);

        bytes3 colorBefore = NAME_HASH.colorOf();
        bytes32 svgHashBefore = keccak256(bytes(NAME_HASH.identiconSVG()));

        // Re-point mutable config (a routine merchant action). nameHash stays immutable by design.
        address newPayout = makeAddr("newPayout");
        address newFeeRecipient = makeAddr("newFeeRecipient");
        vm.prank(merchantOwner);
        router.updateMerchant(merchantId, newPayout, newFeeRecipient, 75, true);

        // The stored commitment is unchanged, so the brand math is unchanged.
        (,,,,, bytes32 storedNameHash) = router.merchants(merchantId);
        assertEq(storedNameHash, NAME_HASH, "nameHash is immutable across config updates");
        assertEq(storedNameHash.colorOf(), colorBefore, "brand color pinned across config update");
        assertEq(
            keccak256(bytes(storedNameHash.identiconSVG())),
            svgHashBefore,
            "identicon pinned across config update"
        );
    }

    /*//////////////////////////////////////////////////////////////
                              HELPERS
    //////////////////////////////////////////////////////////////*/

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory sb = bytes(s);
        bytes memory pb = bytes(prefix);
        if (sb.length < pb.length) return false;
        for (uint256 i = 0; i < pb.length; ++i) {
            if (sb[i] != pb[i]) return false;
        }
        return true;
    }

    function _endsWith(string memory s, string memory suffix) internal pure returns (bool) {
        bytes memory sb = bytes(s);
        bytes memory fb = bytes(suffix);
        if (sb.length < fb.length) return false;
        uint256 offset = sb.length - fb.length;
        for (uint256 i = 0; i < fb.length; ++i) {
            if (sb[offset + i] != fb[i]) return false;
        }
        return true;
    }

    function _contains(string memory s, string memory needle) internal pure returns (bool) {
        bytes memory sb = bytes(s);
        bytes memory nb = bytes(needle);
        if (nb.length == 0 || sb.length < nb.length) return false;
        for (uint256 i = 0; i <= sb.length - nb.length; ++i) {
            bool matched = true;
            for (uint256 j = 0; j < nb.length; ++j) {
                if (sb[i + j] != nb[j]) {
                    matched = false;
                    break;
                }
            }
            if (matched) return true;
        }
        return false;
    }
}
