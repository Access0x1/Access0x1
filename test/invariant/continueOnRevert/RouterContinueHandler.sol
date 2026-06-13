// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Access0x1Router } from "../../../src/Access0x1Router.sol";
import { MockUSDC } from "../../mocks/MockUSDC.sol";
import { RescueClaimer } from "../../mocks/RescueClaimer.sol";

/// @notice The HOSTILE, revert-TOLERANT twin of `RouterHandler`. Where the fail-on-revert handler
///         `bound`s inputs and early-returns so no valid call ever reverts, this one fires RAW,
///         unbounded, out-of-order calls — garbage merchant ids, mismatched assets, zero/huge amounts,
///         payments to inactive or non-existent merchants, claims with nothing owed — and lets them
///         revert. The matching suite runs with `fail-on-revert = false`, so the fuzzer is hunting for
///         a reachable state that breaks conservation under adversarial sequences, not asserting that
///         every call succeeds. This mirrors fund-me's `ContinueOnRevert` handler vs its
///         `StopOnRevert` (bounded) one.
/// @dev    Ghost accounting is updated ONLY after a call SUCCEEDS (the `try` arm), so the invariants
///         compare the contract's real money movement against an independent recompute exactly as the
///         bounded suite does — but over the union of accepted-and-rejected inputs. The handler owns
///         the platform + the merchants it creates so it can drive `setPlatformFee` and the squeeze.
contract RouterContinueHandler is Test {
    using Math for uint256;

    Access0x1Router public immutable router;
    MockUSDC public immutable usdc;
    address public immutable treasury;

    /// @notice Net-payment sinks; `payouts[2]` rejects native so the rescue path is exercised.
    address[3] public payouts;
    RescueClaimer public rejectPayout;
    /// @notice Fee sinks, disjoint from payouts + treasury.
    address[2] public feeRecipients;

    /// @notice Merchants the handler created (all ids >= 2; the canary is id 1, registered first).
    uint256[] public merchantIds;

    /// @dev The frozen canary's merchantId. The suite registers it FIRST (before handing the router
    ///      to this handler), and `nextMerchantId` starts at 1, so the canary is always id 1. The
    ///      handler must never pay it — see `_rawId`.
    uint256 internal constant CANARY_ID = 1;

    // ---- ghost accounting (only advanced on a SUCCESSFUL call) ----
    uint256 public ghostGrossNative;
    uint256 public ghostGrossToken;
    uint256 public ghostPlatformNative;
    uint256 public ghostPlatformToken;
    bool public feeCapRespected = true;

    constructor(Access0x1Router router_, MockUSDC usdc_, address treasury_) {
        router = router_;
        usdc = usdc_;
        treasury = treasury_;
        rejectPayout = new RescueClaimer(router_); // Mode.Reject by default
        payouts[0] = makeAddr("c_payout0");
        payouts[1] = makeAddr("c_payout1");
        payouts[2] = address(rejectPayout);
        feeRecipients[0] = makeAddr("c_fee0");
        feeRecipients[1] = makeAddr("c_fee1");
    }

    /// @notice Finish the Ownable2Step handover (called once in setUp).
    function acceptRouterOwnership() external {
        router.acceptOwnership();
    }

    /*//////////////////////////////////////////////////////////////
        HOSTILE ACTIONS — raw, unbounded, may revert (tolerated)
    //////////////////////////////////////////////////////////////*/

    /// @notice Register with RAW inputs — may revert on fee-too-high or zero payout. On success the id
    ///         is tracked; on revert nothing changes (and the suite tolerates it).
    function registerMerchant(uint256 payoutSeed, uint256 feeSeed, uint16 feeBps) external {
        address payout = payouts[payoutSeed % payouts.length];
        address fr = feeRecipients[feeSeed % feeRecipients.length];
        try router.registerMerchant(
            payout, fr, feeBps, keccak256(abi.encode(payout, fr, feeBps))
        ) returns (
            uint256 id
        ) {
            merchantIds.push(id);
        } catch { }
    }

    /// @notice Update with RAW inputs — may revert (not owner of an unowned slot, fee too high). The
    ///         handler IS every created merchant's owner, so legitimate updates can also land.
    function updateMerchant(
        uint256 idSeed,
        uint256 payoutSeed,
        uint256 feeSeed,
        uint16 feeBps,
        bool active
    ) external {
        uint256 id = _rawId(idSeed);
        address payout = payouts[payoutSeed % payouts.length];
        address fr = feeRecipients[feeSeed % feeRecipients.length];
        try router.updateMerchant(id, payout, fr, feeBps, active) { } catch { }
    }

    /// @notice Move the platform fee with a RAW value — may revert past MAX_FEE_BPS (tolerated).
    function setPlatformFee(uint16 newBps) external {
        try router.setPlatformFee(newBps) { } catch { }
    }

    /// @notice Pay native with a RAW merchant id + RAW usd amount + RAW msg.value. Most combinations
    ///         revert (unknown/inactive merchant, underpaid, zero amount); the rare valid one settles.
    function payNative(uint256 idSeed, uint256 usdSeed, uint256 valueSeed) external {
        uint256 id = _rawId(idSeed);
        uint256 usd = usdSeed % (1_000_000e8 + 1); // 0 .. $1M (0 reverts ZeroAmount — tolerated)
        uint256 value = valueSeed % 2_000 ether;

        (address fr, uint256 platformFee, uint256 gross) = _previewNative(id, usd);
        uint256 beforeFee = treasury.balance + (fr == address(0) ? 0 : fr.balance);

        vm.deal(address(this), value);
        try router.payNative{ value: value }(id, usd, bytes32(usd)) {
            // Settled. Record against the independent recompute.
            ghostGrossNative += gross;
            ghostPlatformNative += platformFee;
            _recordFeeCap(gross, (treasury.balance + fr.balance) - beforeFee);
        } catch { }
    }

    /// @notice Pay token with a RAW merchant id + RAW usd amount, sometimes with a MISMATCHED asset
    ///         (native sentinel) to probe the allowlist + the cross-asset firewall.
    function payToken(uint256 idSeed, uint256 usdSeed, bool useNativeSentinel) external {
        uint256 id = _rawId(idSeed);
        uint256 usd = usdSeed % (1_000_000e8 + 1);
        address token = useNativeSentinel ? address(0) : address(usdc);

        (address fr, uint256 platformFee, uint256 gross) = _previewToken(id, usd, token);
        uint256 beforeFee = usdc.balanceOf(treasury) + usdc.balanceOf(fr);

        if (gross > 0) {
            usdc.mint(address(this), gross);
            usdc.approve(address(router), gross);
        }
        try router.payToken(id, token, usd, bytes32(usd)) {
            ghostGrossToken += gross;
            ghostPlatformToken += platformFee;
            _recordFeeCap(gross, (usdc.balanceOf(treasury) + usdc.balanceOf(fr)) - beforeFee);
        } catch { }
    }

    /// @notice Claim rescue from a RAW caller (the rejecting payout). Mostly reverts NothingToRescue;
    ///         when funds were queued it pulls them and lowers the router's residual.
    function claimRescue(uint256 callerSeed) external {
        address claimer = payouts[callerSeed % payouts.length];
        vm.prank(claimer);
        try router.claimRescue() { } catch { }
    }

    /*//////////////////////////////////////////////////////////////
        INTERNAL — best-effort independent preview (view, never reverts)
    //////////////////////////////////////////////////////////////*/

    /// @dev A RAW id from the seed: half the time a handler-created merchant, half the time a garbage
    ///      id in [0, nextMerchantId+8) so the fuzzer also hits unknown/0 ids that must revert cleanly.
    /// @dev The frozen canary (id 1) is NEVER returned: its payout/feeRecipient are deliberately OUTSIDE
    ///      the handler's closed sink set (the basis of the exact conservation recompute), and the
    ///      canary exists only to back the isolation invariant — paying it would move money to an
    ///      untracked sink and is not what this handler models. A garbage seed that resolves to 1 is
    ///      bumped to a still-garbage id (nextMerchantId+1) so the unknown-id revert path stays covered.
    function _rawId(uint256 seed) internal view returns (uint256 id) {
        uint256 len = merchantIds.length;
        if (len > 0 && seed % 2 == 0) {
            id = merchantIds[(seed / 2) % len];
        } else {
            id = seed % (router.nextMerchantId() + 8);
        }
        if (id == CANARY_ID) id = router.nextMerchantId() + 1; // skip the frozen canary
    }

    /// @dev Best-effort recompute of (feeDest, platformFee, gross) for native; returns gross==0 when
    ///      the call would revert so the ghost is never advanced for a reverting path.
    function _previewNative(uint256 id, uint256 usd)
        internal
        view
        returns (address fr, uint256 platformFee, uint256 gross)
    {
        (address payout, address mOwner, address feeRecipient,, bool active,) = router.merchants(id);
        if (mOwner == address(0) || !active || usd == 0) return (payout, 0, 0);
        gross = _quoteNoRevert(address(0), usd);
        if (gross == 0) return (payout, 0, 0);
        fr = feeRecipient == address(0) ? payout : feeRecipient;
        platformFee = Math.mulDiv(gross, router.platformFeeBps(), 10_000);
    }

    /// @dev Best-effort recompute for token; gross==0 (and fr) for any path that would revert.
    function _previewToken(uint256 id, uint256 usd, address token)
        internal
        view
        returns (address fr, uint256 platformFee, uint256 gross)
    {
        (address payout, address mOwner, address feeRecipient,, bool active,) = router.merchants(id);
        if (mOwner == address(0) || !active || usd == 0 || token != address(usdc)) {
            return (payout, 0, 0);
        }
        gross = _quoteNoRevert(token, usd);
        if (gross == 0) return (payout, 0, 0);
        fr = feeRecipient == address(0) ? payout : feeRecipient;
        platformFee = Math.mulDiv(gross, router.platformFeeBps(), 10_000);
    }

    /// @dev Quote without reverting: returns 0 if the quote would revert (unallowed/no-feed/stale).
    function _quoteNoRevert(address token, uint256 usd) internal view returns (uint256) {
        try router.quote(0, token, usd) returns (uint256 q) {
            return q;
        } catch {
            return 0;
        }
    }

    function _recordFeeCap(uint256 gross, uint256 feeCharged) internal {
        if (gross == 0) return;
        if (feeCharged * 10_000 > gross * router.MAX_FEE_BPS()) feeCapRespected = false;
    }

    /*//////////////////////////////////////////////////////////////
        GHOST READOUTS (same shape as the bounded handler)
    //////////////////////////////////////////////////////////////*/

    function outstandingRescue() external view returns (uint256 total) {
        total += router.rescue(payouts[0]);
        total += router.rescue(payouts[1]);
        total += router.rescue(payouts[2]);
        total += router.rescue(feeRecipients[0]);
        total += router.rescue(feeRecipients[1]);
        total += router.rescue(treasury);
    }

    function deliveredNative() external view returns (uint256 total) {
        total += payouts[0].balance;
        total += payouts[1].balance;
        total += payouts[2].balance;
        total += feeRecipients[0].balance;
        total += feeRecipients[1].balance;
        total += treasury.balance;
    }

    function deliveredToken() external view returns (uint256 total) {
        total += usdc.balanceOf(payouts[0]);
        total += usdc.balanceOf(payouts[1]);
        total += usdc.balanceOf(payouts[2]);
        total += usdc.balanceOf(feeRecipients[0]);
        total += usdc.balanceOf(feeRecipients[1]);
        total += usdc.balanceOf(treasury);
    }
}
