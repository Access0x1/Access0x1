// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20Burnable } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { DeployAll } from "../../script/DeployAll.s.sol";
import { CreateXEtch } from "../helpers/CreateXEtch.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { PaymentLanes } from "../../src/PaymentLanes.sol";
import { HouseTokenFactory } from "../../src/HouseTokenFactory.sol";
import { HouseToken } from "../../src/HouseToken.sol";
import { IHouseTokenFactory } from "../../src/interfaces/IHouseTokenFactory.sol";

import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";

/// @title  HouseTokenIntegration — {HouseToken} through the REAL deploy script + the live money spine
/// @author Access0x1
/// @notice The Cyfrin INTEGRATION tier for the house ERC-20. Unlike `EndToEnd.t.sol` (which hand-wires
///         the estate with `new`), this suite stands the system up via the REAL `DeployAll` orchestrator
///         + `HelperConfig` — so the DEPLOY PATH itself is under test, not just the contracts. The
///         `HouseTokenFactory` it reaches is the exact instance the script deploys and records as public
///         state; the token is then exercised through its real composition with the freshly deployed
///         `Access0x1Router` (allowlist + Chainlink-priced `quote`) and `PaymentLanes`, the same seam a
///         business uses to make its house token a first-class pay-in currency (SPEC.md "payout token +
///         house token"). Proving it via the script is the point: a green here means an operator running
///         `make deploy-*` gets a factory that actually composes with the spine, not a unit that only
///         works in a bespoke test harness.
/// @dev    Mirrors `test/unit/DeployAll.t.sol`'s local-run shape: chainId 31337 picks
///         `HelperConfig._localConfigWithMocks` (fresh MockUSDC + MockV3Aggregator + ChainRegistry, no
///         RPC/env), and `ROUTER_OWNER` is pinned to Foundry's broadcast default sender so the script's
///         in-broadcast owner-only configure calls are authorized exactly as in a real
///         `--sender $DEPLOYER` run. The script's `vm.startBroadcast()` makes the BROADCASTER the
///         deployer of record (the factory's `caller`), so the deployed token's `factory()` pointer is
///         the script-deployed factory — honest provenance straight off the real path. No new mocks: the
///         router/token are priced with the in-repo `MockV3Aggregator`, the USDC mock comes from
///         HelperConfig.
contract HouseTokenIntegrationTest is Test {
    /// @dev Local Anvil chain id — selects HelperConfig's fresh-mocks branch.
    uint256 internal constant LOCAL = 31_337;

    /// @dev Foundry's broadcast default sender (the address a no-arg `vm.startBroadcast()` pranks as).
    ///      Pinning `ROUTER_OWNER` to it reproduces the real `--sender $DEPLOYER` owner-default match,
    ///      so the script's `setTokenAllowed`/`setPriceFeed` configure calls succeed in-broadcast.
    address internal constant BROADCASTER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    // The estate, as the SCRIPT produced it.
    Access0x1Router internal router;
    PaymentLanes internal lanes;
    HouseTokenFactory internal factory;
    HelperConfig internal helperConfig;
    address internal usdc; // the HelperConfig-deployed MockUSDC (6 dec)

    // Actors for the house-token flows.
    address internal business = makeAddr("business"); // the merchant: owns its house token
    address internal customer = makeAddr("customer"); // a holder who pays in house tokens
    address internal payout = makeAddr("payout"); // merchant net recipient (lane claim)
    address internal feeRecipient = makeAddr("feeRecipient"); // merchant surcharge leg

    string internal constant H_NAME = "Acme Points";
    string internal constant H_SYMBOL = "ACME";
    uint8 internal constant H_DECIMALS = 18;
    uint256 internal constant H_SUPPLY = 1_000_000e18;

    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.50% surcharge -> feeRecipient
    uint256 internal merchantId;

    /// @notice Stand up the WHOLE estate via the real deploy script, with PaymentLanes ON so the house
    ///         token can settle into a non-custodial lane. Then register a merchant on the
    ///         script-deployed router. Everything downstream uses the script's own factory instance.
    function setUp() public {
        CreateXEtch.enable(vm);
        vm.warp(1_700_000_000); // a stable, non-zero timestamp keeps the mock feed inside staleness
        vm.chainId(LOCAL);
        vm.setEnv("ROUTER_OWNER", vm.toString(BROADCASTER));
        vm.setEnv("DEPLOY_PAYMENT_LANES", "true"); // exercise the lane-credit composition

        DeployAll deployer = new DeployAll();
        (router, lanes, helperConfig) = deployer.run();
        factory = deployer.houseFactory(); // the EXACT factory the script deployed + recorded
        usdc = helperConfig.getConfig().usdc;

        // Sanity: the script actually produced the pieces this suite composes.
        assertTrue(address(factory) != address(0), "script deployed a HouseTokenFactory");
        assertTrue(address(lanes) != address(0), "script deployed + wired PaymentLanes");
        assertEq(router.paymentLanes(), address(lanes), "router wired to the lane ledger");

        // Register a merchant on the script's router (permissionless; caller becomes owner).
        vm.prank(business);
        merchantId =
            router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, keccak256("acme.eth"));
    }

    /*//////////////////////////////////////////////////////////////
            DEPLOY THROUGH THE SCRIPT'S FACTORY — ZERO CUSTODY
    //////////////////////////////////////////////////////////////*/

    /// @notice A business deploys its OWN house token through the factory the SCRIPT deployed, and owns
    ///         it outright: full supply + Ownable owner are the business's, the factory keeps no key, no
    ///         role, no balance, and provenance is recorded. This is the non-custody claim proven on the
    ///         real deploy path (not a hand-wired factory) — and the deployed token's `factory()` points
    ///         back at the script-deployed factory, so provenance is honest end to end.
    function test_integration_deployThroughScriptFactory_zeroCustody() public {
        vm.expectEmit(true, false, true, false, address(factory));
        emit IHouseTokenFactory.Deployed(
            business, address(0), business, H_NAME, H_SYMBOL, H_DECIMALS, H_SUPPLY, block.chainid
        );

        vm.prank(business);
        address token = factory.deployHouseToken(business, H_NAME, H_SYMBOL, H_DECIMALS, H_SUPPLY);

        // Provenance recorded on the script's factory.
        assertTrue(factory.isHouseToken(token), "factory records provenance");
        assertEq(factory.deployedCount(), 1, "deployed count incremented");
        assertEq(HouseToken(token).factory(), address(factory), "token points back at THIS factory");

        // The business owns it; the factory holds nothing and cannot act on it.
        assertEq(HouseToken(token).owner(), business, "business owns its token");
        assertEq(IERC20(token).balanceOf(business), H_SUPPLY, "full supply to the business");
        assertEq(IERC20(token).balanceOf(address(factory)), 0, "factory holds zero balance");

        // The factory cannot mint — Ownable rejects it exactly like any other non-owner.
        vm.prank(address(factory));
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(factory))
        );
        HouseToken(token).mint(address(factory), 1);
    }

    /*//////////////////////////////////////////////////////////////
        HOUSE TOKEN AS A PAY-IN CURRENCY THROUGH THE SCRIPT'S ROUTER
    //////////////////////////////////////////////////////////////*/

    /// @notice The house token composes with the SCRIPT-DEPLOYED router as a first-class pay-in
    ///         currency: the platform admin allowlists + price-feeds it (closed-loop store credit),
    ///         then a $250 order quotes through the SAME Chainlink-priced `quote` math that prices USDC.
    ///         This proves the house-token seam slots into the deployed spine, not a test-only router.
    function test_integration_houseTokenPricesThroughScriptRouter() public {
        vm.prank(business);
        address token = factory.deployHouseToken(business, H_NAME, H_SYMBOL, H_DECIMALS, H_SUPPLY);

        // Allowlist + feed the house token on the DEPLOYED router (owner-only; owner == broadcaster).
        MockV3Aggregator houseFeed = new MockV3Aggregator(8, 1e8); // $1.00, 8-dec feed
        vm.startPrank(BROADCASTER);
        router.setTokenAllowed(token, true);
        router.setPriceFeed(token, address(houseFeed));
        vm.stopPrank();

        // An 18-dec house token at $1.00: a $250 order quotes to 250e18 — same math as native USDC.
        uint256 usdAmount8 = 250e8;
        assertEq(
            router.quote(merchantId, token, usdAmount8),
            250e18,
            "house token prices through the deployed router's quote"
        );
    }

    /// @notice Full money flow with the house token AS the settlement currency through the script's
    ///         spine: a customer pays in house tokens, the router takes its exact two-leg fee split
    ///         (net + platformFee + merchantFee == gross), the NET lands in PaymentLanes as a
    ///         non-custodial receipt, the router keeps ZERO custody, and the merchant claims real house
    ///         tokens out of its lane. Conservation + zero-custody proven end to end on the deployed
    ///         contracts — the house token behaves exactly like USDC on the spine.
    function test_integration_houseTokenSettlesThroughLanes_conservesAndZeroCustody() public {
        // 1. Business deploys + the platform allowlists/feeds the house token on the deployed router.
        vm.prank(business);
        address token = factory.deployHouseToken(business, H_NAME, H_SYMBOL, H_DECIMALS, H_SUPPLY);
        MockV3Aggregator houseFeed = new MockV3Aggregator(8, 1e8);
        vm.startPrank(BROADCASTER);
        router.setTokenAllowed(token, true);
        router.setPriceFeed(token, address(houseFeed));
        vm.stopPrank();

        // 2. The business issues store credit to a customer (owner-only mint), who approves the router.
        uint256 usdAmount8 = 250e8;
        uint256 gross = router.quote(merchantId, token, usdAmount8); // 250e18
        vm.prank(business);
        HouseToken(token).mint(customer, gross);
        vm.prank(customer);
        IERC20(token).approve(address(router), type(uint256).max);

        // 3. The exact two-leg split, recomputed independently of the contract.
        uint16 platformFeeBps = router.platformFeeBps();
        uint256 platformFee = gross * platformFeeBps / 10_000;
        uint256 merchantFee = gross * MERCHANT_FEE_BPS / 10_000;
        uint256 net = gross - platformFee - merchantFee;
        assertEq(net + platformFee + merchantFee, gross, "net + fee == gross (conservation)");

        uint256 supplyBefore = IERC20(token).totalSupply();
        uint256 laneId = lanes.laneId(block.chainid, token, payout);

        // 4. Settle in house tokens.
        vm.prank(customer);
        router.payToken(merchantId, token, usdAmount8, keccak256("order-house-1"));

        // 5. Money landed exactly: customer debited gross, net credited to the merchant's lane, the
        //    lane ledger backs it 1:1, and the router holds ZERO house tokens (zero custody).
        assertEq(IERC20(token).balanceOf(customer), 0, "customer debited exactly gross");
        assertEq(lanes.balanceOf(payout, laneId), net, "merchant lane credited with net");
        assertEq(IERC20(token).balanceOf(address(lanes)), net, "lanes hold net 1:1 (backed)");
        assertEq(
            IERC20(token).balanceOf(address(router)), 0, "router holds no token (zero custody)"
        );
        assertEq(
            IERC20(token).totalSupply(), supplyBefore, "settlement is a transfer, supply unchanged"
        );

        // 6. The merchant claims its lane: the receipt burns and real house tokens hit the payout wallet.
        vm.prank(payout);
        lanes.claim(token);
        assertEq(IERC20(token).balanceOf(payout), net, "merchant claimed net house tokens");
        assertEq(lanes.balanceOf(payout, laneId), 0, "lane receipt burned after claim");
        assertEq(IERC20(token).balanceOf(address(lanes)), 0, "lanes drained back to baseline");
    }

    /// @notice The house token's burn extension composes with the deployed estate too: a business that
    ///         issued store credit can retire it (e.g. expiring loyalty points) by burning its own
    ///         balance, lowering totalSupply — independent of the router, proving the closed-loop
    ///         lifecycle (mint to issue, burn to retire) works on the real deploy path.
    function test_integration_houseTokenBurnRetiresSupply() public {
        vm.prank(business);
        address token = factory.deployHouseToken(business, H_NAME, H_SYMBOL, H_DECIMALS, H_SUPPLY);

        uint256 toBurn = 100_000e18;
        vm.prank(business);
        ERC20Burnable(token).burn(toBurn);

        assertEq(IERC20(token).balanceOf(business), H_SUPPLY - toBurn, "business balance reduced");
        assertEq(IERC20(token).totalSupply(), H_SUPPLY - toBurn, "supply retired by exactly toBurn");
    }
}
