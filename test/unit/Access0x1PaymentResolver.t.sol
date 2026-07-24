// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1PaymentResolver } from "../../src/ens/Access0x1PaymentResolver.sol";
import { IAccess0x1PaymentResolver } from "../../src/interfaces/IAccess0x1PaymentResolver.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice A trivial v2 for the UUPS upgrade test: one added view, no new storage, so the upgrade
///         must preserve every prior slot (router, coinType, bindings).
contract Access0x1PaymentResolverV2 is Access0x1PaymentResolver {
    /// @notice A marker the original does not expose — proves the new logic is live post-upgrade.
    function version2Marker() external pure returns (string memory) {
        return "v2";
    }
}

/// @notice Minimal mock ENS registry for the strong node-control path: a settable `node ⇒ owner` map.
contract MockEnsRegistry {
    mapping(bytes32 => address) public owner;

    function setOwner(bytes32 node, address who) external {
        owner[node] = who;
    }
}

/// @notice Unit suite for {Access0x1PaymentResolver} — ENS as a LIVE payment endpoint. Proves:
///         binding is gated by live merchant ownership; `addr`/`text` read the router at query time
///         (a payout change with NO re-issuance is reflected immediately); the multichain `addr`
///         answers only for THIS chain's ENSIP-11 coinType (the per-chain money-path guard); ENSIP-10
///         `resolve` dispatches the inner `addr`/`text` call; unbound nodes resolve to nothing (never
///         a fabricated address); and the ERC-165 profile advertises the ENS interfaces. Deployed
///         BEHIND a UUPS proxy via the shared {ProxyDeployer}, the production shape.
contract Access0x1PaymentResolverTest is Test, ProxyDeployer {
    using Strings for uint256;
    using Strings for address;

    Access0x1Router internal router;
    Access0x1PaymentResolver internal resolver;

    address internal routerOwner = makeAddr("routerOwner");
    address internal resolverAdmin = makeAddr("resolverAdmin");
    address internal treasury = makeAddr("treasury");
    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%

    address internal merchantOwner = makeAddr("merchantOwner");
    address internal merchantPayout = makeAddr("merchantPayout");
    address internal stranger = makeAddr("stranger");
    bytes32 internal constant NAME_HASH = keccak256("acme");

    /// @dev An opaque ENS namehash — the resolver treats `node` as a key, so any bytes32 works.
    bytes32 internal constant NODE = keccak256("pay.acme.eth");
    bytes32 internal constant UNBOUND_NODE = keccak256("unbound.eth");

    // ENS resolution-profile interface ids (ERC-165).
    bytes4 internal constant ID_ADDR = 0x3b3b57de;
    bytes4 internal constant ID_ADDR_COIN = 0xf1cb7e06;
    bytes4 internal constant ID_TEXT = 0x59d1d43c;
    bytes4 internal constant ID_EXTENDED = 0x9061b923;
    bytes4 internal constant ID_ERC165 = 0x01ffc9a7;

    uint256 internal merchantId;

    function setUp() public {
        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(
                    Access0x1Router.initialize, (routerOwner, treasury, PLATFORM_FEE_BPS)
                )
            )
        );

        resolver = Access0x1PaymentResolver(
            deployProxy(
                address(new Access0x1PaymentResolver()),
                abi.encodeCall(Access0x1PaymentResolver.initialize, (resolverAdmin, router))
            )
        );

        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(merchantPayout, address(0), 0, NAME_HASH);
    }

    // ──────────────────────── bind auth ────────────────────────

    function test_Initialize_ZeroRouter_Reverts() public {
        Access0x1PaymentResolver impl = new Access0x1PaymentResolver();
        vm.expectRevert(IAccess0x1PaymentResolver.Access0x1PaymentResolver__ZeroAddress.selector);
        deployProxy(
            address(impl),
            abi.encodeCall(
                Access0x1PaymentResolver.initialize, (resolverAdmin, Access0x1Router(address(0)))
            )
        );
    }

    function test_Bind_ByMerchantOwner_Succeeds() public {
        vm.expectEmit(true, true, true, true, address(resolver));
        emit IAccess0x1PaymentResolver.NameBound(NODE, merchantId, merchantOwner);
        vm.prank(merchantOwner);
        resolver.bindName(NODE, merchantId);

        assertTrue(resolver.isBound(NODE));
        assertEq(resolver.merchantOf(NODE), merchantId);
    }

    function test_Bind_ByNonOwner_Reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1PaymentResolver.Access0x1PaymentResolver__NotMerchantOwner.selector,
                merchantId,
                stranger
            )
        );
        vm.prank(stranger);
        resolver.bindName(NODE, merchantId);
    }

    function test_Bind_UnknownMerchant_Reverts() public {
        uint256 ghost = merchantId + 999;
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1PaymentResolver.Access0x1PaymentResolver__MerchantUnknown.selector, ghost
            )
        );
        vm.prank(merchantOwner);
        resolver.bindName(NODE, ghost);
    }

    // ──────────────────────── node-control (anti-hijack) ────────────────────────

    /// @dev The hijack the red team found: without a node-control gate, a SECOND merchant seat (freely
    ///      registered by an attacker) could re-bind a name already bound to a victim's seat. The
    ///      first-claim fallback (no registry configured) must now reject it as NotNodeOwner.
    function test_Bind_Rebind_ByStrangerSeat_Reverts() public {
        _bind(); // merchantOwner binds NODE to their seat

        vm.prank(stranger);
        uint256 attackerSeat = router.registerMerchant(stranger, address(0), 0, keccak256("evil"));

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1PaymentResolver.Access0x1PaymentResolver__NotNodeOwner.selector,
                NODE,
                stranger
            )
        );
        vm.prank(stranger);
        resolver.bindName(NODE, attackerSeat);

        // The victim's binding is untouched.
        assertEq(resolver.merchantOf(NODE), merchantId);
    }

    /// @dev A merchant may still re-point their OWN node to another seat they own (overwrite allowed).
    function test_Bind_Rebind_BySameOwner_Succeeds() public {
        _bind();
        vm.prank(merchantOwner);
        uint256 secondSeat =
            router.registerMerchant(merchantPayout, address(0), 0, keccak256("acme2"));

        vm.prank(merchantOwner);
        resolver.bindName(NODE, secondSeat);
        assertEq(resolver.merchantOf(NODE), secondSeat);
    }

    /// @dev With a registry configured, binding requires the caller to be the node's ENS owner even
    ///      for a first claim — the trust-minimized guarantee.
    function test_Bind_WithRegistry_RequiresNodeOwner() public {
        MockEnsRegistry reg = new MockEnsRegistry();
        vm.prank(resolverAdmin);
        resolver.setEnsRegistry(address(reg));

        // Node owned by someone else ⇒ even the seat owner cannot bind.
        reg.setOwner(NODE, stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1PaymentResolver.Access0x1PaymentResolver__NotNodeOwner.selector,
                NODE,
                merchantOwner
            )
        );
        vm.prank(merchantOwner);
        resolver.bindName(NODE, merchantId);

        // Node owned by the caller ⇒ bind succeeds.
        reg.setOwner(NODE, merchantOwner);
        vm.prank(merchantOwner);
        resolver.bindName(NODE, merchantId);
        assertEq(resolver.merchantOf(NODE), merchantId);
    }

    function test_SetEnsRegistry_OnlyOwner_Reverts() public {
        vm.prank(stranger);
        vm.expectRevert();
        resolver.setEnsRegistry(address(0xBEEF));
    }

    // ──────────────────────── live addr ────────────────────────

    function test_Addr_ResolvesLivePayout() public {
        _bind();
        assertEq(resolver.addr(NODE), merchantPayout);
    }

    /// @dev The headline property: change the payout on the router with NO re-issuance, and the name
    ///      resolves to the NEW payout on the very next query.
    function test_Addr_ReflectsPayoutChange_Live() public {
        _bind();
        address newPayout = makeAddr("newPayout");
        vm.prank(merchantOwner);
        router.updateMerchant(merchantId, newPayout, address(0), 0, true);
        assertEq(resolver.addr(NODE), newPayout);
    }

    function test_Addr_UnboundNode_IsZero() public view {
        assertEq(resolver.addr(UNBOUND_NODE), address(0));
    }

    // ──────────────────────── multichain addr (per-chain guard) ────────────────────────

    function test_AddrCoin_ThisChain_ReturnsPayoutBytes() public {
        _bind();
        bytes memory got = resolver.addr(NODE, resolver.chainCoinType());
        assertEq(got, abi.encodePacked(merchantPayout));
    }

    function test_AddrCoin_OtherChain_ReturnsEmpty() public {
        _bind();
        // A different chain's coinType (Base Sepolia 84532) must NOT return this chain's payout.
        uint256 otherCoin = 0x80000000 | uint256(84_532);
        assertEq(resolver.addr(NODE, otherCoin), bytes(""));
    }

    function test_AddrCoin_UnboundNode_ReturnsEmpty() public view {
        assertEq(resolver.addr(UNBOUND_NODE, resolver.chainCoinType()), bytes(""));
    }

    function test_ChainCoinType_IsEnsIp11() public view {
        // Foundry's default chain id is 31337; ENSIP-11 coinType = 0x80000000 | chainId.
        assertEq(resolver.chainCoinType(), 0x80000000 | block.chainid);
    }

    // ──────────────────────── live text records ────────────────────────

    function test_Text_LiveRecords() public {
        _bind();
        assertEq(resolver.text(NODE, "click.access0x1.merchantId"), merchantId.toString());
        assertEq(resolver.text(NODE, "click.access0x1.router"), address(router).toHexString());
        assertEq(resolver.text(NODE, "click.access0x1.chainId"), block.chainid.toString());
        assertEq(resolver.text(NODE, "click.access0x1.pricingCurrency"), "USD");
        assertEq(resolver.text(NODE, "click.access0x1.payout"), merchantPayout.toHexString());
    }

    function test_Text_UnknownKey_IsEmpty() public {
        _bind();
        assertEq(resolver.text(NODE, "com.example.unknown"), "");
    }

    function test_Text_UnboundNode_IsEmpty() public view {
        assertEq(resolver.text(UNBOUND_NODE, "click.access0x1.merchantId"), "");
    }

    // ──────────────────────── ENSIP-10 wildcard resolve ────────────────────────

    function test_Resolve_Addr() public {
        _bind();
        bytes memory data = abi.encodeWithSelector(ID_ADDR, NODE);
        bytes memory out = resolver.resolve(hex"00", data);
        assertEq(abi.decode(out, (address)), merchantPayout);
    }

    function test_Resolve_AddrCoin() public {
        _bind();
        bytes memory data = abi.encodeWithSelector(ID_ADDR_COIN, NODE, resolver.chainCoinType());
        bytes memory out = resolver.resolve(hex"00", data);
        assertEq(abi.decode(out, (bytes)), abi.encodePacked(merchantPayout));
    }

    function test_Resolve_Text() public {
        _bind();
        bytes memory data = abi.encodeWithSelector(ID_TEXT, NODE, "click.access0x1.pricingCurrency");
        bytes memory out = resolver.resolve(hex"00", data);
        assertEq(abi.decode(out, (string)), "USD");
    }

    function test_Resolve_UnsupportedSelector_Reverts() public {
        bytes4 bogus = 0xdeadbeef;
        bytes memory data = abi.encodeWithSelector(bogus, NODE);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1PaymentResolver.Access0x1PaymentResolver__UnsupportedProfile.selector,
                bogus
            )
        );
        resolver.resolve(hex"00", data);
    }

    // ──────────────────────── unbind ────────────────────────

    function test_Unbind_ByOwner_ClearsResolution() public {
        _bind();
        vm.expectEmit(true, true, false, true, address(resolver));
        emit IAccess0x1PaymentResolver.NameUnbound(NODE, merchantId);
        vm.prank(merchantOwner);
        resolver.unbindName(NODE);

        assertFalse(resolver.isBound(NODE));
        assertEq(resolver.addr(NODE), address(0));
        assertEq(resolver.text(NODE, "click.access0x1.merchantId"), "");
    }

    function test_Unbind_ByNonOwner_Reverts() public {
        _bind();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1PaymentResolver.Access0x1PaymentResolver__NotMerchantOwner.selector,
                merchantId,
                stranger
            )
        );
        vm.prank(stranger);
        resolver.unbindName(NODE);
    }

    function test_Unbind_UnboundNode_Reverts() public {
        // An unbound node maps to seat 0, which the router never assigns ⇒ MerchantUnknown(0).
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1PaymentResolver.Access0x1PaymentResolver__MerchantUnknown.selector,
                uint256(0)
            )
        );
        vm.prank(merchantOwner);
        resolver.unbindName(UNBOUND_NODE);
    }

    // ──────────────────────── ERC-165 ────────────────────────

    function test_SupportsInterface_EnsProfiles() public view {
        assertTrue(resolver.supportsInterface(ID_ERC165));
        assertTrue(resolver.supportsInterface(ID_ADDR));
        assertTrue(resolver.supportsInterface(ID_ADDR_COIN));
        assertTrue(resolver.supportsInterface(ID_TEXT));
        assertTrue(resolver.supportsInterface(ID_EXTENDED));
        assertFalse(resolver.supportsInterface(0xffffffff));
        assertFalse(resolver.supportsInterface(0xdeadbeef));
    }

    // ──────────────────────── UUPS upgrade ────────────────────────

    function test_Upgrade_PreservesBindings() public {
        _bind();
        Access0x1PaymentResolverV2 v2 = new Access0x1PaymentResolverV2();
        vm.prank(resolverAdmin);
        resolver.upgradeToAndCall(address(v2), "");

        assertEq(Access0x1PaymentResolverV2(address(resolver)).version2Marker(), "v2");
        // Storage survived the upgrade: the binding and its live resolution are intact.
        assertTrue(resolver.isBound(NODE));
        assertEq(resolver.addr(NODE), merchantPayout);
    }

    function test_Upgrade_ByNonAdmin_Reverts() public {
        Access0x1PaymentResolverV2 v2 = new Access0x1PaymentResolverV2();
        vm.prank(stranger);
        vm.expectRevert();
        resolver.upgradeToAndCall(address(v2), "");
    }

    // ──────────────────────── helpers ────────────────────────

    function _bind() internal {
        vm.prank(merchantOwner);
        resolver.bindName(NODE, merchantId);
    }
}
