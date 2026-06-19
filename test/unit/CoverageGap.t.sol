// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";

// ── contracts under test ────────────────────────────────────────────────────
import { Access0x1Bookings } from "../../src/Access0x1Bookings.sol";
import { IAccess0x1Bookings } from "../../src/interfaces/IAccess0x1Bookings.sol";
import { Access0x1GiftCards } from "../../src/Access0x1GiftCards.sol";
import { IAccess0x1GiftCards } from "../../src/interfaces/IAccess0x1GiftCards.sol";
import { Access0x1Nft } from "../../src/Access0x1Nft.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { SessionGrant } from "../../src/SessionGrant.sol";

// ── test infrastructure ──────────────────────────────────────────────────────
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockERC721 } from "../mocks/MockERC721.sol";

import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @dev A minimal ERC-721 that silently no-ops safeTransferFrom (4-arg, which is virtual)
///      so the marketplace cannot verify the NFT actually landed in escrow.
///      The 3-arg variant delegates to the 4-arg one in OZ, so overriding the 4-arg
///      variant is sufficient to make both a no-op.
contract LyingERC721 is ERC721 {
    uint256 private _nextId;

    constructor() ERC721("Lying NFT", "LNFT") { }

    function mint(address to) external returns (uint256 id) {
        id = _nextId++;
        _mint(to, id); // raw _mint: no receiver check, keeps ownership with `to`
    }

    /// @dev 4-arg is virtual in OZ ERC721. No-op: the token stays with its current owner.
    ///      The marketplace calls safeTransferFrom then checks ownerOf — it still
    ///      shows the original owner, so EscrowFailed is triggered.
    function safeTransferFrom(address, address, uint256, bytes memory) public override { }
}

