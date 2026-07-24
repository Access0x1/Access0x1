// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { Access0x1CcipReceiver } from "../../src/Access0x1CcipReceiver.sol";
import { ICcipReceiver } from "../../src/interfaces/ICcipReceiver.sol";

/// @notice A minimal ERC-20 for the receiver tests: mintable, no fee, no hooks.
contract TestToken {
    string public name = "Test";
    string public symbol = "TST";
    uint8 public decimals = 18;
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

/// @notice A stand-in Access0x1 router: quotes a configurable rate and pulls `gross` on payToken.
///         Either leg can be told to revert, so the tests can drive both refusal paths.
contract MockRouter {
    uint256 public rate = 1e18; // token amount per 1e8 USD
    bool public quoteReverts;
    bool public payReverts;
    uint256 public lastGrossPulled;
    address public lastPayer;

    function setRate(uint256 r) external {
        rate = r;
    }

    function setQuoteReverts(bool v) external {
        quoteReverts = v;
    }

    function setPayReverts(bool v) external {
        payReverts = v;
    }

    function quote(uint256, address, uint256 usdAmount8) external view returns (uint256) {
        require(!quoteReverts, "quote");
        return (usdAmount8 * rate) / 1e8;
    }

    function payToken(uint256, address token, uint256 usdAmount8, bytes32) external {
        require(!payReverts, "pay");
        uint256 gross = (usdAmount8 * rate) / 1e8;
        IERC20(token).transferFrom(msg.sender, address(this), gross);
        lastGrossPulled = gross;
        lastPayer = msg.sender;
    }
}

/// @notice Unit tests for {Access0x1CcipReceiver}.
///
/// @dev The load-bearing property is the one stated in the contract: money that arrives is ALWAYS
///      either settled to the merchant or claimable by the refund recipient — never stuck, never
///      silently kept. Each refusal path is asserted to leave the full delivered amount claimable,
///      and the authorization path is asserted to revert rather than credit, because accepting an
///      unverified message would let anyone mint a settlement from nothing.
contract Access0x1CcipReceiverTest is Test {
    Access0x1CcipReceiver internal receiver;
    MockRouter internal router;
    TestToken internal token;

    address internal constant CCIP_ROUTER = address(0xCC19);
    address internal constant OWNER = address(0x0BEE);
    address internal constant SRC_SENDER = address(0x5E4D);
    address internal constant BUYER = address(0xB0B);
    uint64 internal constant SRC_SELECTOR = 16_015_286_601_757_825_753; // an example selector
    uint256 internal constant MERCHANT_ID = 7;
    uint256 internal constant USD_8 = 25e8; // $25.00

    function setUp() public {
        router = new MockRouter();
        token = new TestToken();
        receiver = new Access0x1CcipReceiver(CCIP_ROUTER, address(router), OWNER);
        vm.prank(OWNER);
        receiver.setSourceLane(SRC_SELECTOR, SRC_SENDER);
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────

    function _msg(bytes32 id, uint64 selector, address sender, uint256 delivered, address refundTo)
        internal
        view
        returns (ICcipReceiver.Any2EVMMessage memory m)
    {
        ICcipReceiver.EVMTokenAmount[] memory amts = new ICcipReceiver.EVMTokenAmount[](1);
        amts[0] = ICcipReceiver.EVMTokenAmount({ token: address(token), amount: delivered });
        m = ICcipReceiver.Any2EVMMessage({
            messageId: id,
            sourceChainSelector: selector,
            sender: abi.encode(sender),
            data: abi.encode(MERCHANT_ID, USD_8, bytes32("order-1"), refundTo),
            destTokenAmounts: amts
        });
    }

    /// @dev CCIP delivers the tokens to the receiver before calling it; mirror that.
    function _deliver(ICcipReceiver.Any2EVMMessage memory m) internal {
        token.mint(address(receiver), m.destTokenAmounts[0].amount);
        vm.prank(CCIP_ROUTER);
        receiver.ccipReceive(m);
    }

    // ── authorization: the only path that MUST revert ────────────────────────────────────────

    function test_RevertWhen_CallerIsNotCcipRouter() public {
        ICcipReceiver.Any2EVMMessage memory m = _msg("m1", SRC_SELECTOR, SRC_SENDER, 25e18, BUYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1CcipReceiver.Access0x1CcipReceiver__NotCcipRouter.selector, address(this)
            )
        );
        receiver.ccipReceive(m);
    }

    function test_RevertWhen_LaneIsClosed() public {
        uint64 unknown = 999;
        ICcipReceiver.Any2EVMMessage memory m = _msg("m1", unknown, SRC_SENDER, 25e18, BUYER);
        vm.prank(CCIP_ROUTER);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1CcipReceiver.Access0x1CcipReceiver__LaneNotAllowed.selector,
                unknown,
                SRC_SENDER
            )
        );
        receiver.ccipReceive(m);
    }

    function test_RevertWhen_SenderIsNotTheAllowlistedOne() public {
        address impostor = address(0xBAD);
        ICcipReceiver.Any2EVMMessage memory m = _msg("m1", SRC_SELECTOR, impostor, 25e18, BUYER);
        vm.prank(CCIP_ROUTER);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1CcipReceiver.Access0x1CcipReceiver__LaneNotAllowed.selector,
                SRC_SELECTOR,
                impostor
            )
        );
        receiver.ccipReceive(m);
    }

    /// @dev The reason the lane is keyed by SELECTOR and not by sender alone: CREATE2/CREATE3 make
    ///      the same address across chains normal, so a sender-only check would let any chain
    ///      impersonate any other.
    function test_RevertWhen_RightSenderButWrongChain() public {
        uint64 otherChain = 12_345;
        ICcipReceiver.Any2EVMMessage memory m = _msg("m1", otherChain, SRC_SENDER, 25e18, BUYER);
        vm.prank(CCIP_ROUTER);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1CcipReceiver.Access0x1CcipReceiver__LaneNotAllowed.selector,
                otherChain,
                SRC_SENDER
            )
        );
        receiver.ccipReceive(m);
    }

    function test_RevertWhen_MessageReplayed() public {
        ICcipReceiver.Any2EVMMessage memory m = _msg("dup", SRC_SELECTOR, SRC_SENDER, 25e18, BUYER);
        _deliver(m);
        token.mint(address(receiver), 25e18);
        vm.prank(CCIP_ROUTER);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1CcipReceiver.Access0x1CcipReceiver__AlreadyProcessed.selector,
                bytes32("dup")
            )
        );
        receiver.ccipReceive(m);
    }

    function test_RevertWhen_NotExactlyOneToken() public {
        ICcipReceiver.EVMTokenAmount[] memory none = new ICcipReceiver.EVMTokenAmount[](0);
        ICcipReceiver.Any2EVMMessage memory m = ICcipReceiver.Any2EVMMessage({
            messageId: "m1",
            sourceChainSelector: SRC_SELECTOR,
            sender: abi.encode(SRC_SENDER),
            data: abi.encode(MERCHANT_ID, USD_8, bytes32(0), BUYER),
            destTokenAmounts: none
        });
        vm.prank(CCIP_ROUTER);
        vm.expectRevert(
            abi.encodeWithSelector(
                Access0x1CcipReceiver.Access0x1CcipReceiver__ExpectedOneToken.selector, 0
            )
        );
        receiver.ccipReceive(m);
    }

    // ── the happy path ───────────────────────────────────────────────────────────────────────

    function test_SettlesThroughTheRouterWhenTheAmountIsExact() public {
        _deliver(_msg("m1", SRC_SELECTOR, SRC_SENDER, 25e18, BUYER));

        assertEq(router.lastGrossPulled(), 25e18, "router pulled the quoted gross");
        assertEq(router.lastPayer(), address(receiver), "the receiver is the payer of record");
        assertEq(token.balanceOf(address(receiver)), 0, "no residual held");
        assertEq(receiver.claimable(BUYER, address(token)), 0, "nothing owed on an exact settle");
    }

    function test_SurplusIsCreditedNotKept() public {
        _deliver(_msg("m1", SRC_SELECTOR, SRC_SENDER, 30e18, BUYER));

        assertEq(router.lastGrossPulled(), 25e18, "settled exactly the quote");
        assertEq(receiver.claimable(BUYER, address(token)), 5e18, "surplus is owed to the buyer");
        assertEq(token.balanceOf(address(receiver)), 5e18, "and still held pending the claim");
    }

    // ── refusals: never revert, always claimable ─────────────────────────────────────────────

    function test_ShortAmountIsCreditedInFullAndNotSettled() public {
        _deliver(_msg("m1", SRC_SELECTOR, SRC_SENDER, 20e18, BUYER));

        assertEq(
            router.lastGrossPulled(), 0, "nothing settled — a partial settle would under-pay"
        );
        assertEq(receiver.claimable(BUYER, address(token)), 20e18, "the FULL delivery is claimable");
    }

    function test_RouterRefusalIsCreditedInFull() public {
        router.setPayReverts(true);
        _deliver(_msg("m1", SRC_SELECTOR, SRC_SENDER, 25e18, BUYER));

        assertEq(router.lastGrossPulled(), 0, "no settlement happened");
        assertEq(receiver.claimable(BUYER, address(token)), 25e18, "the FULL delivery is claimable");
        assertEq(
            token.allowance(address(receiver), address(router)), 0, "dangling approval cleared"
        );
    }

    function test_StaleFeedOrBadQuoteIsCreditedInFull() public {
        router.setQuoteReverts(true);
        _deliver(_msg("m1", SRC_SELECTOR, SRC_SENDER, 25e18, BUYER));

        assertEq(receiver.claimable(BUYER, address(token)), 25e18, "the FULL delivery is claimable");
    }

    /// @dev A zero refundTo must not burn the credit; it falls back to the allowlisted sender.
    function test_ZeroRefundToFallsBackToTheSourceSender() public {
        router.setPayReverts(true);
        _deliver(_msg("m1", SRC_SELECTOR, SRC_SENDER, 25e18, address(0)));

        assertEq(receiver.claimable(SRC_SENDER, address(token)), 25e18, "credited to the sender");
        assertEq(
            receiver.claimable(address(0), address(token)), 0, "never credited to the zero address"
        );
    }

    // ── claims ───────────────────────────────────────────────────────────────────────────────

    function test_ClaimPaysTheFullBalanceAndZeroesIt() public {
        router.setPayReverts(true);
        _deliver(_msg("m1", SRC_SELECTOR, SRC_SENDER, 25e18, BUYER));

        vm.prank(BUYER);
        uint256 paid = receiver.claim(address(token));

        assertEq(paid, 25e18, "paid the whole credit");
        assertEq(token.balanceOf(BUYER), 25e18, "buyer holds it");
        assertEq(receiver.claimable(BUYER, address(token)), 0, "credit zeroed");
        assertEq(token.balanceOf(address(receiver)), 0, "receiver holds nothing after");
    }

    function test_RevertWhen_ClaimingNothing() public {
        vm.prank(BUYER);
        vm.expectRevert(Access0x1CcipReceiver.Access0x1CcipReceiver__NothingToClaim.selector);
        receiver.claim(address(token));
    }

    // ── admin ────────────────────────────────────────────────────────────────────────────────

    function test_RevertWhen_NonOwnerSetsALane() public {
        vm.prank(BUYER);
        vm.expectRevert();
        receiver.setSourceLane(1, address(1));
    }

    function test_OwnerCanCloseALane() public {
        vm.prank(OWNER);
        receiver.setSourceLane(SRC_SELECTOR, address(0));

        (bool open,) = receiver.laneStatus(SRC_SELECTOR);
        assertFalse(open, "lane closed");

        ICcipReceiver.Any2EVMMessage memory m = _msg("m1", SRC_SELECTOR, SRC_SENDER, 25e18, BUYER);
        vm.prank(CCIP_ROUTER);
        vm.expectRevert();
        receiver.ccipReceive(m);
    }

    function test_RevertWhen_ConstructedWithZeroAddresses() public {
        vm.expectRevert(Access0x1CcipReceiver.Access0x1CcipReceiver__ZeroAddress.selector);
        new Access0x1CcipReceiver(address(0), address(router), OWNER);
    }

    // ── ERC-165: CCIP probes this BEFORE it will deliver ─────────────────────────────────────

    /// @dev Chainlink's router checks ERC-165 to confirm a destination can receive. A false here
    ///      means deliveries fail for a reason nothing on-chain explains, so it is pinned.
    function test_AdvertisesTheCcipReceiverInterface() public view {
        assertTrue(receiver.supportsInterface(type(ICcipReceiver).interfaceId), "IAny2EVMMessageReceiver");
        assertTrue(receiver.supportsInterface(0x01ffc9a7), "IERC165");
        assertFalse(receiver.supportsInterface(0xffffffff), "the ERC-165 invalid id must be false");
    }

    /// @dev The interface id MUST equal Chainlink's `IAny2EVMMessageReceiver` — which is simply the
    ///      `ccipReceive` selector, since that interface declares exactly one function. If
    ///      {ICcipReceiver} ever gains a second function (or inherits IERC165), the XOR changes and
    ///      CCIP stops recognising this contract. This asserts the equality directly.
    function test_InterfaceIdEqualsTheCcipReceiveSelector() public pure {
        bytes4 expected = bytes4(keccak256("ccipReceive((bytes32,uint64,bytes,bytes,(address,uint256)[]))"));
        assertEq(type(ICcipReceiver).interfaceId, expected, "id must be the ccipReceive selector alone");
    }

    // ── the invariant, stated as a test ──────────────────────────────────────────────────────

    /// @dev Whatever happens, the receiver holds exactly what it owes — never more, never less.
    function testFuzz_HeldBalanceAlwaysEqualsWhatIsOwed(uint96 delivered, bool payReverts) public {
        vm.assume(delivered > 0);
        router.setPayReverts(payReverts);
        _deliver(_msg("m1", SRC_SELECTOR, SRC_SENDER, delivered, BUYER));

        assertEq(
            token.balanceOf(address(receiver)),
            receiver.claimable(BUYER, address(token)),
            "held balance equals the outstanding credit — nothing stuck, nothing kept"
        );
    }
}
