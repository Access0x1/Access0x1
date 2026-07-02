// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Receivables } from "../../src/Receivables.sol";
import { IReceivables } from "../../src/interfaces/IReceivables.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { FeeOnTransferToken } from "../mocks/FeeOnTransferToken.sol";
import { RevertingReceiver } from "../mocks/RevertingReceiver.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC721Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { IERC2981 } from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import { IERC4906 } from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {
    IERC721Metadata
} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    OwnableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @notice A trivial v2 implementation for the upgrade test: a subclass adding one view and no new
///         storage, so an upgrade to it must preserve all prior state (it would consume from `__gap`
///         if it added a slot).
contract ReceivablesV2 is Receivables {
    /// @notice A marker the v1 implementation does not expose — proves the new logic is live post-upgrade.
    function version2Marker() external pure returns (string memory) {
        return "v2";
    }
}

/// @notice A contract that cannot receive ERC-721s (no {onERC721Received}) — drives the `_safeMint`
///         rejection on {mint}.
contract NonReceiver {
    // intentionally empty: lacks onERC721Received, so a safeTransfer to it reverts
}

/// @notice A contract that CAN hold an ERC-721 (it implements {onERC721Received}) but REJECTS every
///         native transfer — a creditor that can own a receivable but whose net push fails, driving the
///         `Receivables__CreditorPushFailed` revert on the native settle path.
contract NftHolderRejectsEth {
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC721Received.selector;
    }

    receive() external payable {
        revert("no ether");
    }
}

