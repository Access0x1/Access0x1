// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { MembershipToken } from "../../../src/tokens/MembershipToken.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC1155 } from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title  MembershipTokenTest
/// @author Access0x1
/// @notice Coverage for the creator/subscription membership ERC-1155 preset: tier config, mint/renew
///         with time-boxed validity (extend-before-expiry, restart-after-lapse), the read-time active
///         view, soulbound transfer enforcement, per-tier URI, the declared platform-fee ceiling, and
///         the {quoteSplit} that mirrors the router's floor-bps math (fuzzed for rounding parity).
contract MembershipTokenTest is Test {
    MembershipToken internal membership;

    address internal admin = makeAddr("admin");
    address internal minter = makeAddr("minter");
    address internal manager = makeAddr("manager");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint16 internal constant PLATFORM_FEE_BPS = 250; // 2.5%
    uint256 internal constant TIER_GOLD = 1;
    uint256 internal constant PRICE_USD8 = 29e8; // $29.00
    uint64 internal constant PERIOD = 30 days;

    function setUp() public {
        vm.warp(1_700_000_000);
        membership = new MembershipToken("ipfs://base/{id}", admin, PLATFORM_FEE_BPS, treasury);
        vm.startPrank(admin);
        membership.grantRole(membership.MINTER_ROLE(), minter);
        membership.grantRole(membership.MANAGER_ROLE(), manager);
        vm.stopPrank();
        vm.prank(manager);
        membership.setTier(TIER_GOLD, PRICE_USD8, PERIOD, false, "ipfs://gold");
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_constructor_setsAdminAndFee() public view {
        assertTrue(membership.hasRole(membership.DEFAULT_ADMIN_ROLE(), admin));
        assertEq(membership.platformFeeBps(), PLATFORM_FEE_BPS);
        assertEq(membership.platformTreasury(), treasury);
    }

    function test_constructor_revertsZeroAdmin() public {
        vm.expectRevert(MembershipToken.MembershipToken__ZeroAddress.selector);
        new MembershipToken("u", address(0), PLATFORM_FEE_BPS, treasury);
    }

    function test_constructor_revertsFeeTooHigh() public {
        vm.expectRevert(
            abi.encodeWithSelector(MembershipToken.MembershipToken__FeeTooHigh.selector, 1001, 1000)
        );
        new MembershipToken("u", admin, 1001, treasury);
    }

    /*//////////////////////////////////////////////////////////////
                                  TIERS
    //////////////////////////////////////////////////////////////*/

    function test_setTier_onlyManager() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                membership.MANAGER_ROLE()
            )
        );
        vm.prank(alice);
        membership.setTier(2, 1e8, PERIOD, false, "");
    }

    function test_setTier_revertsZeroPeriod() public {
        vm.expectRevert(MembershipToken.MembershipToken__ZeroPeriod.selector);
        vm.prank(manager);
        membership.setTier(2, 1e8, 0, false, "");
    }

    function test_uri_perTierOverride() public view {
        assertEq(membership.uri(TIER_GOLD), "ipfs://gold");
        assertEq(membership.uri(99), "ipfs://base/{id}"); // falls back to base
    }

    /*//////////////////////////////////////////////////////////////
                              MINT / RENEW
    //////////////////////////////////////////////////////////////*/

    function test_mint_happy() public {
        vm.prank(minter);
        uint64 vu = membership.mint(alice, TIER_GOLD, 1);
        assertEq(vu, uint64(block.timestamp) + PERIOD);
        assertEq(membership.balanceOf(alice, TIER_GOLD), 1);
        assertTrue(membership.isActive(alice, TIER_GOLD));
    }

    function test_mint_onlyMinter() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                membership.MINTER_ROLE()
            )
        );
        vm.prank(alice);
        membership.mint(alice, TIER_GOLD, 1);
    }

    function test_mint_revertsUnknownTier() public {
        vm.expectRevert(
            abi.encodeWithSelector(MembershipToken.MembershipToken__TierNotFound.selector, 99)
        );
        vm.prank(minter);
        membership.mint(alice, 99, 1);
    }

    function test_renew_beforeExpiry_extends() public {
        vm.prank(minter);
        uint64 first = membership.mint(alice, TIER_GOLD, 1);
        // renew halfway through: expiry should extend by another full PERIOD from the current expiry
        vm.warp(block.timestamp + PERIOD / 2);
        vm.prank(minter);
        uint64 second = membership.mint(alice, TIER_GOLD, 1);
        assertEq(second, first + PERIOD);
        assertEq(membership.balanceOf(alice, TIER_GOLD), 2);
    }

    function test_renew_afterLapse_restartsFromNow() public {
        vm.prank(minter);
        membership.mint(alice, TIER_GOLD, 1);
        // let it lapse
        vm.warp(block.timestamp + PERIOD + 1 days);
        assertFalse(membership.isActive(alice, TIER_GOLD));
        vm.prank(minter);
        uint64 renewed = membership.mint(alice, TIER_GOLD, 1);
        assertEq(renewed, uint64(block.timestamp) + PERIOD);
        assertTrue(membership.isActive(alice, TIER_GOLD));
    }

    function test_isActive_falseWhenExpired() public {
        vm.prank(minter);
        membership.mint(alice, TIER_GOLD, 1);
        vm.warp(block.timestamp + PERIOD + 1);
        assertFalse(membership.isActive(alice, TIER_GOLD));
        // still holds the token, just not active
        assertEq(membership.balanceOf(alice, TIER_GOLD), 1);
    }

    function test_isActive_falseWhenNoBalance() public view {
        assertFalse(membership.isActive(bob, TIER_GOLD));
    }

    /*//////////////////////////////////////////////////////////////
                               SOULBOUND
    //////////////////////////////////////////////////////////////*/

    function test_transferable_tierMovesFreely() public {
        vm.prank(minter);
        membership.mint(alice, TIER_GOLD, 2);
        vm.prank(alice);
        membership.safeTransferFrom(alice, bob, TIER_GOLD, 1, "");
        assertEq(membership.balanceOf(bob, TIER_GOLD), 1);
    }

    function test_soulbound_blocksTransfer() public {
        uint256 tierPersonal = 7;
        vm.prank(manager);
        membership.setTier(tierPersonal, 1e8, PERIOD, true, "");
        vm.prank(minter);
        membership.mint(alice, tierPersonal, 1);
        vm.expectRevert(
            abi.encodeWithSelector(MembershipToken.MembershipToken__Soulbound.selector, tierPersonal)
        );
        vm.prank(alice);
        membership.safeTransferFrom(alice, bob, tierPersonal, 1, "");
    }

    function test_soulbound_mintStillWorks() public {
        // A soulbound tier must still MINT (from == 0 bypasses the transfer gate) — the personal
        // membership is granted, only wallet-to-wallet resale is blocked.
        uint256 tierPersonal = 7;
        vm.prank(manager);
        membership.setTier(tierPersonal, 1e8, PERIOD, true, "");
        vm.prank(minter);
        membership.mint(alice, tierPersonal, 1);
        assertEq(membership.balanceOf(alice, tierPersonal), 1);
        assertTrue(membership.isActive(alice, tierPersonal));
    }

    function test_soulbound_selfTransferAlsoBlocked() public {
        // Even a same-address "transfer" (from and to both non-zero) is gated for soulbound.
        uint256 tierPersonal = 7;
        vm.prank(manager);
        membership.setTier(tierPersonal, 1e8, PERIOD, true, "");
        vm.prank(minter);
        membership.mint(alice, tierPersonal, 1);
        vm.expectRevert(
            abi.encodeWithSelector(MembershipToken.MembershipToken__Soulbound.selector, tierPersonal)
        );
        vm.prank(alice);
        membership.safeTransferFrom(alice, alice, tierPersonal, 1, "");
    }

    /*//////////////////////////////////////////////////////////////
                              FEE / SPLIT
    //////////////////////////////////////////////////////////////*/

    function test_setPlatformFee_onlyAdmin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                membership.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(alice);
        membership.setPlatformFee(100, treasury);
    }

    function test_setPlatformFee_revertsTooHigh() public {
        vm.expectRevert(
            abi.encodeWithSelector(MembershipToken.MembershipToken__FeeTooHigh.selector, 1001, 1000)
        );
        vm.prank(admin);
        membership.setPlatformFee(1001, treasury);
    }

    function test_quoteSplit_matchesRouterMath() public view {
        (uint256 fee, uint256 net) = membership.quoteSplit(10_000);
        assertEq(fee, 250); // 2.5% of 10_000
        assertEq(net, 9750);
        assertEq(fee + net, 10_000); // conservation
    }

    /// @dev {quoteSplit} must equal the router's exact floor-bps arithmetic for any gross + bps.
    function testFuzz_quoteSplit_conservationAndParity(uint256 gross, uint16 bps) public {
        gross = bound(gross, 0, 1e30);
        bps = uint16(bound(bps, 0, membership.MAX_FEE_BPS()));
        vm.prank(admin);
        membership.setPlatformFee(bps, treasury);
        (uint256 fee, uint256 net) = membership.quoteSplit(gross);
        assertEq(fee, Math.mulDiv(gross, bps, 10_000)); // router uses the same mulDiv floor
        assertEq(fee + net, gross); // never mints or burns value
        assertLe(fee, gross);
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    function test_supportsInterface() public view {
        assertTrue(membership.supportsInterface(type(IERC1155).interfaceId));
        assertTrue(membership.supportsInterface(type(IAccessControl).interfaceId));
        assertTrue(membership.supportsInterface(type(IERC165).interfaceId));
    }
}
