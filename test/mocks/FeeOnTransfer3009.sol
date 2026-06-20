// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice An EIP-3009 token that ALSO skims 1% on every transfer. It exists to prove the {Refunds}
///         3009 funding leg's balance-delta check rejects a fee-on-transfer token: the authorization's
///         `value` is debited from the funder but the contract receives less, so `received != amount`
///         and {requestRefundWithAuthorization} reverts {Refunds__FeeOnTransferToken}.
contract FeeOnTransfer3009 is ERC20, EIP712 {
    bytes32 private constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    error AuthInvalidSignature();
    error AuthAlreadyUsed();
    error AuthWrongCaller();

    constructor() ERC20("FOT 3009", "FOT9") EIP712("FOT 3009", "1") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice The EIP-712 domain separator, exposed so the test can build a 3009 authorization digest.
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Same 3009 surface as the clean mock, but the `_update` override skims 1% so the realized
    ///         receipt is below the authorized `value`.
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
        if (authorizationState[from][nonce]) revert AuthAlreadyUsed();
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce
            )
        );
        (address recovered, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(_hashTypedDataV4(structHash), v, r, s);
        if (err != ECDSA.RecoverError.NoError || recovered != from) revert AuthInvalidSignature();
        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100; // 1% skim
            super._update(from, to, value - fee);
            if (fee > 0) super._update(from, address(0xdead), fee);
        } else {
            super._update(from, to, value);
        }
    }
}
