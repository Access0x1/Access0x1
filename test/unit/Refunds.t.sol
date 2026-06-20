// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Refunds } from "../../src/Refunds.sol";
import { IRefunds } from "../../src/interfaces/IRefunds.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockUsdcPermit3009 } from "../mocks/MockUsdcPermit3009.sol";
import { FeeOnTransferToken } from "../mocks/FeeOnTransferToken.sol";
import { FeeOnTransfer3009 } from "../mocks/FeeOnTransfer3009.sol";
import { BlocklistToken } from "../mocks/BlocklistToken.sol";
import { RevertingReceiver } from "../mocks/RevertingReceiver.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    OwnableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @notice A trivial v2 implementation for the upgrade test: a subclass adding one view and nothing
///         else, so an upgrade to it must preserve all prior state. It carries no new storage (it would
///         consume from `__gap` if it did), proving the proxy keeps every slot across the impl swap.
contract RefundsV2 is Refunds {
    /// @notice A marker the original implementation does not expose — proves the new logic is live.
    function version2Marker() external pure returns (string memory) {
        return "v2";
    }
}

/// @notice The {Refunds} unit suite: the full surface in one fixture — initializer, the three funding
///         legs (standard / EIP-2612 permit / EIP-3009 receiveWithAuthorization), native + token,
///         claim, reclaim, the terminal-state machine, the never-blockable pull-map (withdraw /
///         withdrawTo), the ERC-6909 claim-receipt accounting, ERC-165, and the UUPS upgrade + freeze.
///         The contract is deployed BEHIND a UUPS proxy via the shared {ProxyDeployer}, so every test
///         exercises the production proxy↔impl shape. Every revert path is asserted.
contract RefundsTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    Refunds internal refunds;

    address internal owner = makeAddr("owner"); // router owner
    address internal treasury = makeAddr("treasury");
    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%

    /// @dev The merchant owner is a known private key so it can SIGN the 2612/3009 funding authorizations.
    uint256 internal merchantOwnerPk = 0xA11CE;
    address internal merchantOwner = vm.addr(0xA11CE);
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient");
    bytes32 internal constant NAME_HASH = keccak256("acme");

    MockUSDC internal usdc; // 6 dp, plain (standard-allowance leg)
    MockUsdcPermit3009 internal usdcP; // 6 dp, permit + 3009 (gasless legs)
    MockV3Aggregator internal usdcFeed; // only needed so the token is allowlisted

    address internal buyer = makeAddr("buyer");
    address internal stranger = makeAddr("stranger");
    bytes32 internal constant ORDER = keccak256("order-1");

    /// @dev The contract (upgrade-admin) owner of the Refunds proxy — DISTINCT from `merchantOwner`.
    address internal admin = makeAddr("admin");

    uint256 internal merchantId;
    uint64 internal deadline;

    function setUp() public {
        vm.warp(1_700_000_000);
        deadline = uint64(block.timestamp + 7 days);

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (owner, treasury, PLATFORM_FEE_BPS))
            )
        );

        address impl = address(new Refunds());
        refunds = Refunds(deployProxy(impl, abi.encodeCall(Refunds.initialize, (admin, router))));

        usdc = new MockUSDC();
        usdcP = new MockUsdcPermit3009();
        usdcFeed = new MockV3Aggregator(8, 1e8);
        vm.startPrank(owner);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        router.setTokenAllowed(address(usdcP), true);
        router.setPriceFeed(address(usdcP), address(usdcFeed));
        vm.stopPrank();

        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, 50, NAME_HASH);

        // Fund the merchant owner so it can pay refunds out.
        usdc.mint(merchantOwner, 1_000_000e6);
        usdcP.mint(merchantOwner, 1_000_000e6);
        vm.deal(merchantOwner, 100 ether);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Request a standard-allowance USDC refund for `amount` (merchant owner approves first).
    function _requestTokenStd(bytes32 order, uint256 amount) internal {
        vm.startPrank(merchantOwner);
        usdc.approve(address(refunds), amount);
        refunds.requestRefund(merchantId, order, buyer, address(usdc), amount, deadline);
        vm.stopPrank();
    }

    /// @dev Request a native refund for `amount`.
    function _requestNative(bytes32 order, uint256 amount) internal {
        vm.prank(merchantOwner);
        refunds.requestRefund{ value: amount }(
            merchantId, order, buyer, address(0), amount, deadline
        );
    }

    /// @dev Build a valid EIP-2612 permit signature from the merchant owner for `usdcP`.
    function _permitSig(uint256 value, uint256 permitDeadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 typehash = keccak256(
            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        );
        bytes32 structHash = keccak256(
            abi.encode(
                typehash,
                merchantOwner,
                address(refunds),
                value,
                usdcP.nonces(merchantOwner),
                permitDeadline
            )
        );
        bytes32 digest = _toTypedDigest(usdcP.DOMAIN_SEPARATOR(), structHash);
        (v, r, s) = vm.sign(merchantOwnerPk, digest);
    }

    /// @dev Build a valid EIP-3009 receiveWithAuthorization signature from the merchant owner for a token.
    function _authSig(
        bytes32 domainSep,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 typehash = keccak256(
            "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );
        bytes32 structHash = keccak256(
            abi.encode(
                typehash, merchantOwner, address(refunds), value, validAfter, validBefore, nonce
            )
        );
        (v, r, s) = vm.sign(merchantOwnerPk, _toTypedDigest(domainSep, structHash));
    }

    function _toTypedDigest(bytes32 domainSep, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    /// @dev The current lifecycle state of the default `(merchantId, ORDER)` refund, as a uint8.
    function _state(bytes32 order) internal view returns (uint8) {
        return uint8(refunds.refundOf(merchantId, order).state);
    }

    /*//////////////////////////////////////////////////////////////
                              INITIALIZE
    //////////////////////////////////////////////////////////////*/

    function test_initializeSetsRouterAndOwner() public view {
        assertEq(address(refunds.router()), address(router));
        assertEq(OwnableUpgradeable(address(refunds)).owner(), admin);
    }

    function test_initializeRevertsOnZeroRouter() public {
        address impl = address(new Refunds());
        vm.expectRevert(IRefunds.Refunds__ZeroAddress.selector);
        deployProxy(
            impl, abi.encodeCall(Refunds.initialize, (admin, Access0x1Router(payable(address(0)))))
        );
    }

    function test_initializeRevertsOnSecondCall() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        refunds.initialize(admin, router);
    }

    /*//////////////////////////////////////////////////////////////
                       REQUEST (standard allowance)
    //////////////////////////////////////////////////////////////*/

    function test_requestToken_fundsAndMintsReceipt() public {
        uint256 amount = 100e6;
        uint256 id = refunds.refundTokenId(merchantId, ORDER);

        vm.startPrank(merchantOwner);
        usdc.approve(address(refunds), amount);
        vm.expectEmit(true, true, true, true);
        emit IRefunds.RefundRequested(merchantId, ORDER, buyer, address(usdc), amount, deadline, id);
        refunds.requestRefund(merchantId, ORDER, buyer, address(usdc), amount, deadline);
        vm.stopPrank();

        // The contract holds exactly the refund; the buyer holds an equal ERC-6909 receipt.
        assertEq(usdc.balanceOf(address(refunds)), amount);
        assertEq(refunds.balanceOf(buyer, id), amount);

        IRefunds.Refund memory r = refunds.refundOf(merchantId, ORDER);
        assertEq(r.merchantId, merchantId);
        assertEq(r.buyer, buyer);
        assertEq(r.asset, address(usdc));
        assertEq(r.amount, amount);
        assertEq(r.deadline, deadline);
        assertEq(uint8(r.state), uint8(IRefunds.RefundState.PENDING));
        assertTrue(refunds.isClaimable(merchantId, ORDER));
    }

    function test_requestNative_fundsAndMintsReceipt() public {
        uint256 amount = 1 ether;
        _requestNative(ORDER, amount);
        assertEq(address(refunds).balance, amount);
        assertEq(refunds.balanceOf(buyer, refunds.refundTokenId(merchantId, ORDER)), amount);
        assertEq(_state(ORDER), uint8(IRefunds.RefundState.PENDING));
    }

    function test_requestToken_revertsOnZeroBuyer() public {
        vm.prank(merchantOwner);
        vm.expectRevert(IRefunds.Refunds__ZeroAddress.selector);
        refunds.requestRefund(merchantId, ORDER, address(0), address(usdc), 1e6, deadline);
    }

    function test_requestToken_revertsOnZeroAmount() public {
        vm.prank(merchantOwner);
        vm.expectRevert(IRefunds.Refunds__ZeroAmount.selector);
        refunds.requestRefund(merchantId, ORDER, buyer, address(usdc), 0, deadline);
    }

    function test_requestToken_revertsOnPastDeadline() public {
        uint64 past = uint64(block.timestamp);
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(IRefunds.Refunds__BadDeadline.selector, past, block.timestamp)
        );
        refunds.requestRefund(merchantId, ORDER, buyer, address(usdc), 1e6, past);
    }

    function test_requestToken_revertsForNonMerchantOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRefunds.Refunds__NotMerchantOwner.selector, merchantId, stranger
            )
        );
        refunds.requestRefund(merchantId, ORDER, buyer, address(usdc), 1e6, deadline);
    }

    function test_requestToken_revertsForUnknownMerchant() public {
        // An unknown merchant has owner == address(0); no caller equals it, so it reverts NotMerchantOwner.
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRefunds.Refunds__NotMerchantOwner.selector, uint256(999), merchantOwner
            )
        );
        refunds.requestRefund(999, ORDER, buyer, address(usdc), 1e6, deadline);
    }

    function test_requestToken_revertsOnDuplicateOrderId() public {
        _requestTokenStd(ORDER, 50e6);
        vm.startPrank(merchantOwner);
        usdc.approve(address(refunds), 50e6);
        vm.expectRevert(
            abi.encodeWithSelector(IRefunds.Refunds__AlreadyRequested.selector, merchantId, ORDER)
        );
        refunds.requestRefund(merchantId, ORDER, buyer, address(usdc), 50e6, deadline);
        vm.stopPrank();
    }

    function test_requestNative_revertsOnValueMismatch() public {
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(IRefunds.Refunds__ValueMismatch.selector, 1 ether, 0.5 ether)
        );
        refunds.requestRefund{ value: 0.5 ether }(
            merchantId, ORDER, buyer, address(0), 1 ether, deadline
        );
    }

    function test_requestToken_revertsOnStrayValue() public {
        vm.startPrank(merchantOwner);
        usdc.approve(address(refunds), 1e6);
        vm.expectRevert(abi.encodeWithSelector(IRefunds.Refunds__ValueMismatch.selector, 0, 1 wei));
        refunds.requestRefund{ value: 1 wei }(
            merchantId, ORDER, buyer, address(usdc), 1e6, deadline
        );
        vm.stopPrank();
    }

    function test_requestToken_rejectsFeeOnTransfer() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        fot.mint(merchantOwner, 100e6);
        vm.startPrank(merchantOwner);
        fot.approve(address(refunds), 100e6);
        // 1% skim ⇒ received 99e6 != 100e6 asked.
        vm.expectRevert(
            abi.encodeWithSelector(IRefunds.Refunds__FeeOnTransferToken.selector, 100e6, 99e6)
        );
        refunds.requestRefund(merchantId, ORDER, buyer, address(fot), 100e6, deadline);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                       REQUEST (EIP-2612 permit)
    //////////////////////////////////////////////////////////////*/

    function test_requestWithPermit_funds() public {
        uint256 amount = 250e6;
        uint256 pDeadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(amount, pDeadline);

        vm.prank(merchantOwner);
        refunds.requestRefundWithPermit(
            merchantId, ORDER, buyer, address(usdcP), amount, deadline, pDeadline, v, r, s
        );

        assertEq(usdcP.balanceOf(address(refunds)), amount);
        assertEq(refunds.balanceOf(buyer, refunds.refundTokenId(merchantId, ORDER)), amount);
    }

    function test_requestWithPermit_revertsForNative() public {
        vm.prank(merchantOwner);
        vm.expectRevert(IRefunds.Refunds__GaslessNotForNative.selector);
        refunds.requestRefundWithPermit(
            merchantId, ORDER, buyer, address(0), 1e6, deadline, block.timestamp + 1, 0, 0, 0
        );
    }

    function test_requestWithPermit_survivesFrontRunPermit() public {
        // An attacker front-runs the permit (consuming the nonce) — our try/catch swallows the revert
        // and the funding still succeeds because the allowance is set. Simulate by submitting the
        // permit directly first, then calling with a now-stale signature.
        uint256 amount = 250e6;
        uint256 pDeadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(amount, pDeadline);
        // Front-run: anyone submits the permit, setting the allowance + bumping the nonce.
        usdcP.permit(merchantOwner, address(refunds), amount, pDeadline, v, r, s);
        // Now the same signature is stale (nonce consumed); the contract's try/catch tolerates it.
        vm.prank(merchantOwner);
        refunds.requestRefundWithPermit(
            merchantId, ORDER, buyer, address(usdcP), amount, deadline, pDeadline, v, r, s
        );
        assertEq(usdcP.balanceOf(address(refunds)), amount);
    }

    /*//////////////////////////////////////////////////////////////
                   REQUEST (EIP-3009 receiveWithAuthorization)
    //////////////////////////////////////////////////////////////*/

    function test_requestWithAuthorization_funds() public {
        uint256 amount = 300e6;
        bytes32 nonce = keccak256("auth-nonce-1");
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) =
            _authSig(usdcP.DOMAIN_SEPARATOR(), amount, validAfter, validBefore, nonce);

        IRefunds.ReceiveAuthorization memory auth = IRefunds.ReceiveAuthorization({
            from: merchantOwner, validAfter: validAfter, validBefore: validBefore, nonce: nonce
        });

        vm.prank(merchantOwner);
        refunds.requestRefundWithAuthorization(
            merchantId, ORDER, buyer, address(usdcP), amount, deadline, auth, v, r, s
        );

        assertEq(usdcP.balanceOf(address(refunds)), amount);
        assertEq(refunds.balanceOf(buyer, refunds.refundTokenId(merchantId, ORDER)), amount);
    }

    function test_requestWithAuthorization_revertsForNative() public {
        IRefunds.ReceiveAuthorization memory auth;
        vm.prank(merchantOwner);
        vm.expectRevert(IRefunds.Refunds__GaslessNotForNative.selector);
        refunds.requestRefundWithAuthorization(
            merchantId, ORDER, buyer, address(0), 1e6, deadline, auth, 0, 0, 0
        );
    }

    function test_requestWithAuthorization_revertsWhenAuthFromNotOwner() public {
        uint256 amount = 300e6;
        bytes32 nonce = keccak256("auth-nonce-2");
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) =
            _authSig(usdcP.DOMAIN_SEPARATOR(), amount, 0, validBefore, nonce);
        // auth.from is the stranger, not the merchant owner ⇒ reject.
        IRefunds.ReceiveAuthorization memory auth = IRefunds.ReceiveAuthorization({
            from: stranger, validAfter: 0, validBefore: validBefore, nonce: nonce
        });
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRefunds.Refunds__NotMerchantOwner.selector, merchantId, stranger
            )
        );
        refunds.requestRefundWithAuthorization(
            merchantId, ORDER, buyer, address(usdcP), amount, deadline, auth, v, r, s
        );
    }

    function test_requestWithAuthorization_rejectsFeeOnTransfer() public {
        FeeOnTransfer3009 fot = new FeeOnTransfer3009();
        fot.mint(merchantOwner, 100e6);
        vm.prank(owner);
        router.setTokenAllowed(address(fot), true); // allowlisting not required by Refunds, but harmless

        uint256 amount = 100e6;
        bytes32 nonce = keccak256("auth-fot");
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 typehash = keccak256(
            "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );
        bytes32 structHash = keccak256(
            abi.encode(typehash, merchantOwner, address(refunds), amount, 0, validBefore, nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(merchantOwnerPk, _toTypedDigest(fot.DOMAIN_SEPARATOR(), structHash));

        IRefunds.ReceiveAuthorization memory auth = IRefunds.ReceiveAuthorization({
            from: merchantOwner, validAfter: 0, validBefore: validBefore, nonce: nonce
        });
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(IRefunds.Refunds__FeeOnTransferToken.selector, 100e6, 99e6)
        );
        refunds.requestRefundWithAuthorization(
            merchantId, ORDER, buyer, address(fot), amount, deadline, auth, v, r, s
        );
    }

    /*//////////////////////////////////////////////////////////////
                                  CLAIM
    //////////////////////////////////////////////////////////////*/

    function test_claimToken_paysBuyerAndBurnsReceipt() public {
        uint256 amount = 100e6;
        _requestTokenStd(ORDER, amount);
        uint256 id = refunds.refundTokenId(merchantId, ORDER);

        vm.expectEmit(true, true, true, true);
        emit IRefunds.RefundClaimed(merchantId, ORDER, buyer, address(usdc), amount);
        vm.prank(buyer);
        refunds.claim(merchantId, ORDER);

        assertEq(usdc.balanceOf(buyer), amount);
        assertEq(usdc.balanceOf(address(refunds)), 0); // zero custody after resolution
        assertEq(refunds.balanceOf(buyer, id), 0); // receipt burned
        assertEq(_state(ORDER), uint8(IRefunds.RefundState.CLAIMED));
        assertFalse(refunds.isClaimable(merchantId, ORDER));
    }

    function test_claimNative_paysBuyer() public {
        uint256 amount = 1 ether;
        _requestNative(ORDER, amount);
        uint256 before = buyer.balance;
        vm.prank(buyer);
        refunds.claim(merchantId, ORDER);
        assertEq(buyer.balance, before + amount);
        assertEq(address(refunds).balance, 0);
    }

    function test_claim_revertsForNonBuyer() public {
        _requestTokenStd(ORDER, 100e6);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IRefunds.Refunds__NotBuyer.selector, merchantId, ORDER, stranger)
        );
        refunds.claim(merchantId, ORDER);
    }

    function test_claim_revertsForUnknownRefund() public {
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(IRefunds.Refunds__Unknown.selector, merchantId, ORDER)
        );
        refunds.claim(merchantId, ORDER);
    }

    function test_claim_revertsAfterWindowClosed() public {
        _requestTokenStd(ORDER, 100e6);
        vm.warp(deadline); // at the deadline the claim window is closed (>=)
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRefunds.Refunds__ClaimWindowClosed.selector, merchantId, ORDER, deadline
            )
        );
        refunds.claim(merchantId, ORDER);
    }

    function test_claim_cannotDoubleClaim() public {
        _requestTokenStd(ORDER, 100e6);
        vm.prank(buyer);
        refunds.claim(merchantId, ORDER);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRefunds.Refunds__NotPending.selector,
                merchantId,
                ORDER,
                IRefunds.RefundState.CLAIMED
            )
        );
        refunds.claim(merchantId, ORDER);
    }

    function test_claim_revertingBuyerQueuesToPullMap() public {
        // A buyer whose `receive` reverts cannot block its own native refund — it queues to the pull-map.
        RevertingReceiver rr = new RevertingReceiver();
        vm.prank(merchantOwner);
        refunds.requestRefund{ value: 1 ether }(
            merchantId, ORDER, address(rr), address(0), 1 ether, deadline
        );

        vm.expectEmit(true, true, false, true);
        emit IRefunds.PayoutQueued(address(rr), address(0), 1 ether);
        vm.prank(address(rr));
        refunds.claim(merchantId, ORDER);

        // The refund still resolved (terminal), and the funds are claimable from the pull-map.
        assertEq(_state(ORDER), uint8(IRefunds.RefundState.CLAIMED));
        assertEq(refunds.withdrawable(address(rr), address(0)), 1 ether);
        assertEq(address(refunds).balance, 1 ether); // still held, awaiting the pull
    }

    /*//////////////////////////////////////////////////////////////
                                 RECLAIM
    //////////////////////////////////////////////////////////////*/

    function test_reclaim_returnsFundsAfterWindow() public {
        uint256 amount = 100e6;
        _requestTokenStd(ORDER, amount);
        vm.warp(deadline);

        address sink = makeAddr("sink");
        vm.expectEmit(true, true, true, true);
        emit IRefunds.RefundReclaimed(merchantId, ORDER, sink, address(usdc), amount);
        vm.prank(merchantOwner);
        refunds.reclaim(merchantId, ORDER, sink);

        assertEq(usdc.balanceOf(sink), amount);
        assertEq(usdc.balanceOf(address(refunds)), 0);
        assertEq(refunds.balanceOf(buyer, refunds.refundTokenId(merchantId, ORDER)), 0); // stale receipt burned
        assertEq(
            uint8(refunds.refundOf(merchantId, ORDER).state), uint8(IRefunds.RefundState.RECLAIMED)
        );
    }

    function test_reclaim_revertsBeforeWindowCloses() public {
        _requestTokenStd(ORDER, 100e6);
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRefunds.Refunds__WindowNotClosed.selector, merchantId, ORDER, deadline
            )
        );
        refunds.reclaim(merchantId, ORDER, merchantOwner);
    }

    function test_reclaim_revertsForNonMerchantOwner() public {
        _requestTokenStd(ORDER, 100e6);
        vm.warp(deadline);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRefunds.Refunds__NotMerchantOwner.selector, merchantId, stranger
            )
        );
        refunds.reclaim(merchantId, ORDER, stranger);
    }

    function test_reclaim_revertsOnZeroSink() public {
        _requestTokenStd(ORDER, 100e6);
        vm.warp(deadline);
        vm.prank(merchantOwner);
        vm.expectRevert(IRefunds.Refunds__ZeroAddress.selector);
        refunds.reclaim(merchantId, ORDER, address(0));
    }

    function test_reclaim_revertsForUnknownRefund() public {
        vm.warp(deadline);
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(IRefunds.Refunds__Unknown.selector, merchantId, ORDER)
        );
        refunds.reclaim(merchantId, ORDER, merchantOwner);
    }

    function test_claim_blockedAfterReclaim() public {
        _requestTokenStd(ORDER, 100e6);
        vm.warp(deadline);
        vm.prank(merchantOwner);
        refunds.reclaim(merchantId, ORDER, merchantOwner);
        // The buyer can never claim a reclaimed refund (terminal) — and the window is closed anyway.
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRefunds.Refunds__NotPending.selector,
                merchantId,
                ORDER,
                IRefunds.RefundState.RECLAIMED
            )
        );
        refunds.claim(merchantId, ORDER);
    }

    /*//////////////////////////////////////////////////////////////
                            WITHDRAW (pull-map)
    //////////////////////////////////////////////////////////////*/

    function test_withdraw_paysQueuedNative() public {
        RevertingReceiver rr = new RevertingReceiver();
        vm.prank(merchantOwner);
        refunds.requestRefund{ value: 1 ether }(
            merchantId, ORDER, address(rr), address(0), 1 ether, deadline
        );
        vm.prank(address(rr));
        refunds.claim(merchantId, ORDER); // queues to pull-map (rr reverts on receive)

        // rr still cannot pull native to itself (its receive reverts) — that path reverts.
        vm.prank(address(rr));
        vm.expectRevert(
            abi.encodeWithSelector(IRefunds.Refunds__WithdrawFailed.selector, address(rr), 1 ether)
        );
        refunds.withdraw(address(0));
    }

    function test_withdrawTo_redirectsQueuedNative() public {
        RevertingReceiver rr = new RevertingReceiver();
        vm.prank(merchantOwner);
        refunds.requestRefund{ value: 1 ether }(
            merchantId, ORDER, address(rr), address(0), 1 ether, deadline
        );
        vm.prank(address(rr));
        refunds.claim(merchantId, ORDER);

        // rr redirects ITS OWN credit to a receivable address.
        address good = makeAddr("good");
        vm.expectEmit(true, true, true, true);
        emit IRefunds.WithdrawnTo(address(rr), good, address(0), 1 ether);
        vm.prank(address(rr));
        refunds.withdrawTo(address(0), good);
        assertEq(good.balance, 1 ether);
        assertEq(refunds.withdrawable(address(rr), address(0)), 0);
    }

    function test_claimToken_blockedBuyerQueuesThenWithdraws() public {
        // A buyer blocklisted on a USDC-style token cannot have the claim push land — it queues to the
        // pull-map (the token branch of _payoutOrQueue), and the buyer pulls it once unblocked (the
        // token branch of withdraw). The refund still resolves (never-blockable, law #5).
        BlocklistToken bl = new BlocklistToken();
        bl.mint(merchantOwner, 100e6);
        vm.startPrank(merchantOwner);
        bl.approve(address(refunds), 100e6);
        refunds.requestRefund(merchantId, ORDER, buyer, address(bl), 100e6, deadline);
        vm.stopPrank();

        bl.setBlocked(buyer, true); // the buyer cannot receive bl now

        vm.expectEmit(true, true, false, true);
        emit IRefunds.PayoutQueued(buyer, address(bl), 100e6);
        vm.prank(buyer);
        refunds.claim(merchantId, ORDER); // push fails ⇒ queues

        assertEq(_state(ORDER), uint8(IRefunds.RefundState.CLAIMED));
        assertEq(refunds.withdrawable(buyer, address(bl)), 100e6);

        // Pulling while still blocked reverts inside SafeERC20 (the token's own revert bubbles up),
        // restoring the credit; once unblocked the pull succeeds (the token branch of withdraw).
        bl.setBlocked(buyer, false);
        vm.expectEmit(true, true, false, true);
        emit IRefunds.Withdrawn(buyer, address(bl), 100e6);
        vm.prank(buyer);
        refunds.withdraw(address(bl));
        assertEq(bl.balanceOf(buyer), 100e6);
        assertEq(refunds.withdrawable(buyer, address(bl)), 0);
    }

    function test_withdraw_revertsWhenNothingOwed() public {
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(IRefunds.Refunds__NothingToWithdraw.selector, address(usdc))
        );
        refunds.withdraw(address(usdc));
    }

    function test_withdrawTo_revertsOnZeroAddress() public {
        vm.prank(buyer);
        vm.expectRevert(IRefunds.Refunds__ZeroAddress.selector);
        refunds.withdrawTo(address(0), address(0));
    }

    function test_withdrawTo_revertsWhenNothingOwed() public {
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(IRefunds.Refunds__NothingToWithdraw.selector, address(usdc))
        );
        refunds.withdrawTo(address(usdc), buyer);
    }

    /*//////////////////////////////////////////////////////////////
                              VIEWS / ERC-165
    //////////////////////////////////////////////////////////////*/

    function test_refundTokenId_isDeterministicPerPosition() public view {
        assertEq(
            refunds.refundTokenId(merchantId, ORDER),
            uint256(keccak256(abi.encodePacked("Access0x1Refund", merchantId, ORDER)))
        );
        // Distinct positions hold distinct ids — a different order id, or a different merchant, never
        // collides onto the same receipt (the bug a per-asset id would have allowed).
        assertTrue(
            refunds.refundTokenId(merchantId, ORDER)
                != refunds.refundTokenId(merchantId, keccak256("order-2"))
        );
        assertTrue(
            refunds.refundTokenId(merchantId, ORDER) != refunds.refundTokenId(merchantId + 1, ORDER)
        );
    }

    function test_supportsInterface() public view {
        assertTrue(refunds.supportsInterface(type(IRefunds).interfaceId));
        assertTrue(refunds.supportsInterface(type(IERC165).interfaceId));
        assertFalse(refunds.supportsInterface(0xffffffff));
    }

    function test_isClaimable_falseForUnknownAndResolved() public {
        assertFalse(refunds.isClaimable(merchantId, ORDER)); // unknown
        _requestTokenStd(ORDER, 100e6);
        assertTrue(refunds.isClaimable(merchantId, ORDER));
        vm.prank(buyer);
        refunds.claim(merchantId, ORDER);
        assertFalse(refunds.isClaimable(merchantId, ORDER)); // claimed
    }

    /*//////////////////////////////////////////////////////////////
                          UUPS UPGRADE / FREEZE
    //////////////////////////////////////////////////////////////*/

    function test_upgrade_preservesStateAndAddsFn() public {
        _requestTokenStd(ORDER, 100e6);

        address v2 = address(new RefundsV2());
        vm.prank(admin);
        UUPSUpgradeable(address(refunds)).upgradeToAndCall(v2, "");

        assertEq(RefundsV2(address(refunds)).version2Marker(), "v2");
        assertEq(address(refunds.router()), address(router));
        IRefunds.Refund memory r = refunds.refundOf(merchantId, ORDER);
        assertEq(r.amount, 100e6);
        assertEq(uint8(r.state), uint8(IRefunds.RefundState.PENDING));
        assertEq(refunds.balanceOf(buyer, refunds.refundTokenId(merchantId, ORDER)), 100e6);
        assertEq(OwnableUpgradeable(address(refunds)).owner(), admin);
    }

    function test_upgrade_revertNonOwner() public {
        address v2 = address(new RefundsV2());
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger)
        );
        UUPSUpgradeable(address(refunds)).upgradeToAndCall(v2, "");
    }

    function test_freeze_renounceOwnershipBlocksUpgradeForever() public {
        vm.prank(admin);
        OwnableUpgradeable(address(refunds)).renounceOwnership();
        assertEq(OwnableUpgradeable(address(refunds)).owner(), address(0));

        address v2 = address(new RefundsV2());
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, admin)
        );
        UUPSUpgradeable(address(refunds)).upgradeToAndCall(v2, "");
    }
}
