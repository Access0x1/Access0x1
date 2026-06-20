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
    ReentrancyGuardTransient
} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Access0x1Router } from "./Access0x1Router.sol";
import {
    IGaslessPayIn,
    IERC2612Permit,
    IERC7597Permit,
    IERC3009Authorization
} from "./interfaces/IGaslessPayIn.sol";

/// @title  GaslessPayIn
/// @author Rensley R. @vyperpilleddev
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
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    /// @notice The shared, audited payments router this contract composes. Set once in {initialize} and
    ///         never repointed (no setter) — the fee-split, pricing (USD→token via {OracleLib}'s
    ///         staleness guard), the allowlist, and the zero-custody push are all delegated to it (a new
    ///         router = a new GaslessPayIn proxy / fresh initialize).
    /// @dev    Plain storage, not `immutable`: an upgradeable contract reads state from the proxy, while
    ///         an `immutable` lives in the implementation bytecode. Effectively immutable per proxy.
    Access0x1Router public routerContract;

    /// @dev Reserved storage slots so future versions can APPEND new state without shifting the layout
    ///      above (UUPS storage-collision safety). Each new variable added in a later version consumes
    ///      one slot from the head of this gap; shrink `__gap` by exactly the number of slots added so
    ///      the total stays 50. NEVER reorder or insert a variable above this gap — only append.
    uint256[50] private __gap;

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
    /// @dev    Wires every base: Ownable + its 2-step extension. `initialOwner` becomes the UPGRADE ADMIN
    ///         (the `Ownable2Step` owner); it must be non-zero (`__Ownable_init` reverts on zero). There
    ///         is no `__UUPSUpgradeable_init()`/`__ReentrancyGuard_init()` in OZ 5.x (those bases hold no
    ///         initializable storage). The router must be non-zero (a new router = a fresh proxy).
    /// @param initialOwner The contract owner / upgrade admin (non-zero). Holds NO authority over any
    ///                     pay-in — the pay paths are permissionless and buyer-signed.
    /// @param router_      The deployed {Access0x1Router} every pay-in settles through.
    function initialize(address initialOwner, Access0x1Router router_) external initializer {
        if (address(router_) == address(0)) revert GaslessPayIn__ZeroAddress();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
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

    /*//////////////////////////////////////////////////////////////
                                PAY-IN
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IGaslessPayIn
    /// @dev CEI + `nonReentrant`. Quote the gross IN-TX, require the signed allowance covers it, submit
    ///      the EIP-2612 permit TOLERANTLY (a front-run that already set the allowance must not brick the
    ///      pay-in — the pull is the real gate), pull exactly the gross, then route. The permit is
    ///      submitted with the EXACT `buyer`/`this`/`value`/`deadline` the buyer signed, so a relayer can
    ///      neither alter the grant nor redirect it. A zero buyer is rejected (no real holder is address
    ///      zero, and the token would mis-recover).
    function payInWithPermit(
        uint256 merchantId,
        address token,
        uint256 usdAmount8,
        address buyer,
        Permit calldata permitData,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes32 orderId
    ) external nonReentrant {
        if (buyer == address(0)) revert GaslessPayIn__ZeroBuyer();

        uint256 gross = routerContract.quote(merchantId, token, usdAmount8);
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
    ///      ACCOUNT buyer can authorize the allowance (the token validates the blob against `buyer`). The
    ///      permit is likewise submitted tolerantly; the pull is the gate. CEI + `nonReentrant`.
    function payInWithPermit7597(
        uint256 merchantId,
        address token,
        uint256 usdAmount8,
        address buyer,
        Permit calldata permitData,
        bytes calldata signature,
        bytes32 orderId
    ) external nonReentrant {
        if (buyer == address(0)) revert GaslessPayIn__ZeroBuyer();

        uint256 gross = routerContract.quote(merchantId, token, usdAmount8);
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

        _route(merchantId, token, buyer, gross, usdAmount8, orderId, Rail.AUTHORIZATION_3009);
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

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

        _route(merchantId, token, buyer, gross, usdAmount8, orderId, rail);
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
        Rail rail
    ) private {
        IERC20(token).forceApprove(address(routerContract), gross);
        routerContract.payToken(merchantId, token, usdAmount8, orderId);
        // The router pulled the full approval; reset any dangling allowance to 0 defensively so no stale
        // approval can ever be reused (it is already 0 on the happy path).
        IERC20(token).forceApprove(address(routerContract), 0);

        // Zero-custody invariant: the contract must retain NO balance of the routed token. The router
        // pulled exactly `gross` and pushed net + fee out in the same tx, so this is 0 on the happy path;
        // a non-zero residual (a misbehaving token, an unexpected router accounting) reverts the whole
        // pay-in rather than stranding funds here.
        uint256 residual = IERC20(token).balanceOf(address(this));
        if (residual != 0) revert GaslessPayIn__CustodyResidual(token, residual);

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
