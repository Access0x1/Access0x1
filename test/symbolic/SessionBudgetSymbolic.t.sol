// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { SessionGrant } from "../../src/SessionGrant.sol";
import { ISessionGrant } from "../../src/interfaces/ISessionGrant.sol";

/// @title  SessionBudgetSymbolic — prove the never-negative spend meter SYMBOLICALLY (Halmos)
/// @author Access0x1
/// @notice The never-negative budget is the security surface of {SessionGrant} (and, by composition,
///         the heart of {Access0x1Subscriptions}): a delegate can spend up to the authorized
///         `budgetCap` and NOT ONE WEI MORE, for ANY sequence of spend amounts. Here Halmos drives
///         a SYMBOLIC spend and proves the invariant `spent <= budgetCap` is preserved — across all
///         possible spend amounts the solver can construct, not just sampled fuzz values.
///
///         This runs against the REAL {SessionGrant} contract (no oracle, no token — `spend` is pure
///         budget arithmetic), so the symbolic proof is over the shipped bytecode's logic.
///
///         RUN: `make halmos`. The file also compiles + runs under `forge test` via the concrete
///         `test_` wrappers, so the gate never depends on Halmos being installed.
contract SessionBudgetSymbolic is Test {
    SessionGrant internal grant;

    address internal owner = address(0xA11CE);
    address internal delegate = address(0xBEEF);
    uint64 internal expiry;

    function setUp() public {
        grant = new SessionGrant("Access0x1 SessionGrant", "1");
        vm.warp(1_700_000_000);
        expiry = uint64(block.timestamp + 365 days);
    }

    /// @notice SYMBOLIC: open a session, then a single symbolic spend can never push `spent` past the
    ///         cap. Either the spend is within budget (and remaining decreases by exactly the amount)
    ///         or it reverts — the budget can never go negative and is never silently exceeded.
    /// @dev Halmos picks `budgetCap` and `amount` symbolically. We open as the owner, then spend as the
    ///      delegate. The proof: after a SUCCESSFUL spend, `spent <= budgetCap` holds; an over-budget
    ///      spend MUST revert (so it can never write a state that violates the invariant).
    function check_spend_neverExceedsBudget(uint256 budgetCap, uint256 amount) public {
        // Bound to the realistic accounting domain (USD-8dp values well under 2^128) so the solver
        // explores the meaningful space; budgetCap must be non-zero (the contract rejects a zero cap).
        vm.assume(budgetCap > 0 && budgetCap <= type(uint128).max);
        vm.assume(amount > 0 && amount <= type(uint128).max);

        vm.prank(owner);
        bytes32 sessionId = grant.openSession(delegate, budgetCap, expiry);

        // A spend strictly greater than the cap MUST revert — it can never be applied.
        if (amount > budgetCap) {
            vm.prank(delegate);
            vm.expectRevert();
            grant.spend(sessionId, amount);
            // The budget is untouched by the rejected spend.
            assert(grant.remaining(sessionId) == budgetCap);
        } else {
            // An in-budget spend applies exactly, leaving remaining == cap - amount (never negative).
            vm.prank(delegate);
            uint256 remainingAfter = grant.spend(sessionId, amount);
            assert(remainingAfter == budgetCap - amount);
            assert(grant.remaining(sessionId) == budgetCap - amount);
            // The session record's `spent` never exceeds the cap.
            ISessionGrant.Session memory s = grant.sessionOf(sessionId);
            assert(s.spent <= s.budgetCap);
        }
    }

    /// @notice SYMBOLIC: two consecutive spends can never sum past the cap. The second spend reverts
    ///         exactly when it would push the total over budget — the meter holds across a sequence.
    function check_twoSpends_neverExceedBudget(uint256 budgetCap, uint256 a, uint256 b) public {
        vm.assume(budgetCap > 0 && budgetCap <= type(uint128).max);
        vm.assume(a > 0 && a <= budgetCap); // the first spend is in-budget by assumption
        vm.assume(b > 0 && b <= type(uint128).max);

        vm.prank(owner);
        bytes32 sessionId = grant.openSession(delegate, budgetCap, expiry);

        vm.prank(delegate);
        grant.spend(sessionId, a); // succeeds (a <= budgetCap)

        uint256 left = budgetCap - a;
        if (b > left) {
            vm.prank(delegate);
            vm.expectRevert();
            grant.spend(sessionId, b);
            assert(grant.remaining(sessionId) == left); // unchanged by the rejected second spend
        } else {
            vm.prank(delegate);
            grant.spend(sessionId, b);
            assert(grant.remaining(sessionId) == left - b); // exact, never negative
        }
    }

    /*//////////////////////////////////////////////////////////////
                    CONCRETE WRAPPERS (run under forge test)
    //////////////////////////////////////////////////////////////*/

    /// @notice The concrete case so this file is part of the normal `forge test` gate without Halmos.
    function test_spend_neverExceedsBudget_concrete() public {
        vm.prank(owner);
        bytes32 sessionId = grant.openSession(delegate, 1_000e8, expiry);

        vm.prank(delegate);
        uint256 left = grant.spend(sessionId, 400e8);
        assertEq(left, 600e8, "remaining after an in-budget spend");

        // Over-budget by one unit reverts — the meter never goes negative.
        vm.prank(delegate);
        vm.expectRevert();
        grant.spend(sessionId, 600e8 + 1);
        assertEq(grant.remaining(sessionId), 600e8, "budget untouched by the rejected overspend");
    }
}
