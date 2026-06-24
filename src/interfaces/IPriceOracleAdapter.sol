// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @title  IERC7726Lite
/// @author Access0x1
/// @notice The minimal on-chain surface of **ERC-7726 — Common Quote Oracle (DRAFT)**: a single,
///         source-agnostic price read. `getQuote` answers "how much `quote` token is `baseAmount` of
///         `base` token worth", both denominated in their OWN token decimals, so the consumer never
///         handles the oracle's internal decimals.
/// @dev    ERC-7726 is a DRAFT (no final EIP number; spec at the Ethereum Magicians thread + the
///         alcueca/erc7726 reference) — declared locally because our dependency set ships no canonical
///         7726 artifact. We honor the canonical argument ORDER `(baseAmount, base, quote)` and the
///         decimal contract exactly, so any ERC-7726 consumer binds to this surface unmodified. The
///         `address(0)` sentinel denotes the chain's NATIVE coin as either side of the pair.
interface IERC7726Lite {
    /// @notice Return the amount of `quote` token equivalent in value to `baseAmount` of `base` token.
    /// @dev    ERC-7726 (draft) canonical signature + decimal contract: the result is expressed in
    ///         `quote`'s native decimals, and `baseAmount` is in `base`'s native decimals — the adapter
    ///         absorbs the oracle's own decimals internally. Reverts (never returns 0) when the price
    ///         cannot be produced (no feed / stale round / non-positive answer). `MUST` be `view`.
    /// @param baseAmount The amount of the base token to convert, in the base token's own decimals.
    /// @param base       The base token being priced (`address(0)` = native).
    /// @param quote      The quote token to denominate the result in (`address(0)` = native).
    /// @return quoteAmount The equivalent amount of `quote`, in the quote token's own decimals.
    function getQuote(uint256 baseAmount, address base, address quote)
        external
        view
        returns (uint256 quoteAmount);
}

/// @title  IPriceOracleAdapter
/// @author Access0x1
/// @notice The external surface of {PriceOracleAdapter} — a thin, SWAPPABLE price oracle that
///         normalizes any underlying price SOURCE behind a single, ERC-standard quote function so the
///         router (and every commerce primitive) can stop hard-binding `AggregatorV3Interface`. The
///         adapter today wraps a Chainlink `<base>/<quote>` feed through {OracleLib}'s staleness +
///         completed-round guard, but a future swap to a TWAP, a redstone push feed, or a fixed-rate
///         stub is a NEW implementation behind this same interface — zero churn at the call site.
/// @dev    ERCs implemented:
///         • **ERC-7726 — Common Quote Oracle (DRAFT, unmerged).** A minimal, source-agnostic pricing
///           interface: `getQuote(baseAmount, base, quote)` returns the amount of `quote` token worth
///           `baseAmount` of `base` token, both expressed in their OWN decimals — so the caller never
///           juggles oracle decimals. The standard is a DRAFT (no final EIP number assigned; pin the
///           spec idea, not a frozen ABI): tracked at the Ethereum Magicians "ERC-7726: Common Quote
///           Oracle" thread and the alcueca/erc7726 reference. We implement its canonical argument
///           ORDER — `(uint256 baseAmount, address base, address quote)` — and its decimal contract
///           (result in `quote`'s native decimals) so an ERC-7726 consumer can drive this adapter
///           unmodified. The token-as-currency sentinel for the chain's NATIVE coin is `address(0)`.
///         • **ERC-165 — Standard Interface Detection.** `supportsInterface` answers `true` for
///           {IPriceOracleAdapter}, the bare {IERC7726Lite} quote surface, and {IERC165}, so a router
///           or SDK can feature-detect a swapped-in adapter before binding to it.
///
///         WHY a `Lite` 7726 surface (below) and not an import: ERC-7726 is a draft with no canonical
///         on-chain artifact in our dependency set, so we declare the exact quote selector locally as
///         {IERC7726Lite}. {IPriceOracleAdapter} EXTENDS it — the 7726 `getQuote` IS the adapter's
///         money-read; the adapter only adds owner configuration + the staleness window on top.
///
///         This adapter holds NO funds and moves NO value — it is pure infrastructure (a `view` price
///         read plus owner-only feed configuration). There is therefore NO custody, NO settlement, and
///         NO money invariant here; the fee-split / zero-custody guarantees live in {Access0x1Router},
///         which this adapter only PRICES for.
interface IPriceOracleAdapter is IERC7726Lite {
    // ──────────────────────── events ────────────────────────

