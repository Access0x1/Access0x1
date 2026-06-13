// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Access0x1Router } from "../../src/Access0x1Router.sol";

/// @notice A payout contract that exercises the rescue pull-path. As `Reject` it refuses the native
///         push during settlement, so the router parks the net in `rescue[this]` (the receipt still
///         stands). Flipped to `Accept`, `claim()` pulls it back. As `Reenter` it tries to re-enter
///         `claimRescue` from `receive` — `nonReentrant` must make the inner call revert, the outer
///         push see `ok == false`, and the whole claim roll back with the credit intact.
contract RescueClaimer {
    enum Mode {
        Reject,
        Accept,
        Reenter
    }

    Mode public mode = Mode.Reject;
    Access0x1Router public immutable router;

    constructor(Access0x1Router router_) {
        router = router_;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    /// @notice Pull this contract's queued native value out of the router.
    function claim() external {
        router.claimRescue();
    }

    receive() external payable {
        if (mode == Mode.Reject) revert("reject");
        if (mode == Mode.Reenter) router.claimRescue(); // guard must block this
        // Accept: take the funds and return.
    }
}
