// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {
    IERC6909,
    IERC6909Metadata,
    IERC6909TokenSupply
} from "@openzeppelin/contracts/interfaces/IERC6909.sol";
import { Access0x1Lanes } from "../../src/Access0x1Lanes.sol";

/// @notice PaymentLanes (ERC-6909) unit suite — the lane-id scheme, introspection, and metadata.
///         Mint/transfer/admin land in their own test groups as those functions are built.
contract Access0x1LanesTest is Test {
    Access0x1Lanes internal lanes;

    address internal owner = makeAddr("owner");
    address internal merchant = makeAddr("merchant");
    address internal asset = makeAddr("usdc");

    uint64 internal constant BASE_SELECTOR = 15_971_525_489_660_198_786; // a CCIP-style selector

    function setUp() public {
        lanes = new Access0x1Lanes(owner);
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_constructor_setsOwner() public view {
        assertEq(lanes.owner(), owner);
    }

    /*//////////////////////////////////////////////////////////////
                              LANE ID SCHEME
    //////////////////////////////////////////////////////////////*/

    function test_laneId_isDeterministic() public view {
        uint256 a = lanes.laneId(BASE_SELECTOR, asset, merchant);
        uint256 b = lanes.laneId(BASE_SELECTOR, asset, merchant);
        assertEq(a, b, "same tuple must yield the same id");
    }

    function test_laneId_differsOnEachField() public {
        address otherAsset = makeAddr("otherAsset");
        address otherRecipient = makeAddr("otherRecipient");
        uint256 base = lanes.laneId(BASE_SELECTOR, asset, merchant);
        assertTrue(
            base != lanes.laneId(BASE_SELECTOR + 1, asset, merchant), "chainSelector matters"
        );
        assertTrue(base != lanes.laneId(BASE_SELECTOR, otherAsset, merchant), "asset matters");
        assertTrue(base != lanes.laneId(BASE_SELECTOR, asset, otherRecipient), "recipient matters");
    }

    function testFuzz_laneId_matchesOffchainEncoding(
        uint64 chainSelector,
        address asset_,
        address recipient
    ) public view {
        uint256 expected = uint256(keccak256(abi.encode(chainSelector, asset_, recipient)));
        assertEq(lanes.laneId(chainSelector, asset_, recipient), expected);
    }

    /*//////////////////////////////////////////////////////////////
                              INTROSPECTION
    //////////////////////////////////////////////////////////////*/

    function test_supportsInterface_advertisesFullSurface() public view {
        assertTrue(lanes.supportsInterface(type(IERC165).interfaceId), "ERC-165");
        assertTrue(lanes.supportsInterface(type(IERC6909).interfaceId), "ERC-6909");
        assertTrue(
            lanes.supportsInterface(type(IERC6909TokenSupply).interfaceId), "Token-Supply ext"
        );
        assertTrue(lanes.supportsInterface(type(IERC6909Metadata).interfaceId), "Metadata ext");
    }

    function test_supportsInterface_rejectsUnknown() public view {
        assertFalse(lanes.supportsInterface(0xffffffff), "the ERC-165 invalid sentinel");
        assertFalse(lanes.supportsInterface(0xdeadbeef), "an unrelated id");
    }

    /*//////////////////////////////////////////////////////////////
                                METADATA
    //////////////////////////////////////////////////////////////*/

    function test_metadata_nameAndSymbolAreConstant() public view {
        uint256 id = lanes.laneId(BASE_SELECTOR, asset, merchant);
        assertEq(lanes.name(id), "Access0x1 Payment Lane");
        assertEq(lanes.symbol(id), "a0x1LANE");
    }

    function test_metadata_unopenedLaneHasZeroDecimals() public view {
        uint256 id = lanes.laneId(BASE_SELECTOR, asset, merchant);
        assertEq(lanes.decimals(id), 0, "an unopened lane has no cached decimals yet");
    }

    function test_laneOf_unopenedIsEmpty() public view {
        uint256 id = lanes.laneId(BASE_SELECTOR, asset, merchant);
        (uint64 chainSelector, address asset_, address recipient, uint8 dec) = lanes.laneOf(id);
        assertEq(chainSelector, 0);
        assertEq(asset_, address(0));
        assertEq(recipient, address(0));
        assertEq(dec, 0);
    }

    function test_isMinter_defaultsFalse() public view {
        assertFalse(lanes.isMinter(owner), "no minter is set at construction, not even the owner");
    }

    /*//////////////////////////////////////////////////////////////
                            ADMIN — setMinter
    //////////////////////////////////////////////////////////////*/

    event MinterSet(address indexed minter, bool allowed);

    function test_setMinter_ownerAllowsAndRevokes() public {
        address router = makeAddr("router");

        vm.expectEmit(true, false, false, true, address(lanes));
        emit MinterSet(router, true);
        vm.prank(owner);
        lanes.setMinter(router, true);
        assertTrue(lanes.isMinter(router), "owner allowlisted the router");

        vm.prank(owner);
        lanes.setMinter(router, false);
        assertFalse(lanes.isMinter(router), "owner revoked the router");
    }

    function test_setMinter_revertsForNonOwner() public {
        address stranger = makeAddr("stranger");
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        vm.prank(stranger);
        lanes.setMinter(stranger, true);
    }

    function test_setMinter_revertsZeroAddress() public {
        vm.expectRevert(Access0x1Lanes.Access0x1Lanes__ZeroAddress.selector);
        vm.prank(owner);
        lanes.setMinter(address(0), true);
    }
}
