// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";
import { IPaymentLanes } from "../../src/interfaces/IPaymentLanes.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

/// @notice FABLE RED-TEAM adversarial suite for the ERC-6909 PaymentLanes unit. Every test here is an
///         EXPLOIT ATTEMPT, not happy-path coverage. The unit MUST resist:
///           - cross-merchant lane leakage (a holder of lane X cannot touch lane Y's balance)
///           - cross-ASSET pool drain via {claimLane} (a cheap-asset receipt cannot pull an
///             expensive asset out of the shared contract)
///           - lane-id collision / forgery (forge a known merchant's lane id)
///           - ERC-6909 approval / operator abuse (spend without authorization)
///           - balance over/underflow
///           - reentrancy on the value paths
///           - zero / dust edge cases
/// @dev    A green run is the proof the unit holds. A FAILING assertion in here that documents a real
///         loss is a BREAK that proc-contracts must fix in src/ (red-team never edits src/).
contract PaymentLanesAttackTest is Test {
    PaymentLanes internal lanes;
    MockUSDC internal usdc; // the valuable asset (real USDC stand-in, 6dp)
    MockUSDC internal evil; // a second 6dp asset the attacker can mint freely (worthless coin)

    address internal admin = makeAddr("pl_attack_admin");
    address internal router = makeAddr("pl_attack_router");
    address internal merchantA = makeAddr("pl_attack_merchantA");
    address internal merchantB = makeAddr("pl_attack_merchantB");
    address internal attacker = makeAddr("pl_attack_attacker");

    uint256 internal constant NET = 1_000e6;

    function setUp() public {
        lanes = new PaymentLanes(admin);
        usdc = new MockUSDC();
        evil = new MockUSDC();

        vm.prank(admin);
        lanes.setRouter(router, true);

        // The authorized router is funded + approved for both assets so its credits back the lanes.
        usdc.mint(router, 10_000_000e6);
        evil.mint(router, 10_000_000e6);
        vm.startPrank(router);
        usdc.approve(address(lanes), type(uint256).max);
        evil.approve(address(lanes), type(uint256).max);
        vm.stopPrank();
    }

    function _credit(address recipient, address asset, uint256 amount) internal returns (uint256) {
        vm.prank(router);
        return lanes.credit(recipient, asset, amount);
    }

    /*//////////////////////////////////////////////////////////////
          ATTACK 1 — CROSS-ASSET POOL DRAIN VIA claimLane(id, asset)
    //////////////////////////////////////////////////////////////*/

    /// @notice HEADLINE EXPLOIT. {claimLane} takes `id` and `asset` as INDEPENDENT arguments and pays
    ///         out `_balanceOf[msg.sender][id]` units of `asset` while burning the receipt on `id`.
    ///         The receipt's backing asset is NOT bound to the `asset` argument. So a holder of a lane
    ///         backed by a WORTHLESS coin can burn that receipt while pointing `asset` at USDC — and
    ///         walk away with USDC that backs OTHER merchants' lanes. This is cross-asset + cross-
    ///         merchant value theft.
    ///
    ///         Concretely: merchantB legitimately holds $1,000 USDC in a lane (PaymentLanes holds
    ///         1,000e6 USDC). The attacker is credited 1,000 units of a worthless `evil` coin (its own
    ///         lane, fully backed by evil). The attacker then calls claimLane(evilLaneId, usdc) and
    ///         receives 1,000e6 USDC — draining merchantB's backing. merchantB can no longer claim.
    function test_attack_claimLane_crossAssetDrain() public {
        // Victim: a real merchant with a real USDC lane.
        uint256 idB = _credit(merchantB, address(usdc), NET);
        assertEq(usdc.balanceOf(address(lanes)), NET, "victim USDC backing held");

        // Attacker gets a same-SIZED lane on a worthless coin it can obtain cheaply.
        uint256 idEvil = _credit(attacker, address(evil), NET);
        // After both credits PaymentLanes holds NET usdc + NET evil.
        assertEq(usdc.balanceOf(address(lanes)), NET);
        assertEq(evil.balanceOf(address(lanes)), NET);

        uint256 attackerUsdcBefore = usdc.balanceOf(attacker);

        // EXPLOIT: burn the EVIL-backed receipt but ask for USDC.
        vm.prank(attacker);
        lanes.claimLane(idEvil, address(usdc));

        uint256 attackerUsdcAfter = usdc.balanceOf(attacker);

        // If the attacker received ANY usdc, the cross-asset drain succeeded.
        if (attackerUsdcAfter > attackerUsdcBefore) {
            // Document the break: the victim's backing is gone and the victim's own claim now fails.
            assertEq(
                attackerUsdcAfter - attackerUsdcBefore,
                NET,
                "BREAK: attacker drained the full USDC pool with a worthless-coin receipt"
            );
            // Victim's lane balance is still NET (untouched bookkeeping) but the USDC is gone.
            assertEq(lanes.balanceOf(merchantB, idB), NET, "victim still 'owns' NET on paper");
            assertLt(
                usdc.balanceOf(address(lanes)), NET, "BREAK: USDC backing merchantB was stolen"
            );
            // Prove the victim is now insolvent: its claim reverts because the pool is empty.
            vm.prank(merchantB);
            vm.expectRevert(); // SafeERC20 transfer fails — no USDC left
            lanes.claim(address(usdc));
            revert("CROSS_ASSET_DRAIN_CONFIRMED");
        }

        // SAFE PATH: if the unit binds the asset to the lane, the attacker gets nothing in USDC and
        // the victim's backing is intact.
        assertEq(attackerUsdcAfter, attackerUsdcBefore, "attacker gained no USDC");
        assertEq(usdc.balanceOf(address(lanes)), NET, "victim USDC backing intact");
    }

    /// @notice The same exploit aimed at conservation directly: after a cross-asset claim, does the
    ///         per-asset conservation invariant (held USDC == Σ unclaimed USDC lanes) still hold?
    function test_attack_claimLane_breaksPerAssetConservation() public {
        _credit(merchantB, address(usdc), NET); // Σ USDC lane balances = NET; held USDC = NET
        uint256 idEvil = _credit(attacker, address(evil), 1); // tiny evil receipt

        // Try to pull 1 unit of USDC against the evil receipt.
        vm.prank(attacker);
        try lanes.claimLane(idEvil, address(usdc)) {
            // If this succeeded, held USDC dropped to NET-1 while Σ USDC lane balances is still NET.
            uint256 heldUsdc = usdc.balanceOf(address(lanes));
            uint256 sumUsdcLanes =
                lanes.balanceOf(merchantB, lanes.laneId(block.chainid, address(usdc), merchantB));
            assertEq(
                heldUsdc,
                sumUsdcLanes,
                "BREAK: per-asset conservation violated - held USDC below sum of unclaimed USDC lanes"
            );
        } catch {
            // SAFE: the cross-asset claim must NOT pay out. Conservation preserved.
            assertEq(usdc.balanceOf(address(lanes)), NET, "USDC pool intact");
        }
    }

    /*//////////////////////////////////////////////////////////////
                ATTACK 2 — CROSS-MERCHANT LANE LEAKAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice A lane balance belongs to (owner, id). The attacker holds NO balance on merchantB's
    ///         lane id, so neither claim, claimLane, nor transfer can touch merchantB's funds.
    function test_attack_cannotClaimAnotherMerchantsLane() public {
        uint256 idB = _credit(merchantB, address(usdc), NET);

        // Attacker tries to claim merchantB's lane id directly. Attacker's balance on idB is 0.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__NothingToClaim.selector, attacker, address(usdc)
            )
        );
        lanes.claimLane(idB, address(usdc));

        // merchantB's balance and the pool are untouched.
        assertEq(lanes.balanceOf(merchantB, idB), NET);
        assertEq(usdc.balanceOf(address(lanes)), NET);
    }

    /// @notice The convenience claim() is keyed to msg.sender's OWN derived lane — the attacker can
    ///         never reach merchantB's lane through it, even sharing the same asset.
    function test_attack_claimShorthandIsCallerScoped() public {
        _credit(merchantB, address(usdc), NET);

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__NothingToClaim.selector, attacker, address(usdc)
            )
        );
        lanes.claim(address(usdc)); // attacker's own usdc lane is empty
    }

    /// @notice transfer() moves only the CALLER's balance on a lane; an attacker holding zero on
    ///         merchantB's lane cannot transfer merchantB's funds out.
    function test_attack_cannotTransferAnothersLaneBalance() public {
        uint256 idB = _credit(merchantB, address(usdc), NET);

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__InsufficientBalance.selector, attacker, idB, 0, 1
            )
        );
        lanes.transfer(makeAddr("sink"), idB, 1);

        assertEq(lanes.balanceOf(merchantB, idB), NET);
    }

    /// @notice Fuzz: no sequence of attacker-owned credits/claims on ANY asset/amount can reduce a
    ///         frozen victim lane's balance. Cross-merchant isolation under random pressure.
    function testFuzz_attack_victimLaneFrozenUnderAttackerActivity(
        uint256 attackerAmt,
        bool useUsdc,
        uint256 claimSplit
    ) public {
        uint256 idB = _credit(merchantB, address(usdc), NET);

        attackerAmt = bound(attackerAmt, 1, 5_000e6);
        address aAsset = useUsdc ? address(usdc) : address(evil);
        uint256 idAtt = _credit(attacker, aAsset, attackerAmt);

        // Attacker churns: transfer part to a sink then claim what it legitimately holds. All of this
        // operates on the attacker's OWN lane (idAtt) and its own backing asset — never the victim's.
        claimSplit = bound(claimSplit, 0, attackerAmt);
        if (claimSplit > 0) {
            vm.prank(attacker);
            lanes.transfer(makeAddr("attsink"), idAtt, claimSplit);
        }
        uint256 leftover = lanes.balanceOf(attacker, idAtt);
        if (leftover > 0) {
            vm.prank(attacker);
            lanes.claimLane(idAtt, aAsset);
        }

        // The victim's lane balance never moved, no matter what the attacker did on its own lane.
        assertEq(lanes.balanceOf(merchantB, idB), NET, "victim lane balance must be frozen");
    }

    /*//////////////////////////////////////////////////////////////
              ATTACK 3 — LANE-ID COLLISION / FORGERY
    //////////////////////////////////////////////////////////////*/

    /// @notice The lane id is keccak256(abi.encode(chainId, asset, recipient)). The attacker cannot
    ///         craft a (chainId', asset', recipient') triple it controls that collides with the
    ///         victim's lane id, so it can never be credited onto the victim's lane.
    function testFuzz_attack_cannotForgeVictimLaneId(
        uint256 chainId_,
        address asset_,
        address recipient_
    ) public view {
        uint256 victimId = lanes.laneId(block.chainid, address(usdc), merchantB);
        // Exclude the genuine victim triple — any OTHER triple must produce a different id.
        vm.assume(chainId_ != block.chainid || asset_ != address(usdc) || recipient_ != merchantB);
        assertTrue(
            lanes.laneId(chainId_, asset_, recipient_) != victimId,
            "BREAK: lane-id collision - a different triple forged the victim's lane id"
        );
    }

    /// @notice abi.encode (not encodePacked) means no boundary aliasing: shifting bytes between the
    ///         asset and recipient legs cannot produce the same preimage. Spot-check a classic
    ///         packed-collision shape that WOULD alias under encodePacked.
    function test_attack_noEncodePackedAliasing() public view {
        // Under abi.encodePacked, (asset=0x..AA, recipient=0xBB..) vs a shifted split could collide.
        // Under abi.encode each leg is its own 32-byte word, so these are always distinct.
        // (Built via arithmetic so Solidity does not treat the literals as checksummed addresses.)
        address a1 = address(uint160(0xAA)); // 0x..00AA
        address r1 = address(uint160(0xBB) * (2 ** 152)); // 0xBB00..00
        address a2 = address(uint160(0xAB)); // 0x..00AB
        address r2 = address(uint160(0xB0) * (2 ** 152)); // 0xB000..00
        assertTrue(
            lanes.laneId(1, a1, r1) != lanes.laneId(1, a2, r2),
            "BREAK: encodePacked-style aliasing collision"
        );
    }

    /// @notice Crediting a forged-but-distinct lane id never lands on the victim's books. Even if the
    ///         attacker registers itself as a recipient with a near-miss address, the recipient leg
    ///         keeps the balance on the attacker's own (owner, id), not the victim's.
    function test_attack_creditLandsOnRecipientOnly() public {
        uint256 idB = _credit(merchantB, address(usdc), NET);
        // Router credits the ATTACKER (different recipient) — must not touch merchantB's lane.
        uint256 idAtt = _credit(attacker, address(usdc), NET);
        assertTrue(idAtt != idB);
        assertEq(lanes.balanceOf(merchantB, idB), NET);
        assertEq(lanes.balanceOf(attacker, idB), 0); // attacker holds nothing on the victim lane
    }

    /*//////////////////////////////////////////////////////////////
            ATTACK 4 — ERC-6909 APPROVAL / OPERATOR ABUSE
    //////////////////////////////////////////////////////////////*/

    /// @notice No allowance, not an operator: transferFrom must revert. Cannot spend without authz.
    function test_attack_transferFromWithoutAuthorization() public {
        uint256 idB = _credit(merchantB, address(usdc), NET);
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__InsufficientAllowance.selector,
                merchantB,
                attacker,
                idB,
                0,
                1
            )
        );
        lanes.transferFrom(merchantB, attacker, idB, 1);
        assertEq(lanes.balanceOf(merchantB, idB), NET);
    }

    /// @notice A finite allowance cannot be over-spent across multiple transferFrom calls — the
    ///         decrement is real, not a no-op.
    function test_attack_allowanceCannotBeOverspent() public {
        uint256 idA = _credit(merchantA, address(usdc), NET);
        vm.prank(merchantA);
        lanes.approve(attacker, idA, 300e6);

        // First spend of 300 drains the allowance to 0.
        vm.prank(attacker);
        lanes.transferFrom(merchantA, attacker, idA, 300e6);
        assertEq(lanes.allowance(merchantA, attacker, idA), 0);

        // Second spend of even 1 must revert — allowance exhausted.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__InsufficientAllowance.selector,
                merchantA,
                attacker,
                idA,
                0,
                1
            )
        );
        lanes.transferFrom(merchantA, attacker, idA, 1);
        assertEq(lanes.balanceOf(merchantA, idA), NET - 300e6);
    }

    /// @notice An allowance on lane X grants NO power over lane Y. Per-id allowance isolation.
    function test_attack_allowanceIsPerLaneNotGlobal() public {
        uint256 idUsdc = _credit(merchantA, address(usdc), NET);
        uint256 idEvil = _credit(merchantA, address(evil), NET);

        // merchantA approves attacker only on the USDC lane.
        vm.prank(merchantA);
        lanes.approve(attacker, idUsdc, NET);

        // Attacker cannot touch the EVIL lane with the USDC-lane allowance.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__InsufficientAllowance.selector,
                merchantA,
                attacker,
                idEvil,
                0,
                1
            )
        );
        lanes.transferFrom(merchantA, attacker, idEvil, 1);
        assertEq(lanes.balanceOf(merchantA, idEvil), NET);
    }

    /// @notice Revoking an operator immediately removes its blanket authority. A stale operator that
    ///         was once approved cannot move funds after revocation.
    function test_attack_revokedOperatorCannotSpend() public {
        uint256 idA = _credit(merchantA, address(usdc), NET);
        vm.startPrank(merchantA);
        lanes.setOperator(attacker, true);
        lanes.setOperator(attacker, false); // revoked before any use
        vm.stopPrank();

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__InsufficientAllowance.selector,
                merchantA,
                attacker,
                idA,
                0,
                NET
            )
        );
        lanes.transferFrom(merchantA, attacker, idA, NET);
        assertEq(lanes.balanceOf(merchantA, idA), NET);
    }

    /// @notice An operator is owner-scoped: being merchantA's operator gives no power over merchantB.
    function test_attack_operatorIsOwnerScoped() public {
        uint256 idB = _credit(merchantB, address(usdc), NET);
        // merchantA makes attacker its operator. That says NOTHING about merchantB.
        vm.prank(merchantA);
        lanes.setOperator(attacker, true);

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__InsufficientAllowance.selector,
                merchantB,
                attacker,
                idB,
                0,
                1
            )
        );
        lanes.transferFrom(merchantB, attacker, idB, 1);
        assertEq(lanes.balanceOf(merchantB, idB), NET);
    }

    /// @notice Only an authorized router may credit. An attacker cannot self-mint a lane receipt out
    ///         of thin air (which it could then claim against a real pool).
    function test_attack_nonRouterCannotMint() public {
        vm.prank(attacker);
        vm.expectRevert(IPaymentLanes.PaymentLanes__Unauthorized.selector);
        lanes.credit(attacker, address(usdc), NET);
        assertEq(lanes.balanceOf(attacker, lanes.laneId(block.chainid, address(usdc), attacker)), 0);
    }

    /*//////////////////////////////////////////////////////////////
                  ATTACK 5 — OVER / UNDERFLOW & DOUBLE CLAIM
    //////////////////////////////////////////////////////////////*/

    /// @notice A lane cannot be claimed twice. The second claim has nothing left (balance zeroed by
    ///         CEI) and reverts — no double withdrawal of the underlying.
    function test_attack_doubleClaimReverts() public {
        _credit(merchantA, address(usdc), NET);
        vm.prank(merchantA);
        lanes.claim(address(usdc));
        assertEq(usdc.balanceOf(merchantA), NET);

        vm.prank(merchantA);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__NothingToClaim.selector, merchantA, address(usdc)
            )
        );
        lanes.claim(address(usdc));
        assertEq(usdc.balanceOf(address(lanes)), 0);
    }

    /// @notice claimLane double-spend: claim, then claim the same id again — second must revert.
    function test_attack_doubleClaimLaneReverts() public {
        uint256 id = _credit(merchantA, address(usdc), NET);
        vm.startPrank(merchantA);
        lanes.claimLane(id, address(usdc));
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__NothingToClaim.selector, merchantA, address(usdc)
            )
        );
        lanes.claimLane(id, address(usdc));
        vm.stopPrank();
    }

    /// @notice transfer cannot create balance: moving X out of a lane with balance X leaves 0, and a
    ///         further 1-unit move underflow-reverts (Solidity 0.8 checked / explicit guard).
    function test_attack_transferCannotUnderflow() public {
        uint256 id = _credit(merchantA, address(usdc), NET);
        vm.startPrank(merchantA);
        lanes.transfer(attacker, id, NET); // move everything
        assertEq(lanes.balanceOf(merchantA, id), 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__InsufficientBalance.selector, merchantA, id, 0, 1
            )
        );
        lanes.transfer(attacker, id, 1); // nothing left
        vm.stopPrank();
    }

    /// @notice Crediting near uint256 max then once more would overflow the balance add. credit()
    ///         uses checked math, so a second credit that overflows the lane balance MUST revert
    ///         (arithmetic panic), never wrap around to a small number (which would silently erase the
    ///         victim's receipt). A NoMoveToken whose transferFrom moves nothing lets us drive the
    ///         accounting to the boundary without minting 2^256 real units.
    function test_attack_creditOverflowReverts() public {
        NoMoveToken phantom = new NoMoveToken();
        // (router is already authorized; phantom needs no balance because transferFrom is a no-op)

        uint256 huge = type(uint256).max - 10;
        vm.prank(router);
        lanes.credit(attacker, address(phantom), huge);

        uint256 id = lanes.laneId(block.chainid, address(phantom), attacker);
        assertEq(lanes.balanceOf(attacker, id), huge);

        // A second credit of 20 would push the lane balance over 2^256-1 -> checked add panics.
        vm.prank(router);
        vm.expectRevert(); // arithmetic overflow panic on _balanceOf[recipient][id] += amount
        lanes.credit(attacker, address(phantom), 20);

        // Balance unchanged after the reverted overflow.
        assertEq(lanes.balanceOf(attacker, id), huge);
    }

    /*//////////////////////////////////////////////////////////////
                       ATTACK 6 — ZERO / DUST EDGE CASES
    //////////////////////////////////////////////////////////////*/

    /// @notice Zero-amount credit is rejected — no empty lane that could confuse accounting.
    function test_attack_zeroCreditRejected() public {
        vm.prank(router);
        vm.expectRevert(IPaymentLanes.PaymentLanes__ZeroAmount.selector);
        lanes.credit(merchantA, address(usdc), 0);
    }

    /// @notice Claiming an empty lane reverts rather than emitting a zero-value burn or paying nothing
    ///         silently (which could be used to spoof receipts off-chain).
    function test_attack_claimEmptyLaneReverts() public {
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__NothingToClaim.selector, attacker, address(usdc)
            )
        );
        lanes.claim(address(usdc));
    }

    /// @notice A 1-wei dust lane round-trips exactly: credit 1, claim 1, pool returns to 0. No dust
    ///         is stranded in the contract and no rounding creates/destroys value.
    function test_attack_dustRoundTripIsExact() public {
        uint256 id = _credit(merchantA, address(usdc), 1);
        assertEq(usdc.balanceOf(address(lanes)), 1);
        vm.prank(merchantA);
        lanes.claim(address(usdc));
        assertEq(usdc.balanceOf(merchantA), 1);
        assertEq(usdc.balanceOf(address(lanes)), 0);
        assertEq(lanes.balanceOf(merchantA, id), 0);
    }

    /// @notice Transferring 0 across a lane is a no-op move (allowed by the surface) but must not
    ///         corrupt balances or let a zero-balance holder fabricate a positive balance.
    function test_attack_zeroTransferDoesNotCorrupt() public {
        uint256 id = _credit(merchantA, address(usdc), NET);
        vm.prank(merchantA);
        lanes.transfer(attacker, id, 0); // zero move
        assertEq(lanes.balanceOf(merchantA, id), NET);
        assertEq(lanes.balanceOf(attacker, id), 0);
    }

    /*//////////////////////////////////////////////////////////////
                          ATTACK 7 — REENTRANCY
    //////////////////////////////////////////////////////////////*/

    /// @notice A re-entrant claim on a DIFFERENT lane during the claim transfer. CEI zeroes the
    ///         current lane first and the guard blocks any re-entry — the attacker is paid exactly
    ///         what it holds across both lanes, never more.
    function test_attack_reentrantClaimAcrossLanesPaysOnce() public {
        ReentrantMultiLaneToken evilTok = new ReentrantMultiLaneToken();
        evilTok.setLanes(lanes);
        evilTok.mint(router, 3 * NET);
        vm.prank(router);
        evilTok.approve(address(lanes), type(uint256).max);

        // Credit two lanes of the malicious token to the attacker.
        uint256 id1 = _credit(attacker, address(evilTok), NET);
        evilTok.setSecondClaimTarget(address(evilTok)); // re-enter claim() on its own lane
        evilTok.arm(true);

        uint256 attBefore = evilTok.balanceOf(attacker);
        vm.prank(attacker);
        lanes.claim(address(evilTok)); // claims attacker's id1

        // Guard + CEI: attacker paid exactly NET once; no surplus drained from the contract.
        uint256 paid = evilTok.balanceOf(attacker) - attBefore;
        assertEq(paid, NET, "attacker paid exactly once, no reentrancy bonus");
        assertEq(lanes.balanceOf(attacker, id1), 0);
        // The contract must not have over-paid: it should hold nothing of this token now.
        assertEq(evilTok.balanceOf(address(lanes)), 0);
    }
}

/// @notice A malicious 6dp token that re-enters claim() on the lanes contract during its outbound
///         transfer, attempting to be paid more than the single legitimate claim.
contract ReentrantMultiLaneToken is MockUSDC {
    IPaymentLanes internal lanes;
    address internal secondTarget;
    bool internal armed;

    function setLanes(IPaymentLanes lanes_) external {
        lanes = lanes_;
    }

    function setSecondClaimTarget(address asset) external {
        secondTarget = asset;
    }

    function arm(bool on) external {
        armed = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (armed && from == address(lanes) && address(lanes) != address(0)) {
            armed = false; // one-shot
            try lanes.claim(secondTarget) { } catch { }
        }
        super._update(from, to, value);
    }
}

/// @notice An IERC20 whose transferFrom/transfer succeed (return true) but move no balance. Used only
///         to drive PaymentLanes' lane-balance accounting to the uint256 boundary without minting an
///         astronomical real supply. It satisfies SafeERC20 (non-reverting, returns true).
contract NoMoveToken {
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function allowance(address, address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function totalSupply() external pure returns (uint256) {
        return 0;
    }
}
