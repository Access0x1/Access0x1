// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IAccess0x1SponsorRegistry
/// @author Access0x1
/// @notice The external surface of {Access0x1SponsorRegistry} — the STRUCTURED, inspectable
///         on-chain record linking a merchant to its GAS SPONSOR. "Sponsor wired to this
///         business" is a real question a dashboard must answer truthfully, so the answer lives
///         on-chain where anyone can read it: `sponsorOf(merchantId)` is non-zero exactly when a
///         sponsor has offered AND the merchant's owner has accepted. The record is the v1
///         product: it names WHO submits (and pays gas for) the merchant's gasless flows — the
///         relayer role {GaslessPayIn} leaves open to "any submitter" becomes a declared,
///         consented relationship a UI can display and a relayer can honor.
/// @dev    RECORD-ONLY BY DESIGN (v1). This contract holds NO funds and gates NO money path:
///         {GaslessPayIn} remains open to any relayer (the buyer's signatures are what authorize
///         a settlement — see its docs), so a wrong or stale sponsor record can never block or
///         redirect a payment (law: money paths roll back, never swallow; nothing here is ON a
///         money path at all). The declared upgrade rung — NOT built here, never implied live —
///         is a funded gas tank (sponsor escrows gas money, relayers draw reimbursement), which
///         would arrive as its own audited module.
///
///         CONSENT IS TWO-STEP. Anyone may OFFER to sponsor a merchant (an offer is inert data),
///         but the record only binds when the MERCHANT'S OWNER accepts — read LIVE from
///         `router.merchants(id).owner`, the registry every module trusts. Either side may walk
///         away (`clearSponsor`), because a sponsorship neither party wants is just stale truth.
interface IAccess0x1SponsorRegistry {
    // ──────────────────────── events ────────────────────────

    /// @notice A sponsor offered to fund a merchant's gasless flows. Inert until accepted.
    /// @param merchantId The merchant seat the offer targets.
    /// @param sponsor    The wallet offering to sponsor (the caller).
    event SponsorshipOffered(uint256 indexed merchantId, address indexed sponsor);

    /// @notice The merchant's owner accepted the pending offer — the record is now WIRED.
    /// @param merchantId The merchant seat.
    /// @param sponsor    The sponsor now on record.
    event SponsorAccepted(uint256 indexed merchantId, address indexed sponsor);

    /// @notice The sponsorship record (or a pending offer) was cleared.
    /// @param merchantId The merchant seat.
    /// @param sponsor    The sponsor that was on record (or pending), now cleared.
    /// @param byMerchant True when the merchant's owner cleared it; false when the sponsor
    ///                   walked away.
    event SponsorCleared(uint256 indexed merchantId, address indexed sponsor, bool byMerchant);

    // ──────────────────────── errors ────────────────────────

    /// @notice A zero address was supplied where a non-zero one is required.
    error Access0x1SponsorRegistry__ZeroAddress();

    /// @notice The merchant seat does not exist on the router (owner == address(0)).
    error Access0x1SponsorRegistry__MerchantUnknown(uint256 merchantId);

    /// @notice Caller is not the merchant's owner (read live from the router registry).
    error Access0x1SponsorRegistry__NotMerchantOwner(uint256 merchantId, address caller);

    /// @notice {acceptSponsor} with no pending offer to accept.
    error Access0x1SponsorRegistry__NoPendingOffer(uint256 merchantId);

    /// @notice {clearSponsor} by an address that is neither the merchant's owner nor the
    ///         recorded/pending sponsor.
    error Access0x1SponsorRegistry__NotPartyToSponsorship(uint256 merchantId, address caller);

    /// @notice Nothing recorded or pending to clear.
    error Access0x1SponsorRegistry__NothingToClear(uint256 merchantId);

    // ──────────────────────── views ────────────────────────

    /// @notice THE record: the sponsor wired to this merchant, or address(0) when none. A
    ///         dashboard renders CONNECTED exactly when this is non-zero — never from prose.
    function sponsorOf(uint256 merchantId) external view returns (address);

    /// @notice A pending, not-yet-accepted offer (address(0) when none). Renders as an
    ///         actionable "offer awaiting your acceptance" for the merchant's owner.
    function pendingSponsorOf(uint256 merchantId) external view returns (address);

    // ──────────────────────── mutating ────────────────────────

    /// @notice Offer to sponsor a merchant's gasless flows. Callable by ANY wallet (the offer is
    ///         inert data until the merchant accepts); overwrites the caller's own earlier offer
    ///         or a competing pending offer (last offer stands — the merchant accepts at most one).
    /// @param merchantId The merchant seat (must exist on the router).
    function offerSponsorship(uint256 merchantId) external;

    /// @notice Accept the pending offer. Only the merchant's owner (live router read) may call.
    ///         Replaces any previously recorded sponsor with the accepted one.
    /// @param merchantId The merchant seat.
    function acceptSponsor(uint256 merchantId) external;

    /// @notice Clear the recorded sponsorship AND any pending offer. Callable by the merchant's
    ///         owner (live read) or by the recorded/pending sponsor itself — either side may
    ///         walk away.
    /// @param merchantId The merchant seat.
    function clearSponsor(uint256 merchantId) external;
}
