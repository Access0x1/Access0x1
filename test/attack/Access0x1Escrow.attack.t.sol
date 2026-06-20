// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Escrow } from "../../src/Access0x1Escrow.sol";
import { IAccess0x1Escrow } from "../../src/interfaces/IAccess0x1Escrow.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { BlocklistToken } from "../mocks/BlocklistToken.sol";
import { RevertingReceiver } from "../mocks/RevertingReceiver.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A native recipient that re-enters one of the escrow's value paths on receiving ETH. Armed
///         externally so the funding leg behaves normally; on the push it fires ONE re-entrant call into
///         the configured selector and swallows the revert, so the legitimate (queued) path still
///         completes and the test can assert the guard held. Proves `nonReentrant` + CEI defeat a
///         re-entrant resolution / withdraw across every native push the contract makes.
contract ReentrantEscrowReceiver {
    Access0x1Escrow public immutable escrow;
    uint256 public reentryId; // the escrow id to re-enter against (for the withdraw probes)
    bytes4 public selector; // which fn to re-enter: confirm / cancel / withdraw / withdrawTo
    bool public armed; // a re-entry is armed for the next inbound push
    bool public bounceOnReenter; // true ⇒ revert receive() after a blocked re-entry (forces queueing)
    bool public rejecting; // true ⇒ revert every push outright (used to force the initial queue)

    constructor(Access0x1Escrow escrow_) {
        escrow = escrow_;
    }

    /// @notice Reject (or accept) every inbound native push outright — used to force a release/refund net
    ///         to QUEUE first, before a withdraw re-entry is armed against the parked credit.
    function setRejecting(bool on) external {
        rejecting = on;
    }

    /// @notice Arm a single re-entry on the next inbound push. `bounce` controls whether a (correctly)
    ///         blocked inner call then reverts THIS `receive()`: set true on the release/refund probes (so
    ///         the never-blockable push queues), false on the withdraw probes (so the legitimate outer
    ///         payout still lands). Arming clears `rejecting` so the armed push is accepted.
    function arm(bytes4 selector_, uint256 reentryId_, bool bounce) external {
        selector = selector_;
        reentryId = reentryId_;
        bounceOnReenter = bounce;
        armed = true;
        rejecting = false;
    }

    /// @dev On the inbound native push, fire ONE re-entrant call into the armed selector. A correct
    ///      `nonReentrant` + CEI MUST make that inner call revert — we catch it. If the guard were ABSENT
    ///      the inner call would SUCCEED (a real double-settle / drain); we let that ride so the test's
    ///      post-state assertions expose it.
    receive() external payable {
        if (rejecting) revert("ReentrantEscrowReceiver: rejecting");
        if (!armed) return;
        armed = false; // one-shot
        bytes4 s = selector;
        bool innerReverted;
        if (s == Access0x1Escrow.confirm.selector) {
            try escrow.confirm(reentryId) { }
            catch {
                innerReverted = true;
            }
        } else if (s == Access0x1Escrow.cancel.selector) {
            try escrow.cancel(reentryId) { }
            catch {
                innerReverted = true;
            }
        } else if (s == Access0x1Escrow.withdraw.selector) {
            try escrow.withdraw(address(0)) { }
            catch {
                innerReverted = true;
            }
        } else if (s == Access0x1Escrow.withdrawTo.selector) {
            try escrow.withdrawTo(address(0), address(this)) { }
            catch {
                innerReverted = true;
            }
        }
        // Re-entry was correctly blocked. On the release/refund probes, bounce the push so the credit
        // queues (the clean proof state); on the withdraw probes, return normally so the legit outer
        // payout still lands (the re-entry having been a harmless no-op).
        if (innerReverted && bounceOnReenter) revert("ReentrantEscrowReceiver: blocked");
    }

    /// @notice Pull a queued native credit for this contract.
    function pullWithdraw() external {
        escrow.withdraw(address(0));
    }

    /// @notice Redirect this contract's own queued native credit to `to`.
    function pullWithdrawTo(address to) external {
        escrow.withdrawTo(address(0), to);
    }
}

