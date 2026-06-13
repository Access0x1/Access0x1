// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { DeployAll } from "../../script/DeployAll.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { HouseTokenFactory } from "../../src/HouseTokenFactory.sol";
import { HouseToken } from "../../src/HouseToken.sol";

/// @title  HouseTokenFactoryIntegration — Cyfrin INTEGRATION suite for {HouseTokenFactory}
/// @author Access0x1
/// @notice Exercises the factory THROUGH the REAL deploy path, not a hand-rolled `new` in a test. The
///         existing end-to-end test (test/integration/EndToEnd.t.sol) wires the estate by hand; this
///         file is the Cyfrin integration layer that proves the SHIPPING artifact is correct: it runs
///         the actual `DeployAll` script (which itself reads `HelperConfig`, deploys the Router, the
///         SessionGrant, the commerce quartet, and the HouseTokenFactory in one broadcast), then drives
///         the factory it produced. Because the factory under test is the one the deploy script builds,
///         the DEPLOY ITSELF is covered here too — a misconfigured script would fail this suite.
///
///         The integration story: a business deploys its OWN house ERC-20 through the script-deployed
///         factory, the platform admin then allowlists that token as a payable/payout token on the
///         script-deployed Router (the SPEC.md "payout token + house token" seam), and we prove the
///         pieces COMPOSE — the factory hands over zero-custody ownership, the Router can trust the
///         token's provenance, and a real owner-only mint + holder transfer work end to end.
/// @dev    Local Anvil chain: `HelperConfig` deploys live mocks (MockUSDC, MockV3Aggregator), so no real
///         feed/USDC addresses are needed. `ROUTER_OWNER` is pinned to the broadcast default sender so
///         the in-broadcast `onlyOwner` configure calls in `DeployAll` are authorized — mirroring a real
///         `forge script --sender $DEPLOYER` run (the same convention test/unit/DeployAll.t.sol uses).
contract HouseTokenFactoryIntegrationTest is Test {
    /// @dev Foundry's broadcast default sender — what `vm.startBroadcast()` (no arg) pranks as inside the
    ///      script; pinning ROUTER_OWNER to it lets the script's owner-only configure calls authorize.
    address internal constant BROADCASTER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;
    uint256 internal constant LOCAL = 31_337;

    Access0x1Router internal router;
    HouseTokenFactory internal factory;
    HelperConfig internal helperConfig;

    address internal business = makeAddr("business"); // the merchant wallet that will OWN its house token
    address internal relayer = makeAddr("relayer"); // a distinct deployer-of-record (onboarding relayer)
    address internal customer = makeAddr("customer"); // a downstream holder of the house token

    /// @notice Stand up the WHOLE estate via the real `DeployAll` script, then capture the factory it
    ///         produced. This is the integration seam: every assertion below runs against the
    ///         script-built factory, so the deploy script is under test alongside the contract.
    function setUp() public {
        vm.chainId(LOCAL);
        // Pin the owner to the broadcaster so DeployAll's owner-only configure calls are authorized
        // (reproduces the real `--sender $DEPLOYER` run where `owner` defaults to the signer).
        vm.setEnv("ROUTER_OWNER", vm.toString(BROADCASTER));
        // Keep the lanes ledger out of this story — the house-token seam is the Router allowlist, not
        // PaymentLanes; leaving lanes off keeps the integration focused and deterministic.
        vm.setEnv("DEPLOY_PAYMENT_LANES", "false");

        DeployAll deployer = new DeployAll();
        (router,, helperConfig) = deployer.run();
        // The script records the factory it deployed in public state — read it back as the SUT.
        factory = deployer.houseFactory();

        // Sanity: the script actually produced a factory and wired the router around it.
        assertTrue(address(factory) != address(0), "DeployAll must deploy a HouseTokenFactory");
        assertTrue(address(router) != address(0), "DeployAll must deploy the Router spine");
        assertEq(factory.deployedCount(), 0, "a fresh factory starts with zero deploys");
    }

    /*//////////////////////////////////////////////////////////////
        THE SCRIPT-DEPLOYED FACTORY IS A REAL, ZERO-CUSTODY FACTORY
    //////////////////////////////////////////////////////////////*/

    /// @notice The factory the deploy script produced has NO owner, NO admin surface, and NO custody — it
    ///         is the same zero-authority artifact the unit tests describe, proven on the SHIPPING build.
    ///         A business deploys its own token through it and walks away owning everything; the factory
    ///         keeps only provenance.
    function test_integration_scriptFactory_deploysZeroCustodyToken() public {
        // The business nominates ITSELF as owner; a relayer is the deployer of record (caller-agnostic).
        vm.prank(relayer);
        HouseToken token = HouseToken(
            factory.deployHouseToken(business, "Acme Points", "ACME", 18, 1_000_000e18)
        );

        // The business owns the token and the full supply; the relayer and factory hold nothing.
        assertEq(token.owner(), business, "business owns its house token");
        assertEq(token.balanceOf(business), 1_000_000e18, "full supply to the business");
        assertEq(token.balanceOf(relayer), 0, "the deployer-of-record holds no supply");
        assertEq(token.balanceOf(address(factory)), 0, "the factory holds no supply (zero custody)");
        assertTrue(token.owner() != address(factory), "the factory never owns a deployed token");

        // Provenance recorded on the script-built factory.
        assertTrue(factory.isHouseToken(address(token)), "factory records the token's provenance");
        assertEq(factory.deployedCount(), 1, "deployedCount tracks the one deploy");
        assertEq(token.factory(), address(factory), "the token points back at the script's factory");
    }

    /*//////////////////////////////////////////////////////////////
        COMPOSITION WITH THE ROUTER — the payout/payable-token seam
    //////////////////////////////////////////////////////////////*/

    /// @notice The house-token + Router composition (SPEC.md "payout token + house token"): a business
    ///         deploys its house ERC-20 through the script's factory, then the platform admin allowlists
    ///         that token on the script's Router so it can flow as a payable token. Proves the factory's
    ///         output slots straight into the Router's allowlist seam, and that the Router's owner — the
    ///         broadcaster the script wired — is the ONLY party who can flip the allowlist (a non-owner
    ///         cannot, so the house token cannot be smuggled onto the allowlist by anyone else).
    function test_integration_houseTokenComposesWithRouterAllowlist() public {
        HouseToken token =
            HouseToken(factory.deployHouseToken(business, "Acme Points", "ACME", 18, 0));

        // Before allowlisting, the Router does not yet accept the freshly minted house token.
        assertFalse(router.tokenAllowed(address(token)), "a new house token is not pre-allowlisted");

        // A non-owner cannot allowlist it — the Router's owner gate holds for the house-token seam too.
        vm.prank(business);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, business)
        );
        router.setTokenAllowed(address(token), true);

        // The Router owner (the broadcaster the script set) allowlists the provenance-trusted token.
        // The Router can trust it precisely because the factory vouches for where it came from.
        assertTrue(
            factory.isHouseToken(address(token)), "Router can trust provenance before allowing"
        );
        vm.prank(router.owner());
        router.setTokenAllowed(address(token), true);
        assertTrue(router.tokenAllowed(address(token)), "house token now flows as a payable token");
    }

    /*//////////////////////////////////////////////////////////////
        END-TO-END LIFECYCLE on the script-built factory
    //////////////////////////////////////////////////////////////*/

    /// @notice Full house-token lifecycle through the script's factory: deploy with zero initial supply,
    ///         the owning business mints closed-loop points later (owner-only), a customer receives a
    ///         transfer and burns part of it, and supply conservation holds at every step. This is the
    ///         "loyalty / closed-loop credit" flow the factory exists to enable, proven on the deployed
    ///         artifact rather than a hand-rolled instance.
    function test_integration_houseTokenLifecycle_mintTransferBurn() public {
        // Deploy through the real factory with NO initial supply — the owner mints on demand.
        HouseToken token =
            HouseToken(factory.deployHouseToken(business, "Acme Points", "ACME", 18, 0));
        assertEq(token.totalSupply(), 0, "no supply at deploy");

        // Only the business owner may mint its closed-loop points — never the factory, never a relayer.
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, relayer)
        );
        token.mint(relayer, 1_000e18);

        // The owner mints points to itself, then distributes some to a customer.
        vm.prank(business);
        token.mint(business, 1_000e18);
        assertEq(token.totalSupply(), 1_000e18, "supply == minted points");

        vm.prank(business);
        IERC20(address(token)).transfer(customer, 400e18);
        assertEq(token.balanceOf(customer), 400e18, "customer received points");
        assertEq(token.balanceOf(business), 600e18, "business retains the remainder");

        // The customer burns part of their balance (closed-loop redemption); total supply shrinks by
        // exactly the burned amount — conservation under burn.
        vm.prank(customer);
        HouseToken(address(token)).burn(100e18);
        assertEq(token.balanceOf(customer), 300e18, "customer balance reduced by the burn");
        assertEq(token.totalSupply(), 900e18, "totalSupply shrinks by exactly the burned amount");

        // The factory's provenance + count are untouched by any of the token-level activity.
        assertTrue(
            factory.isHouseToken(address(token)), "provenance is permanent across token activity"
        );
        assertEq(factory.deployedCount(), 1, "token-level activity never changes the deploy count");
    }

    /// @notice Multiple businesses onboard through the SAME script-deployed factory: each gets a distinct,
    ///         independently owned token, and the factory's monotonic counter reflects exactly the number
    ///         of deploys. Proves the shared, permissionless factory isolates tenants by construction —
    ///         one business's token grants no authority over another's.
    function test_integration_multiTenantOnboarding() public {
        address businessB = makeAddr("businessB");

        address tA = factory.deployHouseToken(business, "Acme Points", "ACME", 18, 500e18);
        address tB = factory.deployHouseToken(businessB, "Beta Bucks", "BETA", 6, 1_000e6);

        assertTrue(tA != tB, "each tenant gets a distinct token contract");
        assertEq(factory.deployedCount(), 2, "count reflects both onboardings");

        // Tenant isolation: each business owns only its own token; neither can mint the other's.
        assertEq(HouseToken(tA).owner(), business);
        assertEq(HouseToken(tB).owner(), businessB);
        vm.prank(business);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, business)
        );
        HouseToken(tB).mint(business, 1);

        // Distinct decimals survive the shared factory (USDC-style 6 vs standard 18).
        assertEq(HouseToken(tA).decimals(), 18);
        assertEq(HouseToken(tB).decimals(), 6);
    }
}
