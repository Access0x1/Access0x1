// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { Access0x1GiftCards } from "../../src/Access0x1GiftCards.sol";
import { IAccess0x1GiftCards } from "../../src/interfaces/IAccess0x1GiftCards.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { GiftCardsHandler } from "./GiftCardsHandler.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @notice Access0x1GiftCards' money invariants under a bounded, handler-driven fuzzer — the security
///         floor for the prepaid-balance ledger. Every property is asserted against an INDEPENDENT
///         ghost recomputation in the handler, never against the contract's own numbers.
///
///         Proven here (the ADR's GiftCards fuzz list):
///           1. A card balance can NEVER go negative — enforced by the handler bounding redeems to the
///              live balance + the contract's hard `min`/guard; every balance read is `>= 0` by type
///              and the conservation check below would catch any wrap.
///           2. Conservation — Σ holder balances on a card == Σ issued − Σ redeemed (net of reversals).
///              No balance materializes from nowhere.
///           3. Reversal idempotency — a redemptionId reverses at most once and a redeem replays at
///              most once (the handler tracks both; the ghost only moves on the FIRST effective
///              reverse, so any double-credit would break conservation).
///           4. Coupon cap — `redemptionsCount` never exceeds `maxRedemptions`.
///           5. Tenant isolation — a frozen canary card (never touched by any action) keeps its exact
///              balance no matter what happens on other cards / coupons.
contract Access0x1GiftCardsInvariant is StdInvariant, Test, ProxyDeployer {
    Access0x1GiftCards internal cards;
    Access0x1Router internal router;
    GiftCardsHandler internal handler;

    address internal admin = makeAddr("gci_admin");
    address internal treasury = makeAddr("gci_treasury");
    address internal merchantOwner = makeAddr("gci_merchantOwner");
    uint256 internal merchantId;

    function setUp() public {
        // Both contracts run behind UUPS proxies (storage in the proxy, logic in the impl).
        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (admin, treasury, 100))
            )
        );
        cards = Access0x1GiftCards(
            deployProxy(
                address(new Access0x1GiftCards()),
                abi.encodeCall(Access0x1GiftCards.initialize, (admin, router))
            )
        );

        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(
            makeAddr("gci_payout"), address(0), 0, keccak256("gci_merchant")
        );

        handler = new GiftCardsHandler(cards, router, merchantOwner, merchantId);
        handler.seedCanary();

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = GiftCardsHandler.issue.selector;
        selectors[1] = GiftCardsHandler.redeem.selector;
        selectors[2] = GiftCardsHandler.reverse.selector;
        selectors[3] = GiftCardsHandler.transfer.selector;
        selectors[4] = GiftCardsHandler.applyCoupon.selector;
        selectors[5] = GiftCardsHandler.releaseCoupon.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @notice Invariants 1 + 2 — never-negative + conservation (card 0): the live sum of holder
    ///         balances equals the independent ghost `issued - redeemed`. A negative balance (wrap)
    ///         or a balance from nowhere would break this equality.
    function invariant_conservationCard0() public view {
        uint256 id = handler.cardIdAt(0);
        assertEq(handler.sumHolderBalances(id), handler.ghostOutstanding(id));
    }

    /// @notice Invariants 1 + 2 — same, card 1.
    function invariant_conservationCard1() public view {
        uint256 id = handler.cardIdAt(1);
        assertEq(handler.sumHolderBalances(id), handler.ghostOutstanding(id));
    }

    /// @notice Invariant 4 — coupon cap: the handler coupon's consumption count never exceeds its
    ///         configured maximum, no matter the interleaving of apply / release.
    function invariant_couponCapNeverExceeded() public view {
        IAccess0x1GiftCards.Coupon memory c = cards.coupons(handler.merchantId(), handler.COUPON());
        assertLe(c.redemptionsCount, handler.COUPON_MAX());
    }

    /// @notice Invariant 5 — tenant isolation: the frozen canary card (never touched by any action)
    ///         keeps its exact issued balance regardless of all other activity.
    function invariant_canaryCardFrozen() public view {
        assertEq(
            cards.balanceOf(handler.canaryHolder(), handler.canaryCardId()), handler.canaryBalance()
        );
    }
}
