// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HookTestBase} from "./utils/HookTestBase.sol";
import {MockMerchants} from "./Access0x1ReceiptHook.t.sol";
import {Access0x1MemberFeeHook, IMembership} from "../src/Access0x1MemberFeeHook.sol";
import {Access0x1SwapRouter} from "../src/Access0x1SwapRouter.sol";

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockMembership is IMembership {
    mapping(address => mapping(uint256 => bool)) public active;
    bool public broken;

    function set(address who, uint256 tier, bool on) external {
        active[who][tier] = on;
    }

    function breakIt() external {
        broken = true;
    }

    function isActive(address who, uint256 tier) external view returns (bool) {
        require(!broken, "down");
        return active[who][tier];
    }
}

contract Access0x1MemberFeeHookTest is HookTestBase {
    uint160 internal constant FLAGS = 0x2080; // beforeInitialize | beforeSwap
    uint256 internal constant MERCHANT = 3;
    uint256 internal constant TIER = 1;
    uint24 internal constant MEMBER_FEE = 500; // 0.05%
    uint24 internal constant PUBLIC_FEE = 10_000; // 1%

    MockMerchants internal registry;
    MockMembership internal membership;
    Access0x1MemberFeeHook internal hook;
    Access0x1SwapRouter internal router;
    PoolKey internal key;

    address internal owner = makeAddr("merchant owner");
    address internal member = makeAddr("member");
    address internal outsider = makeAddr("outsider");

    function setUp() public {
        _deployV4();
        registry = new MockMerchants();
        registry.set(MERCHANT, owner, owner, true);
        membership = new MockMembership();
        membership.set(member, TIER, true);

        address where = _flagAddress(FLAGS);
        _place(abi.encodePacked(type(Access0x1MemberFeeHook).creationCode, abi.encode(manager, registry)), where);
        hook = Access0x1MemberFeeHook(where);
        router = new Access0x1SwapRouter(manager);

        key = _dynamicKey(60);
        vm.startPrank(owner);
        hook.configure(key, MERCHANT, membership, TIER, MEMBER_FEE, PUBLIC_FEE);
        hook.setRouterTrust(MERCHANT, address(router), true);
        vm.stopPrank();
        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));
        _addLiquidity(key);

        _fund(member);
        _fund(outsider);
    }

    // ── 1. the address carries exactly what the hook declares ───────────────────────────────

    function test_Address_MatchesDeclaredPermissions() public view {
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, FLAGS, "address bits");
        assertEq(_maskOf(hook.getHookPermissions()), FLAGS, "declared permissions");
    }

    // ── 2. the fee ──────────────────────────────────────────────────────────────────────────

    function test_Member_PaysLessThanOutsider_ForTheSameSwap() public {
        uint256 snap = vm.snapshotState();
        uint256 memberOut = _swap(member, 1e16);
        vm.revertToState(snap);
        uint256 outsiderOut = _swap(outsider, 1e16);

        assertGt(memberOut, outsiderOut, "the member got no better price");
        (uint24 mFee,) = hook.feeFor(key, member);
        (uint24 oFee,) = hook.feeFor(key, outsider);
        assertEq(mFee, MEMBER_FEE);
        assertEq(oFee, PUBLIC_FEE);
    }

    /// @dev Through a router the merchant does not trust, the swapper is the router, which holds
    ///      no membership: a member gets exactly what an outsider gets.
    function test_UntrustedRouter_PaysThePublicFee_EvenForAMember() public {
        vm.prank(owner);
        hook.setRouterTrust(MERCHANT, address(router), false);

        uint256 snap = vm.snapshotState();
        uint256 memberOut = _swap(member, 1e16);
        vm.revertToState(snap);
        assertEq(memberOut, _swap(outsider, 1e16), "an untrusted router's user got the member fee");
    }

    function test_BrokenMembership_FallsBackToPublicFee_SwapSettles() public {
        membership.breakIt();
        (uint24 fee, bool isMember) = hook.feeFor(key, member);
        assertEq(fee, PUBLIC_FEE);
        assertFalse(isMember);
        assertGt(_swap(member, 1e16), 0, "the swap did not settle");
    }

    // ── 3. configuration ────────────────────────────────────────────────────────────────────

    function test_RevertWhen_ConfiguredByAnyoneButTheMerchantOwner() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Access0x1MemberFeeHook.NotMerchantOwner.selector, MERCHANT, outsider));
        hook.configure(_dynamicKey(10), MERCHANT, membership, TIER, MEMBER_FEE, PUBLIC_FEE);
    }

    function test_RevertWhen_AnotherMerchantTakesAConfiguredPool() public {
        registry.set(4, outsider, outsider, true);
        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1MemberFeeHook.PoolBoundToAnotherMerchant.selector, key.toId(), MERCHANT)
        );
        hook.configure(key, 4, membership, TIER, 0, 0);
    }

    function test_RevertWhen_FeeAboveCap_OrMemberFeeAbovePublic() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(Access0x1MemberFeeHook.FeeTooHigh.selector, uint24(100_001)));
        hook.configure(key, MERCHANT, membership, TIER, 0, 100_001);
        vm.expectRevert(
            abi.encodeWithSelector(Access0x1MemberFeeHook.MemberFeeAbovePublicFee.selector, uint24(2), uint24(1))
        );
        hook.configure(key, MERCHANT, membership, TIER, 2, 1);
        vm.stopPrank();
    }

    /// @dev Unconfigured or static-fee pools cannot be opened: the PoolManager wraps the hook's error.
    function test_RevertWhen_PoolIsUnconfigured_OrStaticFee() public {
        PoolKey memory bare = _dynamicKey(10);
        vm.expectRevert();
        manager.initialize(bare, TickMath.getSqrtPriceAtTick(0));

        PoolKey memory fixedFee = PoolKey(currency0, currency1, 3000, 10, IHooks(address(hook)));
        vm.prank(owner);
        hook.configure(fixedFee, MERCHANT, membership, TIER, MEMBER_FEE, PUBLIC_FEE);
        vm.expectRevert();
        manager.initialize(fixedFee, TickMath.getSqrtPriceAtTick(0));
    }

    // ── 4. fuzz ─────────────────────────────────────────────────────────────────────────────

    /// @dev For any amount and any pair of valid fees, a member never receives less than an outsider.
    function testFuzz_MemberNeverWorseOff(uint96 amount, uint24 memberFee, uint24 publicFee) public {
        publicFee = uint24(bound(publicFee, 0, hook.MAX_FEE()));
        memberFee = uint24(bound(memberFee, 0, publicFee));
        uint256 amountIn = bound(amount, 1e6, 1e16);
        vm.prank(owner);
        hook.configure(key, MERCHANT, membership, TIER, memberFee, publicFee);

        uint256 snap = vm.snapshotState();
        uint256 memberOut = _swap(member, amountIn);
        vm.revertToState(snap);
        assertGe(memberOut, _swap(outsider, amountIn), "a member received less than an outsider");
    }

    // ── helpers ─────────────────────────────────────────────────────────────────────────────

    function _dynamicKey(int24 spacing) internal view returns (PoolKey memory) {
        return PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, spacing, IHooks(address(hook)));
    }

    function _fund(address who) internal {
        IERC20(Currency.unwrap(currency0)).transfer(who, 1e18);
        vm.prank(who);
        IERC20(Currency.unwrap(currency0)).approve(address(router), type(uint256).max);
    }

    function _swap(address who, uint256 amountIn) internal returns (uint256 out) {
        vm.prank(who);
        out = router.swapExactIn(key, true, amountIn, 0, who, "", block.timestamp);
    }
}
