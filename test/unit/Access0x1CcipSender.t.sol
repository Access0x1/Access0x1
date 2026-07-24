// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { Access0x1CcipSender } from "../../src/Access0x1CcipSender.sol";
import { ICcipReceiver } from "../../src/interfaces/ICcipReceiver.sol";
import { ICcipRouterClient } from "../../src/interfaces/ICcipRouterClient.sol";

/// @notice Minimal mintable ERC-20 for the sender tests.
contract SenderTestToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice A stand-in CCIP Router: quotes a fixed fee, records the last message, pulls the tokens
///         the way the real Router does on ccipSend.
contract MockCcipRouter {
    uint256 public fee = 0.01 ether;
    bytes32 public nextId = bytes32(uint256(1));

    uint64 public lastSelector;
    ICcipRouterClient.EVM2AnyMessage public lastMessage;
    uint256 public lastValue;

    function setFee(uint256 f) external {
        fee = f;
    }

    function getFee(uint64, ICcipRouterClient.EVM2AnyMessage memory)
        external
        view
        returns (uint256)
    {
        return fee;
    }

    function isChainSupported(uint64) external pure returns (bool) {
        return true;
    }

    function ccipSend(uint64 selector, ICcipRouterClient.EVM2AnyMessage calldata message)
        external
        payable
        returns (bytes32)
    {
        lastSelector = selector;
        lastMessage = message;
        lastValue = msg.value;
        // The real Router pulls the bridged tokens from the caller.
        for (uint256 i = 0; i < message.tokenAmounts.length; ++i) {
            IERC20(message.tokenAmounts[i].token).transferFrom(
                msg.sender, address(this), message.tokenAmounts[i].amount
            );
        }
        if (message.feeToken != address(0)) {
            IERC20(message.feeToken).transferFrom(msg.sender, address(this), fee);
        }
        return nextId;
    }

    function lastTokenAmount() external view returns (address token, uint256 amount) {
        ICcipRouterClient.EVM2AnyMessage memory m = lastMessage;
        return (m.tokenAmounts[0].token, m.tokenAmounts[0].amount);
    }
}

