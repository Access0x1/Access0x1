// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { DeployAll } from "../../script/DeployAll.s.sol";
import { CreateXEtch } from "../helpers/CreateXEtch.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";
import { SplitSettler } from "../../src/SplitSettler.sol";
import { ISplitSettler } from "../../src/interfaces/ISplitSettler.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title PaymentLanes commingled-lane over-claim — cross-merchant theft (red-team)
/// @notice The lane key `keccak256(abi.encode(chainId, asset, recipient))` omits
///         `merchantId`, so every merchant sharing a conduit `recipient` shares ONE
///         lane per asset, and `PaymentLanes.claim` drains the WHOLE lane. The router
///         credits that lane on EVERY `payToken` to a conduit-payout merchant —
///         including a DIRECT `/m/<id>` link payment that never runs the conduit's
///         own settle. That direct payment's net strands in the shared lane, and the
///         next `settleToken` on ANY merchant sharing the conduit claims the whole
///         lane and fans it to ITS payees — stealing the stranded net.
///         Invariant that MUST hold: a settle's fanout == that settle's own router net.
contract PaymentLanesComminglingAttackTest is Test, ProxyDeployer {
    uint256 internal constant LOCAL = 31_337;
    address internal constant BROADCASTER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    Access0x1Router internal router;
    PaymentLanes internal lanes;
    MockUSDC internal usdc;
    SplitSettler internal settler;

    address internal attackerOwner = makeAddr("attackerOwner");
    address internal victimOwner = makeAddr("victimOwner");
    address internal payeeA = makeAddr("attacker_payeeA");
    address internal payeeB = makeAddr("attacker_payeeB");
    address internal attackerBuyer = makeAddr("attackerBuyer");
    address internal directPayer = makeAddr("directPayer");

    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.50%
    bytes32 internal constant ATTACK_ORDER = keccak256("attack-order");
    bytes32 internal constant VICTIM_ORDER = keccak256("victim-order");

    uint256 internal attackerMerchantId;
    uint256 internal victimId;
    uint256 internal splitId;

    function setUp() public {
        CreateXEtch.enable(vm);
        vm.warp(1_700_000_000);
        vm.chainId(LOCAL);
        vm.setEnv("ROUTER_OWNER", vm.toString(BROADCASTER));
        vm.setEnv("DEPLOY_PAYMENT_LANES", "true");
        HelperConfig hc;
        (router, lanes, hc) = new DeployAll().run();
        usdc = MockUSDC(hc.getConfig().usdc);

        // The attacker's own conduit (SplitSettler), paying 60/40 to the attacker's payees.
        settler = SplitSettler(
            payable(deployProxy(
                    address(new SplitSettler()),
                    abi.encodeCall(SplitSettler.initialize, (attackerOwner, router))
                ))
        );

        // The attacker's merchant pays out to the conduit.
        vm.prank(attackerOwner);
        attackerMerchantId = router.registerMerchant(
            address(settler), address(0), MERCHANT_FEE_BPS, keccak256("attacker.eth")
        );

        ISplitSettler.Payee[] memory payees = new ISplitSettler.Payee[](2);
        payees[0] = ISplitSettler.Payee({ account: payeeA, shareBps: 6000 });
        payees[1] = ISplitSettler.Payee({ account: payeeB, shareBps: 4000 });
        vm.prank(attackerOwner);
        splitId = settler.createSplit(attackerMerchantId, payees, 0);

        // The VICTIM merchant ALSO pays out to the SAME conduit (permissionless
        // registration — nothing prevents a shared conduit address).
        vm.prank(victimOwner);
        victimId = router.registerMerchant(
            address(settler), address(0), MERCHANT_FEE_BPS, keccak256("victim.eth")
        );

        usdc.mint(attackerBuyer, 1_000_000e6);
        vm.prank(attackerBuyer);
        usdc.approve(address(settler), type(uint256).max);

        usdc.mint(directPayer, 1_000_000e6);
        vm.prank(directPayer);
        usdc.approve(address(router), type(uint256).max);
    }

    function test_attack_commingledLane_directPayStolenByNextSettle() public {
        // 1. The victim is paid via the PLAIN router link (direct payToken — the
        //    default product flow: "one link, no contract code"), NOT the conduit's
        //    settleToken. Its net strands in lane(chain, usdc, settler).
        vm.prank(directPayer);
        router.payToken(victimId, address(usdc), 100e8, VICTIM_ORDER);

        // The victim's net is whatever the router credited to the shared lane —
        // read it directly (no fee-math needed) as the stranded amount.
        uint256 lid = lanes.laneId(block.chainid, address(usdc), address(settler));
        uint256 victimNet = lanes.balanceOf(address(settler), lid);
        assertGt(victimNet, 90e6, "victim's ~$99 net stranded in the shared conduit lane");

        // 2. The attacker settles a tiny $1 payment on ITS OWN split. With the
        //    bounded-claim fix, settleToken claims ONLY the net this $1 settle
        //    credited — the victim's stranded net stays in the shared lane.
        vm.prank(attackerBuyer);
        settler.settleToken(splitId, address(usdc), 1e8, ATTACK_ORDER);

        uint256 fanned = settler.withdrawable(payeeA, address(usdc))
            + settler.withdrawable(payeeB, address(usdc));

        // THE fix invariant: the victim's stranded net is UNTOUCHED in the shared
        // lane after the attacker's settle — not swept into the attacker's split.
        // Pre-fix the lane was drained to ~0 and `fanned` was victimNet + attackNet
        // (~$99.5); post-fix the lane still holds exactly victimNet and `fanned` is
        // only the attacker's own tiny $1 net.
        assertEq(
            lanes.balanceOf(address(settler), lid),
            victimNet,
            "victim's net remains in the lane (not swept by the attacker's settle)"
        );
        assertLt(
            fanned, victimNet, "attacker fanned out only its own net, nowhere near the victim's $99"
        );
    }
}
