// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { ERC721Royalty } from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Royalty.sol";
import { ERC2981 } from "@openzeppelin/contracts/token/common/ERC2981.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title  TicketToken
/// @author Access0x1
/// @notice A VANILLA, CLONEABLE event-ticketing NFT: a plain OZ ERC-721 with per-token seat/tier
///         metadata, an operator-configurable TRANSFER WINDOW (resale on/off + an optional cutoff), a
///         one-way CHECK-IN (flag or burn), and a param'd ERC-2981 royalty. Every ticket is one seat at
///         one event; the contract records the seat and its lifecycle, nothing more. It composes NO
///         money path — the SALE is settled by the shared {Access0x1Router} (USD→token, fee-split,
///         zero-custody) and the ticket is minted on that settlement — so this contract holds no funds
///         and re-derives no fee logic.
/// @dev    REUSABLE-BASE RULES (nothing privileged, nothing hardcoded):
///           - `admin_` is a CONSTRUCTOR PARAM holding only `DEFAULT_ADMIN_ROLE`; it grants
///             {MINTER_ROLE} (the sale/settlement leg) and {CHECKIN_ROLE} (the gate operator) to
///             whatever backend a deployment chooses. No address is baked in.
///           - The royalty receiver + bps are CONSTRUCTOR PARAMS (`royaltyReceiver_`, `royaltyBps_`),
///             validated `<= MAX_ROYALTY_BPS`, and re-settable per-token or globally by the admin. bps
///             is the ERC-2981 fraction of sale price (denominator 10_000) — the same bps model the
///             router's fee uses — so a marketplace that honors ERC-2981 pays the creator on resale.
///           - The transfer policy is per-token config, defaulting to FREELY TRANSFERABLE. An operator
///             may set a ticket non-transferable (will-call only) and/or a `transfersFrozenAfter`
///             timestamp (no resale once doors are near). The policy NEVER blocks the mint (primary
///             sale) or the check-in burn — only wallet-to-wallet resale.
///         ENFORCEMENT lives in {_update} (OZ 5.x's single transfer choke-point), so plain, approved,
///         and safe transfers are gated identically; MINT (`from == 0`) and CHECK-IN BURN (`to == 0`)
///         always pass. CHECK-IN is one-way and idempotency-guarded: a ticket checks in at most once,
///         and a checked-in ticket can never resell (it is spent). {ticketURI} is per-token; the base
///         URI is admin-set.
contract TicketToken is ERC721Royalty, AccessControl {
    /*//////////////////////////////////////////////////////////////
                                 ROLES
    //////////////////////////////////////////////////////////////*/

    /// @notice May mint tickets — the SALE/settlement leg (a router-settled purchase, a box office).
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice May check a ticket in at the gate (flag or burn) and (re)configure a ticket's policy.
    bytes32 public constant CHECKIN_ROLE = keccak256("CHECKIN_ROLE");

    /*//////////////////////////////////////////////////////////////
                                 CONFIG
    //////////////////////////////////////////////////////////////*/

    /// @notice Hard ceiling on the ERC-2981 royalty: 10% (1000 bps). No configuration can exceed it, so
    ///         a clone can never set a confiscatory resale royalty. Matches the router's fee ceiling.
    uint96 public constant MAX_ROYALTY_BPS = 1000;

    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice Per-ticket seat/tier record. Immutable at mint except `checkedIn` (one-way false→true).
    /// @dev    Packs `tier` + `checkedIn` beside the two `uint64`s; `seatId` and `eventId` are opaque
    ///         (a seat map hash, an event key) so any venue/format reuses the same layout.
    struct Ticket {
        uint64 eventId; // opaque event key (a show, a date, a session)
        uint64 seatId; // opaque seat/GA reference (0 = general admission)
        uint32 tier; // tier index (0-based; the metadata resolves its name/price)
        bool checkedIn; // one-way: set true at the gate, never cleared
        bool nonTransferable; // true ⇒ will-call only (no wallet-to-wallet resale)
        uint64 transfersFrozenAfter; // resale blocked at/after this unix time (0 = never freezes)
    }

    /// @notice tokenId ⇒ its immutable-at-mint seat record (only `checkedIn` mutates, one-way).
    mapping(uint256 tokenId => Ticket ticket) private _tickets;

    /// @notice tokenId ⇒ per-token metadata URI. Set at mint; the full URI is returned verbatim.
    mapping(uint256 tokenId => string uri) private _ticketURI;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice A ticket was minted for `eventId`/`seatId` at `tier` to `to`.
    event TicketMinted(
        uint256 indexed tokenId, uint64 indexed eventId, uint64 seatId, uint32 tier, address indexed to
    );

    /// @notice A ticket's resale policy changed (transferability and/or the freeze cutoff).
    event TicketPolicySet(
        uint256 indexed tokenId, bool nonTransferable, uint64 transfersFrozenAfter
    );

    /// @notice A ticket was checked in at the gate. `burned` distinguishes flag-only from burn-on-entry.
    event CheckedIn(uint256 indexed tokenId, address indexed holder, bool burned);

    /// @notice A zero address was supplied where a non-zero one is required.
    error TicketToken__ZeroAddress();

    /// @notice The requested royalty exceeds `MAX_ROYALTY_BPS`.
    error TicketToken__RoyaltyTooHigh(uint96 requested, uint96 max);

    /// @notice The ticket is already checked in — it is spent and cannot be re-used or resold.
    error TicketToken__AlreadyCheckedIn(uint256 tokenId);

    /// @notice A resale was attempted on a non-transferable ticket (will-call only).
    error TicketToken__NonTransferable(uint256 tokenId);

    /// @notice A resale was attempted at/after the ticket's transfer-freeze cutoff.
    error TicketToken__TransfersFrozen(uint256 tokenId, uint64 frozenAfter);

    /// @notice A resale was attempted on a ticket already checked in (spent).
    error TicketToken__CheckedInNonTransferable(uint256 tokenId);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploy a fresh ticket collection. `admin_` is the only configured authority (holds
    ///         `DEFAULT_ADMIN_ROLE`); it grants {MINTER_ROLE}/{CHECKIN_ROLE} per its own governance. The
    ///         default royalty is set from params (receiver + bps ≤ `MAX_ROYALTY_BPS`); a zero receiver
    ///         with zero bps is allowed (no royalty), but a non-zero bps requires a non-zero receiver.
    /// @param name_             The ERC-721 collection name.
    /// @param symbol_           The ERC-721 collection symbol.
    /// @param admin_            The role admin (non-zero). Receives `DEFAULT_ADMIN_ROLE` only.
    /// @param royaltyReceiver_  The ERC-2981 default royalty receiver (may be zero iff `royaltyBps_==0`).
    /// @param royaltyBps_       The default royalty in bps (≤ `MAX_ROYALTY_BPS`).
    constructor(
        string memory name_,
        string memory symbol_,
        address admin_,
        address royaltyReceiver_,
        uint96 royaltyBps_
    ) ERC721(name_, symbol_) {
        if (admin_ == address(0)) revert TicketToken__ZeroAddress();
        if (royaltyBps_ > MAX_ROYALTY_BPS) {
            revert TicketToken__RoyaltyTooHigh(royaltyBps_, MAX_ROYALTY_BPS);
        }
        if (royaltyBps_ > 0 && royaltyReceiver_ == address(0)) revert TicketToken__ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        if (royaltyBps_ > 0) _setDefaultRoyalty(royaltyReceiver_, royaltyBps_);
    }

    /*//////////////////////////////////////////////////////////////
                                 ISSUE
    //////////////////////////////////////////////////////////////*/

    /// @notice Mint a ticket. Only {MINTER_ROLE} (the router-settled sale leg or a box office). The seat
    ///         record and metadata URI are written once; the ticket starts freely transferable unless
    ///         `nonTransferable`/`transfersFrozenAfter` are set here.
    /// @param to                   The buyer/holder (non-zero, must accept ERC-721 via safeMint).
    /// @param tokenId              The ticket id to mint (must not already exist).
    /// @param eventId              Opaque event key recorded on the ticket.
    /// @param seatId               Opaque seat reference (0 = general admission).
    /// @param tier                 Tier index (metadata resolves its meaning).
    /// @param nonTransferable      True ⇒ will-call only (no resale).
    /// @param transfersFrozenAfter Unix time at/after which resale is blocked (0 = never).
    /// @param uri                  The per-token metadata URI (may be empty).
    function mint(
        address to,
        uint256 tokenId,
        uint64 eventId,
        uint64 seatId,
        uint32 tier,
        bool nonTransferable,
        uint64 transfersFrozenAfter,
        string calldata uri
    ) external onlyRole(MINTER_ROLE) {
        _tickets[tokenId] = Ticket({
            eventId: eventId,
            seatId: seatId,
            tier: tier,
            checkedIn: false,
            nonTransferable: nonTransferable,
            transfersFrozenAfter: transfersFrozenAfter
        });
        if (bytes(uri).length != 0) _ticketURI[tokenId] = uri;
        emit TicketMinted(tokenId, eventId, seatId, tier, to);
        emit TicketPolicySet(tokenId, nonTransferable, transfersFrozenAfter);
        _safeMint(to, tokenId);
    }

    /*//////////////////////////////////////////////////////////////
                              POLICY / GATE
    //////////////////////////////////////////////////////////////*/

    /// @notice (Re)configure a ticket's resale policy. Only {CHECKIN_ROLE} (the event operator). Cannot
    ///         change a ticket that is already checked in (spent). Setting `nonTransferable` true or a
    ///         past `transfersFrozenAfter` locks resale; both false/0 reopens it.
    /// @param tokenId              The ticket to reconfigure (must exist).
    /// @param nonTransferable      True ⇒ block resale (will-call only).
    /// @param transfersFrozenAfter Unix time at/after which resale is blocked (0 = never).
    function setTicketPolicy(uint256 tokenId, bool nonTransferable, uint64 transfersFrozenAfter)
        external
        onlyRole(CHECKIN_ROLE)
    {
        Ticket storage t = _tickets[tokenId];
        _requireOwned(tokenId); // reverts for a nonexistent ticket
        if (t.checkedIn) revert TicketToken__AlreadyCheckedIn(tokenId);
        t.nonTransferable = nonTransferable;
        t.transfersFrozenAfter = transfersFrozenAfter;
        emit TicketPolicySet(tokenId, nonTransferable, transfersFrozenAfter);
    }

    /// @notice Check a ticket in at the gate. Only {CHECKIN_ROLE}. One-way and idempotency-guarded: a
    ///         ticket checks in at most once. If `burn` is true the ticket is burned on entry (single-use,
    ///         no re-admission); otherwise it is flagged `checkedIn` (kept as a collectible/stamp that can
    ///         never resell again). Either way the ticket is thereafter SPENT.
    /// @param tokenId The ticket to admit (must exist and not already be checked in).
    /// @param burn    True ⇒ burn on entry; false ⇒ flag and keep.
    function checkIn(uint256 tokenId, bool burn) external onlyRole(CHECKIN_ROLE) {
        address holder = _requireOwned(tokenId);
        Ticket storage t = _tickets[tokenId];
        if (t.checkedIn) revert TicketToken__AlreadyCheckedIn(tokenId);
        t.checkedIn = true; // one-way, set before the burn (CEI)
        emit CheckedIn(tokenId, holder, burn);
        if (burn) _burn(tokenId);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice The full seat record for `tokenId` (zeroed for a nonexistent/burned ticket).
    /// @param tokenId The ticket id.
    /// @return The {Ticket} record.
    function ticketOf(uint256 tokenId) external view returns (Ticket memory) {
        return _tickets[tokenId];
    }

    /// @notice Whether `tokenId` has been checked in (spent). True even after a check-in burn.
    /// @param tokenId The ticket id.
    /// @return Whether the ticket is checked in.
    function isCheckedIn(uint256 tokenId) external view returns (bool) {
        return _tickets[tokenId].checkedIn;
    }

    /// @inheritdoc ERC721
    /// @dev Returns the per-token URI set at mint (empty string if none). Independent of any base URI.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _ticketURI[tokenId];
    }

    /*//////////////////////////////////////////////////////////////
                          ROYALTY ADMIN (ERC-2981)
    //////////////////////////////////////////////////////////////*/

    /// @notice Set the collection-wide default royalty. Only `DEFAULT_ADMIN_ROLE`. `bps ≤ MAX_ROYALTY_BPS`;
    ///         a non-zero bps requires a non-zero receiver.
    /// @param receiver The royalty receiver.
    /// @param bps      The royalty in basis points (≤ `MAX_ROYALTY_BPS`).
    function setDefaultRoyalty(address receiver, uint96 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_ROYALTY_BPS) revert TicketToken__RoyaltyTooHigh(bps, MAX_ROYALTY_BPS);
        if (bps > 0 && receiver == address(0)) revert TicketToken__ZeroAddress();
        _setDefaultRoyalty(receiver, bps);
    }

    /// @notice Set a per-ticket royalty override (takes precedence over the default). Only
    ///         `DEFAULT_ADMIN_ROLE`. `bps ≤ MAX_ROYALTY_BPS`; a non-zero bps requires a non-zero receiver.
    /// @param tokenId  The ticket to override.
    /// @param receiver The royalty receiver for this ticket.
    /// @param bps      The royalty in basis points (≤ `MAX_ROYALTY_BPS`).
    function setTokenRoyalty(uint256 tokenId, address receiver, uint96 bps)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (bps > MAX_ROYALTY_BPS) revert TicketToken__RoyaltyTooHigh(bps, MAX_ROYALTY_BPS);
        if (bps > 0 && receiver == address(0)) revert TicketToken__ZeroAddress();
        _setTokenRoyalty(tokenId, receiver, bps);
    }

    /*//////////////////////////////////////////////////////////////
                              ENFORCEMENT
    //////////////////////////////////////////////////////////////*/

    /// @dev The single OZ 5.x transfer choke-point. MINT (`from == 0`) and CHECK-IN BURN (`to == 0`)
    ///      always pass — the primary sale and the gate must never be blocked by resale policy. A
    ///      wallet-to-wallet RESALE (both non-zero) is gated: a checked-in (spent) ticket, a
    ///      non-transferable ticket, or a ticket at/after its freeze cutoff cannot move. So a ticket is
    ///      freely resellable by default, and an operator's will-call / freeze / used-ticket rules are
    ///      enforced on every ERC-721 entry point uniformly.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        // Resale = both endpoints non-zero (mint has from==0, burn has to==0; both bypass policy).
        if (from != address(0) && to != address(0)) {
            Ticket storage t = _tickets[tokenId];
            if (t.checkedIn) revert TicketToken__CheckedInNonTransferable(tokenId);
            if (t.nonTransferable) revert TicketToken__NonTransferable(tokenId);
            uint64 frozenAfter = t.transfersFrozenAfter;
            if (frozenAfter != 0 && block.timestamp >= frozenAfter) {
                revert TicketToken__TransfersFrozen(tokenId, frozenAfter);
            }
        }
        return super._update(to, tokenId, auth);
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC165
    /// @dev Unions the ERC-721 + ERC-2981 (via {ERC721Royalty}) and {AccessControl} interface ids.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Royalty, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
