// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Nft } from "../../src/Access0x1Nft.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockERC721 } from "../mocks/MockERC721.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    OwnableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @notice A trivial v2 implementation used by the upgrade test: a subclass that adds one view function
///         and changes nothing else, so an upgrade to it must preserve all prior state. It deliberately
///         carries no new storage (it would consume from `__gap` if it did), proving the proxy keeps
///         every slot across the implementation swap.
contract Access0x1NftV2 is Access0x1Nft {
    /// @notice A marker the original implementation does not expose — lets the test prove the new logic
    ///         is live after {upgradeToAndCall}.
    /// @return The constant string identifying this as the v2 implementation.
    function version2Marker() external pure returns (string memory) {
        return "v2";
    }
}

/// @title  Access0x1NftTest
/// @author Access0x1
/// @notice Happy-path + access-control unit coverage for the NFT commerce escrow. Proves the listing
///         lifecycle, the atomic USD-priced purchase (NFT for token, fee-split by the Router, zero
///         custody), the buyer-consent price guard, cancel-returns-the-NFT, and that pause never
///         blocks a cancel. The marketplace is deployed BEHIND a UUPS proxy (impl → `ERC1967Proxy` with
///         `initialize(...)` calldata → cast) via the shared {ProxyDeployer}, so every test exercises the
///         production proxy↔impl shape; tail tests cover the UUPS upgrade + the permanent freeze via
///         `renounceOwnership`.
contract Access0x1NftTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    Access0x1Nft internal nftMarket;
    MockV3Aggregator internal usdcFeed;
    MockUSDC internal usdc;
    MockERC721 internal collection;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal sellerPayout = makeAddr("sellerPayout");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");

    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5%
    uint256 internal constant PRICE_USD8 = 99e8; // $99.00

    uint256 internal merchantId;
    uint256 internal tokenId;

    function setUp() public {
        vm.warp(1_700_000_000);
        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (admin, treasury, PLATFORM_FEE_BPS))
            )
        );
        address impl = address(new Access0x1Nft());
        address proxy = deployProxy(impl, abi.encodeCall(Access0x1Nft.initialize, (admin, router)));
        nftMarket = Access0x1Nft(proxy);

        usdc = new MockUSDC();
        usdcFeed = new MockV3Aggregator(8, 1e8); // $1
        collection = new MockERC721();

        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        // The seller is the Router merchant owner; net lands at sellerPayout.
        vm.prank(seller);
        merchantId =
            router.registerMerchant(sellerPayout, feeRecipient, MERCHANT_FEE_BPS, keccak256("m"));

        // Mint an NFT to the seller and approve the marketplace to escrow it.
        tokenId = collection.mint(seller);
        vm.prank(seller);
        collection.setApprovalForAll(address(nftMarket), true);

        usdc.mint(buyer, 1_000_000e6);
    }

    function _list() internal returns (uint256 listingId) {
        vm.prank(seller);
        listingId =
            nftMarket.list(merchantId, address(collection), tokenId, address(usdc), PRICE_USD8);
    }

    function _legs(uint256 gross)
        internal
        pure
        returns (uint256 platformFee, uint256 merchantFee, uint256 net)
    {
        platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        net = gross - platformFee - merchantFee;
    }

    /// @notice list() escrows the NFT and records the listing.
    function test_list_escrowsNftAndRecords() public {
        uint256 listingId = _list();

        assertEq(collection.ownerOf(tokenId), address(nftMarket), "NFT escrowed");
        (address s, bool active, address c, address pt, uint256 tid, uint256 mid, uint256 price) =
            nftMarket.listings(listingId);
        assertEq(s, seller);
        assertEq(c, address(collection));
        assertEq(tid, tokenId);
        assertEq(mid, merchantId);
        assertEq(pt, address(usdc));
        assertEq(price, PRICE_USD8);
        assertTrue(active);
    }

    /// @notice buy() pays through the Router (exact fee-split), delivers the NFT, keeps zero custody.
    function test_buy_settlesAndDeliversNft() public {
        uint256 listingId = _list();
        uint256 gross = router.quote(merchantId, address(usdc), PRICE_USD8);
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _legs(gross);

        vm.prank(buyer);
        usdc.approve(address(nftMarket), gross);
        vm.prank(buyer);
        nftMarket.buy(listingId, PRICE_USD8, gross);

        // NFT delivered to buyer.
        assertEq(collection.ownerOf(tokenId), buyer, "NFT to buyer");
        // Money invariants: conservation + exact two-leg split.
        assertEq(net + platformFee + merchantFee, gross, "conservation");
        assertEq(usdc.balanceOf(sellerPayout), net, "net to seller payout");
        assertEq(usdc.balanceOf(treasury), platformFee, "platform fee");
        assertEq(usdc.balanceOf(feeRecipient), merchantFee, "merchant fee");
        // Zero custody: neither the marketplace nor the router holds any token.
        assertEq(usdc.balanceOf(address(nftMarket)), 0, "marketplace zero custody");
        assertEq(usdc.balanceOf(address(router)), 0, "router zero custody");
        assertEq(usdc.allowance(address(nftMarket), address(router)), 0, "no dangling allowance");
        // Buyer charged exactly gross.
        assertEq(usdc.balanceOf(buyer), 1_000_000e6 - gross, "buyer charged gross");
        // Listing one-shot: a second buy reverts inactive.
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Nft.Access0x1Nft__ListingInactive.selector, listingId)
        );
        nftMarket.buy(listingId, PRICE_USD8, type(uint256).max);
    }

    /// @notice buy() with a mismatched buyer price reverts (front-run / price-bump consent guard).
    function test_buy_priceMismatchReverts() public {
        uint256 listingId = _list();
        vm.prank(buyer);
        usdc.approve(address(nftMarket), type(uint256).max);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Nft.Access0x1Nft__PriceMismatch.selector, PRICE_USD8, PRICE_USD8 + 1
            )
        );
        nftMarket.buy(listingId, PRICE_USD8 + 1, type(uint256).max);
        // Unsold: NFT still escrowed, listing still active.
        assertEq(collection.ownerOf(tokenId), address(nftMarket));
    }

    /// @notice buy() reverts when the live quote requires more token units than the buyer's outlay cap
    ///         (slippage guard, L-5). The USD price is unchanged — `maxPriceUsd8` still matches — so this
    ///         proves the token-amount ceiling is an INDEPENDENT bound, not subsumed by the USD consent.
    ///         The cap reverts BEFORE any token moves: no money leaves the buyer, the NFT stays escrowed.
    function test_buy_tokenAmountTooHighReverts() public {
        uint256 listingId = _list();
        uint256 gross = router.quote(merchantId, address(usdc), PRICE_USD8);
        // Cap one unit below the actual quote: the buyer consents to the USD price but will not spend
        // this many token units.
        uint256 cap = gross - 1;

        vm.prank(buyer);
        usdc.approve(address(nftMarket), type(uint256).max);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Nft.Access0x1Nft__TokenAmountTooHigh.selector, gross, cap
            )
        );
        nftMarket.buy(listingId, PRICE_USD8, cap);

        // No token moved and the listing is untouched (cap check is before the pull + the effect).
        assertEq(usdc.balanceOf(buyer), 1_000_000e6, "buyer not charged on slippage revert");
        assertEq(collection.ownerOf(tokenId), address(nftMarket), "NFT still escrowed");
        (,,,,,, uint256 price) = nftMarket.listings(listingId);
        assertEq(price, PRICE_USD8, "listing intact");
    }

    /// @notice buy() succeeds when the buyer's outlay cap exactly equals the quoted gross — the boundary
    ///         is inclusive (`gross > maxTokenAmount` reverts, `gross == maxTokenAmount` passes).
    function test_buy_tokenAmountCapExactBoundaryPasses() public {
        uint256 listingId = _list();
        uint256 gross = router.quote(merchantId, address(usdc), PRICE_USD8);

        vm.prank(buyer);
        usdc.approve(address(nftMarket), gross);
        vm.prank(buyer);
        nftMarket.buy(listingId, PRICE_USD8, gross); // cap == gross: at the boundary, not over it

        assertEq(collection.ownerOf(tokenId), buyer, "NFT delivered at the exact cap");
        assertEq(usdc.balanceOf(buyer), 1_000_000e6 - gross, "buyer charged exactly gross");
    }

    /// @notice cancelListing() returns the NFT to the seller and deactivates the listing.
    function test_cancel_returnsNft() public {
        uint256 listingId = _list();
        vm.prank(seller);
        nftMarket.cancelListing(listingId);

        assertEq(collection.ownerOf(tokenId), seller, "NFT returned");
        vm.prank(buyer);
        usdc.approve(address(nftMarket), type(uint256).max);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Nft.Access0x1Nft__ListingInactive.selector, listingId)
        );
        nftMarket.buy(listingId, PRICE_USD8, type(uint256).max);
    }

    /// @notice Only the seller may cancel.
    function test_cancel_onlySeller() public {
        uint256 listingId = _list();
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Nft.Access0x1Nft__NotSeller.selector, listingId, buyer)
        );
        nftMarket.cancelListing(listingId);
    }

    /// @notice Only the Router merchant owner may list under a merchantId.
    function test_list_onlyMerchantOwner() public {
        uint256 otherTokenId = collection.mint(buyer);
        vm.prank(buyer);
        collection.setApprovalForAll(address(nftMarket), true);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Nft.Access0x1Nft__NotMerchantOwner.selector, merchantId, buyer
            )
        );
        nftMarket.list(merchantId, address(collection), otherTokenId, address(usdc), PRICE_USD8);
    }

    /// @notice Listing against a non-existent merchant reverts.
    function test_list_merchantNotFound() public {
        vm.prank(seller);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Nft.Access0x1Nft__MerchantNotFound.selector, 999)
        );
        nftMarket.list(999, address(collection), tokenId, address(usdc), PRICE_USD8);
    }

    /// @notice Listing with a disallowed payment token reverts at list time (fail-fast, no stranded
    ///         escrow), bubbling the Router's TokenNotAllowed.
    function test_list_disallowedTokenReverts() public {
        MockUSDC other = new MockUSDC();
        vm.prank(seller);
        vm.expectRevert(); // Router: Access0x1__TokenNotAllowed
        nftMarket.list(merchantId, address(collection), tokenId, address(other), PRICE_USD8);
        // NFT not escrowed (the revert rolled back the would-be escrow).
        assertEq(collection.ownerOf(tokenId), seller);
    }

    /// @notice Zero price and zero address are rejected.
    function test_list_zeroPriceAndAddress() public {
        vm.startPrank(seller);
        vm.expectRevert(Access0x1Nft.Access0x1Nft__ZeroPrice.selector);
        nftMarket.list(merchantId, address(collection), tokenId, address(usdc), 0);
        vm.expectRevert(Access0x1Nft.Access0x1Nft__ZeroAddress.selector);
        nftMarket.list(merchantId, address(0), tokenId, address(usdc), PRICE_USD8);
        vm.stopPrank();
    }

    /// @notice pause() blocks list() and buy() but NEVER cancelListing() (no hostage assets).
    function test_pause_blocksTradeNotCancel() public {
        uint256 listingId = _list();
        vm.prank(admin);
        nftMarket.pause();

        // buy blocked.
        vm.prank(buyer);
        usdc.approve(address(nftMarket), type(uint256).max);
        vm.prank(buyer);
        vm.expectRevert(); // Pausable: EnforcedPause
        nftMarket.buy(listingId, PRICE_USD8, type(uint256).max);

        // list blocked.
        uint256 t2 = collection.mint(seller);
        vm.prank(seller);
        vm.expectRevert();
        nftMarket.list(merchantId, address(collection), t2, address(usdc), PRICE_USD8);

        // cancel STILL works while paused.
        vm.prank(seller);
        nftMarket.cancelListing(listingId);
        assertEq(collection.ownerOf(tokenId), seller, "cancel works under pause");
    }

    /// @notice Only the admin may pause.
    function test_pause_onlyOwner() public {
        vm.prank(buyer);
        vm.expectRevert();
        nftMarket.pause();
    }

    /// @notice The initializer rejects a zero router (the constructor-revert, now in {initialize}). The
    ///         revert surfaces from inside the proxy's atomic deploy-and-initialize call.
    function test_initialize_zeroRouterReverts() public {
        address impl = address(new Access0x1Nft());
        vm.expectRevert(Access0x1Nft.Access0x1Nft__ZeroAddress.selector);
        deployProxy(
            impl,
            abi.encodeCall(Access0x1Nft.initialize, (admin, Access0x1Router(payable(address(0)))))
        );
    }

    /// @notice The proxy was already initialized in setUp; a second call must revert (one-time
    ///         initializer guard).
    function test_initialize_revertOnSecondCall() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        nftMarket.initialize(admin, router);
    }

    /// @notice The admin (contract owner / upgrade admin) upgrades the proxy to a v2 implementation: the
    ///         new logic goes live AND every prior storage slot survives (a live listing is intact), since
    ///         storage lives in the proxy, not the swapped implementation.
    function test_upgrade_preservesStateAndAddsFn() public {
        // Seed state under v1: a live listing escrowing the seller's NFT.
        vm.prank(seller);
        uint256 listingId =
            nftMarket.list(merchantId, address(collection), tokenId, address(usdc), PRICE_USD8);

        // The admin upgrades the proxy to v2.
        address v2 = address(new Access0x1NftV2());
        vm.prank(admin);
        UUPSUpgradeable(address(nftMarket)).upgradeToAndCall(v2, "");

        // The new logic is live...
        assertEq(Access0x1NftV2(address(nftMarket)).version2Marker(), "v2");

        // ...and ALL prior state survived the implementation swap (storage lives in the proxy).
        (address ls,, address lc, address lpt, uint256 ltid, uint256 lmid, uint256 lprice) =
            nftMarket.listings(listingId);
        assertEq(ls, seller, "seller preserved");
        assertEq(lc, address(collection), "collection preserved");
        assertEq(lpt, address(usdc), "paymentToken preserved");
        assertEq(ltid, tokenId, "tokenId preserved");
        assertEq(lmid, merchantId, "merchantId preserved");
        assertEq(lprice, PRICE_USD8, "priceUsd8 preserved");
        assertEq(address(nftMarket.router()), address(router), "router reference preserved");
        assertEq(nftMarket.nextListingId(), 2, "nextListingId preserved");
        assertEq(OwnableUpgradeable(address(nftMarket)).owner(), admin, "upgrade admin unchanged");
        assertEq(
            IERC721(collection).ownerOf(tokenId),
            address(nftMarket),
            "NFT still escrowed post-upgrade"
        );
    }

    /// @notice A non-owner cannot upgrade — {_authorizeUpgrade} is `onlyOwner`.
    function test_upgrade_revertNonOwner() public {
        address v2 = address(new Access0x1NftV2());
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, buyer)
        );
        UUPSUpgradeable(address(nftMarket)).upgradeToAndCall(v2, "");
    }

    /// @notice Renouncing ownership freezes the implementation forever: with no owner,
    ///         {_authorizeUpgrade} reverts for EVERYONE, so a later upgrade can never land.
    function test_freeze_renounceOwnershipBlocksUpgradeForever() public {
        vm.prank(admin);
        OwnableUpgradeable(address(nftMarket)).renounceOwnership();
        assertEq(OwnableUpgradeable(address(nftMarket)).owner(), address(0), "owner renounced");

        address v2 = address(new Access0x1NftV2());
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, admin)
        );
        UUPSUpgradeable(address(nftMarket)).upgradeToAndCall(v2, "");
    }
}
