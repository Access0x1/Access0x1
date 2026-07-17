// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    Ownable2StepUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {
    ERC721Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {
    ERC721URIStorageUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721URIStorageUpgradeable.sol";
import {
    ERC2981Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/common/ERC2981Upgradeable.sol";
import {
    ReentrancyGuardTransient
} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Access0x1Router } from "./Access0x1Router.sol";
import { IPaymentLanes } from "./interfaces/IPaymentLanes.sol";
import { IReceivables } from "./interfaces/IReceivables.sol";

/// @title  Receivables
/// @author Access0x1
/// @notice An OPEN invoice minted as a TRANSFERABLE, FACTORABLE ERC-721: whoever HOLDS the token is the
///         on-chain creditor and receives the {Access0x1Router} settlement at pay time. A merchant
///         operator mints a receivable to an initial creditor for a USD face value in an allowlisted
///         settlement token (optionally locked to one debtor); the NFT is then a freely tradable claim —
///         a business can SELL or FACTOR its open invoice on any marketplace, and the buyer becomes the
///         creditor automatically. Paying a receivable pulls the quoted gross from the debtor, routes it
///         through the Router's fee-split (USD→token priced in-tx via a Chainlink feed, exact two-leg
///         fee, `net + fee == gross`), pays the NET to the CURRENT holder, and BURNS the token. A
///         receivable therefore settles AT MOST ONCE and pays exactly one creditor — the holder at
///         settlement time.
/// @dev    ERCs implemented:
///           - ERC-721 (+ Metadata): the receivable IS the token; transfer == assignment of the credit.
///           - ERC-4906 (Metadata-Update): `_setTokenURI` emits `MetadataUpdate` so a marketplace
///             refreshes a receivable's art/attributes when its URI changes; `supportsInterface`
///             advertises 4906 via the URI-storage base.
///           - ERC-2981 (Royalty): a default + per-token royalty on SECONDARY sales — the protocol-level
///             FACTORING-FEE signal (marketplaces voluntarily honor it on a factoring resale).
///           - EIP-7572 (draft) contractURI: collection-level metadata for marketplaces, surfaced via
///             {contractURI} + a `ContractURIUpdated` event (FLAGGED as draft below). It is NOT in
///             `supportsInterface` because EIP-7572 specifies no ERC-165 id (it is detected by the
///             presence of the function).
///
///         COMPOSES, never duplicates: this contract owns the receivable LIFECYCLE, the NFT, and the
///         net-forward to the live holder ONLY. ALL pricing + the entire fee split (platform cut →
///         treasury, merchant surcharge → feeRecipient, net → payout) and the USD→token quote live in
///         {Access0x1Router}; this contract NEVER re-derives a fee — it reads the router's live policy by
///         routing the full gross through `payToken`/`payNative` and measuring the NET it receives by a
///         balance delta. The conduit invariant: every receivable's `merchantId` must be a router
///         merchant whose `payout` is THIS contract (checked at mint), so the router's net is pushed
///         here and then forwarded, in the SAME tx, to `ownerOf(tokenId)`. Net custody across a
///         settlement is zero (pulled-then-forwarded); only the NFT is "held" — as ownership, the claim
///         itself — between mint and settle/cancel.
///
///         MONEY INVARIANT — exactly one creditor per OPEN receivable, paid at most once:
///         the creditor is NEVER stored; it is always the live `ownerOf(tokenId)`, so an ERC-721
///         transfer is the sole atomic way it changes (one holder ⇒ one creditor, by ERC-721). A `pay`
///         flips the status to terminal `SETTLED` and BURNS the token BEFORE any external call (CEI), so
///         a replay reverts (`NotOpen`, then the token no longer exists). The net forwarded equals
///         exactly what the router pushed here (measured, not re-derived), so `net + fee == gross`
///         remains the router's proven property and no value is created or skimmed in the hop.
///
///         UPGRADEABILITY (the Access0x1 UUPS TEMPLATE — every system contract follows this exact
///         shape): the contract is deployed behind an `ERC1967Proxy`; storage lives in the proxy, logic
///         in this implementation. State is set once via {initialize} (the constructor-replacement,
///         `initializer`-guarded) — including {router}, which is therefore PROXY storage, not a
///         logic-bytecode immutable. The implementation's own constructor calls `_disableInitializers()`
///         so the logic contract can never be initialized or hijacked directly. Upgrades route through
///         {upgradeToAndCall} and are authorized by {_authorizeUpgrade} (`onlyOwner` — the
///         `Ownable2StepUpgradeable` owner / upgrade admin, DISTINCT from the per-merchant owners read
///         live from the router). Calling `renounceOwnership()` permanently freezes the implementation.
///         A trailing `__gap` reserves slots for safe future storage appends.
contract Receivables is
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    ERC2981Upgradeable,
    ERC721URIStorageUpgradeable,
    ReentrancyGuardTransient,
    IReceivables
{
    using SafeERC20 for IERC20;

    /// @notice The native-token sentinel: `address(0)` as a "token" means the chain's native coin.
    address private constant NATIVE = address(0);

    /// @notice The shared, audited payments router this contract composes for ALL pricing + fee math.
    ///         Set once in {initialize} and never repointed (no setter) — the fee-split, the in-tx
    ///         USD→token quote, the merchant registry, and the zero-custody push are all delegated to
    ///         it. It is the FIRST app-specific storage slot (after the inherited bases' namespaced
    ///         ERC-7201 storage).
    Access0x1Router public router;

    /// @notice tokenId ⇒ the receivable record. The creditor is NOT here (it is `ownerOf(tokenId)`).
    mapping(uint256 tokenId => Receivable) private _receivables;

    /// @notice The id assigned to the next {mint}. Starts at 1, so 0 is an unset sentinel (matching the
    ///         router's `nextMerchantId` convention) — a tokenId is never 0.
    uint256 private _nextTokenId;

    /// @notice The collection-level metadata URI (EIP-7572 `contractURI`). Set by the upgrade admin.
    string private _contractURI;

    /// @notice tokenId ⇒ whether the receivable has been FACTORED (moved holder→holder on the secondary
    ///         market). Set by the {_update} hook; checked by {cancel}. Once a receivable is sold, the
    ///         claim is firm and the issuer can no longer void it — otherwise `cancel` would burn a
    ///         third party's purchased claim with no refund. Sticky: never cleared once set.
    mapping(uint256 tokenId => bool) private _factored;

    /// @dev Reserved storage slots so future versions can APPEND new state without shifting the layout
    ///      above (UUPS storage-collision safety). Each new variable added in a later version consumes
    ///      one slot from the head of this gap; shrink `__gap` by exactly the number of slots added so
    ///      the total stays 50. NEVER reorder or insert a variable above this gap — only append.
    ///      (`_factored` consumed one slot → 49.)
    uint256[49] private __gap;

    /// @dev The implementation is the logic half of a UUPS pair; its OWN storage is never used in
    ///      production (the proxy holds state). `_disableInitializers()` burns the implementation's
    ///      initializer so it can never be initialized — and therefore never owned or upgraded —
    ///      directly, closing the classic uninitialized-implementation takeover. Runs at
    ///      implementation-deploy time.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time initializer — the constructor-replacement for the proxy. Wires the upgradeable
    ///         bases (ERC-721 + URI-storage + ERC-2981, Ownable + its 2-step extension, and the UUPS
    ///         machinery), names the collection, and sets the composed router + the starting token id.
    ///         Guarded by `initializer`, so it runs exactly once per proxy; the typical deploy is
    ///         `new ERC1967Proxy(impl, abi.encodeCall(initialize, (..)))`.
    /// @dev    No `__UUPSUpgradeable_init()`: in OZ 5.x `UUPSUpgradeable` holds no initializable storage.
    ///         `initialOwner` becomes the upgrade admin; it must be non-zero (`__Ownable_init` reverts on
    ///         zero). `router_` must be non-zero — there is no setter, so it is effectively immutable per
    ///         proxy.
    /// @param router_         The deployed {Access0x1Router} every settlement composes.
    /// @param initialOwner    The contract owner / upgrade admin (non-zero).
    /// @param name_           The ERC-721 collection name.
    /// @param symbol_         The ERC-721 collection symbol.
    /// @param contractURI_    The initial EIP-7572 collection metadata URI ("" for none).
    function initialize(
        Access0x1Router router_,
        address initialOwner,
        string calldata name_,
        string calldata symbol_,
        string calldata contractURI_
    ) external initializer {
        if (address(router_) == address(0)) {
            revert Receivables__ZeroAddress();
        }
        __ERC721_init(name_, symbol_);
        __ERC721URIStorage_init();
        __ERC2981_init();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        router = router_;
        _nextTokenId = 1;
        _contractURI = contractURI_;
    }

    /*//////////////////////////////////////////////////////////////
                                  MINT
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IReceivables
    /// @dev    Auth + the conduit invariant: the caller must be `merchantId`'s router owner (read live
    ///         from `router.merchants(id)` — the single source of truth), AND that merchant's `payout`
    ///         must be THIS contract, so the router's net returns here at settlement to be forwarded to
    ///         the live holder. An unknown merchant has `owner == address(0)` (no caller equals it) and
    ///         is rejected by the owner check. CEI: checks (auth, conduit, non-zero amount/creditor) →
    ///         effects (write the record, advance the id) → interaction (mint the NFT, set its URI). The
    ///         token/feed validity is NOT checked here — it is enforced in-tx by the router's `quote` at
    ///         pay time, so a receivable can be minted before its token is allowlisted and still settles
    ///         safely once it is. `_safeMint` enforces `onERC721Received` for a contract creditor, so a
    ///         creditor that cannot hold ERC-721s is rejected at mint.
    function mint(
        uint256 merchantId,
        address creditor,
        address debtor,
        address token,
        uint256 amountUsd8,
        uint64 dueBy,
        string calldata uri
    ) external nonReentrant returns (uint256 tokenId) {
        if (creditor == address(0)) revert Receivables__ZeroAddress();
        if (amountUsd8 == 0) revert Receivables__ZeroAmount();
        (address payout, address merchantOwner) = _merchantPayoutAndOwner(merchantId);
        if (msg.sender != merchantOwner) {
            revert Receivables__NotMerchantOwner(merchantId, msg.sender);
        }
        // Conduit invariant: the merchant's router payout MUST be this contract, so a settlement's net
        // is pushed here (not to a fixed external payout) and can be forwarded to the CURRENT holder.
        if (payout != address(this)) {
            revert Receivables__MerchantPayoutNotConduit(merchantId, payout);
        }

        tokenId = _nextTokenId++;
        _receivables[tokenId] = Receivable({
            merchantId: merchantId,
            debtor: debtor,
            token: token,
            amountUsd8: amountUsd8,
            dueBy: dueBy,
            status: Status.OPEN
        });

        // Mint the receivable to the initial creditor, then stamp its metadata URI (URI-storage emits
        // the ERC-4906 MetadataUpdate). The NFT is now a freely transferable/factorable claim.
        _safeMint(creditor, tokenId);
        if (bytes(uri).length != 0) _setTokenURI(tokenId, uri);

        emit ReceivableMinted(tokenId, merchantId, creditor, debtor, token, amountUsd8, dueBy);
    }

    /*//////////////////////////////////////////////////////////////
                                  PAY
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IReceivables
    /// @dev    CEI: checks (OPEN + debtor authorization + token path) → effects (flip to terminal
    ///         SETTLED and BURN the token BEFORE any external call, so a re-entrant `pay` finds the
    ///         receivable no longer OPEN / no longer existent and reverts) → interactions (snapshot the
    ///         creditor, quote, pull the exact gross from the payer, route through the router's
    ///         fee-split, forward the net the router pushed here to the creditor). `nonReentrant` is
    ///         belt-and-suspenders on top of the state flip + burn. The contract holds ~zero token
    ///         balance afterwards: the router pulls the full approval and pushes net (here) + fee (out)
    ///         in the same call, and the net is immediately forwarded out. A fee-on-transfer token is
    ///         rejected by the pull's balance-delta check before routing.
    function pay(uint256 tokenId, bytes32 orderId) external nonReentrant {
        Receivable storage r = _receivables[tokenId];
        address token = _authorizePay(r, tokenId);
        if (token == NATIVE) revert Receivables__WrongPayPath(tokenId, token);

        uint256 merchantId = r.merchantId;
        uint256 amountUsd8 = r.amountUsd8;

        // CONDUIT RE-CHECK (live): mint enforced the merchant's router payout == this contract, but the
        // merchant owner can `updateMerchant` to repoint payout AFTER mint while still active. Re-verify
        // the LIVE payout here — a pure router view read, before any burn/state mutation (CEI-clean) — and
        // revert loudly if it was moved. Otherwise the router would push the net to the NEW payout, the
        // balance-delta below would read 0, and this contract would forward 0 to the creditor with the NFT
        // already burned: the creditor robbed, the money silently swallowed. Reverting keeps the claim
        // intact. Tradeoff (no upside for an attacker): a merchant who repoints payout now BLOCKS its own
        // settlement (griefing) rather than being able to STEAL — and it gains nothing (it was already paid
        // when the receivable was factored). Settlement resumes once payout is restored to the conduit.
        (address payout,) = _merchantPayoutAndOwner(merchantId);
        if (payout != address(this)) {
            revert Receivables__MerchantPayoutNotConduit(merchantId, payout);
        }

        // Snapshot the creditor (current holder) BEFORE the burn — they are the net beneficiary.
        address creditor = ownerOf(tokenId);

        // EFFECTS — terminal flip + burn before any interaction (single-settlement / no double-pay).
        r.status = Status.SETTLED;
        _burn(tokenId); // clears the URI-storage slot too; the tokenId no longer exists

        // INTERACTIONS — quote, pull the exact gross from the payer, route through the router split.
        // Snapshot the balance BEFORE pulling the gross: the conduit is BOTH the address the router
        // pulls the gross from AND the `payout` the router returns the net to, so across the
        // pull → payToken sequence the contract's balance rises by exactly `net` (gross in from the
        // payer, gross out to the router, net back from the router). Measuring from the pre-pull
        // baseline yields `net` directly and never re-derives a fee. (Capturing it AFTER the pull would
        // read `net - gross` and underflow.)
        uint256 gross = router.quote(merchantId, token, amountUsd8); // allowlist + feed + staleness
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        _pullExact(token, msg.sender, gross);

        // Snapshot our lane balance BEFORE the settle: this payout may be a SHARED conduit and a
        // co-tenant merchant's direct payToken can strand net in the SAME lane. We claim ONLY the delta
        // THIS settle credits (below), never that pre-existing balance — otherwise a receivable settle
        // would sweep another merchant's stranded funds to this creditor (cross-merchant theft).
        address lanes = router.paymentLanes();
        uint256 laneKey;
        uint256 laneBefore;
        if (lanes != address(0)) {
            laneKey = IPaymentLanes(lanes).laneId(block.chainid, token, address(this));
            laneBefore = IPaymentLanes(lanes).balanceOf(address(this), laneKey);
        }

        // Route the FULL gross through the audited fee-split. The router pulls `gross` from here (its
        // own in-tx quote equals ours — same feed round), sends the platform cut → treasury + the
        // merchant surcharge → feeRecipient, and pushes the NET back to THIS contract (the conduit
        // payout). We measure that net by the balance delta — never re-deriving a fee — and forward it.
        IERC20(token).forceApprove(address(router), gross);
        router.payToken(merchantId, token, amountUsd8, orderId);
        // Defensive: the router pulled the full approval via its own balance-delta check; reset any
        // residual to 0 so no dangling allowance survives (zero-custody hygiene).
        IERC20(token).forceApprove(address(router), 0);
        // If the router routed the net through PaymentLanes it was minted to THIS contract as an
        // ERC-6909 lane (our payout id), NOT pushed back as ERC-20. Claim back ONLY the amount this
        // settle just credited (laneAfter - laneBefore), leaving any co-tenant merchant's stranded
        // balance untouched in the shared lane, so `net` is exact and can never include another
        // merchant's funds (whether or not lanes are wired).
        if (lanes != address(0)) {
            uint256 credited = IPaymentLanes(lanes).balanceOf(address(this), laneKey) - laneBefore;
            if (credited > 0) {
                IPaymentLanes(lanes).claimLaneUpTo(laneKey, token, credited);
            }
        }
        uint256 net = IERC20(token).balanceOf(address(this)) - balBefore;

        // Forward the router's net to the creditor (holder-at-settlement). zero net custody.
        IERC20(token).safeTransfer(creditor, net);

        emit ReceivableSettled(tokenId, msg.sender, creditor, token, gross, net, orderId);
    }

    /// @inheritdoc IReceivables
    /// @dev    The native mirror of {pay}. CEI: flip to SETTLED + burn, quote the gross, require
    ///         `msg.value` covers it, forward exactly `gross` into `router.payNative` (which splits and
    ///         pushes the net back here as the conduit payout), forward the measured net to the creditor,
    ///         then refund the payer's excess. A failed refund DOES revert (the payer is present and must
    ///         not silently lose the excess); a failed net push to a contract creditor reverts the whole
    ///         settlement (it has not "settled" if the creditor cannot be paid — the burn rolls back with
    ///         it). `nonReentrant` + state-flip-and-burn-first.
    function payNative(uint256 tokenId, bytes32 orderId) external payable nonReentrant {
        Receivable storage r = _receivables[tokenId];
        address token = _authorizePay(r, tokenId);
        if (token != NATIVE) revert Receivables__WrongPayPath(tokenId, token);

        uint256 merchantId = r.merchantId;
        uint256 amountUsd8 = r.amountUsd8;

        // CONDUIT RE-CHECK (live): see {pay}. The merchant owner can repoint payout away from this conduit
        // after mint while still active; without this re-verify the router would push the net to the new
        // payout, the native balance-delta below would read 0, and the burned NFT's holder would be paid
        // nothing. Re-read the LIVE payout (a pure view read, before the burn — CEI-clean) and revert loudly
        // instead of swallowing. The griefing-not-theft tradeoff is documented in {pay}.
        (address payout,) = _merchantPayoutAndOwner(merchantId);
        if (payout != address(this)) {
            revert Receivables__MerchantPayoutNotConduit(merchantId, payout);
        }

        address creditor = ownerOf(tokenId);

        // EFFECTS — terminal flip + burn before any interaction.
        r.status = Status.SETTLED;
        _burn(tokenId);

        // INTERACTIONS — quote, check msg.value, forward exactly gross to the router, forward net.
        uint256 gross = router.quote(merchantId, NATIVE, amountUsd8);
        if (msg.value < gross) revert Receivables__Underpaid(gross, msg.value);

        // Forward exactly `gross`; the router re-quotes the same gross in this tx (same feed round),
        // splits it, and pushes the net back to this contract (its conduit payout). Measure the net as
        // the native-balance RISE across the router call, ISOLATED from the unspent excess still in this
        // frame: `msg.value` (gross + excess) already arrived, so subtracting exactly the `gross` we are
        // about to forward gives a baseline that already includes the excess; after the router pushes
        // `net` back, the rise above that baseline is precisely `net` (the excess cancels in the delta,
        // as does any pre-existing balance). The router owns the fee math; we never re-derive it.
        uint256 balBefore = address(this).balance - gross;
        router.payNative{ value: gross }(merchantId, amountUsd8, orderId);
        uint256 net = address(this).balance - balBefore;

        // Forward the net to the creditor (holder-at-settlement); a contract creditor that rejects it
        // reverts the whole settlement (the burn rolls back too) — never a silent loss.
        if (net > 0) {
            // slither-disable-next-line low-level-calls
            (bool okNet,) = creditor.call{ value: net }("");
            if (!okNet) revert Receivables__CreditorPushFailed(creditor, net);
        }

        // Refund the payer's excess (present-party, so a failure reverts rather than stranding funds).
        uint256 refund = msg.value - gross;
        if (refund > 0) {
            // slither-disable-next-line low-level-calls
            (bool okRefund,) = msg.sender.call{ value: refund }("");
            if (!okRefund) revert Receivables__NativeRefundFailed(msg.sender, refund);
        }

        emit ReceivableSettled(tokenId, msg.sender, creditor, NATIVE, gross, net, orderId);
    }

    /*//////////////////////////////////////////////////////////////
                                 CANCEL
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IReceivables
    /// @dev    `onlyMerchantOwner` + OPEN-only: a SETTLED receivable can never be cancelled (its token no
    ///         longer exists), and only the merchant owner can void an unpaid one. `OPEN → CANCELLED` is
    ///         one-way; the token is burned so the cancelled claim cannot be transferred or paid.
    function cancel(uint256 tokenId) external {
        Receivable storage r = _receivables[tokenId];
        Status status = r.status;
        if (status != Status.OPEN) revert Receivables__NotOpen(tokenId, status);
        (, address merchantOwner) = _merchantPayoutAndOwner(r.merchantId);
        if (msg.sender != merchantOwner) {
            revert Receivables__NotMerchantOwner(r.merchantId, msg.sender);
        }
        // A FACTORED receivable (sold to a secondary holder) is a firm claim: the issuer can no longer
        // void it, or this burn would destroy the factor's purchased NFT with zero refund while the
        // issuer keeps the sale proceeds and re-collects the debt. Mirrors the pay()/payNative() conduit
        // re-check's "grief, never STEAL" principle — the issuer may void ONLY what it has not sold.
        if (_factored[tokenId]) revert Receivables__AlreadyFactored(tokenId);

        r.status = Status.CANCELLED;
        _burn(tokenId);
        emit ReceivableCancelled(tokenId);
    }

    /*//////////////////////////////////////////////////////////////
                                ROYALTY
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IReceivables
    /// @dev    `onlyOwner` (the upgrade admin) — the protocol-level factoring-fee policy. A zero
    ///         `receiver` clears the default royalty (OZ `_deleteDefaultRoyalty`); else the fraction
    ///         must not exceed `_feeDenominator()` (OZ's `_setDefaultRoyalty` enforces this, surfaced
    ///         here as the typed {Receivables__RoyaltyTooHigh} via the pre-check).
    function setDefaultRoyalty(address receiver, uint96 feeNumerator) external onlyOwner {
        if (receiver == address(0)) {
            _deleteDefaultRoyalty();
            return;
        }
        uint96 denom = _feeDenominator();
        if (feeNumerator > denom) revert Receivables__RoyaltyTooHigh(feeNumerator, denom);
        _setDefaultRoyalty(receiver, feeNumerator);
    }

    /// @inheritdoc IReceivables
    /// @dev    `onlyOwner`. The per-token royalty overrides the default for one receivable (e.g. a
    ///         bespoke factoring fee on a large invoice). Zero `receiver` resets it to the default.
    function setTokenRoyalty(uint256 tokenId, address receiver, uint96 feeNumerator)
        external
        onlyOwner
    {
        if (receiver == address(0)) {
            _resetTokenRoyalty(tokenId);
            return;
        }
        uint96 denom = _feeDenominator();
        if (feeNumerator > denom) revert Receivables__RoyaltyTooHigh(feeNumerator, denom);
        _setTokenRoyalty(tokenId, receiver, feeNumerator);
    }

    /*//////////////////////////////////////////////////////////////
                            METADATA (EIP-7572)
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IReceivables
    /// @dev    EIP-7572 (DRAFT): collection-level metadata for marketplaces. The draft specifies no
    ///         ERC-165 interface id, so this is detected by function presence, not `supportsInterface`.
    function contractURI() external view returns (string memory) {
        return _contractURI;
    }

    /// @inheritdoc IReceivables
    /// @dev    `onlyOwner` (the upgrade admin). Emits {ContractURIUpdated} so a marketplace re-reads the
    ///         collection metadata (the EIP-7572 update signal).
    function setContractURI(string calldata newContractURI) external onlyOwner {
        _contractURI = newContractURI;
        emit ContractURIUpdated(newContractURI);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IReceivables
    function receivableOf(uint256 tokenId) external view returns (Receivable memory) {
        return _receivables[tokenId];
    }

    /// @inheritdoc IReceivables
    function creditorOf(uint256 tokenId) external view returns (address) {
        return ownerOf(tokenId); // reverts for a non-existent/burned token (ERC-721 semantics)
    }

    /// @inheritdoc IReceivables
    function isPayable(uint256 tokenId) external view returns (bool) {
        return _receivables[tokenId].status == Status.OPEN;
    }

    /// @inheritdoc IReceivables
    function isFactored(uint256 tokenId) external view returns (bool) {
        return _factored[tokenId];
    }

    /// @inheritdoc IReceivables
    function nextTokenId() external view returns (uint256) {
        return _nextTokenId;
    }

    /*//////////////////////////////////////////////////////////////
                          ERC-165 / OVERRIDES
    //////////////////////////////////////////////////////////////*/

    /// @notice ERC-165: advertise ERC-721, ERC-721-Metadata, ERC-4906 (via the URI-storage base), and
    ///         ERC-2981. EIP-7572 has no interface id, so it is intentionally absent.
    /// @dev    The diamond requires an explicit override across the URI-storage (ERC-721 + 4906) and
    ///         ERC-2981 branches; `super` walks both via C3 linearization.
    /// @param interfaceId The ERC-165 interface id queried.
    /// @return True iff the interface is supported.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorageUpgradeable, ERC2981Upgradeable, IERC165)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    /// @notice ERC-721 transfer hook — flags a receivable as FACTORED the moment it moves between two
    ///         real holders (a secondary-market sale), which locks {cancel} out (a sold claim is firm).
    /// @dev    `from == address(0)` is the mint and `to == address(0)` is the burn (cancel/settle);
    ///         neither is a factoring transfer, so ONLY a holder→holder move sets the flag. The flag is
    ///         sticky (never cleared), so a receivable that round-trips back to its initial creditor
    ///         still cannot be voided — conservative by design: any secondary movement makes it firm.
    /// @param  to      The recipient (zero on burn).
    /// @param  tokenId The receivable moving.
    /// @param  auth    The address the ERC-721 base authorizes the move against.
    /// @return from    The previous holder (zero on mint), per the ERC-721 base.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721Upgradeable)
        returns (address)
    {
        address from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0)) {
            _factored[tokenId] = true;
        }
        return from;
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @notice Authorize a UUPS upgrade. Restricted to the contract `owner` (the upgrade admin) — the
    ///         single gate {upgradeToAndCall} consults before swapping the implementation.
    /// @dev    Empty body: the `onlyOwner` modifier IS the policy. Once `renounceOwnership()` sets the
    ///         owner to address(0), every call here reverts, so the implementation becomes permanently
    ///         immutable (the on-chain "freeze"). `newImplementation` is intentionally unnamed — no
    ///         per-target allow-listing; the owner is fully trusted to vet the target off-chain.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }

    /// @dev Read a router merchant's `payout` and `owner` in one call. A never-registered merchant
    ///      returns `(address(0), address(0))`, which the owner-equality and conduit checks reject (no
    ///      caller is address(0); this contract is never address(0)).
    function _merchantPayoutAndOwner(uint256 merchantId)
        private
        view
        returns (address payout, address owner_)
    {
        (payout, owner_,,,,) = router.merchants(merchantId);
    }

    /// @dev The shared pay-path precondition gate: the receivable must exist + be OPEN, and (if locked)
    ///      `msg.sender` must be the locked debtor. Returns the receivable's immutable settlement token
    ///      so the caller can branch on the native/ERC-20 path. Reverts otherwise — no state is mutated.
    ///      A non-existent receivable reads `status == NONE`, caught by the OPEN check.
    function _authorizePay(Receivable storage r, uint256 tokenId)
        private
        view
        returns (address token)
    {
        Status status = r.status;
        if (status != Status.OPEN) revert Receivables__NotOpen(tokenId, status);
        address lockedDebtor = r.debtor;
        if (lockedDebtor != address(0) && msg.sender != lockedDebtor) {
            revert Receivables__NotAuthorizedDebtor(tokenId, lockedDebtor, msg.sender);
        }
        token = r.token;
    }

    /// @dev Pull exactly `amount` of an ERC-20 in, verifying via the balance delta that the token did
    ///      not skim (fee-on-transfer / rebasing) — those are rejected so the router always splits the
    ///      full gross. Mirrors the router's own `_pullExact` so the doctrine is identical at both hops.
    function _pullExact(address token, address from, uint256 amount) private {
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(from, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        if (received != amount) revert Receivables__FeeOnTransferToken(amount, received);
    }

    /// @notice Accept native value pushed in by the router (the conduit net leg of a {payNative}
    ///         settlement). The contract only ever holds native transiently inside its own `payNative`
    ///         frame, which forwards it to the creditor in the same call.
    /// @dev    Deliberately minimal: the router's `_pushNativeOrQueue` sends the net here with a bare
    ///         call, so a `receive()` is required or the net would be queued to the router's rescue map
    ///         instead of reaching the creditor. No reentrancy is possible — `payNative` is
    ///         `nonReentrant` and the router itself holds the lock while pushing.
    receive() external payable { }
}
