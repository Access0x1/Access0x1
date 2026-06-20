// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";
import { IPaymentLanes } from "../../src/interfaces/IPaymentLanes.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { ReentrantClaimToken } from "../mocks/ReentrantClaimToken.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @notice FABLE RED-TEAM — SECOND PASS on the cross-asset firewall fix.
///
///         The fix bound every lane to the asset that funded it (`_laneAsset[id]`) and turned a
///         mismatched-asset claim into a SILENT NO-OP RETURN (not a revert): `if (backing != 0 &&
///         asset != backing) return;`. That behavioral change is itself a new attack surface. This
///         suite re-attacks specifically the seams the firewall opened:
///
///           A. Per-asset conservation under MIXED-asset stateful fuzzing (the existing invariant
///              handler never fires claimLane with a mismatched asset; this one does, every step).
///           B. Cross-merchant isolation when the attacker holds a SAME-ASSET lane (not just a
///              worthless coin) — the real lane is keyed to a different recipient.
///           C. Claim-after-transfer: a transferee can only ever pull the lane's BOUND asset, and a
///              mismatched-asset claim on a received lane must not burn the receipt.
///           D. The no-op return must NOT consume the receipt — after a mismatched call the holder can
///              still claim the correct asset for full value (no silent fund-trap / griefing burn).
///           E. Operator/approval can move a RECEIPT but confers NO claim power over another's lane
///              (claim is strictly msg.sender-scoped; there is no claimFrom).
///           F. Reentrancy on claim that re-enters via the MISMATCHED no-op path (ReentrantClaimToken),
///              and a cross-asset re-entry attempt during a legitimate claim.
///           G. The full pool-drain headline, re-run with THREE assets and three merchants so a
///              mismatched claim has multiple foreign pools to (fail to) reach.
///
/// @dev    Red-team NEVER edits src/. A failing assertion here that documents real loss is a BREAK.
contract PaymentLanesFirewallAttackTest is Test, ProxyDeployer {
    PaymentLanes internal lanes;
    MockUSDC internal usdc; // valuable asset (6dp)
    MockUSDC internal eurc; // second real asset (6dp)
    MockUSDC internal evil; // worthless coin the attacker mints freely (6dp)

    address internal admin = makeAddr("fw_admin");
    address internal router = makeAddr("fw_router");
    address internal merchantA = makeAddr("fw_merchantA");
    address internal merchantB = makeAddr("fw_merchantB");
    address internal merchantC = makeAddr("fw_merchantC");
    address internal attacker = makeAddr("fw_attacker");
    address internal sink = makeAddr("fw_sink");

    uint256 internal constant NET = 1_000e6;

    function setUp() public {
        lanes = PaymentLanes(
            deployProxy(
                address(new PaymentLanes()), abi.encodeCall(PaymentLanes.initialize, (admin))
            )
        );
        usdc = new MockUSDC();
        eurc = new MockUSDC();
        evil = new MockUSDC();

        vm.prank(admin);
        lanes.setRouter(router, true);

        usdc.mint(router, 100_000_000e6);
        eurc.mint(router, 100_000_000e6);
        evil.mint(router, 100_000_000e6);
        vm.startPrank(router);
        usdc.approve(address(lanes), type(uint256).max);
        eurc.approve(address(lanes), type(uint256).max);
        evil.approve(address(lanes), type(uint256).max);
        vm.stopPrank();
    }

    function _credit(address recipient, address asset, uint256 amount) internal returns (uint256) {
        vm.prank(router);
        return lanes.credit(recipient, asset, amount);
    }

    function _lid(address asset, address who) internal view returns (uint256) {
        return lanes.laneId(block.chainid, asset, who);
    }

    /*//////////////////////////////////////////////////////////////
        D — THE NO-OP RETURN MUST NOT CONSUME THE RECEIPT (anti-grief)
    //////////////////////////////////////////////////////////////*/

    /// @notice The fix swaps a revert for a silent no-op on a mismatched-asset claim. A subtle break
    ///         would be if that no-op BURNED the receipt (it returns before the zero-balance check, so
    ///         it must not): the holder would lose the receipt while getting nothing — a griefing burn
    ///         that destroys real backing without paying anyone. Assert the receipt survives a
    ///         mismatched call and the holder can STILL claim the correct asset for full value.
    function test_attack_mismatchedClaimDoesNotBurnReceipt() public {
        uint256 idEvil = _credit(attacker, address(evil), NET);
        assertEq(lanes.balanceOf(attacker, idEvil), NET, "receipt minted");

        // Mismatched claim: point the evil-backed lane at USDC. Must be a no-op (no burn, no pay).
        uint256 evilHeldBefore = evil.balanceOf(address(lanes));
        uint256 usdcHeldBefore = usdc.balanceOf(address(lanes));
        vm.prank(attacker);
        lanes.claimLane(idEvil, address(usdc));

        // Receipt intact; no asset moved at all.
        assertEq(lanes.balanceOf(attacker, idEvil), NET, "receipt NOT burned by the no-op");
        assertEq(evil.balanceOf(address(lanes)), evilHeldBefore, "no evil moved");
        assertEq(usdc.balanceOf(address(lanes)), usdcHeldBefore, "no usdc moved");

        // The holder can still redeem the correct asset for the full amount.
        vm.prank(attacker);
        lanes.claimLane(idEvil, address(evil));
        assertEq(evil.balanceOf(attacker), NET, "full value still claimable on the bound asset");
        assertEq(lanes.balanceOf(attacker, idEvil), 0, "now burned");
    }

    /// @notice An attacker cannot REPEAT mismatched no-op calls to drip value out: each call moves zero
    ///         and conservation is untouched no matter how many times it fires.
    function test_attack_repeatedMismatchedCallsDripNothing() public {
        _credit(merchantB, address(usdc), NET); // victim pool
        uint256 idEvil = _credit(attacker, address(evil), NET);

        uint256 usdcHeld = usdc.balanceOf(address(lanes));
        for (uint256 i = 0; i < 25; i++) {
            vm.prank(attacker);
            lanes.claimLane(idEvil, address(usdc)); // always a no-op
        }
        assertEq(usdc.balanceOf(address(lanes)), usdcHeld, "no USDC drained over many no-ops");
        assertEq(usdc.balanceOf(attacker), 0, "attacker gained no USDC");
        // Evil receipt still fully redeemable.
        assertEq(lanes.balanceOf(attacker, idEvil), NET);
    }

    /// @notice convenience claim(asset) derives the caller's OWN lane for `asset`. If the attacker holds
    ///         an evil lane but calls claim(usdc), it derives the attacker's USDC lane (empty) — must
    ///         revert NothingToClaim, never touch the evil lane or any pool.
    function test_attack_convenienceClaimWrongAssetRevertsEmpty() public {
        _credit(merchantB, address(usdc), NET);
        _credit(attacker, address(evil), NET);

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__NothingToClaim.selector, attacker, address(usdc)
            )
        );
        lanes.claim(address(usdc)); // attacker's USDC lane is empty
        assertEq(usdc.balanceOf(address(lanes)), NET, "victim pool intact");
        assertEq(lanes.balanceOf(attacker, _lid(address(evil), attacker)), NET, "evil lane intact");
    }

    /*//////////////////////////////////////////////////////////////
        C — CLAIM-AFTER-TRANSFER: transferee bound to the lane's asset
    //////////////////////////////////////////////////////////////*/

    /// @notice merchantB transfers its USDC-lane receipt to the attacker. The attacker now HOLDS balance
    ///         on a USDC-backed lane id. It can claim USDC (legit, that's the value it received) but
    ///         pointing that lane at EURC/evil must pay nothing and must not burn the receipt.
    function test_attack_transfereeBoundToLaneAsset() public {
        uint256 idB = _credit(merchantB, address(usdc), NET);
        // Also stand up a foreign EURC pool the attacker would love to reach.
        _credit(merchantC, address(eurc), NET);

        vm.prank(merchantB);
        lanes.transfer(attacker, idB, NET); // attacker now holds the USDC receipt
        assertEq(lanes.balanceOf(attacker, idB), NET);

        // Mismatched claims on the received lane: no pay, no burn.
        vm.prank(attacker);
        lanes.claimLane(idB, address(eurc));
        vm.prank(attacker);
        lanes.claimLane(idB, address(evil));
        assertEq(lanes.balanceOf(attacker, idB), NET, "receipt survives mismatched claims");
        assertEq(eurc.balanceOf(address(lanes)), NET, "foreign EURC pool intact");
        assertEq(eurc.balanceOf(attacker), 0);

        // The legit claim on the bound asset pays exactly the transferred value.
        vm.prank(attacker);
        lanes.claimLane(idB, address(usdc));
        assertEq(usdc.balanceOf(attacker), NET, "transferee pulls only the bound asset's value");
        assertEq(lanes.balanceOf(attacker, idB), 0);
        // Victim merchantB legitimately divested; the EURC pool was never touched.
        assertEq(eurc.balanceOf(address(lanes)), NET);
    }

    /// @notice A partial transfer splits the receipt; neither holder can pull more than their share, and
    ///         neither can pull a foreign asset against the shared lane id.
    function test_attack_partialTransferShareIsExactAndAssetBound() public {
        uint256 idB = _credit(merchantB, address(usdc), NET);
        _credit(merchantA, address(eurc), NET); // foreign pool

        vm.prank(merchantB);
        lanes.transfer(attacker, idB, 400e6);

        // attacker tries to pull EURC against the USDC lane id -> no-op, receipt intact.
        vm.prank(attacker);
        lanes.claimLane(idB, address(eurc));
        assertEq(lanes.balanceOf(attacker, idB), 400e6, "share intact after mismatched claim");

        // Each holder pulls exactly its USDC share; total out == NET, nothing extra.
        vm.prank(attacker);
        lanes.claimLane(idB, address(usdc));
        vm.prank(merchantB);
        lanes.claimLane(idB, address(usdc));
        assertEq(usdc.balanceOf(attacker), 400e6);
        assertEq(usdc.balanceOf(merchantB), 600e6);
        assertEq(usdc.balanceOf(address(lanes)), 0, "USDC pool exactly emptied, no overdraw");
        assertEq(eurc.balanceOf(address(lanes)), NET, "EURC pool never touched");
    }

    /*//////////////////////////////////////////////////////////////
        E — OPERATOR / APPROVAL CONFER NO CLAIM POWER
    //////////////////////////////////////////////////////////////*/

    /// @notice There is no claimFrom: claim/claimLane burn `_balanceOf[msg.sender][id]` ONLY. An
    ///         operator (blanket transfer authority) for merchantB cannot claim merchantB's lane — the
    ///         operator's own balance on that id is zero, so claimLane reverts NothingToClaim. The
    ///         operator's only path is transferFrom into itself THEN claim, which is just a transfer —
    ///         it cannot conjure value. Confirm the direct claim attempt yields nothing.
    function test_attack_operatorCannotClaimOwnersLane() public {
        uint256 idB = _credit(merchantB, address(usdc), NET);
        vm.prank(merchantB);
        lanes.setOperator(attacker, true); // attacker is merchantB's operator

        // Operator tries to claim merchantB's lane directly — its OWN balance on idB is 0.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__NothingToClaim.selector, attacker, address(usdc)
            )
        );
        lanes.claimLane(idB, address(usdc));
        assertEq(lanes.balanceOf(merchantB, idB), NET, "owner balance untouched by operator claim");
        assertEq(usdc.balanceOf(address(lanes)), NET);
    }

    /// @notice Operator path that DOES work (transferFrom then claim) still cannot create value: the
    ///         operator moves the receipt to itself and claims exactly NET — no more — and only the
    ///         bound asset. This bounds the operator's power to "move what's there", not "mint".
    function test_attack_operatorTransferThenClaimNoInflation() public {
        uint256 idB = _credit(merchantB, address(usdc), NET);
        _credit(merchantC, address(eurc), NET); // foreign pool
        vm.prank(merchantB);
        lanes.setOperator(attacker, true);

        // Operator pulls the receipt to itself (legit ERC-6909 operator power) ...
        vm.prank(attacker);
        lanes.transferFrom(merchantB, attacker, idB, NET);

        // ... then a mismatched claim still pays nothing (asset firewall holds for operators too) ...
        vm.prank(attacker);
        lanes.claimLane(idB, address(eurc));
        assertEq(eurc.balanceOf(address(lanes)), NET, "foreign EURC pool intact");

        // ... and the legit claim pays exactly NET of the bound asset, never more.
        vm.prank(attacker);
        lanes.claimLane(idB, address(usdc));
        assertEq(usdc.balanceOf(attacker), NET, "exactly NET, no inflation");
        assertEq(usdc.balanceOf(address(lanes)), 0);
    }

    /// @notice A per-id allowance lets a spender move the receipt but, identically, confers no claim
    ///         power: the spender claiming the OWNER's id directly has zero of its own balance there.
    function test_attack_approvedSpenderCannotClaimOwnersLane() public {
        uint256 idB = _credit(merchantB, address(usdc), NET);
        vm.prank(merchantB);
        lanes.approve(attacker, idB, type(uint256).max);

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__NothingToClaim.selector, attacker, address(usdc)
            )
        );
        lanes.claimLane(idB, address(usdc));
        assertEq(lanes.balanceOf(merchantB, idB), NET);
    }

    /*//////////////////////////////////////////////////////////////
        B / G — CROSS-MERCHANT DRAIN with a SAME-ASSET attacker lane
    //////////////////////////////////////////////////////////////*/

    /// @notice Sharper than the worthless-coin headline: the attacker holds a lane of the SAME asset
    ///         (USDC) as the victim, just keyed to a different recipient. It must still be unable to
    ///         pull the victim's USDC by passing the victim's id, because its balance on the victim id
    ///         is zero (claim is owner+id scoped, asset match is necessary but NOT sufficient).
    function test_attack_sameAssetDifferentMerchantCannotDrain() public {
        uint256 idVictim = _credit(merchantB, address(usdc), 5 * NET);
        _credit(attacker, address(usdc), NET); // attacker's own (smaller) USDC lane

        uint256 poolBefore = usdc.balanceOf(address(lanes));
        // Attacker passes the VICTIM's id with the correct (USDC) asset — asset matches, but the
        // attacker holds zero on idVictim, so it must revert and drain nothing.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__NothingToClaim.selector, attacker, address(usdc)
            )
        );
        lanes.claimLane(idVictim, address(usdc));
        assertEq(usdc.balanceOf(address(lanes)), poolBefore, "pool intact");
        assertEq(lanes.balanceOf(merchantB, idVictim), 5 * NET, "victim balance intact");
    }

    /// @notice The full headline drain, three-asset / three-merchant edition: attacker holds only an
    ///         evil lane; usdc, eurc pools back real merchants. NO combination of (foreign id, foreign
    ///         asset) the attacker can pass pulls a single unit out of usdc or eurc.
    function test_attack_multiAssetMultiMerchantNoDrain() public {
        uint256 idUsdcB = _credit(merchantB, address(usdc), 3 * NET);
        uint256 idEurcC = _credit(merchantC, address(eurc), 2 * NET);
        uint256 idEvil = _credit(attacker, address(evil), NET);

        uint256 usdcPool = usdc.balanceOf(address(lanes));
        uint256 eurcPool = eurc.balanceOf(address(lanes));

        // Every cross attempt the attacker can make on its OWN evil lane against a foreign asset:
        vm.startPrank(attacker);
        lanes.claimLane(idEvil, address(usdc)); // mismatch no-op
        lanes.claimLane(idEvil, address(eurc)); // mismatch no-op
        vm.stopPrank();

        // Attempts on foreign ids (attacker holds zero there) revert; wrap each in expectRevert.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__NothingToClaim.selector, attacker, address(usdc)
            )
        );
        lanes.claimLane(idUsdcB, address(usdc));

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPaymentLanes.PaymentLanes__NothingToClaim.selector, attacker, address(eurc)
            )
        );
        lanes.claimLane(idEurcC, address(eurc));

        assertEq(usdc.balanceOf(address(lanes)), usdcPool, "USDC pool intact across all attempts");
        assertEq(eurc.balanceOf(address(lanes)), eurcPool, "EURC pool intact across all attempts");
        assertEq(usdc.balanceOf(attacker), 0);
        assertEq(eurc.balanceOf(attacker), 0);
        // Real merchants can still claim their full backing (solvency preserved).
        vm.prank(merchantB);
        lanes.claimLane(idUsdcB, address(usdc));
        vm.prank(merchantC);
        lanes.claimLane(idEurcC, address(eurc));
        assertEq(usdc.balanceOf(merchantB), 3 * NET);
        assertEq(eurc.balanceOf(merchantC), 2 * NET);
    }

    /*//////////////////////////////////////////////////////////////
        F — REENTRANCY THROUGH THE FIREWALL SEAMS
    //////////////////////////////////////////////////////////////*/

    /// @notice ReentrantClaimToken re-enters claim(itself) on the legit outbound transfer. The
    ///         nonReentrant guard + CEI must keep total paid == the single lane balance. Here the
    ///         re-entry asset MATCHES (same token) — the guard is what must hold.
    function test_attack_reentrantSameAssetClaimPaysOnce() public {
        ReentrantClaimToken rc = new ReentrantClaimToken();
        rc.setLanes(lanes);
        rc.mint(router, 10 * NET);
        vm.prank(router);
        rc.approve(address(lanes), type(uint256).max);

        // Fund a foreign USDC pool the reentrancy would love to skim if the guard failed.
        _credit(merchantB, address(usdc), 5 * NET);

        uint256 id = _credit(attacker, address(rc), NET);
        rc.arm(true);

        vm.prank(attacker);
        lanes.claim(address(rc)); // re-enters claim(rc) on the outbound transfer

        assertEq(rc.balanceOf(attacker), NET, "paid exactly once, no reentrancy bonus");
        assertEq(lanes.balanceOf(attacker, id), 0);
        assertEq(rc.balanceOf(address(lanes)), 0, "no over-pay of the malicious token");
        assertEq(usdc.balanceOf(address(lanes)), 5 * NET, "foreign USDC pool never touched");
    }

    /// @notice A re-entrant attempt during claim that points at a DIFFERENT, mismatched lane/asset.
    ///         Even if the guard were somehow bypassed, the firewall no-op would pay nothing; with the
    ///         guard, the re-entry reverts and is swallowed. Either way: paid once, no foreign drain.
    function test_attack_reentrantCrossAssetAttemptDuringClaim() public {
        ReentrantCrossClaimToken rc = new ReentrantCrossClaimToken();
        rc.setLanes(lanes);
        rc.mint(router, 10 * NET);
        vm.prank(router);
        rc.approve(address(lanes), type(uint256).max);

        // The foreign pool the re-entry will try to reach via a mismatched claimLane.
        uint256 idUsdcB = _credit(merchantB, address(usdc), 5 * NET);
        rc.setCrossTarget(idUsdcB, address(usdc)); // re-entry will try claimLane(idUsdcB, usdc)

        uint256 id = _credit(attacker, address(rc), NET);
        rc.arm(true);

        uint256 usdcPool = usdc.balanceOf(address(lanes));
        vm.prank(attacker);
        lanes.claim(address(rc));

        assertEq(rc.balanceOf(attacker), NET, "attacker paid its rc lane exactly once");
        assertEq(lanes.balanceOf(attacker, id), 0);
        assertEq(
            usdc.balanceOf(address(lanes)), usdcPool, "foreign USDC pool untouched by re-entry"
        );
        assertEq(usdc.balanceOf(address(rc)), 0, "re-entry pulled no USDC to the token");
    }

    /*//////////////////////////////////////////////////////////////
        A — PER-ASSET CONSERVATION under MIXED-asset stateful fuzzing
    //////////////////////////////////////////////////////////////*/

    /// @notice Stateless-fuzz a single sweep: credit two assets to two merchants, hand the attacker a
    ///         random evil lane, let it fire an arbitrary (id, asset) mismatched claim, then assert BOTH
    ///         real pools still equal the sum of their unclaimed lane balances. Per-asset conservation
    ///         must survive any single adversarial claimLane the attacker can name.
    function testFuzz_attack_perAssetConservationAfterArbitraryClaim(
        uint256 aAmt,
        uint256 bAmt,
        uint256 evilAmt,
        uint8 whichId,
        uint8 whichAsset
    ) public {
        aAmt = bound(aAmt, 1, 10_000_000e6);
        bAmt = bound(bAmt, 1, 10_000_000e6);
        evilAmt = bound(evilAmt, 1, 10_000_000e6);

        uint256 idUsdcA = _credit(merchantA, address(usdc), aAmt);
        uint256 idEurcB = _credit(merchantB, address(eurc), bAmt);
        uint256 idEvil = _credit(attacker, address(evil), evilAmt);

        // Attacker names ANY of the known ids and ANY of the three assets.
        uint256[3] memory ids = [idUsdcA, idEurcB, idEvil];
        address[3] memory assets = [address(usdc), address(eurc), address(evil)];
        uint256 id = ids[whichId % 3];
        address asset = assets[whichAsset % 3];

        vm.prank(attacker);
        try lanes.claimLane(id, asset) { } catch { }

        // Per-asset conservation: held == Σ unclaimed lanes of that asset, for EVERY asset.
        assertEq(
            usdc.balanceOf(address(lanes)), lanes.balanceOf(merchantA, idUsdcA), "USDC conservation"
        );
        assertEq(
            eurc.balanceOf(address(lanes)), lanes.balanceOf(merchantB, idEurcB), "EURC conservation"
        );
        assertEq(
            evil.balanceOf(address(lanes)), lanes.balanceOf(attacker, idEvil), "evil conservation"
        );
    }
}

/// @notice A malicious 6dp token that, on the outbound claim transfer, re-enters PaymentLanes with a
///         CROSS-ASSET claimLane against a FOREIGN lane id — testing both the guard and the firewall
///         no-op simultaneously. The re-entry is swallowed so the legit claim completes.
contract ReentrantCrossClaimToken is MockUSDC {
    IPaymentLanes internal lanes;
    uint256 internal crossId;
    address internal crossAsset;
    bool internal armed;

    function setLanes(IPaymentLanes lanes_) external {
        lanes = lanes_;
    }

    function setCrossTarget(uint256 id, address asset) external {
        crossId = id;
        crossAsset = asset;
    }

    function arm(bool on) external {
        armed = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (armed && from == address(lanes) && address(lanes) != address(0)) {
            armed = false; // one-shot
            try lanes.claimLane(crossId, crossAsset) { } catch { }
        }
        super._update(from, to, value);
    }
}
