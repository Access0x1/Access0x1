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
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    OwnableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @notice A trivial v2 implementation used by the upgrade test: a subclass that adds one view function
///         and changes nothing else, so an upgrade to it must preserve all prior state. It deliberately
///         carries no new storage (it would consume from `__gap` if it did), proving the proxy keeps
///         every slot — including the provenance ledger — across the implementation swap.
contract HouseTokenFactoryV2 is HouseTokenFactory {
    /// @notice A marker the original implementation does not expose — lets the test prove the new logic
    ///         is live after {upgradeToAndCall}.
    /// @return The constant string identifying this as the v2 implementation.
    function version2Marker() external pure returns (string memory) {
        return "v2";
    }
}

/// @notice Unit + fuzz suite for the non-custodial {HouseTokenFactory} and the {HouseToken} it deploys.
///         Covers every path of {deployHouseToken} (success, zero-owner, empty metadata, zero supply,
///         custom decimals, distinct caller vs owner) plus the deployed token's owner-only mint, the
///         burn extension, the permit domain, and the core security claim: the factory walks away with
///         NO ownership, NO mint authority, and NO balance — verified both directly and via an
///         adversarial attempt to make the factory exercise authority it must not have. The factory is
///         deployed BEHIND a UUPS proxy (deploy impl → `ERC1967Proxy` with `initialize(...)` calldata →
///         cast the proxy to the type) via the shared {ProxyDeployer}, so every behavioural test
///         exercises the production proxy↔impl shape. Tail tests cover the UUPS upgrade + the permanent
///         freeze via `renounceOwnership`.
contract HouseTokenFactoryTest is Test, ProxyDeployer {
    HouseTokenFactory internal factory;

    /// @dev The contract (upgrade-admin) owner — the `Ownable2Step` owner. Authorizes UUPS upgrades;
    ///      renouncing it freezes the implementation forever. It has NO power over a deployed
    ///      {HouseToken} and does NOT gate {deployHouseToken} (deploying stays permissionless).
    address internal admin = makeAddr("admin");

    address internal business = makeAddr("business"); // the merchant/business wallet (token owner)
    address internal caller = makeAddr("caller"); // a distinct deployer (e.g. an onboarding relayer)
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    string internal constant NAME = "Acme Loyalty";
    string internal constant SYMBOL = "ACME";
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant SUPPLY = 1_000_000e18;

    function setUp() public {
        // Deploy the implementation, then the ERC1967 proxy that initializes it, then drive the proxy.
        address impl = address(new HouseTokenFactory());
        address proxy = deployProxy(impl, abi.encodeCall(HouseTokenFactory.initialize, (admin)));
        factory = HouseTokenFactory(proxy);
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
        emit IHouseTokenFactory.Deployed(
            business, address(0), caller, NAME, SYMBOL, DECIMALS, SUPPLY, block.chainid
        );
        _deploy();
    }

    /// @notice The enriched `Deployed` event carries `decimals` AND `chainId` in its data payload, so a
    ///         consumer can render an amount and place the token on its chain from the log alone — no
    ///         extra eth_call. We match the FULL data here (every field, including the indexed token
    ///         topic via the predicted CREATE address) to pin the new fields exactly.
    function test_deploy_emitsDeployedWithDecimalsAndChainId() public {
        address predicted = vm.computeCreateAddress(address(factory), 1);
        vm.expectEmit(true, true, true, true, address(factory));
        emit IHouseTokenFactory.Deployed(
            business, predicted, caller, "Six DP", "SIX", 6, 1_000e6, block.chainid
        );
        vm.prank(caller);
        factory.deployHouseToken(business, "Six DP", "SIX", 6, 1_000e6);
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

    function test_deploy_badDecimals_reverts() public {
        // decimals > 18 is rejected at the source: a >18-decimal token breaks the router's quote()
        // scaling. 19 is the first illegal value.
        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(IHouseTokenFactory.HouseTokenFactory__BadDecimals.selector, 19)
        );
        factory.deployHouseToken(business, NAME, SYMBOL, 19, SUPPLY);
    }

    function test_deploy_decimals18_isAllowed() public {
        // 18 is the inclusive ceiling — the boundary must succeed (only > 18 reverts).
        vm.prank(caller);
        HouseToken token = HouseToken(factory.deployHouseToken(business, NAME, SYMBOL, 18, SUPPLY));
        assertEq(token.decimals(), 18);
    }

    function test_deploy_badDecimals_leavesNoIndexState() public {
        // A rejected deploy records nothing anywhere — count, enumeration, owner-index all untouched.
        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(IHouseTokenFactory.HouseTokenFactory__BadDecimals.selector, 255)
        );
        factory.deployHouseToken(business, NAME, SYMBOL, 255, SUPPLY);

        assertEq(factory.deployedCount(), 0, "reverted deploy must not bump the count");
        assertEq(factory.allTokensLength(), 0, "reverted deploy must not extend the enumeration");
        assertEq(factory.tokensOf(business).length, 0, "reverted deploy must not index the owner");
    }

    /*//////////////////////////////////////////////////////////////
                       DISCOVERABILITY INDEX + VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice After a deploy the three indexes line up: the owner's `tokensOf` list holds the token, the
    ///         global enumeration holds it at index 0, and `allTokensLength` is 1.
    function test_index_singleDeploy_populatesAllThreeIndexes() public {
        HouseToken token = _deploy();

        address[] memory owned = factory.tokensOf(business);
        assertEq(owned.length, 1, "owner has exactly one token");
        assertEq(owned[0], address(token), "owner-index points at the deployed token");

        assertEq(factory.allTokensLength(), 1, "global enumeration length is 1");
        assertEq(factory.tokenAt(0), address(token), "tokenAt(0) is the deployed token");
    }

    /// @notice `tokenRecord` returns the packed provenance: owner-at-deploy, the deploy timestamp, and
    ///         the deploy chain id (== block.chainid). The on-chain "who/when/where" with no log-scraping.
    function test_index_tokenRecord_fieldsAreCorrect() public {
        vm.warp(1_700_000_000); // a fixed, non-zero timestamp so deployedAt is meaningfully asserted
        HouseToken token = _deploy();

        IHouseTokenFactory.TokenRecord memory rec = factory.tokenRecord(address(token));
        assertEq(rec.owner, business, "record owner is the supply recipient");
        assertEq(
            rec.deployedAt, uint64(block.timestamp), "record deployedAt is the deploy timestamp"
        );
        assertEq(rec.chainId, uint64(block.chainid), "record chainId is the deploy chain");
    }

    /// @notice The record for a token the factory never deployed is the zero record — distinguishable
    ///         from a real one (whose owner is non-zero).
    function test_index_tokenRecord_zeroForUnknown() public view {
        IHouseTokenFactory.TokenRecord memory rec = factory.tokenRecord(address(0xBEEF));
        assertEq(rec.owner, address(0));
        assertEq(rec.deployedAt, 0);
        assertEq(rec.chainId, 0);
    }

    /// @notice One owner deploying several tokens accumulates them in `tokensOf` in deploy order, while a
    ///         different owner's list stays separate. Proves the owner-index is per-owner and additive.
    function test_index_tokensOf_groupsByOwnerInOrder() public {
        vm.startPrank(caller);
        address a1 = factory.deployHouseToken(business, NAME, SYMBOL, 18, SUPPLY);
        address a2 = factory.deployHouseToken(business, "Two", "TWO", 18, 0);
        address b1 = factory.deployHouseToken(alice, "Alice", "ALC", 6, 0);
        vm.stopPrank();

        address[] memory bizTokens = factory.tokensOf(business);
        assertEq(bizTokens.length, 2, "business owns two tokens");
        assertEq(bizTokens[0], a1, "first in deploy order");
        assertEq(bizTokens[1], a2, "second in deploy order");

        address[] memory aliceTokens = factory.tokensOf(alice);
        assertEq(aliceTokens.length, 1, "alice owns one token");
        assertEq(aliceTokens[0], b1);

        // Global enumeration sees all three, in global deploy order.
        assertEq(factory.allTokensLength(), 3);
        assertEq(factory.tokenAt(0), a1);
        assertEq(factory.tokenAt(1), a2);
        assertEq(factory.tokenAt(2), b1);
    }

    /// @notice An owner that has deployed nothing returns an empty `tokensOf` list (not a revert).
    function test_index_tokensOf_emptyForUnknownOwner() public {
        assertEq(factory.tokensOf(makeAddr("nobody")).length, 0);
    }

    /// @notice `tokenAt` reverts on an out-of-bounds index (the array's own bounds check). At length 1,
    ///         index 1 is past the end.
    function test_index_tokenAt_outOfBoundsReverts() public {
        _deploy();
        vm.expectRevert();
        factory.tokenAt(1);
    }

    /// @notice The global enumeration length tracks `deployedCount` exactly across multiple deploys.
    function test_index_allTokensLength_tracksDeployedCount() public {
        assertEq(factory.allTokensLength(), factory.deployedCount());
        _deploy();
        _deploy();
        assertEq(factory.allTokensLength(), 2);
        assertEq(factory.allTokensLength(), factory.deployedCount());
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
        // Stay inside the factory's accepted decimals domain (≤ 18); the > 18 revert is pinned by the
        // dedicated BadDecimals tests, so this success-property fuzz must not stray into that path.
        decimals_ = uint8(bound(uint256(decimals_), 0, 18));

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

    /*//////////////////////////////////////////////////////////////
                          UUPS UPGRADE / FREEZE
    //////////////////////////////////////////////////////////////*/

    function test_initialize_setsAdminOwner() public view {
        // The contract owner is the upgrade admin set at initialize — it gates upgrades ONLY, never a
        // deployed token and never deployHouseToken (which stays permissionless).
        assertEq(OwnableUpgradeable(address(factory)).owner(), admin);
    }

    function test_initialize_revertOnSecondCall() public {
        // The proxy was already initialized in setUp; a second call must revert (one-time initializer).
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        factory.initialize(admin);
    }

    function test_upgrade_preservesStateAndAddsFn() public {
        // Seed state under the v1 implementation: deploy two house tokens so the provenance ledger is
        // non-empty (count == 2, both flagged) before the implementation swap.
        vm.prank(caller);
        address t1 = factory.deployHouseToken(business, NAME, SYMBOL, DECIMALS, SUPPLY);
        vm.prank(caller);
        address t2 = factory.deployHouseToken(alice, "Beta", "BETA", 18, 0);
        assertEq(factory.deployedCount(), 2);

        // The admin (contract owner) upgrades the proxy to v2.
        address v2 = address(new HouseTokenFactoryV2());
        vm.prank(admin);
        UUPSUpgradeable(address(factory)).upgradeToAndCall(v2, "");

        // The new logic is live...
        assertEq(HouseTokenFactoryV2(address(factory)).version2Marker(), "v2");

        // ...and ALL prior state survived the implementation swap (storage lives in the proxy).
        assertEq(factory.deployedCount(), 2);
        assertTrue(factory.isHouseToken(t1));
        assertTrue(factory.isHouseToken(t2));
        assertEq(OwnableUpgradeable(address(factory)).owner(), admin); // upgrade admin unchanged

        // The factory still deploys after the upgrade, continuing the same ledger.
        vm.prank(caller);
        address t3 = factory.deployHouseToken(bob, "Gamma", "GAMMA", 18, 1e18);
        assertEq(factory.deployedCount(), 3);
        assertTrue(factory.isHouseToken(t3));
    }

    function test_upgrade_revertNonOwner() public {
        address v2 = address(new HouseTokenFactoryV2());
        // A non-admin cannot upgrade — _authorizeUpgrade is onlyOwner.
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, bob)
        );
        UUPSUpgradeable(address(factory)).upgradeToAndCall(v2, "");
    }

    function test_freeze_renounceOwnershipBlocksUpgradeForever() public {
        // The admin renounces ownership: the upgrade admin becomes address(0).
        vm.prank(admin);
        OwnableUpgradeable(address(factory)).renounceOwnership();
        assertEq(OwnableUpgradeable(address(factory)).owner(), address(0));

        // With no owner, _authorizeUpgrade reverts for EVERYONE — the implementation is frozen forever.
        address v2 = address(new HouseTokenFactoryV2());
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, admin)
        );
        UUPSUpgradeable(address(factory)).upgradeToAndCall(v2, "");

        // And deploying still works after the freeze — the frozen owner never gated it.
        vm.prank(caller);
        address t = factory.deployHouseToken(business, NAME, SYMBOL, DECIMALS, SUPPLY);
        assertTrue(factory.isHouseToken(t));
    }
}

/// @dev Minimal interface to reach EIP-2612's domain separator on the deployed token without importing
///      the full ERC20Permit type (the token IS-A ERC20Permit; this just exposes the one getter).
interface HouseTokenDomain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
