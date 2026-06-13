// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { RevertingReceiver } from "../mocks/RevertingReceiver.sol";
import { ReentrantPayout } from "../mocks/ReentrantPayout.sol";
import { FeeOnTransferToken } from "../mocks/FeeOnTransferToken.sol";

/// @notice The router's unit suite — the full surface in one fixture: constructor, merchant
///         registry, pricing, both pay paths (with adversarial mocks), admin, and rescue.
contract Access0x1RouterTest is Test {
    Access0x1Router internal router;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%

    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient");
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5%
    bytes32 internal constant NAME_HASH = keccak256("acme");

    MockV3Aggregator internal nativeFeed; // ETH/USD, 8 dp
    MockV3Aggregator internal usdcFeed; // USDC/USD, 8 dp
    MockUSDC internal usdc; // 6 dp

    address internal buyer = makeAddr("buyer");
    bytes32 internal constant ORDER = keccak256("order-1");

    function setUp() public virtual {
        router = new Access0x1Router(owner, treasury, PLATFORM_FEE_BPS);
    }

    /// @dev Deploy + wire a native ($2000) and a USDC ($1) feed, and allowlist USDC. Called by the
    ///      pricing tests; a fresh, non-zero warp keeps the feeds inside the staleness window.
    function _configureFeeds() internal {
        vm.warp(1_700_000_000);
        nativeFeed = new MockV3Aggregator(8, 2000e8);
        usdcFeed = new MockV3Aggregator(8, 1e8);
        usdc = new MockUSDC();
        vm.startPrank(owner);
        router.setPriceFeed(address(0), address(nativeFeed));
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();
    }

    /// @dev Register the default merchant as `merchantOwner`; returns its id.
    function _register() internal returns (uint256 id) {
        vm.prank(merchantOwner);
        id = router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);
    }

    /// @dev The two-leg split for the default merchant: platform cut, merchant surcharge, net.
    function _fees(uint256 gross)
        internal
        pure
        returns (uint256 platformFee, uint256 merchantFee, uint256 net)
    {
        platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        net = gross - platformFee - merchantFee;
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_constructorSetsInitialState() public view {
        assertEq(router.owner(), owner);
        assertEq(router.platformTreasury(), treasury);
        assertEq(router.platformFeeBps(), PLATFORM_FEE_BPS);
        assertEq(router.nextMerchantId(), 1); // 0 stays the unset sentinel
        assertEq(router.MAX_FEE_BPS(), 1000);
    }

    function test_constructorRevertsOnZeroTreasury() public {
        vm.expectRevert(Access0x1Router.Access0x1__ZeroAddress.selector);
        new Access0x1Router(owner, address(0), PLATFORM_FEE_BPS);
    }

    function test_constructorRevertsOnFeeTooHigh() public {
        uint16 tooHigh = router.MAX_FEE_BPS() + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__FeeTooHigh.selector, tooHigh, router.MAX_FEE_BPS()
            )
        );
        new Access0x1Router(owner, treasury, tooHigh);
    }

    /*//////////////////////////////////////////////////////////////
                            REGISTER MERCHANT
    //////////////////////////////////////////////////////////////*/

    function test_registerStoresMerchantAndEmits() public {
        vm.expectEmit(true, true, false, true, address(router));
        emit Access0x1Router.MerchantRegistered(
            1, merchantOwner, payout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH
        );
        uint256 id = _register();

        assertEq(id, 1);
        (address p, address o, address fr, uint16 fb, bool active, bytes32 nh) = router.merchants(1);
        assertEq(p, payout);
        assertEq(o, merchantOwner);
        assertEq(fr, feeRecipient);
        assertEq(fb, MERCHANT_FEE_BPS);
        assertTrue(active);
        assertEq(nh, NAME_HASH);
        assertEq(router.nextMerchantId(), 2);
    }

    function test_registerIncrementsId() public {
        assertEq(_register(), 1);
        assertEq(_register(), 2);
    }

    function test_registerRevertsOnZeroPayout() public {
        vm.prank(merchantOwner);
        vm.expectRevert(Access0x1Router.Access0x1__ZeroAddress.selector);
        router.registerMerchant(address(0), feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);
    }

    function test_registerRevertsWhenFeeCapExceeded() public {
        uint16 maxFee = router.MAX_FEE_BPS(); // cache before prank — a call here would consume it
        uint16 over = maxFee - PLATFORM_FEE_BPS + 1; // combined = 1001 > 1000
        uint256 combined = uint256(over) + PLATFORM_FEE_BPS;
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__FeeTooHigh.selector, combined, maxFee)
        );
        router.registerMerchant(payout, feeRecipient, over, NAME_HASH);
    }

    function test_registerAllowsExactlyMaxFee() public {
        uint16 atCap = router.MAX_FEE_BPS() - PLATFORM_FEE_BPS; // combined == 1000
        vm.prank(merchantOwner);
        uint256 id = router.registerMerchant(payout, feeRecipient, atCap, NAME_HASH);
        (,,, uint16 fb,,) = router.merchants(id);
        assertEq(fb, atCap);
    }

    function test_registerAllowsZeroFeeRecipient() public {
        vm.prank(merchantOwner);
        uint256 id = router.registerMerchant(payout, address(0), MERCHANT_FEE_BPS, NAME_HASH);
        (,, address fr,,,) = router.merchants(id);
        assertEq(fr, address(0)); // allowed: pay path falls back to payout
    }

    /*//////////////////////////////////////////////////////////////
                            UPDATE MERCHANT
    //////////////////////////////////////////////////////////////*/

    function test_updateChangesConfigAndPreservesIdentity() public {
        uint256 id = _register();
        address newPayout = makeAddr("newPayout");
        address newFeeRecipient = makeAddr("newFeeRecipient");
        uint16 newFeeBps = 200;

        vm.expectEmit(true, false, false, true, address(router));
        emit Access0x1Router.MerchantUpdated(id, newPayout, newFeeRecipient, newFeeBps, false);
        vm.prank(merchantOwner);
        router.updateMerchant(id, newPayout, newFeeRecipient, newFeeBps, false);

        (address p, address o, address fr, uint16 fb, bool active, bytes32 nh) =
            router.merchants(id);
        assertEq(p, newPayout);
        assertEq(fr, newFeeRecipient);
        assertEq(fb, newFeeBps);
        assertFalse(active);
        assertEq(o, merchantOwner); // owner is immutable
        assertEq(nh, NAME_HASH); // nameHash is immutable
    }

    function test_updateRevertsOnUnknownId() public {
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__MerchantNotFound.selector, 999)
        );
        router.updateMerchant(999, payout, feeRecipient, MERCHANT_FEE_BPS, true);
    }

    function test_updateRevertsWhenNotOwner() public {
        uint256 id = _register();
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__NotMerchantOwner.selector, id, attacker
            )
        );
        router.updateMerchant(id, payout, feeRecipient, MERCHANT_FEE_BPS, true);
    }

    function test_updateRevertsOnZeroPayout() public {
        uint256 id = _register();
        vm.prank(merchantOwner);
        vm.expectRevert(Access0x1Router.Access0x1__ZeroAddress.selector);
        router.updateMerchant(id, address(0), feeRecipient, MERCHANT_FEE_BPS, true);
    }

    function test_updateRevertsWhenFeeCapExceeded() public {
        uint256 id = _register();
        uint16 maxFee = router.MAX_FEE_BPS(); // cache before prank — a call here would consume it
        uint16 over = maxFee - PLATFORM_FEE_BPS + 1;
        uint256 combined = uint256(over) + PLATFORM_FEE_BPS;
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__FeeTooHigh.selector, combined, maxFee)
        );
        router.updateMerchant(id, payout, feeRecipient, over, true);
    }

    /*//////////////////////////////////////////////////////////////
                                QUOTE
    //////////////////////////////////////////////////////////////*/

    function test_quoteNativeConversion() public {
        _configureFeeds();
        // $20.00 at ETH=$2000 → 0.01 ETH
        assertEq(router.quote(1, address(0), 20e8), 0.01 ether);
    }

    function test_quoteUsdcConversion() public {
        _configureFeeds();
        // $20.00 at USDC=$1 → 20 USDC (6 dp) — proves non-18-decimal handling
        assertEq(router.quote(1, address(usdc), 20e8), 20e6);
    }

    function test_quoteRoundsUp() public {
        _configureFeeds();
        vm.prank(owner);
        // ETH=$3000: 1e-8 USD → 1e26 / 3e19 = 3333333.33… → ceil 3333334
        nativeFeed.updateAnswer(3000e8);
        assertEq(router.quote(1, address(0), 1), 3_333_334);
    }

    function test_quoteRevertsOnZeroUsd() public {
        _configureFeeds();
        vm.expectRevert(Access0x1Router.Access0x1__ZeroAmount.selector);
        router.quote(1, address(0), 0);
    }

    function test_quoteRevertsWhenTokenNotAllowed() public {
        _configureFeeds();
        address rando = makeAddr("rando");
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__TokenNotAllowed.selector, rando)
        );
        router.quote(1, rando, 20e8);
    }

    function test_quoteRevertsWhenAllowedButNoFeed() public {
        _configureFeeds();
        address noFeed = makeAddr("noFeed");
        vm.prank(owner);
        router.setTokenAllowed(noFeed, true); // allowed, but priceFeedOf stays 0
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__TokenNotAllowed.selector, noFeed)
        );
        router.quote(1, noFeed, 20e8);
    }

    function test_quoteRevertsOnStaleFeed() public {
        _configureFeeds();
        nativeFeed.setRoundData(1, 2000e8, block.timestamp - 3601, block.timestamp - 3601, 1);
        vm.expectRevert(); // OracleLib__StalePrice, surfaced through the inlined guard
        router.quote(1, address(0), 20e8);
    }

    function test_quoteRevertsOnZeroPrice() public {
        _configureFeeds();
        nativeFeed.updateAnswer(0);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__InvalidPrice.selector, int256(0))
        );
        router.quote(1, address(0), 20e8);
    }

    function test_quoteRevertsOnNegativePrice() public {
        _configureFeeds();
        nativeFeed.updateAnswer(-1);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__InvalidPrice.selector, int256(-1))
        );
        router.quote(1, address(0), 20e8);
    }

    /*//////////////////////////////////////////////////////////////
                              PAY NATIVE
    //////////////////////////////////////////////////////////////*/

    function test_payNativeSettlesAndEmits() public {
        _configureFeeds();
        uint256 id = _register();
        uint256 gross = router.quote(id, address(0), 20e8); // 0.01 ether
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _fees(gross);

        vm.deal(buyer, 1 ether);
        vm.expectEmit(true, true, true, true, address(router));
        emit Access0x1Router.PaymentReceived(
            id, buyer, address(0), gross, platformFee + merchantFee, net, 20e8, ORDER, 0
        );
        vm.prank(buyer);
        router.payNative{ value: gross }(id, 20e8, ORDER);

        assertEq(payout.balance, net);
        assertEq(treasury.balance, platformFee); // platform cut always → treasury
        assertEq(feeRecipient.balance, merchantFee); // merchant surcharge → feeRecipient
        assertEq(address(router).balance, 0); // no custody
        assertEq(net + platformFee + merchantFee, gross); // net + fee == gross
    }

    function test_payNativeRefundsExcess() public {
        _configureFeeds();
        uint256 id = _register();
        uint256 gross = router.quote(id, address(0), 20e8);

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        router.payNative{ value: gross + 0.5 ether }(id, 20e8, ORDER);

        assertEq(buyer.balance, 1 ether - gross); // net effect: buyer paid exactly gross
    }

    function test_payNativeRevertsUnderpaid() public {
        _configureFeeds();
        uint256 id = _register();
        uint256 gross = router.quote(id, address(0), 20e8);

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__Underpaid.selector, gross, gross - 1)
        );
        router.payNative{ value: gross - 1 }(id, 20e8, ORDER);
    }

    function test_payNativeRevertsWhenMerchantNotFound() public {
        _configureFeeds();
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__MerchantNotFound.selector, 42)
        );
        router.payNative{ value: 1 ether }(42, 20e8, ORDER);
    }

    function test_payNativeRevertsWhenInactive() public {
        _configureFeeds();
        uint256 id = _register();
        vm.prank(merchantOwner);
        router.updateMerchant(id, payout, feeRecipient, MERCHANT_FEE_BPS, false); // deactivate

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__MerchantInactive.selector, id)
        );
        router.payNative{ value: 1 ether }(id, 20e8, ORDER);
    }

    function test_payNativeQueuesRescueWhenPayoutRejects() public {
        _configureFeeds();
        RevertingReceiver badPayout = new RevertingReceiver();
        vm.prank(merchantOwner);
        uint256 id =
            router.registerMerchant(address(badPayout), feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);
        uint256 gross = router.quote(id, address(0), 20e8);
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _fees(gross);

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        router.payNative{ value: gross }(id, 20e8, ORDER); // receipt still emits

        assertEq(router.rescue(address(badPayout)), net); // queued, not lost
        assertEq(treasury.balance, platformFee); // platform cut still paid
        assertEq(feeRecipient.balance, merchantFee); // merchant surcharge still paid
        assertEq(address(router).balance, net); // router holds exactly the rescued net
    }

    function test_payNativeRevertsWhenRefundFails() public {
        _configureFeeds();
        uint256 id = _register();
        uint256 gross = router.quote(id, address(0), 20e8);

        RevertingReceiver badBuyer = new RevertingReceiver();
        vm.deal(address(badBuyer), 1 ether);
        vm.prank(address(badBuyer));
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__NativePushFailed.selector, address(badBuyer), 0.5 ether
            )
        );
        router.payNative{ value: gross + 0.5 ether }(id, 20e8, ORDER);
    }

    function test_payNativeReentrancyIsBlocked() public {
        _configureFeeds();
        vm.prank(merchantOwner);
        uint256 id = router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);

        ReentrantPayout attacker = new ReentrantPayout(router, id);
        vm.prank(merchantOwner);
        router.updateMerchant(id, address(attacker), feeRecipient, MERCHANT_FEE_BPS, true);

        uint256 gross = router.quote(id, address(0), 20e8);
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _fees(gross);

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        router.payNative{ value: gross }(id, 20e8, ORDER);

        // re-entry reverted → net push failed → queued; the merchant is NOT settled twice
        assertEq(router.rescue(address(attacker)), net);
        assertEq(treasury.balance, platformFee);
        assertEq(feeRecipient.balance, merchantFee);
    }

    /*//////////////////////////////////////////////////////////////
                              PAY TOKEN
    //////////////////////////////////////////////////////////////*/

    function test_payTokenSettlesAndEmits() public {
        _configureFeeds();
        uint256 id = _register();
        uint256 gross = router.quote(id, address(usdc), 20e8); // 20 USDC
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _fees(gross);

        usdc.mint(buyer, 100e6);
        vm.prank(buyer);
        usdc.approve(address(router), gross);

        vm.expectEmit(true, true, true, true, address(router));
        emit Access0x1Router.PaymentReceived(
            id, buyer, address(usdc), gross, platformFee + merchantFee, net, 20e8, ORDER, 0
        );
        vm.prank(buyer);
        router.payToken(id, address(usdc), 20e8, ORDER);

        assertEq(usdc.balanceOf(payout), net);
        assertEq(usdc.balanceOf(treasury), platformFee); // platform cut → treasury
        assertEq(usdc.balanceOf(feeRecipient), merchantFee); // merchant surcharge → feeRecipient
        assertEq(usdc.balanceOf(address(router)), 0); // no custody — zero residual
        assertEq(net + platformFee + merchantFee, gross);
    }

    function test_payTokenRevertsOnNativeToken() public {
        _configureFeeds();
        uint256 id = _register();
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__TokenNotAllowed.selector, address(0))
        );
        router.payToken(id, address(0), 20e8, ORDER);
    }

    function test_payTokenRevertsWhenNotAllowed() public {
        _configureFeeds();
        uint256 id = _register();
        MockUSDC other = new MockUSDC(); // never allowlisted, no feed
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__TokenNotAllowed.selector, address(other)
            )
        );
        router.payToken(id, address(other), 20e8, ORDER);
    }

    function test_payTokenRevertsOnFeeOnTransfer() public {
        _configureFeeds();
        uint256 id = _register();
        FeeOnTransferToken fot = new FeeOnTransferToken();
        vm.startPrank(owner);
        router.setTokenAllowed(address(fot), true);
        router.setPriceFeed(address(fot), address(usdcFeed)); // $1, so gross = 20e6
        vm.stopPrank();

        uint256 gross = router.quote(id, address(fot), 20e8);
        uint256 received = gross - gross / 100; // the token skims 1%
        fot.mint(buyer, 100e6);
        vm.prank(buyer);
        fot.approve(address(router), gross);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__FeeOnTransferToken.selector, gross, received
            )
        );
        router.payToken(id, address(fot), 20e8, ORDER);
    }

    function test_payTokenRevertsOnInsufficientAllowance() public {
        _configureFeeds();
        uint256 id = _register();
        usdc.mint(buyer, 100e6); // minted, but never approved
        vm.prank(buyer);
        vm.expectRevert(); // OZ ERC20InsufficientAllowance bubbled through SafeERC20
        router.payToken(id, address(usdc), 20e8, ORDER);
    }

    function test_payTokenRevertsWhenInactive() public {
        _configureFeeds();
        uint256 id = _register();
        vm.prank(merchantOwner);
        router.updateMerchant(id, payout, feeRecipient, MERCHANT_FEE_BPS, false);

        usdc.mint(buyer, 100e6);
        vm.prank(buyer);
        usdc.approve(address(router), type(uint256).max);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__MerchantInactive.selector, id)
        );
        router.payToken(id, address(usdc), 20e8, ORDER);
    }
}
