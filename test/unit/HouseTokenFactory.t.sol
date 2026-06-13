// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { ERC20Burnable } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import { HouseTokenFactory } from "../../src/HouseTokenFactory.sol";
import { HouseToken } from "../../src/HouseToken.sol";
import { IHouseTokenFactory } from "../../src/interfaces/IHouseTokenFactory.sol";

/// @notice Unit + fuzz suite for the non-custodial {HouseTokenFactory} and the {HouseToken} it deploys.
///         Covers every path of {deployHouseToken} (success, zero-owner, empty metadata, zero supply,
///         custom decimals, distinct caller vs owner) plus the deployed token's owner-only mint, the
///         burn extension, the permit domain, and the core security claim: the factory walks away with
///         NO ownership, NO mint authority, and NO balance — verified both directly and via an
///         adversarial attempt to make the factory exercise authority it must not have.
contract HouseTokenFactoryTest is Test {
    HouseTokenFactory internal factory;

    address internal business = makeAddr("business"); // the merchant/business wallet (token owner)
    address internal caller = makeAddr("caller"); // a distinct deployer (e.g. an onboarding relayer)
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    string internal constant NAME = "Acme Loyalty";
    string internal constant SYMBOL = "ACME";
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant SUPPLY = 1_000_000e18;

    function setUp() public {
        factory = new HouseTokenFactory();
    }

    /// @dev Deploy a standard house token owned by `business`, called by `caller`.
    function _deploy() internal returns (HouseToken token) {
        vm.prank(caller);
        token = HouseToken(factory.deployHouseToken(business, NAME, SYMBOL, DECIMALS, SUPPLY));
    }

    /*//////////////////////////////////////////////////////////////
                              DEPLOY: SUCCESS
    //////////////////////////////////////////////////////////////*/

    function test_deploy_assignsOwnershipAndSupplyToBusiness() public {
        HouseToken token = _deploy();

        // The business owns the token and holds the ENTIRE supply at deploy.
        assertEq(token.owner(), business, "owner must be the business");
        assertEq(token.balanceOf(business), SUPPLY, "full supply to the business");
        assertEq(token.totalSupply(), SUPPLY, "totalSupply == initialSupply");

        // Metadata is what was requested.
        assertEq(token.name(), NAME);
        assertEq(token.symbol(), SYMBOL);
        assertEq(token.decimals(), DECIMALS);

        // Provenance recorded.
        assertTrue(factory.isHouseToken(address(token)));
        assertEq(factory.deployedCount(), 1);
        assertEq(token.factory(), address(factory));
    }

    function test_deploy_emitsDeployedWithLockedShape() public {
        // We can't know the token address before deploy, so don't match the (indexed) token topic.
        vm.expectEmit(true, false, true, false, address(factory));
        emit IHouseTokenFactory.Deployed(business, address(0), caller, NAME, SYMBOL, SUPPLY);
        _deploy();
    }

    function test_deploy_zeroInitialSupply_mintsNothing() public {
        vm.prank(caller);
        HouseToken token = HouseToken(factory.deployHouseToken(business, NAME, SYMBOL, DECIMALS, 0));

        assertEq(token.totalSupply(), 0, "no supply minted");
        assertEq(token.balanceOf(business), 0);
        // The business can still mint later — it owns the token.
        vm.prank(business);
        token.mint(business, 500e18);
        assertEq(token.balanceOf(business), 500e18);
    }

    function test_deploy_customDecimals() public {
        vm.prank(caller);
        HouseToken token =
            HouseToken(factory.deployHouseToken(business, "Six DP", "SIX", 6, 1_000e6));
        assertEq(token.decimals(), 6);
        assertEq(token.balanceOf(business), 1_000e6);
    }

    function test_deploy_callerDistinctFromOwner_callerGetsNothing() public {
        HouseToken token = _deploy();
        // The DEPLOYER (caller) is not the owner and holds no balance — only `business` does.
        assertEq(token.balanceOf(caller), 0, "deployer holds no supply");
        assertTrue(token.owner() != caller, "deployer is not the owner");
        // The caller cannot mint.
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        token.mint(caller, 1);
    }

    function test_deploy_multiple_incrementsCountAndUniqueAddresses() public {
        vm.prank(caller);
        address t1 = factory.deployHouseToken(business, NAME, SYMBOL, DECIMALS, SUPPLY);
        vm.prank(caller);
        address t2 = factory.deployHouseToken(alice, "Beta", "BETA", 18, 0);

        assertTrue(t1 != t2, "each deploy is a distinct contract");
        assertEq(factory.deployedCount(), 2);
        assertTrue(factory.isHouseToken(t1));
        assertTrue(factory.isHouseToken(t2));
        assertEq(HouseToken(t1).owner(), business);
        assertEq(HouseToken(t2).owner(), alice);
    }

    /*//////////////////////////////////////////////////////////////
                              DEPLOY: REVERTS
    //////////////////////////////////////////////////////////////*/

    function test_deploy_zeroOwner_reverts() public {
        vm.prank(caller);
        vm.expectRevert(IHouseTokenFactory.HouseTokenFactory__ZeroOwner.selector);
        factory.deployHouseToken(address(0), NAME, SYMBOL, DECIMALS, SUPPLY);
    }

    function test_deploy_emptyName_reverts() public {
        vm.prank(caller);
        vm.expectRevert(IHouseTokenFactory.HouseTokenFactory__EmptyMetadata.selector);
        factory.deployHouseToken(business, "", SYMBOL, DECIMALS, SUPPLY);
    }

    function test_deploy_emptySymbol_reverts() public {
        vm.prank(caller);
        vm.expectRevert(IHouseTokenFactory.HouseTokenFactory__EmptyMetadata.selector);
        factory.deployHouseToken(business, NAME, "", DECIMALS, SUPPLY);
    }

    function test_isHouseToken_falseForUnknown() public view {
        assertFalse(factory.isHouseToken(address(0xBEEF)));
    }

    /*//////////////////////////////////////////////////////////////
                       TOKEN: OWNER-ONLY MINT / OWNABLE
    //////////////////////////////////////////////////////////////*/

    function test_token_ownerCanMint() public {
        HouseToken token = _deploy();
        vm.prank(business);
        token.mint(alice, 250e18);
        assertEq(token.balanceOf(alice), 250e18);
        assertEq(token.totalSupply(), SUPPLY + 250e18);
    }

    function test_token_nonOwnerCannotMint() public {
        HouseToken token = _deploy();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        token.mint(bob, 1e18);
    }

    function test_token_ownerCanTransferOwnership() public {
        HouseToken token = _deploy();
        vm.prank(business);
        token.transferOwnership(alice);
        assertEq(token.owner(), alice);
    }

    function test_token_burnable() public {
        HouseToken token = _deploy();
        vm.prank(business);
        ERC20Burnable(address(token)).burn(100e18);
        assertEq(token.balanceOf(business), SUPPLY - 100e18);
        assertEq(token.totalSupply(), SUPPLY - 100e18);
    }

    function test_token_standardTransfer() public {
        HouseToken token = _deploy();
        vm.prank(business);
        IERC20(address(token)).transfer(alice, 10e18);
        assertEq(token.balanceOf(alice), 10e18);
        assertEq(token.balanceOf(business), SUPPLY - 10e18);
    }

    function test_token_permitDomainLive() public {
        // The token must expose a usable EIP-2612 permit surface (router pay path can consume it).
        // We only assert the domain separator is non-zero — a full sig flow is exercised elsewhere.
        // Cast through the minimal interface to confirm the ERC20Permit wiring compiled in.
        HouseToken token = _deploy();
        assertGt(uint256(HouseTokenDomain(address(token)).DOMAIN_SEPARATOR()), 0);
    }

    /*//////////////////////////////////////////////////////////////
            ATTACK: THE FACTORY CANNOT RETAIN ANY AUTHORITY
    //////////////////////////////////////////////////////////////*/

    /// @notice Core security claim, asserted directly: post-deploy the factory holds NO ownership, NO
    ///         mint authority, and NO balance over the token it just created.
    function test_attack_factoryHasNoAuthorityOrBalance() public {
        HouseToken token = _deploy();

        // Not the owner.
        assertTrue(token.owner() != address(factory), "factory must not own the token");

        // Cannot mint — Ownable rejects the factory exactly like any other non-owner.
        vm.prank(address(factory));
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(factory))
        );
        token.mint(address(factory), 1_000_000e18);

        // Holds no balance.
        assertEq(token.balanceOf(address(factory)), 0, "factory must hold no tokens");

        // Cannot transfer ownership to itself.
        vm.prank(address(factory));
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(factory))
        );
        token.transferOwnership(address(factory));
    }

    /// @notice The factory has no admin surface to abuse at all: it exposes only a view (`isHouseToken`,
    ///         `deployedCount`) and the permissionless `deployHouseToken`. There is no setter, no
    ///         owner, no pause — nothing an attacker who seized the factory could use to touch a
    ///         deployed token. We prove the factory cannot retroactively flip provenance either: the
    ///         only way `isHouseToken` becomes true is a real deploy.
    function test_attack_factoryCannotForgeProvenance() public {
        // An arbitrary external token was NOT deployed by us.
        HouseToken rogue = new HouseToken(bob, "Rogue", "ROG", 18, 1);
        assertFalse(
            factory.isHouseToken(address(rogue)),
            "a token not deployed via the factory is never marked house"
        );
        // And the rogue token's factory pointer is THIS test, not our factory — provenance is honest.
        assertEq(rogue.factory(), address(this));
    }

    /*//////////////////////////////////////////////////////////////
                                  FUZZ
    //////////////////////////////////////////////////////////////*/

    function testFuzz_deploy_supplyAllToOwner_factoryZero(
        address owner_,
        uint8 decimals_,
        uint256 supply_
    ) public {
        vm.assume(owner_ != address(0));
        vm.assume(owner_ != address(factory));
        supply_ = bound(supply_, 0, type(uint128).max);

        vm.prank(caller);
        HouseToken token =
            HouseToken(factory.deployHouseToken(owner_, "Fuzz", "FZ", decimals_, supply_));

        // Conservation: every minted unit is the owner's; the factory holds nothing.
        assertEq(token.balanceOf(owner_), supply_);
        assertEq(token.totalSupply(), supply_);
        assertEq(token.balanceOf(address(factory)), 0);
        assertEq(token.owner(), owner_);
        assertEq(token.decimals(), decimals_);
        assertTrue(factory.isHouseToken(address(token)));
    }

    function testFuzz_deploy_zeroOwnerAlwaysReverts(uint256 supply_) public {
        vm.prank(caller);
        vm.expectRevert(IHouseTokenFactory.HouseTokenFactory__ZeroOwner.selector);
        factory.deployHouseToken(address(0), NAME, SYMBOL, DECIMALS, supply_);
    }
}

/// @dev Minimal interface to reach EIP-2612's domain separator on the deployed token without importing
///      the full ERC20Permit type (the token IS-A ERC20Permit; this just exposes the one getter).
interface HouseTokenDomain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
