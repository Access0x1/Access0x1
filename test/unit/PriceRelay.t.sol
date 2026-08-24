// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

import { PriceRelaySender } from "../../src/PriceRelaySender.sol";
import { PriceRelayReceiver } from "../../src/PriceRelayReceiver.sol";
import { ICcipReceiver } from "../../src/interfaces/ICcipReceiver.sol";
import { ICcipRouterClient } from "../../src/interfaces/ICcipRouterClient.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { OracleLib } from "../../src/libraries/OracleLib.sol";
import { MockV3Aggregator } from "../mocks/MockV3Aggregator.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";

/// @notice A stand-in for BOTH ends of a CCIP lane in one contract: it quotes a fee and accepts a
///         `ccipSend` like a source Router, and it can hand a message to a destination receiver like a
///         destination Router. Collapsing the two into one address is a test convenience — the real
///         deployment has a different Router on each chain — and it costs nothing here, because every
///         guard under test keys off the (selector, sender) PAIR rather than the Router's identity.
contract MockCcipMesh {
    uint256 public fee = 0.01 ether;
    bytes32 public nextId = bytes32(uint256(1));

    uint64 public lastSelector;
    uint256 public lastValue;
    bytes public lastData;
    bytes public lastReceiver;
    address public lastFeeToken;
    bytes public lastExtraArgs;
    uint256 public lastTokenCount;

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

    /// @dev Records everything the sender built, so the tests can assert on the exact wire shape —
    ///      most importantly that `tokenAmounts` is EMPTY, which is what makes this a data-only message.
    function ccipSend(uint64 selector, ICcipRouterClient.EVM2AnyMessage calldata message)
        external
        payable
        returns (bytes32)
    {
        lastSelector = selector;
        lastValue = msg.value;
        lastData = message.data;
        lastReceiver = message.receiver;
        lastFeeToken = message.feeToken;
        lastExtraArgs = message.extraArgs;
        lastTokenCount = message.tokenAmounts.length;

        bytes32 id = nextId;
        nextId = bytes32(uint256(id) + 1);
        return id;
    }

    /// @dev The destination-Router half: deliver a message to a receiver as the Router would.
    function deliver(
        address receiver,
        bytes32 messageId,
        uint64 srcSelector,
        address sender,
        bytes memory data
    ) external {
        ICcipReceiver(receiver)
            .ccipReceive(
                ICcipReceiver.Any2EVMMessage({
                messageId: messageId,
                sourceChainSelector: srcSelector,
                sender: abi.encode(sender),
                data: data,
                destTokenAmounts: new ICcipReceiver.EVMTokenAmount[](0)
            })
            );
    }
}

