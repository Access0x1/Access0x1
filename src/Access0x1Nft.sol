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
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {
    ReentrancyGuardTransient
} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import { Access0x1Router } from "./Access0x1Router.sol";

/// @title  Access0x1Nft
/// @author Rensley R. @vyperpilleddev
/// @notice A USD-priced, ZERO-CUSTODY NFT COMMERCE primitive: a seller lists an ERC-721 at a USD
///         price; a buyer pays an allowlisted, USD-priced token (USDC by default) and the NFT
///         transfers to the buyer ATOMICALLY in the same tx. The payment is priced and fee-split by
///         {Access0x1Router} (USD→token via a Chainlink feed read in-tx, exact two-leg fee split,
///         net→seller + fee→treasury) — this contract NEVER re-derives the fee logic and NEVER holds
///         a payment token. The only thing it escrows is the listed NFT, and only until the matching
///         purchase settles or the seller cancels.
/// @dev    COMPOSES — never duplicates — the audited Router:
///           - AUTHORIZATION: a listing is bound to the seller's Router `merchantId`; only that
///             merchant's Router `owner` may list/cancel under it, read straight from
///             `Router.merchants(id)` (single source of truth, same pattern as the sibling ledgers).
///           - MONEY: {buy} pulls exactly the quoted token amount from the buyer, approves the Router
///             for it, and calls `Router.payToken(merchantId, ...)`. The Router pulls that gross from
///             THIS contract (so the seller's net lands at the merchant payout and the fee legs split
///             exactly as for any direct payment), then this contract `safeTransferFrom`s the escrowed
///             NFT to the buyer. Net custody of the payment token across {buy} is zero.
///         CUSTODY MODEL — the NFT sits in escrow between {list} and {buy}/{cancelListing}; the
///         payment token is never held (pulled-and-forwarded inside one tx). CEI + `nonReentrant`
///         guard every state-mutating path; the NFT leg uses `safeTransferFrom` + {onERC721Received}
///         so a contract buyer that cannot receive ERC-721s is rejected BEFORE money is committed in
///         the listing direction, and a malicious NFT/token callback cannot re-enter to double-spend.
///         A {cancelListing} (refund-of-asset) is NEVER blocked by a pause — the seller can always
///         retrieve an unsold NFT (no hostage assets, the asset-side analogue of law #5).
///
///         UPGRADEABILITY (the Access0x1 UUPS TEMPLATE — every other system contract follows this exact
///         shape): the contract is deployed behind an `ERC1967Proxy`; storage lives in the proxy, logic
///         in this implementation. State is set once via {initialize} (the constructor-replacement,
///         `initializer`-guarded) — including the {router} reference, which is therefore PROXY storage,
///         not a logic-bytecode immutable (an immutable would read from the impl, not the proxy). The
///         implementation's own constructor calls `_disableInitializers()` so the logic contract can
///         never be initialized or hijacked directly. Upgrades route through {upgradeToAndCall} and are
///         authorized by {_authorizeUpgrade} (`onlyOwner` — the `Ownable2StepUpgradeable` owner / upgrade
///         admin). Calling `renounceOwnership()` permanently freezes the implementation (no owner ⇒ no
///         authorized upgrade ⇒ immutable forever). A trailing `__gap` reserves slots for safe future
///         storage appends.
contract Access0x1Nft is
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardTransient,
    IERC721Receiver
{
    using SafeERC20 for IERC20;

    /// @notice A live NFT listing, laid out for tight packing — 6 storage slots, not 7. Slot 0 co-packs
    ///         `seller` (20 bytes) + `active` (1 byte), `collection` and `paymentToken` take one slot
    ///         each, and `tokenId`/`merchantId`/`priceUsd8` are full words; `priceUsd8` is the USD price
    ///         with 8 decimals (matching the Router's `usdAmount8`).
    /// @param seller       The address that listed (receives the NFT back on cancel). MUST be the
    ///                     Router merchant owner at list time. (slot 0, low 20 bytes)
    /// @param active       False once sold or cancelled (one-shot; blocks replay {buy}). Co-packed with
    ///                     `seller` in slot 0 (byte 20).
    /// @param collection   The ERC-721 contract escrowed. (slot 1)
    /// @param paymentToken The allowlisted ERC-20 a buyer pays in (Router prices + fee-splits it). (slot 2)
    /// @param tokenId      The token id escrowed. (slot 3)
    /// @param merchantId   The Router merchant the sale settles to (its payout receives the net). (slot 4)
    /// @param priceUsd8    The list price in USD, 8 decimals (e.g. $99.00 == 99e8). (slot 5)
    struct Listing {
        address seller;
        bool active;
        address collection;
        address paymentToken;
        uint256 tokenId;
        uint256 merchantId;
        uint256 priceUsd8;
    }

    /// @notice The Access0x1 Router that prices, fee-splits, and settles every purchase, and whose
    ///         merchant registry authorizes listings. Set ONCE in {initialize} and never reassigned, so
    ///         the money + auth source can never be swapped out from under live listings — the upgradeable
    ///         analogue of the original `immutable` (it lives in PROXY storage, since an `immutable` would
    ///         read from the implementation bytecode, not the proxy). It is the FIRST storage slot.
    Access0x1Router public router;

    /// @notice listingId ⇒ its record. listingId is assigned sequentially from {nextListingId}.
    mapping(uint256 listingId => Listing) public listings;

    /// @notice The id assigned to the next {list}. Starts at 1, so 0 is an unset sentinel.
    uint256 public nextListingId;

    /// @notice A new NFT listing was created and the NFT escrowed.
    event Listed(
        uint256 indexed listingId,
        uint256 indexed merchantId,
        address indexed seller,
        address collection,
        uint256 tokenId,
        address paymentToken,
        uint256 priceUsd8
    );

    /// @notice A listing was bought: the buyer paid through the Router and received the NFT.
    event Bought(
        uint256 indexed listingId,
        uint256 indexed merchantId,
        address indexed buyer,
        address collection,
        uint256 tokenId,
        address paymentToken,
        uint256 grossPaid
    );

    /// @notice A listing was cancelled by the seller and the escrowed NFT returned.
    event Cancelled(
        uint256 indexed listingId, address indexed seller, address collection, uint256 tokenId
    );

    /// @notice A zero address was supplied where a non-zero one is required.
    error Access0x1Nft__ZeroAddress();

    /// @notice A zero price was supplied where a positive USD price is required.
    error Access0x1Nft__ZeroPrice();

    /// @notice The referenced merchant does not exist in the Router.
    error Access0x1Nft__MerchantNotFound(uint256 merchantId);

    /// @notice The caller is not the Router owner of the referenced merchant.
    error Access0x1Nft__NotMerchantOwner(uint256 merchantId, address caller);

    /// @notice The listing does not exist or is no longer active.
    error Access0x1Nft__ListingInactive(uint256 listingId);

    /// @notice The caller is not the seller of the listing.
    error Access0x1Nft__NotSeller(uint256 listingId, address caller);

    /// @notice The buyer-supplied USD price did not match the listing (front-running / stale-quote
    ///         guard: the buyer signs the exact price they agreed to).
    error Access0x1Nft__PriceMismatch(uint256 expected, uint256 supplied);

    /// @notice The token amount the live Chainlink quote requires exceeds the buyer's hard outlay cap
    ///         (slippage guard: the fixed USD price re-prices into more token units between consent and
    ///         inclusion than the buyer agreed to spend).
    error Access0x1Nft__TokenAmountTooHigh(uint256 gross, uint256 maxTokenAmount);

    /// @notice The escrow did not actually receive the NFT during {list} (defensive: a non-standard
    ///         ERC-721 whose `safeTransferFrom` does not move ownership is rejected).
    error Access0x1Nft__EscrowFailed(address collection, uint256 tokenId);

    /// @dev The implementation is the logic half of a UUPS pair; its OWN storage is never used in
    ///      production (the proxy holds state). `_disableInitializers()` burns the implementation's
    ///      initializer so it can never be initialized — and therefore never owned or upgraded — directly,
    ///      closing the classic uninitialized-implementation takeover. Runs at implementation-deploy time.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time initializer — the constructor-replacement for the proxy. Wires the upgradeable
    ///         bases (Ownable + its 2-step extension, Pausable, ReentrancyGuard, and the UUPS machinery),
    ///         then runs the old constructor body verbatim. Guarded by `initializer`, so it runs exactly
    ///         once per proxy; the typical deploy is
    ///         `new ERC1967Proxy(impl, abi.encodeCall(initialize, (initialOwner, router_)))`.
    /// @dev    No `__UUPSUpgradeable_init()`: in OZ 5.x `UUPSUpgradeable` re-exports the non-upgradeable
    ///         contract (it holds no initializable storage), so there is no such initializer to call.
    ///         `initialOwner` becomes the admin / upgrade owner; it must be non-zero (`__Ownable_init`
    ///         reverts on zero). The remaining body is byte-for-byte the old constructor's.
    /// @param initialOwner The admin (Ownable2Step) — can pause new pay-ins, nothing custodial.
    /// @param router_      The Access0x1 Router used for pricing, fee-split, settlement, and auth.
    function initialize(address initialOwner, Access0x1Router router_) external initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __Pausable_init();
        if (address(router_) == address(0)) revert Access0x1Nft__ZeroAddress();
        router = router_;
        nextListingId = 1;
    }

    /*//////////////////////////////////////////////////////////////
                                ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Halt new listings and purchases ({list}/{buy} revert while paused). A circuit breaker
    ///         for a Router/feed incident. Deliberately does NOT gate {cancelListing} — a seller must
    ///         always be able to retrieve an unsold NFT, even during a pause (no hostage assets).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume listings and purchases after a {pause}.
    function unpause() external onlyOwner {
        _unpause();
    }

    /*//////////////////////////////////////////////////////////////
                                LISTING
    //////////////////////////////////////////////////////////////*/

    /// @notice List an ERC-721 for sale at a USD price. The caller MUST be the Router `owner` of
    ///         `merchantId` (the sale settles to that merchant's payout). The NFT is pulled into escrow
    ///         here via `safeTransferFrom`, so the caller must have approved this contract for it first.
    /// @dev    CEI: checks (auth, non-zero price, token allowlisted at the Router via a `quote` probe)
    ///         → effects (write the listing) → interaction (escrow the NFT, then verify ownership moved).
    ///         The `quote` probe makes a listing with an unpriceable/disallowed `paymentToken` fail
    ///         FAST at list time rather than stranding an escrowed NFT behind an unbuyable listing.
    /// @param merchantId   The Router merchant the sale settles to.
    /// @param collection   The ERC-721 contract.
    /// @param tokenId      The token id to list (caller must own it and have approved this contract).
    /// @param paymentToken The allowlisted ERC-20 a buyer pays in.
    /// @param priceUsd8    The list price in USD (8 decimals), must be > 0.
    /// @return listingId   The newly assigned listing id (>= 1).
    function list(
        uint256 merchantId,
        address collection,
        uint256 tokenId,
        address paymentToken,
        uint256 priceUsd8
    ) external nonReentrant whenNotPaused returns (uint256 listingId) {
        if (collection == address(0) || paymentToken == address(0)) {
            revert Access0x1Nft__ZeroAddress();
        }
        if (priceUsd8 == 0) revert Access0x1Nft__ZeroPrice();
        _requireMerchantOwner(merchantId, msg.sender);
        // Probe pricing at list time: reverts (TokenNotAllowed / stale feed) if this token can never
        // be used to buy — so a seller cannot escrow an NFT behind a structurally unbuyable listing.
        router.quote(merchantId, paymentToken, priceUsd8);

        listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            collection: collection,
            tokenId: tokenId,
            merchantId: merchantId,
            paymentToken: paymentToken,
            priceUsd8: priceUsd8,
            active: true
        });

        // Escrow the NFT LAST (interaction), then verify it actually landed here. A non-standard 721
        // whose `safeTransferFrom` silently no-ops is rejected, so an active listing always backs a
        // truly held NFT.
        IERC721(collection).safeTransferFrom(msg.sender, address(this), tokenId);
        if (IERC721(collection).ownerOf(tokenId) != address(this)) {
            revert Access0x1Nft__EscrowFailed(collection, tokenId);
        }

        emit Listed(listingId, merchantId, msg.sender, collection, tokenId, paymentToken, priceUsd8);
    }

    /// @notice Cancel a listing and return the escrowed NFT to its seller. Only the seller may call.
    ///         NOT gated by {pause}: an unsold NFT is never held hostage.
    /// @dev    CEI: checks (active, caller is seller) → effects (deactivate) → interaction (return NFT).
    ///         Deactivating BEFORE the transfer makes a re-entrant cancel/buy find an inactive listing.
    /// @param listingId The listing to cancel.
    function cancelListing(uint256 listingId) external nonReentrant {
        Listing storage l = listings[listingId];
        if (!l.active) revert Access0x1Nft__ListingInactive(listingId);
        if (msg.sender != l.seller) revert Access0x1Nft__NotSeller(listingId, msg.sender);

        l.active = false; // effect before interaction
        address collection = l.collection;
        uint256 tokenId = l.tokenId;
        address seller = l.seller;

        IERC721(collection).safeTransferFrom(address(this), seller, tokenId);
        emit Cancelled(listingId, seller, collection, tokenId);
    }

    /*//////////////////////////////////////////////////////////////
                                PURCHASE
    //////////////////////////////////////////////////////////////*/

    /// @notice Buy a listed NFT. Prices the listing's USD price into the payment token via the Router,
    ///         pulls exactly that gross from the buyer, settles it through `Router.payToken` (net→seller
    ///         payout, fees split), and transfers the escrowed NFT to the buyer — all atomically.
    /// @dev    CEI with pull-then-forward:
    ///           checks    — listing active, buyer-signed `maxPriceUsd8` matches the listing price
    ///                       (front-run / price-bump guard);
    ///           effects   — deactivate the listing (one-shot; a re-entrant buy finds it inactive);
    ///           interaction — quote gross, enforce the buyer's `maxTokenAmount` outlay cap (slippage
    ///                       guard, reverting before any token moves), pull gross from buyer, approve the
    ///                       Router, `payToken` (Router pulls the gross from here and does the fee-split +
    ///                       settlement), then `safeTransferFrom` the NFT to the buyer.
    ///         ZERO CUSTODY of the payment token: it is pulled in and forwarded to the Router in the
    ///         same call; the post-settlement approval is reset to 0 so no dangling allowance remains.
    ///         The NFT leg uses {safeTransferFrom}, so a contract buyer that cannot receive ERC-721s
    ///         reverts the whole purchase (atomic — the money is rolled back with it).
    /// @param listingId      The listing to buy.
    /// @param maxPriceUsd8   The USD price (8 decimals) the buyer agreed to; must equal the listing
    ///                       price. This is the buyer's explicit consent to the exact price, defeating a
    ///                       seller price-bump or a swapped listing between quote and submit.
    /// @param maxTokenAmount The buyer's HARD CAP on token outlay: the maximum number of `paymentToken`
    ///                       units they will spend. The fixed USD price re-prices against the live
    ///                       Chainlink feed in-tx, so the token units can drift between consent and
    ///                       inclusion; this bound reverts {Access0x1Nft__TokenAmountTooHigh} before any
    ///                       token moves when the quote exceeds it. Pass the quoted amount for an exact
    ///                       cap, or `type(uint256).max` to opt out of the slippage bound.
    function buy(uint256 listingId, uint256 maxPriceUsd8, uint256 maxTokenAmount)
        external
        nonReentrant
        whenNotPaused
    {
        Listing storage l = listings[listingId];
        if (!l.active) revert Access0x1Nft__ListingInactive(listingId);

        // Snapshot the immutable-for-this-sale fields before the effect, then deactivate.
        uint256 merchantId = l.merchantId;
        address collection = l.collection;
        uint256 tokenId = l.tokenId;
        address paymentToken = l.paymentToken;
        uint256 priceUsd8 = l.priceUsd8;
        if (maxPriceUsd8 != priceUsd8) {
            revert Access0x1Nft__PriceMismatch(priceUsd8, maxPriceUsd8);
        }

        l.active = false; // effect before interactions — one-shot, blocks re-entrant double-buy

        // Quote the gross the Router will require, enforce the buyer's token-outlay cap BEFORE pulling
        // anything, then pull exactly that from the buyer and approve the Router to pull it back out.
        // The Router does ALL pricing/fee-split/settlement; this contract only relays the gross and
        // never keeps it.
        uint256 gross = router.quote(merchantId, paymentToken, priceUsd8);
        if (gross > maxTokenAmount) revert Access0x1Nft__TokenAmountTooHigh(gross, maxTokenAmount);
        IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), gross);
        IERC20(paymentToken).forceApprove(address(router), gross);

        // Settle through the audited money path. The Router pulls `gross` from THIS contract, splits
        // the fee, and pushes net→merchant payout + fee legs. An order id ties the receipt to this
        // listing for off-chain reconciliation.
        router.payToken(merchantId, paymentToken, priceUsd8, bytes32(listingId));

        // Defensive: the Router pulls the full gross via its balance-delta check, so the approval is
        // consumed. Reset any residual to 0 so no dangling allowance survives (zero-custody hygiene).
        IERC20(paymentToken).forceApprove(address(router), 0);

        // Deliver the NFT to the buyer LAST. safeTransferFrom enforces onERC721Received for contract
        // buyers; a buyer that cannot receive reverts the whole purchase, rolling back the payment.
        IERC721(collection).safeTransferFrom(address(this), msg.sender, tokenId);

        emit Bought(listingId, merchantId, msg.sender, collection, tokenId, paymentToken, gross);
    }

    /*//////////////////////////////////////////////////////////////
                            ERC-721 RECEIVER
    //////////////////////////////////////////////////////////////*/

    /// @notice Accept ERC-721s sent here (the escrow leg of {list}). Returns the receiver magic value.
    /// @dev    Accepts unconditionally: {list} is the only path that should send an NFT here, and it
    ///         verifies ownership moved immediately afterward. Accepting all incoming 721s keeps the
    ///         escrow `safeTransferFrom` from reverting; a stray NFT sent outside {list} has no listing
    ///         and is simply not for sale (its sender can re-list it via {list} or the prior owner can
    ///         recover via the collection's own transfer if they retained approval).
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }

    /*//////////////////////////////////////////////////////////////
                            INTERNAL: AUTH
    //////////////////////////////////////////////////////////////*/

    /// @notice Authorize a UUPS upgrade. Restricted to the contract `owner` (the upgrade admin) — the
    ///         single gate {upgradeToAndCall} consults before swapping the implementation.
    /// @dev    Empty body: the `onlyOwner` modifier IS the policy. Once `renounceOwnership()` sets the
    ///         owner to address(0), every call here reverts, so the implementation becomes permanently
    ///         immutable (the on-chain "freeze"). `newImplementation` is intentionally unnamed — no
    ///         per-target allow-listing; the owner is fully trusted to vet the target off-chain.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }

    /// @dev Authorize `caller` as the Router owner of `merchantId`. The Router merchant registry is the
    ///      single source of truth (same composition pattern as the sibling ledgers). `merchants`
    ///      returns the full record tuple; `owner == address(0)` means the merchant was never
    ///      registered.
    function _requireMerchantOwner(uint256 merchantId, address caller) private view {
        (, address merchantOwner,,,,) = router.merchants(merchantId);
        if (merchantOwner == address(0)) revert Access0x1Nft__MerchantNotFound(merchantId);
        if (caller != merchantOwner) revert Access0x1Nft__NotMerchantOwner(merchantId, caller);
    }

    /// @dev Reserved storage slots so future versions can APPEND new state without shifting the layout
    ///      above (UUPS storage-collision safety). Each new variable added in a later version consumes
    ///      one slot from the head of this gap; shrink `__gap` by exactly the number of slots added so
    ///      the total stays 50. NEVER reorder or insert a variable above this gap — only append.
    uint256[50] private __gap;
}
