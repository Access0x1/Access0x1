// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { HouseTokenFactory } from "../../src/HouseTokenFactory.sol";
import { HouseToken } from "../../src/HouseToken.sol";
import { IHouseTokenFactory } from "../../src/interfaces/IHouseTokenFactory.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @title  HouseTokenFactoryFuzz — Cyfrin STATELESS FUZZ suite for {HouseTokenFactory}
/// @author Access0x1
/// @notice Per-call property fuzzing of the factory's whole external surface. The existing unit file
///         (test/unit/HouseTokenFactory.t.sol) carries two narrow fuzz cases; this file is the dedicated
///         Cyfrin stateless-fuzz layer: every `deployHouseToken` input dimension (owner, name, symbol,
///         decimals, initialSupply, caller) is fuzzed under `bound()`/`vm.assume` constraints, and the
///         contract's core conservation + zero-custody properties are asserted on EVERY single call —
///         not just a happy-path sample. The factory has no money math of its own (it mints nothing, it
///         holds nothing), so the "money" invariant here is the conservation of the deployed token's
///         supply: the FULL minted supply lands with `owner`, the factory's balance is zero, and there is
///         zero residual custody — the analogue of `net + fee == gross` for a contract whose whole job is
///         to hand authority away in the same tx it creates it.
/// @dev    Stateless by construction: each fuzz run gets a FRESH factory in {setUp}, so no run depends on
///         another's state (that is what separates this from the stateful-invariant layer). Mocks are
///         reused from test/mocks where relevant; the factory itself needs none.
contract HouseTokenFactoryFuzzTest is Test, ProxyDeployer {
    HouseTokenFactory internal factory;

    address internal admin = makeAddr("admin"); // the upgrade admin set at initialize

    function setUp() public {
        // Deploy the implementation, then the ERC1967 proxy that initializes it, then drive the proxy.
        address impl = address(new HouseTokenFactory());
        address proxy = deployProxy(impl, abi.encodeCall(HouseTokenFactory.initialize, (admin)));
        factory = HouseTokenFactory(proxy);
    }

    /// @dev Reject the inputs `deployHouseToken` is contractually allowed to reject, so a fuzz run that
    ///      SHOULD succeed is never confused with a legitimate revert. Also keep fuzzed addresses off the
    ///      factory itself and off precompiles, which would skew a balance assertion.
    function _assumeDeployable(address owner_, string memory name_, string memory symbol_)
        internal
        view
    {
        vm.assume(owner_ != address(0));
        vm.assume(owner_ != address(factory));
        vm.assume(uint160(owner_) > 0x09); // skip the 1..9 precompiles
        vm.assume(bytes(name_).length != 0);
        vm.assume(bytes(symbol_).length != 0);
    }

    /*//////////////////////////////////////////////////////////////
        deployHouseToken — SUCCESS PROPERTIES (asserted EVERY call)
    //////////////////////////////////////////////////////////////*/

    /// @notice CONSERVATION + ZERO CUSTODY, fuzzed across the whole input space. Proves that for any
    ///         valid (owner, metadata, decimals, supply, caller): the entire supply is the owner's, the
    ///         factory holds nothing, `totalSupply == initialSupply` (no phantom mint, no skim), the owner
    ///         is the Ownable owner (not the caller, not the factory), decimals round-trips, and the token
    ///         is recorded as house provenance. This is the factory's money invariant — the deployed
    ///         supply is conserved entirely to `owner`, with zero residual custody anywhere else.
    function testFuzz_deploy_conservationAndZeroCustody(
        address owner_,
        address caller_,
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_,
        uint256 supply_
    ) public {
        _assumeDeployable(owner_, name_, symbol_);
        // Bound supply away from the absurd 2^256 tail so balance arithmetic in the token stays sane;
        // uint128 max is already astronomically larger than any real token supply.
        supply_ = bound(supply_, 0, type(uint128).max);

        vm.prank(caller_);
        HouseToken token =
            HouseToken(factory.deployHouseToken(owner_, name_, symbol_, decimals_, supply_));

        // Supply conservation: every minted unit is the owner's; nothing escaped to anyone else.
        assertEq(token.balanceOf(owner_), supply_, "full supply must land with owner");
        assertEq(token.totalSupply(), supply_, "totalSupply must equal the requested initialSupply");

        // Zero custody: the factory holds NO balance over the token it just minted. If owner happens to
        // be the caller, the caller legitimately holds the supply; otherwise the caller holds zero too.
        assertEq(token.balanceOf(address(factory)), 0, "factory must hold zero balance");
        if (caller_ != owner_) {
            assertEq(token.balanceOf(caller_), 0, "a caller that is not the owner holds nothing");
        }

        // Authority lands with the owner, never the factory: the non-custody property is structural.
        assertEq(token.owner(), owner_, "Ownable owner must be the chosen owner");
        assertTrue(token.owner() != address(factory), "factory must never own a deployed token");

        // Metadata + provenance round-trip exactly as requested.
        assertEq(token.decimals(), decimals_, "decimals must round-trip");
        assertEq(token.name(), name_, "name must round-trip");
        assertEq(token.symbol(), symbol_, "symbol must round-trip");
        assertEq(
            token.factory(), address(factory), "token must point back at its deploying factory"
        );
        assertTrue(
            factory.isHouseToken(address(token)), "provenance flag must be set on a real deploy"
        );
        assertEq(factory.deployedCount(), 1, "a single deploy increments the count by exactly one");
    }

    /// @notice The deployed token's authority is the owner's ALONE: for any non-owner address, `mint`
    ///         reverts with Ownable's unauthorized error. Proves the factory cannot, by handing a fuzzed
    ///         caller in, leak mint rights to anyone but the chosen owner.
    function testFuzz_deploy_onlyOwnerCanMint(
        address owner_,
        address stranger_,
        uint256 supply_,
        uint256 mintAmount_
    ) public {
        _assumeDeployable(owner_, "Fuzz", "FZ");
        vm.assume(stranger_ != owner_); // a genuine non-owner
        supply_ = bound(supply_, 0, type(uint128).max);
        mintAmount_ = bound(mintAmount_, 1, type(uint128).max);

        HouseToken token = HouseToken(factory.deployHouseToken(owner_, "Fuzz", "FZ", 18, supply_));

        // A stranger cannot mint.
        vm.prank(stranger_);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger_)
        );
        token.mint(stranger_, mintAmount_);

        // The owner can — and supply grows by exactly the minted amount (conservation under mint).
        uint256 before = token.totalSupply();
        vm.prank(owner_);
        token.mint(owner_, mintAmount_);
        assertEq(
            token.totalSupply(), before + mintAmount_, "owner mint grows supply by exactly amount"
        );
        assertEq(token.balanceOf(owner_), supply_ + mintAmount_, "minted units land with owner");
    }

    /// @notice Counter monotonicity + provenance: N successive deploys (any 1..16) leave `deployedCount`
    ///         at exactly N, every returned token address is distinct, and every one is flagged house.
    ///         Proves the count can only move forward by one per deploy and provenance is never missed.
    function testFuzz_deploy_countMonotonicAndAddressesUnique(uint8 n, address owner_) public {
        _assumeDeployable(owner_, "X", "X");
        uint256 count = bound(uint256(n), 1, 16);

        address[] memory seen = new address[](count);
        for (uint256 i = 0; i < count; ++i) {
            address t = factory.deployHouseToken(owner_, "X", "X", 18, 0);
            // Each new contract address is distinct from every earlier one.
            for (uint256 j = 0; j < i; ++j) {
                assertTrue(t != seen[j], "each deploy must be a fresh, distinct contract");
            }
            seen[i] = t;
            assertTrue(factory.isHouseToken(t), "every deploy records provenance");
            assertEq(factory.deployedCount(), i + 1, "count tracks exactly the number of deploys");
        }
    }

    /*//////////////////////////////////////////////////////////////
        deployHouseToken — REVERT PROPERTIES (asserted EVERY call)
    //////////////////////////////////////////////////////////////*/

    /// @notice Zero owner ALWAYS reverts, for any metadata / decimals / supply / caller. Proves the
    ///         factory never deploys a token whose supply would be minted to nowhere and whose ownership
    ///         would be silently renounced. On revert, the count never moves.
    function testFuzz_deploy_zeroOwnerAlwaysReverts(
        address caller_,
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_,
        uint256 supply_
    ) public {
        vm.assume(bytes(name_).length != 0 && bytes(symbol_).length != 0);
        uint256 countBefore = factory.deployedCount();

        vm.prank(caller_);
        vm.expectRevert(IHouseTokenFactory.HouseTokenFactory__ZeroOwner.selector);
        factory.deployHouseToken(address(0), name_, symbol_, decimals_, supply_);

        assertEq(
            factory.deployedCount(), countBefore, "a reverted deploy must not move the counter"
        );
    }

    /// @notice Empty name OR empty symbol ALWAYS reverts with EmptyMetadata, for any non-zero owner and
    ///         any supply. Proves a house token can never be born unidentifiable, and the failed attempt
    ///         leaves no provenance and no count change.
    function testFuzz_deploy_emptyMetadataAlwaysReverts(
        address owner_,
        bool blankName,
        string calldata other,
        uint256 supply_
    ) public {
        vm.assume(owner_ != address(0));
        // `other` is the field that stays non-empty; the chosen field is blanked.
        vm.assume(bytes(other).length != 0);
        uint256 countBefore = factory.deployedCount();

        string memory name_ = blankName ? "" : other;
        string memory symbol_ = blankName ? other : "";

        vm.expectRevert(IHouseTokenFactory.HouseTokenFactory__EmptyMetadata.selector);
        factory.deployHouseToken(owner_, name_, symbol_, 18, supply_);

        assertEq(
            factory.deployedCount(), countBefore, "a reverted deploy must not move the counter"
        );
    }

    /*//////////////////////////////////////////////////////////////
        isHouseToken — VIEW PROPERTY (asserted EVERY call)
    //////////////////////////////////////////////////////////////*/

    /// @notice For ANY address the factory did not deploy, `isHouseToken` is false. Proves provenance
    ///         cannot be forged by querying an arbitrary address — the flag is set only by a real deploy,
    ///         so the router can trust a `true` result. We fuzz across the full address space and exclude
    ///         only the one address we actually deploy.
    function testFuzz_isHouseToken_falseForAnyUndeployed(address probe, address owner_) public {
        _assumeDeployable(owner_, "Real", "REAL");

        address real = factory.deployHouseToken(owner_, "Real", "REAL", 18, 1);
        vm.assume(probe != real); // anything other than the one we deployed

        assertFalse(factory.isHouseToken(probe), "only a real deploy is ever marked house");
        // And the genuine one is, in the same world — the flag distinguishes them.
        assertTrue(factory.isHouseToken(real), "the real deploy is marked house");
    }
}
