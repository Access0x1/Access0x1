// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { ERC20Burnable } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { HouseToken } from "../../src/HouseToken.sol";

/// @title  HouseTokenFuzz — stateless (single-call) fuzz suite for {HouseToken}
/// @author Access0x1
/// @notice The Cyfrin STATELESS-FUZZ tier for the house ERC-20: every public/external function is
///         driven with `bound()`-constrained random inputs and the per-call invariant is asserted on
///         each draw. Where the existing `HouseTokenFactory.t.sol` fuzz only varies the DEPLOY inputs
///         (owner/decimals/supply), this file fuzzes the TOKEN ITSELF — mint, burn, burnFrom, transfer,
///         approve, transferFrom, and the EIP-2612 permit — so the conservation + authorization
///         properties are checked across the whole input domain, not at a handful of fixed amounts.
/// @dev    Each test is single-shot (arrange → one fuzzed act → assert): no handler, no persisted state
///         between calls — that is the STATEFUL-INVARIANT tier, intentionally out of scope here. The
///         token is constructed directly (not via the factory) so a draw is one clean deploy; the
///         factory's own deploy-path fuzz already lives in `HouseTokenFactory.t.sol` and is not
///         duplicated. The cross-cutting money invariant proven on every mutating draw is SUPPLY
///         CONSERVATION: `totalSupply == sum(balances)` — nothing is created or destroyed except by an
///         explicit mint (which credits exactly one account) or a burn (which debits exactly one).
contract HouseTokenFuzz is Test {
    HouseToken internal token;

    address internal owner = makeAddr("owner"); // the business: sole minter + initial holder
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    string internal constant NAME = "Acme Loyalty";
    string internal constant SYMBOL = "ACME";
    uint8 internal constant DECIMALS = 18;

    /// @dev A generous-but-bounded supply ceiling. Bounding draws to `type(uint128).max` keeps the
    ///      sum of a few balances comfortably below `type(uint256).max`, so a legitimate mint can never
    ///      overflow `totalSupply` — that lets the tests assert the OZ math, not Solidity's overflow
    ///      guard, while still spanning 0 → an astronomically large supply.
    uint256 internal constant MAX = type(uint128).max;

    function setUp() public {
        // initialSupply 0 — each fuzz test mints exactly what it needs, so the starting state is a
        // clean, empty token whose only authority is `owner`.
        token = new HouseToken(owner, NAME, SYMBOL, DECIMALS, 0);
    }

    /// @dev The conservation oracle reused by every mutating test: the three account balances we ever
    ///      touch must sum to the recorded totalSupply (no other account is ever credited/debited).
    function _assertConservation() internal view {
        assertEq(
            token.balanceOf(owner) + token.balanceOf(alice) + token.balanceOf(bob),
            token.totalSupply(),
            "sum(balances) must equal totalSupply"
        );
    }

    /*//////////////////////////////////////////////////////////////
                                  MINT
    //////////////////////////////////////////////////////////////*/

    /// @notice mint(to, amount) credits EXACTLY `amount` to `to` and raises totalSupply by the same
    ///         amount — for any recipient and any in-range amount. Proves the owner-issuance path is a
    ///         pure credit (no fee, no skim) across the whole amount domain.
    function testFuzz_mint_creditsExactlyAndRaisesSupply(address to, uint256 amount) public {
        vm.assume(to != address(0)); // ERC20 forbids minting to the zero address
        amount = bound(amount, 0, MAX);

        uint256 supplyBefore = token.totalSupply();
        uint256 balBefore = token.balanceOf(to);

        vm.prank(owner);
        token.mint(to, amount);

        assertEq(token.balanceOf(to), balBefore + amount, "recipient credited exactly amount");
        assertEq(token.totalSupply(), supplyBefore + amount, "supply rose by exactly amount");
    }

    /// @notice mint is owner-ONLY for every non-owner caller and every amount: a random stranger can
    ///         never inflate the supply. The authorization boundary holds across the caller domain.
    function testFuzz_mint_nonOwnerAlwaysReverts(address notOwner, uint256 amount) public {
        vm.assume(notOwner != owner);
        amount = bound(amount, 0, MAX);

        vm.prank(notOwner);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, notOwner)
        );
        token.mint(alice, amount);

        assertEq(token.totalSupply(), 0, "no supply minted by an unauthorized caller");
    }

    /*//////////////////////////////////////////////////////////////
                                  BURN
    //////////////////////////////////////////////////////////////*/

    /// @notice burn(amount) destroys EXACTLY `amount` from the caller's own balance and lowers
    ///         totalSupply by the same amount — conservation holds for any holder balance and any burn
    ///         ≤ that balance. (The holder burns their OWN tokens; no allowance involved.)
    function testFuzz_burn_destroysExactlyAndLowersSupply(uint256 minted, uint256 toBurn) public {
        minted = bound(minted, 0, MAX);
        toBurn = bound(toBurn, 0, minted); // can only burn what you hold

        vm.prank(owner);
        token.mint(alice, minted);
        uint256 supplyBefore = token.totalSupply();

        vm.prank(alice);
        ERC20Burnable(address(token)).burn(toBurn);

        assertEq(token.balanceOf(alice), minted - toBurn, "holder debited exactly toBurn");
        assertEq(token.totalSupply(), supplyBefore - toBurn, "supply fell by exactly toBurn");
        _assertConservation();
    }

    /// @notice Burning MORE than you hold always reverts with ERC20InsufficientBalance and leaves both
    ///         balance and supply untouched — a holder can never destroy value it does not own.
    function testFuzz_burn_overBalanceReverts(uint256 minted, uint256 over) public {
        minted = bound(minted, 0, MAX - 1);
        over = bound(over, minted + 1, type(uint256).max); // strictly more than the balance

        vm.prank(owner);
        token.mint(alice, minted);
        uint256 supplyBefore = token.totalSupply();

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, alice, minted, over
            )
        );
        ERC20Burnable(address(token)).burn(over);

        assertEq(token.balanceOf(alice), minted, "balance untouched on failed burn");
        assertEq(token.totalSupply(), supplyBefore, "supply untouched on failed burn");
    }

    /// @notice burnFrom(holder, amount) spends the caller's allowance: it destroys exactly `amount`
    ///         from `holder`, decrements the allowance by exactly `amount`, and lowers supply by the
    ///         same — across any allowance/burn split. Proves the approved-burn path is also a pure,
    ///         exact debit (the router's permit-burn flow relies on this conservation).
    function testFuzz_burnFrom_spendsAllowanceAndConserves(
        uint256 minted,
        uint256 allowance,
        uint256 toBurn
    ) public {
        minted = bound(minted, 0, MAX);
        allowance = bound(allowance, 0, minted); // approve at most what alice can cover
        toBurn = bound(toBurn, 0, allowance); // burn at most what bob is approved for

        vm.prank(owner);
        token.mint(alice, minted);
        vm.prank(alice);
        token.approve(bob, allowance);

        uint256 supplyBefore = token.totalSupply();

        vm.prank(bob);
        ERC20Burnable(address(token)).burnFrom(alice, toBurn);

        assertEq(token.balanceOf(alice), minted - toBurn, "holder debited exactly toBurn");
        assertEq(token.totalSupply(), supplyBefore - toBurn, "supply fell by exactly toBurn");
        assertEq(
            token.allowance(alice, bob), allowance - toBurn, "allowance spent by exactly toBurn"
        );
        _assertConservation();
    }

    /*//////////////////////////////////////////////////////////////
                                TRANSFER
    //////////////////////////////////////////////////////////////*/

    /// @notice transfer(to, amount) moves value WITHOUT changing totalSupply: the sender's debit equals
    ///         the recipient's credit for any in-range balance/amount. The house token has no fee, no
    ///         hook, no rebase — a transfer is a pure relabelling of ownership. Self-transfer is the
    ///         tricky edge (sender == recipient): the balance must be unchanged, never doubled.
    function testFuzz_transfer_conservesSupplyAndMovesExactly(
        uint256 minted,
        uint256 amount,
        bool toSelf
    ) public {
        minted = bound(minted, 0, MAX);
        amount = bound(amount, 0, minted);
        address to = toSelf ? alice : bob;

        vm.prank(owner);
        token.mint(alice, minted);
        uint256 supplyBefore = token.totalSupply();

        vm.prank(alice);
        token.transfer(to, amount);

        if (toSelf) {
            // A self-transfer must be a no-op on the balance (credit and debit cancel exactly).
            assertEq(token.balanceOf(alice), minted, "self-transfer leaves balance unchanged");
        } else {
            assertEq(token.balanceOf(alice), minted - amount, "sender debited exactly amount");
            assertEq(token.balanceOf(bob), amount, "recipient credited exactly amount");
        }
        assertEq(token.totalSupply(), supplyBefore, "transfer never changes totalSupply");
        _assertConservation();
    }

    /// @notice Transferring more than you hold always reverts (ERC20InsufficientBalance) and moves
    ///         nothing — value cannot be conjured by an over-transfer.
    function testFuzz_transfer_overBalanceReverts(uint256 minted, uint256 over) public {
        minted = bound(minted, 0, MAX - 1);
        over = bound(over, minted + 1, type(uint256).max);

        vm.prank(owner);
        token.mint(alice, minted);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, alice, minted, over
            )
        );
        token.transfer(bob, over);

        assertEq(token.balanceOf(alice), minted, "sender balance untouched on failed transfer");
        assertEq(token.balanceOf(bob), 0, "recipient never credited on failed transfer");
    }

    /*//////////////////////////////////////////////////////////////
                       APPROVE / TRANSFER-FROM
    //////////////////////////////////////////////////////////////*/

    /// @notice approve(spender, value) sets the allowance to EXACTLY `value` (last-write-wins, not
    ///         additive) for any spender and any value — the precondition the router's pull path needs.
    function testFuzz_approve_setsExactAllowance(address spender, uint256 value) public {
        vm.assume(spender != address(0)); // ERC20 forbids approving the zero address as spender
        vm.prank(alice);
        token.approve(spender, value);
        assertEq(token.allowance(alice, spender), value, "allowance set to exactly value");
    }

    /// @notice transferFrom(from, to, amount) moves value AND spends allowance, both by exactly
    ///         `amount`, with totalSupply unchanged — for any minted/allowance/amount split. This is the
    ///         router/PaymentLanes pull leg: a third party (bob) moves alice's tokens within her
    ///         approval, and conservation holds.
    function testFuzz_transferFrom_movesAndSpendsAllowanceExactly(
        uint256 minted,
        uint256 allowance,
        uint256 amount
    ) public {
        minted = bound(minted, 0, MAX);
        allowance = bound(allowance, 0, minted);
        amount = bound(amount, 0, allowance);

        vm.prank(owner);
        token.mint(alice, minted);
        vm.prank(alice);
        token.approve(bob, allowance);

        uint256 supplyBefore = token.totalSupply();

        vm.prank(bob);
        token.transferFrom(alice, carol, amount);

        assertEq(token.balanceOf(alice), minted - amount, "owner debited exactly amount");
        assertEq(token.balanceOf(carol), amount, "recipient credited exactly amount");
        assertEq(
            token.allowance(alice, bob), allowance - amount, "allowance spent by exactly amount"
        );
        assertEq(token.totalSupply(), supplyBefore, "transferFrom never changes totalSupply");
    }

    /// @notice transferFrom beyond the approved allowance always reverts (ERC20InsufficientAllowance)
    ///         and moves nothing — the allowance is a hard ceiling a spender can never exceed.
    function testFuzz_transferFrom_overAllowanceReverts(
        uint256 minted,
        uint256 allowance,
        uint256 amount
    ) public {
        minted = bound(minted, 1, MAX);
        allowance = bound(allowance, 0, minted - 1);
        amount = bound(amount, allowance + 1, minted); // > allowance but ≤ balance (isolates allowance)

        vm.prank(owner);
        token.mint(alice, minted);
        vm.prank(alice);
        token.approve(bob, allowance);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, bob, allowance, amount
            )
        );
        token.transferFrom(alice, carol, amount);

        assertEq(token.balanceOf(alice), minted, "owner balance untouched on failed transferFrom");
        assertEq(token.balanceOf(carol), 0, "recipient never credited on failed transferFrom");
    }

    /*//////////////////////////////////////////////////////////////
                            EIP-2612 PERMIT
    //////////////////////////////////////////////////////////////*/

    /// @notice A valid EIP-2612 permit sets the allowance to EXACTLY `value`, consumes EXACTLY one
    ///         nonce, and is replay-proof — for any value and any not-yet-expired deadline. This is the
    ///         gasless-approval surface the router's pay path can consume; the fuzz spans the value and
    ///         (future) deadline domain to prove the signature flow, nonce bump, and replay rejection
    ///         hold everywhere, not just at a single canned amount.
    function testFuzz_permit_setsAllowanceBumpsNonceAndIsReplayProof(
        uint256 value,
        uint256 deadlineSkew
    ) public {
        // A signer we control the key for, so we can produce a real EIP-712 signature.
        (address signer, uint256 pk) = makeAddrAndKey("permitSigner");
        // Deadline strictly in the future (now .. now + ~1 year) — never expired for this call.
        uint256 deadline = block.timestamp + bound(deadlineSkew, 1, 365 days);

        uint256 nonceBefore = token.nonces(signer);
        bytes32 digest = _permitDigest(signer, bob, value, nonceBefore, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        token.permit(signer, bob, value, deadline, v, r, s);

        assertEq(token.allowance(signer, bob), value, "permit set allowance to exactly value");
        assertEq(token.nonces(signer), nonceBefore + 1, "permit consumed exactly one nonce");

        // Replay: the SAME signature now carries a stale nonce → the recovered signer mismatches and
        // OZ reverts ERC2612InvalidSigner. The allowance is not changed a second time.
        vm.expectRevert();
        token.permit(signer, bob, value, deadline, v, r, s);
        assertEq(token.allowance(signer, bob), value, "replay did not re-apply the permit");
    }

    /// @dev Build the EIP-2612 permit digest exactly as ERC20Permit does: the 0x1901 envelope over the
    ///      token's live DOMAIN_SEPARATOR and the typed Permit struct hash. Reading the domain from the
    ///      token (not reconstructing it) keeps this correct regardless of name/version/chainid.
    function _permitDigest(
        address ownerAddr,
        address spender,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 permitTypehash = keccak256(
            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        );
        bytes32 structHash =
            keccak256(abi.encode(permitTypehash, ownerAddr, spender, value, nonce, deadline));
        return keccak256(
            abi.encodePacked(
                "\x19\x01", IERC20Permit(address(token)).DOMAIN_SEPARATOR(), structHash
            )
        );
    }
}