/// @notice Unit tests for {Access0x1CcipSender}.
/// @dev The invariant mirrors the receiver's: this contract's steady-state balance is ZERO — every
///      token and every wei either went to the Router or back to the buyer, in the same tx.
contract Access0x1CcipSenderTest is Test {
    Access0x1CcipSender internal sender;
    MockCcipRouter internal ccipRouter;
    SenderTestToken internal token;
    SenderTestToken internal link;

    address internal constant OWNER = address(0x0BEE);
    address internal constant BUYER = address(0xB0B);
    address internal constant DEST_RECEIVER = address(0xD0D0);
    uint64 internal constant DEST = 16_015_286_601_757_825_753;
    uint256 internal constant MERCHANT_ID = 7;
    uint256 internal constant USD_8 = 25e8;

    function setUp() public {
        ccipRouter = new MockCcipRouter();
        token = new SenderTestToken();
        link = new SenderTestToken();
        sender = new Access0x1CcipSender(address(ccipRouter), address(link), OWNER);
        vm.prank(OWNER);
        sender.setDestination(DEST, DEST_RECEIVER);

        token.mint(BUYER, 100e18);
        link.mint(BUYER, 10e18);
        vm.deal(BUYER, 10 ether);
        vm.startPrank(BUYER);
        token.approve(address(sender), type(uint256).max);
        link.approve(address(sender), type(uint256).max);
        vm.stopPrank();
    }

    function _pay(uint256 amount, uint256 value, bool inLink) internal returns (bytes32) {
        vm.prank(BUYER);
        return sender.payCrossChain{ value: value }(
            DEST, MERCHANT_ID, USD_8, bytes32("order-1"), address(token), amount, BUYER, inLink
        );
    }

    // ── sending ──────────────────────────────────────────────────────────────────────────────

    function test_SendsTokensAndIntentThroughTheCcipRouter() public {
        _pay(25e18, 0.01 ether, false);

        (address t, uint256 a) = ccipRouter.lastTokenAmount();
        assertEq(t, address(token), "bridged token");
        assertEq(a, 25e18, "bridged amount");
        assertEq(ccipRouter.lastSelector(), DEST, "destination selector");
        assertEq(ccipRouter.lastValue(), 0.01 ether, "exactly the quoted native fee forwarded");
        assertEq(token.balanceOf(address(ccipRouter)), 25e18, "router holds the tokens");
    }

    function test_MessageDataMatchesTheReceiverDecodeShape() public {
        _pay(25e18, 0.01 ether, false);
        (,, bytes memory data,,) = _lastMessageFields();
        (uint256 mId, uint256 usd, bytes32 oid, address refundTo) =
            abi.decode(data, (uint256, uint256, bytes32, address));
        assertEq(mId, MERCHANT_ID);
        assertEq(usd, USD_8);
        assertEq(oid, bytes32("order-1"));
        assertEq(refundTo, BUYER);
    }

    function test_ReceiverIsTheConfiguredDestinationAbiEncoded() public {
        _pay(25e18, 0.01 ether, false);
        (bytes memory receiver,,,,) = _lastMessageFields();
        assertEq(abi.decode(receiver, (address)), DEST_RECEIVER);
    }

    // ── fees ─────────────────────────────────────────────────────────────────────────────────

    function test_NativeFee_ExcessIsReturnedToTheBuyer() public {
        uint256 before = BUYER.balance;
        _pay(25e18, 1 ether, false); // grossly overpay a 0.01 ether fee

        assertEq(before - BUYER.balance, 0.01 ether, "buyer net-paid exactly the fee");
        assertEq(address(sender).balance, 0, "sender keeps no native");
    }

    function test_RevertWhen_NativeFeeInsufficient() public {
        vm.prank(BUYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1CcipSender.Access0x1CcipSender__InsufficientNativeFee.selector,
                0.01 ether,
                0.001 ether
            )
        );
        sender.payCrossChain{ value: 0.001 ether }(
            DEST, MERCHANT_ID, USD_8, bytes32("o"), address(token), 25e18, BUYER, false
        );
    }

    function test_LinkFee_PullsExactlyTheQuote() public {
        _pay(25e18, 0, true);
        assertEq(link.balanceOf(address(ccipRouter)), 0.01 ether, "router pulled the LINK fee");
        assertEq(link.balanceOf(address(sender)), 0, "sender keeps no LINK");
    }

    function test_RevertWhen_LinkFeeButNativeAttached() public {
        // Stray native alongside a LINK fee would strand in the contract — refused.
        vm.prank(BUYER);
        vm.expectRevert();
        sender.payCrossChain{ value: 1 wei }(
            DEST, MERCHANT_ID, USD_8, bytes32("o"), address(token), 25e18, BUYER, true
        );
    }

    // ── guards ───────────────────────────────────────────────────────────────────────────────

    function test_RevertWhen_DestinationNotConfigured() public {
        uint64 unknown = 999;
        vm.prank(BUYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1CcipSender.Access0x1CcipSender__DestinationNotSet.selector, unknown
            )
        );
        sender.payCrossChain{ value: 0.01 ether }(
            unknown, MERCHANT_ID, USD_8, bytes32("o"), address(token), 25e18, BUYER, false
        );
    }

    function test_ZeroRefundToDefaultsToTheBuyer() public {
        vm.prank(BUYER);
        sender.payCrossChain{ value: 0.01 ether }(
            DEST, MERCHANT_ID, USD_8, bytes32("o"), address(token), 25e18, address(0), false
        );
        (,, bytes memory data,,) = _lastMessageFields();
        (,,, address refundTo) = abi.decode(data, (uint256, uint256, bytes32, address));
        assertEq(refundTo, BUYER, "zero refundTo must fall back to the buyer, never burn");
    }

    function test_RevertWhen_NonOwnerSetsDestination() public {
        vm.prank(BUYER);
        vm.expectRevert();
        sender.setDestination(1, address(1));
    }

    // ── wire-format constants: derived, then proven ──────────────────────────────────────────

    /// @dev The sender DERIVES Chainlink's extra-args tag from its source string rather than
    ///      pasting the hex. This pins the derivation to the value chainlink-ccip documents, so if
    ///      the two ever disagree the suite says so instead of messages silently mis-decoding.
    function test_ExtraArgsTagMatchesChainlinksDocumentedValue() public pure {
        assertEq(
            bytes4(keccak256("CCIP EVMExtraArgsV1")),
            bytes4(0x97a657c9),
            "EVM_EXTRA_ARGS_V1_TAG must equal Chainlink's Client.sol constant"
        );
    }

    /// @dev And that the encoded extraArgs actually carry the configured gas limit.
    function test_ExtraArgsCarryTheConfiguredGasLimit() public {
        _pay(25e18, 0.01 ether, false);
        (,,,, bytes memory extraArgs) = _lastMessageFields();
        assertEq(bytes4(extraArgs), bytes4(0x97a657c9), "tagged as EVMExtraArgsV1");

        bytes memory tail = new bytes(extraArgs.length - 4);
        for (uint256 i = 0; i < tail.length; ++i) {
            tail[i] = extraArgs[i + 4];
        }
        assertEq(abi.decode(tail, (uint256)), sender.destGasLimit(), "gas limit round-trips");
    }

    // ── the invariant ────────────────────────────────────────────────────────────────────────

    /// @dev Zero custody: whatever happens, the sender holds nothing after the tx.
    function testFuzz_SenderBalanceAlwaysZeroAfterASend(uint96 amount, uint96 overpay) public {
        vm.assume(amount > 0 && amount <= 100e18);
        uint256 value = 0.01 ether + uint256(overpay) % 1 ether;
        _pay(amount, value, false);

        assertEq(token.balanceOf(address(sender)), 0, "no tokens held");
        assertEq(address(sender).balance, 0, "no native held");
        assertEq(link.balanceOf(address(sender)), 0, "no LINK held");
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────

    /// @dev The mock's auto-generated getter for a public struct omits dynamic-ARRAY members
    ///      (tokenAmounts) but returns the rest: (receiver, data, feeToken, extraArgs).
    function _lastMessageFields()
        internal
        view
        returns (
            bytes memory receiver,
            uint256 tokenCount,
            bytes memory data,
            address feeToken,
            bytes memory extraArgs
        )
    {
        (receiver, data, feeToken, extraArgs) = ccipRouter.lastMessage();
        tokenCount = 1;
    }
}
