// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { GaslessPayIn } from "../../src/GaslessPayIn.sol";
import { IGaslessPayIn } from "../../src/interfaces/IGaslessPayIn.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDCGasless } from "../mocks/MockUSDCGasless.sol";
import { SmartWallet1271 } from "../mocks/SmartWallet1271.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    OwnableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @notice A trivial v2 implementation for the upgrade test: adds one view, no new storage, so an
///         upgrade to it must preserve all prior state (proving the proxy keeps every slot).
contract GaslessPayInV2 is GaslessPayIn {
    function version2Marker() external pure returns (string memory) {
        return "v2";
    }
}

/// @notice An EIP-3009 USDC stand-in that SKIMS 1% on the authorized transfer — the fee-on-transfer
///         attack on the direct-pull (3009) rail. The contract must receive less than the gross and
///         revert {GaslessPayIn__PullShortfall} before any routing happens. Named distinctly from the
///         repo's existing {FeeOnTransfer3009} mock (a `receiveWithAuthorization` variant) so the two
///         never collide as artifacts.
contract FeeSkimGasless3009 is MockUSDCGasless {
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100; // 1% skim
            super._update(from, to, value - fee);
            if (fee > 0) super._update(from, address(0xdead), fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @notice The GaslessPayIn unit suite: the full surface in one fixture — initializer, the three gasless
///         rails (EIP-2612 permit, ERC-7597 bytes-permit incl. an ERC-1271 smart-account buyer, EIP-3009
///         transferWithAuthorization), the quote pass-through, every revert path (zero buyer, low permit
///         value, 3009 value mismatch, fee-on-transfer shortfall, token replay), and the UUPS
///         upgrade/freeze. Asserts each rail settles THROUGH the router's live fee-split (net → merchant,
///         fee → treasury, net + fee == gross) and that the contract retains ZERO token balance after
///         every settled tx — the money invariant. Deployed BEHIND a UUPS proxy via {ProxyDeployer}.
contract GaslessPayInTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    GaslessPayIn internal payIn;

    address internal owner = makeAddr("owner"); // router admin
    address internal admin = makeAddr("admin"); // payIn upgrade admin
    address internal treasury = makeAddr("treasury");
    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%

    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient");
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5%
    bytes32 internal constant NAME_HASH = keccak256("acme");

    MockV3Aggregator internal usdcFeed;
    MockUSDCGasless internal usdc; // 6 dp gasless USDC

    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");

    address internal buyer;
    uint256 internal buyerPk;

    uint256 internal merchantId;
    uint256 internal constant USD_AMOUNT = 100e8; // $100, 8 decimals
    bytes32 internal constant ORDER_ID = keccak256("order-1");

    // The token's EIP-712 typehashes (mirrored from the mock for digest construction).
    bytes32 internal constant PERMIT_TYPEHASH = keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
    );
    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        (buyer, buyerPk) = makeAddrAndKey("buyer");

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (owner, treasury, PLATFORM_FEE_BPS))
            )
        );

        address payInImpl = address(new GaslessPayIn());
        payIn = GaslessPayIn(
            deployProxy(payInImpl, abi.encodeCall(GaslessPayIn.initialize, (admin, router)))
        );

        usdcFeed = new MockV3Aggregator(8, 1e8); // $1 per USDC
        usdc = new MockUSDCGasless();
        vm.startPrank(owner);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);
    }

    /*//////////////////////////////////////////////////////////////
                              SIGNING HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev The token's EIP-712 domain separator (the mock uses name "USD Coin", version "2").
    function _tokenDomain(address token) internal view returns (bytes32) {
        return MockUSDCGasless(token).DOMAIN_SEPARATOR();
    }

    function _permitDigest(
        address token,
        address ownerAddr,
        address spender,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, ownerAddr, spender, value, nonce, deadline)
        );
        return MessageHashUtils.toTypedDataHash(_tokenDomain(token), structHash);
    }

    function _authDigest(
        address token,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        return MessageHashUtils.toTypedDataHash(_tokenDomain(token), structHash);
    }

    function _split(uint256 gross)
        internal
        pure
        returns (uint256 platformFee, uint256 merchantFee, uint256 net)
    {
        platformFee = gross * PLATFORM_FEE_BPS / 10_000;
        merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        net = gross - platformFee - merchantFee;
    }

    /*//////////////////////////////////////////////////////////////
                              INITIALIZE
    //////////////////////////////////////////////////////////////*/

    function test_initializeSetsRouterAndOwner() public view {
        assertEq(payIn.router(), address(router));
        assertEq(address(payIn.routerContract()), address(router));
        assertEq(OwnableUpgradeable(address(payIn)).owner(), admin);
    }

    function test_initializeRevertsOnZeroRouter() public {
        address impl = address(new GaslessPayIn());
        vm.expectRevert(IGaslessPayIn.GaslessPayIn__ZeroAddress.selector);
        deployProxy(
            impl,
            abi.encodeCall(GaslessPayIn.initialize, (admin, Access0x1Router(payable(address(0)))))
        );
    }

    function test_initializeRevertsOnSecondCall() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        payIn.initialize(admin, router);
    }

    function test_quoteGrossMatchesRouter() public view {
        uint256 expected = router.quote(merchantId, address(usdc), USD_AMOUNT);
        assertEq(payIn.quoteGross(merchantId, address(usdc), USD_AMOUNT), expected);
        assertEq(expected, 100e6); // $100 at $1/USDC, 6 decimals
    }

    /*//////////////////////////////////////////////////////////////
                        EIP-2612 PERMIT RAIL
    //////////////////////////////////////////////////////////////*/

    function test_payInWithPermit_settlesThroughFeeSplit() public {
        uint256 gross = router.quote(merchantId, address(usdc), USD_AMOUNT);
        usdc.mint(buyer, gross);

        bytes32 digest = _permitDigest(
            address(usdc), buyer, address(payIn), gross, 0, block.timestamp + 1 hours
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);

        (uint256 platformFee, uint256 merchantFee, uint256 net) = _split(gross);

        vm.expectEmit(true, true, true, true, address(payIn));
        emit IGaslessPayIn.GaslessPayInSettled(
            merchantId,
            buyer,
            relayer,
            address(usdc),
            gross,
            IGaslessPayIn.Rail.PERMIT_2612,
            ORDER_ID
        );
        vm.prank(relayer); // ANY relayer submits; the buyer never sends a tx
        payIn.payInWithPermit(
            merchantId,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Permit({ value: gross, deadline: block.timestamp + 1 hours }),
            v,
            r,
            s,
            ORDER_ID
        );

        // net → merchant payout, platform fee → treasury, merchant fee → feeRecipient; zero custody.
        assertEq(usdc.balanceOf(payout), net);
        assertEq(usdc.balanceOf(treasury), platformFee);
        assertEq(usdc.balanceOf(feeRecipient), merchantFee);
        assertEq(net + platformFee + merchantFee, gross);
        assertEq(usdc.balanceOf(address(payIn)), 0); // THE MONEY INVARIANT — no residue
        assertEq(usdc.balanceOf(buyer), 0);
        // No dangling router allowance.
        assertEq(usdc.allowance(address(payIn), address(router)), 0);
    }

    function test_payInWithPermit_allowanceCeilingPullsOnlyGross() public {
        // Buyer signs a permit for MORE than the gross (a ceiling); only the gross is pulled.
        uint256 gross = router.quote(merchantId, address(usdc), USD_AMOUNT);
        uint256 ceiling = gross * 2;
        usdc.mint(buyer, ceiling);

        bytes32 digest = _permitDigest(
            address(usdc), buyer, address(payIn), ceiling, 0, block.timestamp + 1 hours
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);

        vm.prank(relayer);
        payIn.payInWithPermit(
            merchantId,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Permit({ value: ceiling, deadline: block.timestamp + 1 hours }),
            v,
            r,
            s,
            ORDER_ID
        );

        assertEq(usdc.balanceOf(buyer), ceiling - gross); // only the gross left the buyer
        assertEq(usdc.balanceOf(address(payIn)), 0);
        // The contract reset its own router allowance, but the buyer's residual allowance to the
        // contract is harmless (only the buyer can grant it; nothing pulls beyond an explicit gross).
        assertEq(usdc.allowance(address(payIn), address(router)), 0);
    }

    function test_payInWithPermit_revertsOnZeroBuyer() public {
        vm.prank(relayer);
        vm.expectRevert(IGaslessPayIn.GaslessPayIn__ZeroBuyer.selector);
        payIn.payInWithPermit(
            merchantId,
            address(usdc),
            USD_AMOUNT,
            address(0),
            IGaslessPayIn.Permit({ value: 100e6, deadline: block.timestamp + 1 hours }),
            27,
            bytes32(0),
            bytes32(0),
            ORDER_ID
        );
    }

    function test_payInWithPermit_revertsOnLowPermitValue() public {
        uint256 gross = router.quote(merchantId, address(usdc), USD_AMOUNT);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IGaslessPayIn.GaslessPayIn__PermitValueTooLow.selector, gross - 1, gross
            )
        );
        payIn.payInWithPermit(
            merchantId,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Permit({ value: gross - 1, deadline: block.timestamp + 1 hours }),
            27,
            bytes32(0),
            bytes32(0),
            ORDER_ID
        );
    }

    function test_payInWithPermit_frontRunPermit_stillSettles() public {
        // A front-runner submits the buyer's permit first (consuming the nonce); the allowance is set, so
        // our tolerant permit catch lets the pull-and-route still succeed.
        uint256 gross = router.quote(merchantId, address(usdc), USD_AMOUNT);
        usdc.mint(buyer, gross);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _permitDigest(address(usdc), buyer, address(payIn), gross, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);

        // Front-run: anyone can land the permit directly on the token.
        vm.prank(stranger);
        usdc.permit(buyer, address(payIn), gross, deadline, v, r, s);
        assertEq(usdc.allowance(buyer, address(payIn)), gross);

        // Now the relayer's call: the inner permit reverts (nonce spent) but is caught; the pull works.
        vm.prank(relayer);
        payIn.payInWithPermit(
            merchantId,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Permit({ value: gross, deadline: deadline }),
            v,
            r,
            s,
            ORDER_ID
        );
        uint256 totalFee = gross * (PLATFORM_FEE_BPS + MERCHANT_FEE_BPS) / 10_000;
        assertEq(usdc.balanceOf(payout), gross - totalFee);
        assertEq(usdc.balanceOf(address(payIn)), 0);
    }

    function test_payInWithPermit_replayRevertsViaTokenNonce() public {
        uint256 gross = router.quote(merchantId, address(usdc), USD_AMOUNT);
        usdc.mint(buyer, gross * 2);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _permitDigest(address(usdc), buyer, address(payIn), gross, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);

        vm.prank(relayer);
        payIn.payInWithPermit(
            merchantId,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Permit({ value: gross, deadline: deadline }),
            v,
            r,
            s,
            ORDER_ID
        );

        // A replay: the token nonce is spent, so the permit can't re-set the allowance; the prior
        // settlement already consumed the buyer's first allowance, so the pull now reverts (no allowance).
        vm.prank(relayer);
        vm.expectRevert(); // ERC20InsufficientAllowance from the token transferFrom
        payIn.payInWithPermit(
            merchantId,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Permit({ value: gross, deadline: deadline }),
            v,
            r,
            s,
            ORDER_ID
        );
    }

    /*//////////////////////////////////////////////////////////////
                        ERC-7597 PERMIT RAIL
    //////////////////////////////////////////////////////////////*/

    function test_payInWithPermit7597_eoaBuyer() public {
        uint256 gross = router.quote(merchantId, address(usdc), USD_AMOUNT);
        usdc.mint(buyer, gross);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _permitDigest(address(usdc), buyer, address(payIn), gross, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        (uint256 platformFee, uint256 merchantFee, uint256 net) = _split(gross);
        vm.expectEmit(true, true, true, true, address(payIn));
        emit IGaslessPayIn.GaslessPayInSettled(
            merchantId,
            buyer,
            relayer,
            address(usdc),
            gross,
            IGaslessPayIn.Rail.PERMIT_7597,
            ORDER_ID
        );
        vm.prank(relayer);
        payIn.payInWithPermit7597(
            merchantId,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Permit({ value: gross, deadline: deadline }),
            sig,
            ORDER_ID
        );

        assertEq(usdc.balanceOf(payout), net);
        assertEq(usdc.balanceOf(treasury), platformFee);
        assertEq(usdc.balanceOf(feeRecipient), merchantFee);
        assertEq(usdc.balanceOf(address(payIn)), 0);
    }

    function test_payInWithPermit7597_smartAccountBuyer_1271() public {
        // A deployed ERC-1271 smart account is the buyer; it validates the bytes permit via its signer EOA.
        SmartWallet1271 wallet = new SmartWallet1271(buyer); // signer = buyer EOA
        address w = address(wallet);
        uint256 gross = router.quote(merchantId, address(usdc), USD_AMOUNT);
        usdc.mint(w, gross);
        uint256 deadline = block.timestamp + 1 hours;

        // The permit digest is over the SMART ACCOUNT as owner; the inner ECDSA sig is the EOA signer's.
        bytes32 digest = _permitDigest(address(usdc), w, address(payIn), gross, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        (,, uint256 net) = _split(gross);
        vm.prank(relayer);
        payIn.payInWithPermit7597(
            merchantId,
            address(usdc),
            USD_AMOUNT,
            w,
            IGaslessPayIn.Permit({ value: gross, deadline: deadline }),
            sig,
            ORDER_ID
        );
        assertEq(usdc.balanceOf(payout), net);
        assertEq(usdc.balanceOf(address(payIn)), 0);
        assertEq(usdc.balanceOf(w), 0);
    }

    function test_payInWithPermit7597_revertsOnZeroBuyer() public {
        vm.prank(relayer);
        vm.expectRevert(IGaslessPayIn.GaslessPayIn__ZeroBuyer.selector);
        payIn.payInWithPermit7597(
            merchantId,
            address(usdc),
            USD_AMOUNT,
            address(0),
            IGaslessPayIn.Permit({ value: 100e6, deadline: block.timestamp + 1 hours }),
            hex"",
            ORDER_ID
        );
    }

    function test_payInWithPermit7597_revertsOnLowPermitValue() public {
        uint256 gross = router.quote(merchantId, address(usdc), USD_AMOUNT);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IGaslessPayIn.GaslessPayIn__PermitValueTooLow.selector, gross - 1, gross
            )
        );
        payIn.payInWithPermit7597(
            merchantId,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Permit({ value: gross - 1, deadline: block.timestamp + 1 hours }),
            hex"",
            ORDER_ID
        );
    }

    /*//////////////////////////////////////////////////////////////
                        EIP-3009 AUTHORIZATION RAIL
    //////////////////////////////////////////////////////////////*/

    function test_payInWithAuthorization_settlesThroughFeeSplit() public {
        uint256 gross = router.quote(merchantId, address(usdc), USD_AMOUNT);
        usdc.mint(buyer, gross);
        bytes32 nonce = keccak256("auth-nonce-1");
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp + 1 hours;

        bytes32 digest = _authDigest(
            address(usdc), buyer, address(payIn), gross, validAfter, validBefore, nonce
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);

        (uint256 platformFee, uint256 merchantFee, uint256 net) = _split(gross);
        vm.expectEmit(true, true, true, true, address(payIn));
        emit IGaslessPayIn.GaslessPayInSettled(
            merchantId,
            buyer,
            relayer,
            address(usdc),
            gross,
            IGaslessPayIn.Rail.AUTHORIZATION_3009,
            ORDER_ID
        );
        vm.prank(relayer);
        payIn.payInWithAuthorization(
            merchantId,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Authorization({
                value: gross, validAfter: validAfter, validBefore: validBefore, nonce: nonce
            }),
            v,
            r,
            s,
            ORDER_ID
        );

        assertEq(usdc.balanceOf(payout), net);
        assertEq(usdc.balanceOf(treasury), platformFee);
        assertEq(usdc.balanceOf(feeRecipient), merchantFee);
        assertEq(net + platformFee + merchantFee, gross);
        assertEq(usdc.balanceOf(address(payIn)), 0); // zero custody
        assertEq(usdc.balanceOf(buyer), 0);
        assertTrue(usdc.authorizationState(buyer, nonce)); // nonce consumed in the token
    }

    function test_payInWithAuthorization_revertsOnZeroBuyer() public {
        vm.prank(relayer);
        vm.expectRevert(IGaslessPayIn.GaslessPayIn__ZeroBuyer.selector);
        payIn.payInWithAuthorization(
            merchantId,
            address(usdc),
            USD_AMOUNT,
            address(0),
            IGaslessPayIn.Authorization({
                value: 100e6,
                validAfter: 0,
                validBefore: block.timestamp + 1 hours,
                nonce: keccak256("n")
            }),
            27,
            bytes32(0),
            bytes32(0),
            ORDER_ID
        );
    }

    function test_payInWithAuthorization_revertsOnValueMismatch() public {
        uint256 gross = router.quote(merchantId, address(usdc), USD_AMOUNT);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IGaslessPayIn.GaslessPayIn__AuthorizationValueMismatch.selector, gross + 1, gross
            )
        );
        payIn.payInWithAuthorization(
            merchantId,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Authorization({
                value: gross + 1, // not equal to gross
                validAfter: 0,
                validBefore: block.timestamp + 1 hours,
                nonce: keccak256("n")
            }),
            27,
            bytes32(0),
            bytes32(0),
            ORDER_ID
        );
    }

    function test_payInWithAuthorization_replayRevertsViaTokenNonce() public {
        uint256 gross = router.quote(merchantId, address(usdc), USD_AMOUNT);
        usdc.mint(buyer, gross * 2);
        bytes32 nonce = keccak256("auth-nonce-replay");
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 digest =
            _authDigest(address(usdc), buyer, address(payIn), gross, 0, validBefore, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);

        IGaslessPayIn.Authorization memory auth = IGaslessPayIn.Authorization({
            value: gross, validAfter: 0, validBefore: validBefore, nonce: nonce
        });

        vm.prank(relayer);
        payIn.payInWithAuthorization(
            merchantId, address(usdc), USD_AMOUNT, buyer, auth, v, r, s, ORDER_ID
        );

        // Replay with the same authorization: the token marks the nonce used, so the second pull reverts.
        vm.prank(relayer);
        vm.expectRevert(); // AuthAlreadyUsed from the token
        payIn.payInWithAuthorization(
            merchantId, address(usdc), USD_AMOUNT, buyer, auth, v, r, s, ORDER_ID
        );
    }

    function test_payInWithAuthorization_feeOnTransfer_revertsShortfall() public {
        // A 3009 token that skims on transfer: the contract receives less than the gross → PullShortfall.
        FeeSkimGasless3009 fot = new FeeSkimGasless3009();
        vm.startPrank(owner);
        router.setTokenAllowed(address(fot), true);
        router.setPriceFeed(address(fot), address(usdcFeed));
        vm.stopPrank();

        uint256 gross = router.quote(merchantId, address(fot), USD_AMOUNT);
        fot.mint(buyer, gross);
        bytes32 nonce = keccak256("fot-nonce");
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 digest =
            _authDigest(address(fot), buyer, address(payIn), gross, 0, validBefore, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);

        uint256 received = gross - gross / 100; // 1% skim
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IGaslessPayIn.GaslessPayIn__PullShortfall.selector, gross, received
            )
        );
        payIn.payInWithAuthorization(
            merchantId,
            address(fot),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Authorization({
                value: gross, validAfter: 0, validBefore: validBefore, nonce: nonce
            }),
            v,
            r,
            s,
            ORDER_ID
        );
    }

    /*//////////////////////////////////////////////////////////////
                          LIVE FEE-SPLIT MIRROR
    //////////////////////////////////////////////////////////////*/

    function test_zeroPlatformFee_paysFullNetMinusMerchantFee() public {
        // Prove the split reads the router's LIVE rate, not a constant: zero platform fee → treasury 0.
        vm.prank(owner);
        router.setPlatformFee(0);

        uint256 gross = router.quote(merchantId, address(usdc), USD_AMOUNT);
        usdc.mint(buyer, gross);
        bytes32 nonce = keccak256("zero-fee");
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 digest =
            _authDigest(address(usdc), buyer, address(payIn), gross, 0, validBefore, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);

        vm.prank(relayer);
        payIn.payInWithAuthorization(
            merchantId,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Authorization({
                value: gross, validAfter: 0, validBefore: validBefore, nonce: nonce
            }),
            v,
            r,
            s,
            ORDER_ID
        );

        uint256 merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(usdc.balanceOf(feeRecipient), merchantFee);
        assertEq(usdc.balanceOf(payout), gross - merchantFee);
        assertEq(usdc.balanceOf(address(payIn)), 0);
    }

    /*//////////////////////////////////////////////////////////////
                          UUPS UPGRADE / FREEZE
    //////////////////////////////////////////////////////////////*/

    function test_upgrade_preservesStateAndAddsFn() public {
        address v2 = address(new GaslessPayInV2());
        vm.prank(admin);
        UUPSUpgradeable(address(payIn)).upgradeToAndCall(v2, "");

        assertEq(GaslessPayInV2(address(payIn)).version2Marker(), "v2");
        assertEq(payIn.router(), address(router));
        assertEq(OwnableUpgradeable(address(payIn)).owner(), admin);
    }

    function test_upgrade_revertNonOwner() public {
        address v2 = address(new GaslessPayInV2());
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger)
        );
        UUPSUpgradeable(address(payIn)).upgradeToAndCall(v2, "");
    }

    function test_freeze_renounceOwnershipBlocksUpgradeForever() public {
        vm.prank(admin);
        OwnableUpgradeable(address(payIn)).renounceOwnership();
        assertEq(OwnableUpgradeable(address(payIn)).owner(), address(0));

        address v2 = address(new GaslessPayInV2());
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, admin)
        );
        UUPSUpgradeable(address(payIn)).upgradeToAndCall(v2, "");
    }
}
