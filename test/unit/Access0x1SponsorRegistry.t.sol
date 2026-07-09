// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Access0x1SponsorRegistry } from "../../src/Access0x1SponsorRegistry.sol";
import { IAccess0x1SponsorRegistry } from "../../src/interfaces/IAccess0x1SponsorRegistry.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import {
    OwnableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @notice A trivial v2 for the upgrade test — one added view, no new storage.
contract SponsorRegistryV2 is Access0x1SponsorRegistry {
    function version2Marker() external pure returns (string memory) {
        return "v2";
    }
}

/// @notice The sponsor-record unit suite: the record is the PRODUCT (a dashboard renders
///         CONNECTED iff `sponsorOf` is non-zero), so every transition is pinned — two-step
///         consent (offer by anyone, accept by the LIVE merchant owner only), last-offer-stands,
///         either-side walk-away, unknown-seat rejection, ownership-handover moving authority
///         (live router reads, never a cached owner), and the UUPS upgrade preserving records.
contract Access0x1SponsorRegistryTest is Test, ProxyDeployer {
    Access0x1Router internal router;
    Access0x1SponsorRegistry internal registry;

    address internal owner = makeAddr("owner"); // router admin
    address internal admin = makeAddr("admin"); // registry upgrade admin
    address internal treasury = makeAddr("treasury");

    address internal merchantOwner = makeAddr("merchantOwner");
    address internal merchantPayout = makeAddr("merchantPayout");
    address internal sponsor = makeAddr("sponsor");
    address internal rivalSponsor = makeAddr("rivalSponsor");
    address internal stranger = makeAddr("stranger");

    uint256 internal merchantId;

    function setUp() public {
        router = Access0x1Router(
            deployProxy(
                address(new Access0x1Router()),
                abi.encodeCall(Access0x1Router.initialize, (owner, treasury, 100))
            )
        );
        registry = Access0x1SponsorRegistry(
            deployProxy(
                address(new Access0x1SponsorRegistry()),
                abi.encodeCall(Access0x1SponsorRegistry.initialize, (admin, router))
            )
        );
        vm.prank(merchantOwner);
        merchantId = router.registerMerchant(merchantPayout, address(0), 0, keccak256("acme"));
    }

    /*//////////////////////////////////////////////////////////////
                              INITIALIZE
    //////////////////////////////////////////////////////////////*/

    function test_initializeSetsRouterAndAdmin() public view {
        assertEq(address(registry.router()), address(router));
        assertEq(OwnableUpgradeable(address(registry)).owner(), admin);
    }

    function test_initializeRevertsOnZeroRouter() public {
        address impl = address(new Access0x1SponsorRegistry());
        vm.expectRevert(IAccess0x1SponsorRegistry.Access0x1SponsorRegistry__ZeroAddress.selector);
        deployProxy(
            impl,
            abi.encodeCall(
                Access0x1SponsorRegistry.initialize, (admin, Access0x1Router(payable(0)))
            )
        );
    }

    function test_initializeRevertsOnSecondCall() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        registry.initialize(admin, router);
    }

    /*//////////////////////////////////////////////////////////////
                                 OFFER
    //////////////////////////////////////////////////////////////*/

    function test_anyoneMayOffer_recordStaysUnwired() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit IAccess0x1SponsorRegistry.SponsorshipOffered(merchantId, sponsor);
        vm.prank(sponsor);
        registry.offerSponsorship(merchantId);

        assertEq(registry.pendingSponsorOf(merchantId), sponsor, "offer pending");
        assertEq(registry.sponsorOf(merchantId), address(0), "NOT wired until accepted");
    }

    function test_offerRevertsForUnknownMerchant() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1SponsorRegistry.Access0x1SponsorRegistry__MerchantUnknown.selector, 999
            )
        );
        vm.prank(sponsor);
        registry.offerSponsorship(999);
    }

    function test_lastOfferStands() public {
        vm.prank(sponsor);
        registry.offerSponsorship(merchantId);
        vm.prank(rivalSponsor);
        registry.offerSponsorship(merchantId);
        assertEq(registry.pendingSponsorOf(merchantId), rivalSponsor);
    }

    /*//////////////////////////////////////////////////////////////
                                 ACCEPT
    //////////////////////////////////////////////////////////////*/

    function test_merchantOwnerAccepts_recordWired() public {
        vm.prank(sponsor);
        registry.offerSponsorship(merchantId);

        vm.expectEmit(true, true, false, true, address(registry));
        emit IAccess0x1SponsorRegistry.SponsorAccepted(merchantId, sponsor);
        vm.prank(merchantOwner);
        registry.acceptSponsor(merchantId);

        assertEq(registry.sponsorOf(merchantId), sponsor, "CONNECTED");
        assertEq(registry.pendingSponsorOf(merchantId), address(0), "offer consumed");
    }

    function test_acceptRevertsForNonOwnerAndNoOffer() public {
        // No offer yet.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1SponsorRegistry.Access0x1SponsorRegistry__NoPendingOffer.selector,
                merchantId
            )
        );
        vm.prank(merchantOwner);
        registry.acceptSponsor(merchantId);

        // Offer exists, wrong caller.
        vm.prank(sponsor);
        registry.offerSponsorship(merchantId);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1SponsorRegistry.Access0x1SponsorRegistry__NotMerchantOwner.selector,
                merchantId,
                stranger
            )
        );
        vm.prank(stranger);
        registry.acceptSponsor(merchantId);

        // The SPONSOR cannot self-accept either — consent is the merchant's.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1SponsorRegistry.Access0x1SponsorRegistry__NotMerchantOwner.selector,
                merchantId,
                sponsor
            )
        );
        vm.prank(sponsor);
        registry.acceptSponsor(merchantId);
    }

    function test_acceptReplacesEarlierSponsor() public {
        vm.prank(sponsor);
        registry.offerSponsorship(merchantId);
        vm.prank(merchantOwner);
        registry.acceptSponsor(merchantId);

        vm.prank(rivalSponsor);
        registry.offerSponsorship(merchantId);
        vm.prank(merchantOwner);
        registry.acceptSponsor(merchantId);

        assertEq(registry.sponsorOf(merchantId), rivalSponsor, "newest accepted wins");
    }

    /*//////////////////////////////////////////////////////////////
                                 CLEAR
    //////////////////////////////////////////////////////////////*/

    function _wire() internal {
        vm.prank(sponsor);
        registry.offerSponsorship(merchantId);
        vm.prank(merchantOwner);
        registry.acceptSponsor(merchantId);
    }

    function test_merchantOwnerClears() public {
        _wire();
        vm.expectEmit(true, true, false, true, address(registry));
        emit IAccess0x1SponsorRegistry.SponsorCleared(merchantId, sponsor, true);
        vm.prank(merchantOwner);
        registry.clearSponsor(merchantId);
        assertEq(registry.sponsorOf(merchantId), address(0), "NOT-YET-WIRED again");
    }

    function test_sponsorWalksAway() public {
        _wire();
        vm.expectEmit(true, true, false, true, address(registry));
        emit IAccess0x1SponsorRegistry.SponsorCleared(merchantId, sponsor, false);
        vm.prank(sponsor);
        registry.clearSponsor(merchantId);
        assertEq(registry.sponsorOf(merchantId), address(0));
    }

    function test_pendingSponsorMayWithdrawOwnOffer() public {
        vm.prank(sponsor);
        registry.offerSponsorship(merchantId);
        vm.prank(sponsor);
        registry.clearSponsor(merchantId);
        assertEq(registry.pendingSponsorOf(merchantId), address(0));
    }

    function test_clearRevertsForStrangerAndWhenEmpty() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1SponsorRegistry.Access0x1SponsorRegistry__NothingToClear.selector,
                merchantId
            )
        );
        vm.prank(merchantOwner);
        registry.clearSponsor(merchantId);

        _wire();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1SponsorRegistry.Access0x1SponsorRegistry__NotPartyToSponsorship.selector,
                merchantId,
                stranger
            )
        );
        vm.prank(stranger);
        registry.clearSponsor(merchantId);
    }

    /*//////////////////////////////////////////////////////////////
                       LIVE OWNERSHIP (the registry law)
    //////////////////////////////////////////////////////////////*/

    function test_ownershipHandoverMovesAuthority() public {
        // Authority follows router.merchants(id).owner LIVE — a seat handover moves accept/clear
        // rights with it, no cached owner anywhere in this contract.
        vm.prank(sponsor);
        registry.offerSponsorship(merchantId);

        address newOwner = makeAddr("newOwner");
        vm.prank(merchantOwner);
        router.proposeMerchantOwner(merchantId, newOwner);
        vm.prank(newOwner);
        router.acceptMerchantOwner(merchantId);

        // Old owner lost authority…
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1SponsorRegistry.Access0x1SponsorRegistry__NotMerchantOwner.selector,
                merchantId,
                merchantOwner
            )
        );
        vm.prank(merchantOwner);
        registry.acceptSponsor(merchantId);

        // …the new owner has it.
        vm.prank(newOwner);
        registry.acceptSponsor(merchantId);
        assertEq(registry.sponsorOf(merchantId), sponsor);
    }

    /*//////////////////////////////////////////////////////////////
                                  UUPS
    //////////////////////////////////////////////////////////////*/

    function test_upgradePreservesRecordsAndGates() public {
        _wire();
        address v2 = address(new SponsorRegistryV2());

        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger)
        );
        vm.prank(stranger);
        registry.upgradeToAndCall(v2, "");

        vm.prank(admin);
        registry.upgradeToAndCall(v2, "");
        assertEq(SponsorRegistryV2(address(registry)).version2Marker(), "v2");
        assertEq(registry.sponsorOf(merchantId), sponsor, "record survives the upgrade");
    }
}
