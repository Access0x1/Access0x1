// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    Ownable2StepUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {
    EIP712Upgradeable
} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {
    ReentrancyGuardTransient
} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { Access0x1Router } from "./Access0x1Router.sol";
import {
    IGaslessPayIn,
    IERC2612Permit,
    IERC7597Permit,
    IERC3009Authorization
} from "./interfaces/IGaslessPayIn.sol";

/// @title  GaslessPayIn
/// @author Access0x1
/// @notice The "FIRST DOLLAR" leg of Access0x1 — a buyer pays an {Access0x1Router} merchant in ONE
///         transaction with NO prior `approve` and NO opened session, off a single off-chain TOKEN
///         signature, submitted by ANY relayer. This is the payment the budget-scoped {SessionGrant}
///         structurally cannot serve: SessionGrant authorizes REPEAT spends inside a session the buyer
///         opened first; GaslessPayIn settles the VERY FIRST payment, before any allowance or session
///         exists. It supports three signature rails, all USDC-native or USDC-shipped:
///           • EIP-2612 `permit` (split `v,r,s`) — the EOA gasless-approve standard;
///           • ERC-7597 `permit` (a single `bytes` signature) — USDC's Last-Call/draft variant that lets
///             an ERC-1271 SMART ACCOUNT authorize, not only an EOA;
///           • EIP-3009 `transferWithAuthorization` (USDC-native, the x402 rail) — a direct, allowance-
///             free pull keyed on a random single-use nonce.
///         In every rail the buyer's signed `value` IS the gross routed (a relayer cannot inflate it) and
///         the signed `spender`/`to` IS this contract (the pull can only land here). Signature validity
///         is enforced by the TOKEN itself (EOA via ECDSA, smart account via ERC-1271 / EIP-712), so this
///         contract holds no signature state — it composes the token's own audited verification.
/// @dev    COMPOSES, never duplicates. This contract owns ONLY the gasless-pull → route orchestration.
///         The USD→token quote (Chainlink feed read in-tx), the allowlist, the exact fee-split, and the
///         zero-custody push all live in {Access0x1Router}; a pay-in becomes the router's `msg.sender`
///         for exactly one `payToken` settlement. The fee policy is NEVER re-derived here — the router's
///         live `platformFeeBps`/`platformTreasury` settle `net + fee == gross` inside `payToken`.
///
///         ZERO CUSTODY (the money invariant). Each path pulls EXACTLY the router's quoted gross into the
///         contract and the router pushes the full net + fee out in the same call. The contract asserts a
///         ZERO residual token balance after routing ({GaslessPayIn__CustodyResidual}); combined with the
///         pull-exactness check, "no token balance retained post-call" holds on every settled tx. A
///         fee-on-transfer / rebasing token is rejected (the pull delta would not equal the gross, and the
///         router's own balance-delta guard rejects it too) — so the routed amount is always exact.
///         CEI + `nonReentrant` (ReentrancyGuardTransient) guard the value path; SafeERC20 for every
///         transfer; custom errors only; an event on settlement.
///
///         REPLAY. Replay protection is the TOKEN's, by construction: EIP-2612 / ERC-7597 consume the
///         buyer's sequential permit nonce, EIP-3009 marks its random 32-byte nonce used. A captured
///         signature therefore cannot be re-submitted — the token rejects the second attempt — so this
///         contract needs no nonce ledger of its own.
///
///         UPGRADEABILITY (the Access0x1 UUPS TEMPLATE — every system contract follows this exact shape):
///         the contract is deployed behind an `ERC1967Proxy`; storage lives in the proxy, logic in this
///         implementation. State is set once via {initialize} (the constructor-replacement,
///         `initializer`-guarded); the implementation's own constructor calls `_disableInitializers()` so
///         the logic contract can never be initialized or hijacked directly. Upgrades route through
///         {upgradeToAndCall} and are authorized by {_authorizeUpgrade} (contract-`owner`-only — the
///         `Ownable2StepUpgradeable` owner / UPGRADE ADMIN, which holds NO authority over any pay-in:
///         every pay-in is permissionless + buyer-signed). Calling `renounceOwnership()` permanently
///         freezes the implementation (no owner ⇒ no authorized upgrade ⇒ immutable forever). A trailing
///         `__gap` reserves slots for safe future storage appends. `router` is plain storage set ONCE in
///         {initialize} (an upgradeable contract cannot read Solidity `immutable`s — they live in the
///         impl bytecode, not the proxy storage); there is no setter, so it is effectively immutable.
contract GaslessPayIn is
    IGaslessPayIn,
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    EIP712Upgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    /// @notice The EIP-712 type hash for {PayInIntent} — the Access0x1-domain co-signature a buyer signs
    ///         to bind a PERMIT-rail (EIP-2612 / ERC-7597) pay-in to a specific merchant, amount, order,
    ///         and ceiling. Verified over THIS contract's domain (name "Access0x1 GaslessPayIn", version
    ///         "1"), so the intent can never be replayed against the token or a different chain/contract.
    bytes32 private constant PAYININTENT_TYPEHASH = keccak256(
        "PayInIntent(uint256 merchantId,address token,uint256 usdAmount8,uint256 maxValue,bytes32 orderId,address buyer,uint256 deadline)"
    );

    /// @notice The shared, audited payments router this contract composes. Set once in {initialize} and
    ///         never repointed (no setter) — the fee-split, pricing (USD→token via {OracleLib}'s
    ///         staleness guard), the allowlist, and the zero-custody push are all delegated to it (a new
    ///         router = a new GaslessPayIn proxy / fresh initialize).
    /// @dev    Plain storage, not `immutable`: an upgradeable contract reads state from the proxy, while
    ///         an `immutable` lives in the implementation bytecode. Effectively immutable per proxy.
    Access0x1Router public routerContract;

    /// @notice PERMIT-rail single-use order ledger: `orderId ⇒ settled`. The ONLY new persistent state in
    ///         this contract, and it exists solely to defeat the residual-allowance re-pull on the 2612 /
    ///         7597 rails. A permit sets a plain token ALLOWANCE of `value`; after a pull of `gross < value`
    ///         the `value − gross` residual still satisfies `safeTransferFrom`, so — even with the
    ///         {PayInIntent} co-signature — a relayer could otherwise replay the SAME bound intent to drain
    ///         the residual to the (correct) merchant repeatedly. Marking `orderId` used BEFORE routing
    ///         (CEI) makes each bound order settle at most once, so no residual re-pull has an unused
    ///         intent. The 3009 rail needs no entry here — its structured, token-single-use nonce already
    ///         binds and one-shots the pull. Appended below `routerContract`; consumes exactly one slot
    ///         from `__gap` (50 → 49). {EIP712Upgradeable} adds NO linear storage (ERC-7201 namespaced).
    mapping(bytes32 orderId => bool settled) private _orderUsed;

    /// @dev Reserved storage slots so future versions can APPEND new state without shifting the layout
    ///      above (UUPS storage-collision safety). Each new variable added in a later version consumes
    ///      one slot from the head of this gap; shrink `__gap` by exactly the number of slots added so
    ///      the total stays 50 (`_orderUsed` took one, so this is now 49). NEVER reorder or insert a
    ///      variable above this gap — only append.
    uint256[49] private __gap;

    /// @dev The implementation is the logic half of a UUPS pair; its OWN storage is never used in
    ///      production (the proxy holds state). `_disableInitializers()` burns the implementation's
    ///      initializer so it can never be initialized — and therefore never owned or upgraded —
    ///      directly, closing the classic uninitialized-implementation takeover. Runs at
    ///      implementation-deploy time.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time initializer — the constructor-replacement for the proxy. Binds the composed
    ///         router and sets the contract (upgrade-admin) owner. Guarded by `initializer`, so it runs
    ///         exactly once per proxy; the typical deploy is
    ///         `new ERC1967Proxy(impl, abi.encodeCall(initialize, ...))`.
    /// @dev    Wires every base: Ownable + its 2-step extension, and the EIP-712 domain used to verify the
    ///         permit-rail {PayInIntent} co-signature (name "Access0x1 GaslessPayIn", version "1").
    ///         `initialOwner` becomes the UPGRADE ADMIN (the `Ownable2Step` owner); it must be non-zero
    ///         (`__Ownable_init` reverts on zero). There is no `__UUPSUpgradeable_init()` /
    ///         `__ReentrancyGuard_init()` in OZ 5.x (those bases hold no initializable storage). The router
    ///         must be non-zero (a new router = a fresh proxy).
    /// @param initialOwner The contract owner / upgrade admin (non-zero). Holds NO authority over any
    ///                     pay-in — the pay paths are permissionless and buyer-signed.
    /// @param router_      The deployed {Access0x1Router} every pay-in settles through.
    function initialize(address initialOwner, Access0x1Router router_) external initializer {
        if (address(router_) == address(0)) revert GaslessPayIn__ZeroAddress();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __EIP712_init("Access0x1 GaslessPayIn", "1");
        routerContract = router_;
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IGaslessPayIn
    function router() external view returns (address) {
        return address(routerContract);
    }

    /// @inheritdoc IGaslessPayIn
    /// @dev Pure pass-through to the router's `quote` (allowlist + feed + staleness), so an off-chain
    ///      signer reads the EXACT gross to authorize from the same source the settlement will pull. The
    ///      first `quote` arg is the merchantId (reserved by the router for future per-merchant pricing).
    function quoteGross(uint256 merchantId, address token, uint256 usdAmount8)
        external
        view
        returns (uint256 gross)
    {
        return routerContract.quote(merchantId, token, usdAmount8);
    }

    /// @inheritdoc IGaslessPayIn
    /// @dev The 3009 rail's binding core: the buyer signs a 3009 authorization whose `nonce` equals THIS
    ///      value, so the (otherwise merchant-blind) token signature also covers the merchant, token, USD
    ///      amount, and order. Recomputed in {payInWithAuthorization} from calldata and required to match
    ///      `auth.nonce`. Includes `block.chainid` + `address(this)` so a signature is bound to this
    ///      deployment on this chain. Not stored: the token's own single-use marking of the nonce is the
    ///      replay guard, so this rail needs no ledger of its own.
    function intentNonce(
        uint256 merchantId,
        address token,
        uint256 usdAmount8,
        address buyer,
        bytes32 orderId
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(block.chainid, address(this), merchantId, token, usdAmount8, buyer, orderId)
        );
    }

    /// @inheritdoc IGaslessPayIn
    /// @dev The permit rails' binding core: the EIP-712 digest of a {PayInIntent} over this contract's own
    ///      domain. The contract recomputes it from calldata and verifies it against `buyer` (ECDSA /
    ///      ERC-1271) via {SignatureChecker}. Because the domain is THIS contract (not the token), the
    ///      intent cannot be replayed against the token or another chain/contract.
    function intentDigest(PayInIntent calldata intent) external view returns (bytes32) {
        return _intentDigest(intent);
    }

    /*//////////////////////////////////////////////////////////////
                                PAY-IN
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IGaslessPayIn
    /// @dev CEI + `nonReentrant`. Quote the gross IN-TX, VERIFY the buyer's {PayInIntent} co-signature
    ///      binds this exact merchant/amount/order and mark the `orderId` single-use (defeats the
    ///      residual-allowance re-pull), require the signed allowance covers it, submit the EIP-2612 permit
    ///      TOLERANTLY (a front-run that already set the allowance must not brick the pay-in — the pull is
    ///      the real gate), pull exactly the gross, then route. The permit is submitted with the EXACT
    ///      `buyer`/`this`/`value`/`deadline` the buyer signed, so a relayer can neither alter the grant
    ///      nor redirect it; the intent binds the merchant/order the permit alone cannot. A zero buyer is
    ///      rejected (no real holder is address zero, and the token would mis-recover).
    function payInWithPermit(
        uint256 merchantId,
        address token,
        uint256 usdAmount8,
        address buyer,
        Permit calldata permitData,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes32 orderId,
        uint256 maxValue,
        uint256 intentDeadline,
        bytes calldata intentSig
    ) external nonReentrant {
        if (buyer == address(0)) revert GaslessPayIn__ZeroBuyer();

        uint256 gross = routerContract.quote(merchantId, token, usdAmount8);
        _verifyIntentAndConsumeOrder(
            merchantId,
            token,
            usdAmount8,
            buyer,
            orderId,
            gross,
            maxValue,
            intentDeadline,
            intentSig
        );
        if (permitData.value < gross) {
            revert GaslessPayIn__PermitValueTooLow(permitData.value, gross);
        }

        // Submit the buyer's permit tolerantly: a front-runner could have already consumed this exact
        // permit to set the allowance, which would revert here on the spent nonce — but the allowance is
        // then already in place, so the pull below still succeeds. We only require the PULL, not the
        // permit, so a benign race can never block the buyer's payment.
        // slither-disable-next-line unchecked-lowlevel
        try IERC2612Permit(token)
            .permit(buyer, address(this), permitData.value, permitData.deadline, v, r, s) { }
            catch { }

        _pullAndRoute(merchantId, token, buyer, gross, usdAmount8, orderId, Rail.PERMIT_2612);
    }

    /// @inheritdoc IGaslessPayIn
    /// @dev As {payInWithPermit} but via the ERC-7597 `bytes`-signature permit, so an ERC-1271 SMART
    ///      ACCOUNT buyer can authorize the allowance (the token validates the blob against `buyer`), and
    ///      the {PayInIntent} co-signature is likewise verified via {SignatureChecker} so the SAME smart
    ///      account can bind the intent. The permit is submitted tolerantly; the pull is the gate; the
    ///      `orderId` is marked single-use. CEI + `nonReentrant`.
    function payInWithPermit7597(
        uint256 merchantId,
        address token,
        uint256 usdAmount8,
        address buyer,
        Permit calldata permitData,
        bytes calldata signature,
        bytes32 orderId,
        uint256 maxValue,
        uint256 intentDeadline,
        bytes calldata intentSig
    ) external nonReentrant {
        if (buyer == address(0)) revert GaslessPayIn__ZeroBuyer();

        uint256 gross = routerContract.quote(merchantId, token, usdAmount8);
        _verifyIntentAndConsumeOrder(
            merchantId,
            token,
            usdAmount8,
            buyer,
            orderId,
            gross,
            maxValue,
            intentDeadline,
            intentSig
        );
        if (permitData.value < gross) {
            revert GaslessPayIn__PermitValueTooLow(permitData.value, gross);
        }

        // slither-disable-next-line unchecked-lowlevel
        try IERC7597Permit(token)
            .permit(buyer, address(this), permitData.value, permitData.deadline, signature) { }
            catch { }

        _pullAndRoute(merchantId, token, buyer, gross, usdAmount8, orderId, Rail.PERMIT_7597);
    }

    /// @inheritdoc IGaslessPayIn
    /// @dev CEI + `nonReentrant`. Quote the gross, require the signed transfer `value` EQUALS it exactly
    ///      (a 3009 auth pulls a fixed amount, so an inexact value would leave residue or under-fund),
    ///      then pull DIRECTLY from the buyer into this contract via the token's own
    ///      `transferWithAuthorization` (no allowance step), verifying the balance delta, and route. The
    ///      token enforces the buyer's signature, the validity window, and the single-use nonce; a
    ///      replayed authorization reverts inside the token, so this contract needs no nonce ledger.
    function payInWithAuthorization(
        uint256 merchantId,
        address token,
        uint256 usdAmount8,
        address buyer,
        Authorization calldata auth,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes32 orderId
    ) external nonReentrant {
        if (buyer == address(0)) revert GaslessPayIn__ZeroBuyer();

        // STRUCTURED-NONCE INTENT BINDING (the 3009 core). The 3009 `nonce` is buyer-chosen; require it to
        // equal the intent hash over (chainid, this, merchantId, token, usdAmount8, buyer, orderId). The
        // buyer's token signature therefore also covers the merchant/amount/order — a relayer that passes a
        // different merchantId/usdAmount8/orderId recomputes a different expected nonce, so `auth.nonce`
        // no longer matches and this reverts BEFORE any pull. No new state: the token still marks the nonce
        // single-use, so replay protection is unchanged.
        bytes32 expectedNonce = intentNonce(merchantId, token, usdAmount8, buyer, orderId);
        if (auth.nonce != expectedNonce) {
            revert GaslessPayIn__IntentMismatch(expectedNonce, auth.nonce);
        }

        uint256 gross = routerContract.quote(merchantId, token, usdAmount8);
        if (auth.value != gross) {
            revert GaslessPayIn__AuthorizationValueMismatch(auth.value, gross);
        }

        // Direct allowance-free pull: the token moves exactly `gross` from `buyer` to this contract on
        // the buyer's EIP-3009 signature. Verify via the balance delta (rejecting fee-on-transfer /
        // rebasing tokens) so the amount routed equals what arrived. The authorization is NOT submitted
        // in a try/catch — a 3009 pull is the settlement itself, so its failure MUST revert the pay-in.
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC3009Authorization(token)
            .transferWithAuthorization(
                buyer, address(this), gross, auth.validAfter, auth.validBefore, auth.nonce, v, r, s
            );
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        if (received != gross) revert GaslessPayIn__PullShortfall(gross, received);

        _route(
            merchantId, token, buyer, gross, usdAmount8, orderId, Rail.AUTHORIZATION_3009, balBefore
        );
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev The permit-rail binding gate (2612 + 7597), run BEFORE the permit is submitted (CEI: effects
    ///      before interactions). Three checks + one effect:
    ///        1. `block.timestamp <= intentDeadline` — the buyer's intent has not expired;
    ///        2. `gross <= maxValue` — the router quote is within the buyer-signed ceiling;
    ///        3. the {PayInIntent} EIP-712 signature recovers to `buyer` (ECDSA or ERC-1271 via
    ///           {SignatureChecker}), binding merchant/token/usdAmount8/maxValue/orderId/buyer/deadline;
    ///        4. mark `orderId` single-use (revert on replay) — so a residual-allowance re-pull, which
    ///           would carry the same bound intent, has no unused order and reverts.
    ///      The order gate is set here (before the external permit/pull) so no reentrant or repeated call
    ///      inside the same order can slip a second settlement through.
    function _verifyIntentAndConsumeOrder(
        uint256 merchantId,
        address token,
        uint256 usdAmount8,
        address buyer,
        bytes32 orderId,
        uint256 gross,
        uint256 maxValue,
        uint256 intentDeadline,
        bytes calldata intentSig
    ) private {
        if (block.timestamp > intentDeadline) {
            revert GaslessPayIn__IntentExpired(intentDeadline, block.timestamp);
        }
        if (gross > maxValue) revert GaslessPayIn__IntentValueExceeded(gross, maxValue);

        bytes32 digest = _intentDigest(
            PayInIntent({
                merchantId: merchantId,
                token: token,
                usdAmount8: usdAmount8,
                maxValue: maxValue,
                orderId: orderId,
                buyer: buyer,
                deadline: intentDeadline
            })
        );
        if (!SignatureChecker.isValidSignatureNow(buyer, digest, intentSig)) {
            revert GaslessPayIn__IntentSignatureInvalid();
        }

        if (_orderUsed[orderId]) revert GaslessPayIn__OrderReplay(orderId);
        _orderUsed[orderId] = true;
    }

    /// @dev EIP-712 digest of a {PayInIntent} over this contract's domain. Shared by the external
    ///      {intentDigest} view (off-chain signers read it) and the internal verification.
    function _intentDigest(PayInIntent memory intent) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PAYININTENT_TYPEHASH,
                    intent.merchantId,
                    intent.token,
                    intent.usdAmount8,
                    intent.maxValue,
                    intent.orderId,
                    intent.buyer,
                    intent.deadline
                )
            )
        );
    }

    /// @dev The permit-rail tail: pull exactly `gross` from `buyer` via `safeTransferFrom` (the allowance
    ///      the just-submitted permit granted), verifying the balance delta to reject a fee-on-transfer /
    ///      rebasing token, then route. Shared by the 2612 and 7597 paths (both set an allowance first).
    function _pullAndRoute(
        uint256 merchantId,
        address token,
        address buyer,
        uint256 gross,
        uint256 usdAmount8,
        bytes32 orderId,
        Rail rail
    ) private {
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(buyer, address(this), gross);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        if (received != gross) revert GaslessPayIn__PullShortfall(gross, received);

        _route(merchantId, token, buyer, gross, usdAmount8, orderId, rail, balBefore);
    }

    /// @dev The shared settlement core: approve the router for EXACTLY `gross`, route through its audited
    ///      fee-split (`payToken` re-quotes the same gross in this tx — same feed round — and pushes
    ///      net → merchant + fee → treasury, all in this call), reset the dangling approval to 0
    ///      defensively, then ASSERT zero residual token balance (the zero-custody invariant) and emit.
    ///      `orderId` ties the router's authoritative `net/fee` receipt back to this pay-in. The contract
    ///      holds ~zero of `token` after this — the router pulled the full approval and pushed everything
    ///      out — and the residual check turns "no token balance retained post-call" into an enforced
    ///      revert, never a silent leak.
    function _route(
        uint256 merchantId,
        address token,
        address buyer,
        uint256 gross,
        uint256 usdAmount8,
        bytes32 orderId,
        Rail rail,
        uint256 balBefore
    ) private {
        IERC20(token).forceApprove(address(routerContract), gross);
        routerContract.payToken(merchantId, token, usdAmount8, orderId);
        // The router pulled the full approval; reset any dangling allowance to 0 defensively so no stale
        // approval can ever be reused (it is already 0 on the happy path).
        IERC20(token).forceApprove(address(routerContract), 0);

        // Zero-custody invariant measured as a DELTA against the pre-pull baseline — NOT an absolute
        // zero. We pulled `gross` in (balance rose to balBefore+gross) and the router pulled exactly
        // that back out and pushed net+fee onward, so the balance must return to `balBefore`. An
        // absolute `== 0` check would let a 1-wei dust donation sent to this contract BEFORE the pay-in
        // permanently brick the token's gasless rail (every settle would then see residual != 0 and
        // revert); the delta check retains no NEW token yet is immune to pre-existing dust.
        uint256 balAfter = IERC20(token).balanceOf(address(this));
        if (balAfter != balBefore) revert GaslessPayIn__CustodyResidual(token, balAfter);

        emit GaslessPayInSettled(merchantId, buyer, msg.sender, token, gross, rail, orderId);
    }

    /// @notice Authorize a UUPS upgrade. Restricted to the contract `owner` (the upgrade admin) — the
    ///         single gate {upgradeToAndCall} consults before swapping the implementation.
    /// @dev    Empty body: the `onlyOwner` modifier IS the policy. Once `renounceOwnership()` sets the
    ///         owner to address(0), every call here reverts, so the implementation becomes permanently
    ///         immutable (the on-chain "freeze"). `newImplementation` is intentionally unnamed — no
    ///         per-target allow-listing; the owner is fully trusted to vet the target off-chain.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }
}
