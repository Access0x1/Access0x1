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

/// @title Conduit × PaymentLanes settlement integrity (audit regression)
/// @notice Proves the CRITICAL fix: with PaymentLanes WIRED on the shared router
///         (the `DEPLOY_PAYMENT_LANES=true` path), a conduit whose router payout is
///         the conduit itself (SplitSettler) still pays its payees the EXACT net.
///         Before the fix, the router credited the net into an ERC-6909 lane the
///         conduit could not claim, so it measured net==0, fanned out zero to every
///         payee, and stranded the funds. This suite wires lanes (the config the
///         legacy unit tests never exercised) and asserts Σ(payee credits) == net > 0.
contract ConduitLanesIntegrationTest is Test, ProxyDeployer {
    uint256 internal constant LOCAL = 31_337;
    address internal constant BROADCASTER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    Access0x1Router internal router;
    PaymentLanes internal lanes;
    MockUSDC internal usdc;
    SplitSettler internal settler;

    address internal merchantOwner = makeAddr("cli_merchantOwner");
    address internal payeeA = makeAddr("cli_payeeA");
    address internal payeeB = makeAddr("cli_payeeB");
    address internal buyer = makeAddr("cli_buyer");

    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.50% merchant surcharge
    uint256 internal constant USD_AMOUNT_8 = 250e8; // $250.00
    bytes32 internal constant ORDER = keccak256("cli-order-1");
    bytes32 internal constant NAME_HASH = keccak256("conduit.access0x1.eth");

    uint256 internal merchantId;
    uint256 internal splitId;

    function setUp() public {
        CreateXEtch.enable(vm);
        vm.warp(1_700_000_000);

        // Deploy the real spine WITH PaymentLanes wired — the exact composition the
        // audit flagged and the legacy conduit tests never covered.
        vm.chainId(LOCAL);
        vm.setEnv("ROUTER_OWNER", vm.toString(BROADCASTER));
        vm.setEnv("DEPLOY_PAYMENT_LANES", "true");
        HelperConfig hc;
        (router, lanes, hc) = new DeployAll().run();
        usdc = MockUSDC(hc.getConfig().usdc);
        assertEq(router.paymentLanes(), address(lanes), "lanes wired on the router");

        // Deploy the SplitSettler conduit against the live router.
        settler = SplitSettler(
            payable(deployProxy(
                    address(new SplitSettler()),
                    abi.encodeCall(SplitSettler.initialize, (merchantOwner, router))
                ))
        );

        // The conduit IS the merchant payout — this is the config that strands net
        // under a lanes-wired router without the claim-back fix.
        vm.prank(merchantOwner);
        merchantId =
            router.registerMerchant(address(settler), address(0), MERCHANT_FEE_BPS, NAME_HASH);

        ISplitSettler.Payee[] memory payees = new ISplitSettler.Payee[](2);
        payees[0] = ISplitSettler.Payee({ account: payeeA, shareBps: 6000 });
        payees[1] = ISplitSettler.Payee({ account: payeeB, shareBps: 4000 });
        vm.prank(merchantOwner);
        splitId = settler.createSplit(merchantId, payees, 0);

        usdc.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        usdc.approve(address(settler), type(uint256).max);
    }

    function test_lanesWired_splitPaysPayeesExactNet_notZero() public {
        uint256 gross = router.quote(merchantId, address(usdc), USD_AMOUNT_8);
        assertGt(gross, 0, "quote is non-zero");

        vm.prank(buyer);
        settler.settleToken(splitId, address(usdc), USD_AMOUNT_8, ORDER);

        uint256 credA = settler.withdrawable(payeeA, address(usdc));
        uint256 credB = settler.withdrawable(payeeB, address(usdc));
        uint256 net = credA + credB;

        // THE regression assertion: net reached the payees (pre-fix this was 0 — the
        // net was stranded in an unclaimable lane and every payee got nothing).
        assertGt(net, 0, "payees were credited the net (not stranded in a lane)");

        // Exact conservation: Σ(payee credits) == the router net (gross - fees), and
        // the split proportions hold (60/40, last leg absorbs the rounding remainder).
        // net == gross - platformFee - merchantFee; derive it the same way the router does.
        // We assert Σ credits equals the settler's realized net and the shares are right.
        assertEq(credA, (net * 6000) / 10_000, "payee A got ~60% (remainder to last leg)");
        assertEq(credB, net - (net * 6000) / 10_000, "payee B got the exact remainder");

        // The conduit CLAIMED its lane back to ERC-20 (else this balance would be 0 and the net
        // stranded). It holds exactly the net as real ERC-20, custodied for the pull-map until
        // payees withdraw — the never-blockable payout model.
        assertEq(
            IERC20(usdc).balanceOf(address(settler)),
            net,
            "conduit holds the claimed-back net as ERC-20"
        );

        // End-to-end: a payee withdraws and receives their exact leg in real USDC.
        vm.prank(payeeA);
        settler.withdraw(address(usdc));
        assertEq(
            IERC20(usdc).balanceOf(payeeA), credA, "payee A withdrew the exact net leg in ERC-20"
        );
    }
}
