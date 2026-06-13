// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";

/// @notice Base fixture for the router's registry/admin/quote unit tests. Pay-path tests (which
///         need token + reverting-receiver mocks) live in their own file built on the same shape.
contract Access0x1RouterTest is Test {
    Access0x1Router internal router;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    uint16 internal constant PLATFORM_FEE_BPS = 100; // 1%

    address internal merchantOwner = makeAddr("merchantOwner");
    address internal payout = makeAddr("payout");
    address internal feeRecipient = makeAddr("feeRecipient");
    uint16 internal constant MERCHANT_FEE_BPS = 50; // 0.5%
    bytes32 internal constant NAME_HASH = keccak256("acme");

    function setUp() public virtual {
        router = new Access0x1Router(owner, treasury, PLATFORM_FEE_BPS);
    }

    /// @dev Register the default merchant as `merchantOwner`; returns its id.
    function _register() internal returns (uint256 id) {
        vm.prank(merchantOwner);
        id = router.registerMerchant(payout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_constructorSetsInitialState() public view {
        assertEq(router.owner(), owner);
        assertEq(router.platformTreasury(), treasury);
        assertEq(router.platformFeeBps(), PLATFORM_FEE_BPS);
        assertEq(router.nextMerchantId(), 1); // 0 stays the unset sentinel
        assertEq(router.MAX_FEE_BPS(), 1000);
    }

    function test_constructorRevertsOnZeroTreasury() public {
        vm.expectRevert(Access0x1Router.Access0x1__ZeroAddress.selector);
        new Access0x1Router(owner, address(0), PLATFORM_FEE_BPS);
    }

    function test_constructorRevertsOnFeeTooHigh() public {
        uint16 tooHigh = router.MAX_FEE_BPS() + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__FeeTooHigh.selector, tooHigh, router.MAX_FEE_BPS()
            )
        );
        new Access0x1Router(owner, treasury, tooHigh);
    }

    /*//////////////////////////////////////////////////////////////
                            REGISTER MERCHANT
    //////////////////////////////////////////////////////////////*/

    function test_registerStoresMerchantAndEmits() public {
        vm.expectEmit(true, true, false, true, address(router));
        emit Access0x1Router.MerchantRegistered(
            1, merchantOwner, payout, feeRecipient, MERCHANT_FEE_BPS, NAME_HASH
        );
        uint256 id = _register();

        assertEq(id, 1);
        (address p, address o, address fr, uint16 fb, bool active, bytes32 nh) = router.merchants(1);
        assertEq(p, payout);
        assertEq(o, merchantOwner);
        assertEq(fr, feeRecipient);
        assertEq(fb, MERCHANT_FEE_BPS);
        assertTrue(active);
        assertEq(nh, NAME_HASH);
        assertEq(router.nextMerchantId(), 2);
    }

    function test_registerIncrementsId() public {
        assertEq(_register(), 1);
        assertEq(_register(), 2);
    }

    function test_registerRevertsOnZeroPayout() public {
        vm.prank(merchantOwner);
        vm.expectRevert(Access0x1Router.Access0x1__ZeroAddress.selector);
        router.registerMerchant(address(0), feeRecipient, MERCHANT_FEE_BPS, NAME_HASH);
    }

    function test_registerRevertsWhenFeeCapExceeded() public {
        uint256 maxFee = router.MAX_FEE_BPS(); // cache before prank — a call here would consume it
        uint16 over = uint16(maxFee) - PLATFORM_FEE_BPS + 1; // combined = 1001 > 1000
        uint256 combined = uint256(over) + PLATFORM_FEE_BPS;
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__FeeTooHigh.selector, combined, maxFee)
        );
        router.registerMerchant(payout, feeRecipient, over, NAME_HASH);
    }

    function test_registerAllowsExactlyMaxFee() public {
        uint16 atCap = router.MAX_FEE_BPS() - PLATFORM_FEE_BPS; // combined == 1000
        vm.prank(merchantOwner);
        uint256 id = router.registerMerchant(payout, feeRecipient, atCap, NAME_HASH);
        (,,, uint16 fb,,) = router.merchants(id);
        assertEq(fb, atCap);
    }

    function test_registerAllowsZeroFeeRecipient() public {
        vm.prank(merchantOwner);
        uint256 id = router.registerMerchant(payout, address(0), MERCHANT_FEE_BPS, NAME_HASH);
        (,, address fr,,,) = router.merchants(id);
        assertEq(fr, address(0)); // allowed: pay path falls back to payout
    }

    /*//////////////////////////////////////////////////////////////
                            UPDATE MERCHANT
    //////////////////////////////////////////////////////////////*/

    function test_updateChangesConfigAndPreservesIdentity() public {
        uint256 id = _register();
        address newPayout = makeAddr("newPayout");
        address newFeeRecipient = makeAddr("newFeeRecipient");
        uint16 newFeeBps = 200;

        vm.expectEmit(true, false, false, true, address(router));
        emit Access0x1Router.MerchantUpdated(id, newPayout, newFeeRecipient, newFeeBps, false);
        vm.prank(merchantOwner);
        router.updateMerchant(id, newPayout, newFeeRecipient, newFeeBps, false);

        (address p, address o, address fr, uint16 fb, bool active, bytes32 nh) =
            router.merchants(id);
        assertEq(p, newPayout);
        assertEq(fr, newFeeRecipient);
        assertEq(fb, newFeeBps);
        assertFalse(active);
        assertEq(o, merchantOwner); // owner is immutable
        assertEq(nh, NAME_HASH); // nameHash is immutable
    }

    function test_updateRevertsOnUnknownId() public {
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__MerchantNotFound.selector, 999)
        );
        router.updateMerchant(999, payout, feeRecipient, MERCHANT_FEE_BPS, true);
    }

    function test_updateRevertsWhenNotOwner() public {
        uint256 id = _register();
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1Router.Access0x1__NotMerchantOwner.selector, id, attacker
            )
        );
        router.updateMerchant(id, payout, feeRecipient, MERCHANT_FEE_BPS, true);
    }

    function test_updateRevertsOnZeroPayout() public {
        uint256 id = _register();
        vm.prank(merchantOwner);
        vm.expectRevert(Access0x1Router.Access0x1__ZeroAddress.selector);
        router.updateMerchant(id, address(0), feeRecipient, MERCHANT_FEE_BPS, true);
    }

    function test_updateRevertsWhenFeeCapExceeded() public {
        uint256 id = _register();
        uint256 maxFee = router.MAX_FEE_BPS(); // cache before prank — a call here would consume it
        uint16 over = uint16(maxFee) - PLATFORM_FEE_BPS + 1;
        uint256 combined = uint256(over) + PLATFORM_FEE_BPS;
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1Router.Access0x1__FeeTooHigh.selector, combined, maxFee)
        );
        router.updateMerchant(id, payout, feeRecipient, over, true);
    }
}