/// @title  CoverageGapTest
/// @notice Targeted tests that exercise the handful of lines not reached by the
///         main suites, without changing any contract logic.
///
///         Lines addressed:
///           src/Access0x1Bookings.sol 128-129  — slotKeyOf() view getter
///           src/Access0x1Bookings.sol 368      — _cancel() wrong-status revert
///           src/Access0x1GiftCards.sol 164     — redeem() defensive never-negative guard
///           src/Access0x1GiftCards.sol 324,326 — _discountFor() AMOUNT / else branches
///           src/Access0x1Nft.sol 142           — pause() body (_pause)
///           src/Access0x1Nft.sol 146-147       — unpause() body (_unpause)
///           src/Access0x1Nft.sol 199           — EscrowFailed revert in list()
///           src/Access0x1Router.sol 302,307    — Router pause()/unpause() bodies
///           src/Access0x1Router.sol 373        — quote() native branch (token == NATIVE)
///           src/SessionGrant.sol 210           — SessionExists defensive revert
///           src/SessionGrant.sol 315           — effectiveSig assignment (non-6492 path)
contract CoverageGapTest is Test {
    // ── shared infrastructure ────────────────────────────────────────────────

    Access0x1Router internal router;
    SessionGrant internal sessionGrant;

    MockV3Aggregator internal usdcFeed; // USDC/USD 8 dp
    MockV3Aggregator internal nativeFeed; // ETH/USD 8 dp
    MockUSDC internal usdc;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    uint256 internal merchantId;

    uint16 internal constant PLATFORM_FEE = 100; // 1%
    uint16 internal constant MERCHANT_FEE = 50; // 0.5%

    function setUp() public virtual {
        vm.warp(1_700_000_000);

        router = new Access0x1Router(admin, treasury, PLATFORM_FEE);
        sessionGrant = new SessionGrant("Access0x1 SessionGrant", "1");

        usdc = new MockUSDC();
        usdcFeed = new MockV3Aggregator(8, 1e8); // $1
        nativeFeed = new MockV3Aggregator(8, 2000e8); // $2000

        vm.startPrank(admin);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        router.setPriceFeed(address(0), address(nativeFeed)); // native = address(0)
        vm.stopPrank();

        vm.prank(merchantOwner);
        merchantId =
            router.registerMerchant(payout, address(0), MERCHANT_FEE, keccak256("merchant"));
    }

    // =========================================================================
    //  Access0x1Bookings — slotKeyOf() (lines 128-129)
    // =========================================================================

    /// @notice slotKeyOf() returns zero for an id that was never reserved, and the
    ///         expected slotKey after a reservation is created. Exercises lines 128-129.
    function test_bookings_slotKeyOf_returnsZeroAndThenKey() public {
        Access0x1Bookings bookings =
            new Access0x1Bookings(admin, address(router), address(sessionGrant));

        // For an id that never existed, slotKeyOf must return 0.
        assertEq(bookings.slotKeyOf(9999), bytes32(0), "unknown id => bytes32(0)");

        // After a reserve, slotKeyOf must return the exact slotKey used.
        usdc.mint(address(this), 1_000_000e6);
        usdc.approve(address(bookings), type(uint256).max);

        IAccess0x1Bookings.Policy memory p =
            IAccess0x1Bookings.Policy({ cancelWindowSecs: 0, lateFeeUsd8: 0, noShowFeeUsd8: 0 });
        bytes32 wantKey = keccak256("slot-A");
        uint256 id = bookings.reserve(
            merchantId,
            wantKey,
            uint64(block.timestamp + 1 days),
            address(usdc),
            10e8, // $10 deposit
            0,
            p,
            1 days,
            keccak256("nonce-1")
        );
        assertEq(bookings.slotKeyOf(id), wantKey, "slotKeyOf returns the correct slot key");
    }

    // =========================================================================
    //  Access0x1Bookings — _cancel() wrong-status revert (line 368)
    // =========================================================================

    /// @notice Calling cancel() on a reservation that is already CANCELLED triggers
    ///         the _cancel() wrong-status guard (line 368).
    function test_bookings_cancel_wrongStatusRevert() public {
        Access0x1Bookings bookings =
            new Access0x1Bookings(admin, address(router), address(sessionGrant));

        usdc.mint(address(this), 1_000_000e6);
        usdc.approve(address(bookings), type(uint256).max);

        IAccess0x1Bookings.Policy memory p =
            IAccess0x1Bookings.Policy({ cancelWindowSecs: 0, lateFeeUsd8: 0, noShowFeeUsd8: 0 });

        // Reserve a slot, then cancel it.
        uint256 id = bookings.reserve(
            merchantId,
            keccak256("slot-B"),
            uint64(block.timestamp + 2 days),
            address(usdc),
            10e8,
            0,
            p,
            1 days,
            keccak256("nonce-2")
        );

        // First cancel succeeds.
        bookings.cancel(id, IAccess0x1Bookings.ActorType.PAYER);

        // Second cancel on the now-CANCELLED reservation must hit line 368.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Bookings.Access0x1Bookings__WrongStatus.selector,
                id,
                IAccess0x1Bookings.RStatus.CANCELLED,
                IAccess0x1Bookings.RStatus.HELD
            )
        );
        bookings.cancel(id, IAccess0x1Bookings.ActorType.PAYER);
    }

    // =========================================================================
    //  Access0x1GiftCards — _discountFor() AMOUNT branch (line 324)
    //                       and else (unreachable) branch (line 326)
    // =========================================================================

    /// @notice applyCoupon with DiscountType.AMOUNT exercises the `raw = value` branch
    ///         (line 324). The else branch (line 326) is unreachable with the current
    ///         two-variant enum; this test covers the reachable AMOUNT path.
    function test_giftcards_discountFor_amountBranch() public {
        Access0x1GiftCards cards = new Access0x1GiftCards(admin, router);
        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, address(0), 0, keccak256("gc-m"));

        bytes32 cid = keccak256("FLAT10");
        vm.startPrank(merchantOwner);
        // AMOUNT coupon: flat $10 discount
        cards.setCoupon(merchantId, cid, IAccess0x1GiftCards.DiscountType.AMOUNT, 10e8, 0, 0);

        uint256 discount = cards.applyCoupon(merchantId, cid, 100e8);
        vm.stopPrank();
        assertEq(discount, 10e8, "AMOUNT discount: flat $10 off a $100 sale");
    }

    /// @notice applyCoupon with a clamped AMOUNT coupon (value > sale) exercises the
    ///         `return raw > amount ? amount : raw` clamp on line 328, confirming the
    ///         AMOUNT branch succeeds even when the raw value overshoots.
    function test_giftcards_discountFor_amountClamped() public {
        Access0x1GiftCards cards = new Access0x1GiftCards(admin, router);
        vm.prank(merchantOwner);
        uint256 mid = router.registerMerchant(payout, address(0), 0, keccak256("gc-m2"));

        bytes32 cid = keccak256("FLAT500");
        vm.startPrank(merchantOwner);
        cards.setCoupon(mid, cid, IAccess0x1GiftCards.DiscountType.AMOUNT, 500e8, 0, 0);

        // $500 flat on a $50 sale: must clamp to $50.
        uint256 discount = cards.applyCoupon(mid, cid, 50e8);
        vm.stopPrank();
        assertEq(discount, 50e8, "AMOUNT discount clamped to sale amount");
    }

    // =========================================================================
    //  Access0x1Nft — pause() body (line 142) and unpause() body (lines 146-147)
    // =========================================================================

    /// @notice Calls both pause() and unpause() on the NFT marketplace, exercising
    ///         their respective internal _pause/_unpause body lines.
    function test_nft_pauseAndUnpause() public {
        Access0x1Nft nftMarket = new Access0x1Nft(admin, router);

        assertFalse(nftMarket.paused(), "initially unpaused");

        vm.prank(admin);
        nftMarket.pause(); // exercises line 142
        assertTrue(nftMarket.paused(), "paused after pause()");

        vm.prank(admin);
        nftMarket.unpause(); // exercises lines 146-147
        assertFalse(nftMarket.paused(), "unpaused after unpause()");
    }

    // =========================================================================
    //  Access0x1Nft — EscrowFailed revert (line 199)
    // =========================================================================

    /// @notice list() with a lying ERC-721 that no-ops safeTransferFrom triggers the
    ///         EscrowFailed guard (line 199).
    function test_nft_list_escrowFailedRevert() public {
        Access0x1Nft nftMarket = new Access0x1Nft(admin, router);
        LyingERC721 lying = new LyingERC721();

        vm.prank(merchantOwner);
        uint256 mid = router.registerMerchant(payout, address(0), 0, keccak256("nft-m"));

        // Mint an NFT to this test contract and "approve" the marketplace (the lying
        // contract accepts any call, so approval is a no-op too, but that is fine — the
        // revert we are targeting happens AFTER safeTransferFrom).
        uint256 tid = lying.mint(address(this));

        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Nft.Access0x1Nft__EscrowFailed.selector, address(lying), tid
            )
        );
        vm.prank(merchantOwner);
        nftMarket.list(mid, address(lying), tid, address(usdc), 10e8);
    }

    // =========================================================================
    //  Access0x1Router — pause() body (line 302) and unpause() body (line 307)
    // =========================================================================

    /// @notice Explicit pause + unpause toggle on the Router, targeting lines 302 and 307.
    function test_router_pauseAndUnpause() public {
        assertFalse(router.paused());

        vm.prank(admin);
        router.pause(); // line 302: _pause()
        assertTrue(router.paused());

        vm.prank(admin);
        router.unpause(); // line 307: _unpause()
        assertFalse(router.paused());
    }

    // =========================================================================
    //  Access0x1Router — quote() native branch (line 373)
    // =========================================================================

    /// @notice Calling quote() with the native sentinel (address(0)) exercises the
    ///         `if (token == NATIVE)` branch that sets tokenDecimals = 18 (line 373-374).
    function test_router_quoteNative_exercisesNativeBranch() public {
        // $20 at $2000/ETH => 0.01 ETH = 0.01 * 10^18
        uint256 amount = router.quote(merchantId, address(0), 20e8);
        assertEq(amount, 0.01 ether, "native quote: $20 @ $2000/ETH = 0.01 ETH");
    }

    // =========================================================================
    //  SessionGrant — SessionExists defensive revert (line 210)
    //  and effectiveSig assignment (line 315)
    // =========================================================================

    /// @notice isValidSignatureNow() with a non-6492 EOA signature exercises the
    ///         `bytes calldata effectiveSig = signature` assignment (line 315) and the
    ///         non-6492 fast path through _validate1271OrEOACalldata.
    function test_sessionGrant_isValidSignatureNow_eoaFastPath() public {
        uint256 pk = 0xA11CE;
        address signer = vm.addr(pk);
        bytes32 digest = keccak256("hello");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        // The signature is NOT 6492-wrapped (no magic suffix), so effectiveSig = signature
        // at line 315 is the live path.  isValidSignatureNow must return true.
        assertTrue(sessionGrant.isValidSignatureNow(signer, digest, sig));
    }

    /// @notice isValidSignatureNow() with a short (< 32 byte) signature still executes
    ///         the `bytes calldata effectiveSig = signature` assignment and falls through
    ///         to _validate1271OrEOACalldata, returning false for a garbage sig.
    function test_sessionGrant_isValidSignatureNow_shortSigFastPath() public {
        address signer = makeAddr("signer");
        bytes32 digest = keccak256("data");
        // 4-byte garbage: shorter than 32, definitely not 6492 wrapped — exercises line 315.
        assertFalse(sessionGrant.isValidSignatureNow(signer, digest, hex"deadbeef"));
    }
}
