// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";

/// @notice A hostile ERC-20 that, on the router's OUTBOUND push (the `safeTransfer` of net/fee during
///         `payToken`), re-enters `payToken` on the router to try to settle a second payment inside
///         the first. The router's shared `nonReentrant` guard must revert that inner call; because
///         the push is a plain (non-try) `safeTransfer`, the inner revert propagates and reverts the
///         WHOLE outer `payToken` — proving a token callback can never double-settle and that the
///         half-finished outer payment rolls back atomically (no phantom receipt, no residual token).
/// @dev    `arm`ed externally so the funding mints + the buyer's pull-in behave normally; only the
///         router→sink push trips the re-entry. `from == router` is the outbound-leg signature.
///         The re-entrant call is wrapped so its revert is observable post-mortem only if the guard
///         were absent — but since SafeERC20 re-throws, the outer tx reverts regardless.
contract MockReentrantToken is ERC20 {
    Access0x1Router public router;
    uint256 public merchantId;
    uint256 public usdAmount8;
    bool public armed;

    constructor() ERC20("Mock Reentrant", "MRE") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTarget(Access0x1Router router_, uint256 merchantId_, uint256 usdAmount8_) external {
        router = router_;
        merchantId = merchantId_;
        usdAmount8 = usdAmount8_;
    }

    function arm(bool on) external {
        armed = on;
    }

    /// @dev On the outbound push from the router, re-enter `payToken`. `nonReentrant` reverts the
    ///      inner call; SafeERC20's plain transfer re-throws it, reverting the whole outer payment.
    function _update(address from, address to, uint256 value) internal override {
        if (armed && from == address(router) && address(router) != address(0)) {
            armed = false; // one-shot guard against unbounded recursion if the lock were absent
            router.payToken(merchantId, address(this), usdAmount8, bytes32(uint256(0xbad)));
        }
        super._update(from, to, value);
    }
}
