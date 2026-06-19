// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";
import { IPaymentLanes } from "../../src/interfaces/IPaymentLanes.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { ReentrantClaimToken } from "../mocks/ReentrantClaimToken.sol";
import { ReentrantCreditToken } from "../mocks/ReentrantCreditToken.sol";

/// @notice The PaymentLanes unit suite — the full ERC-6909 receipt surface plus the credit/claim
///         extensions and the router integration, with adversarial reentrancy mocks. A second
///         6-decimal token (`eurc`) stands in for "any coin" so cross-asset isolation is exercised.
contract PaymentLanesTest is Test {
    PaymentLanes internal lanes;
    MockUSDC internal usdc;
    MockUSDC internal eurc; // a second asset (also 6dp) — different lane id than usdc

    address internal admin = makeAddr("admin");
    address internal router = makeAddr("router"); // an authorized-router EOA stand-in
    address internal merchantA = makeAddr("merchantA");
    address internal merchantB = makeAddr("merchantB");
    address internal bob = makeAddr("bob");

    uint256 internal constant NET = 1_000e6; // $1,000 of a 6-dp asset

    function setUp() public {
        lanes = new PaymentLanes(admin);
        usdc = new MockUSDC();
        eurc = new MockUSDC();

        vm.prank(admin);
        lanes.setRouter(router, true);

        // The router stand-in needs balance + approval to back its credits.
        usdc.mint(router, 1_000_000e6);
        eurc.mint(router, 1_000_000e6);
        vm.startPrank(router);
        usdc.approve(address(lanes), type(uint256).max);
        eurc.approve(address(lanes), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev Credit `amount` of `asset` to `recipient` as the authorized router.
    function _credit(address recipient, address asset, uint256 amount) internal returns (uint256) {
        vm.prank(router);
        return lanes.credit(recipient, asset, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                 CREDIT
    //////////////////////////////////////////////////////////////*/

    function test_credit_success() public {
        uint256 expectedId = lanes.laneId(block.chainid, address(usdc), merchantA);
        assertEq(
            expectedId, uint256(keccak256(abi.encode(block.chainid, address(usdc), merchantA)))
        );

        vm.expectEmit(true, true, true, true, address(lanes));
        emit IPaymentLanes.Transfer(router, address(0), merchantA, expectedId, NET);
        uint256 id = _credit(merchantA, address(usdc), NET);

        assertEq(id, expectedId);
        assertEq(lanes.balanceOf(merchantA, id), NET);
        assertEq(usdc.balanceOf(address(lanes)), NET); // lane is fully backed
    }

    function test_credit_revertsOnZeroRecipient() public {
        vm.prank(router);
        vm.expectRevert(IPaymentLanes.PaymentLanes__ZeroAddress.selector);
        lanes.credit(address(0), address(usdc), NET);
    }

    function test_credit_revertsOnZeroAsset() public {
        vm.prank(router);
        vm.expectRevert(IPaymentLanes.PaymentLanes__ZeroAddress.selector);
        lanes.credit(merchantA, address(0), NET);
    }

    function test_credit_revertsOnZeroAmount() public {
        vm.prank(router);
        vm.expectRevert(IPaymentLanes.PaymentLanes__ZeroAmount.selector);
        lanes.credit(merchantA, address(usdc), 0);
    }

    function test_credit_revertsOnUnauthorized() public {
        vm.prank(bob);
        vm.expectRevert(IPaymentLanes.PaymentLanes__Unauthorized.selector);
        lanes.credit(merchantA, address(usdc), NET);
    }

    function test_credit_multipleAssetsSameRecipient() public {
        uint256 idUsdc = _credit(merchantA, address(usdc), NET);
        uint256 idEurc = _credit(merchantA, address(eurc), 500e6);

        assertTrue(idUsdc != idEurc); // different asset ⇒ different lane
        assertEq(lanes.balanceOf(merchantA, idUsdc), NET);
        assertEq(lanes.balanceOf(merchantA, idEurc), 500e6);
    }

    function test_credit_multipleRecipientsSameAsset() public {
        uint256 idA = _credit(merchantA, address(usdc), NET);
        uint256 idB = lanes.laneId(block.chainid, address(usdc), merchantB);

        assertTrue(idA != idB); // different recipient ⇒ different lane
        assertEq(lanes.balanceOf(merchantA, idA), NET);
        assertEq(lanes.balanceOf(merchantB, idB), 0); // crediting A left B untouched

        _credit(merchantB, address(usdc), 250e6);
        assertEq(lanes.balanceOf(merchantA, idA), NET); // still untouched
        assertEq(lanes.balanceOf(merchantB, idB), 250e6);
    }

    /*//////////////////////////////////////////////////////////////
                                  CLAIM
    //////////////////////////////////////////////////////////////*/

    function test_claim_success() public {
        uint256 id = _credit(merchantA, address(usdc), NET);
        assertEq(usdc.balanceOf(address(lanes)), NET); // held by PaymentLanes pre-claim

        vm.expectEmit(true, true, true, true, address(lanes));
        emit IPaymentLanes.Transfer(merchantA, merchantA, address(0), id, NET);
        vm.prank(merchantA);
        lanes.claim(address(usdc));

        assertEq(lanes.balanceOf(merchantA, id), 0); // receipt burned
        assertEq(usdc.balanceOf(merchantA), NET); // underlying delivered
        assertEq(usdc.balanceOf(address(lanes)), 0); // nothing left held
    }

    function test_claim_revertsOnNothing() public {
        vm.prank(merchantA);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__NothingToClaim.selector, merchantA, address(usdc)
            )
        );
        lanes.claim(address(usdc));
    }

    function test_claim_revertsOnZeroAsset() public {
        vm.prank(merchantA);
        vm.expectRevert(IPaymentLanes.PaymentLanes__ZeroAddress.selector);
        lanes.claim(address(0));
    }

    function test_claim_partialViaTransfer() public {
        uint256 id = _credit(merchantA, address(usdc), NET);

        // A moves half to bob; both claim their share; total claimed == total credited. Bob received
        // A's lane id, so bob pulls it with `claimLane`; A pulls the remainder via the `claim` shorthand
        // (A's own lane == `id`).
        vm.prank(merchantA);
        lanes.transfer(bob, id, NET / 2);

        vm.prank(bob);
        lanes.claimLane(id, address(usdc));
        vm.prank(merchantA);
        lanes.claim(address(usdc));

        assertEq(usdc.balanceOf(bob), NET / 2);
        assertEq(usdc.balanceOf(merchantA), NET / 2);
        assertEq(usdc.balanceOf(bob) + usdc.balanceOf(merchantA), NET);
        assertEq(usdc.balanceOf(address(lanes)), 0);
    }

    /*//////////////////////////////////////////////////////////////
                                TRANSFER
    //////////////////////////////////////////////////////////////*/

    function test_transfer_success() public {
        uint256 id = _credit(merchantA, address(usdc), NET);

        vm.expectEmit(true, true, true, true, address(lanes));
        emit IPaymentLanes.Transfer(merchantA, merchantA, bob, id, 400e6);
        vm.prank(merchantA);
        bool ok = lanes.transfer(bob, id, 400e6);

        assertTrue(ok);
        assertEq(lanes.balanceOf(merchantA, id), NET - 400e6);
        assertEq(lanes.balanceOf(bob, id), 400e6);
    }

    function test_transfer_revertsOnInsufficient() public {
        uint256 id = _credit(merchantA, address(usdc), NET);
        vm.prank(merchantA);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__InsufficientBalance.selector,
                merchantA,
                id,
                NET,
                NET + 1
            )
        );
        lanes.transfer(bob, id, NET + 1);
    }

    function test_transfer_revertsOnZeroTo() public {
        uint256 id = _credit(merchantA, address(usdc), NET);
        vm.prank(merchantA);
        vm.expectRevert(IPaymentLanes.PaymentLanes__ZeroAddress.selector);
        lanes.transfer(address(0), id, 1);
    }

    /*//////////////////////////////////////////////////////////////
                              TRANSFER FROM
    //////////////////////////////////////////////////////////////*/

    function test_transferFrom_withAllowance() public {
        uint256 id = _credit(merchantA, address(usdc), NET);

        vm.prank(merchantA);
        lanes.approve(bob, id, 300e6);

        vm.prank(bob);
        bool ok = lanes.transferFrom(merchantA, bob, id, 300e6);

        assertTrue(ok);
        assertEq(lanes.balanceOf(merchantA, id), NET - 300e6);
        assertEq(lanes.balanceOf(bob, id), 300e6);
        assertEq(lanes.allowance(merchantA, bob, id), 0); // decremented by the amount
    }

    function test_transferFrom_withOperator() public {
        uint256 id = _credit(merchantA, address(usdc), NET);

        vm.prank(merchantA);
        lanes.setOperator(bob, true);

        // Operator can move any amount with NO per-id allowance set.
        vm.prank(bob);
        bool ok = lanes.transferFrom(merchantA, bob, id, NET);

        assertTrue(ok);
        assertEq(lanes.balanceOf(merchantA, id), 0);
        assertEq(lanes.balanceOf(bob, id), NET);
    }

    function test_transferFrom_revertsOnInsufficientAllowance() public {
        uint256 id = _credit(merchantA, address(usdc), NET);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__InsufficientAllowance.selector, merchantA, bob, id, 0, 1
            )
        );
        lanes.transferFrom(merchantA, bob, id, 1);
    }

    function test_transferFrom_operatorOverridesAllowanceMapping() public {
        uint256 id = _credit(merchantA, address(usdc), NET);

        // Even with a tiny per-id allowance, operator status lets bob move the whole balance and
        // the allowance is NOT consumed (operator path bypasses the allowance entirely).
        vm.startPrank(merchantA);
        lanes.approve(bob, id, 1);
        lanes.setOperator(bob, true);
        vm.stopPrank();

        vm.prank(bob);
        lanes.transferFrom(merchantA, bob, id, NET);

        assertEq(lanes.balanceOf(bob, id), NET);
        assertEq(lanes.allowance(merchantA, bob, id), 1); // untouched
    }

    function test_transferFrom_infiniteAllowanceNotDecremented() public {
        uint256 id = _credit(merchantA, address(usdc), NET);
        vm.prank(merchantA);
        lanes.approve(bob, id, type(uint256).max);

        vm.prank(bob);
        lanes.transferFrom(merchantA, bob, id, NET);

        assertEq(lanes.allowance(merchantA, bob, id), type(uint256).max); // max is sticky
    }

    /*//////////////////////////////////////////////////////////////
                           APPROVE / OPERATOR
    //////////////////////////////////////////////////////////////*/

    function test_approve_setsAllowance() public {
        uint256 id = lanes.laneId(block.chainid, address(usdc), merchantA);
        vm.expectEmit(true, true, true, true, address(lanes));
        emit IPaymentLanes.Approval(merchantA, bob, id, 123e6);
        vm.prank(merchantA);
        bool ok = lanes.approve(bob, id, 123e6);

        assertTrue(ok);
        assertEq(lanes.allowance(merchantA, bob, id), 123e6);
    }

    function test_approve_overwriteWithoutZeroFirst() public {
        uint256 id = lanes.laneId(block.chainid, address(usdc), merchantA);
        vm.startPrank(merchantA);
        lanes.approve(bob, id, 100e6);
        lanes.approve(bob, id, 50e6); // overwrite — no zero-first dance required
        vm.stopPrank();
        assertEq(lanes.allowance(merchantA, bob, id), 50e6);
    }

    function test_setOperator_true() public {
        vm.expectEmit(true, true, false, true, address(lanes));
        emit IPaymentLanes.OperatorSet(merchantA, bob, true);
        vm.prank(merchantA);
        bool ok = lanes.setOperator(bob, true);

        assertTrue(ok);
        assertTrue(lanes.isOperator(merchantA, bob));
    }

    function test_setOperator_false() public {
        vm.startPrank(merchantA);
        lanes.setOperator(bob, true);
        vm.expectEmit(true, true, false, true, address(lanes));
        emit IPaymentLanes.OperatorSet(merchantA, bob, false);
        lanes.setOperator(bob, false);
        vm.stopPrank();
        assertFalse(lanes.isOperator(merchantA, bob));
    }

    /*//////////////////////////////////////////////////////////////
                               SET ROUTER
    //////////////////////////////////////////////////////////////*/

    function test_setRouter_onlyOwner() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        lanes.setRouter(bob, true);
    }

    function test_setRouter_authorizeAndCredit() public {
        address newRouter = makeAddr("newRouter");
        usdc.mint(newRouter, NET);
        vm.prank(newRouter);
        usdc.approve(address(lanes), NET);

        // Authorize the new router and revoke the old one.
        vm.startPrank(admin);
        vm.expectEmit(true, false, false, true, address(lanes));
        emit IPaymentLanes.RouterSet(newRouter, true);
        lanes.setRouter(newRouter, true);
        lanes.setRouter(router, false);
        vm.stopPrank();

        // New router can credit.
        vm.prank(newRouter);
        uint256 id = lanes.credit(merchantA, address(usdc), NET);
        assertEq(lanes.balanceOf(merchantA, id), NET);

        // Old router can no longer credit.
        vm.prank(router);
        vm.expectRevert(IPaymentLanes.PaymentLanes__Unauthorized.selector);
        lanes.credit(merchantA, address(usdc), NET);
    }

    function test_setRouter_revertsOnZero() public {
        vm.prank(admin);
        vm.expectRevert(IPaymentLanes.PaymentLanes__ZeroAddress.selector);
        lanes.setRouter(address(0), true);
    }

    function test_constructor_revertsOnZeroOwner() public {
        // Ownable's own zero-owner guard fires first.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new PaymentLanes(address(0));
    }

    /*//////////////////////////////////////////////////////////////
                          OWNERSHIP (Ownable2Step)
    //////////////////////////////////////////////////////////////*/

    /// @notice L-2: admin handover is the fat-finger-safe two-tx flow — `transferOwnership` only
    ///         records a pending owner; the new owner takes control only after `acceptOwnership`.
    function test_ownership_twoStep() public {
        address newOwner = makeAddr("newOwner");

        vm.expectEmit(true, true, false, true, address(lanes));
        emit Ownable2Step.OwnershipTransferStarted(admin, newOwner);
        vm.prank(admin);
        lanes.transferOwnership(newOwner);

        // Still the old owner until the new one accepts; pending owner is recorded.
        assertEq(lanes.owner(), admin);
        assertEq(lanes.pendingOwner(), newOwner);

        vm.prank(newOwner);
        lanes.acceptOwnership();

        assertEq(lanes.owner(), newOwner);
        assertEq(lanes.pendingOwner(), address(0));
    }

    /// @notice L-2 regression: a `transferOwnership` is NOT effective until `acceptOwnership`. The old
    ///         owner keeps `setRouter` authority and the (still-only-pending) successor is rejected, so a
    ///         mistyped/uncontrolled successor address can never seize — or permanently brick — the
    ///         router allowlist in a single tx (the single-step `Ownable` footgun this finding closes).
    function test_ownership_transferNotEffectiveUntilAccept() public {
        address newOwner = makeAddr("newOwner");

        vm.prank(admin);
        lanes.transferOwnership(newOwner);

        // Pending only: the old owner is still the live admin.
        assertEq(lanes.owner(), admin);
        assertEq(lanes.pendingOwner(), newOwner);

        // The pending (not-yet-accepted) owner cannot use owner-only `setRouter` yet.
        vm.prank(newOwner);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, newOwner)
        );
        lanes.setRouter(newOwner, true);

        // The current owner still fully controls the allowlist mid-handover.
        address r2 = makeAddr("r2");
        vm.expectEmit(true, false, false, true, address(lanes));
        emit IPaymentLanes.RouterSet(r2, true);
        vm.prank(admin);
        lanes.setRouter(r2, true);
        assertTrue(lanes.isRouter(r2));

        // Only after the successor accepts does control move; the old owner then loses `setRouter`.
        vm.prank(newOwner);
        lanes.acceptOwnership();
        assertEq(lanes.owner(), newOwner);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        lanes.setRouter(admin, true);
    }

    /// @notice Only the recorded pending owner may accept; an arbitrary account cannot.
    function test_ownership_acceptOwnership_onlyPending() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(admin);
        lanes.transferOwnership(newOwner);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        lanes.acceptOwnership();

        // The handover is untouched — still pending the real successor.
        assertEq(lanes.owner(), admin);
        assertEq(lanes.pendingOwner(), newOwner);
    }

    /*//////////////////////////////////////////////////////////////
                                 LANE ID
    //////////////////////////////////////////////////////////////*/

    function testFuzz_laneId_deterministic(uint256 chainId_, address asset, address recipient)
        public
        view
    {
        uint256 a = lanes.laneId(chainId_, asset, recipient);
        uint256 b = lanes.laneId(chainId_, asset, recipient);
        assertEq(a, b); // same inputs ⇒ same id
        assertEq(a, uint256(keccak256(abi.encode(chainId_, asset, recipient))));
    }

    function testFuzz_laneId_distinctInputsDistinctIds(
        uint256 c1,
        address a1,
        address r1,
        uint256 c2,
        address a2,
        address r2
    ) public view {
        vm.assume(c1 != c2 || a1 != a2 || r1 != r2);
        assertTrue(lanes.laneId(c1, a1, r1) != lanes.laneId(c2, a2, r2));
    }

    function test_laneId_crossChain() public view {
        uint256 onMainnet = lanes.laneId(1, address(usdc), merchantA);
        uint256 onArc = lanes.laneId(5_042_002, address(usdc), merchantA);
        assertTrue(onMainnet != onArc); // chain isolation lives in the id
    }

    /*//////////////////////////////////////////////////////////////
                               REENTRANCY
    //////////////////////////////////////////////////////////////*/

    function test_reentrancy_claim() public {
        ReentrantClaimToken evil = new ReentrantClaimToken();
        evil.setLanes(lanes);
        evil.mint(router, NET);
        vm.prank(router);
        evil.approve(address(lanes), NET);

        // Credit a lane backed by the malicious token.
        uint256 id = _credit(merchantA, address(evil), NET);
        evil.arm(true); // arm the re-entrant claim on the outbound transfer

        // CEI zeroes the balance before the transfer, so the re-entrant claim finds nothing (and
        // the guard blocks it anyway). The legitimate claim still settles exactly once.
        vm.prank(merchantA);
        lanes.claim(address(evil));

        assertEq(lanes.balanceOf(merchantA, id), 0);
        assertEq(evil.balanceOf(merchantA), NET); // paid exactly once
        assertEq(evil.balanceOf(address(lanes)), 0); // no surplus, no double pay
    }

    function test_reentrancy_credit() public {
        ReentrantCreditToken evil = new ReentrantCreditToken();
        evil.setLanes(lanes, merchantA);
        evil.mint(router, NET);
        vm.prank(router);
        evil.approve(address(lanes), type(uint256).max);
        evil.arm(true);

        // The re-entrant credit (fired by the token mid-pull) hits the nonReentrant guard and
        // reverts the WHOLE outer credit — no partial mint survives.
        vm.prank(router);
        vm.expectRevert(); // ReentrancyGuardReentrantCall, bubbled
        lanes.credit(merchantA, address(evil), NET);

        uint256 id = lanes.laneId(block.chainid, address(evil), merchantA);
        assertEq(lanes.balanceOf(merchantA, id), 0); // nothing minted
    }

    /*//////////////////////////////////////////////////////////////
                                  FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @notice Conservation: after a credit then a claim of the same lane, the lane balance returns to
    ///         zero and the underlying is fully returned — no wei created or destroyed.
    function testFuzz_conservation(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000e6);
        uint256 id = _credit(merchantA, address(usdc), amount);
        assertEq(lanes.balanceOf(merchantA, id), amount);
        assertEq(usdc.balanceOf(address(lanes)), amount);

        vm.prank(merchantA);
        lanes.claim(address(usdc));
        assertEq(lanes.balanceOf(merchantA, id), 0);
        assertEq(usdc.balanceOf(address(lanes)), 0);
        assertEq(usdc.balanceOf(merchantA), amount);
    }

    /// @notice Cross-merchant isolation: crediting merchant A's lane never moves merchant B's lane
    ///         balance, for any amounts and any (other) recipient/asset.
    function testFuzz_crossMerchantIsolation(uint256 amtA, uint256 amtB, bool sameAsset) public {
        amtA = bound(amtA, 1, 500_000e6);
        amtB = bound(amtB, 1, 500_000e6);
        address assetB = sameAsset ? address(usdc) : address(eurc);

        uint256 idA = lanes.laneId(block.chainid, address(usdc), merchantA);
        uint256 idB = lanes.laneId(block.chainid, assetB, merchantB);
        assertTrue(idA != idB); // distinct triples

        _credit(merchantA, address(usdc), amtA);
        uint256 bBefore = lanes.balanceOf(merchantB, idB);
        _credit(merchantB, assetB, amtB);
        // Crediting B did not change A; A's earlier credit did not seed B.
        assertEq(lanes.balanceOf(merchantA, idA), amtA);
        assertEq(lanes.balanceOf(merchantB, idB), bBefore + amtB);
    }

    /*//////////////////////////////////////////////////////////////
                          ROUTER INTEGRATION
    //////////////////////////////////////////////////////////////*/

    /// @dev A reusable wired-up router + lanes + feed + token fixture, returned in one struct so the
    ///      integration tests stay under the IR stack budget.
    struct Wired {
        Access0x1Router r;
        PaymentLanes l;
        MockUSDC payUsdc;
        address rTreasury;
        uint256 mid;
        address mPayout;
        address mFee;
    }

    /// @dev Stand up a router wired to PaymentLanes (router authorized iff `authorizeRouter`), a $1
    ///      USDC feed, and a registered merchant. Keeps the test bodies shallow.
    function _wire(bool authorizeRouter, uint16 merchantFeeBps, string memory salt)
        internal
        returns (Wired memory w)
    {
        address rOwner = makeAddr(string.concat("rOwner_", salt));
        w.rTreasury = makeAddr(string.concat("rTreasury_", salt));
        w.r = new Access0x1Router(rOwner, w.rTreasury, 100); // 1% platform fee

        vm.warp(1_700_000_000);
        MockV3Aggregator usdcFeed = new MockV3Aggregator(8, 1e8); // USDC/USD = $1
        w.payUsdc = new MockUSDC();
        w.l = new PaymentLanes(rOwner);

        vm.startPrank(rOwner);
        w.r.setTokenAllowed(address(w.payUsdc), true);
        w.r.setPriceFeed(address(w.payUsdc), address(usdcFeed));
        w.r.setPaymentLanes(address(w.l));
        if (authorizeRouter) w.l.setRouter(address(w.r), true);
        vm.stopPrank();

        address mOwner = makeAddr(string.concat("mOwner_", salt));
        w.mPayout = makeAddr(string.concat("mPayout_", salt));
        w.mFee = makeAddr(string.concat("mFee_", salt));
        vm.prank(mOwner);
        w.mid = w.r.registerMerchant(w.mPayout, w.mFee, merchantFeeBps, keccak256(bytes(salt)));
    }

    /// @dev Buyer pays `usd` for merchant `w.mid` in USDC and returns the gross pulled.
    function _pay(Wired memory w, uint256 usd, string memory salt)
        internal
        returns (uint256 gross)
    {
        gross = w.r.quote(w.mid, address(w.payUsdc), usd);
        address buyer2 = makeAddr(string.concat("buyer_", salt));
        w.payUsdc.mint(buyer2, gross);
        vm.startPrank(buyer2);
        w.payUsdc.approve(address(w.r), gross);
        w.r.payToken(w.mid, address(w.payUsdc), usd, keccak256("order"));
        vm.stopPrank();
    }

    function test_integration_routerCredit() public {
        Wired memory w = _wire({ authorizeRouter: true, merchantFeeBps: 50, salt: "ic" });

        uint256 usd = 1_000e8;
        uint256 gross = _pay(w, usd, "ic");
        uint256 platformFee = gross * 100 / 10_000; // 1%
        uint256 merchantFee = gross * 50 / 10_000; // 0.5%
        uint256 net = gross - platformFee - merchantFee;

        // The merchant's NET is now a lane receipt, fully backed by USDC held in PaymentLanes.
        uint256 laneId = w.l.laneId(block.chainid, address(w.payUsdc), w.mPayout);
        assertEq(w.l.balanceOf(w.mPayout, laneId), net);
        assertEq(w.payUsdc.balanceOf(address(w.l)), net);

        // Invariant 3 (zero custody): the router holds no token.
        assertEq(w.payUsdc.balanceOf(address(w.r)), 0);

        // The fee legs settled normally (NOT into lanes).
        assertEq(w.payUsdc.balanceOf(w.rTreasury), platformFee);
        assertEq(w.payUsdc.balanceOf(w.mFee), merchantFee);

        // The merchant pulls its net out of the lane.
        vm.prank(w.mPayout);
        w.l.claim(address(w.payUsdc));
        assertEq(w.payUsdc.balanceOf(w.mPayout), net);
        assertEq(w.payUsdc.balanceOf(address(w.l)), 0);
    }

    function test_integration_lanesFailureFallsBackToDirectPush() public {
        // Router NOT authorized on PaymentLanes: the credit reverts inside try/catch and the net is
        // pushed directly to the merchant — the payment still settles (law #5).
        Wired memory w = _wire({ authorizeRouter: false, merchantFeeBps: 0, salt: "fb" });

        uint256 usd = 1_000e8;
        uint256 gross = _pay(w, usd, "fb");
        uint256 net = gross - (gross * 100 / 10_000);

        uint256 laneId = w.l.laneId(block.chainid, address(w.payUsdc), w.mPayout);
        assertEq(w.l.balanceOf(w.mPayout, laneId), 0); // nothing in lanes
        assertEq(w.payUsdc.balanceOf(address(w.l)), 0);
        assertEq(w.payUsdc.balanceOf(w.mPayout), net); // settled directly
        assertEq(w.payUsdc.balanceOf(address(w.r)), 0); // zero custody held
    }

    function test_setPaymentLanes_onlyOwner() public {
        Access0x1Router r = new Access0x1Router(admin, makeAddr("t"), 100);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        r.setPaymentLanes(address(lanes));
    }
}