    /// @notice A `<base>/<quote>` feed (and, optionally, its max-staleness window) was set or cleared.
    /// @dev    `feed == address(0)` clears the pair, after which any {getQuote} for it reverts
    ///         {PriceOracleAdapter__FeedNotSet}. `maxStaleness == 0` means the pair falls back to
    ///         {OracleLib}'s 1h default window inside {getQuote}.
    /// @param base        The base token of the configured pair (`address(0)` = native).
    /// @param quote       The quote token the price is denominated in (`address(0)` = native).
    /// @param feed        The Chainlink aggregator now serving the pair (`address(0)` = cleared).
    /// @param maxStaleness The max age (seconds) the feed answer may reach before it is treated as
    ///                     stale (`0` ⇒ the 1h {OracleLib} default).
    event FeedSet(
        address indexed base, address indexed quote, address indexed feed, uint256 maxStaleness
    );

    // ──────────────────────── errors ────────────────────────

    /// @notice A zero address was supplied where a non-zero one is required (the feed on a SET).
    error PriceOracleAdapter__ZeroAddress();

    /// @notice A zero base amount was supplied; a quote must be for a positive amount.
    error PriceOracleAdapter__ZeroAmount();

    /// @notice No feed is configured for the requested `<base>/<quote>` pair.
    error PriceOracleAdapter__FeedNotSet(address base, address quote);

    /// @notice The feed returned a non-positive price, so a quote cannot be derived from it.
    error PriceOracleAdapter__InvalidPrice(int256 answer);

    // ──────────────────────── views ────────────────────────

    /// @notice The Chainlink aggregator currently serving a `<base>/<quote>` pair, or `address(0)` if
    ///         the pair is unconfigured.
    /// @param base  The base token (`address(0)` = native).
    /// @param quote The quote token (`address(0)` = native).
    /// @return feed The configured aggregator (`address(0)` ⇒ no feed ⇒ {getQuote} reverts).
    function feedOf(address base, address quote) external view returns (AggregatorV3Interface feed);

    /// @notice The max-staleness window (seconds) a `<base>/<quote>` pair's feed answer may reach
    ///         before {getQuote} treats it as stale. `0` ⇒ the pair uses {OracleLib}'s 1h default.
    /// @param base  The base token (`address(0)` = native).
    /// @param quote The quote token (`address(0)` = native).
    /// @return maxStaleness The configured window, or `0` for the 1h default.
    function stalenessOf(address base, address quote) external view returns (uint256 maxStaleness);

    /// @notice ERC-165 interface detection — see {IERC165}.
    /// @param interfaceId The interface identifier to test.
    /// @return True iff this contract implements `interfaceId`.
    function supportsInterface(bytes4 interfaceId) external view returns (bool);

    // ──────────────────────── owner config ────────────────────────

    /// @notice Set or clear the Chainlink feed for a `<base>/<quote>` pair, using {OracleLib}'s 1h
    ///         default staleness window. Owner-only.
    /// @dev    Pass `feed == address(0)` to CLEAR the pair (and reset its window to the default). The
    ///         3-arg overload widens the window for a slow-heartbeat feed.
    /// @param base  The base token (`address(0)` = native).
    /// @param quote The quote token the price is denominated in (`address(0)` = native).
    /// @param feed  The Chainlink `<base>/<quote>` aggregator (`address(0)` clears the pair).
    function setFeed(address base, address quote, AggregatorV3Interface feed) external;

    /// @notice Set the Chainlink feed AND an explicit max-staleness window for a `<base>/<quote>`
    ///         pair. Owner-only. `maxStaleness` MUST be `> 0`; to clear a pair use the 2-arg overload.
    /// @param base         The base token (`address(0)` = native).
    /// @param quote        The quote token the price is denominated in (`address(0)` = native).
    /// @param feed         The Chainlink `<base>/<quote>` aggregator (must be non-zero here).
    /// @param maxStaleness The max age (seconds, `> 0`) the feed answer may reach before {getQuote}
    ///                     treats it as stale — widen this for a slow-heartbeat feed (e.g. 24h USDC/USD).
    function setFeed(address base, address quote, AggregatorV3Interface feed, uint256 maxStaleness)
        external;
}
