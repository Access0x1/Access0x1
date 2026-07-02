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

/// @notice The merchant-binding hardening suite — proves a permissionless relayer can NO LONGER redirect a
///         buyer's gasless pay-in to a different merchant, change its amount/order, or re-pull a residual
///         allowance. Two merchants (`A` = the buyer's intended, `B` = the relayer's own) share one router;
///         a single buyer signs an authorization/intent for merchant A / order X, and the relayer attempts
///         the attack against merchant B (or a mutated amount/order). Each NEGATIVE test asserts the guard
///         reverts; the happy-path regression proves the settlement still records the BUYER-signed merchant.
/// @dev    The 3009 rail binds via the STRUCTURED nonce (`auth.nonce == intentNonce(...)`); the permit
///         rails bind via the Access0x1-domain {PayInIntent} co-signature + single-use `orderId`. Every
///         negative here would SUCCEED against the pre-fix contract (which bound only the token's
///         from/to/value/nonce, never the merchant/amount/order) — the guard is what makes them revert.
contract GaslessMerchantBindingTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    GaslessPayIn internal payIn;

    address internal owner = makeAddr("owner");
    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%

    // Merchant A — the buyer's intended payee. Merchant B — the relayer's own (the redirect target).
    address internal merchantAOwner = makeAddr("merchantAOwner");
    address internal payoutA = makeAddr("payoutA");
    address internal feeRecipientA = makeAddr("feeRecipientA");
    address internal merchantBOwner = makeAddr("merchantBOwner");
    address internal payoutB = makeAddr("payoutB");
    address internal feeRecipientB = makeAddr("feeRecipientB");
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5%

    MockV3Aggregator internal usdcFeed;
    MockUSDCGasless internal usdc;

    address internal relayer = makeAddr("relayer"); // the attacker: any address may relay
    address internal buyer;
    uint256 internal buyerPk;

    uint256 internal merchantA;
    uint256 internal merchantB;
    uint256 internal constant USD_AMOUNT = 100e8; // $100
    bytes32 internal constant ORDER_X = keccak256("order-X"); // the buyer-intended order

    bytes32 internal constant PERMIT_TYPEHASH = keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
    );
    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function setUp() public {
        vm.warp(1_700_000_000);
        (buyer, buyerPk) = makeAddrAndKey("buyer");

        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (owner, treasury, PLATFORM_FEE_BPS))
            )
        );
        payIn = GaslessPayIn(
            deployProxy(
                address(new GaslessPayIn()),
                abi.encodeCall(GaslessPayIn.initialize, (admin, router))
            )
        );

        usdcFeed = new MockV3Aggregator(8, 1e8); // $1 per USDC
        usdc = new MockUSDCGasless();
        vm.startPrank(owner);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(usdcFeed));
        vm.stopPrank();

        vm.prank(merchantAOwner);
        merchantA =
            router.registerMerchant(payoutA, feeRecipientA, MERCHANT_FEE_BPS, keccak256("A"));
        vm.prank(merchantBOwner);
        merchantB =
            router.registerMerchant(payoutB, feeRecipientB, MERCHANT_FEE_BPS, keccak256("B"));
    }

    /*//////////////////////////////////////////////////////////////
                              SIGNING HELPERS
    //////////////////////////////////////////////////////////////*/

    function _tokenDomain() internal view returns (bytes32) {
        return usdc.DOMAIN_SEPARATOR();
    }

    /// @dev Build + sign an EIP-3009 authorization over `nonce` (EOA `buyerPk`).
    function _signAuth(uint256 value, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                buyer,
                address(payIn),
                value,
                uint256(0),
                validBefore,
                nonce
            )
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(_tokenDomain(), structHash);
        return vm.sign(buyerPk, digest);
    }

    /// @dev Build + sign an EIP-2612 / ERC-7597 permit over the token domain (EOA `buyerPk`).
    function _signPermit(address ownerAddr, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, ownerAddr, address(payIn), value, nonce, deadline)
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(_tokenDomain(), structHash);
        return vm.sign(buyerPk, digest);
    }

    /// @dev Sign the Access0x1-domain {PayInIntent} for `intentBuyer` with `signerPk` (EOA or the smart
    ///      account's signer EOA).
    function _signIntent(
        uint256 signerPk,
        uint256 merchantId,
        uint256 maxValue,
        bytes32 orderId,
        address intentBuyer,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 digest = payIn.intentDigest(
            IGaslessPayIn.PayInIntent({
                merchantId: merchantId,
                token: address(usdc),
                usdAmount8: USD_AMOUNT,
                maxValue: maxValue,
                orderId: orderId,
                buyer: intentBuyer,
                deadline: deadline
            })
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    /*//////////////////////////////////////////////////////////////
                        3009 — STRUCTURED NONCE
    //////////////////////////////////////////////////////////////*/

    /// @notice PRE-FIX THIS SUCCEEDS: the relayer redirects the buyer's merchant-A authorization to its own
    ///         merchant B. Post-fix, the buyer signed `auth.nonce = intentNonce(A, …, ORDER_X)`; submitting
    ///         it against merchant B recomputes a DIFFERENT expected nonce, so the guard reverts before any
    ///         pull. The buyer's token signature simply does not authorize merchant B.
    function test_relayer_cannot_redirect_to_other_merchant_3009() public {
        uint256 gross = router.quote(merchantA, address(usdc), USD_AMOUNT);
        usdc.mint(buyer, gross);
        uint256 validBefore = block.timestamp + 1 hours;

        // The buyer signs for merchant A / order X (the structured nonce binds them).
        bytes32 nonceA = payIn.intentNonce(merchantA, address(usdc), USD_AMOUNT, buyer, ORDER_X);
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(gross, validBefore, nonceA);

        // The relayer submits the SAME signed auth against merchant B. The contract recomputes the expected
        // nonce for merchant B and it will not match `nonceA`.
        bytes32 expectedB = payIn.intentNonce(merchantB, address(usdc), USD_AMOUNT, buyer, ORDER_X);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IGaslessPayIn.GaslessPayIn__IntentMismatch.selector, expectedB, nonceA
            )
        );
        payIn.payInWithAuthorization(
            merchantB, // ← the redirect
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Authorization({
                value: gross, validAfter: 0, validBefore: validBefore, nonce: nonceA
            }),
            v,
            r,
            s,
            ORDER_X
        );

        // Nothing moved: merchant B got nothing, the buyer keeps their funds.
        assertEq(usdc.balanceOf(payoutB), 0);
        assertEq(usdc.balanceOf(buyer), gross);
    }

    /// @notice PRE-FIX THIS SUCCEEDS: with a fixed same-price quote, the relayer swaps `usdAmount8` (or the
    ///         `orderId`) while reusing the buyer's signed nonce. Post-fix both are folded into the
    ///         structured nonce, so either mutation breaks the match. Two mutations, one test.
    function test_relayer_cannot_change_usdAmount_or_orderId_3009() public {
        // Two USD prices that quote to a same-ish gross is not needed — the guard fires on the nonce, before
        // any quote comparison. The buyer signs for (A, USD_AMOUNT, ORDER_X).
        uint256 gross = router.quote(merchantA, address(usdc), USD_AMOUNT);
        usdc.mint(buyer, gross);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonceIntended =
            payIn.intentNonce(merchantA, address(usdc), USD_AMOUNT, buyer, ORDER_X);
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(gross, validBefore, nonceIntended);

        IGaslessPayIn.Authorization memory auth = IGaslessPayIn.Authorization({
            value: gross, validAfter: 0, validBefore: validBefore, nonce: nonceIntended
        });

        // (1) Relayer mutates usdAmount8 (200e8 instead of 100e8) → expected nonce differs → revert.
        uint256 otherUsd = 200e8;
        bytes32 expectedUsd = payIn.intentNonce(merchantA, address(usdc), otherUsd, buyer, ORDER_X);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IGaslessPayIn.GaslessPayIn__IntentMismatch.selector, expectedUsd, nonceIntended
            )
        );
        payIn.payInWithAuthorization(
            merchantA, address(usdc), otherUsd, buyer, auth, v, r, s, ORDER_X
        );

        // (2) Relayer mutates orderId → expected nonce differs → revert.
        bytes32 otherOrder = keccak256("order-Y");
        bytes32 expectedOrder =
            payIn.intentNonce(merchantA, address(usdc), USD_AMOUNT, buyer, otherOrder);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IGaslessPayIn.GaslessPayIn__IntentMismatch.selector, expectedOrder, nonceIntended
            )
        );
        payIn.payInWithAuthorization(
            merchantA, address(usdc), USD_AMOUNT, buyer, auth, v, r, s, otherOrder
        );

        assertEq(usdc.balanceOf(buyer), gross); // still untouched after both attempts
    }

    /*//////////////////////////////////////////////////////////////
                    PERMIT RAILS — INTENT + ORDER GATE
    //////////////////////////////////////////////////////////////*/

    /// @notice PRE-FIX THIS SUCCEEDS (the over-pull): a buyer permits a ceiling of `2×gross`; a first pay-in
    ///         settles `gross` and leaves `gross` residual allowance. Pre-fix any relayer re-calls the
    ///         permit rail to drain the residual to any merchant. Post-fix the SECOND call replays the bound
    ///         `orderId`, which is single-use, so it reverts — the residual can never be re-pulled.
    function test_permit_residual_allowance_cannot_be_repulled() public {
        uint256 gross = router.quote(merchantA, address(usdc), USD_AMOUNT);
        uint256 ceiling = gross * 2; // buyer permits a ceiling; residual remains after the first pull
        usdc.mint(buyer, ceiling);
        uint256 deadline = block.timestamp + 1 hours;

        (uint8 v, bytes32 r, bytes32 s) = _signPermit(buyer, ceiling, 0, deadline);
        bytes memory intentSig = _signIntent(buyerPk, merchantA, ceiling, ORDER_X, buyer, deadline);

        // First settlement: pulls `gross`, leaves `ceiling − gross` residual allowance to the contract.
        vm.prank(relayer);
        payIn.payInWithPermit(
            merchantA,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Permit({ value: ceiling, deadline: deadline }),
            v,
            r,
            s,
            ORDER_X,
            ceiling,
            deadline,
            intentSig
        );
        assertGe(usdc.allowance(buyer, address(payIn)), gross); // residual really is exploitable pre-fix

        // The re-pull: same bound intent + orderId. Blocked by the single-use order ledger.
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(IGaslessPayIn.GaslessPayIn__OrderReplay.selector, ORDER_X)
        );
        payIn.payInWithPermit(
            merchantA,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Permit({ value: ceiling, deadline: deadline }),
            v,
            r,
            s,
            ORDER_X,
            ceiling,
            deadline,
            intentSig
        );

        // Only `gross` ever left the buyer; the residual allowance is inert.
        assertEq(usdc.balanceOf(buyer), ceiling - gross);
    }

    /// @notice A relayer cannot replay a fully-consumed bound `orderId` on the permit rail (exact-value
    ///         permit, so there is no residual — but the order gate still one-shots it). Complements the
    ///         residual test: even with a fresh permit signature, the SAME orderId cannot settle twice.
    function test_bound_intent_replayed_orderId_reverts() public {
        uint256 gross = router.quote(merchantA, address(usdc), USD_AMOUNT);
        usdc.mint(buyer, gross * 2);
        uint256 deadline = block.timestamp + 1 hours;

        (uint8 v, bytes32 r, bytes32 s) = _signPermit(buyer, gross, 0, deadline);
        bytes memory intentSig = _signIntent(buyerPk, merchantA, gross, ORDER_X, buyer, deadline);

        vm.prank(relayer);
        payIn.payInWithPermit(
            merchantA,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Permit({ value: gross, deadline: deadline }),
            v,
            r,
            s,
            ORDER_X,
            gross,
            deadline,
            intentSig
        );

        // Fresh permit (next token nonce) but the SAME bound orderId → OrderReplay.
        (uint8 v2, bytes32 r2, bytes32 s2) = _signPermit(buyer, gross, 1, deadline);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(IGaslessPayIn.GaslessPayIn__OrderReplay.selector, ORDER_X)
        );
        payIn.payInWithPermit(
            merchantA,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Permit({ value: gross, deadline: deadline }),
            v2,
            r2,
            s2,
            ORDER_X,
            gross,
            deadline,
            intentSig
        );
    }

    /// @notice PRE-FIX THIS SUCCEEDS: the relayer redirects the buyer's permit-rail pay-in to merchant B.
    ///         Post-fix the {PayInIntent} the buyer signed names merchant A; recomputing the digest for
    ///         merchant B does not recover to the buyer, so the co-signature is rejected.
    function test_relayer_cannot_redirect_to_other_merchant_permit() public {
        uint256 gross = router.quote(merchantA, address(usdc), USD_AMOUNT);
        usdc.mint(buyer, gross);
        uint256 deadline = block.timestamp + 1 hours;

        (uint8 v, bytes32 r, bytes32 s) = _signPermit(buyer, gross, 0, deadline);
        // Buyer signs the intent for merchant A.
        bytes memory intentSigA = _signIntent(buyerPk, merchantA, gross, ORDER_X, buyer, deadline);

        // Relayer submits it against merchant B: the recomputed digest binds merchant B, so the signature
        // no longer recovers to the buyer.
        vm.prank(relayer);
        vm.expectRevert(IGaslessPayIn.GaslessPayIn__IntentSignatureInvalid.selector);
        payIn.payInWithPermit(
            merchantB,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Permit({ value: gross, deadline: deadline }),
            v,
            r,
            s,
            ORDER_X,
            gross,
            deadline,
            intentSigA
        );
        assertEq(usdc.balanceOf(payoutB), 0);
    }

    /// @notice PRE-FIX THIS SUCCEEDS: the ERC-7597 mirror of the 2612 redirect. Even though both permit
    ///         rails share `_verifyIntentAndConsumeOrder`, prove the 7597 wiring: buyer signs a
    ///         {PayInIntent} for merchant A, relayer submits it via `payInWithPermit7597` against merchant
    ///         B; the digest recomputed for merchant B does not recover to the buyer, so the co-signature
    ///         is rejected and merchant B receives nothing.
    function test_relayer_cannot_redirect_to_other_merchant_permit7597() public {
        uint256 gross = router.quote(merchantA, address(usdc), USD_AMOUNT);
        usdc.mint(buyer, gross);
        uint256 deadline = block.timestamp + 1 hours;

        // The 7597 permit is a single bytes signature over the token domain.
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(buyer, gross, 0, deadline);
        bytes memory permitSig = abi.encodePacked(r, s, v);
        // Buyer signs the intent for merchant A.
        bytes memory intentSigA = _signIntent(buyerPk, merchantA, gross, ORDER_X, buyer, deadline);

        // Relayer submits it against merchant B on the 7597 rail.
        vm.prank(relayer);
        vm.expectRevert(IGaslessPayIn.GaslessPayIn__IntentSignatureInvalid.selector);
        payIn.payInWithPermit7597(
            merchantB,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Permit({ value: gross, deadline: deadline }),
            permitSig,
            ORDER_X,
            gross,
            deadline,
            intentSigA
        );
        assertEq(usdc.balanceOf(payoutB), 0);
    }

    /*//////////////////////////////////////////////////////////////
                        INTENT WINDOW + CEILING
    //////////////////////////////////////////////////////////////*/

    /// @notice The permit-rail intent expires: a buyer signs a {PayInIntent} with a `deadline`, and a
    ///         relayer that submits it after that time reverts `GaslessPayIn__IntentExpired`. Warps one
    ///         second past the signed intent deadline (the token permit deadline is set far ahead so the
    ///         intent expiry — not the permit expiry — is the gate under test).
    function test_permit_intent_expired_reverts() public {
        uint256 gross = router.quote(merchantA, address(usdc), USD_AMOUNT);
        usdc.mint(buyer, gross);
        uint256 intentDeadline = block.timestamp + 1 hours;
        uint256 permitDeadline = block.timestamp + 2 hours; // outlives the intent, so it is not the gate

        (uint8 v, bytes32 r, bytes32 s) = _signPermit(buyer, gross, 0, permitDeadline);
        bytes memory intentSig =
            _signIntent(buyerPk, merchantA, gross, ORDER_X, buyer, intentDeadline);

        // Move just past the intent deadline (still within the permit window). Refresh the price feed so
        // its staleness guard is not what fires — the intent expiry is the gate under test.
        vm.warp(intentDeadline + 1);
        usdcFeed.updateAnswer(1e8);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IGaslessPayIn.GaslessPayIn__IntentExpired.selector, intentDeadline, block.timestamp
            )
        );
        payIn.payInWithPermit(
            merchantA,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Permit({ value: gross, deadline: permitDeadline }),
            v,
            r,
            s,
            ORDER_X,
            gross,
            intentDeadline,
            intentSig
        );
        assertEq(usdc.balanceOf(payoutA), 0); // nothing settled
    }

    /// @notice The permit-rail ceiling bites: a buyer signs a {PayInIntent} whose `maxValue` is BELOW the
    ///         router's quoted gross, so settling would pull more than authorized. The contract reverts
    ///         `GaslessPayIn__IntentValueExceeded(gross, maxValue)` before any pull. The token permit
    ///         allowance is set to the full gross so it is NOT the gate — the intent ceiling is.
    function test_permit_intent_value_exceeded_reverts() public {
        uint256 gross = router.quote(merchantA, address(usdc), USD_AMOUNT);
        usdc.mint(buyer, gross);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 tightCeiling = gross - 1; // one below the quote — the intent under-authorizes

        // The permit itself covers the full gross (so PermitValueTooLow is not what fires).
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(buyer, gross, 0, deadline);
        bytes memory intentSig =
            _signIntent(buyerPk, merchantA, tightCeiling, ORDER_X, buyer, deadline);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IGaslessPayIn.GaslessPayIn__IntentValueExceeded.selector, gross, tightCeiling
            )
        );
        payIn.payInWithPermit(
            merchantA,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Permit({ value: gross, deadline: deadline }),
            v,
            r,
            s,
            ORDER_X,
            tightCeiling,
            deadline,
            intentSig
        );
        assertEq(usdc.balanceOf(payoutA), 0);
        assertEq(usdc.balanceOf(buyer), gross); // untouched
    }

    /*//////////////////////////////////////////////////////////////
                          ERC-1271 SMART ACCOUNT
    //////////////////////////////////////////////////////////////*/

    /// @notice The {PayInIntent} co-signature accepts an ERC-1271 smart account: the intent's `buyer` is the
    ///         wallet, and its signer EOA's ECDSA over the digest validates via {SignatureChecker}.
    function test_smart_account_1271_intent_accepted() public {
        SmartWallet1271 wallet = new SmartWallet1271(buyer); // signer = buyer EOA
        address w = address(wallet);
        uint256 gross = router.quote(merchantA, address(usdc), USD_AMOUNT);
        usdc.mint(w, gross);
        uint256 deadline = block.timestamp + 1 hours;

        // The 7597 permit is signed over the smart account as owner (its 1271 validates the EOA sig).
        bytes32 permitStruct =
            keccak256(abi.encode(PERMIT_TYPEHASH, w, address(payIn), gross, uint256(0), deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(buyerPk, MessageHashUtils.toTypedDataHash(_tokenDomain(), permitStruct));
        bytes memory permitSig = abi.encodePacked(r, s, v);

        // The intent's buyer is the smart account; the co-signature is the EOA signer's ECDSA sig.
        bytes memory intentSig = _signIntent(buyerPk, merchantA, gross, ORDER_X, w, deadline);

        vm.prank(relayer);
        payIn.payInWithPermit7597(
            merchantA,
            address(usdc),
            USD_AMOUNT,
            w,
            IGaslessPayIn.Permit({ value: gross, deadline: deadline }),
            permitSig,
            ORDER_X,
            gross,
            deadline,
            intentSig
        );

        (,, uint256 net) = _split(gross);
        assertEq(usdc.balanceOf(payoutA), net);
        assertEq(usdc.balanceOf(w), 0);
    }

    /// @notice A {PayInIntent} co-signature from the WRONG signer is rejected — the smart account's 1271
    ///         only validates its configured signer, so an attacker's signature over the same digest fails.
    function test_wrong_signer_intent_rejected() public {
        SmartWallet1271 wallet = new SmartWallet1271(buyer); // signer = buyer EOA
        address w = address(wallet);
        uint256 gross = router.quote(merchantA, address(usdc), USD_AMOUNT);
        usdc.mint(w, gross);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 permitStruct =
            keccak256(abi.encode(PERMIT_TYPEHASH, w, address(payIn), gross, uint256(0), deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(buyerPk, MessageHashUtils.toTypedDataHash(_tokenDomain(), permitStruct));
        bytes memory permitSig = abi.encodePacked(r, s, v);

        // An attacker (not the wallet's signer) signs the intent over the correct digest for the wallet.
        (, uint256 attackerPk) = makeAddrAndKey("attacker");
        bytes32 digest = payIn.intentDigest(
            IGaslessPayIn.PayInIntent({
                merchantId: merchantA,
                token: address(usdc),
                usdAmount8: USD_AMOUNT,
                maxValue: gross,
                orderId: ORDER_X,
                buyer: w,
                deadline: deadline
            })
        );
        (uint8 av, bytes32 ar, bytes32 as_) = vm.sign(attackerPk, digest);
        bytes memory badIntentSig = abi.encodePacked(ar, as_, av);

        vm.prank(relayer);
        vm.expectRevert(IGaslessPayIn.GaslessPayIn__IntentSignatureInvalid.selector);
        payIn.payInWithPermit7597(
            merchantA,
            address(usdc),
            USD_AMOUNT,
            w,
            IGaslessPayIn.Permit({ value: gross, deadline: deadline }),
            permitSig,
            ORDER_X,
            gross,
            deadline,
            badIntentSig
        );
    }

    /*//////////////////////////////////////////////////////////////
                             HAPPY PATH
    //////////////////////////////////////////////////////////////*/

    /// @notice REGRESSION: the bound 3009 pay-in still settles to the BUYER-signed merchant, and the event
    ///         records that merchant/order — the fix does not break the legitimate path.
    function test_happy_path_settles_and_event_records_buyer_signed_merchantId() public {
        uint256 gross = router.quote(merchantA, address(usdc), USD_AMOUNT);
        usdc.mint(buyer, gross);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = payIn.intentNonce(merchantA, address(usdc), USD_AMOUNT, buyer, ORDER_X);
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(gross, validBefore, nonce);

        (uint256 platformFee, uint256 merchantFee, uint256 net) = _split(gross);

        // The event carries the BUYER-signed merchant A and order X (not a relayer-chosen value).
        vm.expectEmit(true, true, true, true, address(payIn));
        emit IGaslessPayIn.GaslessPayInSettled(
            merchantA,
            buyer,
            relayer,
            address(usdc),
            gross,
            IGaslessPayIn.Rail.AUTHORIZATION_3009,
            ORDER_X
        );
        vm.prank(relayer);
        payIn.payInWithAuthorization(
            merchantA,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Authorization({
                value: gross, validAfter: 0, validBefore: validBefore, nonce: nonce
            }),
            v,
            r,
            s,
            ORDER_X
        );

        assertEq(usdc.balanceOf(payoutA), net); // funds went to merchant A, the buyer's choice
        assertEq(usdc.balanceOf(payoutB), 0); // never to merchant B
        assertEq(usdc.balanceOf(treasury), platformFee);
        assertEq(usdc.balanceOf(feeRecipientA), merchantFee);
        assertEq(usdc.balanceOf(address(payIn)), 0); // zero custody preserved
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
}
