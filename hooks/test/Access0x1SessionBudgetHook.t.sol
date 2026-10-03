// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HookTestBase} from "./utils/HookTestBase.sol";
import {Access0x1SessionBudgetHook, ISessionBudget} from "../src/Access0x1SessionBudgetHook.sol";
import {Access0x1SwapRouter} from "../src/Access0x1SwapRouter.sol";

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The rules of Access0x1's SessionGrant.spend that the hook depends on: only the delegate
///         spends, never past the budget, never after expiry or revocation.
contract MockSessions is ISessionBudget {
    struct S {
        address owner;
        address delegate;
        uint256 cap;
        uint256 spent;
        uint64 expiry;
        bool revoked;
    }

    mapping(bytes32 => S) public s;

    error Budget();
    error Dead();
    error NotDelegate();

    function open(bytes32 id, address owner, address delegate, uint256 cap, uint64 expiry) external {
        s[id] = S(owner, delegate, cap, 0, expiry, false);
    }

    function revoke(bytes32 id) external {
        s[id].revoked = true;
    }

    function ownerOf(bytes32 id) external view returns (address) {
        return s[id].owner;
    }

    function spend(bytes32 id, uint256 amount) external returns (uint256) {
        S storage x = s[id];
        if (msg.sender != x.delegate) revert NotDelegate();
        if (x.revoked || block.timestamp > x.expiry) revert Dead();
        if (amount > x.cap - x.spent) revert Budget();
        x.spent += amount;
        return x.cap - x.spent;
    }
}

contract Access0x1SessionBudgetHookTest is HookTestBase {
    uint160 internal constant FLAGS = 0x80; // beforeSwap
    bytes32 internal constant SESSION = keccak256("session");
    uint256 internal constant BUDGET = 3e15;

    MockSessions internal sessions;
    Access0x1SessionBudgetHook internal hook;
    Access0x1SwapRouter internal router;
    PoolKey internal key;

    address internal owner = makeAddr("session owner");
    address internal thief = makeAddr("thief");

    function setUp() public {
        _deployV4();
        sessions = new MockSessions();
        address where = _flagAddress(FLAGS);
        _place(abi.encodePacked(type(Access0x1SessionBudgetHook).creationCode, abi.encode(manager, sessions)), where);
        hook = Access0x1SessionBudgetHook(where);
        key = _initPool(IHooks(where));
        _addLiquidity(key);
        router = new Access0x1SwapRouter(manager);

        sessions.open(SESSION, owner, address(hook), BUDGET, uint64(block.timestamp + 1 days));
        vm.prank(owner);
        hook.setRouterTrust(address(router), true);
        _fund(owner);
        _fund(thief);
    }

    function test_Address_MatchesDeclaredPermissions() public view {
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, FLAGS, "address bits");
        assertEq(_maskOf(hook.getHookPermissions()), FLAGS, "declared permissions");
    }

    function test_SwapsAreChargedUntilTheBudgetIsGone() public {
        _swap(owner, 2e15);
        _swap(owner, 1e15);
        (,,, uint256 spent,,) = sessions.s(SESSION);
        assertEq(spent, BUDGET, "not every swap was charged");

        vm.prank(owner);
        vm.expectRevert(); // MockSessions.Budget, wrapped by the PoolManager
        router.swapExactIn(key, true, 1, 0, owner, abi.encode(SESSION), block.timestamp);
    }

    function test_RevertWhen_SessionExpired_OrRevoked() public {
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(owner);
        vm.expectRevert();
        router.swapExactIn(key, true, 1e15, 0, owner, abi.encode(SESSION), block.timestamp);

        vm.warp(block.timestamp - 2);
        sessions.revoke(SESSION);
        vm.prank(owner);
        vm.expectRevert();
        router.swapExactIn(key, true, 1e15, 0, owner, abi.encode(SESSION), block.timestamp);
    }

    function test_RevertWhen_SomeoneElseUsesTheSession() public {
        vm.prank(thief);
        vm.expectRevert();
        router.swapExactIn(key, true, 1e15, 0, thief, abi.encode(SESSION), block.timestamp);
        (,,, uint256 spent,,) = sessions.s(SESSION);
        assertEq(spent, 0, "a stranger spent the owner's budget");
    }

    /// @dev The owner's own swap through a router the owner does NOT trust is not charged as theirs.
    function test_RevertWhen_RouterIsNotTrustedByTheOwner() public {
        vm.prank(owner);
        hook.setRouterTrust(address(router), false);
        vm.prank(owner);
        vm.expectRevert();
        router.swapExactIn(key, true, 1e15, 0, owner, abi.encode(SESSION), block.timestamp);
    }

    function test_SwapWithoutSession_IsUntouched() public {
        assertGt(_swapPlain(thief, 1e15), 0);
    }

    function test_RevertWhen_SessionDataIsMalformed_OrExactOutput() public {
        vm.expectRevert();
        swapRouter.swap(key, _params(-1e15), _settings(), abi.encodePacked(SESSION, uint8(1)));
        vm.expectRevert();
        swapRouter.swap(key, _params(1e15), _settings(), abi.encode(SESSION));
    }

    /// @dev Whatever the split, the session never pays out more than its budget.
    function testFuzz_NeverSpendsPastTheBudget(uint64 a, uint64 b) public {
        uint256 x = bound(a, 1, BUDGET);
        uint256 y = bound(b, 1, BUDGET);
        _swap(owner, x);
        if (x + y > BUDGET) {
            vm.prank(owner);
            vm.expectRevert();
            router.swapExactIn(key, true, y, 0, owner, abi.encode(SESSION), block.timestamp);
        } else {
            _swap(owner, y);
        }
        (,,, uint256 spent,,) = sessions.s(SESSION);
        assertLe(spent, BUDGET);
    }

    function _fund(address who) internal {
        IERC20(Currency.unwrap(currency0)).transfer(who, 1e18);
        vm.prank(who);
        IERC20(Currency.unwrap(currency0)).approve(address(router), type(uint256).max);
    }

    function _swap(address who, uint256 amountIn) internal {
        vm.prank(who);
        router.swapExactIn(key, true, amountIn, 0, who, abi.encode(SESSION), block.timestamp);
    }

    function _swapPlain(address who, uint256 amountIn) internal returns (uint256 out) {
        vm.prank(who);
        out = router.swapExactIn(key, true, amountIn, 0, who, "", block.timestamp);
    }

    function _params(int256 amount) internal pure returns (SwapParams memory) {
        return SwapParams({zeroForOne: true, amountSpecified: amount, sqrtPriceLimitX96: MIN_PRICE_LIMIT});
    }

    function _settings() internal pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }
}
