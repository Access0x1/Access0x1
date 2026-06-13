// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice A minimal ERC-1271 smart account: a signature is valid iff its ECDSA recovery matches the
///         configured `signer` EOA. Used to exercise SessionGrant's deployed-smart-account path.
contract SmartWallet1271 is IERC1271 {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    /// @inheritdoc IERC1271
    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) {
            return IERC1271.isValidSignature.selector;
        }
        return 0xffffffff;
    }
}

/// @notice A CREATE2 factory that deploys {SmartWallet1271} at a deterministic, counterfactual
///         address. Used to exercise SessionGrant's ERC-6492 (sign-before-deploy) path: the wallet
///         address is known and signed against BEFORE any code exists, then the 6492 wrapper carries
///         the factory call that brings the account into existence at validation time.
contract WalletFactory {
    /// @notice Deploy a {SmartWallet1271} for `signer` at the CREATE2 address {addressOf} predicts.
    /// @dev    Idempotent-ish: a second call with the same args reverts (CREATE2 collision); callers
    ///         should only deploy once. SessionGrant's 6492 path only calls this when the target has
    ///         no code, so a redundant deploy is never attempted.
    function deploy(address signer_) external returns (address wallet) {
        wallet = address(new SmartWallet1271{ salt: _salt(signer_) }(signer_));
    }

    /// @notice The counterfactual address a {SmartWallet1271} for `signer` will occupy.
    function addressOf(address signer_) external view returns (address) {
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(SmartWallet1271).creationCode, abi.encode(signer_)));
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), _salt(signer_), initCodeHash)
                    )
                )
            )
        );
    }

    function _salt(address signer_) private pure returns (bytes32) {
        return bytes32(uint256(uint160(signer_)));
    }
}
