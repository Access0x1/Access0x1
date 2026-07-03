// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import { IERC1155Receiver } from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import { Access0x1Account } from "../../src/Access0x1Account.sol";
import { IERC6551Account } from "../../src/interfaces/IERC6551Account.sol";
import { IERC6551Executable } from "../../src/interfaces/IERC6551Executable.sol";
import { IERC6551Registry } from "../../src/interfaces/IERC6551Registry.sol";
import { ERC6551Registry } from "../vendor/ERC6551Registry.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { MockERC721 } from "../mocks/MockERC721.sol";
import { MockERC1155 } from "../mocks/MockERC1155.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { ReturnBombERC721 } from "../mocks/ReturnBombERC721.sol";
import { RevertingCallee } from "../mocks/RevertingCallee.sol";
import { SmartWallet1271 } from "../mocks/SmartWallet1271.sol";

/// @notice Unit + fuzz suite for {Access0x1Account}, the minimal ERC-6551 token bound account.
///         Covers the whole surface against the REAL registry (the official reference source,
///         vendored and etched at the canonical singleton address, so every counterfactual matches
///         production): registry parity + idempotence + event, {token} decoding the proxy's
///         appended constant data (and staying constant across owner changes), {owner} tracking
///         the live NFT holder and degrading to `address(0)` — never reverting — on foreign-chain
///         bindings and non-ERC-721 bindings, holder-only CALL-only {execute} with exact revert
///         bubbling and success-only `state` bumps, control following the NFT (new holder in / old
///         holder out, for execute AND ERC-1271), ERC-1271 for EOA and nested smart-account
///         owners, asset custody (ERC-20/721/1155 single + batch), the ownership-cycle guard
///         refusing the account's own bound token, and ERC-165 pinning of the standard ids
///         `0x6faff5f1` / `0x51945447` and the EIP-6551 signer magic value `0x523e3260`.
contract Access0x1AccountTest is Test {
    /// @dev The canonical ERC-6551 registry singleton address (EIP-6551, Nick's Factory deploy).
    address internal constant CANONICAL_REGISTRY = 0x000000006551c19487814612e58FE06813775758;

    IERC6551Registry internal registry; // typed at the CANONICAL address after vm.etch
    Access0x1Account internal implementation;
    Access0x1Account internal account; // the TBA for (nft, TOKEN_ID) at SALT
    MockERC721 internal nft;
    MockERC1155 internal multi;
    MockUSDC internal usdc;
    RevertingCallee internal callee;

    address internal alice = makeAddr("alice"); // initial holder of TOKEN_ID — the account's owner
    address internal bob = makeAddr("bob"); // later holder / plain payment receiver
    address internal mallory = makeAddr("mallory"); // NEVER a valid signer

    bytes32 internal constant SALT = bytes32(0);
    uint256 internal constant TOKEN_ID = 1;
    bytes32 internal constant DIGEST = keccak256("Access0x1Account: message under test");

    function setUp() public {
        // Deploy the vendored OFFICIAL reference registry locally, then etch its runtime code at
        // the canonical singleton address — tests compute the same counterfactuals as production.
        ERC6551Registry vendoredRegistry = new ERC6551Registry();
        vm.etch(CANONICAL_REGISTRY, address(vendoredRegistry).code);
        registry = IERC6551Registry(CANONICAL_REGISTRY);

        // One implementation serves every account — deployed once, proxied per token.
        implementation = new Access0x1Account();

        nft = new MockERC721();
        multi = new MockERC1155();
        usdc = new MockUSDC();
        callee = new RevertingCallee();

        // alice holds the bound token; her TBA is created up front.
        nft.mintId(alice, TOKEN_ID);
        account = _createAccount(SALT, block.chainid, address(nft), TOKEN_ID);
    }

    /// @dev Create (or fetch) the TBA for a binding through the canonical registry.
    function _createAccount(bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        internal
        returns (Access0x1Account)
    {
        return Access0x1Account(
            payable(registry.createAccount(
                    address(implementation), salt, chainId, tokenContract, tokenId
                ))
        );
    }

    /*//////////////////////////////////////////////////////////////
                                REGISTRY
    //////////////////////////////////////////////////////////////*/

    function test_registry_counterfactualMatchesDeployed() public view {
        address predicted = registry.account(
            address(implementation), SALT, block.chainid, address(nft), TOKEN_ID
        );
        assertEq(predicted, address(account), "account() must equal the createAccount() address");
        // The EIP's exact proxy shape: 45-byte minimal proxy + 4 constant words = 0xAD bytes.
        assertEq(address(account).code.length, 0xad, "deployed proxy is the 173-byte EIP layout");
    }

    function test_registry_createAccountIsIdempotent() public {
        // Second call for an existing binding returns the SAME address and must not revert.
        address again = registry.createAccount(
            address(implementation), SALT, block.chainid, address(nft), TOKEN_ID
        );
        assertEq(again, address(account), "idempotent createAccount");
    }

    function test_registry_saltAndImplementationChangeTheAddress() public {
        address salted =
            address(_createAccount(bytes32(uint256(1)), block.chainid, address(nft), TOKEN_ID));
        assertTrue(salted != address(account), "a different salt is a different account");

        Access0x1Account secondImpl = new Access0x1Account();
        address reImplemented = registry.createAccount(
            address(secondImpl), SALT, block.chainid, address(nft), TOKEN_ID
        );
        assertTrue(
            reImplemented != address(account), "a different implementation is a different account"
        );
    }

    function test_registry_emitsAccountCreatedOnDeploy() public {
        bytes32 freshSalt = bytes32(uint256(0xA11CE));
        address predicted = registry.account(
            address(implementation), freshSalt, block.chainid, address(nft), TOKEN_ID
        );

        vm.expectEmit(true, true, true, true, CANONICAL_REGISTRY);
        emit IERC6551Registry.ERC6551AccountCreated(
            predicted, address(implementation), freshSalt, block.chainid, address(nft), TOKEN_ID
        );
        registry.createAccount(
            address(implementation), freshSalt, block.chainid, address(nft), TOKEN_ID
        );
    }

    function testFuzz_registry_counterfactualParity(uint256 tokenId, bytes32 salt) public {
        address predicted =
            registry.account(address(implementation), salt, block.chainid, address(nft), tokenId);
        address deployed = registry.createAccount(
            address(implementation), salt, block.chainid, address(nft), tokenId
        );
        assertEq(predicted, deployed, "counterfactual == deployed for every (tokenId, salt)");
    }

    /*//////////////////////////////////////////////////////////////
                            TOKEN / OWNER
    //////////////////////////////////////////////////////////////*/

    function test_token_decodesTheBinding() public view {
        (uint256 chainId, address tokenContract, uint256 tokenId) = account.token();
        assertEq(chainId, block.chainid, "bound chainId");
        assertEq(tokenContract, address(nft), "bound token contract");
        assertEq(tokenId, TOKEN_ID, "bound token id");
    }

    function test_token_isConstantAcrossOwnerChanges() public {
        vm.prank(alice);
        nft.transferFrom(alice, bob, TOKEN_ID);

        // The EIP's MUST: token() never changes — it is bytecode, not storage.
        (uint256 chainId, address tokenContract, uint256 tokenId) = account.token();
        assertEq(chainId, block.chainid);
        assertEq(tokenContract, address(nft));
        assertEq(tokenId, TOKEN_ID);
    }

    function test_owner_tracksTheCurrentHolder() public {
        assertEq(account.owner(), alice, "initial holder owns the account");
        vm.prank(alice);
        nft.transferFrom(alice, bob, TOKEN_ID);
        assertEq(account.owner(), bob, "ownership follows the NFT, live");
    }

    function test_owner_zeroOnForeignChainBinding() public {
        // Same token, but the binding says it lives on ANOTHER chain — the account is inert here.
        Access0x1Account foreign = _createAccount(SALT, block.chainid + 1, address(nft), TOKEN_ID);
        assertEq(foreign.owner(), address(0), "no local owner for a foreign-chain binding");
        assertEq(
            foreign.isValidSigner(alice, ""), bytes4(0), "nobody validates on an inert account"
        );
    }

    function test_isValidSigner_magicValueForTheHolder() public view {
        bytes4 magic = account.isValidSigner(alice, "");
        // The EIP-6551 magic value is pinned by the standard: 0x523e3260 (its own selector).
        assertEq(magic, bytes4(0x523e3260), "the EIP-6551 signer magic value");
        assertEq(magic, IERC6551Account.isValidSigner.selector, "selector == magic value");
        assertEq(account.isValidSigner(mallory, ""), bytes4(0), "non-holder is invalid");
    }

    /// @notice {isValidSigner} must not revert even when the binding is garbage: bound to an EOA
    ///         (ownerOf "succeeds" with empty returndata) or to a live contract that is not an
    ///         ERC-721 (ownerOf selector reverts). Proved under raw STATICCALL.
    function test_isValidSigner_neverRevertsOnBrokenBindings() public {
        Access0x1Account boundToEoa =
            _createAccount(SALT, block.chainid, makeAddr("justAnEoa"), TOKEN_ID);
        (bool ok, bytes memory ret) = address(boundToEoa)
            .staticcall(abi.encodeCall(IERC6551Account.isValidSigner, (alice, "")));
        assertTrue(ok, "EOA-bound account: isValidSigner staticcall-safe");
        assertEq(abi.decode(ret, (bytes4)), bytes4(0), "EOA-bound account validates nobody");

        Access0x1Account boundToNonNft =
            _createAccount(SALT, block.chainid, address(usdc), TOKEN_ID);
        (ok, ret) = address(boundToNonNft)
            .staticcall(abi.encodeCall(IERC6551Account.isValidSigner, (alice, "")));
        assertTrue(ok, "non-ERC721-bound account: isValidSigner staticcall-safe");
        assertEq(abi.decode(ret, (bytes4)), bytes4(0), "non-ERC721-bound account validates nobody");
    }

    /// @notice Return-bomb hardening on the view surface: a hostile bound contract whose `ownerOf`
    ///         answers with a 1MB returndata blob must (1) still resolve to NO owner (the strict
    ///         one-word rule) and (2) never force {owner} to copy the blob — the bounded-copy
    ///         staticcall reads at most one word, so the account-side cost stays constant.
    ///         Differential proof: the hardened `owner()` (which ALSO pays the bomb's own
    ///         execution) must cost strictly less gas than one naive full-returndata copy of the
    ///         same bomb — the copy the old high-level staticcall path would have performed.
    function test_owner_boundedGasOnReturnBombBinding() public {
        ReturnBombERC721 bomb = new ReturnBombERC721();
        Access0x1Account bombAccount = _createAccount(SALT, block.chainid, address(bomb), TOKEN_ID);

        uint256 gasBefore = gasleft();
        address resolved = bombAccount.owner();
        uint256 hardenedGas = gasBefore - gasleft();
        assertEq(resolved, address(0), "a return-bombing binding resolves to no owner");
        assertEq(bombAccount.isValidSigner(alice, ""), bytes4(0), "and validates nobody");

        // The naive baseline: a high-level staticcall that copies ALL returndata into memory —
        // exactly what owner() must never do again.
        gasBefore = gasleft();
        (bool ok, bytes memory blob) =
            address(bomb).staticcall(abi.encodeCall(IERC721.ownerOf, (TOKEN_ID)));
        uint256 naiveCopyGas = gasBefore - gasleft();
        assertTrue(ok, "the bomb itself answers successfully");
        assertEq(blob.length, bomb.BOMB_SIZE(), "the bomb really returned 1MB");
        assertLt(
            hardenedGas,
            naiveCopyGas,
            "bounded-copy owner() must cost less than one full copy of the bomb"
        );
    }

    function testFuzz_isValidSigner_nonHolderNeverValidates(address signer) public view {
        vm.assume(signer != alice);
        assertEq(account.isValidSigner(signer, ""), bytes4(0), "only the holder validates");
    }

    /*//////////////////////////////////////////////////////////////
                                EXECUTE
    //////////////////////////////////////////////////////////////*/

    function test_execute_holderSendsEther() public {
        vm.deal(address(account), 1 ether);

        vm.prank(alice);
        bytes memory result = account.execute(bob, 0.6 ether, "", 0);

        assertEq(result.length, 0, "plain ETH send returns no data");
        assertEq(bob.balance, 0.6 ether, "receiver got the ETH");
        assertEq(address(account).balance, 0.4 ether, "account keeps the rest");
        assertEq(account.state(), 1, "one successful execute bumps state once");
    }

    function test_execute_forwardsMsgValue() public {
        // `payable` execute: fund the account and spend in the same transaction.
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        account.execute{ value: 1 ether }(bob, 1 ether, "", 0);
        assertEq(bob.balance, 1 ether, "msg.value flowed straight through");
        assertEq(address(account).balance, 0, "nothing stranded");
    }

    function test_execute_returnsCalleeReturnDataExactly() public {
        usdc.mint(address(account), 100e6);

        vm.prank(alice);
        bytes memory result =
            account.execute(address(usdc), 0, abi.encodeCall(usdc.transfer, (bob, 40e6)), 0);

        assertTrue(abi.decode(result, (bool)), "callee return data comes back verbatim");
        assertEq(usdc.balanceOf(bob), 40e6, "the account's tokens moved");
        assertEq(usdc.balanceOf(address(account)), 60e6, "remainder stays");
    }

    function test_execute_revertsForNonSigner() public {
        vm.deal(address(account), 1 ether);
        vm.prank(mallory);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Account.Access0x1Account__InvalidSigner.selector, mallory
            )
        );
        account.execute(mallory, 1 ether, "", 0);
    }

    function testFuzz_execute_unsupportedOperationsRevert(uint8 operation) public {
        vm.assume(operation != 0);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Account.Access0x1Account__UnsupportedOperation.selector, operation
            )
        );
        account.execute(bob, 0, "", operation);
    }

    function test_execute_bubblesCustomErrorVerbatim() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RevertingCallee.RevertingCallee__Boom.selector, 42));
        account.execute(address(callee), 0, abi.encodeCall(callee.boom, (42)), 0);
    }

    function test_execute_bubblesStringRevertVerbatim() public {
        vm.prank(alice);
        vm.expectRevert("RevertingCallee: nope");
        account.execute(address(callee), 0, abi.encodeCall(callee.nope, ()), 0);
    }

    function test_execute_stateIncrementsOnlyOnSuccess() public {
        assertEq(account.state(), 0, "fresh account starts at state 0");

        vm.prank(alice);
        account.execute(bob, 0, "", 0);
        assertEq(account.state(), 1, "success bumps state");

        // A failed execute reverts wholesale — the pre-call increment rolls back with it.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RevertingCallee.RevertingCallee__Boom.selector, 7));
        account.execute(address(callee), 0, abi.encodeCall(callee.boom, (7)), 0);
        assertEq(account.state(), 1, "failed execute leaves state untouched");

        vm.prank(alice);
        account.execute(bob, 0, "", 0);
        assertEq(account.state(), 2, "next success bumps again");
    }

    /// @notice Sell the NFT, sell the account: the new holder controls it immediately and the old
    ///         holder is locked out — there is no residual authority to revoke.
    function test_execute_controlFollowsTheNft() public {
        vm.deal(address(account), 1 ether);
        vm.prank(alice);
        nft.transferFrom(alice, bob, TOKEN_ID);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Account.Access0x1Account__InvalidSigner.selector, alice)
        );
        account.execute(alice, 1 ether, "", 0);

        vm.prank(bob);
        account.execute(bob, 1 ether, "", 0);
        assertEq(bob.balance, 1 ether, "the new holder spends the account");
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-1271
    //////////////////////////////////////////////////////////////*/

    /// @dev Mint a fresh token to `holder` and return its TBA (distinct id per test).
    function _accountHeldBy(address holder, uint256 tokenId) internal returns (Access0x1Account) {
        nft.mintId(holder, tokenId);
        return _createAccount(SALT, block.chainid, address(nft), tokenId);
    }

    function test_isValidSignature_eoaOwnerSignatureValid() public {
        (address signer, uint256 signerPk) = makeAddrAndKey("eoaOwner");
        Access0x1Account tba = _accountHeldBy(signer, 2);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, DIGEST);
        assertEq(
            tba.isValidSignature(DIGEST, abi.encodePacked(r, s, v)),
            IERC1271.isValidSignature.selector,
            "the holder's ECDSA signature validates"
        );
    }

    function test_isValidSignature_wrongSignerInvalid() public {
        (address signer,) = makeAddrAndKey("eoaOwner");
        (, uint256 strangerPk) = makeAddrAndKey("stranger");
        Access0x1Account tba = _accountHeldBy(signer, 2);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(strangerPk, DIGEST);
        assertEq(
            tba.isValidSignature(DIGEST, abi.encodePacked(r, s, v)),
            bytes4(0xffffffff),
            "a stranger's signature is rejected"
        );
    }

    function test_isValidSignature_smartAccountOwnerValid() public {
        // The NFT is held by an ERC-1271 smart wallet — SignatureChecker nests into it.
        (address walletSigner, uint256 walletSignerPk) = makeAddrAndKey("walletSigner");
        SmartWallet1271 wallet = new SmartWallet1271(walletSigner);
        nft.mintId(alice, 3);
        vm.prank(alice);
        nft.transferFrom(alice, address(wallet), 3); // unsafe transfer — the wallet has no receiver hook
        Access0x1Account tba = _createAccount(SALT, block.chainid, address(nft), 3);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletSignerPk, DIGEST);
        assertEq(
            tba.isValidSignature(DIGEST, abi.encodePacked(r, s, v)),
            IERC1271.isValidSignature.selector,
            "the smart-account owner's signature validates via nested ERC-1271"
        );
    }

    function test_isValidSignature_staleAfterNftTransfer() public {
        (address signer, uint256 signerPk) = makeAddrAndKey("eoaOwner");
        Access0x1Account tba = _accountHeldBy(signer, 2);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, DIGEST);
        bytes memory signature = abi.encodePacked(r, s, v);
        assertEq(tba.isValidSignature(DIGEST, signature), IERC1271.isValidSignature.selector);

        vm.prank(signer);
        nft.transferFrom(signer, bob, 2);
        assertEq(
            tba.isValidSignature(DIGEST, signature),
            bytes4(0xffffffff),
            "the old holder's signature dies with the transfer"
        );
    }

    /// @notice ERC-1271 must not revert on garbage: wrong-length signatures, and accounts with no
    ///         local owner at all (foreign-chain binding). Proved under raw STATICCALL.
    function test_isValidSignature_neverRevertsOnGarbage() public {
        (bool ok, bytes memory ret) = address(account)
            .staticcall(abi.encodeWithSelector(IERC1271.isValidSignature.selector, DIGEST, ""));
        assertTrue(ok, "empty signature: staticcall-safe");
        assertEq(abi.decode(ret, (bytes4)), bytes4(0xffffffff), "empty signature is just invalid");

        Access0x1Account foreign = _createAccount(SALT, block.chainid + 1, address(nft), TOKEN_ID);
        (ok, ret) = address(foreign)
            .staticcall(abi.encodeWithSelector(IERC1271.isValidSignature.selector, DIGEST, ""));
        assertTrue(ok, "ownerless account: staticcall-safe");
        assertEq(abi.decode(ret, (bytes4)), bytes4(0xffffffff), "ownerless account rejects all");
    }

    /*//////////////////////////////////////////////////////////////
                             ASSET HOLDING
    //////////////////////////////////////////////////////////////*/

    function test_receive_acceptsPlainEther() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(account).call{ value: 1 ether }("");
        assertTrue(ok, "receive() accepts plain ETH");
        assertEq(address(account).balance, 1 ether);
    }

    function test_holdsErc20() public {
        usdc.mint(address(account), 250e6);
        assertEq(usdc.balanceOf(address(account)), 250e6, "the TBA holds ERC-20 like any wallet");
    }

    function test_holdsErc721_viaSafeTransfer() public {
        // A DIFFERENT id from the same collection safe-transfers in fine — only the bound token
        // is refused (the cycle guard is exact, not collection-wide).
        nft.mintId(alice, 7);
        vm.prank(alice);
        nft.safeTransferFrom(alice, address(account), 7);
        assertEq(nft.ownerOf(7), address(account), "the TBA holds ERC-721 via the safe path");
    }

    function test_holdsErc1155_singleAndBatch() public {
        multi.mint(address(account), 1, 10);
        assertEq(multi.balanceOf(address(account), 1), 10, "single ERC-1155 receipt");

        uint256[] memory ids = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        ids[0] = 2;
        ids[1] = 3;
        amounts[0] = 5;
        amounts[1] = 8;
        multi.mintBatch(address(account), ids, amounts);
        assertEq(multi.balanceOf(address(account), 2), 5, "batch ERC-1155 receipt (id 2)");
        assertEq(multi.balanceOf(address(account), 3), 8, "batch ERC-1155 receipt (id 3)");
    }

    /// @notice The ownership-cycle guard: safe-transferring the account's OWN bound token into the
    ///         account would make the account its own owner — bricked forever — so the receiver
    ///         hook refuses it and the NFT stays put.
    function test_ownershipCycleGuard_refusesTheBoundToken() public {
        vm.prank(alice);
        vm.expectRevert(Access0x1Account.Access0x1Account__OwnershipCycle.selector);
        nft.safeTransferFrom(alice, address(account), TOKEN_ID);
        assertEq(nft.ownerOf(TOKEN_ID), alice, "the bound token never moved");
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    function test_supportsInterface_advertisesTheStandardIds() public view {
        // The EIP-6551 ids are pinned by the standard text: 0x6faff5f1 / 0x51945447.
        assertEq(
            type(IERC6551Account).interfaceId,
            bytes4(0x6faff5f1),
            "IERC6551Account drifted from the EIP id"
        );
        assertEq(
            type(IERC6551Executable).interfaceId,
            bytes4(0x51945447),
            "IERC6551Executable drifted from the EIP id"
        );

        assertTrue(account.supportsInterface(type(IERC6551Account).interfaceId), "6551 account");
        assertTrue(
            account.supportsInterface(type(IERC6551Executable).interfaceId), "6551 executable"
        );
        assertTrue(account.supportsInterface(type(IERC1271).interfaceId), "ERC-1271");
        assertTrue(account.supportsInterface(type(IERC721Receiver).interfaceId), "721 receiver");
        assertTrue(account.supportsInterface(type(IERC1155Receiver).interfaceId), "1155 receiver");
        assertTrue(account.supportsInterface(type(IERC165).interfaceId), "ERC-165");
        assertFalse(account.supportsInterface(0xffffffff), "0xffffffff must be false per ERC-165");
    }
}
