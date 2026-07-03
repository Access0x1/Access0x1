// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC721Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { Access0x1RwaToken } from "../../src/Access0x1RwaToken.sol";
import { IERC7943NonFungible } from "../../src/interfaces/IERC7943NonFungible.sol";

/// @notice Unit + fuzz suite for {Access0x1RwaToken}, the vanilla ERC-7943 (uRWA) compliant-asset
///         NFT. Covers the full standard surface and its enforcement: role-gated mint/burn with the
///         receiver compliance gate, wallet-to-wallet transfers gated on BOTH endpoints (including
///         the approved-operator path — the check lives in `_update`, not a wrapper), per-tokenId
///         freeze blocking + unfreeze restoring, {forcedTransfer} bypassing the sender gate and the
///         freeze (unfreeze-before-move ordering, events in order) while still honoring the receiver
///         gate, the never-revert/never-write composability contract of the `can*` views (proved
///         under raw STATICCALL), ERC-165 detection of the standard id `0xbf1ef5fe`, and
///         AccessControl gating on every authority entry point.
contract Access0x1RwaTokenTest is Test {
    Access0x1RwaToken internal token;

    address internal admin = makeAddr("admin"); // DEFAULT_ADMIN_ROLE — grants the operational roles
    address internal issuer = makeAddr("issuer"); // MINTER + BURNER
    address internal regulator = makeAddr("regulator"); // FREEZER + FORCE_TRANSFER
    address internal registrar = makeAddr("registrar"); // WHITELIST
    address internal alice = makeAddr("alice"); // allowed holder
    address internal bob = makeAddr("bob"); // allowed holder
    address internal mallory = makeAddr("mallory"); // NEVER allowlisted

    string internal constant NAME = "Access0x1 RWA";
    string internal constant SYMBOL = "A0X1RWA";
    uint256 internal constant TOKEN_ID = 1;

    // Cached so tests never interleave an extra call between vm.expectRevert and the call under test.
    bytes32 internal minterRole;
    bytes32 internal burnerRole;
    bytes32 internal freezerRole;
    bytes32 internal whitelistRole;
    bytes32 internal forceTransferRole;

    function setUp() public {
        token = new Access0x1RwaToken(NAME, SYMBOL, admin);

        minterRole = token.MINTER_ROLE();
        burnerRole = token.BURNER_ROLE();
        freezerRole = token.FREEZER_ROLE();
        whitelistRole = token.WHITELIST_ROLE();
        forceTransferRole = token.FORCE_TRANSFER_ROLE();

        // The admin configures its own authority set — nothing was granted at construction.
        vm.startPrank(admin);
        token.grantRole(minterRole, issuer);
        token.grantRole(burnerRole, issuer);
        token.grantRole(freezerRole, regulator);
        token.grantRole(forceTransferRole, regulator);
        token.grantRole(whitelistRole, registrar);
        vm.stopPrank();

        // Reference compliance list: alice and bob are allowed endpoints; mallory never is.
        vm.startPrank(registrar);
        token.setWhitelisted(alice, true);
        token.setWhitelisted(bob, true);
        vm.stopPrank();
    }

    /// @dev Mint the canonical test asset to alice (issuer holds MINTER_ROLE; alice is allowed).
    function _mintToAlice() internal {
        vm.prank(issuer);
        token.mint(alice, TOKEN_ID);
    }

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_constructor_setsMetadataAndAdminOnly() public view {
        assertEq(token.name(), NAME);
        assertEq(token.symbol(), SYMBOL);
        assertTrue(token.hasRole(token.DEFAULT_ADMIN_ROLE(), admin), "admin holds the admin role");

        // NOTHING operational is pre-granted — every clone configures its own authority set.
        assertFalse(token.hasRole(minterRole, admin), "no implicit minter");
        assertFalse(token.hasRole(burnerRole, admin), "no implicit burner");
        assertFalse(token.hasRole(freezerRole, admin), "no implicit freezer");
        assertFalse(token.hasRole(whitelistRole, admin), "no implicit whitelister");
        assertFalse(token.hasRole(forceTransferRole, admin), "no implicit enforcer");
    }

    function test_constructor_revertsOnZeroAdmin() public {
        vm.expectRevert(Access0x1RwaToken.Access0x1RwaToken__ZeroAddress.selector);
        new Access0x1RwaToken(NAME, SYMBOL, address(0));
    }

    /*//////////////////////////////////////////////////////////////
                                 MINT
    //////////////////////////////////////////////////////////////*/

    function test_mint_minterMintsToWhitelistedReceiver() public {
        _mintToAlice();
        assertEq(token.ownerOf(TOKEN_ID), alice);
        assertEq(token.balanceOf(alice), 1);
    }

    function test_mint_revertsForNonMinter() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, minterRole
            )
        );
        token.mint(alice, TOKEN_ID);
    }

    function test_mint_revertsToNonWhitelistedReceiver() public {
        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(IERC7943NonFungible.ERC7943CannotReceive.selector, mallory)
        );
        token.mint(mallory, TOKEN_ID);
    }

    /*//////////////////////////////////////////////////////////////
                               TRANSFER
    //////////////////////////////////////////////////////////////*/

    function test_transfer_allowedWhenBothEndpointsWhitelisted() public {
        _mintToAlice();
        vm.prank(alice);
        token.safeTransferFrom(alice, bob, TOKEN_ID);
        assertEq(token.ownerOf(TOKEN_ID), bob);
    }

    function test_transfer_revertsWhenSenderNotAllowed() public {
        _mintToAlice();
        // The holder falls off the compliance list AFTER acquiring the asset.
        vm.prank(registrar);
        token.setWhitelisted(alice, false);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC7943NonFungible.ERC7943CannotSend.selector, alice)
        );
        token.transferFrom(alice, bob, TOKEN_ID);
    }

    function test_transfer_revertsWhenReceiverNotAllowed() public {
        _mintToAlice();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC7943NonFungible.ERC7943CannotReceive.selector, mallory)
        );
        token.transferFrom(alice, mallory, TOKEN_ID);
    }

    /// @notice The gate lives in `_update`, so an APPROVED OPERATOR cannot route around it: consent
    ///         (approval) does not override compliance.
    function test_transfer_operatorPathIsGatedIdentically() public {
        _mintToAlice();
        vm.prank(alice);
        token.approve(bob, TOKEN_ID);
        vm.prank(registrar);
        token.setWhitelisted(alice, false); // sender falls off the list after approving

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IERC7943NonFungible.ERC7943CannotSend.selector, alice)
        );
        token.transferFrom(alice, bob, TOKEN_ID);
    }

    function testFuzz_transfer_arbitraryNonWhitelistedReceiverIsRejected(address to) public {
        vm.assume(to != alice && to != bob && to != address(0));
        _mintToAlice();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC7943NonFungible.ERC7943CannotReceive.selector, to)
        );
        token.transferFrom(alice, to, TOKEN_ID);
    }

    /*//////////////////////////////////////////////////////////////
                            FREEZE / UNFREEZE
    //////////////////////////////////////////////////////////////*/

    function test_freeze_blocksTransfer() public {
        _mintToAlice();
        vm.prank(regulator);
        token.setFrozenTokens(alice, TOKEN_ID, true);
        assertTrue(token.getFrozenTokens(alice, TOKEN_ID));

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC7943NonFungible.ERC7943InsufficientUnfrozenBalance.selector, alice, TOKEN_ID
            )
        );
        token.transferFrom(alice, bob, TOKEN_ID);
    }

    function test_unfreeze_restoresTransfer() public {
        _mintToAlice();
        vm.startPrank(regulator);
        token.setFrozenTokens(alice, TOKEN_ID, true);
        token.setFrozenTokens(alice, TOKEN_ID, false); // overwrite semantics, approve-like
        vm.stopPrank();
        assertFalse(token.getFrozenTokens(alice, TOKEN_ID));

        vm.prank(alice);
        token.safeTransferFrom(alice, bob, TOKEN_ID);
        assertEq(token.ownerOf(TOKEN_ID), bob);
    }

    function test_setFrozenTokens_emitsFrozenAndReturnsTrue() public {
        _mintToAlice();
        vm.expectEmit(true, true, true, true, address(token));
        emit IERC7943NonFungible.Frozen(alice, TOKEN_ID, true);
        vm.prank(regulator);
        assertTrue(token.setFrozenTokens(alice, TOKEN_ID, true));
    }

    /// @notice Spec-allowed: a freeze flag may be set for an account that does not hold the token.
    ///         It is keyed by (account, tokenId), so only the CURRENT owner's flag gates transfers.
    function test_setFrozenTokens_isPerAccountKeyed() public {
        _mintToAlice();
        vm.prank(regulator);
        token.setFrozenTokens(bob, TOKEN_ID, true); // bob does not hold TOKEN_ID
        assertTrue(token.getFrozenTokens(bob, TOKEN_ID));

        // alice's transfer is unaffected — her own flag is what matters.
        vm.prank(alice);
        token.safeTransferFrom(alice, bob, TOKEN_ID);
        assertEq(token.ownerOf(TOKEN_ID), bob);
    }

    function test_setFrozenTokens_revertsForNonFreezer() public {
        vm.prank(mallory);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, mallory, freezerRole
            )
        );
        token.setFrozenTokens(alice, TOKEN_ID, true);
    }

    function test_setFrozenTokens_revertsOnZeroAccount() public {
        vm.prank(regulator);
        vm.expectRevert(Access0x1RwaToken.Access0x1RwaToken__ZeroAddress.selector);
        token.setFrozenTokens(address(0), TOKEN_ID, true);
    }

    function testFuzz_freeze_isPerTokenId(uint256 otherId) public {
        vm.assume(otherId != TOKEN_ID);
        _mintToAlice();
        vm.prank(issuer);
        token.mint(alice, otherId);

        vm.prank(regulator);
        token.setFrozenTokens(alice, TOKEN_ID, true);

        // The untouched id still moves; the frozen one is blocked.
        vm.prank(alice);
        token.safeTransferFrom(alice, bob, otherId);
        assertEq(token.ownerOf(otherId), bob);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC7943NonFungible.ERC7943InsufficientUnfrozenBalance.selector, alice, TOKEN_ID
            )
        );
        token.transferFrom(alice, bob, TOKEN_ID);
    }

    /*//////////////////////////////////////////////////////////////
                            FORCED TRANSFER
    //////////////////////////////////////////////////////////////*/

    /// @notice The seizure path bypasses the sender-side gate AND the freeze: a de-listed holder
    ///         with a frozen token can still be enforcement-transferred. Unfreeze happens BEFORE the
    ///         move (events in that order), so no stale flag survives on the old owner.
    function test_forcedTransfer_bypassesSenderGateAndFreeze() public {
        _mintToAlice();
        vm.prank(registrar);
        token.setWhitelisted(alice, false); // sender no longer allowed
        vm.prank(regulator);
        token.setFrozenTokens(alice, TOKEN_ID, true); // and the token is frozen

        vm.expectEmit(true, true, true, true, address(token));
        emit IERC7943NonFungible.Frozen(alice, TOKEN_ID, false); // 1: unfreeze first
        vm.expectEmit(true, true, true, true, address(token));
        emit IERC721.Transfer(alice, bob, TOKEN_ID); // 2: then the raw move
        vm.expectEmit(true, true, true, true, address(token));
        emit IERC7943NonFungible.ForcedTransfer(alice, bob, TOKEN_ID); // 3: then the seizure record

        vm.prank(regulator);
        assertTrue(token.forcedTransfer(alice, bob, TOKEN_ID));

        assertEq(token.ownerOf(TOKEN_ID), bob);
        assertFalse(token.getFrozenTokens(alice, TOKEN_ID), "no stale frozen flag on the old owner");
    }

    function test_forcedTransfer_stillHonorsReceiverGate() public {
        _mintToAlice();
        vm.prank(regulator);
        vm.expectRevert(
            abi.encodeWithSelector(IERC7943NonFungible.ERC7943CannotReceive.selector, mallory)
        );
        token.forcedTransfer(alice, mallory, TOKEN_ID);
    }

    function test_forcedTransfer_revertsForNonRole() public {
        _mintToAlice();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, forceTransferRole
            )
        );
        token.forcedTransfer(alice, bob, TOKEN_ID);
    }

    function test_forcedTransfer_revertsOnNonexistentToken() public {
        vm.prank(regulator);
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, TOKEN_ID)
        );
        token.forcedTransfer(alice, bob, TOKEN_ID);
    }

    function test_forcedTransfer_revertsWhenFromIsNotTheOwner() public {
        _mintToAlice();
        vm.prank(regulator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC721Errors.ERC721IncorrectOwner.selector, bob, TOKEN_ID, alice
            )
        );
        token.forcedTransfer(bob, alice, TOKEN_ID);
    }

    /*//////////////////////////////////////////////////////////////
                                 BURN
    //////////////////////////////////////////////////////////////*/

    function test_burn_burnerRetiresAssetAndClearsFreeze() public {
        _mintToAlice();
        vm.prank(regulator);
        token.setFrozenTokens(alice, TOKEN_ID, true);

        // Burning is an authority action — not blocked by the freeze, and it clears the flag.
        vm.prank(issuer);
        token.burn(TOKEN_ID);

        assertEq(token.balanceOf(alice), 0);
        assertFalse(token.getFrozenTokens(alice, TOKEN_ID), "frozen flag cleared on burn");
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, TOKEN_ID)
        );
        token.ownerOf(TOKEN_ID);
    }

    function test_burn_revertsForNonBurner() public {
        _mintToAlice();
        vm.prank(alice); // even the holder cannot burn — retiring an asset is an authority action
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, burnerRole
            )
        );
        token.burn(TOKEN_ID);
    }

    function test_burn_revertsOnNonexistentToken() public {
        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, TOKEN_ID)
        );
        token.burn(TOKEN_ID);
    }

    /*//////////////////////////////////////////////////////////////
                          REFERENCE ALLOWLIST
    //////////////////////////////////////////////////////////////*/

    function test_setWhitelisted_emitsAndReflectsInPolicyViews() public {
        vm.expectEmit(true, true, true, true, address(token));
        emit Access0x1RwaToken.Whitelisted(mallory, true);
        vm.prank(registrar);
        token.setWhitelisted(mallory, true);

        assertTrue(token.isWhitelisted(mallory));
        assertTrue(token.canSend(mallory));
        assertTrue(token.canReceive(mallory));
    }

    function test_setWhitelisted_revertsForNonRole() public {
        vm.prank(mallory);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, mallory, whitelistRole
            )
        );
        token.setWhitelisted(mallory, true);
    }

    function test_setWhitelisted_revertsOnZeroAddress() public {
        vm.prank(registrar);
        vm.expectRevert(Access0x1RwaToken.Access0x1RwaToken__ZeroAddress.selector);
        token.setWhitelisted(address(0), true);
    }

    /*//////////////////////////////////////////////////////////////
                       POLICY VIEWS (COMPOSABILITY)
    //////////////////////////////////////////////////////////////*/

    function test_canTransfer_trueOnlyWhenEveryConditionHolds() public {
        _mintToAlice();
        assertTrue(token.canTransfer(alice, bob, TOKEN_ID), "happy path");

        // Wrong current owner ⇒ false.
        assertFalse(token.canTransfer(bob, alice, TOKEN_ID), "from must be the owner");

        // Frozen ⇒ false; thawed ⇒ true again.
        vm.prank(regulator);
        token.setFrozenTokens(alice, TOKEN_ID, true);
        assertFalse(token.canTransfer(alice, bob, TOKEN_ID), "frozen blocks");
        vm.prank(regulator);
        token.setFrozenTokens(alice, TOKEN_ID, false);
        assertTrue(token.canTransfer(alice, bob, TOKEN_ID), "unfreeze restores");

        // Either endpoint off the list ⇒ false.
        assertFalse(token.canTransfer(alice, mallory, TOKEN_ID), "receiver not allowed");
        vm.prank(registrar);
        token.setWhitelisted(alice, false);
        assertFalse(token.canTransfer(alice, bob, TOKEN_ID), "sender not allowed");
    }

    /// @notice The uRWA composability contract: `canSend`/`canReceive`/`canTransfer`/
    ///         `getFrozenTokens` MUST NOT revert and MUST NOT write storage, even on garbage inputs.
    ///         Proved under raw STATICCALL (any storage write or revert would flip `ok` to false).
    function test_policyViews_neverRevertNeverWrite_underStaticcall() public view {
        (bool ok,) = address(token).staticcall(abi.encodeCall(token.canSend, (address(0))));
        assertTrue(ok, "canSend(0) staticcall-safe");

        (ok,) = address(token).staticcall(abi.encodeCall(token.canReceive, (address(0))));
        assertTrue(ok, "canReceive(0) staticcall-safe");

        (ok,) = address(token)
            .staticcall(
                abi.encodeCall(token.canTransfer, (address(0), address(0), type(uint256).max))
            );
        assertTrue(ok, "canTransfer on garbage staticcall-safe");

        (ok,) = address(token)
            .staticcall(abi.encodeCall(token.getFrozenTokens, (address(0), type(uint256).max)));
        assertTrue(ok, "getFrozenTokens on garbage staticcall-safe");
    }

    function test_policyViews_falseOnEdgeInputsInsteadOfReverting() public view {
        // Nonexistent token: canTransfer is simply false — it never reverts like ownerOf would.
        assertFalse(token.canTransfer(alice, bob, 999));
        // Zero addresses are never allowed endpoints.
        assertFalse(token.canSend(address(0)));
        assertFalse(token.canReceive(address(0)));
        // from == 0 with a nonexistent id must NOT read as "transferable" (_ownerOf(999) == 0 == from).
        assertFalse(token.canTransfer(address(0), bob, 999));
        // Unfrozen-by-default, even for ids/accounts that were never touched.
        assertFalse(token.getFrozenTokens(mallory, 999));
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    function test_supportsInterface_advertisesTheStandardId() public view {
        // The uRWA NonFungible id is pinned by the standard: 0xbf1ef5fe.
        assertEq(
            type(IERC7943NonFungible).interfaceId,
            bytes4(0xbf1ef5fe),
            "interface drifted from the ERC-7943 id"
        );
        assertTrue(token.supportsInterface(type(IERC7943NonFungible).interfaceId), "uRWA-721");
        assertTrue(token.supportsInterface(type(IERC721).interfaceId), "IERC721");
        assertTrue(token.supportsInterface(type(IAccessControl).interfaceId), "IAccessControl");
        assertTrue(token.supportsInterface(type(IERC165).interfaceId), "IERC165");
        assertFalse(token.supportsInterface(0xffffffff), "0xffffffff must be false per ERC-165");
    }
}
