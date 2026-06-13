// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {
    ERC6909TokenSupply
} from "@openzeppelin/contracts/token/ERC6909/extensions/ERC6909TokenSupply.sol";
import { IERC6909Metadata } from "@openzeppelin/contracts/interfaces/IERC6909.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title  Access0x1Lanes — PaymentLanes (ERC-6909)
/// @author Access0x1
/// @notice The multi-asset, multi-chain balance sheet for Access0x1 merchants and agents. A *lane*
///         is the tuple `(chainSelector, asset, recipient)` collapsed to one ERC-6909 token `id`: a
///         distinct, wallet-readable balance for "what `recipient` was paid in `asset`, originating
///         on `chainSelector`". One address therefore holds many coins across many chains as
///         separate, composable token ids — the agent balance sheet wallets can render.
/// @dev    NON-CUSTODIAL by construction: a lane token is a transferable on-chain CREDIT/receipt of
///         routed value, minted by an authorised `minter` (the zero-custody `Access0x1Router`) at
///         settlement — the underlying funds settled directly to the recipient in the router's own
///         tx. This contract never escrows the paid asset; `totalSupply(id)` is therefore the
///         cumulative routed volume through a lane, not a claim on pooled funds.
///         Built on OpenZeppelin's audited `ERC6909` + `ERC6909TokenSupply`; the lane semantics
///         (id derivation, minter-gated `credit`, per-lane metadata) are the net-new layer. Only
///         Uniswap v4 ships ERC-6909 today — no payments sponsor does — which is why PaymentLanes
///         is an owned-standard differentiator rather than table-stakes plumbing.
contract Access0x1Lanes is Ownable2Step, ERC6909TokenSupply, IERC6909Metadata {
    /// @notice A decoded lane. `recipient == address(0)` is the "unopened lane" sentinel: a lane row
    ///         is written exactly once, the first time it is credited, so its decode is immutable.
    /// @dev    Packs into two slots: `chainSelector`+`asset` (28 bytes) · `recipient`+`decimals`
    ///         (21 bytes). The fields mirror the router's `PaymentReceived(token, …, srcChainSelector)`.
    struct Lane {
        uint64 chainSelector; // CCIP-style source chain selector; 0 = this / local chain
        address asset; // the credited asset (address(0) = the chain's native coin)
        address recipient; // who the lane's credits accrue to
        uint8 decimals; // the asset's own decimals, cached so a wallet renders the lane amount
    }

    /// @notice Human name returned by {name} for every lane id (per-id names would be storage waste;
    ///         the distinguishing data is the lane decode, exposed via {laneOf}).
    string private constant LANE_NAME = "Access0x1 Payment Lane";

    /// @notice Ticker returned by {symbol} for every lane id.
    string private constant LANE_SYMBOL = "a0x1LANE";

    /// @notice id ⇒ its decoded lane. Public getter lets indexers/wallets resolve a lane token back
    ///         to `(chainSelector, asset, recipient, decimals)`. A zero `recipient` means unopened.
    mapping(uint256 id => Lane lane) public laneOf;

    /// @notice account ⇒ may it call {credit}. The owner allowlists the router(s) here; an agent or
    ///         buyer can never mint a lane credit out of thin air.
    mapping(address account => bool allowed) public isMinter;

    /// @notice A minter was allowed or revoked.
    event MinterSet(address indexed minter, bool allowed);

    /// @notice A lane was opened (first credit). Indexed by `recipient` + `asset` so a wallet keys on
    ///         "my lanes" and "all USDC lanes"; the full decode also lives in {laneOf}.
    event LaneOpened(
        uint256 indexed id,
        address indexed recipient,
        address indexed asset,
        uint64 chainSelector,
        uint8 decimals
    );

    /// @notice `amount` of lane `id` was credited (minted) to its recipient.
    event Credited(uint256 indexed id, address indexed recipient, uint256 amount);

    /// @notice Caller is not an allowlisted minter.
    error Access0x1Lanes__NotMinter(address caller);

    /// @notice A zero address was supplied where a non-zero one is required.
    error Access0x1Lanes__ZeroAddress();

    /// @notice A zero amount was supplied where a positive one is required.
    error Access0x1Lanes__ZeroAmount();

    /// @param initialOwner The admin (Ownable2Step) — sets minters. Burner at the event, multisig in prod.
    constructor(address initialOwner) Ownable(initialOwner) { }

    /// @notice Deterministically derive a lane's ERC-6909 token id from its tuple. Pure + collision-
    ///         resistant (`keccak256` over abi.encode, so field boundaries can't be ambiguated), so
    ///         off-chain code (the SDK, a wallet) computes the same id without a round-trip.
    /// @param chainSelector The CCIP-style source chain selector (0 = local chain).
    /// @param asset         The credited asset (address(0) = native).
    /// @param recipient     The address the lane credits.
    /// @return id           The ERC-6909 token id for the lane.
    function laneId(uint64 chainSelector, address asset, address recipient)
        public
        pure
        returns (uint256 id)
    {
        return uint256(keccak256(abi.encode(chainSelector, asset, recipient)));
    }

    /*//////////////////////////////////////////////////////////////
                          ERC-6909 METADATA
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC6909Metadata
    /// @dev Constant across ids — the per-lane identity is the {laneOf} decode, not a string.
    function name(uint256) public pure override returns (string memory) {
        return LANE_NAME;
    }

    /// @inheritdoc IERC6909Metadata
    function symbol(uint256) public pure override returns (string memory) {
        return LANE_SYMBOL;
    }

    /// @inheritdoc IERC6909Metadata
    /// @dev The credited asset's own decimals, cached at lane-open, so a wallet renders the lane
    ///      balance in the asset's units (e.g. 6 for USDC, 18 for native). Zero for an unopened lane.
    function decimals(uint256 id) public view override returns (uint8) {
        return laneOf[id].decimals;
    }

    /// @inheritdoc IERC165
    /// @dev Advertises ERC-165, ERC-6909, the Token-Supply extension (via `super`) and the Metadata
    ///      extension, so a wallet can feature-detect the full lane surface.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC6909TokenSupply, IERC165)
        returns (bool)
    {
        return interfaceId == type(IERC6909Metadata).interfaceId
            || super.supportsInterface(interfaceId);
    }
}
