// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Rejects every native transfer. As a merchant payout it drives the rescue-queue path; as
///         a buyer it drives the refund-revert path. Proves a payee that hates ETH can't break a
///         settled receipt (it gets queued) but can't silently swallow a refund (that reverts).
contract RevertingReceiver {
    receive() external payable {
        revert("RevertingReceiver: no ether");
    }
}
