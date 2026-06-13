// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Access0x1Bookings } from "../../src/Access0x1Bookings.sol";
import { IAccess0x1Bookings } from "../../src/interfaces/IAccess0x1Bookings.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";

/// @notice An ERC-20 with caller-set decimals, so the quote round-trip can be stressed across the
///         full Arc/USDC decimal range (0..27) and a wide price range — proving the USD→token→USD
///         inversion + escrow clamp can never over-pull or strand value at any decimal/price combo.
contract DecToken is ERC20 {
    uint8 private immutable d;

    constructor(uint8 d_) ERC20("Dec", "DEC") {
        d = d_;
    }

    function decimals() public view override returns (uint8) {
        return d;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @notice A 6-dp ERC-20 that re-enters {Access0x1Bookings} on its refund/transfer push. The
///         contract-wide `nonReentrant` guard must defeat the re-entry; either way the payer can
///         never extract more than the held escrow.
contract ReenterBookings is ERC20 {
    Access0x1Bookings public b;
    bool public armed;
    uint256 public targetId;

    constructor() ERC20("Reenter", "RE") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function setB(Access0x1Bookings b_) external {
        b = b_;
    }

    function arm(bool on, uint256 id) external {
        armed = on;
        targetId = id;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (armed && address(b) != address(0)) {
            armed = false; // one-shot
            // Re-enter a value-moving path mid-push; the guard must block it.
            try b.claimRefund(address(this)) { } catch { }
            try b.expireHold(targetId) { } catch { }
        }
        super._update(from, to, value);
    }
}

/// @notice OPUS red-team — the deposit-escrow round-trip math (USD→token at reserve, token→USD→token
///         at resolution, escrow clamp) and the reentrancy/conservation guarantees, fuzzed across the
///         decimal/price space the Router can price. Every property is checked against the escrow that
///         was actually held, never the contract's own bookkeeping.
contract Access0x1BookingsRoundTripAttackTest is Test {
    Access0x1Bookings internal bookings;
    Access0x1Router internal router;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal mo = makeAddr("mo");
    address internal payout = makeAddr("payout");
    address internal fr = makeAddr("fr");
    address internal payer = makeAddr("payer");
    uint256 internal mid;
    bytes32 internal constant SLOT = keccak256("s");

    function setUp() public {
        vm.warp(1_700_000_000);
        router = new Access0x1Router(admin, treasury, 100); // 1%
        bookings = new Access0x1Bookings(admin, address(router), address(0));
        vm.prank(mo);
        mid = router.registerMerchant(payout, fr, 50, keccak256("m")); // 0.5%
    }

    function _allow(address tok, MockV3Aggregator feed) internal {
        vm.startPrank(admin);
        router.setTokenAllowed(tok, true);
        router.setPriceFeed(tok, address(feed));
        vm.stopPrank();
    }

    function _policy() internal pure returns (IAccess0x1Bookings.Policy memory) {
        return IAccess0x1Bookings.Policy({
            cancelWindowSecs: 2 hours, lateFeeUsd8: 10e8, noShowFeeUsd8: 20e8
        });
    }

    /// @notice ATTACK: drive the complete-release round-trip across the whole decimal/price space and
    ///         an adversarial price drift between reserve and complete. The routed amount must never
    ///         exceed the held escrow (no over-pull into another reservation's backing), complete must
    ///         never revert (no DoS on the deposit), and the contract must hold exactly zero of this
    ///         reservation's token afterward (exact conservation — no stranded dust).
    function testFuzz_completeRoundTripNeverOverPulls(
        uint8 dec,
        uint256 priceSeed,
        uint256 depSeed,
        uint256 newPriceSeed
    ) public {
        dec = uint8(bound(dec, 0, 27));
        int256 price = int256(bound(priceSeed, 1, 1e15));
        uint256 dep = bound(depSeed, 1e8, 1_000_000e8); // $1 .. $1M

        MockV3Aggregator feed = new MockV3Aggregator(8, price);
        DecToken tok = new DecToken(dec);
        _allow(address(tok), feed);
        tok.mint(payer, type(uint128).max);
        vm.prank(payer);
        tok.approve(address(bookings), type(uint256).max);

        // Skip decimal/price combos a real chain would never produce (quote overflows / dust escrow).
        uint256 escrow;
        try router.quote(mid, address(tok), dep) returns (uint256 q) {
            escrow = q;
        } catch {
            return;
        }
        if (escrow == 0 || escrow > type(uint112).max) return;

        vm.prank(payer);
        uint256 id = bookings.reserve(
            mid,
            SLOT,
            uint64(block.timestamp + 1 days),
            address(tok),
            dep,
            0,
            _policy(),
            1 days,
            keccak256("n")
        );
        vm.prank(mo);
        bookings.confirm(id);

        feed.updateAnswer(int256(bound(newPriceSeed, 1, 1e15))); // adversarial drift before settle

        uint256 contractBefore = tok.balanceOf(address(bookings));
        uint256 payoutBefore = tok.balanceOf(payout);
        uint256 treasuryBefore = tok.balanceOf(treasury);
        uint256 frBefore = tok.balanceOf(fr);

        vm.prank(mo);
        bookings.complete(id); // MUST NOT revert at any decimal/price

        uint256 routed = (tok.balanceOf(payout) - payoutBefore)
            + (tok.balanceOf(treasury) - treasuryBefore) + (tok.balanceOf(fr) - frBefore);
        assertLe(routed, escrow, "routed exceeds held escrow (over-pull)");
        assertEq(bookings.escrowedOf(address(tok)), 0, "escrow ledger not zero");
        assertEq(tok.balanceOf(address(bookings)), contractBefore - escrow, "balance leak/strand");
    }

    /// @notice ATTACK: the no-show fee inversion must be EXACTLY conservative — operator take + payer
    ///         refund == the full escrow, with the fee never exceeding the quoted target, across the
    ///         decimal/price space (the quote-inversion remainder is refunded, never stranded).
    function testFuzz_noShowConservesEscrowExactly(uint8 dec, uint256 priceSeed, uint256 feeSeed)
        public
    {
        dec = uint8(bound(dec, 2, 18));
        int256 price = int256(bound(priceSeed, 1e6, 1e12));
        uint256 feeUsd = bound(feeSeed, 1e8, 100e8); // $1 .. $100 no-show fee

        MockV3Aggregator feed = new MockV3Aggregator(8, price);
        DecToken tok = new DecToken(dec);
        _allow(address(tok), feed);
        tok.mint(payer, type(uint128).max);
        vm.prank(payer);
        tok.approve(address(bookings), type(uint256).max);

        uint256 dep = 100_000e8; // large enough the fee never clamps to escrow
        uint256 escrow;
        try router.quote(mid, address(tok), dep) returns (uint256 q) {
            escrow = q;
        } catch {
            return;
        }
        if (escrow == 0 || escrow > type(uint120).max) return;

        IAccess0x1Bookings.Policy memory p = IAccess0x1Bookings.Policy({
            cancelWindowSecs: 2 hours, lateFeeUsd8: feeUsd, noShowFeeUsd8: feeUsd
        });
        vm.prank(payer);
        uint256 id = bookings.reserve(
            mid,
            SLOT,
            uint64(block.timestamp + 1 days),
            address(tok),
            dep,
            0,
            p,
            1 days,
            keccak256("n")
        );
        vm.prank(mo);
        bookings.confirm(id);

        uint256 feeTarget = router.quote(mid, address(tok), feeUsd); // the gross the operator should get
        uint256 payoutBefore = tok.balanceOf(payout);
        uint256 treasuryBefore = tok.balanceOf(treasury);
        uint256 frBefore = tok.balanceOf(fr);
        uint256 payerBefore = tok.balanceOf(payer);

        vm.prank(mo);
        bookings.markNoShow(id);

        uint256 routed = (tok.balanceOf(payout) - payoutBefore)
            + (tok.balanceOf(treasury) - treasuryBefore) + (tok.balanceOf(fr) - frBefore);
        uint256 refunded = tok.balanceOf(payer) - payerBefore;

        assertEq(routed + refunded, escrow, "escrow not fully conserved");
        assertLe(routed, feeTarget, "operator routed more than the fee target");
        assertEq(tok.balanceOf(address(bookings)), 0, "dust stranded on contract");
        assertEq(bookings.escrowedOf(address(tok)), 0);
    }

    /// @notice ATTACK: settling reservation A must never dip into reservation B's escrow backing. A
    ///         spiked price makes A's release tiny (most of A's escrow refunds), but B's ledger entry
    ///         and on-contract backing must be untouched.
    function test_attack_settlingAdoesNotTouchBescrow() public {
        MockV3Aggregator feed = new MockV3Aggregator(8, 1e8);
        DecToken tok = new DecToken(6);
        _allow(address(tok), feed);
        tok.mint(payer, type(uint128).max);
        vm.prank(payer);
        tok.approve(address(bookings), type(uint256).max);

        vm.prank(payer);
        uint256 a = bookings.reserve(
            mid,
            keccak256("A"),
            uint64(block.timestamp + 1 days),
            address(tok),
            50e8,
            0,
            _policy(),
            1 days,
            keccak256("nA")
        );
        vm.prank(payer);
        uint256 b = bookings.reserve(
            mid,
            keccak256("B"),
            uint64(block.timestamp + 1 days),
            address(tok),
            70e8,
            0,
            _policy(),
            1 days,
            keccak256("nB")
        );
        uint256 escrowB = bookings.reservationOf(b).escrowAmount;

        vm.prank(mo);
        bookings.confirm(a);
        feed.updateAnswer(1000e8); // A's $50 release now needs ~1/1000 the token; the rest refunds
        vm.prank(mo);
        bookings.complete(a);

        assertEq(bookings.escrowedOf(address(tok)), escrowB, "B escrow ledger corrupted");
        assertGe(tok.balanceOf(address(bookings)), escrowB, "B backing was dipped into");
    }

    /// @notice ATTACK: a token that re-enters on the refund push during {expireHold}. The contract-wide
    ///         `nonReentrant` guard must block the re-entry; the payer can never receive (directly +
    ///         queued) more than the held escrow.
    function test_attack_reentrantRefundPushCannotOverRefund() public {
        MockV3Aggregator feed = new MockV3Aggregator(8, 1e8);
        ReenterBookings re = new ReenterBookings();
        re.setB(bookings);
        _allow(address(re), feed);
        re.mint(payer, 1_000_000e6);
        vm.prank(payer);
        re.approve(address(bookings), type(uint256).max);

        vm.prank(payer);
        uint256 id = bookings.reserve(
            mid,
            SLOT,
            uint64(block.timestamp + 1 days),
            address(re),
            50e8,
            0,
            _policy(),
            1 days,
            keccak256("n")
        );
        uint256 escrow = bookings.reservationOf(id).escrowAmount;

        vm.warp(block.timestamp + 1 days + 1);
        re.arm(true, id);
        bookings.expireHold(id); // refund push re-enters; guard must hold

        uint256 got = re.balanceOf(payer) - (1_000_000e6 - escrow);
        uint256 queued = bookings.refundRescueOf(payer, address(re));
        assertLe(got + queued, escrow, "payer over-refunded via reentrancy");
        assertEq(bookings.escrowedOf(address(re)), 0);
    }
}
