// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { SessionGrant } from "../../src/SessionGrant.sol";
import { ISessionGrant } from "../../src/interfaces/ISessionGrant.sol";
import { SmartWallet1271, WalletFactory } from "../mocks/SmartWallet1271.sol";
import { ReentrantSessionFactory } from "../mocks/ReentrantSessionFactory.sol";

/// @notice Adversarial suite for SessionGrant. Each test is an ATTACK the contract must defeat:
///         budget overspend (incl. salami / round-trip), expiry bypass, signed-grant replay, session-id
///         collision, delegate/owner confusion, and ERC-6492 signature forgery. A passing test means
///         the attack is REJECTED (a revert or a no-op), never that it succeeds.
contract SessionGrantAttackTest is Test {
    SessionGrant internal grant;
    WalletFactory internal factory;

    uint256 internal ownerPk;
    address internal owner;
    uint256 internal attackerPk;
    address internal attacker;
    address internal delegate = makeAddr("delegate");

    uint256 internal constant BUDGET = 1_000e6;
    uint64 internal expiry;

    bytes32 internal constant ERC6492_MAGIC =
        0x6492649264926492649264926492649264926492649264926492649264926492;

    function setUp() public {
        grant = new SessionGrant("Access0x1 SessionGrant", "1");
        factory = new WalletFactory();
        (owner, ownerPk) = makeAddrAndKey("owner");
        (attacker, attackerPk) = makeAddrAndKey("attacker");
        expiry = uint64(block.timestamp + 1 days);
    }

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

    function _open(uint256 budget) internal returns (bytes32 id) {
        vm.prank(owner);
        id = grant.openSession(delegate, budget, expiry);
    }

    /*//////////////////////////////////////////////////////////////
                          ATTACK: BUDGET OVERSPEND
    //////////////////////////////////////////////////////////////*/

    /// @dev A single spend over the cap must revert — budget is a hard ceiling.
    function test_attack_overspend_singleCall() public {
        bytes32 id = _open(BUDGET);
        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISessionGrant.SessionGrant__BudgetExceeded.selector, id, BUDGET, BUDGET + 1
            )
        );
        grant.spend(id, BUDGET + 1);
    }

    /// @dev Salami attack: many small spends must never sum past the cap. The spend that would tip
    ///      over the cap reverts and leaves `spent` untouched.
    function test_attack_overspend_salami() public {
        bytes32 id = _open(BUDGET);
        vm.startPrank(delegate);
        for (uint256 i = 0; i < 10; i++) {
            grant.spend(id, 100e6); // 10 * 100 == 1000 == BUDGET, exactly
        }
        // The 11th unit must be rejected; spent stays pinned at the cap.
        vm.expectRevert(
            abi.encodeWithSelector(ISessionGrant.SessionGrant__BudgetExceeded.selector, id, 0, 1)
        );
        grant.spend(id, 1);
        vm.stopPrank();
        assertEq(grant.sessionOf(id).spent, BUDGET);
    }

    /// @dev A revoked-then-spent session cannot resurrect remaining budget.
    function test_attack_spendAfterRevoke() public {
        bytes32 id = _open(BUDGET);
        vm.prank(owner);
        grant.revoke(id);
        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(ISessionGrant.SessionGrant__SessionRevoked.selector, id)
        );
        grant.spend(id, 1);
    }

    /*//////////////////////////////////////////////////////////////
                          ATTACK: EXPIRY BYPASS
    //////////////////////////////////////////////////////////////*/

    /// @dev One second past expiry, no spend is allowed — there is no grace window.
    function test_attack_expiryBypass_oneSecondLate() public {
        bytes32 id = _open(BUDGET);
        vm.warp(expiry + 1);
        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISessionGrant.SessionGrant__SessionExpired.selector, id, expiry, expiry + 1
            )
        );
        grant.spend(id, 1);
    }

    /// @dev An expired session with budget still on it stays dead far into the future.
    function test_attack_expiryBypass_farFuture() public {
        bytes32 id = _open(BUDGET);
        vm.warp(expiry + 365 days);
        vm.prank(delegate);
        vm.expectRevert(); // SessionExpired
        grant.spend(id, 1);
        assertEq(grant.remaining(id), 0);
    }

    /*//////////////////////////////////////////////////////////////
                          ATTACK: GRANT REPLAY
    //////////////////////////////////////////////////////////////*/

    /// @dev Replaying the SAME signed grant a second time must fail: the nonce advanced on the first
    ///      open, so the second submission validates the signature against the NEW nonce (mismatch →
    ///      BadSignature). The captured signature is single-use.
    function test_attack_replay_sameGrantTwice() public {
        bytes memory sig = _signGrant(ownerPk, owner, delegate, BUDGET, expiry, 0);
        grant.openSessionFor(owner, delegate, BUDGET, expiry, sig);

        // Second submission: nonce is now 1, signature was over nonce 0 → fails validation.
        vm.expectRevert(ISessionGrant.SessionGrant__BadSignature.selector);
        grant.openSessionFor(owner, delegate, BUDGET, expiry, sig);
    }

    /// @dev A grant signed for THIS contract's domain cannot be replayed against a fresh deployment
    ///      with a different domain separator (EIP-712 domain binding).
    function test_attack_replay_crossDomain() public {
        bytes memory sig = _signGrant(ownerPk, owner, delegate, BUDGET, expiry, 0);
        SessionGrant other = new SessionGrant("Access0x1 SessionGrant", "1"); // diff address → diff domain
        vm.expectRevert(ISessionGrant.SessionGrant__BadSignature.selector);
        other.openSessionFor(owner, delegate, BUDGET, expiry, sig);
    }

    /*//////////////////////////////////////////////////////////////
                       ATTACK: AUTHORIZATION CONFUSION
    //////////////////////////////////////////////////////////////*/

    /// @dev The attacker cannot spend a session whose delegate is someone else, even knowing the id.
    function test_attack_delegateImpersonation() public {
        bytes32 id = _open(BUDGET);
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(ISessionGrant.SessionGrant__NotDelegate.selector, id, attacker)
        );
        grant.spend(id, 1);
    }

    /// @dev The attacker cannot revoke (grief) a session they do not own.
    function test_attack_revokeByNonOwner() public {
        bytes32 id = _open(BUDGET);
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(ISessionGrant.SessionGrant__NotOwner.selector, id, attacker)
        );
        grant.revoke(id);
    }

    /// @dev The delegate is NOT the owner: a delegate cannot revoke its own session to escape a future
    ///      owner revoke, nor can it open sessions for the owner.
    function test_attack_delegateCannotRevoke() public {
        bytes32 id = _open(BUDGET);
        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(ISessionGrant.SessionGrant__NotOwner.selector, id, delegate)
        );
        grant.revoke(id);
    }

    /*//////////////////////////////////////////////////////////////
                         ATTACK: ERC-6492 FORGERY
    //////////////////////////////////////////////////////////////*/

    /// @dev A 6492 wrapper whose INNER signature is from the attacker (not the counterfactual wallet's
    ///      configured signer) must fail even though the factory call succeeds and deploys a wallet.
    ///      The forged inner sig recovers to the wrong key → ERC-1271 rejects → BadSignature.
    function test_attack_6492_forgedInnerSig() public {
        address w = factory.addressOf(owner); // wallet's signer == owner
        // Attacker signs the grant instead of the owner.
        bytes memory forgedInner = _signGrant(attackerPk, w, delegate, BUDGET, expiry, 0);
        bytes memory wrapped = abi.encodePacked(
            abi.encode(
                address(factory), abi.encodeCall(WalletFactory.deploy, (owner)), forgedInner
            ),
            ERC6492_MAGIC
        );
        vm.expectRevert(ISessionGrant.SessionGrant__BadSignature.selector);
        grant.openSessionFor(w, delegate, BUDGET, expiry, wrapped);
    }

    /// @dev A 6492 wrapper that deploys a wallet whose signer is the ATTACKER (factory called with the
    ///      attacker's key) cannot satisfy a grant claimed for `w` — because `w` is the counterfactual
    ///      address derived from the OWNER's key, so the attacker-keyed deploy lands at a DIFFERENT
    ///      address and `w` still has no/foreign code → validation fails.
    function test_attack_6492_factoryDeploysWrongSigner() public {
        address w = factory.addressOf(owner); // address bound to owner's key
        bytes memory inner = _signGrant(attackerPk, w, delegate, BUDGET, expiry, 0);
        // Factory call deploys a wallet for the ATTACKER, at a different CREATE2 address than `w`.
        bytes memory wrapped = abi.encodePacked(
            abi.encode(address(factory), abi.encodeCall(WalletFactory.deploy, (attacker)), inner),
            ERC6492_MAGIC
        );
        vm.expectRevert(ISessionGrant.SessionGrant__BadSignature.selector);
        grant.openSessionFor(w, delegate, BUDGET, expiry, wrapped);
        assertEq(w.code.length, 0); // `w` itself was never deployed
    }

    /// @dev A 6492 wrapper pointing at a factory that reverts must surface as BadSignature, not bubble
    ///      the factory revert (best-effort prepare). With no code at `w`, ERC-1271 cannot pass.
    function test_attack_6492_revertingFactory() public {
        address w = factory.addressOf(owner);
        bytes memory inner = _signGrant(ownerPk, w, delegate, BUDGET, expiry, 0);
        // Point the factory call at a selector that does not exist → the call reverts internally.
        bytes memory wrapped = abi.encodePacked(
            abi.encode(address(factory), abi.encodeWithSignature("nope()"), inner), ERC6492_MAGIC
        );
        vm.expectRevert(ISessionGrant.SessionGrant__BadSignature.selector);
        grant.openSessionFor(w, delegate, BUDGET, expiry, wrapped);
    }

    /// @dev The magic suffix alone, with garbage in the wrapper body, must not panic the decoder into
    ///      a successful open — it decodes to junk, the inner sig is invalid, and it reverts cleanly.
    function test_attack_6492_garbageBodyWithMagic() public {
        // 96 bytes of zero (decodes to factory=0, empty bytes, empty bytes) + magic.
        bytes memory wrapped =
            abi.encodePacked(abi.encode(address(0), bytes(""), bytes("")), ERC6492_MAGIC);
        vm.expectRevert(ISessionGrant.SessionGrant__BadSignature.selector);
        grant.openSessionFor(owner, delegate, BUDGET, expiry, wrapped);
    }

    /// @dev L-3 regression: a body that carries the magic suffix but is NOT a valid
    ///      `(address,bytes,bytes)` encoding must yield `false` from the reusable boolean validator
    ///      {isValidSignatureNow} — never a propagating `abi.decode` Panic. (The
    ///      {test_attack_6492_garbageBodyWithMagic} sibling only feeds a WELL-FORMED tuple that decodes
    ///      successfully, so the malformed-decode path was untested before this.) Two shapes both
    ///      trigger the raw-decode Panic: a too-short body, and a tuple with out-of-bounds dynamic
    ///      offsets. Both must now return `false`, and {openSessionFor} over them reverts with the
    ///      clean {BadSignature}, not a bubbled Panic.
    function test_attack_6492_malformedBody_returnsFalse_noRevert() public {
        bytes32 digest = grant.grantDigest(owner, delegate, BUDGET, expiry, 0);

        // Shape 1: a 4-byte body (cannot hold even the first head word) + magic.
        bytes memory shortBody = abi.encodePacked(bytes4(0xdeadbeef), ERC6492_MAGIC);
        assertFalse(
            grant.isValidSignatureNow(owner, digest, shortBody),
            "malformed (short) 6492 body must validate false, not panic"
        );

        // Shape 2: a well-sized body whose dynamic offsets point out of bounds + magic. Three head
        // words: an address leg then two dynamic-`bytes` offsets that point far past the body end.
        bytes memory oobBody = abi.encodePacked(
            bytes32(uint256(uint160(address(factory)))), // factory leg
            bytes32(type(uint256).max), // factoryCalldata offset → out of bounds
            bytes32(type(uint256).max), // innerSig offset → out of bounds
            ERC6492_MAGIC
        );
        assertFalse(
            grant.isValidSignatureNow(owner, digest, oobBody),
            "malformed (out-of-bounds offset) 6492 body must validate false, not panic"
        );

        // And the open relay over a malformed wrapper fails CLOSED with BadSignature (no Panic).
        vm.expectRevert(ISessionGrant.SessionGrant__BadSignature.selector);
        grant.openSessionFor(owner, delegate, BUDGET, expiry, shortBody);
    }

    /// @dev A 6492 wrapper that names a factory whose `factoryCalldata` is EMPTY must not let an
    ///      attacker-keyed inner sig pass: with no code at the counterfactual address and no factory
    ///      prepare, validation falls to EOA recovery of the inner sig, which recovers the attacker —
    ///      not `signer` — so it is rejected. (Covers the 6492 path with `factory != 0` but no deploy.)
    function test_attack_6492_emptyFactoryCalldata_forgedInner() public {
        address w = factory.addressOf(owner);
        bytes memory forgedInner = _signGrant(attackerPk, w, delegate, BUDGET, expiry, 0);
        bytes memory wrapped =
            abi.encodePacked(abi.encode(address(factory), bytes(""), forgedInner), ERC6492_MAGIC);
        vm.expectRevert(ISessionGrant.SessionGrant__BadSignature.selector);
        grant.openSessionFor(w, delegate, BUDGET, expiry, wrapped);
    }

    /*//////////////////////////////////////////////////////////////
                  ATTACK: REENTRANCY VIA 6492 PREPARE (slither
                  reentrancy-no-eth on openSessionFor)
    //////////////////////////////////////////////////////////////*/

    /// @dev THE reentrancy probe (slither `reentrancy-no-eth` on openSessionFor). The ONLY external
    ///      call in SessionGrant is the ERC-6492 `factory.call`, fired BEFORE the owner nonce is
    ///      written. A malicious "factory" re-enters {openSessionFor} with the SAME captured grant,
    ///      trying to open a SECOND session off one authorization.
    ///
    ///      Before the fix, the re-entrant inner open bumped the nonce 0→1, then the outer {_open}
    ///      RE-READ the now-advanced nonce and opened a SECOND session at nonce 1 — applying one
    ///      signature at a nonce it never signed for (a double-open). The fix pins {_open} to the
    ///      nonce the signature was VALIDATED against and reverts {NonceMismatch} when the live nonce
    ///      has moved: the outer open reverts, which rolls back the WHOLE transaction (including the
    ///      inner open), so the malicious grant opens ZERO sessions and the nonce never advances.
    function test_attack_reentrancy_6492_cannotDoubleOpen() public {
        // `owner` is an EOA, so the 6492 prepare path fires the factory call, then EOA recovery
        // validates the inner sig against `owner` directly.
        ReentrantSessionFactory evil = new ReentrantSessionFactory(grant);

        // The PLAIN signature for (owner, delegate, BUDGET, expiry, nonce 0).
        bytes memory plainSig = _signGrant(ownerPk, owner, delegate, BUDGET, expiry, 0);
        // Arm the factory to replay that exact plain sig during the prepare step.
        evil.arm(owner, delegate, BUDGET, expiry, plainSig);

        // Wrap the SAME plain sig in a 6492 envelope that calls the evil factory.
        bytes memory wrapped = abi.encodePacked(
            abi.encode(
                address(evil), abi.encodeCall(ReentrantSessionFactory.deploy, (owner)), plainSig
            ),
            ERC6492_MAGIC
        );

        // The outer open must REVERT (NonceMismatch surfaced by the re-entrant nonce advance),
        // rolling back everything — no session, no nonce movement.
        vm.expectRevert(
            abi.encodeWithSelector(ISessionGrant.SessionGrant__NonceMismatch.selector, owner, 0, 1)
        );
        grant.openSessionFor(owner, delegate, BUDGET, expiry, wrapped);

        // Whole tx reverted → zero sessions, nonce untouched.
        assertEq(grant.nonces(owner), 0, "no nonce may be consumed when the open reverts");
    }

    /// @dev Positive control: a HONEST 6492 grant whose factory does NOT re-enter opens exactly one
    ///      session and advances the nonce by exactly one — the fix does not break the legitimate path.
    function test_reentrancy_honest6492_opensExactlyOne() public {
        address w = factory.addressOf(owner);
        bytes memory innerSig = _signGrant(ownerPk, w, delegate, BUDGET, expiry, 0);
        bytes memory wrapped = abi.encodePacked(
            abi.encode(address(factory), abi.encodeCall(WalletFactory.deploy, (owner)), innerSig),
            ERC6492_MAGIC
        );
        bytes32 id = grant.openSessionFor(w, delegate, BUDGET, expiry, wrapped);
        assertEq(grant.remaining(id), BUDGET);
        assertEq(grant.nonces(w), 1, "exactly one nonce consumed on the honest path");
    }

    /*//////////////////////////////////////////////////////////////
                          VIEW / DOMAIN BINDING
    //////////////////////////////////////////////////////////////*/

    /// @dev The exposed EIP-712 domain separator is real and unique per deployment, so a relayer/signer
    ///      cannot be tricked into reusing a digest across two SessionGrant instances (domain binding).
    function test_domainSeparator_isUniquePerDeployment() public {
        bytes32 ds = grant.domainSeparator();
        assertTrue(ds != bytes32(0));
        SessionGrant other = new SessionGrant("Access0x1 SessionGrant", "1"); // diff address
        assertTrue(
            other.domainSeparator() != ds, "domain separators must differ across deployments"
        );
    }
}
