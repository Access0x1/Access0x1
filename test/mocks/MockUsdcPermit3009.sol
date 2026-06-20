// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice A 6-decimal USDC stand-in that implements BOTH gasless-funding standards the {Refunds}
///         contract supports: EIP-2612 `permit` (inherited from OZ's {ERC20Permit}) AND Circle's
///         EIP-3009 `receiveWithAuthorization`. It mirrors real USDC's surface so the gasless refund
///         legs are exercised against the exact signed-authorization shape they meet on-chain.
/// @dev    The 3009 implementation is the canonical Circle one: a typed-data digest over
///         `ReceiveWithAuthorization(from,to,value,validAfter,validBefore,nonce)`, a per-`from` nonce
///         map for replay protection, a `to == msg.sender` caller binding (so only the intended
///         recipient can pull the authorization), and the `[validAfter, validBefore)` time window.
contract MockUsdcPermit3009 is ERC20, ERC20Permit {
    /// @notice The EIP-3009 typehash for `receiveWithAuthorization` (Circle's exact string).
    bytes32 private constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// @notice from ⇒ 3009 nonce ⇒ used. A 3009 nonce is an arbitrary 32-byte value (not sequential),
    ///         consumed once; this is the on-token replay guard the {Refunds} 3009 leg relies on.
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    /// @notice A 3009 authorization was used (mirrors Circle's event for parity).
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    error AuthInvalidSignature();
    error AuthNotYetValid();
    error AuthExpired();
    error AuthAlreadyUsed();
    error AuthWrongCaller();

    constructor() ERC20("Mock USDC", "USDC") ERC20Permit("Mock USDC") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Circle's EIP-3009 receive-with-authorization: pull `value` from `from` into the caller
    ///         (`to`), authorized by `from`'s off-chain signature. The caller MUST be `to`.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (to != msg.sender) revert AuthWrongCaller();
        if (block.timestamp <= validAfter) revert AuthNotYetValid();
        if (block.timestamp >= validBefore) revert AuthExpired();
        if (authorizationState[from][nonce]) revert AuthAlreadyUsed();

        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, v, r, s);
        if (err != ECDSA.RecoverError.NoError || recovered != from) revert AuthInvalidSignature();

        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }
}
