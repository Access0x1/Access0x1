// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { HouseTokenFactory } from "../../src/HouseTokenFactory.sol";
import { HouseToken } from "../../src/HouseToken.sol";
import { IHouseTokenFactory } from "../../src/interfaces/IHouseTokenFactory.sol";

/// @title  HouseTokenFactoryEdge — Cyfrin UNIT EDGE-CASE suite for {HouseTokenFactory}
/// @author Access0x1
/// @notice The boundary / extreme-value / event-fidelity cases the existing unit file
///         (test/unit/HouseTokenFactory.t.sol) does not pin: the decimals extremes (0 and 255), the
///         maximum possible initial supply (type(uint256).max), unicode/multi-byte metadata, owner ==
///         caller, the FULL `Deployed` event (every field including the token topic, matched against the
///         deterministic CREATE address), the both-fields-empty metadata case, and provenance permanence
///         across the token's own ownership transfer. These are pure unit tests (arrange-act-assert) on a
///         fresh factory — no fuzzing here (that lives in test/fuzz), no script (that lives in
///         test/integration); this file fills the corners the happy-path unit tests skip.
contract HouseTokenFactoryEdgeTest is Test {
    HouseTokenFactory internal factory;

    address internal business = makeAddr("business");
    address internal caller = makeAddr("caller");

    string internal constant NAME = "Acme Loyalty";
    string internal constant SYMBOL = "ACME";

    // Re-declared so the test can `expectEmit` on the factory's event in test scope.
    event Deployed(
        address indexed owner,
        address indexed token,
        address indexed caller,
        string name,
        string symbol,
        uint256 initialSupply
    );

    function setUp() public {
        factory = new HouseTokenFactory();
    }

    /*//////////////////////////////////////////////////////////////
                          DECIMALS — EXTREMES
    //////////////////////////////////////////////////////////////*/

    /// @notice decimals == 0 is a valid, supported configuration (an indivisible whole-unit token, e.g.
    ///         an event ticket / membership seat). Proves the factory does not reject or coerce it.
    function test_edge_decimalsZero() public {
        HouseToken token = HouseToken(factory.deployHouseToken(business, NAME, SYMBOL, 0, 7));
        assertEq(token.decimals(), 0, "0-decimal token is supported as-is");
        assertEq(token.balanceOf(business), 7, "supply is the literal unit count");
        assertEq(token.totalSupply(), 7);
    }

    /// @notice decimals == 255 (max uint8) round-trips intact — the factory passes the byte straight to
    ///         the token's immutable, with no truncation or default-to-18 fallback.
    function test_edge_decimalsMaxUint8() public {
        HouseToken token = HouseToken(factory.deployHouseToken(business, NAME, SYMBOL, 255, 1));
        assertEq(token.decimals(), 255, "max uint8 decimals round-trips");
    }

    /*//////////////////////////////////////////////////////////////
                       INITIAL SUPPLY — EXTREMES
    //////////////////////////////////////////////////////////////*/

    /// @notice The maximum representable supply (type(uint256).max) mints cleanly to the owner with no
    ///         overflow — the token's `_mint` raises totalSupply from 0 to the max in a single step, so
    ///         the boundary holds. Proves conservation even at the arithmetic ceiling.
    function test_edge_maxInitialSupply() public {
        uint256 max = type(uint256).max;
        HouseToken token = HouseToken(factory.deployHouseToken(business, NAME, SYMBOL, 18, max));
        assertEq(token.balanceOf(business), max, "owner holds the maximal supply");
        assertEq(token.totalSupply(), max, "totalSupply == max with no overflow");
        assertEq(token.balanceOf(address(factory)), 0, "factory still holds nothing at the ceiling");
    }

    /// @notice A second `mint` on top of a max-supply token reverts (OZ ERC20 overflow guard) — proving
    ///         the supply ceiling is enforced by the token, and the factory's max-supply deploy does not
    ///         leave a token in a corrupt state. The owner is the one who hits the wall, not the factory.
    function test_edge_maxSupplyThenMintReverts() public {
        HouseToken token =
            HouseToken(factory.deployHouseToken(business, NAME, SYMBOL, 18, type(uint256).max));
        vm.prank(business);
        vm.expectRevert(); // ERC20 total-supply overflow (panic / OZ guard)
        token.mint(business, 1);
    }

    /*//////////////////////////////////////////////////////////////
                       METADATA — EDGE CONTENT
    //////////////////////////////////////////////////////////////*/

    /// @notice A single-byte name/symbol is non-empty and therefore accepted — the guard is strictly
    ///         "length == 0", not a minimum length. Proves the boundary is exactly at the empty string.
    function test_edge_singleByteMetadataAccepted() public {
        HouseToken token = HouseToken(factory.deployHouseToken(business, "A", "B", 18, 1));
        assertEq(token.name(), "A");
        assertEq(token.symbol(), "B");
    }

    /// @notice Multi-byte (unicode) metadata round-trips byte-for-byte — the factory treats name/symbol
    ///         as opaque bytes and never mangles non-ASCII content.
    function test_edge_unicodeMetadataRoundTrips() public {
        string memory uName = unicode"Café Points ★";
        string memory uSym = unicode"☕";
        HouseToken token = HouseToken(factory.deployHouseToken(business, uName, uSym, 18, 0));
        assertEq(token.name(), uName, "unicode name round-trips");
        assertEq(token.symbol(), uSym, "unicode symbol round-trips");
    }

    /// @notice BOTH name and symbol empty still reverts EmptyMetadata (the existing unit file only pins
    ///         each blanked individually). Proves the combined-empty corner is the same single error.
    function test_edge_bothMetadataEmpty_reverts() public {
        vm.expectRevert(IHouseTokenFactory.HouseTokenFactory__EmptyMetadata.selector);
        factory.deployHouseToken(business, "", "", 18, 0);
    }

    /*//////////////////////////////////////////////////////////////
                       OWNER / CALLER IDENTITY EDGES
    //////////////////////////////////////////////////////////////*/

    /// @notice owner == caller (the common self-onboarding case) works and gives that single address both
    ///         ownership AND the full supply. Proves the caller-agnostic factory handles the degenerate
    ///         "I am the business" path identically to the relayer path.
    function test_edge_ownerEqualsCaller() public {
        vm.prank(business);
        HouseToken token = HouseToken(factory.deployHouseToken(business, NAME, SYMBOL, 18, 42e18));
        assertEq(token.owner(), business);
        assertEq(token.balanceOf(business), 42e18, "self-onboarding business holds its own supply");
    }

    /*//////////////////////////////////////////////////////////////
                       EVENT FIDELITY — FULL DATA CHECK
    //////////////////////////////////////////////////////////////*/

    /// @notice The `Deployed` event is emitted with EVERY field correct, including the (indexed) token
    ///         topic — which the existing unit test deliberately skips because it cannot know the address.
    ///         Here we pre-compute the deterministic CREATE address (factory nonce 1 for its first deploy)
    ///         so we can match all four indexed slots + the full data payload. Proves the locked event
    ///         shape carries the real token address an indexer relies on.
    function test_edge_deployedEvent_fullMatchIncludingTokenTopic() public {
        // The token is created by the factory via `new` => CREATE with the factory as deployer. A fresh
        // factory's first contract-creation uses nonce 1 (EIP-161: a new account's nonce starts at 1).
        address predicted = vm.computeCreateAddress(address(factory), 1);

        vm.expectEmit(true, true, true, true, address(factory));
        emit Deployed(business, predicted, caller, NAME, SYMBOL, 1_000e18);

        vm.prank(caller);
        address token = factory.deployHouseToken(business, NAME, SYMBOL, 18, 1_000e18);
        assertEq(token, predicted, "the deployed address matches the predicted CREATE address");
    }

    /*//////////////////////////////////////////////////////////////
                       PROVENANCE PERMANENCE
    //////////////////////////////////////////////////////////////*/

    /// @notice Provenance survives a change of the token's OWNER: after the business hands ownership to a
    ///         new address, `isHouseToken` stays true and `factory()` is unchanged. Proves the
    ///         write-once provenance flag is independent of the token's mutable ownership — the router can
    ///         still trust where the token came from after it changes hands.
    function test_edge_provenanceSurvivesOwnershipTransfer() public {
        address newOwner = makeAddr("newOwner");
        HouseToken token = HouseToken(factory.deployHouseToken(business, NAME, SYMBOL, 18, 1));

        assertTrue(factory.isHouseToken(address(token)));
        vm.prank(business);
        token.transferOwnership(newOwner);

        assertEq(token.owner(), newOwner, "ownership moved");
        assertTrue(
            factory.isHouseToken(address(token)), "provenance is permanent across ownership change"
        );
        assertEq(token.factory(), address(factory), "the factory pointer never changes");
    }

    /// @notice `deployedCount` and provenance are independent per-token: deploying a second token does
    ///         not clear the first's flag, and the count is the exact running total. Proves the mapping is
    ///         additive write-once state, never overwritten.
    function test_edge_provenanceIndependentPerToken() public {
        address t1 = factory.deployHouseToken(business, NAME, SYMBOL, 18, 0);
        address t2 = factory.deployHouseToken(business, "Two", "TWO", 18, 0);
        assertTrue(factory.isHouseToken(t1), "first token's flag survives the second deploy");
        assertTrue(factory.isHouseToken(t2), "second token is flagged too");
        assertEq(factory.deployedCount(), 2, "count is the exact running total");
        // An address that was never deployed stays false even after real deploys exist.
        assertFalse(
            factory.isHouseToken(makeAddr("never")), "an undeployed address is never flagged"
        );
    }
}
