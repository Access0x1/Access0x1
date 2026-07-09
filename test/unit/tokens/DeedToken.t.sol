// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { DeedToken } from "../../../src/tokens/DeedToken.sol";
import { Access0x1RwaToken } from "../../../src/Access0x1RwaToken.sol";
import { IERC7943NonFungible } from "../../../src/interfaces/IERC7943NonFungible.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC721Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice A minimal stand-in fractional-wrapper factory: it receives a locked deed and (in a real
///         deployment) would mint a fractional ERC-20 supply; here it just holds the deed and forwards
///         the (un)lock calls. Implements {onERC721Received} so a `safeTransferFrom` lands, and exposes
///         the two calls the DeedToken guards. Kept trivial — the DeedToken's guards are what's tested.
contract MockFractionalizer is IERC721Receiver {
    DeedToken public deed;

    function setDeed(DeedToken deed_) external {
        deed = deed_;
    }

    /// @dev Pull a consenting holder's deed in (holder must have approved this contract for the token).
    function lock(uint256 tokenId, address holder) external {
        deed.lockForFraction(tokenId, holder);
    }

    /// @dev Return the whole deed to a compliant holder.
    function redeem(uint256 tokenId, address to) external {
        deed.redeemFromFraction(tokenId, to);
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @title  DeedTokenTest
/// @author Access0x1
/// @notice Coverage for the RWA-deed preset on the uRWA base: deed metadata (registry ref + URI),
///         inherited compliance (mint requires canReceive; transfer requires both endpoints + unfrozen;
///         forcedTransfer + freeze work), and the param'd fractionalization hook (only the configured
///         fractionalizer may lock/redeem, only with holder consent, compliance still applies, and the
///         locked flag round-trips). Confirms a DeedToken is a full ERC-7943 token by inheritance.
contract DeedTokenTest is Test {
    DeedToken internal deed;
    MockFractionalizer internal frac;

    address internal admin = makeAddr("admin");
    address internal issuer = makeAddr("issuer"); // MINTER + BURNER
    address internal regulator = makeAddr("regulator"); // FREEZER + FORCE_TRANSFER
    address internal registrar = makeAddr("registrar"); // WHITELIST
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory"); // never allowlisted

    uint256 internal constant DEED_ID = 1;
    bytes32 internal constant REGISTRY_REF = keccak256("parcel-123");

    bytes32 internal minterRole;
    bytes32 internal freezerRole;
    bytes32 internal forceTransferRole;
    bytes32 internal whitelistRole;
    bytes32 internal adminRole;

    function setUp() public {
        deed = new DeedToken("Access Deeds", "DEED", admin);
        frac = new MockFractionalizer();
        frac.setDeed(deed);

        minterRole = deed.MINTER_ROLE();
        freezerRole = deed.FREEZER_ROLE();
        forceTransferRole = deed.FORCE_TRANSFER_ROLE();
        whitelistRole = deed.WHITELIST_ROLE();
        adminRole = deed.DEFAULT_ADMIN_ROLE();

        vm.startPrank(admin);
        deed.grantRole(minterRole, issuer);
        deed.grantRole(deed.BURNER_ROLE(), issuer);
        deed.grantRole(freezerRole, regulator);
        deed.grantRole(forceTransferRole, regulator);
        deed.grantRole(whitelistRole, registrar);
        vm.stopPrank();

        vm.startPrank(registrar);
        deed.setWhitelisted(alice, true);
        deed.setWhitelisted(bob, true);
        deed.setWhitelisted(address(frac), true); // the fractionalizer must be a compliant endpoint
        vm.stopPrank();
    }

    function _mintToAlice() internal {
        vm.prank(issuer);
        deed.mintDeed(alice, DEED_ID, REGISTRY_REF, "ipfs://deed");
    }

    /*//////////////////////////////////////////////////////////////
                             MINT + METADATA
    //////////////////////////////////////////////////////////////*/

    function test_mintDeed_recordsMetadata() public {
        _mintToAlice();
        assertEq(deed.ownerOf(DEED_ID), alice);
        assertEq(deed.registryRefOf(DEED_ID), REGISTRY_REF);
        assertEq(deed.tokenURI(DEED_ID), "ipfs://deed");
    }

    function test_mintDeed_onlyMinter() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, minterRole
            )
        );
        vm.prank(alice);
        deed.mintDeed(alice, DEED_ID, REGISTRY_REF, "");
    }

    function test_mintDeed_revertsNonCompliantReceiver() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC7943NonFungible.ERC7943CannotReceive.selector, mallory)
        );
        vm.prank(issuer);
        deed.mintDeed(mallory, DEED_ID, REGISTRY_REF, "");
    }

    function test_tokenURI_revertsNonexistent() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99));
        deed.tokenURI(99);
    }

    /*//////////////////////////////////////////////////////////////
                       INHERITED COMPLIANCE (uRWA base)
    //////////////////////////////////////////////////////////////*/

    function test_transfer_bothEndpointsGated() public {
        _mintToAlice();
        // alice → bob: both allowlisted, ok
        vm.prank(alice);
        deed.transferFrom(alice, bob, DEED_ID);
        assertEq(deed.ownerOf(DEED_ID), bob);
        // bob → mallory: mallory not allowlisted, blocked
        vm.expectRevert(
            abi.encodeWithSelector(IERC7943NonFungible.ERC7943CannotReceive.selector, mallory)
        );
        vm.prank(bob);
        deed.transferFrom(bob, mallory, DEED_ID);
    }

    function test_freeze_blocksTransfer() public {
        _mintToAlice();
        vm.prank(regulator);
        deed.setFrozenTokens(alice, DEED_ID, true);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC7943NonFungible.ERC7943InsufficientUnfrozenBalance.selector, alice, DEED_ID
            )
        );
        vm.prank(alice);
        deed.transferFrom(alice, bob, DEED_ID);
    }

    function test_forcedTransfer_worksByInheritance() public {
        _mintToAlice();
        vm.prank(regulator);
        deed.forcedTransfer(alice, bob, DEED_ID);
        assertEq(deed.ownerOf(DEED_ID), bob);
    }

    function test_supportsInterface_isUrwa() public view {
        assertTrue(deed.supportsInterface(type(IERC7943NonFungible).interfaceId));
        assertTrue(deed.supportsInterface(type(IERC721).interfaceId));
    }

    /*//////////////////////////////////////////////////////////////
                            FRACTIONALIZATION
    //////////////////////////////////////////////////////////////*/

    function test_setFractionalizer_onlyAdmin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, adminRole
            )
        );
        vm.prank(alice);
        deed.setFractionalizer(address(frac));
    }

    function test_lockForFraction_happy() public {
        _mintToAlice();
        vm.prank(admin);
        deed.setFractionalizer(address(frac));
        // holder consents by approving the fractionalizer for the token
        vm.prank(alice);
        deed.approve(address(frac), DEED_ID);
        // fractionalizer pulls the deed in
        frac.lock(DEED_ID, alice);
        assertEq(deed.ownerOf(DEED_ID), address(frac));
        assertTrue(deed.isFractionLocked(DEED_ID));
    }

    function test_lockForFraction_revertsWithoutConsent() public {
        _mintToAlice();
        vm.prank(admin);
        deed.setFractionalizer(address(frac));
        // no approval given → the base transfer's approval check reverts
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC721Errors.ERC721InsufficientApproval.selector, address(frac), DEED_ID
            )
        );
        frac.lock(DEED_ID, alice);
    }

    function test_lockForFraction_onlyFractionalizer() public {
        _mintToAlice();
        vm.prank(admin);
        deed.setFractionalizer(address(frac));
        vm.prank(alice);
        deed.approve(alice, DEED_ID);
        vm.expectRevert(
            abi.encodeWithSelector(DeedToken.DeedToken__NotFractionalizer.selector, alice)
        );
        vm.prank(alice);
        deed.lockForFraction(DEED_ID, alice);
    }

    function test_lockForFraction_disabledWhenUnset() public {
        _mintToAlice();
        // fractionalizer never set (address(0)) → any caller is rejected
        vm.expectRevert(
            abi.encodeWithSelector(DeedToken.DeedToken__NotFractionalizer.selector, address(this))
        );
        deed.lockForFraction(DEED_ID, alice);
    }

    function test_lockForFraction_revertsDoubleLock() public {
        _mintToAlice();
        vm.prank(admin);
        deed.setFractionalizer(address(frac));
        vm.prank(alice);
        deed.approve(address(frac), DEED_ID);
        frac.lock(DEED_ID, alice);
        vm.expectRevert(
            abi.encodeWithSelector(DeedToken.DeedToken__AlreadyLocked.selector, DEED_ID)
        );
        frac.lock(DEED_ID, alice);
    }

    function test_redeemFromFraction_roundTrip() public {
        _mintToAlice();
        vm.prank(admin);
        deed.setFractionalizer(address(frac));
        vm.prank(alice);
        deed.approve(address(frac), DEED_ID);
        frac.lock(DEED_ID, alice);
        // redeem back to bob (a compliant holder)
        frac.redeem(DEED_ID, bob);
        assertEq(deed.ownerOf(DEED_ID), bob);
        assertFalse(deed.isFractionLocked(DEED_ID));
    }

    function test_redeemFromFraction_revertsNotLocked() public {
        _mintToAlice();
        vm.prank(admin);
        deed.setFractionalizer(address(frac));
        vm.expectRevert(abi.encodeWithSelector(DeedToken.DeedToken__NotLocked.selector, DEED_ID));
        frac.redeem(DEED_ID, bob);
    }

    function test_redeemFromFraction_compliantReceiverEnforced() public {
        _mintToAlice();
        vm.prank(admin);
        deed.setFractionalizer(address(frac));
        vm.prank(alice);
        deed.approve(address(frac), DEED_ID);
        frac.lock(DEED_ID, alice);
        // redeem to a non-compliant holder → the base compliance gate blocks it
        vm.expectRevert(
            abi.encodeWithSelector(IERC7943NonFungible.ERC7943CannotReceive.selector, mallory)
        );
        frac.redeem(DEED_ID, mallory);
    }
}
