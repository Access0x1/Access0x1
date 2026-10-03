// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {HookTestBase} from "./utils/HookTestBase.sol";
import {Access0x1ReceiptHook, IAccess0x1Merchants} from "../src/Access0x1ReceiptHook.sol";
import {Access0x1SwapRouter} from "../src/Access0x1SwapRouter.sol";

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Stands in for the Access0x1 Router's `merchants` getter.
contract MockMerchants is IAccess0x1Merchants {
    struct M {
        address payout;
        address owner;
        bool active;
    }

    mapping(uint256 => M) internal m;
    bool public broken;

    function set(uint256 id, address payout, address owner, bool active) external {
        m[id] = M(payout, owner, active);
    }

    function breakIt() external {
        broken = true;
    }

    function merchants(uint256 id) external view returns (address, address, address, uint16, bool, bytes32) {
        require(!broken, "registry down");
        M memory x = m[id];
        return (x.payout, x.owner, address(0), 0, x.active, bytes32(0));
    }
}

contract Access0x1ReceiptHookTest is HookTestBase {
    uint160 internal constant FLAGS = 0x40; // afterSwap
    bytes32 internal constant RECEIPT_TOPIC =
        keccak256("SwapReceipt(bytes32,uint256,address,address,bytes32,int256,bool)");

    MockMerchants internal registry;
    Access0x1ReceiptHook internal hook;
    Access0x1SwapRouter internal router;
    PoolKey internal key;

    address internal payout = makeAddr("merchant payout");
    address internal owner = makeAddr("merchant owner");
    address internal stranger = makeAddr("stranger");
    uint256 internal constant MERCHANT = 7;

    function setUp() public {
        _deployV4();
        registry = new MockMerchants();
        registry.set(MERCHANT, payout, owner, true);

        address where = _flagAddress(FLAGS);
        _place(abi.encodePacked(type(Access0x1ReceiptHook).creationCode, abi.encode(manager, registry)), where);
        hook = Access0x1ReceiptHook(where);

        key = _initPool(IHooks(where));
        _addLiquidity(key);
        router = new Access0x1SwapRouter(manager);

        for (uint256 i; i < 2; i++) {
            address who = i == 0 ? payout : stranger;
            IERC20(_c0()).transfer(who, 1e18);
            vm.prank(who);
            IERC20(_c0()).approve(address(router), type(uint256).max);
        }
    }

    function _c0() internal view returns (address) {
        return Currency.unwrap(currency0);
    }

    // ── 1. the address carries exactly what the hook declares ───────────────────────────────

    function test_Address_MatchesDeclaredPermissions() public view {
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, FLAGS, "address bits");
        assertEq(_maskOf(hook.getHookPermissions()), FLAGS, "declared permissions");
    }

    function test_RevertWhen_PlacedAtAnAddressWithAnotherFlag() public {
        (bool ok,) = _tryPlace(
            abi.encodePacked(type(Access0x1ReceiptHook).creationCode, abi.encode(manager, registry)),
            _flagAddress(FLAGS | Hooks.BEFORE_SWAP_FLAG)
        );
        assertFalse(ok, "accepted an address that also says beforeSwap");
    }

    function test_RevertWhen_RegistryIsZero() public {
        (bool ok,) = _tryPlace(
            abi.encodePacked(type(Access0x1ReceiptHook).creationCode, abi.encode(manager, address(0))),
            _flagAddress(FLAGS)
        );
        assertFalse(ok, "accepted a zero registry");
    }

    // ── 2. what makes a receipt verified ────────────────────────────────────────────────────

    function test_MerchantWallet_ThroughATrustedRouter_IsVerified() public {
        vm.prank(owner);
        hook.setRouterTrust(MERCHANT, address(router), true);

        (uint256 id, address swapper, bool verified) = _swapVia(payout, abi.encode(MERCHANT, bytes32("order-1")));
        assertEq(id, MERCHANT);
        assertEq(swapper, payout, "the trusted router's user is the swapper");
        assertTrue(verified, "the merchant's own wallet was not verified");
    }

    function test_MerchantWallet_ThroughAnUntrustedRouter_IsNotVerified() public {
        (, address swapper, bool verified) = _swapVia(payout, abi.encode(MERCHANT, bytes32("order-1")));
        assertEq(swapper, address(router), "an untrusted router's word was taken");
        assertFalse(verified);
    }

    function test_Stranger_ClaimingTheMerchant_IsNotVerified() public {
        vm.prank(owner);
        hook.setRouterTrust(MERCHANT, address(router), true);

        (uint256 id, address swapper, bool verified) = _swapVia(stranger, abi.encode(MERCHANT, bytes32("fake")));
        assertEq(id, MERCHANT, "the claim is still recorded");
        assertEq(swapper, stranger);
        assertFalse(verified, "a stranger's claim was verified");
    }

    function test_InactiveMerchant_IsNotVerified() public {
        vm.prank(owner);
        hook.setRouterTrust(MERCHANT, address(router), true);
        registry.set(MERCHANT, payout, owner, false);

        (,, bool verified) = _swapVia(payout, abi.encode(MERCHANT, bytes32("order-1")));
        assertFalse(verified);
    }

    function test_RegistryDown_SwapStillSettles_Unverified() public {
        vm.prank(owner);
        hook.setRouterTrust(MERCHANT, address(router), true);
        registry.breakIt();

        uint256 before = IERC20(_c0()).balanceOf(payout);
        (,, bool verified) = _swapVia(payout, abi.encode(MERCHANT, bytes32("order-1")));
        assertFalse(verified);
        assertEq(before - IERC20(_c0()).balanceOf(payout), 1e15, "the swap did not settle");
    }

    // ── 3. who may trust a router ───────────────────────────────────────────────────────────

    function test_RevertWhen_TrustIsSetByAnyoneButTheOwner() public {
        vm.prank(payout);
        vm.expectRevert(abi.encodeWithSelector(Access0x1ReceiptHook.NotMerchantOwner.selector, MERCHANT, payout));
        hook.setRouterTrust(MERCHANT, address(router), true);
    }

    function test_RevertWhen_TrustIsSetForAnUnregisteredMerchant() public {
        vm.prank(address(0));
        vm.expectRevert(abi.encodeWithSelector(Access0x1ReceiptHook.NotMerchantOwner.selector, 999, address(0)));
        hook.setRouterTrust(999, address(router), true);
    }

    // ── 4. nothing in hook data can fail a swap ─────────────────────────────────────────────

    /// @dev Any hook data: the swap settles, and only exactly 64 bytes is read as a claim.
    function testFuzz_AnyHookData_NeverFailsTheSwap(bytes calldata data, uint96 amount) public {
        uint256 amountIn = bound(amount, 1, 1e16);
        vm.recordLogs();
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            data
        );
        (uint256 id,, bool verified) = _lastReceipt();
        if (data.length != 64) assertEq(id, 0, "a claim was read from data that is not 64 bytes");
        assertFalse(verified, "the test router's own address is no merchant's wallet");
    }

    // ── helpers ─────────────────────────────────────────────────────────────────────────────

    function _swapVia(address who, bytes memory data) internal returns (uint256, address, bool) {
        vm.recordLogs();
        vm.prank(who);
        router.swapExactIn(key, true, 1e15, 0, who, data, block.timestamp);
        return _lastReceipt();
    }

    function _lastReceipt() internal returns (uint256 id, address swapper, bool verified) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = logs.length; i > 0; i--) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter == address(hook) && l.topics[0] == RECEIPT_TOPIC) {
                assertEq(l.topics[1], PoolId.unwrap(key.toId()), "receipt for another pool");
                (,,, verified) = abi.decode(l.data, (address, bytes32, int256, bool));
                return (uint256(l.topics[2]), address(uint160(uint256(l.topics[3]))), verified);
            }
        }
        revert("no SwapReceipt emitted");
    }
}
