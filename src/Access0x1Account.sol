// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import { IERC1155Receiver } from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { IERC6551Account } from "./interfaces/IERC6551Account.sol";
import { IERC6551Executable } from "./interfaces/IERC6551Executable.sol";

/// @title  Access0x1Account
/// @author Access0x1
/// @notice A MINIMAL, VANILLA ERC-6551 token bound account: the smart-contract wallet an NFT owns.
///         Whoever holds the bound token IS the account — they (and only they) can execute calls,
///         spend its Ether, and move the ERC-20/721/1155 assets it holds; sell or transfer the NFT
///         and the whole account (with everything inside) changes hands atomically. One
///         implementation serves every token: the registry deploys an ERC-1167 proxy per
///         (token, salt) whose appended constant data says which NFT rules it, so deploying THIS
///         contract once per chain is all a collection ever needs.
/// @dev    REUSABLE-BASE RULES (nothing privileged, nothing hardcoded): zero constructor params,
///         zero roles, zero fees, no upgrade path, no guardian — the ONLY authority is the current
///         holder of the bound token, read live from its ERC-721 contract at every check. The
///         binding itself is immutable by construction: {token} decodes the ERC-1167 proxy's
///         appended constant data (extcodecopy at offset 0x4d, skipping the 32-byte salt at 0x2d),
///         so it can never change — exactly the EIP's MUST-be-constant rule.
///         SIGNER MODEL: {isValidSigner} returns the EIP-6551 magic value `0x523e3260` iff the
///         queried address is the current token holder; ERC-1271 {isValidSignature} accepts any
///         signature that OZ SignatureChecker validates for that holder (EOA ECDSA or nested
///         ERC-1271 smart-account owner). Both are hardened to NEVER revert: {owner} returns
///         `address(0)` — never throws — when the bound token lives on another chain
///         (`chainId != block.chainid`), when the token contract is not a contract, when
///         `ownerOf` reverts, or when it returns anything that is not a clean address; and
///         `address(0)` is never a valid signer.
///         EXECUTION: {execute} is holder-only and supports ONLY operation 0 (CALL) — the same
///         restriction as the EIP's own minimal reference account (DELEGATECALL could rewrite the
///         proxy's storage semantics, CREATE/CREATE2 add surface a minimal account does not need);
///         anything else reverts with {Access0x1Account__UnsupportedOperation}. `state` is bumped
///         BEFORE the external call (a reentrant observer already sees the new state) and a failed
///         call re-throws the callee's revert data verbatim.
///         KNOWN SEMANTICS (documented, not bugs): (1) {onERC721Received} REVERTS if the incoming
///         token is the account's OWN bound token — an account owning its own controller is a
///         permanent brick (nobody could ever sign for it again), so that cycle is refused at the
///         door; unsafe `transferFrom` cannot be guarded this way (no hook exists), which is an
///         ERC-721 limitation every 6551 account shares. (2) On a chain where the bound token does
///         not live, the account is deliberately INERT (owner is zero, nothing validates, nothing
///         executes) rather than guessing at a cross-chain owner. (3) Calling the view surface on
///         the bare implementation (not a registry proxy) reads its own bytecode as "context" and
///         yields meaningless-but-harmless values; only registry-created proxies are real accounts.
contract Access0x1Account is
    IERC165,
    IERC1271,
    IERC721Receiver,
    IERC1155Receiver,
    IERC6551Account,
    IERC6551Executable
{
    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice EIP-6551 state counter: incremented on every successful {execute}, so off-chain
    ///         actors holding a signed commitment about this account can detect it went stale.
    ///         (Public variable — the generated getter IS the interface's `state()`.)
    uint256 public state;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice `msg.sender` is not a valid signer for this account (not the current holder of the
    ///         bound token, or the account is inert on this chain).
    /// @param signer The rejected caller.
    error Access0x1Account__InvalidSigner(address signer);

    /// @notice {execute} was asked for an operation other than 0 (CALL) — this minimal account,
    ///         like the EIP's own reference account, supports call operations only.
    /// @param operation The rejected operation code.
    error Access0x1Account__UnsupportedOperation(uint8 operation);

    /// @notice A safe-transfer tried to deposit the account's OWN bound token into the account —
    ///         an ownership cycle that would brick it forever (its owner would become itself).
    error Access0x1Account__OwnershipCycle();

    /*//////////////////////////////////////////////////////////////
                            RECEIVE (ETHER)
    //////////////////////////////////////////////////////////////*/

    /// @notice Accepts plain Ether unconditionally (EIP-6551: accounts MUST implement `receive`).
    receive() external payable { }

    /*//////////////////////////////////////////////////////////////
                          BOUND TOKEN / OWNER
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC6551Account
    /// @dev Reads the ERC-1167 proxy's appended constant data laid down by the registry:
    ///      `extcodecopy` of this account's own code at offset `0x4d` for `0x60` bytes — i.e. the
    ///      (chainId, tokenContract, tokenId) words, SKIPPING the 45-byte minimal-proxy prelude
    ///      (bytes 0..0x2d) and the 32-byte salt (0x2d..0x4d). Pure bytecode, so the value is
    ///      constant for the account's whole life (the EIP's MUST). Decoded in assembly with the
    ///      address word masked to 160 bits, so this NEVER reverts — a guarantee {owner},
    ///      {isValidSigner} and {isValidSignature} inherit.
    function token() public view returns (uint256 chainId, address tokenContract, uint256 tokenId) {
        assembly {
            let ptr := mload(0x40) // scratch only — nothing is allocated, no pointer update needed
            extcodecopy(address(), ptr, 0x4d, 0x60)
            chainId := mload(ptr)
            tokenContract := shr(96, shl(96, mload(add(ptr, 0x20))))
            tokenId := mload(add(ptr, 0x40))
        }
    }

    /// @notice The current holder of the bound token — the ONE authority over this account — or
    ///         `address(0)` when no local owner exists.
    /// @dev    NEVER reverts (the account's whole signer surface relies on it): returns
    ///         `address(0)` when the bound token's chain is not this chain, when the token
    ///         contract has no code or `ownerOf` reverts (EOA / non-ERC-721 target), or when the
    ///         staticcall returns anything but one clean left-padded address word.
    ///         RETURN-BOMB HARDENED: the `ownerOf` staticcall is made in assembly with a fixed
    ///         32-byte output buffer (the EVM copies `min(returndatasize, 32)` bytes), so a
    ///         malicious bound contract answering with a huge returndata blob can NEVER force this
    ///         account to copy it — the caller-side cost of probing a hostile binding stays
    ///         constant no matter what the callee returns. `returndatasize()` must equal exactly
    ///         32, preserving the strict "one clean word" acceptance rule of the high-level path.
    /// @return The bound token's current holder, or `address(0)` if undeterminable here.
    function owner() public view returns (address) {
        (uint256 chainId, address tokenContract, uint256 tokenId) = token();
        if (chainId != block.chainid) return address(0);

        bytes memory callData = abi.encodeCall(IERC721.ownerOf, (tokenId));
        bool ok;
        uint256 word;
        assembly {
            // Bounded-copy staticcall into scratch space (0x00..0x1f): at most one word of
            // returndata ever lands in this frame's memory — no attacker-sized expansion.
            ok := staticcall(gas(), tokenContract, add(callData, 0x20), mload(callData), 0x00, 0x20)
            // An EOA "succeeds" with empty returndata; any length other than one exact word is
            // not an address. `word` is only trusted when all 32 buffer bytes were written.
            ok := and(ok, eq(returndatasize(), 0x20))
            word := mload(0x00)
        }
        // Dirty upper bits are not an address either. All failure modes mean "no owner here" —
        // never a revert.
        if (!ok || word >> 160 != 0) return address(0);
        return address(uint160(word));
    }

    /// @inheritdoc IERC6551Account
    /// @dev The EIP default and nothing more: the current token holder is the only valid signer.
    ///      Returns the EIP-6551 magic value `0x523e3260` (this function's own selector) when
    ///      valid, `bytes4(0)` otherwise. `context` is unused by this minimal implementation.
    ///      Never reverts — {owner} absorbs every failure mode into `address(0)`, which never
    ///      validates.
    function isValidSigner(address signer, bytes calldata)
        external
        view
        returns (bytes4 magicValue)
    {
        if (_isValidSigner(signer)) {
            return IERC6551Account.isValidSigner.selector;
        }
        return bytes4(0);
    }

    /// @inheritdoc IERC1271
    /// @dev EIP-6551 requires full ERC-1271 support in addition to {isValidSigner}. Validation is
    ///      delegated to OZ SignatureChecker against {owner}, so BOTH owner kinds work: an EOA
    ///      (ECDSA recovery) and a smart-account owner (nested ERC-1271 staticcall). Returns the
    ///      ERC-1271 magic value `0x1626ba7e` when valid and `0xffffffff` otherwise — including
    ///      when the account has no local owner. Never reverts (tryRecover + staticcall
    ///      underneath).
    function isValidSignature(bytes32 hash, bytes memory signature)
        external
        view
        returns (bytes4 magicValue)
    {
        address currentOwner = owner();
        if (
            currentOwner != address(0)
                && SignatureChecker.isValidSignatureNow(currentOwner, hash, signature)
        ) {
            return IERC1271.isValidSignature.selector;
        }
        return 0xffffffff;
    }

    /*//////////////////////////////////////////////////////////////
                               EXECUTION
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC6551Executable
    /// @dev Holder-only, CALL-only: `msg.sender` must be a valid signer ({owner}, non-zero) and
    ///      `operation` must be 0 — the same restriction the EIP's own minimal reference account
    ///      applies (see the interface NatSpec for why the EIP permits restricting operations).
    ///      `state` increments BEFORE the external call, so any reentrant observer already sees
    ///      the post-operation state; a failed call re-throws the callee's revert data VERBATIM
    ///      (and the revert also rolls the increment back — failed executions leave no trace).
    ///      `payable` so the signer can fund the account and spend in one transaction.
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory result)
    {
        if (!_isValidSigner(msg.sender)) {
            revert Access0x1Account__InvalidSigner(msg.sender);
        }
        if (operation != 0) revert Access0x1Account__UnsupportedOperation(operation);

        ++state;

        bool ok;
        (ok, result) = to.call{ value: value }(data);
        if (!ok) {
            // Bubble the callee's revert data exactly — custom errors, strings, panics, raw bytes.
            assembly {
                revert(add(result, 0x20), mload(result))
            }
        }
    }

    /// @dev The single signer policy: the queried address must be the current bound-token holder,
    ///      and a holder must exist here (`owner() != address(0)` — an inert cross-chain or
    ///      broken-token account validates nobody).
    function _isValidSigner(address signer) internal view returns (bool) {
        address currentOwner = owner();
        return currentOwner != address(0) && signer == currentOwner;
    }

    /*//////////////////////////////////////////////////////////////
                            TOKEN RECEIVERS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC721Receiver
    /// @dev Accepts any ERC-721 EXCEPT the account's own bound token: if (tokenContract, tokenId)
    ///      of the incoming token equals the binding (on the bound chain), the deposit is refused
    ///      with {Access0x1Account__OwnershipCycle} — an account that owns its own controller can
    ///      never be operated again, so the cycle is blocked at the safe-transfer hook.
    function onERC721Received(address, address, uint256 receivedTokenId, bytes calldata)
        external
        view
        returns (bytes4)
    {
        (uint256 chainId, address tokenContract, uint256 tokenId) = token();
        if (chainId == block.chainid && msg.sender == tokenContract && receivedTokenId == tokenId) {
            revert Access0x1Account__OwnershipCycle();
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @inheritdoc IERC1155Receiver
    /// @dev Accepts all ERC-1155 single transfers (an ERC-1155 id can never be the ERC-721 bound
    ///      token, so no cycle is possible on this path).
    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    /// @inheritdoc IERC1155Receiver
    /// @dev Accepts all ERC-1155 batch transfers.
    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    /// @notice ERC-165 detection for everything this account is: {IERC6551Account} (`0x6faff5f1`),
    ///         {IERC6551Executable} (`0x51945447`) — the EIP's MUST-signal execution interface —
    ///         plus IERC1271, the ERC-721/1155 receiver interfaces, and IERC165 itself.
    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId
            || interfaceId == type(IERC6551Account).interfaceId
            || interfaceId == type(IERC6551Executable).interfaceId
            || interfaceId == type(IERC1271).interfaceId
            || interfaceId == type(IERC721Receiver).interfaceId
            || interfaceId == type(IERC1155Receiver).interfaceId;
    }
}
