// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ICredentialSbt } from "../../src/interfaces/ICredentialSbt.sol";

/// @notice Attacker-controlled "factory" used to prove the {CredentialSbt.claim} CEI / nonce-reuse guard.
///         The ERC-6492 wrapper legs (`factory`, `factoryCalldata`) are NOT covered by the signed EIP-712
///         digest, so any submitter may point them at this contract. When an EOA issuer is validated on
///         the 6492 path, {CredentialSbt} best-effort CALLs `factory` with `factoryCalldata` BEFORE it has
///         consumed the voucher's nonce. This mock uses that call to RE-ENTER {claim} with a SECOND voucher
///         the same issuer signed under the SAME nonce (for a different credType). With the fix (nonce
///         marked used before signature validation) the re-entrant leg must revert {NonceUsed}; without it,
///         the still-false nonce guard is re-read and a second badge mints — one nonce, two badges.
contract ReentrantClaimFactory {
    ICredentialSbt public immutable sbt;

    // The re-entrant TYPE_B voucher, staged by the test before the outer claim.
    address public issuer;
    address public subject;
    bytes32 public credType;
    uint8 public level;
    uint64 public expiresAt;
    uint256 public nonce;
    uint256 public deadline;
    bytes public innerSig;

    bool public reentered;
    bool public reentrantMinted;

    constructor(ICredentialSbt sbt_) {
        sbt = sbt_;
    }

    function stage(
        address issuer_,
        address subject_,
        bytes32 credType_,
        uint8 level_,
        uint64 expiresAt_,
        uint256 nonce_,
        uint256 deadline_,
        bytes calldata innerSig_
    ) external {
        issuer = issuer_;
        subject = subject_;
        credType = credType_;
        level = level_;
        expiresAt = expiresAt_;
        nonce = nonce_;
        deadline = deadline_;
        innerSig = innerSig_;
    }

    /// @dev The address the outer voucher's 6492 wrapper names as `factory`; `factoryCalldata` targets this
    ///      selector. {CredentialSbt} calls it while the issuer is still a codeless EOA on the outer claim.
    function reenter() external {
        reentered = true;
        // Re-enter claim() with the SECOND (TYPE_B, same-nonce) voucher. Guarded so a revert here does not
        // bubble (CredentialSbt ignores the factory-call result anyway) — we record whether the mint stuck.
        try sbt.claim(
            issuer, subject, credType, level, expiresAt, nonce, deadline, innerSig
        ) returns (
            uint256
        ) {
            reentrantMinted = true;
        } catch {
            reentrantMinted = false;
        }
    }
}

/// @notice Attacker "factory" that only OBSERVES the nonce guard state at 6492-factory-call time. Asserts
///         nothing itself — it records {CredentialSbt.isNonceUsed(issuer, nonce)} as seen from inside the
///         external call the contract makes DURING {claim}, so the test can prove the nonce is already
///         consumed (== true) before the external interaction under the fix (was: false, pre-fix).
contract NonceProbeFactory {
    ICredentialSbt public immutable sbt;
    address public issuer;
    uint256 public nonce;
    bool public sawNonceUsed;
    bool public probed;

    constructor(ICredentialSbt sbt_) {
        sbt = sbt_;
    }

    function stage(address issuer_, uint256 nonce_) external {
        issuer = issuer_;
        nonce = nonce_;
    }

    function probe() external {
        probed = true;
        sawNonceUsed = sbt.isNonceUsed(issuer, nonce);
    }
}
