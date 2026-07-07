// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { RwaShareVault } from "../../src/RwaShareVault.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

/// @notice Unit + fuzz suite for {RwaShareVault}, the vanilla ERC-4626 fractional-share vault preset.
///         The suite's spine is the MONEY-PATH LAW: exits (`withdraw`/`redeem`) are NEVER blockable,
///         even while the deposit side is paused. It also covers the standard round-trip share math
///         over a non-18-decimal asset (6-decimal MockUSDC), the owner-gated two-layer deposit pause
///         (`maxDeposit`/`maxMint` report 0 AND `_deposit` hard-reverts `EnforcedPause`, including the
///         zero-amount edge), that unpause fully re-opens deposits, and that only the owner may toggle
///         the pause.
contract RwaShareVaultTest is Test {
    RwaShareVault internal vault;
    MockUSDC internal asset;

    address internal owner = makeAddr("owner"); // Ownable — deposit-side pause key only
    address internal alice = makeAddr("alice"); // depositor
    address internal bob = makeAddr("bob"); // second depositor

    string internal constant NAME = "Access0x1 Share Vault";
    string internal constant SYMBOL = "A0X1SV";
    uint256 internal constant SEED = 1_000_000e6; // 1,000,000 USDC (6 decimals)

    function setUp() public {
        asset = new MockUSDC();
        vault = new RwaShareVault(IERC20(address(asset)), NAME, SYMBOL, owner);

        // Fund and pre-approve the two depositors.
        asset.mint(alice, SEED);
        asset.mint(bob, SEED);
        vm.prank(alice);
        asset.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        asset.approve(address(vault), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_constructor_wiresAssetMetadataAndOwner() public view {
        assertEq(vault.asset(), address(asset), "asset is the constructor param");
        assertEq(vault.name(), NAME);
        assertEq(vault.symbol(), SYMBOL);
        assertEq(vault.owner(), owner);
        assertFalse(vault.paused(), "starts unpaused");
        // The share token inherits the asset's decimals via OZ's default (6 here + offset 0).
        assertEq(IERC20Metadata(address(vault)).decimals(), asset.decimals());
    }

    /*//////////////////////////////////////////////////////////////
                         DEPOSIT / REDEEM ROUND-TRIP
    //////////////////////////////////////////////////////////////*/

    function test_deposit_mintsSharesAndPullsAssets() public {
        uint256 amount = 100e6;
        vm.prank(alice);
        uint256 shares = vault.deposit(amount, alice);

        assertGt(shares, 0, "shares minted");
        assertEq(vault.balanceOf(alice), shares);
        assertEq(asset.balanceOf(address(vault)), amount, "assets custodied by the vault");
        assertEq(asset.balanceOf(alice), SEED - amount);
    }

    /// @notice The full round-trip returns (at least, given rounding) the deposited assets — the vault
    ///         is pure share accounting with no fee.
    function test_redeem_returnsUnderlyingPreRata() public {
        uint256 amount = 250e6;
        vm.startPrank(alice);
        uint256 shares = vault.deposit(amount, alice);
        uint256 assetsBack = vault.redeem(shares, alice, alice);
        vm.stopPrank();

        assertEq(assetsBack, amount, "single depositor gets the whole amount back");
        assertEq(vault.balanceOf(alice), 0, "all shares burned");
        assertEq(asset.balanceOf(alice), SEED, "made whole");
    }

    /*//////////////////////////////////////////////////////////////
                          DEPOSIT-SIDE PAUSE
    //////////////////////////////////////////////////////////////*/

    function test_pause_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        vault.pause();
    }

    function test_unpause_onlyOwner() public {
        vm.prank(owner);
        vault.pause();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        vault.unpause();
    }

    /// @notice Layer 1 of the pause: `maxDeposit`/`maxMint` report 0 while paused (the idiomatic
    ///         "closed for deposits" signal, no revert — previews/routers see it cleanly).
    function test_pause_maxDepositAndMaxMintReportZero() public {
        assertGt(vault.maxDeposit(alice), 0, "open before pause");
        assertGt(vault.maxMint(alice), 0, "open before pause");

        vm.prank(owner);
        vault.pause();

        assertEq(vault.maxDeposit(alice), 0, "closed for deposits while paused");
        assertEq(vault.maxMint(alice), 0, "closed for mints while paused");
    }

    /// @notice A NON-ZERO deposit/mint while paused is stopped by Layer 1: OZ's public `deposit`/`mint`
    ///         check `max*` (now 0) FIRST and revert `ERC4626ExceededMax*` before `_deposit` runs. Both
    ///         entry points are firmly closed to new capital — the exact revert differs from the
    ///         zero-amount path (below), which is the point of the two coordinated layers.
    function test_pause_nonZeroDepositAndMintRevertViaMaxLayer() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC4626.ERC4626ExceededMaxDeposit.selector, alice, uint256(100e6), uint256(0)
            )
        );
        vault.deposit(100e6, alice);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC4626.ERC4626ExceededMaxMint.selector, alice, uint256(100e6), uint256(0)
            )
        );
        vault.mint(100e6, alice);
    }

    /// @notice The zero-amount edge is Layer 2: a `deposit(0)`/`mint(0)` slips past the `max*` check as
    ///         a no-op (0 <= max of 0), but the `whenNotPaused` on `_deposit` still hard-reverts
    ///         `EnforcedPause` — so there is NO paused deposit path, not even a zero one.
    function test_pause_zeroAmountDepositAndMintRevertEnforcedPause() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(0, alice);

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.mint(0, alice);
    }

    function test_unpause_reopensDeposits() public {
        vm.startPrank(owner);
        vault.pause();
        vault.unpause();
        vm.stopPrank();

        vm.prank(alice);
        uint256 shares = vault.deposit(100e6, alice);
        assertGt(shares, 0, "deposits flow again after unpause");
    }

    /*//////////////////////////////////////////////////////////////
                    MONEY-PATH LAW: EXITS NEVER BLOCKABLE
    //////////////////////////////////////////////////////////////*/

    /// @notice THE core invariant of this preset: a shareholder can ALWAYS redeem, even while the
    ///         vault is paused. Pausing halts new money IN; it can never trap money that is already in.
    function test_moneyPath_redeemWorksWhilePaused() public {
        // Alice deposits BEFORE the pause.
        vm.prank(alice);
        uint256 shares = vault.deposit(400e6, alice);

        // Owner pauses (incident / wind-down).
        vm.prank(owner);
        vault.pause();
        assertTrue(vault.paused());

        // Redemption still succeeds — no owner or code path can stop it.
        vm.prank(alice);
        uint256 assetsBack = vault.redeem(shares, alice, alice);
        assertEq(assetsBack, 400e6, "full exit honored under pause");
        assertEq(asset.balanceOf(alice), SEED, "made whole despite the pause");
    }

    /// @notice The `withdraw` exit is equally unblockable while paused, and its max/preview views are
    ///         unaffected by the pause (deposit-side only).
    function test_moneyPath_withdrawWorksWhilePaused() public {
        vm.prank(alice);
        vault.deposit(400e6, alice);

        vm.prank(owner);
        vault.pause();

        assertEq(vault.maxWithdraw(alice), 400e6, "exit ceiling untouched by pause");
        vm.prank(alice);
        vault.withdraw(400e6, alice, alice);
        assertEq(asset.balanceOf(alice), SEED, "made whole via withdraw under pause");
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @notice For any deposit amount, the deposit→redeem round-trip returns the full amount (no fee,
    ///         single depositor) and leaves no dust in the vault.
    function testFuzz_roundTrip_returnsFullAmount(uint256 amount) public {
        amount = bound(amount, 1, SEED);
        vm.startPrank(alice);
        uint256 shares = vault.deposit(amount, alice);
        uint256 back = vault.redeem(shares, alice, alice);
        vm.stopPrank();

        assertEq(back, amount, "single depositor round-trips exactly");
        assertEq(asset.balanceOf(address(vault)), 0, "no dust left behind");
    }

    /// @notice For ANY deposit amount, a shareholder can redeem in full while the vault is paused —
    ///         the money-path law holds across the whole input range.
    function testFuzz_moneyPath_redeemAlwaysWorksWhilePaused(uint256 amount) public {
        amount = bound(amount, 1, SEED);
        vm.prank(alice);
        uint256 shares = vault.deposit(amount, alice);

        vm.prank(owner);
        vault.pause();

        vm.prank(alice);
        uint256 back = vault.redeem(shares, alice, alice);
        assertEq(back, amount, "exit honored under pause for any amount");
    }
}
