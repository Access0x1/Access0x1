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

    function setUp() public virtual {
        router = new Access0x1Router(owner, treasury, PLATFORM_FEE_BPS);
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
}
