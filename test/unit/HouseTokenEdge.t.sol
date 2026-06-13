// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { HouseToken } from "../../src/HouseToken.sol";

/// @title  HouseTokenEdge — boundary / revert / zero-and-max unit cases the existing suite misses
/// @author Access0x1
/// @notice Per-function UNIT edge cases for {HouseToken} constructed DIRECTLY (not via the factory).
///         `test/unit/HouseTokenFactory.t.sol` covers the happy paths and the via-factory deploys
///         thoroughly; this file fills the gaps that only show up when the token is built on its own and
///         its OZ-inherited Ownable / ERC20Permit surface is pushed to the edges:
///           - the constructor's owner guard and how it INTERACTS with Ownable's own zero-owner check;
///           - the decimals boundary (0 and 255) the override must preserve;
///           - the `factory` provenance pointer on direct construction (= msg.sender, here the test);
///           - renounceOwnership permanently disabling mint authority (closed-loop supply finality);
///           - transferOwnership-to-zero rejection;
///           - permit with an EXPIRED deadline reverting (the time-boundary of the gasless approval).
/// @dev    No factory and no new mocks — these are pure token-surface units. The signing-key edge for
///         permit uses `makeAddrAndKey` so a real EIP-712 signature is produced. Amounts are exact
///         constants here (the random-amount domain is the STATELESS-FUZZ tier in
///         `test/fuzz/HouseTokenFuzz.t.sol`); this file isolates the BOUNDARY values instead.
contract HouseTokenEdgeTest is Test {
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");

    string internal constant NAME = "Acme Loyalty";
    string internal constant SYMBOL = "ACME";

    /*//////////////////////////////////////////////////////////////
                        CONSTRUCTOR — OWNER GUARD
    //////////////////////////////////////////////////////////////*/

    /// @notice Constructing with a zero owner reverts. NOTE the ACTUAL revert is OZ Ownable's
    ///         `OwnableInvalidOwner(0)`, NOT HouseToken's own `HouseToken__ZeroOwner`: the
    ///         `Ownable(owner_)` base constructor runs in the initializer list (before the body), so it
    ///         catches the zero owner FIRST and the body's `HouseToken__ZeroOwner` check is never
    ///         reached on direct construction. (The factory's separate pre-check is what actually
    ///         surfaces a domain error to callers; see HouseTokenFactory.t.sol.) This test pins the real
    ///         behaviour so a future refactor that reorders the checks is caught.
    function test_constructor_zeroOwner_revertsOwnableInvalidOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new HouseToken(address(0), NAME, SYMBOL, 18, 1_000e18);
    }

    /// @notice Zero initial supply mints nothing and leaves the owner free to mint later — a valid,
    ///         intended construction (loyalty programs that issue on demand). The boundary of the
    ///         `if (initialSupply_ > 0)` mint guard.
    function test_constructor_zeroSupply_mintsNothingButOwnerCanMintLater() public {
        HouseToken token = new HouseToken(owner, NAME, SYMBOL, 18, 0);
        assertEq(token.totalSupply(), 0, "no supply at construction");
        assertEq(token.balanceOf(owner), 0);

        vm.prank(owner);
        token.mint(owner, 500e18);
        assertEq(token.balanceOf(owner), 500e18, "owner can mint after a zero-supply deploy");
    }

    /// @notice `factory` is set to msg.sender at construction — on DIRECT construction that is this test
    ///         contract, not any factory. Provenance is honest: the pointer records who deployed it,
    ///         and a non-factory deploy is plainly attributable.
    function test_constructor_factoryPointerIsMsgSender() public {
        HouseToken token = new HouseToken(owner, NAME, SYMBOL, 18, 0);
        assertEq(token.factory(), address(this), "factory pointer is the direct deployer");
    }

    /*//////////////////////////////////////////////////////////////
                          DECIMALS — BOUNDARIES
    //////////////////////////////////////////////////////////////*/

    /// @notice The decimals override preserves the construction-time value at BOTH ends of the uint8
    ///         range — 0 (indivisible, whole-unit credits) and 255 (the max) — never the OZ default 18.
    function test_decimals_zeroAndMaxBoundaries() public {
        HouseToken zeroDp = new HouseToken(owner, "ZeroDP", "ZDP", 0, 0);
        assertEq(zeroDp.decimals(), 0, "decimals() returns the stored 0, not 18");

        HouseToken maxDp = new HouseToken(owner, "MaxDP", "MDP", 255, 0);
        assertEq(maxDp.decimals(), 255, "decimals() returns the stored 255, not 18");
    }

    /*//////////////////////////////////////////////////////////////
                    OWNABLE — RENOUNCE / TRANSFER EDGES
    //////////////////////////////////////////////////////////////*/

    /// @notice After the owner renounces ownership the supply is FINAL: there is no owner, so `mint`
    ///         can never be called again (every caller, including the ex-owner, is unauthorized). This
    ///         is the closed-loop "fixed-cap" lifecycle — a business can permanently cap issuance by
    ///         renouncing. Existing balances and transfers are unaffected.
    function test_renounceOwnership_permanentlyDisablesMint() public {
        HouseToken token = new HouseToken(owner, NAME, SYMBOL, 18, 1_000e18);

        vm.prank(owner);
        token.renounceOwnership();
        assertEq(token.owner(), address(0), "ownership renounced");

        // The ex-owner can no longer mint — supply is capped forever.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        token.mint(owner, 1);

        // But the already-minted supply still transfers normally (token remains usable).
        vm.prank(owner);
        IERC20(address(token)).transfer(alice, 10e18);
        assertEq(token.balanceOf(alice), 10e18, "existing supply still transferable after renounce");
    }

    /// @notice Transferring ownership to the zero address is rejected by Ownable — a business cannot
    ///         accidentally strand the token's mint authority via `transferOwnership(0)`; the explicit
    ///         `renounceOwnership` path is the only way to reach a zero owner.
    function test_transferOwnership_toZero_reverts() public {
        HouseToken token = new HouseToken(owner, NAME, SYMBOL, 18, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        token.transferOwnership(address(0));
        assertEq(token.owner(), owner, "owner unchanged after a rejected transfer");
    }

    /*//////////////////////////////////////////////////////////////
                      ERC-2612 PERMIT — TIME BOUNDARY
    //////////////////////////////////////////////////////////////*/

    /// @notice A permit whose deadline is in the PAST reverts `ERC2612ExpiredSignature` and sets no
    ///         allowance — the gasless-approval window is a hard time boundary the router's pay path
    ///         can rely on (a captured-but-stale permit can never be replayed after expiry).
    function test_permit_expiredDeadline_reverts() public {
        HouseToken token = new HouseToken(owner, NAME, SYMBOL, 18, 0);
        (address signer, uint256 pk) = makeAddrAndKey("permitSigner");

        // Move time forward, then sign for a deadline strictly in the past.
        vm.warp(1_000_000);
        uint256 deadline = block.timestamp - 1;
        uint256 value = 500e18;

        bytes32 typehash = keccak256(
            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        );
        bytes32 structHash =
            keccak256(abi.encode(typehash, signer, alice, value, token.nonces(signer), deadline));
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", IERC20Permit(address(token)).DOMAIN_SEPARATOR(), structHash
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        vm.expectRevert(
            abi.encodeWithSelector(ERC20Permit.ERC2612ExpiredSignature.selector, deadline)
        );
        token.permit(signer, alice, value, deadline, v, r, s);

        assertEq(token.allowance(signer, alice), 0, "no allowance set by an expired permit");
        assertEq(token.nonces(signer), 0, "expired permit consumes no nonce");
    }
}
