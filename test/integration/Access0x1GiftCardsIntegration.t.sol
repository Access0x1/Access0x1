// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";

import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1GiftCards } from "../../src/Access0x1GiftCards.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";
import { SessionGrant } from "../../src/SessionGrant.sol";
import { IAccess0x1GiftCards } from "../../src/interfaces/IAccess0x1GiftCards.sol";

import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @title  Access0x1GiftCardsIntegration — the prepaid ledger composed with the REAL money spine.
/// @author Access0x1
/// @notice The Cyfrin INTEGRATION layer for {Access0x1GiftCards}. The unit + fuzz suites exercise the
///         gift-card ledger in isolation; this suite proves it COMPOSES with the audited estate exactly
///         as a storefront drives a split-tender sale: a USD-priced order is part-covered by the holder's
///         prepaid card balance (a debit on this contract) and the CHARGEABLE REMAINDER is settled by the
///         buyer straight through the {Access0x1Router} (USDC pull → fee split → {PaymentLanes} receipt)
///         in the SAME tx — the contract NEVER holds a token and never re-derives the fee split.
///
///         The full lifecycle under test, on directly-deployed real contracts:
///           issue (merchant funds the card) → redeem (debit + Router-settled remainder credits a lane)
///           → NEVER NEGATIVE (an over-ask bottoms the card at zero, never below; the remainder grows but
///           the spine still settles cleanly) → reverse (the card is credited back, idempotently).
///
/// @dev    RACE-FREE BY CONSTRUCTION: this suite deploys Router + SessionGrant + PaymentLanes + GiftCards
///         DIRECTLY in `setUp` (`new ...` + owner-only wiring) and never touches process-global
///         `vm.setEnv` for deploy config — so it cannot race a parallel suite on a shared env key (the
///         hazard that broke the combined suite). The DeployAll SCRIPT path is covered separately by
///         `test/unit/DeployAll.t.sol`; here the concern is the cross-contract COMPOSITION, which a
///         deterministic direct wiring proves best. SessionGrant is deployed and wired into the estate
///         (the agent-mandate spine the production deploy stands up alongside the ledger) so the composed
///         surface mirrors the real deployment, even though the gift-card flow itself is delegate-free.
///         USD amounts are 8-decimal (`usdAmount8`, $1 == 1e8); USDC is 6-decimal.
contract Access0x1GiftCardsIntegrationTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    Access0x1GiftCards internal cards;
    PaymentLanes internal lanes;
    SessionGrant internal sessions;

    MockUSDC internal usdc;
    MockV3Aggregator internal usdcFeed;

    address internal admin = makeAddr("gci_admin");
    address internal treasury = makeAddr("gci_treasury");
    address internal merchantOwner = makeAddr("gci_merchantOwner");
    address internal payout = makeAddr("gci_payout");
    address internal feeRecipient = makeAddr("gci_feeRecipient");
    address internal buyer = makeAddr("gci_buyer");

    uint256 internal merchantId;

    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1.00% -> treasury
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.50% -> feeRecipient
    bytes32 internal constant CODE = keccak256("GIFT-INT-001");
    bytes32 internal constant NAME_HASH = keccak256("acme.access0x1.eth");
    uint256 internal constant FACE = 60e8; // $60 gift-card face (8-dec USD)

    /// @notice Stand up the WHOLE estate directly (no deploy script, no env) and wire it: Router spine
    ///         with a real USDC + Chainlink feed, the ERC-6909 PaymentLanes ledger as the settlement
    ///         sink, the SessionGrant agent spine, and the GiftCards prepaid ledger composing the Router
    ///         merchant registry. Then register a merchant and fund + approve the buyer.
    function setUp() public {
        // A stable, non-zero timestamp keeps the Chainlink feed inside the staleness window.
        vm.warp(1_700_000_000);

        // ── Real money-path assets the Router prices + settles against.
        usdc = new MockUSDC(); // 6-decimal USDC
        usdcFeed = new MockV3Aggregator(8, 1e8); // USDC/USD = $1.00, 8-decimal answer

        // ── Deploy the estate DIRECTLY (race-free: no vm.setEnv, no DeployAll.run()).
        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (admin, treasury, PLATFORM_FEE_BPS))
            )
        );
        lanes = PaymentLanes(
            deployProxy(
                address(new PaymentLanes()), abi.encodeCall(PaymentLanes.initialize, (admin))
            )
        );
        sessions = SessionGrant(
            deployProxy(
                address(new SessionGrant()),
                abi.encodeCall(SessionGrant.initialize, ("Access0x1SessionGrant", "1", admin))
            )
        );
        // GiftCards is UUPS: deploy its implementation, then the ERC1967 proxy that runs initialize.
        cards = Access0x1GiftCards(
            deployProxy(
                address(new Access0x1GiftCards()),
                abi.encodeCall(Access0x1GiftCards.initialize, (admin, router))
            )
        );

        // ── Owner-only wiring, all signed by the single admin (the in-broadcast owner of a real deploy).
        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true); // allowlist the pay-in token
        router.setPriceFeed(address(usdc), address(usdcFeed)); // wire its USD feed
        router.setPaymentLanes(address(lanes)); // route settled net into the lane ledger
        lanes.setRouter(address(router), true); // authorize the Router to credit lanes
        vm.stopPrank();

        // ── Tenant side: register a merchant (caller becomes its owner) and fund the buyer.
        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);

        usdc.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        usdc.approve(address(router), type(uint256).max);
    }

    /// @dev Issue `face` to `recipient` on the default merchant + code as the merchant owner.
    function _issue(address recipient, uint256 face) internal returns (uint256 id) {
        vm.prank(merchantOwner);
        id = cards.issueCard(merchantId, CODE, recipient, face);
    }

    /*//////////////////////////////////////////////////////////////
                  THE DIRECT WIRING IS LIVE AND COMPOSED
    //////////////////////////////////////////////////////////////*/

    /// @notice The estate is wired and composes: GiftCards reads the SAME Router for merchant auth, the
    ///         Router prices/settles the wired USDC, and settled net lands in the wired PaymentLanes.
    function test_integration_estateIsWiredAndComposed() public view {
        assertEq(address(cards.router()), address(router), "GiftCards composes the deployed Router");
        assertTrue(router.tokenAllowed(address(usdc)), "Router allowlisted the wired USDC");
        assertEq(router.paymentLanes(), address(lanes), "Router routes settlement into the lanes");
        assertTrue(lanes.isRouter(address(router)), "Lanes authorized the Router to credit");
        assertTrue(sessions.domainSeparator() != bytes32(0), "SessionGrant spine initialized");
        // The merchant the gift card draws against is the one registered on the shared Router.
        (, address mOwner,,,,) = router.merchants(merchantId);
        assertEq(mOwner, merchantOwner, "merchant owner authorizes issuance on the shared registry");
    }

    /*//////////////////////////////////////////////////////////////
        SPLIT-TENDER: ISSUE -> REDEEM (CARD) + ROUTER-SETTLED REMAINDER
    //////////////////////////////////////////////////////////////*/

    /// @notice The headline composition: a $100 order is part-covered by a $60 prepaid card (a debit on
    ///         GiftCards) and the $40 CHARGEABLE REMAINDER is settled by the buyer through the Router in
    ///         the same flow — net credits the merchant's lane, the card balance drops to zero, and the
    ///         Router holds no token (zero custody). Proves the two ledgers cooperate on one sale.
    function test_integration_issueRedeemAndRouterSettleRemainder() public {
        uint256 id = _issue(buyer, FACE); // merchant funds the buyer's card with $60

        // A $100 sale. The card covers $60; the remainder is $40 to settle through the Router.
        uint256 orderUsd8 = 100e8;

        // Redeem the card for the order amount — clamps to the $60 face, the rest is the remainder.
        bytes32 rid = keccak256("split-tender-1");
        vm.prank(buyer);
        uint256 applied = cards.redeem(id, orderUsd8, rid);
        assertEq(applied, FACE, "card applies its full $60 face against the $100 order");
        assertEq(cards.balanceOf(buyer, id), 0, "card spent to exactly zero (never negative)");

        // The chargeable remainder = order - applied = $40, priced + settled through the Router.
        uint256 remainderUsd8 = orderUsd8 - applied;
        assertEq(remainderUsd8, 40e8, "remainder is the order minus the card credit");

        uint256 gross = router.quote(merchantId, address(usdc), remainderUsd8);
        assertEq(gross, 40e6, "remainder prices $40 at $1/USDC to 40e6 (6-dec)");

        uint256 platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        uint256 merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        uint256 net = gross - platformFee - merchantFee;

        vm.prank(buyer);
        router.payToken(merchantId, address(usdc), remainderUsd8, keccak256("order-rem-1"));

        // Zero custody on the Router; the net landed in the wired lane ledger.
        assertEq(usdc.balanceOf(address(router)), 0, "Router holds no token after settlement");
        uint256 laneId = lanes.laneId(block.chainid, address(usdc), payout);
        assertEq(
            lanes.balanceOf(payout, laneId), net, "merchant lane credited with the remainder net"
        );
        assertEq(usdc.balanceOf(treasury), platformFee, "platform fee paid to treasury");
        assertEq(
            usdc.balanceOf(feeRecipient), merchantFee, "merchant surcharge paid to fee recipient"
        );
    }

    /*//////////////////////////////////////////////////////////////
                  NEVER NEGATIVE ACROSS THE COMPOSED FLOW
    //////////////////////////////////////////////////////////////*/

    /// @notice NEVER NEGATIVE end-to-end: an order LARGER than the card's whole face bottoms the card at
    ///         exactly zero (never below), and the FULL order minus the applied face is settled cleanly
    ///         through the Router — the prepaid debit and the on-chain settlement agree on the split.
    function test_integration_overOrderNeverGoesNegativeRemainderSettles() public {
        uint256 id = _issue(buyer, FACE); // $60 card

        // A $250 order dwarfs the $60 card: applied caps at $60, balance bottoms at zero.
        uint256 orderUsd8 = 250e8;
        vm.prank(buyer);
        uint256 applied = cards.redeem(id, orderUsd8, keccak256("over-order-1"));
        assertEq(applied, FACE, "applied caps at the full face, never over-spends");
        assertEq(cards.balanceOf(buyer, id), 0, "balance bottoms at zero - never negative");

        // The remainder ($190) settles through the Router; the lane is credited with its net.
        uint256 remainderUsd8 = orderUsd8 - applied;
        uint256 gross = router.quote(merchantId, address(usdc), remainderUsd8);
        uint256 net =
            gross - (gross * PLATFORM_FEE_BPS / 10_000) - (gross * MERCHANT_FEE_BPS / 10_000);

        vm.prank(buyer);
        router.payToken(merchantId, address(usdc), remainderUsd8, keccak256("order-rem-2"));

        uint256 laneId = lanes.laneId(block.chainid, address(usdc), payout);
        assertEq(lanes.balanceOf(payout, laneId), net, "remainder net settled into the lane");
        assertEq(usdc.balanceOf(address(router)), 0, "Router still holds no token (zero custody)");
    }

    /*//////////////////////////////////////////////////////////////
              REVERSAL ON THE COMPOSED LEDGER (IDEMPOTENT)
    //////////////////////////////////////////////////////////////*/

    /// @notice A cancelled order reverses the CARD leg cleanly while the Router-settled remainder leg is
    ///         a separate, already-final money path (law #5: settled money is not swallowed). The card is
    ///         credited back to its original holder exactly once, idempotently — and the lane balance
    ///         from the remainder is untouched by the card reversal (the two ledgers are independent).
    function test_integration_reverseCardLeg_isIdempotent_andLeavesSettlementIntact() public {
        uint256 id = _issue(buyer, FACE);
        uint256 orderUsd8 = 100e8;

        // Card leg: redeem $60 of the $100 order.
        bytes32 rid = keccak256("reverse-int-1");
        vm.prank(buyer);
        uint256 applied = cards.redeem(id, orderUsd8, rid);
        assertEq(cards.balanceOf(buyer, id), 0, "card spent");

        // Remainder leg: settle $40 through the Router into the lane.
        uint256 remainderUsd8 = orderUsd8 - applied;
        vm.prank(buyer);
        router.payToken(merchantId, address(usdc), remainderUsd8, keccak256("order-rem-3"));
        uint256 laneId = lanes.laneId(block.chainid, address(usdc), payout);
        uint256 settledNet = lanes.balanceOf(payout, laneId);
        assertGt(settledNet, 0, "remainder settled into the lane");

        // Cancel: the merchant owner reverses the card leg (only it may re-credit a spent balance).
        // The card is restored to its full face, once.
        vm.expectEmit(true, true, true, true, address(cards));
        emit IAccess0x1GiftCards.RedemptionReversed(id, buyer, rid, applied);
        vm.prank(merchantOwner);
        cards.reverseRedemption(rid);
        assertEq(cards.balanceOf(buyer, id), FACE, "card credited back to its full face");

        // Idempotent: extra reverses never double-credit the card.
        vm.startPrank(merchantOwner);
        cards.reverseRedemption(rid);
        cards.reverseRedemption(rid);
        vm.stopPrank();
        assertEq(
            cards.balanceOf(buyer, id), FACE, "card credited back exactly once despite retries"
        );

        // The independent settlement leg is untouched by the card reversal.
        assertEq(
            lanes.balanceOf(payout, laneId), settledNet, "settled lane survives the card reversal"
        );
        assertEq(usdc.balanceOf(address(router)), 0, "Router holds no token throughout");
    }

    /// @notice The reversed card is FULLY redeemable again on the composed ledger — a reversal relives a
    ///         spent card, and a fresh redemption against it settles exactly as the first did. Proves the
    ///         reversal is a true restore, not a cosmetic flag.
    function test_integration_reversedCardRedeemsAgain() public {
        uint256 id = _issue(buyer, FACE);

        // Spend the whole card, then reverse it back to life.
        bytes32 rid1 = keccak256("relive-1");
        vm.prank(buyer);
        cards.redeem(id, FACE, rid1);
        assertEq(cards.balanceOf(buyer, id), 0, "fully spent");
        vm.prank(merchantOwner);
        cards.reverseRedemption(rid1);
        assertEq(cards.balanceOf(buyer, id), FACE, "relived to full face");

        // A new redemption against the relived card behaves exactly like a fresh one.
        bytes32 rid2 = keccak256("relive-2");
        vm.prank(buyer);
        uint256 applied = cards.redeem(id, 25e8, rid2);
        assertEq(applied, 25e8, "relived card debits cleanly");
        assertEq(cards.balanceOf(buyer, id), FACE - 25e8, "balance reflects the fresh redemption");
    }
}
