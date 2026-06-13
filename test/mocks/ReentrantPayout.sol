// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Access0x1Router } from "../../src/Access0x1Router.sol";

/// @notice A malicious merchant payout: when it receives its net, it tries to re-enter `payNative`.
///         `nonReentrant` must make that inner call revert, so the outer push fails and the net is
///         queued to `rescue` — never settled twice. This is the reentrancy proof.
contract ReentrantPayout {
    Access0x1Router public immutable router;
    uint256 public immutable merchantId;

    constructor(Access0x1Router router_, uint256 merchantId_) {
        router = router_;
        merchantId = merchantId_;
    }

    receive() external payable {
        // Re-enter. The guard reverts this inner call; the caller's low-level push then sees ok=false.
        router.payNative{ value: msg.value }(merchantId, 1, bytes32(uint256(0xdead)));
    }
}
