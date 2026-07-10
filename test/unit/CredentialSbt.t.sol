// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {
    IERC721Metadata
} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC721Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { CredentialSbt } from "../../src/CredentialSbt.sol";
import { ICredentialSbt, IERC5192 } from "../../src/interfaces/ICredentialSbt.sol";
import { SmartWallet1271, WalletFactory } from "../mocks/SmartWallet1271.sol";
import {
    ReentrantClaimFactory, NonceProbeFactory
} from "../mocks/ReentrantClaimFactory.sol";

/// @notice Unit + fuzz suite for {CredentialSbt}, the vanilla soulbound (ERC-5192) verified-credential
///         badge with levels. Covers the full lifecycle — direct {issue}, gasless {claim} from an
///         EIP-712 voucher (EOA / ERC-1271 / ERC-6492 signers), {setLevel}, issuer {revoke}, subject
///         {renounce}, optional expiry via {isValid}/{hasValidCredential}, the one-active-badge-per-pair
///         invariant, and the SOULBOUND guarantee (every transfer + approval entry point hard-reverts,
///         {locked} always true, {Locked} emitted at mint). Signature negatives (wrong signer, replayed
///         nonce, expired deadline, non-issuer signer) and ERC-165 id detection round it out. Time-based
///         expiry is driven with `vm.warp`; smart-account paths reuse the shared {SmartWallet1271} /
///         {WalletFactory} mocks.
contract CredentialSbtTest is Test {
    CredentialSbt internal sbt;
    WalletFactory internal factory;

    address internal admin = makeAddr("admin"); // DEFAULT_ADMIN_ROLE — grants ISSUER_ROLE

    uint256 internal issuerPk;
    address internal issuer; // ISSUER_ROLE (EOA, so it can sign vouchers)

    address internal subject = makeAddr("subject");
    address internal subject2 = makeAddr("subject2");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");

    string internal constant NAME = "Credential Badge";
    string internal constant SYMBOL = "CRED";
    string internal constant VERSION = "1";

    bytes32 internal constant CRED_TYPE = keccak256("business-verified");
    bytes32 internal constant OTHER_TYPE = keccak256("kyc-attested");

    uint8 internal constant LEVEL = 2;

    bytes32 internal issuerRole;

    bytes32 internal constant ERC6492_MAGIC =
        0x6492649264926492649264926492649264926492649264926492649264926492;

    function setUp() public {
        sbt = new CredentialSbt(NAME, SYMBOL, VERSION, admin);
        factory = new WalletFactory();

        issuerRole = sbt.ISSUER_ROLE();
        (issuer, issuerPk) = makeAddrAndKey("issuer");

        vm.prank(admin);
        sbt.grantRole(issuerRole, issuer);
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_constructor_setsAdminAndMetadata() public view {
        assertEq(sbt.name(), NAME);
        assertEq(sbt.symbol(), SYMBOL);
        assertTrue(sbt.hasRole(sbt.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(sbt.hasRole(issuerRole, issuer));
    }

    function test_constructor_revertZeroAdmin() public {
        vm.expectRevert(ICredentialSbt.CredentialSbt__ZeroAddress.selector);
        new CredentialSbt(NAME, SYMBOL, VERSION, address(0));
    }

    /*//////////////////////////////////////////////////////////////
                                 ISSUE
    //////////////////////////////////////////////////////////////*/

    function test_issue_success_mintsSoulboundBadge() public {
        vm.expectEmit(true, false, false, false, address(sbt));
        emit IERC5192.Locked(1);
        vm.expectEmit(true, true, true, true, address(sbt));
        emit ICredentialSbt.CredentialIssued(1, subject, CRED_TYPE, LEVEL, 0, issuer);

        vm.prank(issuer);
        uint256 tokenId = sbt.issue(subject, CRED_TYPE, LEVEL, 0);

        assertEq(tokenId, 1);
        assertEq(sbt.ownerOf(tokenId), subject);
        assertEq(sbt.balanceOf(subject), 1);
        assertEq(sbt.tokenOfSubject(subject, CRED_TYPE), tokenId);
        assertEq(sbt.levelOf(tokenId), LEVEL);
        assertTrue(sbt.isValid(tokenId));
        assertTrue(sbt.hasValidCredential(subject, CRED_TYPE));

        ICredentialSbt.Credential memory cred = sbt.credentialOf(tokenId);
        assertEq(cred.subject, subject);
        assertEq(cred.credType, CRED_TYPE);
        assertEq(cred.level, LEVEL);
        assertEq(cred.issuedAt, uint64(block.timestamp));
        assertEq(cred.expiresAt, 0);
        assertFalse(cred.revoked);
    }

    function test_issue_incrementsTokenId() public {
        vm.startPrank(issuer);
        uint256 a = sbt.issue(subject, CRED_TYPE, LEVEL, 0);
        uint256 b = sbt.issue(subject2, CRED_TYPE, LEVEL, 0);
        vm.stopPrank();
        assertEq(a, 1);
        assertEq(b, 2);
    }

    function test_issue_sameSubjectDifferentTypes_bothActive() public {
        vm.startPrank(issuer);
        sbt.issue(subject, CRED_TYPE, LEVEL, 0);
        sbt.issue(subject, OTHER_TYPE, LEVEL, 0);
        vm.stopPrank();
        assertTrue(sbt.hasValidCredential(subject, CRED_TYPE));
        assertTrue(sbt.hasValidCredential(subject, OTHER_TYPE));
    }

    function test_issue_revertNotIssuer() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, issuerRole
            )
        );
        sbt.issue(subject, CRED_TYPE, LEVEL, 0);
    }

    function test_issue_revertZeroSubject() public {
        vm.prank(issuer);
        vm.expectRevert(ICredentialSbt.CredentialSbt__ZeroAddress.selector);
        sbt.issue(address(0), CRED_TYPE, LEVEL, 0);
    }

    function test_issue_revertZeroLevel() public {
        vm.prank(issuer);
        vm.expectRevert(ICredentialSbt.CredentialSbt__ZeroLevel.selector);
        sbt.issue(subject, CRED_TYPE, 0, 0);
    }

    function test_issue_revertAlreadyIssued() public {
        vm.startPrank(issuer);
        uint256 tokenId = sbt.issue(subject, CRED_TYPE, LEVEL, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                ICredentialSbt.CredentialSbt__AlreadyIssued.selector, subject, CRED_TYPE, tokenId
            )
        );
        sbt.issue(subject, CRED_TYPE, LEVEL + 1, 0);
        vm.stopPrank();
    }

    function test_issue_afterRevoke_reissuePossible() public {
        vm.startPrank(issuer);
        uint256 first = sbt.issue(subject, CRED_TYPE, LEVEL, 0);
        sbt.revoke(first);
        uint256 second = sbt.issue(subject, CRED_TYPE, LEVEL, 0); // slot freed
        vm.stopPrank();
        assertEq(second, 2);
        assertEq(sbt.tokenOfSubject(subject, CRED_TYPE), second);
    }

    /*//////////////////////////////////////////////////////////////
                                 LEVEL
    //////////////////////////////////////////////////////////////*/

    function test_setLevel_raiseAndLower() public {
        vm.startPrank(issuer);
        uint256 tokenId = sbt.issue(subject, CRED_TYPE, LEVEL, 0);

        vm.expectEmit(true, false, false, true, address(sbt));
        emit ICredentialSbt.LevelChanged(tokenId, LEVEL, 5);
        sbt.setLevel(tokenId, 5);
        assertEq(sbt.levelOf(tokenId), 5);

        sbt.setLevel(tokenId, 1); // lower
        assertEq(sbt.levelOf(tokenId), 1);
        vm.stopPrank();
    }

    function test_setLevel_revertNotIssuer() public {
        vm.prank(issuer);
        uint256 tokenId = sbt.issue(subject, CRED_TYPE, LEVEL, 0);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, issuerRole
            )
        );
        sbt.setLevel(tokenId, 5);
    }

    function test_setLevel_revertZeroLevel() public {
        vm.startPrank(issuer);
        uint256 tokenId = sbt.issue(subject, CRED_TYPE, LEVEL, 0);
        vm.expectRevert(ICredentialSbt.CredentialSbt__ZeroLevel.selector);
        sbt.setLevel(tokenId, 0);
        vm.stopPrank();
    }

    function test_setLevel_revertUnknownCredential() public {
        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(ICredentialSbt.CredentialSbt__UnknownCredential.selector, 99)
        );
        sbt.setLevel(99, 5);
    }

    /*//////////////////////////////////////////////////////////////
                                 REVOKE
    //////////////////////////////////////////////////////////////*/

    function test_revoke_success_burnsAndFreesSlot() public {
        vm.prank(issuer);
        uint256 tokenId = sbt.issue(subject, CRED_TYPE, LEVEL, 0);

        vm.expectEmit(true, true, true, false, address(sbt));
        emit ICredentialSbt.CredentialRevoked(tokenId, subject, CRED_TYPE);
        vm.prank(issuer);
        sbt.revoke(tokenId);

        assertEq(sbt.balanceOf(subject), 0);
        assertEq(sbt.tokenOfSubject(subject, CRED_TYPE), 0);
        assertFalse(sbt.hasValidCredential(subject, CRED_TYPE));
        assertFalse(sbt.isValid(tokenId));
        assertEq(sbt.levelOf(tokenId), 0); // record cleared
        // The token no longer exists.
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, tokenId)
        );
        sbt.ownerOf(tokenId);
    }

    function test_revoke_revertNotIssuer() public {
        vm.prank(issuer);
        uint256 tokenId = sbt.issue(subject, CRED_TYPE, LEVEL, 0);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, issuerRole
            )
        );
        sbt.revoke(tokenId);
    }

    function test_revoke_revertUnknownCredential() public {
        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(ICredentialSbt.CredentialSbt__UnknownCredential.selector, 42)
        );
        sbt.revoke(42);
    }

    /*//////////////////////////////////////////////////////////////
                                RENOUNCE
    //////////////////////////////////////////////////////////////*/

    function test_renounce_subjectCanBurnOwnBadge() public {
        vm.prank(issuer);
        uint256 tokenId = sbt.issue(subject, CRED_TYPE, LEVEL, 0);

        vm.expectEmit(true, true, true, false, address(sbt));
        emit ICredentialSbt.CredentialRenounced(tokenId, subject, CRED_TYPE);
        vm.prank(subject);
        sbt.renounce(tokenId);

        assertEq(sbt.balanceOf(subject), 0);
        assertEq(sbt.tokenOfSubject(subject, CRED_TYPE), 0);
        assertFalse(sbt.isValid(tokenId));
    }

    function test_renounce_revertNotSubject() public {
        vm.prank(issuer);
        uint256 tokenId = sbt.issue(subject, CRED_TYPE, LEVEL, 0);
        // Even the issuer cannot RENOUNCE (that path is subject-only; the issuer uses revoke).
        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ICredentialSbt.CredentialSbt__NotSubject.selector, tokenId, issuer
            )
        );
        sbt.renounce(tokenId);
    }

    function test_renounce_revertUnknownCredential() public {
        vm.prank(subject);
        vm.expectRevert(
            abi.encodeWithSelector(ICredentialSbt.CredentialSbt__UnknownCredential.selector, 7)
        );
        sbt.renounce(7);
    }

    /*//////////////////////////////////////////////////////////////
                                 EXPIRY
    //////////////////////////////////////////////////////////////*/

    function test_expiry_validUntilExpiryThenInvalid() public {
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        vm.prank(issuer);
        uint256 tokenId = sbt.issue(subject, CRED_TYPE, LEVEL, expiresAt);

        assertTrue(sbt.isValid(tokenId));
        vm.warp(expiresAt); // exactly at expiry — still valid (checked with >)
        assertTrue(sbt.isValid(tokenId));
        vm.warp(expiresAt + 1); // one second past — now invalid
        assertFalse(sbt.isValid(tokenId));
        assertFalse(sbt.hasValidCredential(subject, CRED_TYPE));
        // The token still EXISTS (expiry does not burn it); only validity flips.
        assertEq(sbt.ownerOf(tokenId), subject);
        assertEq(sbt.tokenOfSubject(subject, CRED_TYPE), tokenId);
    }

    function test_expiry_zeroNeverExpires() public {
        vm.prank(issuer);
        uint256 tokenId = sbt.issue(subject, CRED_TYPE, LEVEL, 0);
        vm.warp(block.timestamp + 3650 days);
        assertTrue(sbt.isValid(tokenId));
    }

    function test_isValid_unknownToken_false() public view {
        assertFalse(sbt.isValid(999));
        assertFalse(sbt.hasValidCredential(subject, CRED_TYPE));
    }

    /*//////////////////////////////////////////////////////////////
                            SOULBOUND / ERC-5192
    //////////////////////////////////////////////////////////////*/

    function test_locked_alwaysTrueForExisting() public {
        vm.prank(issuer);
        uint256 tokenId = sbt.issue(subject, CRED_TYPE, LEVEL, 0);
        assertTrue(sbt.locked(tokenId));
    }

    function test_locked_revertNonexistent() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 123));
        sbt.locked(123);
    }

    function test_soulbound_transferFromReverts() public {
        vm.prank(issuer);
        uint256 tokenId = sbt.issue(subject, CRED_TYPE, LEVEL, 0);
        vm.prank(subject);
        vm.expectRevert(ICredentialSbt.CredentialSbt__Soulbound.selector);
        sbt.transferFrom(subject, subject2, tokenId);
    }

    function test_soulbound_safeTransferFromReverts() public {
        vm.prank(issuer);
        uint256 tokenId = sbt.issue(subject, CRED_TYPE, LEVEL, 0);
        vm.prank(subject);
        vm.expectRevert(ICredentialSbt.CredentialSbt__Soulbound.selector);
        sbt.safeTransferFrom(subject, subject2, tokenId);
    }

    function test_soulbound_approveReverts() public {
        vm.prank(issuer);
        uint256 tokenId = sbt.issue(subject, CRED_TYPE, LEVEL, 0);
        vm.prank(subject);
        vm.expectRevert(ICredentialSbt.CredentialSbt__Soulbound.selector);
        sbt.approve(subject2, tokenId);
    }

    function test_soulbound_setApprovalForAllReverts() public {
        vm.prank(subject);
        vm.expectRevert(ICredentialSbt.CredentialSbt__Soulbound.selector);
        sbt.setApprovalForAll(subject2, true);
    }

    /*//////////////////////////////////////////////////////////////
                             CLAIM (EIP-712)
    //////////////////////////////////////////////////////////////*/

    function _signVoucher(
        uint256 pk,
        address subject_,
        bytes32 credType,
        uint8 level,
        uint64 expiresAt,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 digest = sbt.claimDigest(subject_, credType, level, expiresAt, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_claim_eoaVoucher_success() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signVoucher(issuerPk, subject, CRED_TYPE, LEVEL, 0, 0, deadline);

        vm.expectEmit(true, true, true, true, address(sbt));
        emit ICredentialSbt.CredentialIssued(1, subject, CRED_TYPE, LEVEL, 0, issuer);

        vm.prank(relayer); // permissionless relayer submits
        uint256 tokenId = sbt.claim(issuer, subject, CRED_TYPE, LEVEL, 0, 0, deadline, sig);

        assertEq(sbt.ownerOf(tokenId), subject);
        assertTrue(sbt.hasValidCredential(subject, CRED_TYPE));
        assertTrue(sbt.isNonceUsed(issuer, 0));
        assertEq(sbt.nextNonce(issuer), 1); // cursor advanced
    }

    function test_claim_revertWrongSigner() public {
        (, uint256 strangerPk) = makeAddrAndKey("strangerSigner");
        uint256 deadline = block.timestamp + 1 hours;
        // Stranger signs but claims issuer authored it → recovery != issuer → BadSignature.
        bytes memory sig = _signVoucher(strangerPk, subject, CRED_TYPE, LEVEL, 0, 0, deadline);
        vm.expectRevert(ICredentialSbt.CredentialSbt__BadSignature.selector);
        sbt.claim(issuer, subject, CRED_TYPE, LEVEL, 0, 0, deadline, sig);
    }

    function test_claim_revertTamperedField() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signVoucher(issuerPk, subject, CRED_TYPE, LEVEL, 0, 0, deadline);
        // Relayer bumps the level; the digest no longer matches the signature.
        vm.expectRevert(ICredentialSbt.CredentialSbt__BadSignature.selector);
        sbt.claim(issuer, subject, CRED_TYPE, LEVEL + 1, 0, 0, deadline, sig);
    }

    function test_claim_revertSignerNotIssuerRole() public {
        // A valid signature from an account that does NOT hold ISSUER_ROLE must be rejected.
        (address notIssuer, uint256 notIssuerPk) = makeAddrAndKey("notIssuer");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signVoucher(notIssuerPk, subject, CRED_TYPE, LEVEL, 0, 0, deadline);
        vm.expectRevert(ICredentialSbt.CredentialSbt__BadSignature.selector);
        sbt.claim(notIssuer, subject, CRED_TYPE, LEVEL, 0, 0, deadline, sig);
    }

    function test_claim_revertReplayedNonce() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signVoucher(issuerPk, subject, CRED_TYPE, LEVEL, 0, 0, deadline);
        sbt.claim(issuer, subject, CRED_TYPE, LEVEL, 0, 0, deadline, sig);

        // Renounce so the (subject, credType) slot is free — proving the REPLAY guard (not the
        // one-per-pair guard) is what rejects the second claim.
        vm.prank(subject);
        sbt.renounce(1);

        vm.expectRevert(
            abi.encodeWithSelector(ICredentialSbt.CredentialSbt__NonceUsed.selector, issuer, 0)
        );
        sbt.claim(issuer, subject, CRED_TYPE, LEVEL, 0, 0, deadline, sig);
    }

    function test_claim_revertExpiredDeadline() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signVoucher(issuerPk, subject, CRED_TYPE, LEVEL, 0, 0, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                ICredentialSbt.CredentialSbt__VoucherExpired.selector, deadline, block.timestamp
            )
        );
        sbt.claim(issuer, subject, CRED_TYPE, LEVEL, 0, 0, deadline, sig);
    }

    function test_claim_atExactDeadline_succeeds() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signVoucher(issuerPk, subject, CRED_TYPE, LEVEL, 0, 0, deadline);
        vm.warp(deadline); // exactly at the deadline — still valid (checked with >)
        uint256 tokenId = sbt.claim(issuer, subject, CRED_TYPE, LEVEL, 0, 0, deadline, sig);
        assertEq(sbt.ownerOf(tokenId), subject);
    }

    function test_claim_revertZeroIssuer() public {
        vm.expectRevert(ICredentialSbt.CredentialSbt__ZeroAddress.selector);
        sbt.claim(address(0), subject, CRED_TYPE, LEVEL, 0, 0, block.timestamp + 1, hex"00");
    }

    function test_claim_outOfOrderNonces_cursorTracksLowestFree() public {
        uint256 deadline = block.timestamp + 1 hours;
        // Claim nonce 1 first (out of order); the cursor stays at 0 (the gap).
        bytes memory sig1 = _signVoucher(issuerPk, subject, CRED_TYPE, LEVEL, 0, 1, deadline);
        sbt.claim(issuer, subject, CRED_TYPE, LEVEL, 0, 1, deadline, sig1);
        assertTrue(sbt.isNonceUsed(issuer, 1));
        assertEq(sbt.nextNonce(issuer), 0); // cursor unmoved — 0 is still free

        // Now claim nonce 0; the cursor jumps past the whole used run (0 and 1) to 2.
        bytes memory sig0 = _signVoucher(issuerPk, subject2, CRED_TYPE, LEVEL, 0, 0, deadline);
        sbt.claim(issuer, subject2, CRED_TYPE, LEVEL, 0, 0, deadline, sig0);
        assertEq(sbt.nextNonce(issuer), 2);
    }

    /*//////////////////////////////////////////////////////////////
                       CLAIM (ERC-1271 / ERC-6492)
    //////////////////////////////////////////////////////////////*/

    function test_claim_1271_deployedSmartAccountIssuer() public {
        // A smart-account issuer whose ERC-1271 validation delegates to the issuer EOA key.
        SmartWallet1271 wallet = new SmartWallet1271(issuer);
        address walletIssuer = address(wallet);
        vm.prank(admin);
        sbt.grantRole(issuerRole, walletIssuer);

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signVoucher(issuerPk, subject, CRED_TYPE, LEVEL, 0, 0, deadline);

        vm.prank(relayer);
        uint256 tokenId = sbt.claim(walletIssuer, subject, CRED_TYPE, LEVEL, 0, 0, deadline, sig);
        assertEq(sbt.ownerOf(tokenId), subject);
        assertTrue(sbt.hasValidCredential(subject, CRED_TYPE));
    }

    function test_claim_6492_counterfactualSmartAccountIssuer() public {
        // Predict the smart-account issuer address; grant it the role + sign against it BEFORE it exists.
        address walletIssuer = factory.addressOf(issuer);
        assertEq(walletIssuer.code.length, 0);
        vm.prank(admin);
        sbt.grantRole(issuerRole, walletIssuer);

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory innerSig = _signVoucher(issuerPk, subject, CRED_TYPE, LEVEL, 0, 0, deadline);
        bytes memory wrapped = abi.encodePacked(
            abi.encode(address(factory), abi.encodeCall(WalletFactory.deploy, (issuer)), innerSig),
            ERC6492_MAGIC
        );

        vm.prank(relayer);
        uint256 tokenId =
            sbt.claim(walletIssuer, subject, CRED_TYPE, LEVEL, 0, 0, deadline, wrapped);
        assertEq(sbt.ownerOf(tokenId), subject);
        assertGt(walletIssuer.code.length, 0); // the 6492 prepare deployed the account
    }

    function test_claim_garbageSignatureRejected() public {
        uint256 deadline = block.timestamp + 1 hours;
        vm.expectRevert(ICredentialSbt.CredentialSbt__BadSignature.selector);
        sbt.claim(issuer, subject, CRED_TYPE, LEVEL, 0, 0, deadline, hex"deadbeef");
    }

    function test_claim_malformed6492WrapperRejected() public {
        uint256 deadline = block.timestamp + 1 hours;
        // A body that ends in the magic suffix but is NOT a valid (address,bytes,bytes) encoding must
        // yield a clean BadSignature (the external try/catch guard), never a bubbled Panic.
        bytes memory wrapped = abi.encodePacked(hex"deadbeefcafe", ERC6492_MAGIC);
        vm.expectRevert(ICredentialSbt.CredentialSbt__BadSignature.selector);
        sbt.claim(issuer, subject, CRED_TYPE, LEVEL, 0, 0, deadline, wrapped);
    }

    /*//////////////////////////////////////////////////////////////
              CLAIM — CEI / NONCE-REUSE REGRESSION (6492 factory)
    //////////////////////////////////////////////////////////////*/

    /// @notice REGRESSION (adversarially verified): the ERC-6492 wrapper's `factory` + `factoryCalldata`
    ///         are NOT part of the signed digest, so any submitter chooses them. For a codeless (EOA)
    ///         issuer the {claim} 6492 path CALLs that attacker factory. If the nonce is consumed only
    ///         AFTER signature validation (the external call), the factory can RE-ENTER {claim} with a
    ///         SECOND voucher the issuer signed under the SAME nonce (different credType) and mint a second
    ///         badge — one nonce, two badges. The fix marks the nonce used BEFORE validation, so the
    ///         re-entrant leg must revert {CredentialSbt__NonceUsed}. Both vouchers are genuinely
    ///         issuer-signed (no forgery); the guard being defeated is the single-use nonce.
    function test_claim_reentrantSameNonce_secondBadgeReverts() public {
        uint256 sharedNonce = 77;
        uint256 deadline = block.timestamp + 1 hours;

        // Two DIFFERENT badges the issuer legitimately signed under the SAME nonce.
        bytes memory sigA = _signVoucher(issuerPk, subject, CRED_TYPE, LEVEL, 0, sharedNonce, deadline);
        bytes memory sigB =
            _signVoucher(issuerPk, subject, OTHER_TYPE, LEVEL, 0, sharedNonce, deadline);

        // Attacker factory staged to re-enter claim() with the TYPE_B (same-nonce) voucher.
        ReentrantClaimFactory evil = new ReentrantClaimFactory(sbt);
        evil.stage(issuer, subject, OTHER_TYPE, LEVEL, 0, sharedNonce, deadline, sigB);

        // The outer TYPE_A voucher, ERC-6492-wrapped so the unsigned `factory` = the attacker contract.
        // The issuer is a codeless EOA, so claim() CALLs `factory` (evil.reenter) before consuming nonce.
        bytes memory wrapped = abi.encodePacked(
            abi.encode(
                address(evil), abi.encodeCall(ReentrantClaimFactory.reenter, ()), sigA
            ),
            ERC6492_MAGIC
        );

        vm.prank(relayer);
        uint256 tokenId =
            sbt.claim(issuer, subject, CRED_TYPE, LEVEL, 0, sharedNonce, deadline, wrapped);

        // The outer TYPE_A claim itself still succeeds (its signature is valid) — the fix does not break
        // legitimate claims; the 6492 factory call is best-effort and its revert is swallowed.
        assertEq(sbt.ownerOf(tokenId), subject, "TYPE_A badge minted to subject");
        assertTrue(sbt.hasValidCredential(subject, CRED_TYPE), "TYPE_A active");

        // The attack path fired but the re-entrant TYPE_B mint was REJECTED by the nonce guard.
        assertTrue(evil.reentered(), "factory call did fire (attack path exercised)");
        assertFalse(evil.reentrantMinted(), "re-entrant claim must NOT have minted (was: minted twice)");
        assertFalse(
            sbt.hasValidCredential(subject, OTHER_TYPE), "NO second badge from the shared nonce"
        );
        assertEq(sbt.balanceOf(subject), 1, "exactly ONE badge from the shared nonce");
        assertTrue(sbt.isNonceUsed(issuer, sharedNonce), "shared nonce consumed exactly once");
    }

    /// @notice REGRESSION: at the instant of the ERC-6492 factory external call, the voucher's nonce must
    ///         already be marked used (checks-effects-interactions). A probe factory reads
    ///         {isNonceUsed} from INSIDE the call {claim} makes during validation; under the fix it sees
    ///         `true` (was: `false`, because the effect trailed the interaction).
    function test_claim_nonceConsumedBeforeExternalCall() public {
        uint256 probeNonce = 5;
        uint256 deadline = block.timestamp + 1 hours;

        NonceProbeFactory probe = new NonceProbeFactory(sbt);
        probe.stage(issuer, probeNonce);

        bytes memory innerSig =
            _signVoucher(issuerPk, subject, CRED_TYPE, LEVEL, 0, probeNonce, deadline);
        bytes memory wrapped = abi.encodePacked(
            abi.encode(address(probe), abi.encodeCall(NonceProbeFactory.probe, ()), innerSig),
            ERC6492_MAGIC
        );

        vm.prank(relayer);
        sbt.claim(issuer, subject, CRED_TYPE, LEVEL, 0, probeNonce, deadline, wrapped);

        assertTrue(probe.probed(), "probe factory was actually called during validation");
        assertTrue(
            probe.sawNonceUsed(),
            "nonce must be consumed BEFORE the external call (CEI); was false pre-fix"
        );
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    function test_supportsInterface_ids() public view {
        assertTrue(sbt.supportsInterface(0xb45a3c0e), "ERC-5192");
        assertTrue(sbt.supportsInterface(type(IERC5192).interfaceId), "IERC5192 typeid");
        assertTrue(sbt.supportsInterface(type(IERC721).interfaceId), "IERC721");
        assertTrue(sbt.supportsInterface(type(IERC721Metadata).interfaceId), "IERC721Metadata");
        assertTrue(sbt.supportsInterface(type(IAccessControl).interfaceId), "IAccessControl");
        assertTrue(sbt.supportsInterface(type(IERC165).interfaceId), "IERC165");
        assertFalse(sbt.supportsInterface(0xffffffff), "0xffffffff must be false per ERC-165");
    }

    function test_erc5192_interfaceId_matchesLockedSelector() public pure {
        // The ERC-5192 id is the single-function interface's selector: locked(uint256).
        assertEq(type(IERC5192).interfaceId, bytes4(0xb45a3c0e));
        assertEq(IERC5192.locked.selector, bytes4(0xb45a3c0e));
    }

    /*//////////////////////////////////////////////////////////////
                                  FUZZ
    //////////////////////////////////////////////////////////////*/

    function testFuzz_issue_roundTrips(
        address subj,
        bytes32 credType,
        uint8 level,
        uint64 expiresAt
    ) public {
        vm.assume(subj != address(0));
        level = uint8(bound(level, 1, type(uint8).max));

        vm.prank(issuer);
        uint256 tokenId = sbt.issue(subj, credType, level, expiresAt);

        assertEq(sbt.ownerOf(tokenId), subj);
        assertEq(sbt.levelOf(tokenId), level);
        assertEq(sbt.tokenOfSubject(subj, credType), tokenId);
        assertTrue(sbt.locked(tokenId));

        // Validity tracks expiry deterministically.
        bool expectValid = expiresAt == 0 || block.timestamp <= expiresAt;
        assertEq(sbt.isValid(tokenId), expectValid);
    }

    function testFuzz_claim_validVoucherAlwaysMintsForNamedSubject(
        address subj,
        bytes32 credType,
        uint8 level,
        uint256 nonce
    ) public {
        vm.assume(subj != address(0));
        vm.assume(subj.code.length == 0); // a safe-mint receiver must accept (EOAs always do)
        level = uint8(bound(level, 1, type(uint8).max));
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory sig = _signVoucher(issuerPk, subj, credType, level, 0, nonce, deadline);
        vm.prank(relayer);
        uint256 tokenId = sbt.claim(issuer, subj, credType, level, 0, nonce, deadline, sig);

        assertEq(sbt.ownerOf(tokenId), subj); // the badge always lands on the VOUCHER subject
        assertTrue(sbt.isNonceUsed(issuer, nonce));
    }

    function testFuzz_soulbound_transferAlwaysReverts(address to) public {
        vm.prank(issuer);
        uint256 tokenId = sbt.issue(subject, CRED_TYPE, LEVEL, 0);
        vm.assume(to != address(0));
        vm.prank(subject);
        vm.expectRevert(ICredentialSbt.CredentialSbt__Soulbound.selector);
        sbt.transferFrom(subject, to, tokenId);
    }
}
