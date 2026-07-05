// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC1155 } from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title  ReceiptToken
/// @author Access0x1
/// @notice A VANILLA, CLONEABLE commerce-RECEIPTS + LOYALTY-POINTS ERC-1155. One contract holds two id
///         namespaces that never collide by construction:
///           - RECEIPTS: `receiptId(orderId)` — a per-order proof of purchase, minted on settlement.
///             A receipt may be SOULBOUND (the honest default: a receipt is a personal record, not a
///             tradeable good) or transferable, chosen per mint.
///           - POINTS: a single fungible loyalty balance under the reserved {POINTS_ID}, accrued on
///             settlement and REDEEMED by burning (the customer spends points; a redemption is a
///             one-shot, `redemptionId`-guarded burn so a replayed redemption reverts).
///         The contract mints proofs and tracks points; it moves NO money — the sale itself settles
///         through the shared {Access0x1Router} (USD→token, fee-split, zero-custody), and the mint is a
///         post-settlement leg. So there is nothing to custody and no fee logic to re-derive here.
/// @dev    REUSABLE-BASE RULES (nothing privileged, nothing hardcoded):
///           - `admin_` (constructor param) holds only `DEFAULT_ADMIN_ROLE`; it grants {ISSUER_ROLE}
///             (the settlement leg mints receipts + accrues points) per its own governance.
///           - {POINTS_ID} is a fixed reserved id (`type(uint256).max`); every receipt id is
///             `uint256(orderId)` and orders never use the max sentinel, so the two spaces are disjoint.
///           - Redemption is a pure burn of the holder's OWN points, one-shot per `redemptionId` — the
///             on-chain idempotency guard mirrors the estate's single-settlement pattern. The value a
///             point redeems for is settled off this ledger (a discount at the router pay path), so the
///             burn is a debit-only bookkeeping entry the holder authorizes.
///         ENFORCEMENT lives in {_update}: MINT (`from == 0`) and BURN (`to == 0`) always pass; a
///         wallet-to-wallet transfer of a SOULBOUND receipt reverts. Points are always transferable
///         (a fungible balance) unless a clone overrides — they are not soulbound by default so a
///         family/team can pool them; a clone wanting non-transferable points sets `pointsSoulbound`.
contract ReceiptToken is ERC1155, AccessControl {
    /*//////////////////////////////////////////////////////////////
                                 ROLES
    //////////////////////////////////////////////////////////////*/

    /// @notice May mint receipts and accrue loyalty points — the settlement leg (or a manual grant).
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    /*//////////////////////////////////////////////////////////////
                                 CONFIG
    //////////////////////////////////////////////////////////////*/

    /// @notice The single reserved ERC-1155 id under which the fungible loyalty-point balance lives.
    ///         `type(uint256).max`, disjoint from every `receiptId` (orders never use the max sentinel).
    uint256 public constant POINTS_ID = type(uint256).max;

    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice receiptId ⇒ whether it is soulbound (non-transferable). Set at mint; a transferable
    ///         receipt has no entry (default false). Points ({POINTS_ID}) obey `pointsSoulbound`.
    mapping(uint256 receiptId => bool soulbound) private _receiptSoulbound;

    /// @notice receiptId ⇒ per-receipt metadata URI (empty ⇒ base URI).
    mapping(uint256 receiptId => string uri) private _receiptURI;

    /// @notice redemptionId ⇒ consumed. The one-shot guard: a replayed {redeemPoints} reverts.
    mapping(bytes32 redemptionId => bool used) public redemptionUsed;

    /// @notice receiptId ⇒ minted. The canonical uniqueness ledger — a transferable receipt with an
    ///         empty URI leaves no other trace, so this bit is the single source of truth for "already
    ///         issued". A second {mintReceipt} of the same order reverts on it.
    mapping(uint256 receiptId => bool minted) private _receiptMinted;

    /// @notice Whether the fungible loyalty points ({POINTS_ID}) are non-transferable. Default false
    ///         (points can be pooled/gifted); a clone flips it at construction for non-transferable
    ///         points. Receipts carry their own per-id soulbound flag.
    bool public immutable pointsSoulbound;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice A receipt was minted for `orderId` to `to` (`soulbound` = whether it can ever transfer).
    event ReceiptMinted(
        uint256 indexed receiptId, bytes32 indexed orderId, address indexed to, bool soulbound
    );

    /// @notice Loyalty points accrued to `to`.
    event PointsAccrued(address indexed to, uint256 amount);

    /// @notice A holder redeemed (burned) `amount` points under a one-shot `redemptionId`.
    event PointsRedeemed(address indexed holder, uint256 amount, bytes32 indexed redemptionId);

    /// @notice A zero address was supplied where a non-zero one is required.
    error ReceiptToken__ZeroAddress();

    /// @notice A zero amount was supplied where a positive one is required.
    error ReceiptToken__ZeroAmount();

    /// @notice A receipt was minted with the reserved points id (would collide with the point balance).
    error ReceiptToken__ReservedId();

    /// @notice The same receipt id was minted twice (proofs are unique per order).
    error ReceiptToken__ReceiptExists(uint256 receiptId);

    /// @notice A transfer was attempted on a soulbound token (receipt or, if configured, points).
    error ReceiptToken__Soulbound(uint256 id);

    /// @notice The redemption id was already consumed (replay).
    error ReceiptToken__RedemptionReplay(bytes32 redemptionId);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploy a fresh receipts+points collection. `admin_` is the only configured authority.
    /// @param baseUri_         The ERC-1155 base URI (per-receipt URIs override it).
    /// @param admin_           The role admin (non-zero). Receives `DEFAULT_ADMIN_ROLE` only.
    /// @param pointsSoulbound_ True ⇒ loyalty points are non-transferable; false ⇒ poolable (default).
    constructor(string memory baseUri_, address admin_, bool pointsSoulbound_) ERC1155(baseUri_) {
        if (admin_ == address(0)) revert ReceiptToken__ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        pointsSoulbound = pointsSoulbound_;
    }

    /*//////////////////////////////////////////////////////////////
                                 RECEIPTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Derive the receipt id for an `orderId` — a pure function so any party can recompute it.
    /// @param orderId The opaque order reference the receipt proves.
    /// @return The receipt id (the low 256 bits are `orderId`; never equals {POINTS_ID} for a real order).
    function receiptId(bytes32 orderId) public pure returns (uint256) {
        return uint256(orderId);
    }

    /// @notice Mint a proof-of-purchase receipt for `orderId`. Only {ISSUER_ROLE} (the settlement leg).
    ///         The receipt is unique per order (a second mint of the same id reverts) and starts
    ///         soulbound or transferable per `soulbound`. A balance of 1 is minted (a receipt is a
    ///         single proof).
    /// @param to       The buyer (non-zero, must accept ERC-1155).
    /// @param orderId  The order this receipt proves (its id must not be the reserved points id).
    /// @param soulbound True ⇒ non-transferable personal record; false ⇒ tradeable.
    /// @param uri_     Per-receipt metadata URI (empty ⇒ base URI).
    /// @return id      The minted receipt id.
    function mintReceipt(address to, bytes32 orderId, bool soulbound, string calldata uri_)
        external
        onlyRole(ISSUER_ROLE)
        returns (uint256 id)
    {
        id = receiptId(orderId);
        if (id == POINTS_ID) revert ReceiptToken__ReservedId();
        // A receipt is a single unique proof, one-shot across ALL holders. `_receiptMinted` is the
        // canonical guard (a transferable receipt with an empty URI leaves no other trace).
        if (_receiptMinted[id]) revert ReceiptToken__ReceiptExists(id);

        _receiptMinted[id] = true;
        if (soulbound) _receiptSoulbound[id] = true;
        if (bytes(uri_).length != 0) _receiptURI[id] = uri_;

        emit ReceiptMinted(id, orderId, to, soulbound);
        _mint(to, id, 1, "");
    }

    /*//////////////////////////////////////////////////////////////
                              LOYALTY POINTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Accrue loyalty points to `to`. Only {ISSUER_ROLE} (the settlement leg computes the
    ///         earn rate off-chain and mints the resulting balance under {POINTS_ID}).
    /// @param to     The earner (non-zero).
    /// @param amount The points to accrue (> 0).
    function accruePoints(address to, uint256 amount) external onlyRole(ISSUER_ROLE) {
        if (amount == 0) revert ReceiptToken__ZeroAmount();
        emit PointsAccrued(to, amount);
        _mint(to, POINTS_ID, amount, "");
    }

    /// @notice Redeem (burn) the caller's OWN loyalty points, one-shot per `redemptionId`. The VALUE a
    ///         point redeems for is applied off this ledger (a discount at the router pay path); this
    ///         call is the debit-only bookkeeping entry the holder authorizes. A replayed `redemptionId`
    ///         reverts, so an off-chain redemption reference can be trusted as settled exactly once.
    /// @dev    The holder burns their own balance (`msg.sender`), so no allowance/approval is needed and
    ///         no one can burn another's points. CEI: the id is marked used BEFORE the burn.
    /// @param amount       The points to redeem (> 0; must not exceed the caller's balance — the burn
    ///                     reverts otherwise via ERC-1155's `ERC1155InsufficientBalance`).
    /// @param redemptionId The one-shot off-chain redemption reference.
    function redeemPoints(uint256 amount, bytes32 redemptionId) external {
        if (amount == 0) revert ReceiptToken__ZeroAmount();
        if (redemptionUsed[redemptionId]) revert ReceiptToken__RedemptionReplay(redemptionId);
        redemptionUsed[redemptionId] = true; // effect before interaction (one-shot)
        emit PointsRedeemed(msg.sender, amount, redemptionId);
        _burn(msg.sender, POINTS_ID, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice The caller's (or any account's) current loyalty-point balance.
    /// @param account The account.
    /// @return The point balance under {POINTS_ID}.
    function pointsOf(address account) external view returns (uint256) {
        return balanceOf(account, POINTS_ID);
    }

    /// @notice Whether a receipt id is soulbound (non-transferable).
    /// @param id The receipt id.
    /// @return Whether the receipt can never transfer.
    function isReceiptSoulbound(uint256 id) external view returns (bool) {
        return _receiptSoulbound[id];
    }

    /// @inheritdoc ERC1155
    /// @dev Per-receipt URI if set, else the base URI.
    function uri(uint256 id) public view override returns (string memory) {
        string memory u = _receiptURI[id];
        return bytes(u).length != 0 ? u : super.uri(id);
    }

    /*//////////////////////////////////////////////////////////////
                              ENFORCEMENT
    //////////////////////////////////////////////////////////////*/

    /// @dev The single ERC-1155 transfer choke-point. MINT (`from == 0`) and BURN (`to == 0`) always
    ///      pass — accrual, receipt issuance, and redemption are never "transfers". A wallet-to-wallet
    ///      move reverts if the id is a soulbound receipt, or if it is {POINTS_ID} and `pointsSoulbound`
    ///      is set. Batch transfers are gated per id.
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override
    {
        if (from != address(0) && to != address(0)) {
            for (uint256 i = 0; i < ids.length; ++i) {
                uint256 id = ids[i];
                bool bound = id == POINTS_ID ? pointsSoulbound : _receiptSoulbound[id];
                if (bound) revert ReceiptToken__Soulbound(id);
            }
        }
        super._update(from, to, ids, values);
    }

    /// @notice Whether a receipt for `orderId` has already been minted (the uniqueness guard).
    /// @param orderId The order reference.
    /// @return Whether its receipt exists.
    function receiptExists(bytes32 orderId) external view returns (bool) {
        return _receiptMinted[receiptId(orderId)];
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC165
    /// @dev Unions the ERC-1155 + {AccessControl} interface ids.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
