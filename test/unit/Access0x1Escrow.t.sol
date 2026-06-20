// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1Escrow } from "../../src/Access0x1Escrow.sol";
import { IAccess0x1Escrow } from "../../src/interfaces/IAccess0x1Escrow.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { FeeOnTransferToken } from "../mocks/FeeOnTransferToken.sol";
import { RevertingReceiver } from "../mocks/RevertingReceiver.sol";
import { BlocklistToken } from "../mocks/BlocklistToken.sol";
import { MockReturnsNothingToken } from "../mocks/MockReturnsNothingToken.sol";
import { SmartWallet1271 } from "../mocks/SmartWallet1271.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    OwnableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @notice A trivial v2 implementation for the upgrade test: a subclass adding one view and changing
///         nothing else, so an upgrade to it must preserve all prior state. It carries no new storage
///         (it would consume from `__gap` if it did), proving the proxy keeps every slot across the swap.
contract Access0x1EscrowV2 is Access0x1Escrow {
    /// @notice A marker the original implementation does not expose — proves the new logic is live.
    function version2Marker() external pure returns (string memory) {
        return "v2";
    }
}

/// @notice A native receiver that rejects ETH while `blocking`, then accepts once toggled off. Used to
///         drive the full never-blockable native path: a release/refund push fails (the credit queues),
///         the recipient unblocks, and a {withdraw} pays it out — proving the parked credit is real and
///         claimable, never lost.
contract ToggleableReceiver {
    bool public blocking = true;

    function setBlocking(bool b) external {
        blocking = b;
    }

    receive() external payable {
        if (blocking) revert("ToggleableReceiver: blocked");
    }
}

