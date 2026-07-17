// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { Receivables } from "../../src/Receivables.sol";
import { IReceivables } from "../../src/interfaces/IReceivables.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @notice The actor that drives the {Receivables} invariant fuzzer through every state-changing path —
///         mint, factor (transfer the NFT to a new creditor), pay (token + native), and cancel — while
///         keeping the ghost accounting the suite checks the contract against.
/// @dev    The handler owns TWO conduit router merchants (their router payout IS the Receivables
///         contract, the conduit invariant) so it can mint + cancel their receivables, and is the sole
///         debtor (so it can always authorize a locked or unlocked pay). The creditor of each receivable
///         is one of three handler-controlled EOAs (so it can factor between them and the net always
///         lands at a known sink). Every action is written to NEVER revert (the suite runs
///         `fail_on_revert = true`): inputs are `bound`ed and preconditions early-return. Fee/creditor
///         sinks are dedicated, disjoint addresses so every unit in them provably came from the router
///         hop — that is what makes the conservation + "settles at most once" checks exact.
contract ReceivablesHandler is Test {
    Access0x1Router public immutable router;
    Receivables public immutable recv;
    MockUSDC public immutable usdc;
    address public immutable treasury;

    /// @notice The two conduit merchants the handler owns.
    uint256 public merchantA;
    uint256 public merchantB;

    /// @notice The fee sinks (one feeRecipient per merchant) + the three creditor sinks the handler
    ///         factors receivables between. All disjoint from each other + the treasury, so a delivered
    ///         unit is unambiguously attributable.
    address public feeA = makeAddr("recv_feeA");
    address public feeB = makeAddr("recv_feeB");
    address[3] public creditors =
        [makeAddr("recv_creditor0"), makeAddr("recv_creditor1"), makeAddr("recv_creditor2")];

    /// @notice The receivable ids the handler minted (the frozen canaries are deliberately excluded).
    uint256[] public ids;

    // ---- ghost accounting (the spec the contract is checked against) ----
    uint256 public ghostGrossSettled; // Σ token gross successfully settled (the value the router split)
    uint256 public ghostGrossSettledNative; // Σ native gross successfully settled
    uint256 public ghostSettleCount; // total number of successful settlements across all receivables
    uint256 public ghostMintedCount; // total receivables the handler minted (excludes the canaries)
    mapping(uint256 => uint256) public settleCountOf; // per-receivable settlement count (must be ≤ 1)

    uint16 internal constant MERCHANT_FEE_BPS = 50;

    constructor(Access0x1Router router_, Receivables recv_, MockUSDC usdc_, address treasury_) {
        router = router_;
        recv = recv_;
        usdc = usdc_;
        treasury = treasury_;
        // Register the two conduit merchants FROM the handler so the handler IS their owner — only then
        // can it mint + cancel their receivables. Each merchant's payout MUST be the Receivables
        // contract (the conduit invariant the mint path enforces).
        merchantA = router.registerMerchant(address(recv), feeA, MERCHANT_FEE_BPS, keccak256("rA"));
        merchantB = router.registerMerchant(address(recv), feeB, MERCHANT_FEE_BPS, keccak256("rB"));
    }

    /// @dev Pick a minted receivable from a seed; `ok` is false when none exist.
    function _pick(uint256 seed) internal view returns (uint256 id, bool ok) {
        uint256 len = ids.length;
        if (len == 0) return (0, false);
        id = ids[seed % len];
        ok = true;
    }

    /*//////////////////////////////////////////////////////////////
                                ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Mint a receivable on one of the two conduit merchants, in USDC or native, to one of the
    ///         three creditor sinks, sometimes locked to the handler (the sole debtor). The token is
    ///         recorded on-chain so {pay}/{payNative} pick the right path; the two conservation sums are
    ///         kept per-asset.
    function mint(
        uint256 merchantSeed,
        uint256 usdSeed,
        uint256 creditorSeed,
        bool locked,
        bool native
    ) external {
        uint256 merchantId = merchantSeed % 2 == 0 ? merchantA : merchantB;
        uint256 usd = bound(usdSeed, 1e8, 100_000e8); // $1 .. $100k
        address creditor = creditors[creditorSeed % 3];
        address debtor = locked ? address(this) : address(0);
        address token = native ? address(0) : address(usdc);
        uint256 id = recv.mint(merchantId, creditor, debtor, token, usd, 0, "");
        ids.push(id);
        ghostMintedCount++;
    }

    /// @notice Factor a receivable: transfer the NFT from its current creditor to another creditor sink.
    ///         Proves the creditor can change arbitrarily before settlement and the net still follows the
    ///         live holder. Early-returns when there is nothing OPEN to move.
    function factor(uint256 idSeed, uint256 toSeed) external {
        (uint256 id, bool ok) = _pick(idSeed);
        if (!ok) return;
        if (!recv.isPayable(id)) return; // not OPEN ⇒ the token may be burned ⇒ skip
        address from = IERC721(address(recv)).ownerOf(id);
        address to = creditors[toSeed % 3];
        if (to == from) return; // no-op transfer would be wasteful (and OZ allows it, but skip)
        vm.prank(from);
        IERC721(address(recv)).transferFrom(from, to, id);
    }

    /// @notice Settle a minted TOKEN receivable if it is currently OPEN. Early-returns otherwise (a
    ///         SETTLED/CANCELLED/native receivable would revert, tripping `fail_on_revert` — which is
    ///         exactly the single-settlement property). The net lands at the live holder (a creditor
    ///         sink), so the conservation sums stay exact.
    function pay(uint256 idSeed) external {
        (uint256 id, bool ok) = _pick(idSeed);
        if (!ok) return;
        if (!recv.isPayable(id)) return; // not OPEN ⇒ skip (replay would revert)
        IReceivables.Receivable memory r = recv.receivableOf(id);
        if (r.token != address(usdc)) return; // native receivable ⇒ wrong path ⇒ skip

        uint256 gross = router.quote(r.merchantId, address(usdc), r.amountUsd8);
        usdc.mint(address(this), gross);
        usdc.approve(address(recv), gross);
        recv.pay(id, bytes32(id));

        ghostGrossSettled += gross;
        ghostSettleCount++;
        settleCountOf[id]++;
    }

    /// @notice Settle a minted NATIVE receivable if it is currently OPEN. Pays exactly gross (no excess,
    ///         so no refund leg perturbs the handler's balance), keeping the native conservation sum
    ///         exact. Early-returns on a token/SETTLED/CANCELLED receivable.
    function payNative(uint256 idSeed) external {
        (uint256 id, bool ok) = _pick(idSeed);
        if (!ok) return;
        if (!recv.isPayable(id)) return;
        IReceivables.Receivable memory r = recv.receivableOf(id);
        if (r.token != address(0)) return; // token receivable ⇒ wrong path ⇒ skip

        uint256 gross = router.quote(r.merchantId, address(0), r.amountUsd8);
        vm.deal(address(this), gross);
        recv.payNative{ value: gross }(id, bytes32(id));

        ghostGrossSettledNative += gross;
        ghostSettleCount++;
        settleCountOf[id]++;
    }

    /// @notice Cancel a minted receivable if it is currently OPEN (the handler owns both merchants, so it
    ///         is authorized). Early-returns otherwise.
    function cancel(uint256 idSeed) external {
        (uint256 id, bool ok) = _pick(idSeed);
        if (!ok) return;
        if (!recv.isPayable(id)) return; // not OPEN ⇒ skip (a SETTLED/CANCELLED cancel would revert)
        if (recv.isFactored(id)) return; // FACTORED ⇒ the claim is firm, cancel now reverts by design
        recv.cancel(id);
    }

    /*//////////////////////////////////////////////////////////////
                              GHOST VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Σ token delivered across every creditor + fee + treasury sink — what the router pushed
    ///         out (the net to a creditor) plus the fee legs across all settlements. Must equal
    ///         `ghostGrossSettled` (conservation / net + fee == gross).
    function deliveredToken() external view returns (uint256 total) {
        total += usdc.balanceOf(creditors[0]);
        total += usdc.balanceOf(creditors[1]);
        total += usdc.balanceOf(creditors[2]);
        total += usdc.balanceOf(feeA);
        total += usdc.balanceOf(feeB);
        total += usdc.balanceOf(treasury);
    }

    /// @notice Σ native delivered across every creditor + fee + treasury sink (+ any router rescue, zero
    ///         in practice since all sinks are EOAs). Must equal `ghostGrossSettledNative`.
    function deliveredNative() external view returns (uint256 total) {
        total += creditors[0].balance + router.rescue(creditors[0]);
        total += creditors[1].balance + router.rescue(creditors[1]);
        total += creditors[2].balance + router.rescue(creditors[2]);
        total += feeA.balance + router.rescue(feeA);
        total += feeB.balance + router.rescue(feeB);
        total += treasury.balance + router.rescue(treasury);
    }

    /// @notice The number of receivables minted by the handler (for the at-most-once-per check).
    function idCount() external view returns (uint256) {
        return ids.length;
    }

    /// @notice The minted receivable id at `index` (for the suite to iterate per-receivable counts).
    function idAt(uint256 index) external view returns (uint256) {
        return ids[index];
    }

    /// @notice ERC-721 receiver hook so the handler can hold a receivable it mints to itself (none do
    ///         today — creditors are the three sinks — but this keeps `_safeMint` safe if that changes).
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC721Received.selector;
    }

    /// @notice Accept native value (the handler is never a creditor sink, so it receives none today,
    ///         but a bare `receive` keeps any future native path from reverting on it).
    receive() external payable { }
}
