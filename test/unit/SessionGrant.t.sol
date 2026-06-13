// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { SessionGrant } from "../../src/SessionGrant.sol";
import { ISessionGrant } from "../../src/interfaces/ISessionGrant.sol";
import { SmartWallet1271, WalletFactory } from "../mocks/SmartWallet1271.sol";

/// @notice The SessionGrant unit suite — the full open/spend/revoke lifecycle, the per-owner replay
///         nonce, and signature validation across EOA / ERC-1271 / ERC-6492. Every external function's
///         revert paths are exercised. Time-based liveness is driven with `vm.warp`.
contract SessionGrantTest is Test {
    SessionGrant internal grant;
    WalletFactory internal factory;

    uint256 internal ownerPk;
    address internal owner;
    address internal delegate = makeAddr("delegate");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant BUDGET = 1_000e6; // $1,000, 6-dp unit
    uint64 internal expiry;

    bytes32 internal constant ERC6492_MAGIC =
        0x6492649264926492649264926492649264926492649264926492649264926492;

    function setUp() public {
        grant = new SessionGrant("Access0x1 SessionGrant", "1");
        factory = new WalletFactory();
        (owner, ownerPk) = makeAddrAndKey("owner");
        expiry = uint64(block.timestamp + 1 days);
    }

    /*//////////////////////////////////////////////////////////////
                              OPEN (DIRECT)
    //////////////////////////////////////////////////////////////*/

    function test_openSession_success() public {
        bytes32 expectedId = grant.computeSessionId(owner, delegate, 0);

        vm.expectEmit(true, true, true, true, address(grant));
        emit ISessionGrant.SessionOpened(owner, expectedId, delegate, BUDGET, expiry, 0);

        vm.prank(owner);
        bytes32 id = grant.openSession(delegate, BUDGET, expiry);

        assertEq(id, expectedId);
        ISessionGrant.Session memory s = grant.sessionOf(id);
        assertEq(s.delegate, delegate);
        assertEq(s.budgetCap, BUDGET);
        assertEq(s.expiry, expiry);
        assertEq(s.spent, 0);
        assertFalse(s.revoked);
        assertEq(grant.remaining(id), BUDGET);
        assertEq(grant.nonces(owner), 1); // nonce consumed
    }

    function test_openSession_revertZeroDelegate() public {
        vm.prank(owner);
        vm.expectRevert(ISessionGrant.SessionGrant__ZeroAddress.selector);
        grant.openSession(address(0), BUDGET, expiry);
    }

    function test_openSession_revertZeroBudget() public {
        vm.prank(owner);
        vm.expectRevert(ISessionGrant.SessionGrant__ZeroBudget.selector);
        grant.openSession(delegate, 0, expiry);
    }

    function test_openSession_revertExpiryInPast() public {
        uint64 past = uint64(block.timestamp); // == now, not in the future
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISessionGrant.SessionGrant__ExpiryInPast.selector, past, block.timestamp
            )
        );
        grant.openSession(delegate, BUDGET, past);
    }

    function test_openSession_twoSessions_distinctIds() public {
        vm.startPrank(owner);
        bytes32 id0 = grant.openSession(delegate, BUDGET, expiry);
        bytes32 id1 = grant.openSession(delegate, BUDGET, expiry); // same delegate, nonce now 1
        vm.stopPrank();
        assertTrue(id0 != id1);
        assertEq(grant.nonces(owner), 2);
    }

    /*//////////////////////////////////////////////////////////////
                              OPEN (RELAYED)
    //////////////////////////////////////////////////////////////*/

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

    function test_openSessionFor_eoaSignature_success() public {
        bytes memory sig = _signGrant(ownerPk, owner, delegate, BUDGET, expiry, 0);

        vm.prank(relayer); // permissionless relayer
        bytes32 id = grant.openSessionFor(owner, delegate, BUDGET, expiry, sig);

        assertEq(id, grant.computeSessionId(owner, delegate, 0));
        assertEq(grant.remaining(id), BUDGET);
        assertEq(grant.nonces(owner), 1);
    }

    function test_openSessionFor_revertZeroOwner() public {
        vm.expectRevert(ISessionGrant.SessionGrant__ZeroAddress.selector);
        grant.openSessionFor(address(0), delegate, BUDGET, expiry, hex"00");
    }

    function test_openSessionFor_revertBadSignature_wrongSigner() public {
        (, uint256 strangerPk) = makeAddrAndKey("strangerSigner");
        // stranger signs a grant claiming to be `owner` → recovery != owner → BadSignature.
        bytes memory sig = _signGrant(strangerPk, owner, delegate, BUDGET, expiry, 0);
        vm.expectRevert(ISessionGrant.SessionGrant__BadSignature.selector);
        grant.openSessionFor(owner, delegate, BUDGET, expiry, sig);
    }

    function test_openSessionFor_revertBadSignature_tamperedField() public {
        bytes memory sig = _signGrant(ownerPk, owner, delegate, BUDGET, expiry, 0);
        // Relayer inflates the budget; the digest no longer matches the signature.
        vm.expectRevert(ISessionGrant.SessionGrant__BadSignature.selector);
        grant.openSessionFor(owner, delegate, BUDGET * 2, expiry, sig);
    }

    function test_openSessionFor_1271_deployedWallet_success() public {
        SmartWallet1271 wallet = new SmartWallet1271(owner); // signer = owner EOA
        address w = address(wallet);
        // The wallet signs by delegating to the owner EOA's key.
        bytes memory sig = _signGrant(ownerPk, w, delegate, BUDGET, expiry, 0);

        vm.prank(relayer);
        bytes32 id = grant.openSessionFor(w, delegate, BUDGET, expiry, sig);
        assertEq(grant.remaining(id), BUDGET);
    }

    function test_openSessionFor_6492_counterfactualWallet_success() public {
        // Predict the wallet address; sign against it BEFORE it has code.
        address w = factory.addressOf(owner);
        assertEq(w.code.length, 0); // not deployed yet

        bytes memory innerSig = _signGrant(ownerPk, w, delegate, BUDGET, expiry, 0);
        bytes memory wrapped = abi.encodePacked(
            abi.encode(address(factory), abi.encodeCall(WalletFactory.deploy, (owner)), innerSig),
            ERC6492_MAGIC
        );

        vm.prank(relayer);
        bytes32 id = grant.openSessionFor(w, delegate, BUDGET, expiry, wrapped);

        assertEq(grant.remaining(id), BUDGET);
        assertGt(w.code.length, 0); // the 6492 prepare deployed it
    }

    /*//////////////////////////////////////////////////////////////
                                 SPEND
    //////////////////////////////////////////////////////////////*/

    function _open() internal returns (bytes32 id) {
        vm.prank(owner);
        id = grant.openSession(delegate, BUDGET, expiry);
    }

    function test_spend_success_decrementsBudget() public {
        bytes32 id = _open();

        vm.expectEmit(true, true, false, true, address(grant));
        emit ISessionGrant.SessionSpent(id, delegate, 400e6, BUDGET - 400e6);
        vm.prank(delegate);
        uint256 left = grant.spend(id, 400e6);

        assertEq(left, BUDGET - 400e6);
        assertEq(grant.remaining(id), BUDGET - 400e6);
        assertEq(grant.sessionOf(id).spent, 400e6);
    }

    function test_spend_multiple_uptoExactBudget() public {
        bytes32 id = _open();
        vm.startPrank(delegate);
        grant.spend(id, 600e6);
        uint256 left = grant.spend(id, 400e6); // exactly exhausts
        vm.stopPrank();
        assertEq(left, 0);
        assertEq(grant.remaining(id), 0);
    }

    function test_spend_atExactExpiry_allowed() public {
        bytes32 id = _open();
        vm.warp(expiry); // exactly at expiry — still live (checked with >)
        vm.prank(delegate);
        uint256 left = grant.spend(id, 1e6);
        assertEq(left, BUDGET - 1e6);
    }

    function test_spend_revertZeroAmount() public {
        bytes32 id = _open();
        vm.prank(delegate);
        vm.expectRevert(ISessionGrant.SessionGrant__ZeroAmount.selector);
        grant.spend(id, 0);
    }

    function test_spend_revertUnknownSession() public {
        bytes32 ghost = keccak256("ghost");
        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(ISessionGrant.SessionGrant__SessionUnknown.selector, ghost)
        );
        grant.spend(ghost, 1e6);
    }

    function test_spend_revertNotDelegate() public {
        bytes32 id = _open();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(ISessionGrant.SessionGrant__NotDelegate.selector, id, stranger)
        );
        grant.spend(id, 1e6);
    }

    function test_spend_revertExpired() public {
        bytes32 id = _open();
        vm.warp(expiry + 1);
        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISessionGrant.SessionGrant__SessionExpired.selector, id, expiry, expiry + 1
            )
        );
        grant.spend(id, 1e6);
    }

    function test_spend_revertRevoked() public {
        bytes32 id = _open();
        vm.prank(owner);
        grant.revoke(id);
        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(ISessionGrant.SessionGrant__SessionRevoked.selector, id)
        );
        grant.spend(id, 1e6);
    }

    function test_spend_revertBudgetExceeded() public {
        bytes32 id = _open();
        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISessionGrant.SessionGrant__BudgetExceeded.selector, id, BUDGET, BUDGET + 1
            )
        );
        grant.spend(id, BUDGET + 1);
    }

    /*//////////////////////////////////////////////////////////////
                                 REVOKE
    //////////////////////////////////////////////////////////////*/

    function test_revoke_success() public {
        bytes32 id = _open();
        vm.expectEmit(true, true, false, false, address(grant));
        emit ISessionGrant.SessionRevoked(id, owner);
        vm.prank(owner);
        grant.revoke(id);

        assertTrue(grant.sessionOf(id).revoked);
        assertEq(grant.remaining(id), 0);
    }

    function test_revoke_revertUnknown() public {
        bytes32 ghost = keccak256("ghost");
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ISessionGrant.SessionGrant__SessionUnknown.selector, ghost)
        );
        grant.revoke(ghost);
    }

    function test_revoke_revertNotOwner() public {
        bytes32 id = _open();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(ISessionGrant.SessionGrant__NotOwner.selector, id, stranger)
        );
        grant.revoke(id);
    }

    function test_revoke_revertAlreadyRevoked() public {
        bytes32 id = _open();
        vm.startPrank(owner);
        grant.revoke(id);
        vm.expectRevert(
            abi.encodeWithSelector(ISessionGrant.SessionGrant__SessionRevoked.selector, id)
        );
        grant.revoke(id);
        vm.stopPrank();
    }

    function test_revoke_byRelayedOwner() public {
        // A session opened via openSessionFor is owned by the SIGNER, who can revoke it.
        bytes memory sig = _signGrant(ownerPk, owner, delegate, BUDGET, expiry, 0);
        vm.prank(relayer);
        bytes32 id = grant.openSessionFor(owner, delegate, BUDGET, expiry, sig);

        vm.prank(owner);
        grant.revoke(id);
        assertTrue(grant.sessionOf(id).revoked);
    }

    /*//////////////////////////////////////////////////////////////
                            VIEWS / EDGE
    //////////////////////////////////////////////////////////////*/

    function test_remaining_unknownSession_zero() public view {
        assertEq(grant.remaining(keccak256("nope")), 0);
    }

    function test_isValidSignatureNow_eoa() public {
        bytes32 digest = grant.grantDigest(owner, delegate, BUDGET, expiry, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        assertTrue(grant.isValidSignatureNow(owner, digest, abi.encodePacked(r, s, v)));
    }

    function test_isValidSignatureNow_eoa_garbageRejected() public {
        bytes32 digest = grant.grantDigest(owner, delegate, BUDGET, expiry, 0);
        assertFalse(grant.isValidSignatureNow(owner, digest, hex"deadbeef"));
    }

    function testFuzz_spend_neverExceedsBudget(uint256 a, uint256 b) public {
        a = bound(a, 1, BUDGET);
        b = bound(b, 1, BUDGET);
        bytes32 id = _open();
        vm.startPrank(delegate);
        grant.spend(id, a);
        if (a + b > BUDGET) {
            vm.expectRevert();
            grant.spend(id, b);
        } else {
            grant.spend(id, b);
            assertEq(grant.sessionOf(id).spent, a + b);
        }
        vm.stopPrank();
        assertLe(grant.sessionOf(id).spent, BUDGET);
    }
}
