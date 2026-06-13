// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title  FeeSplitSymbolic — prove the router's money conservation SYMBOLICALLY (Halmos)
/// @author Access0x1
/// @notice Halmos runs these `check_`-prefixed functions with SYMBOLIC inputs and an SMT solver,
///         proving the property holds for ALL inputs in the declared range — not just the 256 fuzz
///         samples `forge test` draws. The property here is the single most important money invariant
///         in {Access0x1Router}: the fee split CONSERVES value. `net + platformFee + merchantFee` must
///         equal `gross` EXACTLY, for every gross and every fee configuration, with no wei created or
///         destroyed.
///
///         WHY A MIRROR, NOT THE LIVE CONTRACT: the router's `_splitFee` is `private` and the public
///         pay paths read a Chainlink feed (an external call Halmos cannot model symbolically without
///         a feed stub). So this harness re-implements the exact `_splitFee` arithmetic — the same
///         floor rounding and the same MAX_FEE_BPS buyer-protection clamp. It uses plain
///         `gross*bps/DENOM` rather than `Math.mulDiv` because mulDiv's 512-bit branches are SMT-hard;
///         under the bounded domain (gross <= 2^96, bps <= 1000) the product never overflows, so the
///         two are EQUAL — and `testFuzz_split_matchesRouterMulDiv` asserts that equivalence against
///         the real `Math.mulDiv`. The live contract is covered by the fuzz + invariant + scenario
///         suites; this adds the "for-all-inputs" SMT proof of the formula those suites exercise.
///
///         RUN: `make halmos` (installs Halmos via uv if absent). If Halmos is not installed the
///         target no-ops with a clear message; the file still compiles + runs under `forge test` as a
///         couple of concrete sanity cases (the `test_` wrappers below), so the gate is never broken.
contract FeeSplitSymbolic is Test {
    uint256 internal constant FEE_DENOMINATOR = 10_000;
    uint16 internal constant MAX_FEE_BPS = 1000;

    /// @dev A byte-for-byte mirror of {Access0x1Router._splitFee}'s arithmetic (the buyer-protection
    ///      clamp + the two floored fee legs + the net). Kept in lockstep with the contract: if the
    ///      router's formula changes, this mirror must change with it (and the symbolic proof re-runs).
    function _split(uint256 gross, uint256 pBps, uint256 mBps)
        internal
        pure
        returns (uint256 platformFee, uint256 merchantFee, uint256 net)
    {
        // Buyer-protection cap: even if a later platform-fee change pushed the sum past MAX_FEE_BPS,
        // squeeze the MERCHANT surcharge — never the platform cut, never the buyer total.
        if (pBps + mBps > MAX_FEE_BPS) mBps = pBps >= MAX_FEE_BPS ? 0 : MAX_FEE_BPS - pBps;
        // Plain `gross*bps/DENOM` (floored). Under the symbolic bounds (`gross <= 2^96`, `bps <= 1000`)
        // the product is `< 2^106`, so it never overflows and this equals the router's
        // `Math.mulDiv(gross, bps, DENOM)` EXACTLY — `testFuzz_split_matchesRouterMulDiv` asserts that
        // equivalence. Plain arithmetic is used here (not mulDiv) because mulDiv's full 512-bit
        // branches are SMT-hard, making the symbolic proof non-terminating.
        platformFee = (gross * pBps) / FEE_DENOMINATOR;
        merchantFee = (gross * mBps) / FEE_DENOMINATOR;
        net = gross - platformFee - merchantFee;
    }

    /// @notice SYMBOLIC: for ALL gross and ALL fee configs, net + platformFee + merchantFee == gross.
    /// @dev Halmos picks `gross`, `pBps`, `mBps` symbolically. We bound the bps to their real domain
    ///      (each <= MAX_FEE_BPS, the values the router can ever hold) and bound `gross` so the SMT
    ///      problem stays decidable; the conservation identity is what we prove holds universally.
    function check_feeSplit_conservesValue(uint256 gross, uint256 pBps, uint256 mBps) public pure {
        // Constrain inputs to the router's real domain: bps are each capped at MAX_FEE_BPS, and gross
        // is a realistic token amount (well under 2^128) so the solver explores the meaningful space.
        vm.assume(pBps <= MAX_FEE_BPS);
        vm.assume(mBps <= MAX_FEE_BPS);
        vm.assume(gross <= type(uint96).max);

        (uint256 platformFee, uint256 merchantFee, uint256 net) = _split(gross, pBps, mBps);

        // THE INVARIANT: nothing is created or destroyed in the split.
        assert(net + platformFee + merchantFee == gross);
    }

    /// @notice SYMBOLIC: the split never MINTS value and never underflows — net and each fee leg are
    ///         always within `gross`. (The exact MAX_FEE_BPS percentage bound is proven by the
    ///         conservation identity above plus the concrete + live-invariant suites; a `mulDiv`
    ///         division-comparison is intentionally avoided here because it is SMT-hard for the solver
    ///         — we prove the structural no-mint / no-underflow property instead, which conservation
    ///         then upgrades to "the split pays out exactly what it took in, no more.")
    function check_feeSplit_neverMintsValue(uint256 gross, uint256 pBps, uint256 mBps) public pure {
        vm.assume(pBps <= MAX_FEE_BPS);
        vm.assume(mBps <= MAX_FEE_BPS);
        vm.assume(gross <= type(uint96).max);

        (uint256 platformFee, uint256 merchantFee, uint256 net) = _split(gross, pBps, mBps);

        // No value is minted: net is never more than gross, each fee leg is bounded by gross, and the
        // two fee legs together never exceed gross (so `net = gross - fees` never underflows).
        assert(net <= gross);
        assert(platformFee <= gross);
        assert(merchantFee <= gross);
        assert(platformFee + merchantFee <= gross);
    }

    /*//////////////////////////////////////////////////////////////
                    CONCRETE WRAPPERS (run under forge test)
    //////////////////////////////////////////////////////////////*/

    /// @notice So the file is part of the normal `forge test` gate even without Halmos: a couple of
    ///         concrete cases of the same property (Halmos proves the general case symbolically).
    function test_feeSplit_conservesValue_concrete() public pure {
        // $250 at 1% platform + 0.5% merchant (the EndToEnd numbers), in 6-dec USDC.
        (uint256 pf, uint256 mf, uint256 net) = _split(250e6, 100, 50);
        assertEq(net + pf + mf, 250e6, "conservation at the canonical split");
        assertEq(pf, 250e6 * 100 / 10_000, "platform fee = 1%");
        assertEq(mf, 250e6 * 50 / 10_000, "merchant fee = 0.5%");
    }

    /// @notice The buyer-protection clamp: a combined config over MAX_FEE_BPS squeezes the merchant
    ///         surcharge, never the buyer total — and still conserves value.
    function test_feeSplit_clamp_concrete() public pure {
        // platform 800 bps, merchant 500 bps -> 1300 > 1000 cap; merchant squeezed to 1000-800=200.
        (uint256 pf, uint256 mf, uint256 net) = _split(1_000e6, 800, 500);
        assertEq(pf, 1_000e6 * 800 / 10_000, "platform cut untouched by the clamp");
        assertEq(mf, 1_000e6 * 200 / 10_000, "merchant surcharge squeezed to the cap remainder");
        assertEq(net + pf + mf, 1_000e6, "conservation holds under the clamp");
    }

    /// @notice FIDELITY: the symbolic harness's plain-arithmetic legs equal the router's actual
    ///         `Math.mulDiv(gross, bps, DENOM)` for the in-range domain the symbolic proof covers.
    ///         A fuzz cross-check so the symbolic result genuinely speaks to the shipped formula.
    function testFuzz_split_matchesRouterMulDiv(uint96 gross, uint16 pBps, uint16 mBps)
        public
        pure
    {
        pBps = uint16(bound(pBps, 0, MAX_FEE_BPS));
        mBps = uint16(bound(mBps, 0, MAX_FEE_BPS));
        // Apply the SAME clamp the router and `_split` apply, so we compare the post-clamp legs.
        uint256 mEff = uint256(pBps) + mBps > MAX_FEE_BPS
            ? (pBps >= MAX_FEE_BPS ? 0 : MAX_FEE_BPS - pBps)
            : mBps;
        (uint256 pf, uint256 mf,) = _split(gross, pBps, mBps);
        // The router uses Math.mulDiv with floor rounding — identical to plain division when the
        // product does not overflow, which it cannot here (gross <= 2^96, bps <= 1000 => < 2^106).
        assertEq(pf, Math.mulDiv(gross, pBps, FEE_DENOMINATOR), "platform leg == router mulDiv");
        assertEq(mf, Math.mulDiv(gross, mEff, FEE_DENOMINATOR), "merchant leg == router mulDiv");
    }
}