/// @notice A 6-decimal ERC-20 that takes NO fee at deposit time (so `open`'s exact-pull check passes)
///         but, once `armed`, skims 1% on every subsequent transfer — modelling a token that turns
///         fee-on-transfer ON only after the deposit is held. The escrow must NOT be tricked into a
///         conservation break: the queued/withdraw paths move exactly what is credited, and the dust the
///         token itself eats is the token's behaviour, never value the escrow created or double-paid.
contract LateFeeToken is ERC20 {
    bool public armed;

    constructor() ERC20("Late Fee USDC", "lfUSDC") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(bool on) external {
        armed = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (armed && from != address(0) && to != address(0)) {
            uint256 fee = value / 100; // 1% skim, only once armed
            super._update(from, to, value - fee);
            if (fee > 0) super._update(from, address(0xdead), fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @notice Adversarial suite for the ONE fund-custody escrow contract — exploit attempts, not happy-path
///         coverage. A green run proves: (1) `nonReentrant` + CEI defeat re-entry on every value path
///         (withdraw / withdrawTo / release / refund); (2) a signed release cannot be replayed across
///         ids or after a terminal state; (3) no caller can drain another escrow's funds or another
///         party's queued credit (the {withdrawTo} redirect is strictly `msg.sender`-scoped); and (4) a
///         token that turns fee-on-transfer on AFTER the deposit cannot break conservation. Deploys both
///         contracts behind their UUPS proxies, the production shape.
contract Access0x1EscrowAttackTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    Access0x1Escrow internal escrow;

    address internal owner = makeAddr("owner"); // router admin
    address internal admin = makeAddr("admin"); // escrow upgrade admin
    address internal treasury = makeAddr("treasury");
    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%

    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient");
    uint16 internal constant MERCHANT_FEE_BPS = 50;
    bytes32 internal constant NAME_HASH = keccak256("acme");

    MockV3Aggregator internal usdcFeed;
    MockUSDC internal usdc; // 6 dp

    address internal seller = makeAddr("seller");
    address internal arbiter = makeAddr("arbiter");
    address internal attacker = makeAddr("attacker");
    address internal relayer = makeAddr("relayer");
    address internal safeAddr = makeAddr("safeAddr"); // a clean redirect destination

    address internal buyer;
    uint256 internal buyerPk;

    uint256 internal merchantId;
    uint256 internal constant AMOUNT = 100e6; // 100 USDC
    uint256 internal constant NATIVE_AMOUNT = 1 ether;
    uint64 internal deadline;

    function setUp() public {
        vm.warp(1_700_000_000);
        (buyer, buyerPk) = makeAddrAndKey("buyer");
        deadline = uint64(block.timestamp + 7 days);

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (owner, treasury, PLATFORM_FEE_BPS))
            )
        );
        address escrowImpl = address(new Access0x1Escrow());
        escrow = Access0x1Escrow(
            deployProxy(escrowImpl, abi.encodeCall(Access0x1Escrow.initialize, (admin, router)))
        );

        usdcFeed = new MockV3Aggregator(8, 1e8);
        usdc = new MockUSDC();
        vm.startPrank(owner);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);
    }

    /// @dev The platform-only split the escrow mirrors from the router.
    function _split(uint256 amount) internal pure returns (uint256 fee, uint256 net) {
        fee = amount * PLATFORM_FEE_BPS / 10_000;
        net = amount - fee;
    }

    /// @dev Open a funded USDC escrow as `buyer_` (helper for the cross-escrow tests).
    function _openTokenAs(address buyer_, address seller_, address arbiter_)
        internal
        returns (uint256 id)
    {
        usdc.mint(buyer_, AMOUNT);
        vm.startPrank(buyer_);
        usdc.approve(address(escrow), AMOUNT);
        id = escrow.open(seller_, merchantId, address(usdc), AMOUNT, arbiter_, deadline);
        vm.stopPrank();
    }

    /// @dev Sign the EIP-712 release authorization for `id` with `pk`.
    function _signRelease(uint256 pk, uint256 id) internal view returns (bytes memory) {
        bytes32 digest = escrow.releaseDigest(id);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /*//////////////////////////////////////////////////////////////
                       REENTRANCY — RELEASE / REFUND
    //////////////////////////////////////////////////////////////*/

    /// @notice ATTACK: a malicious seller re-enters {confirm} on the SAME id while receiving its net.
    ///         The escrow is already RELEASED (CEI flips state before the push), so the inner call
    ///         reverts {NotOpen}; the outer never-blockable push catches the revert and queues the net.
    ///         The escrow settles exactly once — no double-release, no second net created.
    function test_attack_reentrantConfirmSameIdSettlesOnce() public {
        ReentrantEscrowReceiver evil = new ReentrantEscrowReceiver(escrow);
        vm.deal(buyer, NATIVE_AMOUNT);
        vm.prank(buyer);
        uint256 id = escrow.open{ value: NATIVE_AMOUNT }(
            address(evil), merchantId, address(0), NATIVE_AMOUNT, arbiter, deadline
        );
        (uint256 fee, uint256 net) = _split(NATIVE_AMOUNT);

        evil.arm(Access0x1Escrow.confirm.selector, id, true); // re-enter confirm(id) on receiving net
        vm.prank(buyer);
        escrow.confirm(id);

        // Settled once: state terminal, fee → treasury, net queued for the reverting seller.
        assertEq(uint8(escrow.escrowOf(id).state), uint8(IAccess0x1Escrow.EscrowState.RELEASED));
        assertEq(treasury.balance, fee);
        assertEq(escrow.withdrawable(address(evil), address(0)), net);
        // Exactly the queued net remains on-contract — nothing extra was minted by the re-entry.
        assertEq(address(escrow).balance, net);
    }

    /// @notice ATTACK: a malicious buyer re-enters {cancel} on the SAME id while receiving its refund.
    ///         CEI flips to REFUNDED before the push, so the inner cancel reverts {NotOpen}; the outer
    ///         push queues the refund. The deposit is returned exactly once.
    function test_attack_reentrantCancelSameIdRefundsOnce() public {
        ReentrantEscrowReceiver evil = new ReentrantEscrowReceiver(escrow);
        vm.deal(address(evil), NATIVE_AMOUNT);
        vm.prank(address(evil));
        uint256 id = escrow.open{ value: NATIVE_AMOUNT }(
            seller, merchantId, address(0), NATIVE_AMOUNT, arbiter, deadline
        );

        evil.arm(Access0x1Escrow.cancel.selector, id, true); // re-enter cancel(id) on receiving refund
        vm.prank(seller);
        escrow.cancel(id);

        assertEq(uint8(escrow.escrowOf(id).state), uint8(IAccess0x1Escrow.EscrowState.REFUNDED));
        // The full deposit was queued back to the buyer exactly once; nothing extra created.
        assertEq(escrow.withdrawable(address(evil), address(0)), NATIVE_AMOUNT);
        assertEq(address(escrow).balance, NATIVE_AMOUNT);
    }

    /*//////////////////////////////////////////////////////////////
                       REENTRANCY — WITHDRAW / WITHDRAWTO
    //////////////////////////////////////////////////////////////*/

    /// @notice ATTACK: a claimant re-enters {withdraw} during its own native payout. CEI zeroes the
    ///         credit BEFORE the send and `nonReentrant` blocks the inner call, so the re-entry finds
    ///         nothing owed — the claimant is paid exactly once, never twice.
    function test_attack_reentrantWithdrawPaysOnce() public {
        // Queue a native credit for `evil` by releasing an escrow whose seller is evil (it reverts on
        // the direct push, so the net queues), then disarm so the legit withdraw can land.
        ReentrantEscrowReceiver evil = new ReentrantEscrowReceiver(escrow);
        evil.setRejecting(true); // reject the direct net push so it queues first
        vm.deal(buyer, NATIVE_AMOUNT);
        vm.prank(buyer);
        uint256 id = escrow.open{ value: NATIVE_AMOUNT }(
            address(evil), merchantId, address(0), NATIVE_AMOUNT, arbiter, deadline
        );
        (, uint256 net) = _split(NATIVE_AMOUNT);
        vm.prank(buyer);
        escrow.confirm(id); // direct net push to evil reverts (rejecting) → queued
        assertEq(escrow.withdrawable(address(evil), address(0)), net);

        // arm() clears `rejecting` so the withdraw payout lands; re-enter withdraw() on that payout.
        evil.arm(Access0x1Escrow.withdraw.selector, id, false);
        evil.pullWithdraw();

        // Paid exactly once: the credit is consumed and no extra value was siphoned.
        assertEq(escrow.withdrawable(address(evil), address(0)), 0);
        assertEq(address(evil).balance, net);
        assertEq(address(escrow).balance, 0);
    }

    /// @notice ATTACK: a claimant re-enters {withdrawTo} during its own native redirect. The credit is
    ///         zeroed before the send and the guard blocks the inner call, so the re-entry is a no-op —
    ///         the balance is redirected exactly once, never drained twice.
    function test_attack_reentrantWithdrawToPaysOnce() public {
        ReentrantEscrowReceiver evil = new ReentrantEscrowReceiver(escrow);
        evil.setRejecting(true); // reject the direct net push so it queues first
        vm.deal(buyer, NATIVE_AMOUNT);
        vm.prank(buyer);
        uint256 id = escrow.open{ value: NATIVE_AMOUNT }(
            address(evil), merchantId, address(0), NATIVE_AMOUNT, arbiter, deadline
        );
        (, uint256 net) = _split(NATIVE_AMOUNT);
        vm.prank(buyer);
        escrow.confirm(id); // net queues for evil
        assertEq(escrow.withdrawable(address(evil), address(0)), net);

        // evil redirects to ITSELF and re-enters withdrawTo on the inbound push (arm clears `rejecting`).
        evil.arm(Access0x1Escrow.withdrawTo.selector, id, false);
        evil.pullWithdrawTo(address(evil));

        assertEq(escrow.withdrawable(address(evil), address(0)), 0);
        assertEq(address(evil).balance, net);
        assertEq(address(escrow).balance, 0);
    }

    /*//////////////////////////////////////////////////////////////
                       SIGNED-RELEASE REPLAY
    //////////////////////////////////////////////////////////////*/

    /// @notice ATTACK: replay a buyer's signed release onto a DIFFERENT id. The digest binds the id, so
    ///         the signature for id1 fails the signer check on id2 — no cross-id replay.
    function test_attack_signedReleaseCannotReplayAcrossIds() public {
        uint256 id1 = _openTokenAs(buyer, seller, arbiter);
        uint256 id2 = _openTokenAs(buyer, seller, arbiter);
        bytes memory sigFor1 = _signRelease(buyerPk, id1);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1Escrow.Access0x1Escrow__BadSignature.selector, id2)
        );
        escrow.releaseWithSig(id2, sigFor1);

        assertTrue(escrow.isOpen(id2)); // id2 untouched
    }

    /// @notice ATTACK: replay a buyer's signed release onto the SAME id after it already settled. The
    ///         terminal RELEASED state stops the second submission at the open-guard — settles once.
    function test_attack_signedReleaseCannotReplayAfterTerminal() public {
        uint256 id = _openTokenAs(buyer, seller, arbiter);
        bytes memory sig = _signRelease(buyerPk, id);

        vm.prank(relayer);
        escrow.releaseWithSig(id, sig);
        (uint256 fee, uint256 net) = _split(AMOUNT);
        assertEq(usdc.balanceOf(seller), net);
        assertEq(usdc.balanceOf(treasury), fee);

        // A second submission of the same authorization reverts: the escrow is terminal.
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__NotOpen.selector,
                id,
                IAccess0x1Escrow.EscrowState.RELEASED
            )
        );
        escrow.releaseWithSig(id, sig);

        // The seller/treasury were paid exactly once.
        assertEq(usdc.balanceOf(seller), net);
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    /// @notice ATTACK: replay a signed release after the escrow was REFUNDED. The terminal state stops
    ///         it — a settled-out escrow cannot be re-resolved by an old authorization.
    function test_attack_signedReleaseCannotReleaseRefundedEscrow() public {
        uint256 id = _openTokenAs(buyer, seller, arbiter);
        bytes memory sig = _signRelease(buyerPk, id);

        vm.prank(seller);
        escrow.cancel(id); // refund first
        assertEq(usdc.balanceOf(buyer), AMOUNT);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__NotOpen.selector,
                id,
                IAccess0x1Escrow.EscrowState.REFUNDED
            )
        );
        escrow.releaseWithSig(id, sig);

        // No second movement of funds: the buyer keeps the full refund, the seller got nothing.
        assertEq(usdc.balanceOf(buyer), AMOUNT);
        assertEq(usdc.balanceOf(seller), 0);
    }

    /*//////////////////////////////////////////////////////////////
                       CROSS-ESCROW / CROSS-PARTY DRAIN
    //////////////////////////////////////////////////////////////*/

    /// @notice ATTACK: an attacker tries to drain a SECOND, unrelated escrow's held funds through the
    ///         resolution surface — confirm / cancel / arbitrate / releaseWithSig. Each is gated to the
    ///         escrow's own buyer / seller / arbiter / buyer-signature, so the attacker is rejected on
    ///         every path and the victim escrow stays fully OPEN and funded.
    function test_attack_cannotDrainAnotherEscrow() public {
        // A victim escrow funded by an honest buyer; the attacker holds an unrelated escrow.
        address victimBuyer = makeAddr("victimBuyer");
        address victimSeller = makeAddr("victimSeller");
        address victimArbiter = makeAddr("victimArbiter");
        uint256 victimId = _openTokenAs(victimBuyer, victimSeller, victimArbiter);
        _openTokenAs(attacker, seller, arbiter); // the attacker's own escrow (id 2), unused here

        bytes memory forgedSig = _signRelease(buyerPk, victimId); // not the victim's buyer key

        vm.startPrank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__NotAuthorized.selector, victimId, attacker
            )
        );
        escrow.confirm(victimId); // attacker is not the victim's buyer
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__NotAuthorized.selector, victimId, attacker
            )
        );
        escrow.cancel(victimId); // attacker is not the victim's seller
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__NotAuthorized.selector, victimId, attacker
            )
        );
        escrow.arbitrate(victimId, true); // attacker is not the victim's arbiter
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__BadSignature.selector, victimId
            )
        );
        escrow.releaseWithSig(victimId, forgedSig); // signer != victim's buyer
        vm.stopPrank();

        // The victim escrow is untouched: still OPEN, still fully funded.
        assertTrue(escrow.isOpen(victimId));
        assertEq(uint8(escrow.escrowOf(victimId).state), uint8(IAccess0x1Escrow.EscrowState.OPEN));
        assertEq(usdc.balanceOf(victimSeller), 0);
        assertEq(usdc.balanceOf(victimBuyer), 0);
    }

    /// @notice ATTACK: an attacker tries to redirect ANOTHER party's queued credit via {withdrawTo}.
    ///         The function only ever reads/zeroes `_withdrawable[msg.sender][asset]`, so the attacker —
    ///         who is owed nothing — reverts {NothingToWithdraw}; the real claimant's credit is intact.
    function test_attack_withdrawToCannotMoveAnotherPartysCredit() public {
        // Queue a token credit for the seller via a blocklisted-seller release.
        BlocklistToken bt = new BlocklistToken();
        vm.startPrank(owner);
        router.setTokenAllowed(address(bt), true);
        router.setPriceFeed(address(bt), address(usdcFeed));
        vm.stopPrank();
        bt.mint(buyer, AMOUNT);
        vm.startPrank(buyer);
        bt.approve(address(escrow), AMOUNT);
        uint256 id = escrow.open(seller, merchantId, address(bt), AMOUNT, arbiter, deadline);
        vm.stopPrank();

        bt.setBlocked(seller, true);
        (, uint256 net) = _split(AMOUNT);
        vm.prank(buyer);
        escrow.confirm(id); // net queues for the blocked seller
        assertEq(escrow.withdrawable(seller, address(bt)), net);

        // The attacker is owed nothing in this asset → cannot pull the seller's credit to itself.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__NothingToWithdraw.selector, address(bt)
            )
        );
        escrow.withdrawTo(address(bt), attacker);

        // The seller's credit is fully intact and still only the seller's to move.
        assertEq(escrow.withdrawable(seller, address(bt)), net);
        assertEq(bt.balanceOf(attacker), 0);
    }

    /// @notice The legit anti-strand path: a seller whose own address can never receive (blocklisted)
    ///         redirects THEIR OWN queued credit to a clean address via {withdrawTo}. This is exactly the
    ///         HIGH the fix closes — without it, the credit is permanently strandable.
    function test_attack_withdrawToRescuesStrandedCredit() public {
        BlocklistToken bt = new BlocklistToken();
        vm.startPrank(owner);
        router.setTokenAllowed(address(bt), true);
        router.setPriceFeed(address(bt), address(usdcFeed));
        vm.stopPrank();
        bt.mint(buyer, AMOUNT);
        vm.startPrank(buyer);
        bt.approve(address(escrow), AMOUNT);
        uint256 id = escrow.open(seller, merchantId, address(bt), AMOUNT, arbiter, deadline);
        vm.stopPrank();

        bt.setBlocked(seller, true); // the seller can NEVER receive this token
        (, uint256 net) = _split(AMOUNT);
        vm.prank(buyer);
        escrow.confirm(id);
        assertEq(escrow.withdrawable(seller, address(bt)), net);

        // The seller redirects their own credit to a receivable address — the credit is rescued, not lost.
        vm.expectEmit(true, true, true, true, address(escrow));
        emit IAccess0x1Escrow.WithdrawnTo(seller, safeAddr, address(bt), net);
        vm.prank(seller);
        escrow.withdrawTo(address(bt), safeAddr);

        assertEq(bt.balanceOf(safeAddr), net);
        assertEq(escrow.withdrawable(seller, address(bt)), 0);
        assertEq(bt.balanceOf(address(escrow)), 0);
    }

    /// @notice The native strand-rescue: a seller contract that permanently rejects ETH would see
    ///         {withdraw} revert forever; {withdrawTo} sends the parked native credit to a receivable
    ///         address instead. (The HIGH the fix closes, on the native leg.)
    function test_attack_withdrawToRescuesStrandedNativeCredit() public {
        RevertingReceiver badSeller = new RevertingReceiver(); // can never receive ETH directly
        vm.deal(buyer, NATIVE_AMOUNT);
        vm.prank(buyer);
        uint256 id = escrow.open{ value: NATIVE_AMOUNT }(
            address(badSeller), merchantId, address(0), NATIVE_AMOUNT, arbiter, deadline
        );
        (, uint256 net) = _split(NATIVE_AMOUNT);
        vm.prank(buyer);
        escrow.confirm(id); // net push to badSeller reverts → queues
        assertEq(escrow.withdrawable(address(badSeller), address(0)), net);

        // The credited party (the badSeller contract) redirects its OWN native credit to a clean EOA.
        vm.prank(address(badSeller));
        escrow.withdrawTo(address(0), safeAddr);

        assertEq(safeAddr.balance, net);
        assertEq(escrow.withdrawable(address(badSeller), address(0)), 0);
        assertEq(address(escrow).balance, 0);
    }

    /// @notice ATTACK: {withdrawTo} to a still-reverting native address must revert WHOLE and restore the
    ///         credit — the claimant can never zero their balance without `to` actually receiving.
    function test_attack_withdrawToRevertsAndRestoresOnBadDestination() public {
        RevertingReceiver badSeller = new RevertingReceiver();
        RevertingReceiver badDest = new RevertingReceiver(); // the chosen destination also reverts
        vm.deal(buyer, NATIVE_AMOUNT);
        vm.prank(buyer);
        uint256 id = escrow.open{ value: NATIVE_AMOUNT }(
            address(badSeller), merchantId, address(0), NATIVE_AMOUNT, arbiter, deadline
        );
        (, uint256 net) = _split(NATIVE_AMOUNT);
        vm.prank(buyer);
        escrow.confirm(id);

        vm.prank(address(badSeller));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__WithdrawToFailed.selector, address(badDest), net
            )
        );
        escrow.withdrawTo(address(0), address(badDest));

        // The credit survives the revert — still claimable to a receivable address.
        assertEq(escrow.withdrawable(address(badSeller), address(0)), net);
        assertEq(address(escrow).balance, net);
    }

    /// @notice ATTACK: {withdrawTo} rejects a zero destination (a footgun that would burn the credit).
    function test_attack_withdrawToRejectsZeroDestination() public {
        RevertingReceiver badSeller = new RevertingReceiver();
        vm.deal(buyer, NATIVE_AMOUNT);
        vm.prank(buyer);
        uint256 id = escrow.open{ value: NATIVE_AMOUNT }(
            address(badSeller), merchantId, address(0), NATIVE_AMOUNT, arbiter, deadline
        );
        vm.prank(buyer);
        escrow.confirm(id);

        vm.prank(address(badSeller));
        vm.expectRevert(IAccess0x1Escrow.Access0x1Escrow__ZeroAddress.selector);
        escrow.withdrawTo(address(0), address(0));
    }

    /*//////////////////////////////////////////////////////////////
                       FEE-ON-TRANSFER-AFTER-DEPOSIT DUST
    //////////////////////////////////////////////////////////////*/

    /// @notice ATTACK: a token deposits cleanly (no skim, so `open` passes) but turns fee-on-transfer ON
    ///         after the deposit is held. On release the token eats 1% dust on EACH outbound leg — but
    ///         the escrow never created or double-paid value: the seller + treasury + the token's own
    ///         dust-sink together account for exactly the held amount, and zero is left on-contract. The
    ///         late skim is the token's behaviour, never a conservation break in the escrow.
    function test_attack_lateFeeOnTransferDoesNotBreakConservation() public {
        LateFeeToken lft = new LateFeeToken();
        vm.startPrank(owner);
        router.setTokenAllowed(address(lft), true);
        router.setPriceFeed(address(lft), address(usdcFeed));
        vm.stopPrank();

        lft.mint(buyer, AMOUNT);
        vm.startPrank(buyer);
        lft.approve(address(escrow), AMOUNT);
        // Deposit is clean (token not yet armed) — open's exact-pull check passes.
        uint256 id = escrow.open(seller, merchantId, address(lft), AMOUNT, arbiter, deadline);
        vm.stopPrank();
        assertEq(lft.balanceOf(address(escrow)), AMOUNT);

        lft.arm(true); // NOW the token skims 1% on every transfer
        (uint256 fee, uint256 net) = _split(AMOUNT);
        vm.prank(buyer);
        escrow.confirm(id);

        // The escrow held exactly AMOUNT and pushed `fee` + `net` out; the token skimmed each leg. The
        // recipients + the token's dust-sink together equal the held amount — nothing created/lost by us.
        uint256 dustSink = lft.balanceOf(address(0xdead));
        assertEq(
            lft.balanceOf(seller) + lft.balanceOf(treasury) + dustSink, fee + net, "conservation"
        );
        assertEq(fee + net, AMOUNT);
        // Zero custody: the escrow holds none of this asset after the release.
        assertEq(lft.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.escrowOf(id).state), uint8(IAccess0x1Escrow.EscrowState.RELEASED));
    }
}
