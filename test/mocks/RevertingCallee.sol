// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  RevertingCallee
/// @author Access0x1
/// @notice Test-only callee whose entry points revert with KNOWN payloads (a parameterized custom
///         error and a string reason), used to prove that {Access0x1Account.execute} bubbles a
///         failed call's revert data back to the caller VERBATIM.
contract RevertingCallee {
    /// @notice The custom error {boom} reverts with — the exact bytes a bubbling test expects.
    /// @param code The caller-chosen payload proving the arguments survive the bubble untouched.
    error RevertingCallee__Boom(uint256 code);

    /// @notice Always reverts with `RevertingCallee__Boom(code)`.
    function boom(uint256 code) external pure {
        revert RevertingCallee__Boom(code);
    }

    /// @notice Always reverts with the string reason `"RevertingCallee: nope"`.
    function nope() external pure {
        revert("RevertingCallee: nope");
    }
}