/// @notice The conditional-escrow unit suite: the full surface in one fixture — initializer, open (token
///         + native), the three release triggers (confirm / timeout / arbiter), the two refund triggers
///         (seller-cancel / arbiter), the buyer-signed release (EOA + ERC-1271), the never-blockable
///         pull-map + withdraw, ERC-165, and the UUPS upgrade/freeze. Asserts the release mirrors the
///         router's live fee-split (net + fee == amount, fee → treasury) without re-deriving it, that a
///         refund is full + never-blockable, and that no value path can ever lock or strand funds. The
///         contract is deployed BEHIND a UUPS proxy via the shared {ProxyDeployer}, the production shape.
contract Access0x1EscrowTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    Access0x1Escrow internal escrow;

    address internal owner = makeAddr("owner"); // router admin
    address internal admin = makeAddr("admin"); // escrow upgrade admin
    address internal treasury = makeAddr("treasury");
    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%

    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient");
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5% (proves the escrow ignores the merchant leg)
    bytes32 internal constant NAME_HASH = keccak256("acme");

    MockV3Aggregator internal nativeFeed;
    MockV3Aggregator internal usdcFeed;
    MockUSDC internal usdc; // 6 dp

    address internal seller = makeAddr("seller");
    address internal arbiter = makeAddr("arbiter");
    address internal stranger = makeAddr("stranger");
    address internal relayer = makeAddr("relayer");

    address internal buyer;
    uint256 internal buyerPk;

    uint256 internal merchantId;
    uint256 internal constant AMOUNT = 100e6; // 100 USDC
    uint256 internal constant NATIVE_AMOUNT = 1 ether;
    uint64 internal deadline;

    function setUp() public virtual {
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

        nativeFeed = new MockV3Aggregator(8, 2000e8);
        usdcFeed = new MockV3Aggregator(8, 1e8);
        usdc = new MockUSDC();
        vm.startPrank(owner);
        router.setPriceFeed(address(0), address(nativeFeed));
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);
    }

    /// @dev The platform-only split the escrow mirrors from the router (the merchant surcharge is NOT
    ///      taken on an escrow release — only the platform leg).
    function _split(uint256 amount) internal pure returns (uint256 fee, uint256 net) {
        fee = amount * PLATFORM_FEE_BPS / 10_000;
        net = amount - fee;
    }

    /// @dev Open a funded USDC escrow as the buyer (arbiter optional).
    function _openToken(address arbiter_) internal returns (uint256 id) {
        usdc.mint(buyer, AMOUNT);
        vm.startPrank(buyer);
        usdc.approve(address(escrow), AMOUNT);
        id = escrow.open(seller, merchantId, address(usdc), AMOUNT, arbiter_, deadline);
        vm.stopPrank();
    }

    /// @dev Open a funded native escrow as the buyer (arbiter optional).
    function _openNative(address arbiter_) internal returns (uint256 id) {
        vm.deal(buyer, NATIVE_AMOUNT);
        vm.prank(buyer);
        id = escrow.open{ value: NATIVE_AMOUNT }(
            seller, merchantId, address(0), NATIVE_AMOUNT, arbiter_, deadline
        );
    }

    /*//////////////////////////////////////////////////////////////
                              INITIALIZE
    //////////////////////////////////////////////////////////////*/

    function test_initializeSetsRouterNextIdAndOwner() public view {
        assertEq(address(escrow.router()), address(router));
        assertEq(escrow.nextEscrowId(), 1);
        assertEq(OwnableUpgradeable(address(escrow)).owner(), admin);
    }

    function test_initializeRevertsOnZeroRouter() public {
        address impl = address(new Access0x1Escrow());
        vm.expectRevert(IAccess0x1Escrow.Access0x1Escrow__ZeroAddress.selector);
        deployProxy(
            impl,
            abi.encodeCall(
                Access0x1Escrow.initialize, (admin, Access0x1Router(payable(address(0))))
            )
        );
    }

    function test_initializeRevertsOnSecondCall() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        escrow.initialize(admin, router);
    }

    function test_supportsInterface() public view {
        assertTrue(escrow.supportsInterface(type(IAccess0x1Escrow).interfaceId));
        assertTrue(escrow.supportsInterface(type(IERC165).interfaceId));
        assertFalse(escrow.supportsInterface(0xffffffff));
        assertFalse(escrow.supportsInterface(0xdeadbeef));
    }

    /*//////////////////////////////////////////////////////////////
                                 OPEN
    //////////////////////////////////////////////////////////////*/

    function test_openTokenStoresAndHolds() public {
        usdc.mint(buyer, AMOUNT);
        vm.startPrank(buyer);
        usdc.approve(address(escrow), AMOUNT);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit IAccess0x1Escrow.EscrowOpened(
            1, buyer, seller, merchantId, address(usdc), AMOUNT, arbiter, deadline
        );
        uint256 id = escrow.open(seller, merchantId, address(usdc), AMOUNT, arbiter, deadline);
        vm.stopPrank();

        assertEq(id, 1);
        IAccess0x1Escrow.Escrow memory e = escrow.escrowOf(id);
        assertEq(e.buyer, buyer);
        assertEq(e.seller, seller);
        assertEq(e.merchantId, merchantId);
        assertEq(e.asset, address(usdc));
        assertEq(e.amount, AMOUNT);
        assertEq(e.arbiter, arbiter);
        assertEq(e.deadline, deadline);
        assertEq(uint8(e.state), uint8(IAccess0x1Escrow.EscrowState.OPEN));
        assertEq(escrow.nextEscrowId(), 2);
        assertTrue(escrow.isOpen(id));
        // The deposit is held by the contract.
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        assertEq(usdc.balanceOf(buyer), 0);
    }

    function test_openNativeStoresAndHolds() public {
        uint256 id = _openNative(arbiter);
        assertEq(address(escrow).balance, NATIVE_AMOUNT);
        assertEq(uint8(escrow.escrowOf(id).state), uint8(IAccess0x1Escrow.EscrowState.OPEN));
    }

    function test_openIncrementsId() public {
        assertEq(_openToken(address(0)), 1);
        assertEq(_openToken(address(0)), 2);
    }

    function test_openAllowsZeroArbiter() public {
        uint256 id = _openToken(address(0));
        assertEq(escrow.escrowOf(id).arbiter, address(0));
    }

    function test_openRevertsOnZeroSeller() public {
        vm.prank(buyer);
        vm.expectRevert(IAccess0x1Escrow.Access0x1Escrow__ZeroAddress.selector);
        escrow.open(address(0), merchantId, address(usdc), AMOUNT, arbiter, deadline);
    }

    function test_openRevertsOnZeroAmount() public {
        vm.prank(buyer);
        vm.expectRevert(IAccess0x1Escrow.Access0x1Escrow__ZeroAmount.selector);
        escrow.open(seller, merchantId, address(usdc), 0, arbiter, deadline);
    }

    function test_openRevertsOnPastDeadline() public {
        uint64 past = uint64(block.timestamp);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__BadDeadline.selector, past, block.timestamp
            )
        );
        escrow.open(seller, merchantId, address(usdc), AMOUNT, arbiter, past);
    }

    function test_openRevertsOnUnknownMerchant() public {
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1Escrow.Access0x1Escrow__Unknown.selector, 999)
        );
        escrow.open(seller, 999, address(usdc), AMOUNT, arbiter, deadline);
    }

    function test_openNativeRevertsOnValueMismatch() public {
        vm.deal(buyer, 2 ether);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__ValueMismatch.selector, NATIVE_AMOUNT, 0.5 ether
            )
        );
        escrow.open{ value: 0.5 ether }(
            seller, merchantId, address(0), NATIVE_AMOUNT, arbiter, deadline
        );
    }

    function test_openTokenRevertsOnStrayValue() public {
        usdc.mint(buyer, AMOUNT);
        vm.deal(buyer, 1 ether);
        vm.startPrank(buyer);
        usdc.approve(address(escrow), AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__ValueMismatch.selector, 0, 1 ether
            )
        );
        escrow.open{ value: 1 ether }(seller, merchantId, address(usdc), AMOUNT, arbiter, deadline);
        vm.stopPrank();
    }

    function test_openRevertsOnFeeOnTransferToken() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        fot.mint(buyer, AMOUNT);
        uint256 received = AMOUNT - AMOUNT / 100; // skims 1%
        vm.startPrank(buyer);
        fot.approve(address(escrow), AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__FeeOnTransferToken.selector, AMOUNT, received
            )
        );
        escrow.open(seller, merchantId, address(fot), AMOUNT, arbiter, deadline);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                          CONFIRM (BUYER RELEASE)
    //////////////////////////////////////////////////////////////*/

    function test_confirmReleasesTokenThroughFeeSplit() public {
        uint256 id = _openToken(arbiter);
        (uint256 fee, uint256 net) = _split(AMOUNT);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit IAccess0x1Escrow.EscrowReleased(id, buyer, net, fee);
        vm.prank(buyer);
        escrow.confirm(id);

        // Fee → treasury, net → seller; net + fee == amount; zero custody.
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(seller), net);
        assertEq(net + fee, AMOUNT);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        // The merchant surcharge is NOT taken on an escrow release — feeRecipient/payout untouched.
        assertEq(usdc.balanceOf(feeRecipient), 0);
        assertEq(usdc.balanceOf(payout), 0);
        assertEq(uint8(escrow.escrowOf(id).state), uint8(IAccess0x1Escrow.EscrowState.RELEASED));
        assertFalse(escrow.isOpen(id));
    }

    function test_confirmReleasesNativeThroughFeeSplit() public {
        uint256 id = _openNative(arbiter);
        (uint256 fee, uint256 net) = _split(NATIVE_AMOUNT);

        vm.prank(buyer);
        escrow.confirm(id);

        assertEq(treasury.balance, fee);
        assertEq(seller.balance, net);
        assertEq(net + fee, NATIVE_AMOUNT);
        assertEq(address(escrow).balance, 0);
    }

    function test_confirmRevertsWhenNotBuyer() public {
        uint256 id = _openToken(arbiter);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__NotAuthorized.selector, id, stranger
            )
        );
        escrow.confirm(id);
    }

    function test_confirmRevertsOnSecondRelease() public {
        uint256 id = _openToken(arbiter);
        vm.startPrank(buyer);
        escrow.confirm(id);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__NotOpen.selector,
                id,
                IAccess0x1Escrow.EscrowState.RELEASED
            )
        );
        escrow.confirm(id);
        vm.stopPrank();
    }

    function test_confirmRevertsOnUnknownEscrow() public {
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1Escrow.Access0x1Escrow__Unknown.selector, 42)
        );
        escrow.confirm(42);
    }

    /// @notice With a zero platform fee, the seller nets the full amount and the treasury gets nothing —
    ///         proving the split reads the router's LIVE rate, not a hardcoded constant.
    function test_confirmZeroPlatformFeePaysFullToSeller() public {
        vm.prank(owner);
        router.setPlatformFee(0);
        uint256 id = _openToken(arbiter);
        vm.prank(buyer);
        escrow.confirm(id);
        assertEq(usdc.balanceOf(seller), AMOUNT);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    /// @notice A platform-fee change BETWEEN open and release is reflected at release time (the rate is
    ///         read live), confirming the escrow never snapshots the fee.
    function test_confirmReflectsLiveFeeChange() public {
        uint256 id = _openToken(arbiter);
        vm.prank(owner);
        router.setPlatformFee(1000); // 10%
        (uint256 fee, uint256 net) = (AMOUNT * 1000 / 10_000, AMOUNT - AMOUNT * 1000 / 10_000);
        vm.prank(buyer);
        escrow.confirm(id);
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(seller), net);
    }

    /*//////////////////////////////////////////////////////////////
                          CLAIM AFTER TIMEOUT
    //////////////////////////////////////////////////////////////*/

    function test_timeoutReleasesPermissionlessly() public {
        uint256 id = _openToken(arbiter);
        (uint256 fee, uint256 net) = _split(AMOUNT);
        vm.warp(deadline); // exactly at the deadline is allowed

        vm.expectEmit(true, true, false, true, address(escrow));
        emit IAccess0x1Escrow.EscrowReleased(id, stranger, net, fee);
        vm.prank(stranger); // ANYONE may claim — the anti-lock guarantee
        escrow.claimAfterTimeout(id);

        assertEq(usdc.balanceOf(seller), net);
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(uint8(escrow.escrowOf(id).state), uint8(IAccess0x1Escrow.EscrowState.RELEASED));
    }

    function test_timeoutRevertsBeforeDeadline() public {
        uint256 id = _openToken(arbiter);
        vm.warp(deadline - 1);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__TimeoutNotReached.selector,
                id,
                deadline,
                block.timestamp
            )
        );
        escrow.claimAfterTimeout(id);
    }

    function test_timeoutRevertsWhenAlreadyResolved() public {
        uint256 id = _openToken(arbiter);
        vm.prank(buyer);
        escrow.confirm(id);
        vm.warp(deadline);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__NotOpen.selector,
                id,
                IAccess0x1Escrow.EscrowState.RELEASED
            )
        );
        escrow.claimAfterTimeout(id);
    }

    /*//////////////////////////////////////////////////////////////
                          CANCEL (SELLER REFUND)
    //////////////////////////////////////////////////////////////*/

    function test_cancelRefundsBuyerInFull() public {
        uint256 id = _openToken(arbiter);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IAccess0x1Escrow.EscrowRefunded(id, seller, AMOUNT);
        vm.prank(seller);
        escrow.cancel(id);

        // FULL refund, no fee taken; zero custody.
        assertEq(usdc.balanceOf(buyer), AMOUNT);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(usdc.balanceOf(seller), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.escrowOf(id).state), uint8(IAccess0x1Escrow.EscrowState.REFUNDED));
    }

    function test_cancelRefundsNativeInFull() public {
        uint256 id = _openNative(arbiter);
        vm.prank(seller);
        escrow.cancel(id);
        assertEq(buyer.balance, NATIVE_AMOUNT);
        assertEq(address(escrow).balance, 0);
    }

    function test_cancelRevertsWhenNotSeller() public {
        uint256 id = _openToken(arbiter);
        vm.prank(buyer); // even the buyer cannot cancel — only the seller
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__NotAuthorized.selector, id, buyer
            )
        );
        escrow.cancel(id);
    }

    function test_cancelRevertsOnSecondResolve() public {
        uint256 id = _openToken(arbiter);
        vm.startPrank(seller);
        escrow.cancel(id);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__NotOpen.selector,
                id,
                IAccess0x1Escrow.EscrowState.REFUNDED
            )
        );
        escrow.cancel(id);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                              ARBITRATE
    //////////////////////////////////////////////////////////////*/

    function test_arbitrateReleaseToSeller() public {
        uint256 id = _openToken(arbiter);
        (uint256 fee, uint256 net) = _split(AMOUNT);
        vm.prank(arbiter);
        escrow.arbitrate(id, true);
        assertEq(usdc.balanceOf(seller), net);
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(uint8(escrow.escrowOf(id).state), uint8(IAccess0x1Escrow.EscrowState.RELEASED));
    }

    function test_arbitrateRefundToBuyer() public {
        uint256 id = _openToken(arbiter);
        vm.prank(arbiter);
        escrow.arbitrate(id, false);
        assertEq(usdc.balanceOf(buyer), AMOUNT);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(uint8(escrow.escrowOf(id).state), uint8(IAccess0x1Escrow.EscrowState.REFUNDED));
    }

    function test_arbitrateRevertsWhenNotArbiter() public {
        uint256 id = _openToken(arbiter);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__NotAuthorized.selector, id, stranger
            )
        );
        escrow.arbitrate(id, true);
    }

    function test_arbitrateRevertsWhenNoArbiterSet() public {
        // An escrow with arbiter == address(0): no caller can be the arbiter, so any arbitrate reverts.
        uint256 id = _openToken(address(0));
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__NotAuthorized.selector, id, stranger
            )
        );
        escrow.arbitrate(id, true);
    }

    /*//////////////////////////////////////////////////////////////
                            RELEASE WITH SIG
    //////////////////////////////////////////////////////////////*/

    /// @dev Sign the EIP-712 release authorization for `id` with the EOA buyer's key.
    function _signRelease(uint256 pk, uint256 id) internal view returns (bytes memory) {
        bytes32 digest = escrow.releaseDigest(id);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_releaseWithSig_eoaBuyer_relayerSubmits() public {
        uint256 id = _openToken(arbiter);
        (uint256 fee, uint256 net) = _split(AMOUNT);
        bytes memory sig = _signRelease(buyerPk, id);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit IAccess0x1Escrow.EscrowReleased(id, relayer, net, fee);
        vm.prank(relayer); // permissionless relayer submits the buyer's authorization
        escrow.releaseWithSig(id, sig);

        assertEq(usdc.balanceOf(seller), net);
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(uint8(escrow.escrowOf(id).state), uint8(IAccess0x1Escrow.EscrowState.RELEASED));
    }

    function test_releaseWithSig_revertsOnWrongSigner() public {
        uint256 id = _openToken(arbiter);
        (, uint256 strangerPk) = makeAddrAndKey("notTheBuyer");
        bytes memory sig = _signRelease(strangerPk, id); // signed by someone other than the buyer
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1Escrow.Access0x1Escrow__BadSignature.selector, id)
        );
        escrow.releaseWithSig(id, sig);
    }

    function test_releaseWithSig_revertsOnWrongEscrowId() public {
        uint256 id1 = _openToken(arbiter);
        uint256 id2 = _openToken(arbiter);
        bytes memory sigFor1 = _signRelease(buyerPk, id1); // authorization bound to id1, not id2
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(IAccess0x1Escrow.Access0x1Escrow__BadSignature.selector, id2)
        );
        escrow.releaseWithSig(id2, sigFor1);
    }

    function test_releaseWithSig_cannotReplayAfterRelease() public {
        uint256 id = _openToken(arbiter);
        bytes memory sig = _signRelease(buyerPk, id);
        vm.prank(relayer);
        escrow.releaseWithSig(id, sig);
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
    }

    function test_releaseWithSig_smartAccountBuyer_1271() public {
        // A deployed ERC-1271 smart account is the buyer; it validates via its signer EOA's key.
        SmartWallet1271 wallet = new SmartWallet1271(buyer); // signer = buyer EOA
        address w = address(wallet);
        usdc.mint(w, AMOUNT);
        vm.prank(w);
        usdc.approve(address(escrow), AMOUNT);
        vm.prank(w);
        uint256 id = escrow.open(seller, merchantId, address(usdc), AMOUNT, arbiter, deadline);

        bytes memory sig = _signRelease(buyerPk, id); // the wallet's signer EOA signs
        (uint256 fee, uint256 net) = _split(AMOUNT);
        vm.prank(relayer);
        escrow.releaseWithSig(id, sig);
        assertEq(usdc.balanceOf(seller), net);
        assertEq(usdc.balanceOf(treasury), fee);
    }

    /*//////////////////////////////////////////////////////////////
                       NEVER-BLOCKABLE / PULL-MAP
    //////////////////////////////////////////////////////////////*/

    function test_refundNeverBlocked_blocklistedBuyerQueues() public {
        // A USDC-style blocklist token: the buyer is blocklisted, so the refund push reverts — it must
        // queue to the pull-map and the lifecycle must still complete (law #5).
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

        bt.setBlocked(buyer, true); // the buyer can no longer receive

        vm.expectEmit(true, true, false, true, address(escrow));
        emit IAccess0x1Escrow.PayoutQueued(buyer, address(bt), AMOUNT);
        vm.prank(seller);
        escrow.cancel(id); // refund — must NOT revert despite the blocked recipient

        // The escrow resolved; the funds are queued, claimable by the buyer once unblocked.
        assertEq(uint8(escrow.escrowOf(id).state), uint8(IAccess0x1Escrow.EscrowState.REFUNDED));
        assertEq(escrow.withdrawable(buyer, address(bt)), AMOUNT);
        assertEq(bt.balanceOf(buyer), 0);

        bt.setBlocked(buyer, false);
        vm.prank(buyer);
        escrow.withdraw(address(bt));
        assertEq(bt.balanceOf(buyer), AMOUNT);
        assertEq(escrow.withdrawable(buyer, address(bt)), 0);
    }

    function test_releaseNeverBlocked_revertingNativeSellerQueues() public {
        // A seller contract that rejects ETH: the net push fails and queues; the release still completes.
        RevertingReceiver badSeller = new RevertingReceiver();
        vm.deal(buyer, NATIVE_AMOUNT);
        vm.prank(buyer);
        uint256 id = escrow.open{ value: NATIVE_AMOUNT }(
            address(badSeller), merchantId, address(0), NATIVE_AMOUNT, arbiter, deadline
        );
        (uint256 fee, uint256 net) = _split(NATIVE_AMOUNT);

        vm.prank(buyer);
        escrow.confirm(id);

        // The fee reached the (EOA) treasury; the net queued for the reverting seller.
        assertEq(treasury.balance, fee);
        assertEq(escrow.withdrawable(address(badSeller), address(0)), net);
        // The seller contract reverts on a NATIVE withdraw too, so the credit stays parked (still safe —
        // the escrow resolved and nothing is lost on-contract).
        assertEq(uint8(escrow.escrowOf(id).state), uint8(IAccess0x1Escrow.EscrowState.RELEASED));
    }

    function test_withdrawNative_queuesThenPaysOut() public {
        // A seller that initially rejects ETH: the native net push queues. Once the seller can receive,
        // a {withdraw} pays out the parked credit in full — the queued native credit is real + claimable.
        ToggleableReceiver tSeller = new ToggleableReceiver();
        vm.deal(buyer, NATIVE_AMOUNT);
        vm.prank(buyer);
        uint256 id = escrow.open{ value: NATIVE_AMOUNT }(
            address(tSeller), merchantId, address(0), NATIVE_AMOUNT, arbiter, deadline
        );
        (uint256 fee, uint256 net) = _split(NATIVE_AMOUNT);

        vm.prank(buyer);
        escrow.confirm(id); // net push fails (seller blocking) → queues; fee → EOA treasury

        assertEq(treasury.balance, fee);
        assertEq(escrow.withdrawable(address(tSeller), address(0)), net);
        assertEq(address(escrow).balance, net); // exactly the queued credit remains on-contract

        tSeller.setBlocking(false); // the seller can now receive
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IAccess0x1Escrow.Withdrawn(address(tSeller), address(0), net);
        vm.prank(address(tSeller));
        escrow.withdraw(address(0));

        assertEq(address(tSeller).balance, net);
        assertEq(escrow.withdrawable(address(tSeller), address(0)), 0);
        assertEq(address(escrow).balance, 0);
    }

    function test_withdrawNativeRevertsWhenClaimantRejects() public {
        // A claimant that permanently rejects ETH: the native withdraw send fails and the whole withdraw
        // reverts (the credit is restored, so it can be claimed once the claimant can receive).
        ToggleableReceiver tSeller = new ToggleableReceiver(); // stays blocking
        vm.deal(buyer, NATIVE_AMOUNT);
        vm.prank(buyer);
        uint256 id = escrow.open{ value: NATIVE_AMOUNT }(
            address(tSeller), merchantId, address(0), NATIVE_AMOUNT, arbiter, deadline
        );
        (, uint256 net) = _split(NATIVE_AMOUNT);
        vm.prank(buyer);
        escrow.confirm(id);

        vm.prank(address(tSeller));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__WithdrawFailed.selector, address(tSeller), net
            )
        );
        escrow.withdraw(address(0));
        // The credit survives the revert.
        assertEq(escrow.withdrawable(address(tSeller), address(0)), net);
    }

    function test_withdrawTokenAfterQueue() public {
        // Drive a queued token credit to an EOA-claimable address and pull it.
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

        bt.setBlocked(seller, true); // the seller cannot receive
        (uint256 fee, uint256 net) = _split(AMOUNT);
        vm.prank(buyer);
        escrow.confirm(id);
        // Fee reached the (unblocked) treasury; net queued for the blocked seller.
        assertEq(bt.balanceOf(treasury), fee);
        assertEq(escrow.withdrawable(seller, address(bt)), net);

        bt.setBlocked(seller, false);
        vm.prank(seller);
        escrow.withdraw(address(bt));
        assertEq(bt.balanceOf(seller), net);
    }

    function test_withdrawRevertsWhenNothingOwed() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Escrow.Access0x1Escrow__NothingToWithdraw.selector, address(usdc)
            )
        );
        escrow.withdraw(address(usdc));
    }

    /// @notice A USDT-style no-return-data token releases cleanly (SafeERC20-equivalent length handling).
    function test_releaseUsdtStyleTokenSucceeds() public {
        MockReturnsNothingToken usdt = new MockReturnsNothingToken();
        vm.startPrank(owner);
        router.setTokenAllowed(address(usdt), true);
        router.setPriceFeed(address(usdt), address(usdcFeed));
        vm.stopPrank();
        usdt.mint(buyer, AMOUNT);
        vm.startPrank(buyer);
        usdt.approve(address(escrow), AMOUNT);
        uint256 id = escrow.open(seller, merchantId, address(usdt), AMOUNT, arbiter, deadline);
        vm.stopPrank();

        (uint256 fee, uint256 net) = _split(AMOUNT);
        vm.prank(buyer);
        escrow.confirm(id);
        assertEq(usdt.balanceOf(seller), net);
        assertEq(usdt.balanceOf(treasury), fee);
        assertEq(usdt.balanceOf(address(escrow)), 0);
    }

    /*//////////////////////////////////////////////////////////////
                          UUPS UPGRADE / FREEZE
    //////////////////////////////////////////////////////////////*/

    function test_upgrade_preservesStateAndAddsFn() public {
        uint256 id = _openToken(arbiter); // id 1, OPEN, funded
        assertEq(escrow.nextEscrowId(), 2);

        address v2 = address(new Access0x1EscrowV2());
        vm.prank(admin);
        UUPSUpgradeable(address(escrow)).upgradeToAndCall(v2, "");

        assertEq(Access0x1EscrowV2(address(escrow)).version2Marker(), "v2");
        assertEq(address(escrow.router()), address(router));
        assertEq(escrow.nextEscrowId(), 2);
        IAccess0x1Escrow.Escrow memory e = escrow.escrowOf(id);
        assertEq(e.buyer, buyer);
        assertEq(e.amount, AMOUNT);
        assertEq(uint8(e.state), uint8(IAccess0x1Escrow.EscrowState.OPEN));
        // The held deposit survived the swap (storage lives in the proxy).
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        assertEq(OwnableUpgradeable(address(escrow)).owner(), admin);
    }

    function test_upgrade_revertNonOwner() public {
        address v2 = address(new Access0x1EscrowV2());
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger)
        );
        UUPSUpgradeable(address(escrow)).upgradeToAndCall(v2, "");
    }

    function test_freeze_renounceOwnershipBlocksUpgradeForever() public {
        vm.prank(admin);
        OwnableUpgradeable(address(escrow)).renounceOwnership();
        assertEq(OwnableUpgradeable(address(escrow)).owner(), address(0));

        address v2 = address(new Access0x1EscrowV2());
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, admin)
        );
        UUPSUpgradeable(address(escrow)).upgradeToAndCall(v2, "");
    }
}
