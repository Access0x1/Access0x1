// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    Ownable2StepUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    AggregatorV3Interface
} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

import { OracleLib } from "./libraries/OracleLib.sol";
import { IPriceOracleAdapter, IERC7726Lite } from "./interfaces/IPriceOracleAdapter.sol";

/// @title  PriceOracleAdapter
/// @author Access0x1
/// @notice A thin, SWAPPABLE price oracle that normalizes any underlying price SOURCE behind one
///         ERC-standard read — **ERC-7726's** `getQuote(baseAmount, base, quote)` (the Common Quote
///         Oracle, a DRAFT). It exists so the router and every commerce primitive can depend on a
///         stable `IPriceOracleAdapter` interface instead of hard-binding `AggregatorV3Interface`: the
///         price-source choice becomes a deploy-time wiring decision, not a code change. This first
///         implementation wraps a Chainlink `<base>/<quote>` aggregator behind {OracleLib}'s staleness
///         + completed-round guard; a later swap to a TWAP / push feed / fixed-rate stub is a NEW
///         implementation behind the SAME interface, with zero churn at the call site.
/// @dev    COMPOSES, never duplicates: the staleness + completed-round + carried-over-round logic lives
///         ONCE in {OracleLib} (the Cyfrin/Patrick-Collins pattern, MIT); this adapter only owns feed
///         CONFIGURATION (owner-set per-pair feed + window) and the ERC-7726 decimal normalization on
///         top. The USD→token quote math here MIRRORS {Access0x1Router}'s `quote()` exactly — decimals
///         are read LIVE (`feed.decimals()`, token `decimals()`), never hardcoded, and `Math.mulDiv`
///         rounds UP so a consumer is never quoted LESS value than asked (the Arc-decimals trap is safe).
///
///         ERCs implemented:
///         • **ERC-7726 — Common Quote Oracle (DRAFT, no final EIP number).** `getQuote` returns the
///           amount of `quote` token worth `baseAmount` of `base` token, both in their OWN decimals.
///           We pin the spec IDEA (canonical arg order `(baseAmount, base, quote)` + the result-in-
///           quote-decimals contract), tracked at the Ethereum Magicians "ERC-7726: Common Quote
///           Oracle" thread + the alcueca/erc7726 reference; it is declared locally as {IERC7726Lite}
///           because our dependency set ships no canonical 7726 artifact.
///         • **ERC-165 — Standard Interface Detection.** {supportsInterface} advertises
///           {IPriceOracleAdapter}, the bare {IERC7726Lite} quote surface, and {IERC165}.
///
///         INFRASTRUCTURE, NOT MONEY: this contract is a `view` price read plus owner-only feed
///         configuration. It holds NO funds, moves NO value, has NO settlement path and therefore NO
///         money invariant — there is intentionally NO `nonReentrant`/`SafeERC20`/CEI surface here
///         (nothing to guard). The fee-split, zero-custody, and the five money invariants live in
///         {Access0x1Router}, which this adapter only PRICES for.
///
///         UPGRADEABILITY (the Access0x1 UUPS TEMPLATE — every system contract follows this exact
///         shape): deployed behind an `ERC1967Proxy`; storage in the proxy, logic in this impl. State
///         is set once via {initialize} (`initializer`-guarded); the impl's own constructor calls
///         `_disableInitializers()` so the logic contract can never be initialized/hijacked directly.
///         Upgrades route through {upgradeToAndCall}, authorized by {_authorizeUpgrade} (owner-only).
///         Calling `renounceOwnership()` permanently freezes the implementation. A trailing `__gap`
///         reserves slots for safe future appends.
contract PriceOracleAdapter is
    IPriceOracleAdapter,
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable
{
    using OracleLib for AggregatorV3Interface;

    /// @notice The native-token sentinel: `address(0)` as a token means the chain's native coin. A
    ///         native side of a pair prices at 18 decimals (the EVM native convention).
    address private constant NATIVE = address(0);

    /// @notice The decimal exponent the native coin is priced at (18 — the EVM convention), used when
    ///         either side of a pair is `NATIVE` and so cannot answer `decimals()`.
    uint8 private constant NATIVE_DECIMALS = 18;

    /// @notice base ⇒ quote ⇒ the Chainlink `<base>/<quote>` aggregator. `feed == address(0)` means the
    ///         pair is unconfigured, and any {getQuote} for it reverts {PriceOracleAdapter__FeedNotSet}.
    /// @dev    Private with an explicit {feedOf} getter so the public surface returns the typed
    ///         `AggregatorV3Interface` (matching {IPriceOracleAdapter}) rather than a raw nested map.
    mapping(address base => mapping(address quote => AggregatorV3Interface feed)) private _feedOf;

    /// @notice base ⇒ quote ⇒ the max age (seconds) the pair's feed answer may reach before {getQuote}
    ///         treats it as stale. `0` (unset) falls back to {OracleLib}'s 1h default — so the 2-arg
    ///         {setFeed} keeps the historical 1h window while the 3-arg overload widens it for a
    ///         slow-heartbeat feed (e.g. a 24h USDC/USD needs an 86400s+margin window).
    mapping(address base => mapping(address quote => uint256 maxStaleness)) private _stalenessOf;

    /// @dev Reserved storage slots so future versions can APPEND new state without shifting the layout
    ///      above (UUPS storage-collision safety). Each variable added later consumes one slot from the
    ///      head of this gap; shrink `__gap` by exactly that many so the total stays 50. NEVER reorder
    ///      or insert a variable above this gap — only append.
    uint256[50] private __gap;

    /// @dev The implementation is the logic half of a UUPS pair; its OWN storage is never used in
    ///      production (the proxy holds state). `_disableInitializers()` burns the implementation's
    ///      initializer so it can never be initialized — and therefore never owned or upgraded —
    ///      directly, closing the classic uninitialized-implementation takeover.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time initializer — the constructor-replacement for the proxy. Sets the contract
    ///         (upgrade-admin) owner. Guarded by `initializer`, so it runs exactly once per proxy; the
    ///         typical deploy is `new ERC1967Proxy(impl, abi.encodeCall(initialize, (owner)))`.
    /// @dev    Wires Ownable + its 2-step extension. `initialOwner` becomes the UPGRADE ADMIN and the
    ///         feed-configuration authority; it must be non-zero (`__Ownable_init` reverts on zero).
    ///         There is no `__UUPSUpgradeable_init()` in OZ 5.x (the UUPS base holds no init storage).
    /// @param initialOwner The contract owner / upgrade admin / feed configurator (non-zero).
    function initialize(address initialOwner) external initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
    }

    /*//////////////////////////////////////////////////////////////
                              OWNER CONFIG
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IPriceOracleAdapter
    /// @dev    Clears any per-pair `_stalenessOf` override, so {getQuote} falls back to {OracleLib}'s 1h
    ///         default. Passing `feed == address(0)` CLEARS the pair (and resets its window). Storing
    ///         a feed is NOT validated against a live answer here — staleness/validity is enforced
    ///         in-read by {getQuote}, so a pair can be configured before the feed has posted a round.
    function setFeed(address base, address quote, AggregatorV3Interface feed) external onlyOwner {
        _feedOf[base][quote] = feed;
        _stalenessOf[base][quote] = 0; // unset ⇒ getQuote() uses OracleLib's 1h default
        emit FeedSet(base, quote, address(feed), 0);
    }

    /// @inheritdoc IPriceOracleAdapter
    /// @dev    `maxStaleness` MUST be `> 0`; to clear a pair (and its window) use the 2-arg overload.
    ///         The deploy runbook must verify the window comfortably exceeds the feed's heartbeat +
    ///         deviation cadence, or fresh prices will be rejected as stale.
    function setFeed(address base, address quote, AggregatorV3Interface feed, uint256 maxStaleness)
        external
        onlyOwner
    {
        if (address(feed) == address(0)) revert PriceOracleAdapter__ZeroAddress();
        if (maxStaleness == 0) revert PriceOracleAdapter__ZeroAmount();
        _feedOf[base][quote] = feed;
        _stalenessOf[base][quote] = maxStaleness;
        emit FeedSet(base, quote, address(feed), maxStaleness);
    }

    /*//////////////////////////////////////////////////////////////
                                QUOTE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC7726Lite
    /// @dev    ERC-7726 (draft) read. The configured Chainlink `<base>/<quote>` feed's answer is the
    ///         price of 1 base unit (10^baseDecimals base) in quote, scaled by 10^feedDecimals. So:
    ///
    ///           quoteAmount = baseAmount · price · 10^quoteDecimals
    ///                         ─────────────────────────────────────
    ///                              10^feedDecimals · 10^baseDecimals
    ///
    ///         `Math.mulDiv` holds full 512-bit precision and rounds UP (`Ceil`), so a consumer is
    ///         never quoted LESS value than `baseAmount` is worth (dust ≤ 1 wei of quote) — the same
    ///         never-underpay convention the router's `quote()` uses. Decimals are read LIVE through
    ///         try/catch: a hostile/broken feed or token that reverts on `decimals()` surfaces the typed
    ///         {PriceOracleAdapter__FeedNotSet} (the same revert an unconfigured pair gives) rather than
    ///         an opaque bubble-up. The staleness guard reverts a stale/never-completed/carried-over
    ///         round (and the L1/Arc-safe path skips any sequencer check — none is wired here).
    function getQuote(uint256 baseAmount, address base, address quote)
        public
        view
        returns (uint256 quoteAmount)
    {
        if (baseAmount == 0) revert PriceOracleAdapter__ZeroAmount();

        AggregatorV3Interface feed = _feedOf[base][quote];
        if (address(feed) == address(0)) revert PriceOracleAdapter__FeedNotSet(base, quote);

        // Per-pair staleness window: a slow-heartbeat feed gets its configured window; an unset (0)
        // window falls back to OracleLib's 1h default, so the 2-arg setFeed path keeps the 1h behaviour.
        uint256 maxStaleness = _stalenessOf[base][quote];
        if (maxStaleness == 0) maxStaleness = OracleLib.TIMEOUT;

        // Only the answer is needed; the staleness guard already reverted a stale/never-completed/
        // carried-over round, so the other tuple fields are intentionally unused.
        // slither-disable-next-line unused-return
        (, int256 answer,,,) = feed.staleCheckLatestRoundData(maxStaleness);
        if (answer <= 0) revert PriceOracleAdapter__InvalidPrice(answer);
        // answer > 0 is enforced just above, so this int256→uint256 cast cannot wrap.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 price = uint256(answer);

        uint256 feedDecimals = _feedDecimals(feed, base, quote);
        uint256 baseDecimals = _tokenDecimals(base, quote);
        uint256 quoteDecimals = _tokenDecimals(quote, base);

        // quoteAmount = baseAmount · price · 10^quoteDecimals / (10^feedDecimals · 10^baseDecimals).
        // `baseAmount` is the large protected operand inside `mulDiv` (full 512-bit intermediate); the
        // small `price · 10^quoteDecimals` factor (an 8-dec feed answer × a token-decimal scale) is
        // formed first and never realistically overflows. `Ceil` rounds UP so a consumer is never
        // quoted LESS value than `baseAmount` is worth (the router's never-underpay convention).
        quoteAmount = Math.mulDiv(
            baseAmount,
            price * 10 ** quoteDecimals,
            10 ** (feedDecimals + baseDecimals),
            Math.Rounding.Ceil
        );
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IPriceOracleAdapter
    function feedOf(address base, address quote)
        external
        view
        returns (AggregatorV3Interface feed)
    {
        return _feedOf[base][quote];
    }

    /// @inheritdoc IPriceOracleAdapter
    function stalenessOf(address base, address quote) external view returns (uint256 maxStaleness) {
        return _stalenessOf[base][quote];
    }

    /// @inheritdoc IPriceOracleAdapter
    /// @dev    Advertises the full adapter surface, the bare ERC-7726 (draft) quote surface, and
    ///         ERC-165 itself, so a router/SDK can feature-detect a swapped-in adapter before binding.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IPriceOracleAdapter).interfaceId
            || interfaceId == type(IERC7726Lite).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @notice Authorize a UUPS upgrade. Restricted to the contract `owner` (the upgrade admin) — the
    ///         single gate {upgradeToAndCall} consults before swapping the implementation.
    /// @dev    Empty body: the `onlyOwner` modifier IS the policy. Once `renounceOwnership()` sets the
    ///         owner to address(0), every call here reverts, so the implementation becomes permanently
    ///         immutable. `newImplementation` is intentionally unnamed — no per-target allow-listing.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }

    /// @dev Read a feed's `decimals()` through try/catch. A hostile/broken feed that reverts surfaces
    ///      the typed {PriceOracleAdapter__FeedNotSet} (a feed that cannot answer `decimals()` cannot
    ///      price the pair, so it is treated as unconfigured) rather than an opaque bubble-up.
    function _feedDecimals(AggregatorV3Interface feed, address base, address quote)
        private
        view
        returns (uint256)
    {
        try feed.decimals() returns (uint8 fd) {
            return fd;
        } catch {
            revert PriceOracleAdapter__FeedNotSet(base, quote);
        }
    }

    /// @dev Read a token's `decimals()`, returning the 18-decimal native convention for the `NATIVE`
    ///      (`address(0)`) sentinel and reading live `decimals()` otherwise. A token that reverts on
    ///      `decimals()` surfaces the typed {PriceOracleAdapter__FeedNotSet} for the pair (it cannot be
    ///      priced). `otherSide` is the pair partner, carried only so the error names the full pair.
    function _tokenDecimals(address token, address otherSide) private view returns (uint256) {
        if (token == NATIVE) return NATIVE_DECIMALS;
        try IERC20Metadata(token).decimals() returns (uint8 td) {
            return td;
        } catch {
            // Name the pair in base→quote order: if `token` is the base side, `otherSide` is the quote,
            // and vice-versa. The unconfigurable-decimals token is the one that breaks the pair either way.
            revert PriceOracleAdapter__FeedNotSet(token, otherSide);
        }
    }
}
