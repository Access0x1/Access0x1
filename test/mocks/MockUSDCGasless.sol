// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice A test-only 6-decimal USDC stand-in modeling Circle's `FiatTokenV2_2` gasless surfaces — the
///         three rails {GaslessPayIn} consumes, on the SAME EIP-712 domain real USDC uses:
///           • EIP-2612 `permit(owner,spender,value,deadline,v,r,s)` — sequential-nonce allowance;
///           • ERC-7597 `permit(owner,spender,value,deadline,bytes signature)` — the bytes-sig variant
///             validated via {SignatureChecker} (so an ERC-1271 smart account can sign);
///           • EIP-3009 `transferWithAuthorization(from,to,value,validAfter,validBefore,nonce,v,r,s)`
///             plus `authorizationState` — the random-nonce, allowance-free direct pull.
/// @dev    Faithful to the standards' typehashes so a signature built in a test against this token is
///         exactly what a relayer would replay against real USDC. Mint is unrestricted for funding.
contract MockUSDCGasless is ERC20, EIP712 {
    /// @notice keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256
    ///         deadline)") — the EIP-2612 / ERC-7597 permit struct (both share this typehash).
    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
    );

    /// @notice keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256
    ///         validAfter,uint256 validBefore,bytes32 nonce)") — the EIP-3009 transfer struct.
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// @notice owner ⇒ next sequential permit nonce (EIP-2612 / ERC-7597 replay guard).
    mapping(address owner => uint256 nonce) public nonces;

    /// @notice authorizer ⇒ 32-byte nonce ⇒ used (EIP-3009 single-use replay guard).
    mapping(address authorizer => mapping(bytes32 nonce => bool used)) private _authStates;

    /// @notice Emitted when an EIP-3009 authorization nonce is consumed (mirrors USDC's event).
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    error PermitExpired();
    error InvalidPermitSignature();
    error AuthExpired();
    error AuthNotYetValid();
    error AuthAlreadyUsed();
    error InvalidAuthSignature();

    constructor() ERC20("USD Coin", "USDC") EIP712("USD Coin", "2") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice The token's EIP-712 domain separator (exposed for off-chain signers / parity with USDC).
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Whether an EIP-3009 authorization nonce has been consumed for `authorizer`.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authStates[authorizer][nonce];
    }

    /// @notice EIP-2612 permit (split `v,r,s`).
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (block.timestamp > deadline) revert PermitExpired();
        bytes32 digest = _permitDigest(owner, spender, value, deadline);
        address signer = ECDSA.recover(digest, v, r, s);
        if (signer != owner) revert InvalidPermitSignature();
        _approve(owner, spender, value);
    }

    /// @notice ERC-7597 permit (single `bytes` signature; ERC-1271-capable via {SignatureChecker}).
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert PermitExpired();
        bytes32 digest = _permitDigest(owner, spender, value, deadline);
        if (!SignatureChecker.isValidSignatureNow(owner, digest, signature)) {
            revert InvalidPermitSignature();
        }
        _approve(owner, spender, value);
    }

    /// @notice EIP-3009 transferWithAuthorization (split `v,r,s`) — allowance-free direct pull.
    function transferWithAuthorization(
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
        if (block.timestamp <= validAfter) revert AuthNotYetValid();
        if (block.timestamp >= validBefore) revert AuthExpired();
        if (_authStates[from][nonce]) revert AuthAlreadyUsed();

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                    from,
                    to,
                    value,
                    validAfter,
                    validBefore,
                    nonce
                )
            )
        );
        address signer = ECDSA.recover(digest, v, r, s);
        if (signer != from) revert InvalidAuthSignature();

        _authStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /// @dev The EIP-2612 / ERC-7597 permit digest, consuming and advancing the owner's sequential nonce.
    function _permitDigest(address owner, address spender, uint256 value, uint256 deadline)
        private
        returns (bytes32)
    {
        uint256 nonce = nonces[owner]++;
        return _hashTypedDataV4(
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline))
        );
    }
}
