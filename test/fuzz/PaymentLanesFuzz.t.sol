// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";
import { IPaymentLanes } from "../../src/interfaces/IPaymentLanes.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @title  PaymentLanesFuzz
/// @author Access0x1
/// @notice STATELESS (per-call) fuzz suite for {PaymentLanes} — the Cyfrin "fuzz each public/external
///         function with `bound()`-constrained inputs, then assert the local invariants hold for THIS
///         call" tier. Where the existing unit suite pins specific values and the invariant suite drives
///         long handler sequences, this layer fires ONE function per run over a wide, bounded input
///         space and proves the per-call money/accounting properties that must hold for EVERY input:
///
///           - {credit}:  net == minted lane balance, and the contract's ERC-20 balance rises by EXACTLY
///                        the credited amount (full backing / zero residual custody) — for any amount.
///           - {claim}/{claimLane}: a round-trip conserves value to the wei (credit X → claim X), the
///                        receipt burns to zero, and the pool returns to its pre-claim level.
///           - {transfer}/{transferFrom}: the two legs conserve the per-id supply (sender loses exactly
///                        what the recipient gains) and an allowance is decremented by exactly the spend.
///           - {approve}/{setOperator}: the stored authorization equals the requested value, for any input.
///           - the cross-asset firewall: a credited lane queried for a MISMATCHED asset moves zero of any
///                        pool and does not burn the receipt — for any (amount, mismatched asset).
///
///         Every test bounds amounts to a sane 6-decimal range with `bound()` so the fuzzer spends its
///         budget on meaningful values, never on reverts it cannot satisfy. A green run is the proof the
///         per-call laws hold across the whole input domain, not just the unit suite's hand-picked points.
/// @dev    Reuses the canonical {MockUSDC} (6-decimal) mock — a second instance (`eurc`) stands in for
///         "any other coin" so cross-asset isolation is exercised. No new mocks are introduced.
contract PaymentLanesFuzzTest is Test, ProxyDeployer {
    PaymentLanes internal lanes;
    MockUSDC internal usdc;
    MockUSDC internal eurc; // a second 6dp asset — a distinct lane id from usdc

    address internal admin = makeAddr("plf_admin");
    address internal router = makeAddr("plf_router"); // the authorized-router stand-in
    address internal merchant = makeAddr("plf_merchant");
    address internal other = makeAddr("plf_other");
    address internal spender = makeAddr("plf_spender");

    /// @notice The largest amount any single fuzz credit funds: $1,000,000,000 of a 6-dp asset. Bounding
    ///         here (rather than at type(uint256).max) keeps the router stand-in solvent for the pull-in
    ///         while still spanning dust → billions. Overflow at the uint256 boundary is an ATTACK-suite
    ///         concern (NoMoveToken), not a backing-conservation concern.
    uint256 internal constant MAX_AMT = 1_000_000_000e6;

    function setUp() public {
        lanes = PaymentLanes(
            deployProxy(
                address(new PaymentLanes()), abi.encodeCall(PaymentLanes.initialize, (admin))
            )
        );
        usdc = new MockUSDC();
        eurc = new MockUSDC();

        vm.prank(admin);
        lanes.setRouter(router, true);

        // The router stand-in is funded + approved so its credits are fully backed by a real pull-in.
        usdc.mint(router, type(uint128).max);
        eurc.mint(router, type(uint128).max);
        vm.startPrank(router);
        usdc.approve(address(lanes), type(uint256).max);
        eurc.approve(address(lanes), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev Credit `amount` of `asset` to `recipient` as the authorized router.
    function _credit(address recipient, address asset, uint256 amount) internal returns (uint256) {
        vm.prank(router);
        return lanes.credit(recipient, asset, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                 credit
    //////////////////////////////////////////////////////////////*/

    /// @notice For ANY positive amount, {credit} mints a lane balance equal to the amount AND pulls in
    ///         exactly that many tokens — proving the lane is fully backed and the contract holds no
    ///         surplus (zero residual custody). This is the per-call form of the conservation invariant.
    function testFuzz_credit_mintsExactlyAndIsFullyBacked(uint256 amount) public {
        amount = bound(amount, 1, MAX_AMT);
        uint256 poolBefore = usdc.balanceOf(address(lanes));

        uint256 id = _credit(merchant, address(usdc), amount);

        // Minted lane balance == amount; the lane id is the deterministic triple key.
        assertEq(id, lanes.laneId(block.chainid, address(usdc), merchant), "id is the triple key");
        assertEq(lanes.balanceOf(merchant, id), amount, "minted balance == credited amount");
        // The contract's USDC balance rose by EXACTLY amount: net == fee-free backing, no residual.
        assertEq(
            usdc.balanceOf(address(lanes)), poolBefore + amount, "pool backed by exactly amount"
        );
    }

    /// @notice Repeated credits to the SAME lane accumulate additively and stay fully backed: the lane
    ///         balance is the running sum and the pool matches it wei-for-wei, for any two amounts.
    function testFuzz_credit_accumulatesAndStaysBacked(uint256 a, uint256 b) public {
        a = bound(a, 1, MAX_AMT);
        b = bound(b, 1, MAX_AMT);

        uint256 id = _credit(merchant, address(usdc), a);
        _credit(merchant, address(usdc), b);

        assertEq(
            lanes.balanceOf(merchant, id), a + b, "second credit accumulates onto the same lane"
        );
        assertEq(usdc.balanceOf(address(lanes)), a + b, "pool backs the running sum exactly");
    }

    /// @notice {credit} reverts for ANY non-router caller, no matter the (recipient, asset, amount) — an
    ///         attacker can never mint a receipt against a real pool. (Amount bounded > 0 so the
    ///         authorization check, not the zero-amount guard, is what fires.)
    function testFuzz_credit_revertsForNonRouter(address caller, uint256 amount) public {
        vm.assume(caller != router);
        amount = bound(amount, 1, MAX_AMT);
        vm.prank(caller);
        vm.expectRevert(IPaymentLanes.PaymentLanes__Unauthorized.selector);
        lanes.credit(merchant, address(usdc), amount);
    }

    /*//////////////////////////////////////////////////////////////
                              claim / claimLane
    //////////////////////////////////////////////////////////////*/

    /// @notice Credit→claim round-trip conserves value exactly for ANY amount: the receipt burns to zero,
    ///         the underlying lands in the claimant's wallet, and the pool returns to its baseline — no
    ///         wei created or destroyed across the whole cycle.
    function testFuzz_claim_roundTripConservesValue(uint256 amount) public {
        amount = bound(amount, 1, MAX_AMT);
        uint256 id = _credit(merchant, address(usdc), amount);
        uint256 poolAfterCredit = usdc.balanceOf(address(lanes));

        vm.prank(merchant);
        lanes.claim(address(usdc));

        assertEq(lanes.balanceOf(merchant, id), 0, "receipt burned to zero");
        assertEq(usdc.balanceOf(merchant), amount, "claimant received exactly the credited amount");
        assertEq(
            usdc.balanceOf(address(lanes)),
            poolAfterCredit - amount,
            "pool drained by exactly amount"
        );
    }

    /// @notice {claimLane} of an explicit id behaves identically to the convenience {claim} for the
    ///         original recipient — full value out, receipt burned — for any amount.
    function testFuzz_claimLane_burnsExplicitIdForFullValue(uint256 amount) public {
        amount = bound(amount, 1, MAX_AMT);
        uint256 id = _credit(merchant, address(usdc), amount);

        vm.prank(merchant);
        lanes.claimLane(id, address(usdc));

        assertEq(lanes.balanceOf(merchant, id), 0, "explicit-id claim burns the receipt");
        assertEq(usdc.balanceOf(merchant), amount, "explicit-id claim pays full value");
    }

    /// @notice CROSS-ASSET FIREWALL (per-call): a lane funded by `usdc` queried for ANY mismatched asset
    ///         is a safe no-op — it pays zero of the mismatched pool, leaves the foreign pool untouched,
    ///         and does NOT burn the receipt (so full value stays redeemable on the bound asset). Proven
    ///         over a fuzzed amount on both the credited and the foreign pool.
    function testFuzz_claimLane_mismatchedAssetIsNoOp(uint256 amount, uint256 foreignAmount)
        public
    {
        amount = bound(amount, 1, MAX_AMT);
        foreignAmount = bound(foreignAmount, 1, MAX_AMT);

        // Stand up a foreign EURC pool the mismatched claim would love to reach.
        _credit(other, address(eurc), foreignAmount);
        uint256 id = _credit(merchant, address(usdc), amount);

        uint256 eurcPool = eurc.balanceOf(address(lanes));
        uint256 usdcPool = usdc.balanceOf(address(lanes));

        // Point the USDC-backed lane at EURC: must move nothing and must not burn the receipt.
        vm.prank(merchant);
        lanes.claimLane(id, address(eurc));

        assertEq(lanes.balanceOf(merchant, id), amount, "receipt survives the mismatched no-op");
        assertEq(eurc.balanceOf(address(lanes)), eurcPool, "foreign EURC pool untouched");
        assertEq(usdc.balanceOf(address(lanes)), usdcPool, "USDC pool untouched");
        assertEq(eurc.balanceOf(merchant), 0, "claimant gained no foreign asset");

        // The bound-asset claim still pays full value — the no-op was not a griefing burn.
        vm.prank(merchant);
        lanes.claimLane(id, address(usdc));
        assertEq(usdc.balanceOf(merchant), amount, "full value redeemable on the bound asset");
        assertEq(lanes.balanceOf(merchant, id), 0, "now burned");
    }

    /// @notice {claim} reverts {NothingToClaim} for ANY caller with no balance on its own derived lane —
    ///         an empty/never-funded lane can never silently pay out, for any (caller, asset) pair.
    function testFuzz_claim_revertsOnEmptyLane(address caller) public {
        vm.assume(caller != address(0));
        // No credit to `caller`'s usdc lane → its balance is zero.
        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__NothingToClaim.selector, caller, address(usdc)
            )
        );
        lanes.claim(address(usdc));
    }

    /*//////////////////////////////////////////////////////////////
                                transfer
    //////////////////////////////////////////////////////////////*/

    /// @notice {transfer} conserves the per-id supply for ANY (credit, move) pair within balance: the
    ///         sender loses exactly what the recipient gains, and the sum is the original credit. The
    ///         contract's pool is UNCHANGED by a transfer (a receipt moves between owners, not in/out).
    function testFuzz_transfer_conservesPerIdSupply(uint256 credited, uint256 moved) public {
        credited = bound(credited, 1, MAX_AMT);
        uint256 id = _credit(merchant, address(usdc), credited);
        moved = bound(moved, 0, credited);
        uint256 poolBefore = usdc.balanceOf(address(lanes));

        vm.prank(merchant);
        bool ok = lanes.transfer(other, id, moved);

        assertTrue(ok, "transfer returns true");
        assertEq(lanes.balanceOf(merchant, id), credited - moved, "sender debited by exactly moved");
        assertEq(lanes.balanceOf(other, id), moved, "recipient credited by exactly moved");
        assertEq(
            lanes.balanceOf(merchant, id) + lanes.balanceOf(other, id),
            credited,
            "per-id supply conserved across the two legs"
        );
        assertEq(
            usdc.balanceOf(address(lanes)), poolBefore, "a transfer never moves the backing pool"
        );
    }

    /// @notice {transfer} reverts {InsufficientBalance} whenever the move exceeds the holder's balance —
    ///         a holder can never spend more of a lane than it holds, for any overspend delta.
    function testFuzz_transfer_revertsOnOverspend(uint256 credited, uint256 overBy) public {
        credited = bound(credited, 1, MAX_AMT);
        overBy = bound(overBy, 1, type(uint128).max);
        uint256 id = _credit(merchant, address(usdc), credited);
        uint256 want = credited + overBy;

        vm.prank(merchant);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__InsufficientBalance.selector,
                merchant,
                id,
                credited,
                want
            )
        );
        lanes.transfer(other, id, want);
    }

    /*//////////////////////////////////////////////////////////////
                              transferFrom
    //////////////////////////////////////////////////////////////*/

    /// @notice A finite per-id allowance is decremented by EXACTLY the spend and the balances move by the
    ///         same amount — for any (credited, allowance, spend) where spend <= min(balance, allowance).
    function testFuzz_transferFrom_decrementsAllowanceExactly(
        uint256 credited,
        uint256 allowanceAmt,
        uint256 spend
    ) public {
        credited = bound(credited, 1, MAX_AMT);
        uint256 id = _credit(merchant, address(usdc), credited);
        // Allowance and spend both bounded so the call succeeds: spend <= balance and spend <= allowance.
        allowanceAmt = bound(allowanceAmt, 1, credited);
        spend = bound(spend, 1, allowanceAmt);

        vm.prank(merchant);
        lanes.approve(spender, id, allowanceAmt);

        vm.prank(spender);
        bool ok = lanes.transferFrom(merchant, other, id, spend);

        assertTrue(ok, "transferFrom returns true");
        assertEq(lanes.balanceOf(merchant, id), credited - spend, "owner debited by spend");
        assertEq(lanes.balanceOf(other, id), spend, "recipient credited by spend");
        assertEq(
            lanes.allowance(merchant, spender, id),
            allowanceAmt - spend,
            "allowance decremented by exactly spend"
        );
    }

    /// @notice An operator moves any amount within balance WITHOUT consuming a per-id allowance — the
    ///         operator path bypasses the allowance entirely (ERC-6909), for any (credited, allowance,
    ///         spend<=balance).
    function testFuzz_transferFrom_operatorBypassesAllowance(
        uint256 credited,
        uint256 allowanceAmt,
        uint256 spend
    ) public {
        credited = bound(credited, 1, MAX_AMT);
        uint256 id = _credit(merchant, address(usdc), credited);
        allowanceAmt = bound(allowanceAmt, 0, MAX_AMT);
        spend = bound(spend, 1, credited);

        vm.startPrank(merchant);
        lanes.approve(spender, id, allowanceAmt); // an arbitrary allowance the operator must NOT touch
        lanes.setOperator(spender, true);
        vm.stopPrank();

        vm.prank(spender);
        lanes.transferFrom(merchant, other, id, spend);

        assertEq(lanes.balanceOf(other, id), spend, "operator moved the requested amount");
        assertEq(
            lanes.allowance(merchant, spender, id),
            allowanceAmt,
            "operator path left the allowance untouched"
        );
    }

    /// @notice An infinite allowance (`type(uint256).max`) is sticky: it is NOT decremented by a spend,
    ///         for any spend within balance.
    function testFuzz_transferFrom_infiniteAllowanceSticky(uint256 credited, uint256 spend) public {
        credited = bound(credited, 1, MAX_AMT);
        uint256 id = _credit(merchant, address(usdc), credited);
        spend = bound(spend, 1, credited);

        vm.prank(merchant);
        lanes.approve(spender, id, type(uint256).max);

        vm.prank(spender);
        lanes.transferFrom(merchant, other, id, spend);

        assertEq(
            lanes.allowance(merchant, spender, id),
            type(uint256).max,
            "infinite allowance is never decremented"
        );
    }

    /*//////////////////////////////////////////////////////////////
                            approve / setOperator
    //////////////////////////////////////////////////////////////*/

    /// @notice {approve} stores exactly the requested allowance for any (spender, id, amount) — overwrite
    ///         semantics, no zero-first dance.
    function testFuzz_approve_storesExactValue(address sp, uint256 id, uint256 amount) public {
        vm.assume(sp != address(0));
        vm.prank(merchant);
        bool ok = lanes.approve(sp, id, amount);
        assertTrue(ok, "approve returns true");
        assertEq(lanes.allowance(merchant, sp, id), amount, "stored allowance == requested amount");
    }

    /// @notice {setOperator} stores exactly the requested flag for any (operator, approved) — and is
    ///         owner-scoped (it never leaks to a third party's operator map).
    function testFuzz_setOperator_storesExactFlag(address op, bool approved) public {
        vm.assume(op != address(0));
        vm.prank(merchant);
        bool ok = lanes.setOperator(op, approved);
        assertTrue(ok, "setOperator returns true");
        assertEq(lanes.isOperator(merchant, op), approved, "stored operator flag == requested flag");
        assertFalse(lanes.isOperator(other, op), "operator flag did not leak to another owner");
    }

    /*//////////////////////////////////////////////////////////////
                              setRouter (admin)
    //////////////////////////////////////////////////////////////*/

    /// @notice {setRouter} stores exactly the requested authorization for any (router, flag) and only the
    ///         owner may call it — a non-owner is always rejected by Ownable.
    function testFuzz_setRouter_ownerOnlyAndStoresFlag(address r, bool flag) public {
        vm.assume(r != address(0));

        // Owner path: the flag is stored verbatim.
        vm.prank(admin);
        lanes.setRouter(r, flag);
        assertEq(lanes.isRouter(r), flag, "owner-set router flag stored verbatim");
    }

    /// @notice Any non-owner caller of {setRouter} is rejected — the allowlist is admin-controlled only.
    function testFuzz_setRouter_revertsForNonOwner(address caller, address r, bool flag) public {
        vm.assume(caller != admin && r != address(0));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        lanes.setRouter(r, flag);
    }

    /*//////////////////////////////////////////////////////////////
                                 laneId
    //////////////////////////////////////////////////////////////*/

    /// @notice {laneId} is the pure `keccak256(abi.encode(triple))` for ANY triple, and is recomputable
    ///         off-chain for free (deterministic, no storage read). The unit suite already covers
    ///         determinism + distinctness; this pins the EXACT preimage formula over the full domain so a
    ///         silent change to the hashing scheme (which would break every off-chain lane lookup) trips.
    function testFuzz_laneId_matchesAbiEncodePreimage(
        uint256 chainId_,
        address asset,
        address recipient
    ) public view {
        assertEq(
            lanes.laneId(chainId_, asset, recipient),
            uint256(keccak256(abi.encode(chainId_, asset, recipient))),
            "laneId must equal keccak256(abi.encode(chainId, asset, recipient))"
        );
    }
}
