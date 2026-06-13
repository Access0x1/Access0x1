// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Access0x1Invoices } from "../../src/Access0x1Invoices.sol";

/// @notice A malicious payer that, on receiving its native refund during {Access0x1Invoices.payNative},
///         tries to re-enter `payNative` for the SAME invoice to settle it twice. The contract's
///         `nonReentrant` guard (and the flip-to-PAID-before-interaction) must make the inner call
///         revert, which — because the refund `call` then fails — reverts the entire outer tx. The net
///         effect tested: no double-settlement is possible.
contract ReentrantInvoicePayer {
    Access0x1Invoices public immutable invoices;
    uint256 public immutable invoiceId;
    bool private attacked;

    constructor(Access0x1Invoices invoices_, uint256 invoiceId_) {
        invoices = invoices_;
        invoiceId = invoiceId_;
    }

    /// @notice Kick off the first (legitimate-looking) payment. The over-payment forces a refund,
    ///         which re-enters this contract's `receive`.
    function attack(uint256 grossPlusExcess) external payable {
        invoices.payNative{ value: grossPlusExcess }(invoiceId, keccak256("reenter"));
    }

    receive() external payable {
        if (!attacked) {
            attacked = true;
            // Re-enter to pay the same invoice again. nonReentrant reverts this inner call.
            invoices.payNative{ value: msg.value }(invoiceId, keccak256("reenter-2"));
        }
    }
}
