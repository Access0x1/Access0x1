// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { SessionGrant } from "../../src/SessionGrant.sol";
import { ISessionGrant } from "../../src/interfaces/ISessionGrant.sol";
import { SmartWallet1271, WalletFactory } from "../mocks/SmartWallet1271.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @title  SessionGrantFuzz — stateless (single-call) fuzz suite for SessionGrant
/// @author Access0x1
/// @notice The Cyfrin stateless-fuzz layer: every public / external mutating function is fired ONCE
///         per run with `bound()`-constrained random inputs, and the contract's load-bearing
///         invariants are asserted to hold AFTER that single call. This is distinct from the unit
///         suite (which pins exact values) and the attack suite (which scripts adversarial sequences):
///         here we let the fuzzer roam the legal input space of each function and prove the per-call
///         properties never break.
///
///         INVARIANTS PROVEN PER CALL (the SessionGrant equivalent of "net + fee == gross, no negative
///         balance, zero residual custody" for a money function — SessionGrant is a pure accounting
///         ledger so its money-shaped invariants are budget invariants):
///           * BUDGET CEILING:     spent <= budgetCap ALWAYS (never overspend, even across fuzzed amounts).
///           * CONSERVATION:       spent + remaining == budgetCap for a live session (the budget is fully
///                                 accounted for — the SessionGrant analogue of net + fee == gross).
///           * NON-NEGATIVE:       remaining is monotonically non-increasing and never underflows.
///           * RETURN-CONSISTENCY: spend()'s return value == the on-chain remaining() right after.
///           * NONCE MONOTONIC:    a successful open consumes EXACTLY one owner nonce (replay guard).
///           * ZERO CUSTODY:       the contract NEVER holds ETH — it is a pure authorization ledger.
///
/// @dev    Reuses the existing mocks ({SmartWallet1271}, {WalletFactory}) — no duplicate mocks added.
contract SessionGrantFuzzTest is Test, ProxyDeployer {
    SessionGrant internal grant;
    WalletFactory internal factory;

    uint256 internal ownerPk;
    address internal owner;

    /// @dev The contract (upgrade-admin) owner — required by {initialize}; not otherwise exercised here.
    address internal admin = makeAddr("admin");

    /// @dev The ERC-6492 detection suffix (mirrors the contract constant) — used to wrap inner sigs.
    bytes32 internal constant ERC6492_MAGIC =
        0x6492649264926492649264926492649264926492649264926492649264926492;

    function setUp() public {
        // Deploy the implementation, then the ERC1967 proxy that initializes it, then drive the proxy.
        address impl = address(new SessionGrant());
        address proxy = deployProxy(
            impl, abi.encodeCall(SessionGrant.initialize, ("Access0x1 SessionGrant", "1", admin))
        );
        grant = SessionGrant(proxy);
        factory = new WalletFactory();
        (owner, ownerPk) = makeAddrAndKey("owner");
        // A stable, non-zero base time so warps/expiries are always in a sane range.
        vm.warp(1_700_000_000);
    }

    /*//////////////////////////////////////////////////////////////
                              HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Sign an EIP-712 grant with `pk` for the given fields at `nonce` and pack it r,s,v.
    function _signGrant(
        uint256 pk,
        address owner_,
        address delegate_,
        uint256 budget,
        uint64 exp,
        uint256 nonce
    ) internal view returns (bytes memory) {
        bytes32 digest = grant.grantDigest(owner_, delegate_, budget, exp, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /*//////////////////////////////////////////////////////////////
                       FUZZ: openSession (DIRECT)
    //////////////////////////////////////////////////////////////*/

    /// @notice Fuzz the owner-as-caller open path across the whole legal input space.
    /// @dev    PROVES: for any non-zero delegate, non-zero budget, and future expiry, the open succeeds,
    ///         writes EXACTLY the supplied fields, the id matches the deterministic derivation, the nonce
    ///         advances by exactly one, and remaining() == budgetCap (full budget, nothing spent).
    function testFuzz_openSession_writesExactSession(
        address ownerFuzz,
        address delegate,
        uint256 budgetCap,
        uint64 expiry
    ) public {
        // Constrain to the legal domain: distinct non-zero actors, non-zero budget, strictly future expiry.
        vm.assume(ownerFuzz != address(0) && delegate != address(0));
        budgetCap = bound(budgetCap, 1, type(uint256).max);
        expiry = uint64(bound(expiry, block.timestamp + 1, type(uint64).max));

        uint256 nonceBefore = grant.nonces(ownerFuzz);
        bytes32 expectedId = grant.computeSessionId(ownerFuzz, delegate, nonceBefore);

        vm.prank(ownerFuzz);
        bytes32 id = grant.openSession(delegate, budgetCap, expiry);

        // Id derivation is faithful, and the session struct mirrors the inputs exactly.
        assertEq(id, expectedId, "id == keccak(owner,delegate,nonce)");
        ISessionGrant.Session memory s = grant.sessionOf(id);
        assertEq(s.delegate, delegate, "delegate stored");
        assertEq(s.budgetCap, budgetCap, "budgetCap stored");
        assertEq(s.expiry, expiry, "expiry stored");
        assertEq(s.spent, 0, "fresh session spent==0");
        assertFalse(s.revoked, "fresh session not revoked");

        // Budget invariants on a fresh session: remaining == cap, conservation holds, nonce +1.
        assertEq(grant.remaining(id), budgetCap, "remaining == cap on open");
        assertEq(s.spent + grant.remaining(id), s.budgetCap, "conservation: spent+remaining==cap");
        assertEq(grant.nonces(ownerFuzz), nonceBefore + 1, "exactly one nonce consumed");
    }

    /// @notice Fuzz the illegal-input reverts of the direct open path.
    /// @dev    PROVES: a zero budget OR a non-future expiry is ALWAYS rejected (no session is written and
    ///         the nonce never moves) — the open guards hold for every fuzzed bad input.
    function testFuzz_openSession_rejectsBadParams(uint256 budgetCap, uint64 expiry) public {
        address delegate = makeAddr("d");

        // Case A: zero budget (any expiry) → ZeroBudget, no state change.
        vm.prank(owner);
        vm.expectRevert(ISessionGrant.SessionGrant__ZeroBudget.selector);
        grant.openSession(delegate, 0, uint64(bound(expiry, block.timestamp + 1, type(uint64).max)));

        // Case B: non-future expiry with a valid budget → ExpiryInPast, no state change.
        uint64 pastExpiry = uint64(bound(expiry, 0, block.timestamp));
        budgetCap = bound(budgetCap, 1, type(uint256).max);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISessionGrant.SessionGrant__ExpiryInPast.selector, pastExpiry, block.timestamp
            )
        );
        grant.openSession(delegate, budgetCap, pastExpiry);

        // Neither failed call moved the nonce.
        assertEq(grant.nonces(owner), 0, "no nonce consumed on a rejected open");
    }

    /*//////////////////////////////////////////////////////////////
                       FUZZ: openSessionFor (RELAYED)
    //////////////////////////////////////////////////////////////*/

    /// @notice Fuzz the relayed (signed-grant) open path with a real EOA signature.
    /// @dev    PROVES: for any future expiry / non-zero budget / non-zero delegate, a correctly signed
    ///         grant opens by ANY relayer, the session mirrors the signed fields, and exactly one nonce
    ///         is consumed — the digest binds every field so the relayer cannot alter the grant.
    function testFuzz_openSessionFor_eoaSig(
        address relayer,
        address delegate,
        uint256 budgetCap,
        uint64 expiry
    ) public {
        vm.assume(delegate != address(0));
        budgetCap = bound(budgetCap, 1, type(uint256).max);
        expiry = uint64(bound(expiry, block.timestamp + 1, type(uint64).max));

        bytes memory sig = _signGrant(ownerPk, owner, delegate, budgetCap, expiry, 0);

        vm.prank(relayer); // a permissionless, fuzzed relayer
        bytes32 id = grant.openSessionFor(owner, delegate, budgetCap, expiry, sig);

        assertEq(
            id, grant.computeSessionId(owner, delegate, 0), "id derives from owner+delegate+nonce"
        );
        assertEq(grant.remaining(id), budgetCap, "full budget live");
        assertEq(grant.nonces(owner), 1, "exactly one nonce consumed via relay");
    }

    /// @notice Fuzz tampering: a relayer that mutates ANY signed field is rejected.
    /// @dev    PROVES: changing the budget on a captured signature always fails validation (BadSignature)
    ///         and never opens a session — the EIP-712 digest pins every parameter.
    function testFuzz_openSessionFor_tamperedBudgetRejected(
        uint256 signedBudget,
        uint256 relayedBudget,
        uint64 expiry
    ) public {
        address delegate = makeAddr("d");
        signedBudget = bound(signedBudget, 1, type(uint256).max - 1);
        // The relayer submits a DIFFERENT budget than what was signed.
        relayedBudget = bound(relayedBudget, 1, type(uint256).max);
        vm.assume(relayedBudget != signedBudget);
        expiry = uint64(bound(expiry, block.timestamp + 1, type(uint64).max));

        bytes memory sig = _signGrant(ownerPk, owner, delegate, signedBudget, expiry, 0);

        vm.expectRevert(ISessionGrant.SessionGrant__BadSignature.selector);
        grant.openSessionFor(owner, delegate, relayedBudget, expiry, sig);
        assertEq(grant.nonces(owner), 0, "tampered grant consumes no nonce");
    }

    /// @notice Fuzz the wrong-signer path: a grant signed by anyone but `owner` is rejected.
    /// @dev    PROVES: for any fuzzed non-owner key, the recovered address != owner → BadSignature, so a
    ///         forged authorization never opens a session.
    function testFuzz_openSessionFor_wrongSignerRejected(uint256 wrongPk, uint64 expiry) public {
        // A valid secp256k1 key that is not the owner's.
        wrongPk = bound(wrongPk, 1, type(uint128).max);
        vm.assume(wrongPk != ownerPk);
        address delegate = makeAddr("d");
        expiry = uint64(bound(expiry, block.timestamp + 1, type(uint64).max));

        bytes memory sig = _signGrant(wrongPk, owner, delegate, 1_000e6, expiry, 0);

        vm.expectRevert(ISessionGrant.SessionGrant__BadSignature.selector);
        grant.openSessionFor(owner, delegate, 1_000e6, expiry, sig);
    }

    /*//////////////////////////////////////////////////////////////
                              FUZZ: spend
    //////////////////////////////////////////////////////////////*/

    /// @notice Fuzz a single spend across the legal + illegal amount space.
    /// @dev    PROVES the core money-shaped invariant of the ledger: a spend within budget decrements
    ///         exactly by `amount` (return == on-chain remaining), and a spend over budget reverts and
    ///         leaves spent untouched. In BOTH branches the ceiling (spent <= cap) and conservation
    ///         (spent + remaining == cap) hold — there is never a negative or unaccounted balance.
    function testFuzz_spend_respectsCeilingAndConserves(uint256 budgetCap, uint256 amount) public {
        budgetCap = bound(budgetCap, 1, 1e30);
        address delegate = makeAddr("delegate");
        uint64 expiry = uint64(block.timestamp + 1 days);

        vm.prank(owner);
        bytes32 id = grant.openSession(delegate, budgetCap, expiry);

        // Fuzz the requested amount across both sides of the cap (and include 0 to hit ZeroAmount).
        amount = bound(amount, 0, budgetCap + 1e18);

        vm.prank(delegate);
        if (amount == 0) {
            vm.expectRevert(ISessionGrant.SessionGrant__ZeroAmount.selector);
            grant.spend(id, amount);
        } else if (amount > budgetCap) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    ISessionGrant.SessionGrant__BudgetExceeded.selector, id, budgetCap, amount
                )
            );
            grant.spend(id, amount);
            // The rejected over-spend left the ledger pristine.
            assertEq(grant.sessionOf(id).spent, 0, "over-budget spend writes nothing");
        } else {
            uint256 ret = grant.spend(id, amount);
            ISessionGrant.Session memory s = grant.sessionOf(id);
            assertEq(s.spent, amount, "spent == amount");
            assertEq(ret, budgetCap - amount, "return == cap - amount");
            assertEq(ret, grant.remaining(id), "return matches on-chain remaining()");
        }

        // Invariants that MUST hold no matter which branch fired:
        ISessionGrant.Session memory fin = grant.sessionOf(id);
        assertLe(fin.spent, fin.budgetCap, "CEILING: spent <= cap");
        assertEq(
            fin.spent + grant.remaining(id), fin.budgetCap, "CONSERVATION: spent+remaining==cap"
        );
    }

    /// @notice Fuzz a SEQUENCE of two spends (still single-function per call) to prove cumulative ceiling.
    /// @dev    PROVES the salami property at the unit level: two arbitrary in-range spends can never sum
    ///         past the cap — the second is rejected exactly when a+b > cap, and `spent` only ever holds
    ///         a value <= cap.
    function testFuzz_spend_twoCallsNeverExceedCap(uint256 a, uint256 b) public {
        uint256 budgetCap = 1_000e6;
        address delegate = makeAddr("delegate");
        vm.prank(owner);
        bytes32 id = grant.openSession(delegate, budgetCap, uint64(block.timestamp + 1 days));

        a = bound(a, 1, budgetCap);
        b = bound(b, 1, budgetCap);

        vm.startPrank(delegate);
        grant.spend(id, a);
        if (a + b > budgetCap) {
            vm.expectRevert(); // BudgetExceeded — the cap is a hard ceiling across calls
            grant.spend(id, b);
            assertEq(grant.sessionOf(id).spent, a, "rejected 2nd spend leaves spent at a");
        } else {
            grant.spend(id, b);
            assertEq(grant.sessionOf(id).spent, a + b, "spent == a+b when within cap");
        }
        vm.stopPrank();
        assertLe(grant.sessionOf(id).spent, budgetCap, "spent never exceeds cap");
    }

    /// @notice Fuzz the not-delegate guard: any caller that is not the bound delegate cannot spend.
    /// @dev    PROVES: for every fuzzed caller != delegate, spend reverts NotDelegate and the budget is
    ///         never touched — authorization is strictly enforced on the hot path.
    function testFuzz_spend_onlyDelegate(address caller, uint256 amount) public {
        address delegate = makeAddr("delegate");
        vm.assume(caller != delegate);
        amount = bound(amount, 1, 1_000e6);

        vm.prank(owner);
        bytes32 id = grant.openSession(delegate, 1_000e6, uint64(block.timestamp + 1 days));

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(ISessionGrant.SessionGrant__NotDelegate.selector, id, caller)
        );
        grant.spend(id, amount);
        assertEq(grant.sessionOf(id).spent, 0, "unauthorized caller spends nothing");
    }

    /// @notice Fuzz the expiry boundary: spend is allowed up to AND INCLUDING expiry, dead after.
    /// @dev    PROVES: with `>` liveness, a spend at any time <= expiry succeeds and any time > expiry
    ///         reverts SessionExpired — no off-by-one grace window in either direction.
    function testFuzz_spend_expiryBoundary(uint64 expiry, uint256 warpTo) public {
        expiry = uint64(bound(expiry, block.timestamp + 1, type(uint64).max - 1));
        address delegate = makeAddr("delegate");
        vm.prank(owner);
        bytes32 id = grant.openSession(delegate, 1_000e6, expiry);

        warpTo = bound(warpTo, block.timestamp, type(uint64).max);
        vm.warp(warpTo);

        vm.prank(delegate);
        if (warpTo > expiry) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    ISessionGrant.SessionGrant__SessionExpired.selector, id, expiry, warpTo
                )
            );
            grant.spend(id, 1e6);
        } else {
            uint256 left = grant.spend(id, 1e6);
            assertEq(left, 1_000e6 - 1e6, "spend at/under expiry succeeds");
        }
    }

    /*//////////////////////////////////////////////////////////////
                              FUZZ: revoke
    //////////////////////////////////////////////////////////////*/

    /// @notice Fuzz the revoke authorization guard.
    /// @dev    PROVES: only the exact owner can revoke. A fuzzed non-owner caller is rejected NotOwner
    ///         and the session stays live; the owner always succeeds and the session becomes permanently
    ///         dead (remaining() collapses to 0 regardless of leftover budget).
    function testFuzz_revoke_onlyOwnerAndKills(address caller, uint256 budgetCap) public {
        budgetCap = bound(budgetCap, 1, type(uint256).max);
        address delegate = makeAddr("delegate");
        vm.prank(owner);
        bytes32 id = grant.openSession(delegate, budgetCap, uint64(block.timestamp + 1 days));

        if (caller != owner) {
            vm.prank(caller);
            vm.expectRevert(
                abi.encodeWithSelector(ISessionGrant.SessionGrant__NotOwner.selector, id, caller)
            );
            grant.revoke(id);
            assertFalse(grant.sessionOf(id).revoked, "non-owner cannot revoke");
            assertEq(grant.remaining(id), budgetCap, "session still live after a rejected revoke");
        }

        // The owner can always revoke, and a revoked session is permanently dead.
        vm.prank(owner);
        grant.revoke(id);
        assertTrue(grant.sessionOf(id).revoked, "owner revoked");
        assertEq(grant.remaining(id), 0, "revoked => remaining collapses to 0");
    }

    /*//////////////////////////////////////////////////////////////
                       FUZZ: pure / view helpers
    //////////////////////////////////////////////////////////////*/

    /// @notice Fuzz the deterministic session-id derivation.
    /// @dev    PROVES: computeSessionId is a faithful keccak256(abi.encode(owner,delegate,nonce)) and is
    ///         INJECTIVE over its three legs — distinct triples never collide (abi.encode, not packed).
    function testFuzz_computeSessionId_injective(
        address ownerA,
        address delegateA,
        uint256 nonceA,
        address ownerB,
        address delegateB,
        uint256 nonceB
    ) public view {
        bytes32 idA = grant.computeSessionId(ownerA, delegateA, nonceA);
        assertEq(idA, keccak256(abi.encode(ownerA, delegateA, nonceA)), "matches abi.encode keccak");

        bytes32 idB = grant.computeSessionId(ownerB, delegateB, nonceB);
        bool sameTriple = (ownerA == ownerB && delegateA == delegateB && nonceA == nonceB);
        if (sameTriple) {
            assertEq(idA, idB, "same triple => same id");
        } else {
            assertTrue(idA != idB, "distinct triples never collide");
        }
    }

    /// @notice Fuzz grantDigest determinism + domain binding.
    /// @dev    PROVES: grantDigest is a deterministic function of its fields (same args => same digest),
    ///         and an isValidSignatureNow check accepts a real EOA signature over that exact digest while
    ///         rejecting a digest over any altered nonce — the off-chain signer and the on-chain verifier
    ///         agree on the identical typed-data hash.
    function testFuzz_grantDigest_signableAndBound(uint256 budgetCap, uint64 expiry, uint256 nonce)
        public
    {
        address delegate = makeAddr("d");
        budgetCap = bound(budgetCap, 1, type(uint256).max);
        expiry = uint64(bound(expiry, 1, type(uint64).max));
        nonce = bound(nonce, 0, type(uint128).max);

        bytes32 digest = grant.grantDigest(owner, delegate, budgetCap, expiry, nonce);
        // Determinism: recomputing yields the identical digest.
        assertEq(
            digest,
            grant.grantDigest(owner, delegate, budgetCap, expiry, nonce),
            "digest deterministic"
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        assertTrue(grant.isValidSignatureNow(owner, digest, sig), "owner sig valid over its digest");

        // A digest over a DIFFERENT nonce is a different message the same sig cannot satisfy.
        bytes32 otherDigest = grant.grantDigest(owner, delegate, budgetCap, expiry, nonce + 1);
        assertFalse(
            grant.isValidSignatureNow(owner, otherDigest, sig),
            "sig invalid over a shifted-nonce digest"
        );
    }

    /// @notice Fuzz the zero-custody guarantee: SessionGrant must never accrue an ETH balance.
    /// @dev    PROVES the estate "zero residual custody" law for this auth primitive — across an opened
    ///         session and a spend of any in-range amount, the contract's ETH balance stays 0 (it is a
    ///         pure accounting ledger; the money path lives in a consuming router, never here).
    function testFuzz_zeroCustody(uint256 amount) public {
        amount = bound(amount, 1, 1_000e6);
        address delegate = makeAddr("delegate");
        vm.prank(owner);
        bytes32 id = grant.openSession(delegate, 1_000e6, uint64(block.timestamp + 1 days));
        vm.prank(delegate);
        grant.spend(id, amount);
        assertEq(address(grant).balance, 0, "SessionGrant custodies no ETH, ever");
    }
}
