// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Nft } from "../../src/Access0x1Nft.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockERC721 } from "../mocks/MockERC721.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @notice A malicious contract buyer that re-enters {Access0x1Nft.buy} from inside the NFT-delivery
///         callback ({onERC721Received}) — the dangerous window: it runs AFTER the listing was
///         deactivated and the payment settled, but if the guard were absent it would try to buy a
///         second listing inside the first. The shared `nonReentrant` guard must revert the inner buy.
contract ReentrantNftBuyer is IERC721Receiver {
    Access0x1Nft public immutable market;
    IERC20 public immutable payToken;
    uint256 public secondListingId;
    uint256 public secondPriceUsd8;
    bool public armed;
    bool public innerReverted;

    constructor(Access0x1Nft market_, IERC20 payToken_) {
        market = market_;
        payToken = payToken_;
    }

    function arm(uint256 secondListingId_, uint256 secondPriceUsd8_) external {
        secondListingId = secondListingId_;
        secondPriceUsd8 = secondPriceUsd8_;
        armed = true;
    }

    function doBuy(uint256 listingId, uint256 priceUsd8) external {
        market.buy(listingId, priceUsd8);
    }

    /// @dev Re-enter buy() on the second listing while delivering the first NFT. nonReentrant reverts.
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        override
        returns (bytes4)
    {
        if (armed) {
            armed = false;
            try market.buy(secondListingId, secondPriceUsd8) {
                innerReverted = false;
            } catch {
                innerReverted = true;
            }
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @notice A contract that cannot receive ERC-721s (no onERC721Received). Used to prove a buyer that
///         cannot accept the NFT reverts the whole purchase — the payment is rolled back with it.
contract NonReceiverBuyer {
    Access0x1Nft public immutable market;

    constructor(Access0x1Nft market_) {
        market = market_;
    }

    function approve(IERC20 token, address spender) external {
        token.approve(spender, type(uint256).max);
    }

    function doBuy(uint256 listingId, uint256 priceUsd8) external {
        market.buy(listingId, priceUsd8);
    }
}

/// @title  Access0x1NftAttackTest
/// @author Access0x1
/// @notice Adversarial coverage for the NFT commerce escrow: reentrancy on the NFT-delivery callback,
///         a non-receiver buyer (atomic money rollback), and front-run price-bump consent. A green run
///         is the proof the escrow resists the classic NFT-marketplace exploits with zero custody.
contract Access0x1NftAttackTest is Test {
    Access0x1Router internal router;
    Access0x1Nft internal market;
    MockV3Aggregator internal usdcFeed;
    MockUSDC internal usdc;
    MockERC721 internal collection;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal sellerPayout = makeAddr("sellerPayout");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal seller = makeAddr("seller");

    uint16 internal constant PLATFORM_FEE_BPS = 100;
    uint16 internal constant MERCHANT_FEE_BPS = 50;
    uint256 internal constant PRICE_USD8 = 50e8;

    uint256 internal merchantId;

    function setUp() public {
        vm.warp(1_700_000_000);
        router = new Access0x1Router(admin, treasury, PLATFORM_FEE_BPS);
        market = new Access0x1Nft(admin, router);
        usdc = new MockUSDC();
        usdcFeed = new MockV3Aggregator(8, 1e8);
        collection = new MockERC721();

        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        vm.prank(seller);
        merchantId =
            router.registerMerchant(sellerPayout, feeRecipient, MERCHANT_FEE_BPS, keccak256("m"));
        vm.prank(seller);
        collection.setApprovalForAll(address(market), true);
    }

    function _listNew() internal returns (uint256 listingId, uint256 tokenId) {
        tokenId = collection.mint(seller);
        vm.prank(seller);
        listingId = market.list(merchantId, address(collection), tokenId, address(usdc), PRICE_USD8);
    }

    /// @notice ATTACK: reentrancy on the NFT-delivery callback. A contract buyer re-enters {buy} on a
    ///         SECOND live listing from inside {onERC721Received} of the first. The shared
    ///         `nonReentrant` guard MUST revert that inner buy. The attacker swallows the inner revert
    ///         (so the OUTER buy still completes — the legitimate path), which proves the guard is the
    ///         gate: the second listing can NOT be double-spent inside the first. We assert the inner
    ///         buy reverted, only the first NFT was delivered, the second listing is untouched, and the
    ///         marketplace + router keep zero custody.
    function test_attack_reentrantBuyOnDeliveryIsBlocked() public {
        (uint256 firstId, uint256 firstTokenId) = _listNew();
        (uint256 secondId, uint256 secondTokenId) = _listNew();

        ReentrantNftBuyer attacker = new ReentrantNftBuyer(market, IERC20(address(usdc)));
        usdc.mint(address(attacker), 1_000_000e6);
        vm.prank(address(attacker));
        usdc.approve(address(market), type(uint256).max);
        attacker.arm(secondId, PRICE_USD8);

        // Outer buy of the first listing. Its NFT delivery fires the re-entrant inner buy on the
        // second listing; nonReentrant reverts that inner call (the attacker catches it). The outer
        // buy then completes normally — exactly ONE listing settles.
        vm.prank(address(attacker));
        attacker.doBuy(firstId, PRICE_USD8);

        // The guard bit: the inner re-entrant buy reverted.
        assertTrue(attacker.innerReverted(), "nonReentrant must have reverted the inner buy");

        // Exactly one settlement: first NFT delivered, second still escrowed and active.
        assertEq(collection.ownerOf(firstTokenId), address(attacker), "first NFT delivered once");
        assertEq(collection.ownerOf(secondTokenId), address(market), "second NFT still escrowed");
        (,,,,,, bool secondActive) = market.listings(secondId);
        assertTrue(secondActive, "second listing untouched by the blocked re-entry");

        // Zero custody after the single legitimate settlement.
        uint256 gross = router.quote(merchantId, address(usdc), PRICE_USD8);
        uint256 platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        uint256 merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        uint256 net = gross - platformFee - merchantFee;
        assertEq(usdc.balanceOf(address(market)), 0, "marketplace zero custody");
        assertEq(usdc.balanceOf(address(router)), 0, "router zero custody");
        assertEq(usdc.balanceOf(sellerPayout), net, "exactly one net settled");
        assertEq(usdc.balanceOf(treasury), platformFee, "exactly one platform fee");
        assertEq(usdc.balanceOf(feeRecipient), merchantFee, "exactly one merchant fee");
        // Attacker paid for exactly one NFT (gross), not two.
        assertEq(usdc.balanceOf(address(attacker)), 1_000_000e6 - gross, "charged for one NFT only");
    }

    /// @notice ATTACK / SAFETY: a contract buyer that cannot receive ERC-721s. {buy}'s safeTransferFrom
    ///         reverts (no onERC721Received), which rolls back the whole purchase atomically — the
    ///         money is returned with the NFT, nothing is stranded, the listing stays active.
    function test_attack_nonReceiverBuyerRollsBackMoney() public {
        (uint256 listingId, uint256 tokenId) = _listNew();
        NonReceiverBuyer badBuyer = new NonReceiverBuyer(market);
        usdc.mint(address(badBuyer), 1_000_000e6);
        badBuyer.approve(IERC20(address(usdc)), address(market));

        vm.expectRevert(); // safeTransferFrom to a non-receiver reverts the whole buy
        badBuyer.doBuy(listingId, PRICE_USD8);

        // Atomic rollback: NFT still escrowed, listing active, no money moved.
        assertEq(collection.ownerOf(tokenId), address(market), "NFT still escrowed");
        (,,,,,, bool active) = market.listings(listingId);
        assertTrue(active, "listing still active");
        assertEq(usdc.balanceOf(address(badBuyer)), 1_000_000e6, "buyer fully refunded by rollback");
        assertEq(usdc.balanceOf(sellerPayout), 0, "no payout");
        assertEq(usdc.balanceOf(address(market)), 0, "marketplace zero custody");
    }

    /// @notice ATTACK: a seller front-runs a buyer by re-pricing. The buyer signs the exact USD price
    ///         they agreed to via `maxPriceUsd8`; a listing whose price differs reverts before any
    ///         money moves. Here the buyer's consented price simply mismatches the listing.
    function test_attack_priceConsentBlocksBump() public {
        (uint256 listingId,) = _listNew();
        address buyer = makeAddr("buyer");
        usdc.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        usdc.approve(address(market), type(uint256).max);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Nft.Access0x1Nft__PriceMismatch.selector, PRICE_USD8, PRICE_USD8 - 1
            )
        );
        market.buy(listingId, PRICE_USD8 - 1);
        assertEq(usdc.balanceOf(buyer), 1_000_000e6, "no money moved on mismatch");
    }

    /// @notice FUZZ (stateless): for any price, a clean purchase conserves value, splits the fee
    ///         exactly, delivers the NFT, and leaves the marketplace AND the router with zero custody
    ///         and no dangling allowance — the core money + custody invariants under arbitrary input.
    function testFuzz_buyConservesAndZeroCustody(uint256 usd8) public {
        usd8 = bound(usd8, 1e6, 100_000e8);

        uint256 tokenId = collection.mint(seller);
        vm.prank(seller);
        uint256 listingId =
            market.list(merchantId, address(collection), tokenId, address(usdc), usd8);

        uint256 gross = router.quote(merchantId, address(usdc), usd8);
        vm.assume(gross > 0 && gross <= 1_000_000e6);
        uint256 platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        uint256 merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        uint256 net = gross - platformFee - merchantFee;

        address buyer = makeAddr("fuzzBuyer");
        usdc.mint(buyer, gross);
        vm.prank(buyer);
        usdc.approve(address(market), gross);
        vm.prank(buyer);
        market.buy(listingId, usd8);

        assertEq(collection.ownerOf(tokenId), buyer, "NFT delivered");
        assertEq(net + platformFee + merchantFee, gross, "conservation");
        assertEq(usdc.balanceOf(sellerPayout), net, "net to payout");
        assertEq(usdc.balanceOf(treasury), platformFee, "platform fee");
        assertEq(usdc.balanceOf(feeRecipient), merchantFee, "merchant fee");
        assertEq(usdc.balanceOf(address(market)), 0, "marketplace zero custody");
        assertEq(usdc.balanceOf(address(router)), 0, "router zero custody");
        assertEq(usdc.allowance(address(market), address(router)), 0, "no dangling allowance");
        assertLe((platformFee + merchantFee) * 10_000, gross * router.MAX_FEE_BPS(), "fee cap");

        // reset accounting for the next fuzz run's clean assertions
        vm.prank(sellerPayout);
        usdc.transfer(address(0xdead), net);
        vm.prank(treasury);
        usdc.transfer(address(0xdead), platformFee);
        vm.prank(feeRecipient);
        usdc.transfer(address(0xdead), merchantFee);
    }
}
