// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { SessionGrant } from "../../src/SessionGrant.sol";

/// @notice A MALICIOUS ERC-6492 "factory" that, instead of deploying a wallet, re-enters
///         {SessionGrant.openSessionFor} during the 6492 prepare step. This is the concrete probe for
///         slither's `reentrancy-no-eth` flag on `openSessionFor`: the only external call in the
///         contract is `factory.call(factoryCalldata)` inside the 6492 prepare path, and it fires
///         BEFORE the owner nonce is written. This mock weaponises exactly that call.
///
///         The attack it tries: replay one captured signature to open TWO sessions for the same
///         (owner, delegate, nonce) tuple. The defense it must hit: SessionGrant {_open} RE-READS the
///         owner nonce and the {SessionGrant__SessionExists} collision guard, so the re-entrant open
///         lands on the SAME session id and reverts — the single signature can authorize only one
///         session. A successful test means the re-entrant open is REJECTED.
contract ReentrantSessionFactory {
    SessionGrant public immutable grant;

    address public reentryOwner;
    address public reentryDelegate;
    uint256 public reentryBudget;
    uint64 public reentryExpiry;
    bytes public reentrySig;

    bool public didReenter;
    bool public reentryReverted;

    constructor(SessionGrant grant_) {
        grant = grant_;
    }

    /// @notice Arm the re-entrant payload the factory will replay when invoked during 6492 prepare.
    function arm(
        address owner_,
        address delegate_,
        uint256 budget_,
        uint64 expiry_,
        bytes calldata sig_
    ) external {
        reentryOwner = owner_;
        reentryDelegate = delegate_;
        reentryBudget = budget_;
        reentryExpiry = expiry_;
        reentrySig = sig_;
    }

    /// @notice The "deploy" the 6492 wrapper calls. On its FIRST invocation it re-enters
    ///         openSessionFor with the armed payload (the PLAIN, unwrapped signature the outer call is
    ///         mid-validating, so no further factory call recurses) and records whether the re-entrant
    ///         open was rejected. It never reverts itself (best-effort prepare), so the outer call's
    ///         own nonce re-read + collision guard is what we are testing.
    function deploy(address) external returns (address) {
        if (didReenter) return address(this); // re-enter once only; no infinite recursion
        didReenter = true;
        try grant.openSessionFor(
            reentryOwner, reentryDelegate, reentryBudget, reentryExpiry, reentrySig
        ) {
            reentryReverted = false;
        } catch {
            reentryReverted = true;
        }
        return address(this);
    }
}
