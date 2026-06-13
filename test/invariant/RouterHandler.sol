// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { RescueClaimer } from "../mocks/RescueClaimer.sol";

/// @notice The actor that drives the invariant fuzzer through every state-changing path of the
///         router — register, update, raise the platform fee, and pay in native + token — while
///         keeping ghost accounting the invariant suite checks the contract against.
/// @dev    The handler is BOTH the platform owner (so it can move the platform fee and exercise the
///         `_splitFee` squeeze) and every merchant's owner (so it can update them). Every action is
///         written to NEVER revert (the suite runs `fail_on_revert = true`): inputs are `bound`ed
///         and preconditions early-return. Fee/treasury sinks are dedicated, disjoint addresses so
///         their whole balance provably came from the router — that is what makes the conservation
///         and "platform cut lands at treasury" checks exact.
contract RouterHandler is Test {
    using Math for uint256;

    Access0x1Router public immutable router;
    MockUSDC public immutable usdc;
    address public immutable treasury;

    /// @notice Net-payment sinks. `payouts[2]` is a contract that rejects native (its net is queued
    ///         to `rescue`), so the residual-equals-rescue invariant is actually exercised.
    address[3] public payouts;
    RescueClaimer public rejectPayout;
    /// @notice Fee sinks, DISJOINT from payouts + treasury (so a fee leg never lands in a net sink).
    address[2] public feeRecipients;

    /// @notice Merchants the handler created (the frozen canary is deliberately excluded).
    uint256[] public merchantIds;

    // ---- ghost accounting (the spec the contract is checked against) ----
    uint256 public ghostGrossNative; // Σ native gross sent into payNative
    uint256 public ghostGrossToken; // Σ token gross sent into payToken
    uint256 public ghostPlatformNative; // Σ expected platform fee (native), independent recompute
    uint256 public ghostPlatformToken; // Σ expected platform fee (token)
    bool public feeCapRespected = true; // AND of "fee ≤ MAX_FEE_BPS" over every payment

    constructor(Access0x1Router router_, MockUSDC usdc_, address treasury_) {
        router = router_;
        usdc = usdc_;
        treasury = treasury_;
        rejectPayout = new RescueClaimer(router_); // defaults to Mode.Reject
        payouts[0] = makeAddr("h_payout0");
        payouts[1] = makeAddr("h_payout1");
        payouts[2] = address(rejectPayout);
        feeRecipients[0] = makeAddr("h_fee0");
        feeRecipients[1] = makeAddr("h_fee1");
    }

    /// @notice Finish the Ownable2Step handover from the test (called once in setUp).
    function acceptRouterOwnership() external {
        router.acceptOwnership();
    }

    /// @dev The largest merchant surcharge that keeps `feeBps + platformFeeBps ≤ MAX_FEE_BPS`,
    ///      so register/update never revert on the fee cap.
    function _maxMerchantBps() internal view returns (uint16) {
        return router.MAX_FEE_BPS() - router.platformFeeBps();
    }

    /// @dev Resolve a created merchant from a seed; `ok` is false when none exist or it is inactive.
    function _pickActive(uint256 seed) internal view returns (uint256 id, bool ok) {
        uint256 len = merchantIds.length;
        if (len == 0) return (0, false);
        id = merchantIds[seed % len];
        (, address mOwner,,, bool active,) = router.merchants(id);
        ok = mOwner != address(0) && active;
    }

    /*//////////////////////////////////////////////////////////////
                                ACTIONS
    //////////////////////////////////////////////////////////////*/

    function registerMerchant(uint256 payoutSeed, uint256 feeSeed, uint16 feeBps) external {
        address payout = payouts[payoutSeed % payouts.length];
        address fr = feeRecipients[feeSeed % feeRecipients.length];
        feeBps = uint16(bound(feeBps, 0, _maxMerchantBps()));
        uint256 id = router.registerMerchant(payout, fr, feeBps, keccak256(abi.encode(payout, fr)));
        merchantIds.push(id);
    }

    function updateMerchant(
        uint256 idSeed,
        uint256 payoutSeed,
        uint256 feeSeed,
        uint16 feeBps,
        bool active
    ) external {
        if (merchantIds.length == 0) return;
        uint256 id = merchantIds[idSeed % merchantIds.length];
        address payout = payouts[payoutSeed % payouts.length];
        address fr = feeRecipients[feeSeed % feeRecipients.length];
        feeBps = uint16(bound(feeBps, 0, _maxMerchantBps()));
        router.updateMerchant(id, payout, fr, feeBps, active);
    }

    /// @notice Move the platform fee within [0, MAX] — this is what lets the fuzzer push an existing
    ///         merchant's `platformFeeBps + feeBps` past the cap and exercise the surcharge squeeze.
    function setPlatformFee(uint16 newBps) external {
        router.setPlatformFee(uint16(bound(newBps, 0, router.MAX_FEE_BPS())));
    }

    function payNative(uint256 idSeed, uint256 usdSeed) external {
        (uint256 id, bool ok) = _pickActive(idSeed);
        if (!ok) return;
        uint256 usd = bound(usdSeed, 1e8, 100_000e8); // $1 .. $100k
        uint256 gross = router.quote(id, address(0), usd);
        if (gross == 0) return;

        (address fr, uint256 platformFee) = _expected(id, gross);
        uint256 beforeFee = treasury.balance + fr.balance;

        vm.deal(address(this), gross);
        router.payNative{ value: gross }(id, usd, bytes32(usd));

        ghostGrossNative += gross;
        ghostPlatformNative += platformFee;
        _recordFeeCap(gross, (treasury.balance + fr.balance) - beforeFee);
    }

    function payToken(uint256 idSeed, uint256 usdSeed) external {
        (uint256 id, bool ok) = _pickActive(idSeed);
        if (!ok) return;
        uint256 usd = bound(usdSeed, 1e8, 100_000e8);
        uint256 gross = router.quote(id, address(usdc), usd);
        if (gross == 0) return;

        (address fr, uint256 platformFee) = _expected(id, gross);
        uint256 beforeFee = usdc.balanceOf(treasury) + usdc.balanceOf(fr);

        usdc.mint(address(this), gross);
        usdc.approve(address(router), gross);
        router.payToken(id, address(usdc), usd, bytes32(usd));

        ghostGrossToken += gross;
        ghostPlatformToken += platformFee;
        _recordFeeCap(gross, (usdc.balanceOf(treasury) + usdc.balanceOf(fr)) - beforeFee);
    }

    /// @dev The merchant's fee recipient + the platform fee leg, recomputed independently of the
    ///      contract. The platform leg is never squeezed, so this is the exact treasury credit.
    function _expected(uint256 id, uint256 gross)
        internal
        view
        returns (address fr, uint256 platformFee)
    {
        (address payout,, address feeRecipient,,,) = router.merchants(id);
        fr = feeRecipient == address(0) ? payout : feeRecipient;
        platformFee = Math.mulDiv(gross, router.platformFeeBps(), 10_000);
    }

    /// @dev Fold this payment into the fee-cap invariant: the total fee the router actually charged
    ///      (the delta delivered to treasury + fee recipient) must be ≤ MAX_FEE_BPS of gross.
    function _recordFeeCap(uint256 gross, uint256 feeCharged) internal {
        if (feeCharged * 10_000 > gross * router.MAX_FEE_BPS()) feeCapRespected = false;
    }

    /// @notice Sum the native still owed across every sink (only the rejecting payout ever queues).
    function outstandingRescue() external view returns (uint256 total) {
        total += router.rescue(payouts[0]);
        total += router.rescue(payouts[1]);
        total += router.rescue(payouts[2]);
        total += router.rescue(feeRecipients[0]);
        total += router.rescue(feeRecipients[1]);
        total += router.rescue(treasury);
    }

    /// @notice Sum the native delivered to every sink (what the router successfully pushed out).
    function deliveredNative() external view returns (uint256 total) {
        total += payouts[0].balance;
        total += payouts[1].balance;
        total += payouts[2].balance;
        total += feeRecipients[0].balance;
        total += feeRecipients[1].balance;
        total += treasury.balance;
    }

    /// @notice Sum the token delivered to every sink.
    function deliveredToken() external view returns (uint256 total) {
        total += usdc.balanceOf(payouts[0]);
        total += usdc.balanceOf(payouts[1]);
        total += usdc.balanceOf(payouts[2]);
        total += usdc.balanceOf(feeRecipients[0]);
        total += usdc.balanceOf(feeRecipients[1]);
        total += usdc.balanceOf(treasury);
    }
}