/// @notice A minimal mintable LINK stand-in for the LINK-fee branch.
contract MockLink {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice Unit suite for the Chainlink-backed price relay: {PriceRelaySender} on a chain that HAS a
///         real Chainlink feed, {PriceRelayReceiver} on a chain that has none.
///
///         The suite is arranged as the trust argument itself. SENDER proves a stale or invalid source
///         never becomes a message, and that the message on the wire is data-only. RECEIVER attacks
///         each of the four guards in turn — lane, scale, monotonicity, age/band — plus the replay
///         guard and the cross-chain clock-skew clamp. END-TO-END walks a price from the source
///         aggregator through the lane into the real {Access0x1Router}'s `quote()`, then cuts the relay
///         and proves the router REFUSES rather than settling against the last relayed price.
contract PriceRelayTest is Test, ProxyDeployer {
    MockCcipMesh internal mesh;
    MockV3Aggregator internal sourceFeed;
    MockLink internal link;
    PriceRelaySender internal sender;
    PriceRelayReceiver internal receiver;

    address internal owner = makeAddr("relayOwner");
    address internal stranger = makeAddr("stranger");
    address internal caller = makeAddr("caller");

    /// @dev Ethereum Sepolia's CCIP chain selector, as published in Chainlink's directory. Used as a
    ///      realistic value; nothing in the code hardcodes it.
    uint64 internal constant SRC_SELECTOR = 16_015_286_601_757_825_753;

    /// @dev Arc Network Testnet's CCIP chain selector, as published in Chainlink's directory
    ///      (confirmed 2026-08-23). Again a value, never a hardcode in `src/`.
    uint64 internal constant DEST_SELECTOR = 3_034_092_155_422_581_607;

    uint8 internal constant DECIMALS = 8;
    int256 internal constant PEG = 1e8;
    uint256 internal constant BAND_MIN = 0.95e8;
    uint256 internal constant BAND_MAX = 1.05e8;

    /// @dev Chainlink's USDC/USD feeds run a slow heartbeat with a deviation trigger, so the relay's
    ///      admission window is a day rather than an hour.
    uint256 internal constant MAX_SOURCE_AGE = 86_400;

    uint256 internal constant T0 = 1_700_000_000;

    string internal constant DESCRIPTION =
        "USDC/USD (relayed from Ethereum Sepolia Chainlink via CCIP)";

    function setUp() public {
        vm.warp(T0);
        mesh = new MockCcipMesh();
        link = new MockLink();
        sourceFeed = new MockV3Aggregator(DECIMALS, PEG);

        sender = new PriceRelaySender(
            address(mesh), address(sourceFeed), address(link), MAX_SOURCE_AGE, owner
        );
        receiver = new PriceRelayReceiver(
            address(mesh), DESCRIPTION, DECIMALS, BAND_MIN, BAND_MAX, MAX_SOURCE_AGE, owner
        );

        vm.prank(owner);
        sender.setDestination(DEST_SELECTOR, address(receiver));
        vm.prank(owner);
        receiver.setSourceLane(SRC_SELECTOR, address(sender));

        vm.deal(caller, 100 ether);
    }

    /*//////////////////////////////////////////////////////////////
                                 SENDER
    //////////////////////////////////////////////////////////////*/

    function test_senderReadsTheSourceFeedThroughTheStalenessGuard() public view {
        (int256 answer, uint256 updatedAt, uint8 decimals) = sender.readSource();
        assertEq(answer, PEG, "answer");
        assertEq(updatedAt, T0, "source updatedAt");
        assertEq(decimals, DECIMALS, "decimals");
    }

    /// @dev A stale source answer never becomes a message. Relaying it would LAUNDER its age — it
    ///      would arrive on the destination looking freshly delivered — so it is refused at the source
    ///      before a CCIP fee is spent.
    function test_senderRefusesToRelayAStaleSourceAnswer() public {
        vm.warp(T0 + MAX_SOURCE_AGE + 1);

        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        sender.readSource();

        vm.prank(caller);
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        sender.relay{ value: 1 ether }(DEST_SELECTOR, false);
    }

    function test_senderRefusesANonPositiveSourceAnswer() public {
        sourceFeed.updateAnswer(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceRelaySender.PriceRelaySender__InvalidSourceAnswer.selector, int256(0)
            )
        );
        sender.readSource();
    }

    function test_senderRefusesACarriedOverSourceRound() public {
        // answeredInRound < roundId is Chainlink's "this answer was carried from an earlier round"
        // signal; OracleLib rejects it and so, therefore, does the relay.
        sourceFeed.setRoundData(5, PEG, T0, T0, 4);
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        sender.readSource();
    }

    function test_senderRefusesAnUnsetDestination() public {
        uint64 unknown = 999;
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceRelaySender.PriceRelaySender__DestinationNotSet.selector, unknown
            )
        );
        sender.quoteFee(unknown, address(0));
    }

    /// @dev THE WIRE SHAPE. `tokenAmounts.length == 0` is what makes this CCIP's "Data" message mode
    ///      rather than "Data and Tokens" — which matters because the Arc lane carries zero registered
    ///      token pools, so a token-bearing message would have nowhere to go.
    function test_senderBuildsADataOnlyMessage() public {
        vm.prank(caller);
        sender.relay{ value: 1 ether }(DEST_SELECTOR, false);

        assertEq(mesh.lastTokenCount(), 0, "the message must carry NO tokens");
        assertEq(mesh.lastSelector(), DEST_SELECTOR, "destination selector");
        assertEq(mesh.lastFeeToken(), address(0), "native fee");
        assertEq(abi.decode(mesh.lastReceiver(), (address)), address(receiver), "encoded receiver");

        (int256 answer, uint256 updatedAt, uint8 decimals) =
            abi.decode(mesh.lastData(), (int256, uint256, uint8));
        assertEq(answer, PEG, "payload answer");
        assertEq(updatedAt, T0, "payload source timestamp");
        assertEq(decimals, DECIMALS, "payload scale");
    }

    /// @dev The extra-args tag is DERIVED from Chainlink's documented source string rather than pasted,
    ///      so this asserts the derivation still lands on the published constant.
    function test_extraArgsCarryChainlinksV1TagAndTheGasLimit() public {
        vm.prank(caller);
        sender.relay{ value: 1 ether }(DEST_SELECTOR, false);

        bytes memory extraArgs = mesh.lastExtraArgs();
        bytes4 tag;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            tag := mload(add(extraArgs, 32))
        }
        assertEq(tag, bytes4(0x97a657c9), "EVM_EXTRA_ARGS_V1_TAG");
        assertEq(extraArgs.length, 36, "tag + one uint256 gas limit");
    }

    /// @dev Chainlink's Router keeps native overpayment WITHOUT refunding it, so the sender forwards
    ///      exactly the quote and returns the change itself. Zero custody: nothing is left behind.
    function test_senderForwardsExactlyTheQuoteAndReturnsTheChange() public {
        mesh.setFee(0.02 ether);
        uint256 before = caller.balance;

        vm.prank(caller);
        sender.relay{ value: 1 ether }(DEST_SELECTOR, false);

        assertEq(mesh.lastValue(), 0.02 ether, "router must receive exactly the quote");
        assertEq(caller.balance, before - 0.02 ether, "caller must be charged only the fee");
        assertEq(address(sender).balance, 0, "sender must hold nothing");
    }

    function test_senderRevertsWhenTheNativeFeeIsShort() public {
        mesh.setFee(0.05 ether);
        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceRelaySender.PriceRelaySender__InsufficientNativeFee.selector,
                0.05 ether,
                0.01 ether
            )
        );
        sender.relay{ value: 0.01 ether }(DEST_SELECTOR, false);
    }

    function test_senderPaysTheFeeInLink() public {
        link.mint(caller, 10 ether);
        vm.startPrank(caller);
        link.approve(address(sender), type(uint256).max);
        sender.relay(DEST_SELECTOR, true);
        vm.stopPrank();

        assertEq(mesh.lastFeeToken(), address(link), "fee token must be LINK");
        assertEq(link.balanceOf(caller), 10 ether - 0.01 ether, "LINK fee not pulled");
    }

    /// @dev Stray native alongside a LINK fee would strand in the contract, so it is refused outright.
    function test_senderRejectsNativeValueAlongsideALinkFee() public {
        link.mint(caller, 10 ether);
        vm.startPrank(caller);
        link.approve(address(sender), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceRelaySender.PriceRelaySender__InsufficientNativeFee.selector, 0, 1 ether
            )
        );
        sender.relay{ value: 1 ether }(DEST_SELECTOR, true);
        vm.stopPrank();
    }

    /// @dev Permissionless BY DESIGN: the value comes from an immutable aggregator read inside the
    ///      call, so an arbitrary caller chooses the moment of a refresh and never the number. That is
    ///      what stops a stalled keeper from holding the destination hostage.
    function test_relayIsPermissionlessButTheCallerCannotChooseThePrice() public {
        address randomPerson = makeAddr("randomPerson");
        vm.deal(randomPerson, 1 ether);

        vm.prank(randomPerson);
        sender.relay{ value: 0.5 ether }(DEST_SELECTOR, false);

        (int256 answer,,) = abi.decode(mesh.lastData(), (int256, uint256, uint8));
        assertEq(answer, PEG, "the relayed answer is the feed's, not the caller's");
    }

    function test_strangerCannotSetTheDestination() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        sender.setDestination(DEST_SELECTOR, stranger);
    }

    function test_senderConstructorRejectsZeroAddressesAndZeroWindow() public {
        vm.expectRevert(PriceRelaySender.PriceRelaySender__ZeroAddress.selector);
        new PriceRelaySender(address(0), address(sourceFeed), address(link), MAX_SOURCE_AGE, owner);

        vm.expectRevert(PriceRelaySender.PriceRelaySender__ZeroAddress.selector);
        new PriceRelaySender(address(mesh), address(0), address(link), MAX_SOURCE_AGE, owner);

        vm.expectRevert(PriceRelaySender.PriceRelaySender__ZeroDuration.selector);
        new PriceRelaySender(address(mesh), address(sourceFeed), address(link), 0, owner);
    }

    /*//////////////////////////////////////////////////////////////
                          RECEIVER — GUARD 1: LANE
    //////////////////////////////////////////////////////////////*/

    /// @dev The one check that must never be relaxed: anything other than the real CCIP Router calling
    ///      {ccipReceive} would be an unauthenticated write to the settlement price.
    function test_receiverRejectsACallerThatIsNotTheCcipRouter() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceRelayReceiver.PriceRelayReceiver__NotCcipRouter.selector, stranger
            )
        );
        receiver.ccipReceive(
            ICcipReceiver.Any2EVMMessage({
                messageId: bytes32(uint256(1)),
                sourceChainSelector: SRC_SELECTOR,
                sender: abi.encode(address(sender)),
                data: _payload(PEG, T0, DECIMALS),
                destTokenAmounts: new ICcipReceiver.EVMTokenAmount[](0)
            })
        );
    }

    function test_receiverRejectsAClosedLane() public {
        uint64 closed = 42;
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceRelayReceiver.PriceRelayReceiver__LaneNotAllowed.selector,
                closed,
                address(sender)
            )
        );
        mesh.deliver(
            address(receiver),
            bytes32(uint256(1)),
            closed,
            address(sender),
            _payload(PEG, T0, DECIMALS)
        );
    }

    /// @dev CREATE2/CREATE3 make the same address across chains ordinary, so the lane is keyed by the
    ///      (selector, sender) PAIR. An allowlisted address arriving on the wrong selector is refused,
    ///      and so is a wrong address on the right selector.
    function test_receiverRejectsAnUnallowlistedSenderOnAnOpenLane() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceRelayReceiver.PriceRelayReceiver__LaneNotAllowed.selector,
                SRC_SELECTOR,
                stranger
            )
        );
        mesh.deliver(
            address(receiver),
            bytes32(uint256(1)),
            SRC_SELECTOR,
            stranger,
            _payload(PEG, T0, DECIMALS)
        );
    }

    function test_closingALaneStopsFurtherDeliveries() public {
        _deliver(PEG, T0, 1);

        vm.prank(owner);
        receiver.setSourceLane(SRC_SELECTOR, address(0));

        vm.expectRevert(
            abi.encodeWithSelector(
                PriceRelayReceiver.PriceRelayReceiver__LaneNotAllowed.selector,
                SRC_SELECTOR,
                address(sender)
            )
        );
        _deliver(PEG, T0 + 10, 2);
    }

    function test_strangerCannotOpenALane() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        receiver.setSourceLane(SRC_SELECTOR, stranger);
    }

    /*//////////////////////////////////////////////////////////////
                        RECEIVER — GUARDS 2, 3, 4
    //////////////////////////////////////////////////////////////*/

    /// @dev The router divides by `10 ** feed.decimals()`, so an unnoticed scale change is a silent
    ///      100x mispricing rather than a visible failure. The scale is pinned and enforced.
    function test_receiverRejectsAScaleMismatch() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceRelayReceiver.PriceRelayReceiver__DecimalsMismatch.selector, DECIMALS, 18
            )
        );
        _deliver(PEG, T0, 18, 1);
    }

    /// @dev A reordered or re-delivered report can never walk the price backwards to an older
    ///      observation.
    function test_receiverRejectsAnOlderOrEqualObservation() public {
        _deliver(PEG, T0, 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                PriceRelayReceiver.PriceRelayReceiver__NotNewer.selector, T0, T0 - 100
            )
        );
        _deliver(0.99e8, T0 - 100, 2);

        vm.expectRevert(
            abi.encodeWithSelector(PriceRelayReceiver.PriceRelayReceiver__NotNewer.selector, T0, T0)
        );
        _deliver(0.99e8, T0, 3);
    }

    function test_receiverRejectsADuplicateMessageId() public {
        _deliver(PEG, T0, 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceRelayReceiver.PriceRelayReceiver__AlreadyProcessed.selector,
                bytes32(uint256(1))
            )
        );
        _deliver(1.01e8, T0 + 100, 1);
    }

    /// @dev A report that spent too long in flight never becomes the live price. Admission is separate
    ///      from the router's staleness window: this governs what may enter, that governs how long an
    ///      accepted observation stays usable.
    function test_receiverRejectsAnObservationAlreadyTooOldOnArrival() public {
        vm.warp(T0 + MAX_SOURCE_AGE + 100);
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceRelayReceiver.PriceRelayReceiver__SourceTooOld.selector,
                MAX_SOURCE_AGE + 100,
                MAX_SOURCE_AGE
            )
        );
        _deliver(PEG, T0, 1);
    }

    function test_receiverRejectsAnAnswerOutsideTheBand() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceRelayReceiver.PriceRelayReceiver__AnswerOutOfBand.selector,
                int256(500e8),
                BAND_MIN,
                BAND_MAX
            )
        );
        _deliver(500e8, T0, 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                PriceRelayReceiver.PriceRelayReceiver__AnswerOutOfBand.selector,
                int256(0),
                BAND_MIN,
                BAND_MAX
            )
        );
        _deliver(0, T0, 2);
    }

    /// @dev A refused delivery must leave the previous good answer exactly as it was — a bad report
    ///      degrades nothing, it just lets the existing one keep aging toward the router's cliff.
    function test_aRefusedDeliveryLeavesThePreviousAnswerIntact() public {
        _deliver(PEG, T0, 1);

        vm.expectRevert();
        _deliver(500e8, T0 + 50, 2);

        (uint80 roundId, int256 answer,, uint256 updatedAt,) = receiver.latestRoundData();
        assertEq(roundId, 1, "round must not advance");
        assertEq(answer, PEG, "answer must be untouched");
        assertEq(updatedAt, T0, "timestamp must be untouched");
    }

    /*//////////////////////////////////////////////////////////////
                        RECEIVER — FEED SURFACE
    //////////////////////////////////////////////////////////////*/

    function test_receiverStartsWithNoPriceAndSaysSo() public {
        assertEq(receiver.latestRound(), 0, "no rounds yet");
        vm.expectRevert(PriceRelayReceiver.PriceRelayReceiver__NoPriceYet.selector);
        receiver.latestRoundData();
    }

    function test_receiverReportsTheSourceTimestampNotTheArrivalTime() public {
        // The report is two hours old on arrival — well inside the day-long admission window, but the
        // feed must present it as two hours old, never as fresh.
        uint256 sourceTime = T0;
        vm.warp(T0 + 7200);
        _deliver(PEG, sourceTime, 1);

        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredIn) =
            receiver.latestRoundData();
        assertEq(roundId, 1, "roundId");
        assertEq(answer, PEG, "answer");
        assertEq(updatedAt, sourceTime, "must report the SOURCE time");
        assertEq(startedAt, sourceTime, "startedAt");
        assertEq(answeredIn, 1, "answeredInRound must equal roundId");
        assertEq(receiver.sourceUpdatedAt(), sourceTime, "unclamped source time");
        assertEq(receiver.latestArrivedAt(), T0 + 7200, "arrival time");
    }

    /// @dev CROSS-CHAIN CLOCK SKEW. A source chain running ahead of this one would otherwise produce
    ///      `block.timestamp - updatedAt` underflow inside OracleLib. The clamp is downward-only, so it
    ///      can make a price look older and never fresher.
    function test_aSourceClockAheadOfThisChainIsClampedRatherThanUnderflowing() public {
        uint256 futureSourceTime = T0 + 120;
        _deliver(PEG, futureSourceTime, 1);

        (,,, uint256 updatedAt,) = receiver.latestRoundData();
        assertEq(updatedAt, T0, "must clamp down to the arrival time");
        assertEq(receiver.sourceUpdatedAt(), futureSourceTime, "the raw value stays auditable");

        // The clamp is exactly what keeps the guard's subtraction safe.
        AggregatorV3Interface(address(receiver)).latestRoundData();
        assertEq(_staleCheck(), PEG, "OracleLib must read it without underflowing");
    }

    function test_receiverDescribesItselfAsARelay() public view {
        assertEq(receiver.decimals(), DECIMALS, "decimals");
        assertEq(receiver.description(), DESCRIPTION, "description must name the provenance");
        assertEq(receiver.version(), 0, "version must not impersonate a Chainlink aggregator");
        (uint256 min, uint256 max) = receiver.answerBand();
        assertEq(min, BAND_MIN, "band floor");
        assertEq(max, BAND_MAX, "band ceiling");
    }

    function test_receiverKeepsRoundHistory() public {
        _deliver(PEG, T0, 1);
        vm.warp(T0 + 300);
        _deliver(1.01e8, T0 + 300, 2);

        (, int256 a1,, uint256 u1,) = receiver.getRoundData(1);
        assertEq(a1, PEG, "round 1 answer");
        assertEq(u1, T0, "round 1 timestamp");

        (, int256 a2,, uint256 u2,) = receiver.getRoundData(2);
        assertEq(a2, 1.01e8, "round 2 answer");
        assertEq(u2, T0 + 300, "round 2 timestamp");

        vm.expectRevert(
            abi.encodeWithSelector(
                PriceRelayReceiver.PriceRelayReceiver__NoRound.selector, uint80(9)
            )
        );
        receiver.getRoundData(9);
    }

    function test_receiverAdvertisesItsInterfaces() public view {
        assertTrue(receiver.supportsInterface(type(ICcipReceiver).interfaceId), "ICcipReceiver");
        assertTrue(
            receiver.supportsInterface(type(AggregatorV3Interface).interfaceId), "aggregator"
        );
        assertTrue(receiver.supportsInterface(type(IERC165).interfaceId), "IERC165");
        assertFalse(receiver.supportsInterface(bytes4(0xdeadbeef)), "unknown interface");
    }

    function test_receiverConstructorRejectsBadConfiguration() public {
        vm.expectRevert(PriceRelayReceiver.PriceRelayReceiver__ZeroAddress.selector);
        new PriceRelayReceiver(
            address(0), DESCRIPTION, DECIMALS, BAND_MIN, BAND_MAX, MAX_SOURCE_AGE, owner
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                PriceRelayReceiver.PriceRelayReceiver__InvalidBand.selector, 0, BAND_MAX
            )
        );
        new PriceRelayReceiver(
            address(mesh), DESCRIPTION, DECIMALS, 0, BAND_MAX, MAX_SOURCE_AGE, owner
        );

        vm.expectRevert(PriceRelayReceiver.PriceRelayReceiver__ZeroDuration.selector);
        new PriceRelayReceiver(address(mesh), DESCRIPTION, DECIMALS, BAND_MIN, BAND_MAX, 0, owner);
    }

    /*//////////////////////////////////////////////////////////////
                    END TO END — SOURCE FEED TO ROUTER QUOTE
    //////////////////////////////////////////////////////////////*/

    /// @dev The whole claim in one test. A real Chainlink aggregator's answer travels sender → lane →
    ///      receiver, and the UNMODIFIED {Access0x1Router} prices a payment against it through the
    ///      ordinary `setPriceFeed` wiring — no new router branch, no new import, no second pricing
    ///      path. Then the relay stops, and the router REFUSES rather than settling against the last
    ///      relayed price.
    function test_endToEnd_relayedChainlinkPriceDrivesTheRouterThenFailsClosed() public {
        address routerOwner = makeAddr("routerOwner");
        address treasury = makeAddr("treasury");

        address impl = address(new Access0x1Router());
        Access0x1Router router = Access0x1Router(
            deployProxy(
                impl, abi.encodeCall(Access0x1Router.initialize, (routerOwner, treasury, 100))
            )
        );
        MockUSDC usdc = new MockUSDC();

        // The receiver IS an AggregatorV3Interface, so wiring it needs the existing owner call only.
        vm.startPrank(routerOwner);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(receiver));
        vm.stopPrank();

        // Push the current source price across the lane, exactly as the keeper would.
        vm.prank(caller);
        sender.relay{ value: 1 ether }(DEST_SELECTOR, false);
        (int256 relayedAnswer, uint256 relayedAt, uint8 relayedDecimals) =
            abi.decode(mesh.lastData(), (int256, uint256, uint8));
        mesh.deliver(
            address(receiver),
            bytes32(uint256(77)),
            SRC_SELECTOR,
            address(sender),
            abi.encode(relayedAnswer, relayedAt, relayedDecimals)
        );

        // $29.00 at a $1.00 relayed peg against 6-decimal USDC.
        assertEq(router.quote(0, address(usdc), 29e8), 29_000_000, "quote off the relayed price");

        // THE RELAY STOPS. The router's default window for this token is OracleLib.TIMEOUT.
        vm.warp(T0 + OracleLib.TIMEOUT + 1);
        vm.expectRevert(OracleLib.OracleLib__StalePrice.selector);
        router.quote(0, address(usdc), 29e8);

        // THE RELAY RESUMES. One delivery restores pricing with no router-side action.
        sourceFeed.updateAnswer(PEG);
        vm.prank(caller);
        sender.relay{ value: 1 ether }(DEST_SELECTOR, false);
        (int256 a2, uint256 u2, uint8 d2) = abi.decode(mesh.lastData(), (int256, uint256, uint8));
        mesh.deliver(
            address(receiver),
            bytes32(uint256(78)),
            SRC_SELECTOR,
            address(sender),
            abi.encode(a2, u2, d2)
        );
        assertEq(router.quote(0, address(usdc), 29e8), 29_000_000, "quote after the relay resumes");
    }

    /// @dev A source price MOVE propagates all the way to the quote, proving the relay carries the
    ///      live number rather than a constant baked in anywhere.
    function test_endToEnd_aSourcePriceMoveChangesTheQuote() public {
        address routerOwner = makeAddr("routerOwner");
        address impl = address(new Access0x1Router());
        Access0x1Router router = Access0x1Router(
            deployProxy(
                impl,
                abi.encodeCall(Access0x1Router.initialize, (routerOwner, makeAddr("treasury"), 100))
            )
        );
        MockUSDC usdc = new MockUSDC();
        vm.startPrank(routerOwner);
        router.setTokenAllowed(address(usdc), true);
        router.setPriceFeed(address(usdc), address(receiver));
        vm.stopPrank();

        _deliver(PEG, T0, 1);
        assertEq(router.quote(0, address(usdc), 100e8), 100_000_000, "at $1.00");

        // USDC drifts to $0.98: the same $100 now needs MORE USDC.
        vm.warp(T0 + 60);
        _deliver(0.98e8, T0 + 60, 2);
        assertEq(router.quote(0, address(usdc), 100e8), 102_040_817, "at $0.98, rounded up");
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev The exact payload layout {PriceRelaySender} writes and {PriceRelayReceiver} decodes.
    function _payload(int256 answer, uint256 updatedAt, uint8 decimals)
        private
        pure
        returns (bytes memory)
    {
        return abi.encode(answer, updatedAt, decimals);
    }

    /// @dev Deliver a well-formed report over the open lane.
    function _deliver(int256 answer, uint256 updatedAt, uint256 messageId) private {
        _deliver(answer, updatedAt, DECIMALS, messageId);
    }

    /// @dev Deliver a report at an arbitrary scale, for the scale-mismatch case.
    function _deliver(int256 answer, uint256 updatedAt, uint8 decimals, uint256 messageId) private {
        mesh.deliver(
            address(receiver),
            bytes32(messageId),
            SRC_SELECTOR,
            address(sender),
            _payload(answer, updatedAt, decimals)
        );
    }

    /// @dev Read the receiver the way the router does, so the guard's arithmetic is genuinely exercised
    ///      rather than asserted about.
    function _staleCheck() private view returns (int256 answer) {
        (, answer,,,) = OracleLib.staleCheckLatestRoundData(
            AggregatorV3Interface(address(receiver)), OracleLib.TIMEOUT
        );
    }
}
