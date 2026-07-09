// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    Ownable2StepUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { Access0x1Router } from "./Access0x1Router.sol";
import { IAccess0x1SponsorRegistry } from "./interfaces/IAccess0x1SponsorRegistry.sol";

/// @title  Access0x1SponsorRegistry
/// @author Access0x1
/// @notice The on-chain "who sponsors this business's gas" record. A merchant's gasless flows
///         ({GaslessPayIn}'s signature rails) can be submitted by ANY relayer — this registry
///         turns that open role into a DECLARED, CONSENTED, publicly inspectable relationship:
///         a sponsor offers, the merchant's owner accepts, and `sponsorOf(merchantId)` becomes
///         the single record a dashboard reads (CONNECTED iff non-zero) and a relayer honors.
/// @dev    RECORD-ONLY (v1): holds no funds, gates no money path — {GaslessPayIn} does not read
///         this registry, so a stale record can never block a settlement (law: refunds and
///         money paths are never hostage to an auxiliary surface). The declared v2 rung is a
///         funded gas tank (sponsor escrow + relayer reimbursement) as its OWN audited module.
///
///         TENANT AUTHORITY IS THE ROUTER'S, READ LIVE: acceptance and merchant-side clearing
///         authorize against `router.merchants(id).owner` at call time — the audited registry,
///         never a copy, so a merchant-seat ownership handover moves this authority with it.
///         The contract `owner` (UUPS upgrade admin) holds NO authority over any record.
///
///         UPGRADEABILITY: the Access0x1 UUPS template shape — ERC1967 proxy storage,
///         `_disableInitializers()` in the impl constructor, owner-gated `_authorizeUpgrade`,
///         trailing `__gap`. `router` is plain storage set once in {initialize}.
contract Access0x1SponsorRegistry is
    IAccess0x1SponsorRegistry,
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable
{
    /// @notice The audited registry every module trusts. Set ONCE in {initialize}; no setter.
    Access0x1Router public router;

    /// @notice merchantId ⇒ the ACCEPTED sponsor (address(0) = none). THE record.
    mapping(uint256 merchantId => address sponsor) private _sponsorOf;

    /// @notice merchantId ⇒ a pending, not-yet-accepted offer (address(0) = none).
    mapping(uint256 merchantId => address sponsor) private _pendingSponsorOf;

    /// @dev Reserved storage slots for future appends (UUPS storage-collision safety). Shrink by
    ///      exactly the slots a later version appends; never reorder or insert above this gap.
    uint256[50] private __gap;

    /// @dev Burn the implementation's initializer so the logic contract can never be
    ///      initialized/owned/upgraded directly.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time initializer — binds the composed router and wires the upgrade admin.
    /// @param initialOwner The contract owner / upgrade admin (non-zero; no record authority).
    /// @param router_      The deployed {Access0x1Router} whose merchant registry authorizes
    ///                     every record action (non-zero).
    function initialize(address initialOwner, Access0x1Router router_) external initializer {
        if (address(router_) == address(0)) revert Access0x1SponsorRegistry__ZeroAddress();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        router = router_;
    }

    /*//////////////////////////////////////////////////////////////
                                RECORD
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1SponsorRegistry
    /// @dev Anyone may offer (inert data until accepted); the merchant seat must EXIST so an
    ///      offer can never be parked on an id that could later be claimed by a different
    ///      business (ids are assigned by the router, so an unregistered id has owner 0).
    ///      Last offer stands — a newer offer overwrites a pending one; the merchant accepts
    ///      at most one sponsor.
    function offerSponsorship(uint256 merchantId) external {
        if (_merchantOwner(merchantId) == address(0)) {
            revert Access0x1SponsorRegistry__MerchantUnknown(merchantId);
        }
        _pendingSponsorOf[merchantId] = msg.sender;
        emit SponsorshipOffered(merchantId, msg.sender);
    }

    /// @inheritdoc IAccess0x1SponsorRegistry
    /// @dev Only the merchant's owner, read LIVE. Accepting consumes the pending offer and
    ///      replaces any previously recorded sponsor (one sponsor per seat, the newest accepted).
    function acceptSponsor(uint256 merchantId) external {
        address merchantOwner = _merchantOwner(merchantId);
        if (merchantOwner == address(0)) {
            revert Access0x1SponsorRegistry__MerchantUnknown(merchantId);
        }
        if (msg.sender != merchantOwner) {
            revert Access0x1SponsorRegistry__NotMerchantOwner(merchantId, msg.sender);
        }
        address offered = _pendingSponsorOf[merchantId];
        if (offered == address(0)) {
            revert Access0x1SponsorRegistry__NoPendingOffer(merchantId);
        }
        delete _pendingSponsorOf[merchantId];
        _sponsorOf[merchantId] = offered;
        emit SponsorAccepted(merchantId, offered);
    }

    /// @inheritdoc IAccess0x1SponsorRegistry
    /// @dev Either side walks away: the merchant's owner (live read) or the wallet that is the
    ///      recorded OR pending sponsor. Clears both the record and any pending offer — after a
    ///      clear the dashboard honestly shows NOT-YET-WIRED again.
    function clearSponsor(uint256 merchantId) external {
        address recorded = _sponsorOf[merchantId];
        address pending = _pendingSponsorOf[merchantId];
        if (recorded == address(0) && pending == address(0)) {
            revert Access0x1SponsorRegistry__NothingToClear(merchantId);
        }
        bool byMerchant = msg.sender == _merchantOwner(merchantId);
        bool bySponsor = msg.sender == recorded || msg.sender == pending;
        if (!byMerchant && !bySponsor) {
            revert Access0x1SponsorRegistry__NotPartyToSponsorship(merchantId, msg.sender);
        }
        address cleared = recorded != address(0) ? recorded : pending;
        delete _sponsorOf[merchantId];
        delete _pendingSponsorOf[merchantId];
        emit SponsorCleared(merchantId, cleared, byMerchant);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAccess0x1SponsorRegistry
    function sponsorOf(uint256 merchantId) external view returns (address) {
        return _sponsorOf[merchantId];
    }

    /// @inheritdoc IAccess0x1SponsorRegistry
    function pendingSponsorOf(uint256 merchantId) external view returns (address) {
        return _pendingSponsorOf[merchantId];
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @notice Authorize a UUPS upgrade — the contract owner (upgrade admin) only.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }

    /// @dev The merchant's owner, read LIVE from the router registry. address(0) = never
    ///      registered, which every auth check above treats as "unknown seat".
    function _merchantOwner(uint256 merchantId) private view returns (address owner_) {
        (, owner_,,,,) = router.merchants(merchantId);
    }
}