/// @notice The {Receivables} unit suite: the whole surface in one fixture — initializer, mint (+ the
///         conduit invariant), the token + native settlement paths (with adversarial mocks), the
///         factoring transfer that moves the creditor, cancel, the terminal-state machine, royalties
///         (ERC-2981), the EIP-7572 contractURI, ERC-165, and the views. Asserts the contract composes
///         the router's fee-split exactly (net + fee == gross, zero custody, net → the holder at
///         settlement) without re-deriving it. Deployed BEHIND a UUPS proxy via the shared
///         {ProxyDeployer}; tail tests cover the UUPS upgrade + the permanent freeze.
contract ReceivablesTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    Receivables internal recv;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%

    address internal merchantOwner = makeAddr("merchantOwner");
    address internal feeRecipient = makeAddr("feeRecipient");
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5%
    bytes32 internal constant NAME_HASH = keccak256("acme");

    MockV3Aggregator internal nativeFeed; // ETH/USD, 8 dp
    MockV3Aggregator internal usdcFeed; // USDC/USD, 8 dp
    MockUSDC internal usdc; // 6 dp

    address internal creditor = makeAddr("creditor");
    address internal factor = makeAddr("factor"); // buys the receivable (becomes the new creditor)
    address internal debtor = makeAddr("debtor");
    address internal stranger = makeAddr("stranger");
    bytes32 internal constant ORDER = keccak256("order-1");

    /// @dev The contract (upgrade-admin) owner of the Receivables proxy — distinct from `merchantOwner`.
    address internal admin = makeAddr("admin");

    uint256 internal merchantId; // a conduit merchant: its router payout IS the Receivables contract

    function setUp() public virtual {
        vm.warp(1_700_000_000); // fixed, fresh time so the feeds stay inside the staleness window

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (owner, treasury, PLATFORM_FEE_BPS))
            )
        );
        address recvImpl = address(new Receivables());
        recv = Receivables(
            payable(deployProxy(
                    recvImpl,
                    abi.encodeCall(
                        Receivables.initialize,
                        (router, admin, "Access0x1 Receivables", "A0XR", "ipfs://collection")
                    )
                ))
        );

        nativeFeed = new MockV3Aggregator(8, 2000e8); // ETH/USD = $2000
        usdcFeed = new MockV3Aggregator(8, 1e8); // USDC/USD = $1
        usdc = new MockUSDC();
        vm.startPrank(owner);
        router.setPriceFeed(address(0), address(nativeFeed));
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        // The conduit merchant: its payout is the Receivables contract so the router's net returns here.
        vm.prank(merchantOwner);
        merchantId =
            router.registerMerchant(address(recv), feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);
    }

    /// @dev The two-leg split for the conduit merchant.
    function _fees(uint256 gross)
        internal
        pure
        returns (uint256 platformFee, uint256 merchantFee, uint256 net)
    {
        platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        net = gross - platformFee - merchantFee;
    }

    /// @dev Mint the default OPEN, $1000 USDC receivable to `creditor`, locked to `lockedDebtor`.
    function _mintToken(address lockedDebtor) internal returns (uint256 id) {
        vm.prank(merchantOwner);
        id = recv.mint(merchantId, creditor, lockedDebtor, address(usdc), 1000e8, 0, "ipfs://r1");
    }

    /// @dev Mint the default OPEN native receivable to `creditor`, locked to `lockedDebtor`.
    function _mintNative(address lockedDebtor) internal returns (uint256 id) {
        vm.prank(merchantOwner);
        id = recv.mint(merchantId, creditor, lockedDebtor, address(0), 1000e8, 0, "");
    }

    /*//////////////////////////////////////////////////////////////
                              INITIALIZE
    //////////////////////////////////////////////////////////////*/

    function test_initializeSetsRouterIdOwnerAndMetadata() public view {
        assertEq(address(recv.router()), address(router));
        assertEq(recv.nextTokenId(), 1); // 0 stays the unset sentinel
        assertEq(OwnableUpgradeable(address(recv)).owner(), admin);
        assertEq(IERC721Metadata(address(recv)).name(), "Access0x1 Receivables");
        assertEq(IERC721Metadata(address(recv)).symbol(), "A0XR");
        assertEq(recv.contractURI(), "ipfs://collection");
    }

    function test_initializeRevertsOnZeroRouter() public {
        address impl = address(new Receivables());
        vm.expectRevert(IReceivables.Receivables__ZeroAddress.selector);
        deployProxy(
            impl,
            abi.encodeCall(
                Receivables.initialize, (Access0x1Router(payable(address(0))), admin, "n", "s", "")
            )
        );
    }

    function test_initializeRevertsOnSecondCall() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        recv.initialize(router, admin, "n", "s", "");
    }

    /*//////////////////////////////////////////////////////////////
                                 MINT
    //////////////////////////////////////////////////////////////*/

    function test_mintStoresReceivableMintsNftAndEmits() public {
        vm.expectEmit(true, true, true, true, address(recv));
        emit IReceivables.ReceivableMinted(
            1, merchantId, creditor, debtor, address(usdc), 1000e8, 123
        );
        vm.prank(merchantOwner);
        uint256 id =
            recv.mint(merchantId, creditor, debtor, address(usdc), 1000e8, 123, "ipfs://r1");

        assertEq(id, 1);
        IReceivables.Receivable memory r = recv.receivableOf(id);
        assertEq(r.merchantId, merchantId);
        assertEq(r.debtor, debtor);
        assertEq(r.token, address(usdc));
        assertEq(r.amountUsd8, 1000e8);
        assertEq(r.dueBy, 123);
        assertEq(uint8(r.status), uint8(IReceivables.Status.OPEN));
        // The NFT: the creditor holds it, and it carries the per-token URI.
        assertEq(IERC721(address(recv)).ownerOf(id), creditor);
        assertEq(recv.creditorOf(id), creditor);
        assertEq(IERC721Metadata(address(recv)).tokenURI(id), "ipfs://r1");
        assertEq(recv.nextTokenId(), 2);
        assertTrue(recv.isPayable(id));
    }

    function test_mintEmitsMetadataUpdateForUri() public {
        // ERC-4906: setting the token URI during mint emits MetadataUpdate(tokenId).
        vm.expectEmit(true, false, false, true, address(recv));
        emit IERC4906.MetadataUpdate(1);
        vm.prank(merchantOwner);
        recv.mint(merchantId, creditor, debtor, address(usdc), 1000e8, 0, "ipfs://r1");
    }

    function test_mintIncrementsId() public {
        assertEq(_mintToken(debtor), 1);
        assertEq(_mintToken(debtor), 2);
    }

    function test_mintRevertsOnZeroCreditor() public {
        vm.prank(merchantOwner);
        vm.expectRevert(IReceivables.Receivables__ZeroAddress.selector);
        recv.mint(merchantId, address(0), debtor, address(usdc), 1000e8, 0, "");
    }

    function test_mintRevertsOnZeroAmount() public {
        vm.prank(merchantOwner);
        vm.expectRevert(IReceivables.Receivables__ZeroAmount.selector);
        recv.mint(merchantId, creditor, debtor, address(usdc), 0, 0, "");
    }

    function test_mintRevertsWhenNotMerchantOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__NotMerchantOwner.selector, merchantId, stranger
            )
        );
        recv.mint(merchantId, creditor, debtor, address(usdc), 1000e8, 0, "");
    }

    function test_mintRevertsForUnknownMerchant() public {
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__NotMerchantOwner.selector, 999, merchantOwner
            )
        );
        recv.mint(999, creditor, debtor, address(usdc), 1000e8, 0, "");
    }

    function test_mintRevertsWhenMerchantPayoutNotConduit() public {
        // A merchant whose payout is NOT the Receivables contract cannot be used — its net would never
        // return here to forward to the holder.
        address otherPayout = makeAddr("otherPayout");
        vm.prank(merchantOwner);
        uint256 badMerchant =
            router.registerMerchant(otherPayout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__MerchantPayoutNotConduit.selector,
                badMerchant,
                otherPayout
            )
        );
        recv.mint(badMerchant, creditor, debtor, address(usdc), 1000e8, 0, "");
    }

    function test_mintRevertsWhenCreditorCannotReceiveNft() public {
        NonReceiver bad = new NonReceiver();
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(bad))
        );
        recv.mint(merchantId, address(bad), debtor, address(usdc), 1000e8, 0, "");
    }

    function test_mintAllowsUnknownTokenAtIssueTime() public {
        // Token validity is checked at pay time (router.quote), not mint.
        MockUSDC other = new MockUSDC();
        vm.prank(merchantOwner);
        uint256 id = recv.mint(merchantId, creditor, debtor, address(other), 1000e8, 0, "");
        assertTrue(recv.isPayable(id));
    }

    /*//////////////////////////////////////////////////////////////
                                 PAY
    //////////////////////////////////////////////////////////////*/

    function test_paySettlesNetToHolderThroughRouterFeeSplit() public {
        uint256 id = _mintToken(debtor);
        uint256 gross = router.quote(merchantId, address(usdc), 1000e8);
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _fees(gross);

        usdc.mint(debtor, gross);
        vm.startPrank(debtor);
        usdc.approve(address(recv), gross);
        vm.expectEmit(true, true, true, true, address(recv));
        emit IReceivables.ReceivableSettled(id, debtor, creditor, address(usdc), gross, net, ORDER);
        recv.pay(id, ORDER);
        vm.stopPrank();

        // Net → the creditor (holder at settlement); the router fee legs landed exactly.
        assertEq(usdc.balanceOf(creditor), net);
        assertEq(usdc.balanceOf(treasury), platformFee);
        assertEq(usdc.balanceOf(feeRecipient), merchantFee);
        assertEq(net + platformFee + merchantFee, gross); // net + fee == gross
        // Zero custody at BOTH hops.
        assertEq(usdc.balanceOf(address(recv)), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
        // Terminal state + the token is burned (no double-pay).
        assertEq(uint8(recv.receivableOf(id).status), uint8(IReceivables.Status.SETTLED));
        assertFalse(recv.isPayable(id));
        _assertBurned(id);
        assertEq(usdc.allowance(address(recv), address(router)), 0); // no dangling allowance
    }

    function test_payAfterFactoringPaysTheNewHolder() public {
        // The KEY property: the business factors (sells) the receivable, then the debtor pays, and the
        // FACTOR (new holder) — not the original creditor — receives the net.
        uint256 id = _mintToken(debtor);
        vm.prank(creditor);
        IERC721(address(recv)).transferFrom(creditor, factor, id); // factoring assignment

        uint256 gross = router.quote(merchantId, address(usdc), 1000e8);
        (,, uint256 net) = _fees(gross);
        usdc.mint(debtor, gross);
        vm.startPrank(debtor);
        usdc.approve(address(recv), gross);
        vm.expectEmit(true, true, true, true, address(recv));
        emit IReceivables.ReceivableSettled(id, debtor, factor, address(usdc), gross, net, ORDER);
        recv.pay(id, ORDER);
        vm.stopPrank();

        assertEq(usdc.balanceOf(factor), net); // the FACTOR was paid
        assertEq(usdc.balanceOf(creditor), 0); // the original creditor was NOT
    }

    function test_payByAnyoneWhenDebtorUnlocked() public {
        uint256 id = _mintToken(address(0)); // anyone may settle
        uint256 gross = router.quote(merchantId, address(usdc), 1000e8);
        (,, uint256 net) = _fees(gross);
        usdc.mint(stranger, gross);
        vm.startPrank(stranger);
        usdc.approve(address(recv), gross);
        recv.pay(id, ORDER);
        vm.stopPrank();
        assertEq(usdc.balanceOf(creditor), net);
        assertEq(uint8(recv.receivableOf(id).status), uint8(IReceivables.Status.SETTLED));
    }

    function test_payRevertsWhenLockedAndWrongDebtor() public {
        uint256 id = _mintToken(debtor); // locked to `debtor`
        usdc.mint(stranger, 2000e6);
        vm.startPrank(stranger);
        usdc.approve(address(recv), 2000e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__NotAuthorizedDebtor.selector, id, debtor, stranger
            )
        );
        recv.pay(id, ORDER);
        vm.stopPrank();
    }

    function test_paySecondTimeRevertsNotOpenAndTokenGone() public {
        uint256 id = _mintToken(address(0));
        uint256 gross = router.quote(merchantId, address(usdc), 1000e8);
        usdc.mint(debtor, gross * 2);
        vm.startPrank(debtor);
        usdc.approve(address(recv), gross * 2);
        recv.pay(id, ORDER);
        // Second pay: receivable is SETTLED (and burned) → revert (single-settlement guard).
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__NotOpen.selector, id, IReceivables.Status.SETTLED
            )
        );
        recv.pay(id, ORDER);
        vm.stopPrank();
    }

    function test_payRevertsOnUnknownReceivable() public {
        vm.prank(debtor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__NotOpen.selector, 42, IReceivables.Status.NONE
            )
        );
        recv.pay(42, ORDER);
    }

    function test_payRevertsWhenCancelled() public {
        uint256 id = _mintToken(address(0));
        vm.prank(merchantOwner);
        recv.cancel(id);
        usdc.mint(debtor, 2000e6);
        vm.startPrank(debtor);
        usdc.approve(address(recv), 2000e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__NotOpen.selector, id, IReceivables.Status.CANCELLED
            )
        );
        recv.pay(id, ORDER);
        vm.stopPrank();
    }

    function test_payRevertsOnNativeReceivableWrongPath() public {
        uint256 id = _mintNative(address(0));
        vm.prank(debtor);
        vm.expectRevert(
            abi.encodeWithSelector(IReceivables.Receivables__WrongPayPath.selector, id, address(0))
        );
        recv.pay(id, ORDER);
    }

    function test_payRevertsOnFeeOnTransferToken() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        vm.startPrank(owner);
        router.setTokenAllowed(address(fot), true);
        router.setPriceFeed(address(fot), address(usdcFeed)); // $1
        vm.stopPrank();

        vm.prank(merchantOwner);
        uint256 id = recv.mint(merchantId, creditor, debtor, address(fot), 1000e8, 0, "");
        uint256 gross = router.quote(merchantId, address(fot), 1000e8);
        uint256 received = gross - gross / 100; // token skims 1%
        fot.mint(debtor, gross);
        vm.startPrank(debtor);
        fot.approve(address(recv), gross);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__FeeOnTransferToken.selector, gross, received
            )
        );
        recv.pay(id, ORDER);
        vm.stopPrank();
    }

    function test_payRevertsOnStalePrice() public {
        uint256 id = _mintToken(debtor);
        usdcFeed.setRoundData(2, 1e8, block.timestamp, block.timestamp - 3601, 2); // > 1h stale
        usdc.mint(debtor, 2000e6);
        vm.startPrank(debtor);
        usdc.approve(address(recv), 2000e6);
        vm.expectRevert(); // OracleLib__StalePrice bubbles through router.quote
        recv.pay(id, ORDER);
        vm.stopPrank();
    }

    function test_payRevertsWhenRouterMerchantInactiveAndRollsBack() public {
        uint256 id = _mintToken(debtor);
        vm.prank(merchantOwner);
        router.updateMerchant(merchantId, address(recv), feeRecipient, MERCHANT_FEE_BPS, false);
        usdc.mint(debtor, 2000e6);
        vm.startPrank(debtor);
        usdc.approve(address(recv), 2000e6);
        vm.expectRevert(); // router rejects an inactive merchant; the flip-to-SETTLED + burn roll back
        recv.pay(id, ORDER);
        vm.stopPrank();
        // The whole tx reverted, so the receivable is still OPEN, the NFT still exists + held by creditor.
        assertTrue(recv.isPayable(id));
        assertEq(IERC721(address(recv)).ownerOf(id), creditor);
    }

    function test_pay_revertsWhenPayoutRepointedAwayFromConduit() public {
        // The CONDUIT-REPOINT theft guard. mint() checks the merchant's router `payout` is this contract,
        // but the merchant OWNER can `updateMerchant` to repoint payout to ANY address AFTER the mint,
        // with the merchant still ACTIVE. Without a LIVE re-check at settle, the router would push the net
        // to the NEW payout (e.g. the merchant), pay() would measure a balance delta of 0 and forward 0 to
        // the creditor, and the NFT would already be burned — the creditor robbed, the money swallowed.
        // The guard re-reads the live payout BEFORE the burn and reverts, so nothing settles to the wrong
        // address: the creditor keeps the claim, the token still exists.
        uint256 id = _mintToken(debtor);

        // The merchant owner repoints payout to a third address (still ACTIVE — this is the attack).
        address stolenPayout = makeAddr("stolenPayout");
        vm.prank(merchantOwner);
        router.updateMerchant(merchantId, stolenPayout, feeRecipient, MERCHANT_FEE_BPS, true);

        uint256 gross = router.quote(merchantId, address(usdc), 1000e8);
        usdc.mint(debtor, gross);
        vm.startPrank(debtor);
        usdc.approve(address(recv), gross);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__MerchantPayoutNotConduit.selector,
                merchantId,
                stolenPayout
            )
        );
        recv.pay(id, ORDER);
        vm.stopPrank();

        // Nothing settled: the creditor was NOT robbed, the router pushed nowhere, the NFT still exists.
        assertEq(usdc.balanceOf(creditor), 0);
        assertEq(usdc.balanceOf(stolenPayout), 0);
        assertTrue(recv.isPayable(id));
        assertEq(IERC721(address(recv)).ownerOf(id), creditor);
        assertEq(uint8(recv.receivableOf(id).status), uint8(IReceivables.Status.OPEN));
    }

    /*//////////////////////////////////////////////////////////////
                              PAY NATIVE
    //////////////////////////////////////////////////////////////*/

    function test_payNativeSettlesNetToHolderThroughRouterFeeSplit() public {
        uint256 id = _mintNative(debtor);
        uint256 gross = router.quote(merchantId, address(0), 1000e8);
        (uint256 platformFee, uint256 merchantFee, uint256 net) = _fees(gross);

        vm.deal(debtor, gross);
        vm.expectEmit(true, true, true, true, address(recv));
        emit IReceivables.ReceivableSettled(id, debtor, creditor, address(0), gross, net, ORDER);
        vm.prank(debtor);
        recv.payNative{ value: gross }(id, ORDER);

        assertEq(creditor.balance, net); // net → the holder at settlement
        assertEq(treasury.balance, platformFee);
        assertEq(feeRecipient.balance, merchantFee);
        assertEq(net + platformFee + merchantFee, gross);
        assertEq(address(recv).balance, 0); // zero custody
        assertEq(address(router).balance, 0);
        assertEq(uint8(recv.receivableOf(id).status), uint8(IReceivables.Status.SETTLED));
        _assertBurned(id);
    }

    function test_payNativeAfterFactoringPaysTheNewHolder() public {
        uint256 id = _mintNative(debtor);
        vm.prank(creditor);
        IERC721(address(recv)).transferFrom(creditor, factor, id);

        uint256 gross = router.quote(merchantId, address(0), 1000e8);
        (,, uint256 net) = _fees(gross);
        vm.deal(debtor, gross);
        vm.prank(debtor);
        recv.payNative{ value: gross }(id, ORDER);
        assertEq(factor.balance, net);
        assertEq(creditor.balance, 0);
    }

    function test_payNativeRefundsExcess() public {
        uint256 id = _mintNative(debtor);
        uint256 gross = router.quote(merchantId, address(0), 1000e8);
        vm.deal(debtor, 1 ether + gross);
        vm.prank(debtor);
        recv.payNative{ value: gross + 0.3 ether }(id, ORDER);
        // Net effect on the debtor: paid exactly gross (the 0.3 ether excess was refunded).
        assertEq(debtor.balance, 1 ether);
        assertEq(address(recv).balance, 0);
    }

    function test_payNativeRevertsUnderpaid() public {
        uint256 id = _mintNative(debtor);
        uint256 gross = router.quote(merchantId, address(0), 1000e8);
        vm.deal(debtor, gross);
        vm.prank(debtor);
        vm.expectRevert(
            abi.encodeWithSelector(IReceivables.Receivables__Underpaid.selector, gross, gross - 1)
        );
        recv.payNative{ value: gross - 1 }(id, ORDER);
    }

    function test_payNativeRevertsOnTokenReceivableWrongPath() public {
        uint256 id = _mintToken(address(0));
        vm.deal(debtor, 1 ether);
        vm.prank(debtor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__WrongPayPath.selector, id, address(usdc)
            )
        );
        recv.payNative{ value: 1 ether }(id, ORDER);
    }

    function test_payNativeRevertsWhenLockedAndWrongDebtor() public {
        uint256 id = _mintNative(debtor);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__NotAuthorizedDebtor.selector, id, debtor, stranger
            )
        );
        recv.payNative{ value: 1 ether }(id, ORDER);
    }

    function test_payNativeSecondTimeRevertsNotOpen() public {
        uint256 id = _mintNative(address(0));
        uint256 gross = router.quote(merchantId, address(0), 1000e8);
        vm.deal(debtor, gross * 2);
        vm.startPrank(debtor);
        recv.payNative{ value: gross }(id, ORDER);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__NotOpen.selector, id, IReceivables.Status.SETTLED
            )
        );
        recv.payNative{ value: gross }(id, ORDER);
        vm.stopPrank();
    }

    function test_payNativeRevertsWhenRefundFails() public {
        uint256 id = _mintNative(address(0)); // unlocked, so the reverting receiver may pay
        uint256 gross = router.quote(merchantId, address(0), 1000e8);
        RevertingReceiver badPayer = new RevertingReceiver();
        vm.deal(address(badPayer), 1 ether);
        vm.prank(address(badPayer));
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__NativeRefundFailed.selector, address(badPayer), 0.3 ether
            )
        );
        recv.payNative{ value: gross + 0.3 ether }(id, ORDER);
    }

    function test_payNativeRevertsWhenCreditorRejectsNet() public {
        // A contract creditor that holds the NFT fine but rejects native value: the net push fails and
        // the whole settlement reverts (the burn rolls back), so nothing settles — never a silent loss.
        NftHolderRejectsEth badCreditor = new NftHolderRejectsEth();
        vm.prank(merchantOwner);
        uint256 id =
            recv.mint(merchantId, address(badCreditor), address(0), address(0), 1000e8, 0, "");
        uint256 gross = router.quote(merchantId, address(0), 1000e8);
        (,, uint256 net) = _fees(gross);
        vm.deal(debtor, gross);
        vm.prank(debtor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__CreditorPushFailed.selector, address(badCreditor), net
            )
        );
        recv.payNative{ value: gross }(id, ORDER);
        // Rolled back: still OPEN, still held by the (contract) creditor.
        assertTrue(recv.isPayable(id));
        assertEq(IERC721(address(recv)).ownerOf(id), address(badCreditor));
    }

    function test_payNative_revertsWhenPayoutRepointedAwayFromConduit() public {
        // The native mirror of the conduit-repoint theft guard (see test_pay_revertsWhen...). A merchant
        // owner repoints payout to a third address after mint, still active; without the live re-check the
        // router would push the net there, the balance-delta net would read 0, and the burned NFT's holder
        // would get nothing. The guard reverts before the burn, so the creditor keeps the claim.
        uint256 id = _mintNative(debtor);

        address stolenPayout = makeAddr("stolenPayout");
        vm.prank(merchantOwner);
        router.updateMerchant(merchantId, stolenPayout, feeRecipient, MERCHANT_FEE_BPS, true);

        uint256 gross = router.quote(merchantId, address(0), 1000e8);
        vm.deal(debtor, gross);
        vm.prank(debtor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__MerchantPayoutNotConduit.selector,
                merchantId,
                stolenPayout
            )
        );
        recv.payNative{ value: gross }(id, ORDER);

        // Nothing settled: creditor not robbed, no push to the stolen payout, the NFT still exists + OPEN.
        assertEq(creditor.balance, 0);
        assertEq(stolenPayout.balance, 0);
        assertTrue(recv.isPayable(id));
        assertEq(IERC721(address(recv)).ownerOf(id), creditor);
        assertEq(uint8(recv.receivableOf(id).status), uint8(IReceivables.Status.OPEN));
    }

    /*//////////////////////////////////////////////////////////////
                                CANCEL
    //////////////////////////////////////////////////////////////*/

    function test_cancelByMerchantOwnerBurnsToken() public {
        uint256 id = _mintToken(address(0));
        vm.expectEmit(true, false, false, false, address(recv));
        emit IReceivables.ReceivableCancelled(id);
        vm.prank(merchantOwner);
        recv.cancel(id);
        assertEq(uint8(recv.receivableOf(id).status), uint8(IReceivables.Status.CANCELLED));
        assertFalse(recv.isPayable(id));
        _assertBurned(id);
    }

    function test_cancelRevertsWhenNotMerchantOwner() public {
        uint256 id = _mintToken(address(0));
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__NotMerchantOwner.selector, merchantId, stranger
            )
        );
        recv.cancel(id);
    }

    function test_cancelRevertsOnUnknownReceivable() public {
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__NotOpen.selector, 7, IReceivables.Status.NONE
            )
        );
        recv.cancel(7);
    }

    function test_cancelRevertsWhenAlreadySettled() public {
        uint256 id = _mintToken(address(0));
        uint256 gross = router.quote(merchantId, address(usdc), 1000e8);
        usdc.mint(debtor, gross);
        vm.startPrank(debtor);
        usdc.approve(address(recv), gross);
        recv.pay(id, ORDER);
        vm.stopPrank();
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__NotOpen.selector, id, IReceivables.Status.SETTLED
            )
        );
        recv.cancel(id);
    }

    function test_cancelRevertsWhenAlreadyCancelled() public {
        uint256 id = _mintToken(address(0));
        vm.startPrank(merchantOwner);
        recv.cancel(id);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__NotOpen.selector, id, IReceivables.Status.CANCELLED
            )
        );
        recv.cancel(id);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                          ROYALTY (ERC-2981)
    //////////////////////////////////////////////////////////////*/

    function test_setDefaultRoyaltyAppliesToAllTokens() public {
        address royaltyDest = makeAddr("royaltyDest");
        vm.prank(admin);
        recv.setDefaultRoyalty(royaltyDest, 500); // 5%
        uint256 id = _mintToken(debtor);
        (address rcv, uint256 amount) = IERC2981(address(recv)).royaltyInfo(id, 1000e6);
        assertEq(rcv, royaltyDest);
        assertEq(amount, 1000e6 * 500 / 10_000); // 5%
    }

    function test_setTokenRoyaltyOverridesDefault() public {
        address def = makeAddr("def");
        address per = makeAddr("per");
        uint256 id = _mintToken(debtor);
        vm.startPrank(admin);
        recv.setDefaultRoyalty(def, 500);
        recv.setTokenRoyalty(id, per, 250); // 2.5% for this token
        vm.stopPrank();
        (address rcv, uint256 amount) = IERC2981(address(recv)).royaltyInfo(id, 1000e6);
        assertEq(rcv, per);
        assertEq(amount, 1000e6 * 250 / 10_000);
    }

    function test_setDefaultRoyaltyZeroReceiverClears() public {
        address royaltyDest = makeAddr("royaltyDest");
        vm.startPrank(admin);
        recv.setDefaultRoyalty(royaltyDest, 500);
        recv.setDefaultRoyalty(address(0), 0); // clear
        vm.stopPrank();
        uint256 id = _mintToken(debtor);
        (address rcv, uint256 amount) = IERC2981(address(recv)).royaltyInfo(id, 1000e6);
        assertEq(rcv, address(0));
        assertEq(amount, 0);
    }

    function test_setTokenRoyaltyZeroReceiverResetsToDefault() public {
        address def = makeAddr("def");
        address per = makeAddr("per");
        uint256 id = _mintToken(debtor);
        vm.startPrank(admin);
        recv.setDefaultRoyalty(def, 500);
        recv.setTokenRoyalty(id, per, 250);
        recv.setTokenRoyalty(id, address(0), 0); // reset → falls back to default
        vm.stopPrank();
        (address rcv, uint256 amount) = IERC2981(address(recv)).royaltyInfo(id, 1000e6);
        assertEq(rcv, def);
        assertEq(amount, 1000e6 * 500 / 10_000);
    }

    function test_setDefaultRoyaltyRevertsWhenTooHigh() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__RoyaltyTooHigh.selector, 10_001, 10_000
            )
        );
        recv.setDefaultRoyalty(makeAddr("d"), 10_001);
    }

    function test_setTokenRoyaltyRevertsWhenTooHigh() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__RoyaltyTooHigh.selector, 10_001, 10_000
            )
        );
        recv.setTokenRoyalty(1, makeAddr("d"), 10_001);
    }

    function test_setRoyaltyRevertsWhenNotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger)
        );
        recv.setDefaultRoyalty(makeAddr("d"), 500);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger)
        );
        recv.setTokenRoyalty(1, makeAddr("d"), 500);
    }

    /*//////////////////////////////////////////////////////////////
                          CONTRACT URI (EIP-7572)
    //////////////////////////////////////////////////////////////*/

    function test_setContractURIByOwnerEmits() public {
        vm.expectEmit(false, false, false, true, address(recv));
        emit IReceivables.ContractURIUpdated("ipfs://new");
        vm.prank(admin);
        recv.setContractURI("ipfs://new");
        assertEq(recv.contractURI(), "ipfs://new");
    }

    function test_setContractURIRevertsWhenNotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger)
        );
        recv.setContractURI("ipfs://x");
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    function test_supportsInterfaces() public view {
        assertTrue(IERC721(address(recv)).supportsInterface(type(IERC721).interfaceId));
        assertTrue(IERC721(address(recv)).supportsInterface(type(IERC721Metadata).interfaceId));
        assertTrue(IERC721(address(recv)).supportsInterface(type(IERC2981).interfaceId));
        // ERC-4906 id (bytes4(0x49064906)) advertised via the URI-storage base.
        assertTrue(IERC721(address(recv)).supportsInterface(bytes4(0x49064906)));
        assertTrue(IERC721(address(recv)).supportsInterface(type(IERC165).interfaceId));
        assertFalse(IERC721(address(recv)).supportsInterface(bytes4(0xffffffff)));
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function test_receivableOfUnknownIsZeroed() public view {
        IReceivables.Receivable memory r = recv.receivableOf(123);
        assertEq(r.merchantId, 0);
        assertEq(uint8(r.status), uint8(IReceivables.Status.NONE));
        assertFalse(recv.isPayable(123));
    }

    function test_creditorOfRevertsForUnknown() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 999));
        recv.creditorOf(999);
    }

    /*//////////////////////////////////////////////////////////////
                          UUPS UPGRADE / FREEZE
    //////////////////////////////////////////////////////////////*/

    function test_upgrade_preservesStateAndAddsFn() public {
        uint256 id = _mintToken(debtor); // id 1, OPEN, held by creditor
        assertEq(recv.nextTokenId(), 2);

        address v2 = address(new ReceivablesV2());
        vm.prank(admin);
        UUPSUpgradeable(address(recv)).upgradeToAndCall(v2, "");

        assertEq(ReceivablesV2(payable(address(recv))).version2Marker(), "v2");

        // All prior state survived the implementation swap (storage is in the proxy).
        assertEq(address(recv.router()), address(router));
        assertEq(recv.nextTokenId(), 2);
        assertEq(recv.contractURI(), "ipfs://collection");
        IReceivables.Receivable memory r = recv.receivableOf(id);
        assertEq(r.merchantId, merchantId);
        assertEq(uint8(r.status), uint8(IReceivables.Status.OPEN));
        assertEq(IERC721(address(recv)).ownerOf(id), creditor);
        assertEq(OwnableUpgradeable(address(recv)).owner(), admin);
    }

    function test_upgrade_revertNonOwner() public {
        address v2 = address(new ReceivablesV2());
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger)
        );
        UUPSUpgradeable(address(recv)).upgradeToAndCall(v2, "");
    }

    function test_freeze_renounceOwnershipBlocksUpgradeForever() public {
        vm.prank(admin);
        OwnableUpgradeable(address(recv)).renounceOwnership();
        assertEq(OwnableUpgradeable(address(recv)).owner(), address(0));

        address v2 = address(new ReceivablesV2());
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, admin)
        );
        UUPSUpgradeable(address(recv)).upgradeToAndCall(v2, "");
    }

    /// @dev Assert a tokenId no longer exists (was burned): `ownerOf` reverts with the standard
    ///      ERC-721 nonexistent-token error.
    function _assertBurned(uint256 id) internal {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        IERC721(address(recv)).ownerOf(id);
    }
}
