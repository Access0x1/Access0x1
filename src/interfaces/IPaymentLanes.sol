// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IPaymentLanes
/// @author Access0x1
/// @notice Minimal ERC-6909 surface for Access0x1 PaymentLanes plus the credit/claim receipt
///         extensions. A "lane" is a deterministic ERC-6909 token id derived from a
///         (chainId, asset, recipient) triple — see {laneId}. A lane balance is a non-custodial
///         RECEIPT for net value an allowlisted router has delivered (or is holding for pull-claim):
///         it is never a balance Access0x1 itself can spend.
/// @dev    Lane id = keccak256(abi.encode(chainId, asset, recipient)). Every (chain, token,
///         merchant-wallet) triple is therefore globally unique and collision-resistant, and any
///         off-chain party can recompute a lane id from public data with no storage enumeration.
interface IPaymentLanes {
    // ──────────────────────── ERC-6909 events ────────────────────────

    /// @notice Emitted on every balance change (mint, burn, transfer).
    /// @dev    `from == address(0)` on credit (mint); `to == address(0)` on claim (burn).
    /// @param caller The address that initiated the movement (router on mint, owner/operator/spender
    ///               on transfer, owner on claim).
    /// @param from   The address whose balance decreased (address(0) on a mint).
    /// @param to     The address whose balance increased (address(0) on a burn).
    /// @param id     The lane id whose balance moved.
    /// @param amount The amount moved.
    event Transfer(
        address indexed caller, address indexed from, address indexed to, uint256 id, uint256 amount
    );

    /// @notice Emitted when an operator is granted or revoked.
    /// @param owner    The owner delegating control of all their lanes.
    /// @param operator The address being (un)authorized.
    /// @param approved True if granted, false if revoked.
    event OperatorSet(address indexed owner, address indexed operator, bool approved);

    /// @notice Emitted when a spender allowance is set.
    /// @param owner   The owner whose lane allowance changed.
    /// @param spender The approved spender.
    /// @param id      The lane id the allowance applies to.
    /// @param amount  The new allowance.
    event Approval(
        address indexed owner, address indexed spender, uint256 indexed id, uint256 amount
    );

    /// @notice An authorized router address was set or cleared.
    /// @param router     The router address (de)authorized to call {credit}.
    /// @param authorized True if it may now call {credit}, false if revoked.
    event RouterSet(address indexed router, bool authorized);

    // ──────────────────────── errors ────────────────────────

    /// @notice Caller is not an authorized router.
    error PaymentLanes__Unauthorized();

    /// @notice Transfer or claim amount exceeds available balance.
    error PaymentLanes__InsufficientBalance(
        address owner, uint256 id, uint256 balance, uint256 needed
    );

    /// @notice TransferFrom amount exceeds allowance (and caller is not an operator).
    error PaymentLanes__InsufficientAllowance(
        address owner, address spender, uint256 id, uint256 allowance, uint256 needed
    );

    /// @notice claim() called with zero lane balance, or against an asset that does not back the lane.
    error PaymentLanes__NothingToClaim(address caller, address asset);

    /// @notice Zero address supplied where non-zero is required.
    error PaymentLanes__ZeroAddress();

    /// @notice Zero amount supplied where positive is required.
    error PaymentLanes__ZeroAmount();

    // ──────────────────────── ERC-6909 read ────────────────────────

    /// @notice The credited-but-unclaimed lane balance of `owner` on lane `id`.
    /// @param owner The lane-token holder.
    /// @param id    The lane id.
    /// @return The balance.
    function balanceOf(address owner, uint256 id) external view returns (uint256);

    /// @notice The per-id allowance `owner` granted `spender`.
    /// @param owner   The lane-token holder.
    /// @param spender The approved spender.
    /// @param id      The lane id.
    /// @return The allowance.
    function allowance(address owner, address spender, uint256 id) external view returns (uint256);

    /// @notice Whether `operator` may move any of `owner`'s lanes without a per-id allowance.
    /// @param owner    The lane-token holder.
    /// @param operator The candidate operator.
    /// @return True if `operator` is authorized for all of `owner`'s lanes.
    function isOperator(address owner, address operator) external view returns (bool);

    // ──────────────────────── ERC-6909 write ────────────────────────

    /// @notice Move `amount` of lane `id` from the caller to `to`.
    /// @param to     The recipient (non-zero).
    /// @param id     The lane id.
    /// @param amount The amount to move.
    /// @return True on success.
    function transfer(address to, uint256 id, uint256 amount) external returns (bool);

    /// @notice Move `amount` of lane `id` from `from` to `to`, spending the caller's allowance
    ///         (unless the caller is an operator for `from`).
    /// @param from   The source holder.
    /// @param to     The recipient (non-zero).
    /// @param id     The lane id.
    /// @param amount The amount to move.
    /// @return True on success.
    function transferFrom(address from, address to, uint256 id, uint256 amount)
        external
        returns (bool);

    /// @notice Set the caller's allowance for `spender` on lane `id` to `amount` (overwrite).
    /// @param spender The approved spender.
    /// @param id      The lane id.
    /// @param amount  The new allowance.
    /// @return True on success.
    function approve(address spender, uint256 id, uint256 amount) external returns (bool);

    /// @notice Grant or revoke `operator` for all of the caller's lanes.
    /// @param operator The operator.
    /// @param approved True to grant, false to revoke.
    /// @return True on success.
    function setOperator(address operator, bool approved) external returns (bool);

    // ──────────────────────── PaymentLanes extensions ────────────────────────

    /// @notice Credit `amount` of `asset` to `recipient`'s lane, minting lane tokens.
    ///         Called by an allowlisted router after it has already pushed net USDC (or holds it for
    ///         pull-claim). Only callable by an authorized router.
    /// @param recipient The merchant's payout address (one leg of the lane key).
    /// @param asset     The ERC-20 settled (USDC by default).
    /// @param amount    The net amount delivered / to-be-claimed.
    /// @return id       The lane id for (block.chainid, asset, recipient).
    function credit(address recipient, address asset, uint256 amount) external returns (uint256 id);

    /// @notice Burn the caller's full balance on its OWN lane for `asset` on this chain and return the
    ///         underlying asset. Pull pattern — the lane token is a receipt, not a held balance. This
    ///         is the convenience path for the original recipient; a transferee that received a lane
    ///         id from someone else uses {claimLane}.
    /// @param asset The ERC-20 to claim.
    function claim(address asset) external;

    /// @notice Burn the caller's full balance on an explicit lane `id` and return `asset`. Lets a
    ///         transferee (who holds a lane keyed to the original recipient) pull the underlying. The
    ///         caller MUST pass the `asset` that funded `id`: the lane stores its backing asset at
    ///         {credit} time, so a mismatched `asset` reverts with {PaymentLanes__AssetMismatch} and
    ///         can never release another asset's pool (the cross-asset firewall).
    /// @param id    The lane id to burn (e.g. one received via {transfer}).
    /// @param asset The ERC-20 that funded `id` (must equal the asset bound at credit time).
    function claimLane(uint256 id, address asset) external;

    /// @notice Derive the deterministic lane id for a (chainId, asset, recipient) triple.
    /// @dev    Pure — no storage read. Callers can compute lane ids off-chain for free.
    /// @param chainId_  The chain id leg (block.chainid at credit time).
    /// @param asset     The ERC-20 leg.
    /// @param recipient The recipient leg.
    /// @return The lane id.
    function laneId(uint256 chainId_, address asset, address recipient)
        external
        pure
        returns (uint256);
}
