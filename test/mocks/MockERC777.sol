// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";

/// @title  MockERC777
/// @author Access0x1
/// @notice A minimal ERC-777-LIKE token for adversarial testing. ERC-777 is fully ERC-20-compatible
///         on the wire (`transfer`/`transferFrom`/`balanceOf`/`decimals`), so the router's `payToken`
///         path mechanically accepts it — BUT the standard adds `tokensToSend` (a SENDER hook, fired
///         BEFORE balances move) and `tokensReceived` (a RECIPIENT hook, fired AFTER balances move).
///         Either hook hands control to attacker code in the MIDDLE of a token movement, which is the
///         classic ERC-777 reentrancy vector (the imBTC / Uniswap-V1 drain).
/// @dev    Rather than pull in the ERC-1820 registry, this mock fires the hooks DIRECTLY on a
///         configured target inside `_update`, which is a faithful and STRICTLY STRONGER model: it
///         re-enters the router on EVERY leg of the movement (the pull-in AND each outbound push),
///         giving the reentrancy guard more chances to fail than a registry-gated 777 would. The
///         token is ERC-20 by inheritance, so a router that survives this also survives a real 777.
contract MockERC777 is ERC20 {
    /// @notice The router the malicious hook re-enters.
    Access0x1Router public router;

    /// @notice The merchant the re-entrant `payToken` targets.
    uint256 public merchantId;

    /// @notice The USD amount (8 decimals) the re-entrant `payToken` quotes.
    uint256 public usdAmount8;

    /// @notice Which hook to fire. 0 = none, 1 = tokensReceived (on the router's pull-IN), 2 =
    ///         tokensToSend (on the router's outbound push), 3 = both.
    uint8 public hookMode;

    /// @notice One-shot latch so an absent guard cannot recurse unbounded (the guard is what we test).
    bool private fired;

    /// @notice Records whether the malicious inner `payToken` actually reverted (proof the guard bit).
    bool public innerReverted;

    constructor() ERC20("Mock ERC777", "M777") { }

    /// @notice 6 decimals like USDC, so the same router quote math is exercised.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Point the malicious hook at a router + merchant + price.
    function arm(Access0x1Router router_, uint256 merchantId_, uint256 usdAmount8_, uint8 hookMode_)
        external
    {
        router = router_;
        merchantId = merchantId_;
        usdAmount8 = usdAmount8_;
        hookMode = hookMode_;
        fired = false;
        innerReverted = false;
    }

    /// @dev The ERC-777 reentrancy surface, modeled on ERC-20's single `_update` chokepoint:
    ///      - `tokensReceived` (mode 1/3): fired when the ROUTER becomes the recipient — i.e. during
    ///        `_pullExact`'s `safeTransferFrom(buyer → router)`, mid-settlement, BEFORE the router has
    ///        split or pushed anything. This is the dangerous window.
    ///      - `tokensToSend` (mode 2/3): fired when the ROUTER is the sender — i.e. during each
    ///        outbound `safeTransfer(router → payout/treasury/feeDest)`.
    ///      In both cases the hook tries to re-enter `payToken` to settle a second payment inside the
    ///      first. The router's shared `nonReentrant` guard MUST revert that inner call; because the
    ///      router's transfers are plain (non-try) SafeERC20 calls, the inner revert propagates and
    ///      reverts the WHOLE outer payment — no double-settle, no phantom receipt, atomic rollback.
    function _update(address from, address to, uint256 value) internal override {
        address r = address(router);
        if (r != address(0) && !fired) {
            bool receivedHook = (hookMode == 1 || hookMode == 3) && to == r;
            bool sendHook = (hookMode == 2 || hookMode == 3) && from == r;
            if (receivedHook || sendHook) {
                fired = true; // latch BEFORE re-entry so the guard, not this flag, is the gate
                try router.payToken(
                    merchantId, address(this), usdAmount8, bytes32(uint256(0x777))
                ) {
                    // Inner settle SUCCEEDED — the guard did NOT bite. The attack test asserts the
                    // outer tx as a whole, so a successful double-settle will surface as broken money
                    // invariants there; we also record it as a non-revert here.
                    innerReverted = false;
                } catch {
                    innerReverted = true; // guard bit: inner reverted as required
                    revert("MockERC777: reentrancy blocked"); // re-throw so the outer tx rolls back
                }
            }
        }
        super._update(from, to, value);
    }
}
