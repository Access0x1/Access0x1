/**
 * Access0x1 — One-Tag Checkout embed (embed.js)
 *
 * A merchant pastes ONE script tag into any HTML page (no build step, no npm,
 * no framework) and gets a "Pay with Crypto" button. The button reads the live
 * crypto-equivalent price via a single `eth_call` to the Access0x1Router's
 * `quote` view function, then opens the hosted checkout in a new tab on click.
 *
 *   <script
 *     src="https://<host>/embed.js"
 *     data-merchant="42"
 *     data-amount-usd="29.00"></script>
 *
 * White-label (ADR unit 5 / D4 b): a tenant can ALSO paste a slug tag —
 *
 *   <script
 *     src="https://<host>/embed.js"
 *     data-slug="joes-barbershop"
 *     data-amount-usd="29.00"></script>
 *
 * When `data-slug` is present the embed additionally fetches the public,
 * cacheable branding endpoint `GET /api/branding/{slug}` and, on success,
 * themes the button with the merchant's brand color, labels it "Pay {name}",
 * and opens the branded hosted checkout `/c/{slug}`. The branding fetch is
 * best-effort: on ANY failure the button degrades to the default label + the
 * "/m/{merchantId}" path (when a merchant id is known) so the host page is
 * never broken. A NUMERIC-only `data-merchant` tag behaves exactly as before:
 * at most one eth_call (the quote) and zero branding fetches.
 *
 * DOCTRINE (see embed-js.spec.md "Doctrine Guardrails"):
 *   - Zero custody: this file holds no keys/tokens; it only calls a view fn and opens a URL.
 *   - Real, booth-confirmed addresses: every address below is a __PLACEHOLDER__ token,
 *     replaced at build time from NEXT_PUBLIC_* env vars. Never hardcode from memory.
 *   - Law #4 truth: the quote is a live eth_call, never a cached/estimated number.
 *     On any failure, show USD only — never a stale guess.
 *   - Gas-tight: exactly ONE eth_call (view, no gas) per page load. No polling/sockets.
 *   - No Claude API key: this is a PUBLIC file; it contains no secrets and calls
 *     Anthropic via a server route only (not from here).
 *   - Graceful degradation is mandatory: this script MUST NOT crash the host page
 *     under any condition. Every error path falls back to the USD-only label.
 *
 * No globals: single IIFE, zero `window.*` exports.
 */
(function () {
  'use strict';

  /**
   * Chain registry. ALL address slots are `__PLACEHOLDER__` tokens in source;
   * `web/scripts/replace-embed-addrs.js` substitutes them from NEXT_PUBLIC_*
   * env vars during `next build`. A still-present placeholder is treated as
   * "not deployed yet" and the embed falls back to the USD-only label.
   *
   * @type {Object<number, {rpc: string, router: string, usdc: string, usdcDecimals: number}>}
   */
  var CHAIN_DEFAULTS = {
    5042002: {
      // Arc testnet — the default chain.
      rpc: 'https://rpc.testnet.arc.network',
      router: '__ROUTER_ADDRESS__',
      usdc: '__ARC_USDC_ADDRESS__',
      usdcDecimals: 18, // Arc native USDC is 18-dec (booth-confirm)
    },
    84532: {
      // Base Sepolia.
      rpc: 'https://sepolia.base.org',
      router: '__BASE_SEPOLIA_ROUTER_ADDRESS__',
      usdc: '__BASE_SEPOLIA_USDC_ADDRESS__',
      usdcDecimals: 6,
    },
    300: {
      // zkSync Sepolia.
      rpc: 'https://sepolia.era.zksync.dev',
      router: '__ZKSYNC_SEPOLIA_ROUTER_ADDRESS__',
      usdc: '__ZKSYNC_SEPOLIA_USDC_ADDRESS__',
      usdcDecimals: 6,
    },
  };

  var DEFAULT_CHAIN_ID = 5042002;
  var DEFAULT_LABEL = 'Pay with Crypto';
  /** USD amounts on-chain carry 8 decimals (router USD_DECIMALS == 8). */
  var USD_DECIMALS = 8;
  /** Function selector for quote(uint256,address,uint256). */
  var QUOTE_SELECTOR = '0x6fc904ca';
  /** Host this embed.js was served from — checkout lives on the same origin. */
  var EMBED_ORIGIN = embedOrigin();
  /** Marks a still-unreplaced address placeholder. */
  var PLACEHOLDER_RE = /^__[A-Z0-9_]+__$/;

  /**
   * Resolve the origin this script was loaded from, so the checkout URL is
   * always same-origin with the embed. Falls back to the page origin.
   *
   * @returns {string} the origin (e.g. "https://pay.access0x1.com").
   */
  function embedOrigin() {
    try {
      var s = document.currentScript;
      if (s && s.src) return new URL(s.src, location.href).origin;
    } catch (_e) {
      /* fall through */
    }
    return location.origin;
  }

  /**
   * Convert a decimal USD string (e.g. "29.00") into an 8-decimal integer
   * string (e.g. "2900000000"), with no floating-point rounding error. Returns
   * null for any malformed or non-positive input.
   *
   * @param {string} usd - decimal USD price as written in `data-amount-usd`.
   * @returns {string|null} the 8-decimal integer string, or null if invalid.
   */
  function usdToAmount8(usd) {
    if (typeof usd !== 'string') return null;
    var m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(usd.trim());
    if (!m) return null;
    var whole = m[1];
    var frac = (m[2] || '').slice(0, USD_DECIMALS);
    while (frac.length < USD_DECIMALS) frac += '0';
    var digits = (whole + frac).replace(/^0+(?=\d)/, '');
    if (!/^[0-9]+$/.test(digits) || /^0+$/.test(digits)) return null; // reject zero
    return digits;
  }

  /**
   * Left-pad a hex string (no 0x) to 64 chars — one 32-byte ABI word.
   *
   * @param {string} hex - hex characters, no "0x" prefix.
   * @returns {string} the value padded to 64 hex chars.
   */
  function pad32(hex) {
    var h = hex.toLowerCase().replace(/^0x/, '');
    while (h.length < 64) h = '0' + h;
    return h;
  }

  /**
   * Convert a non-negative decimal-digit string into a hex string (no 0x),
   * using BigInt so values larger than 2^53 are exact.
   *
   * @param {string} dec - a non-negative integer as a decimal string.
   * @returns {string} the value in hex (no "0x"), or "0" on bad input.
   */
  function decToHex(dec) {
    try {
      return BigInt(dec).toString(16);
    } catch (_e) {
      return '0';
    }
  }

  /**
   * ABI-encode `quote(merchantId, token, usdAmount8)` calldata.
   *
   * @param {string} merchantId - uint256 merchant id (decimal string).
   * @param {string} token - 20-byte token address (USDC) with 0x prefix.
   * @param {string} usdAmount8 - uint256 USD amount, 8 decimals (decimal string).
   * @returns {string} the 0x-prefixed calldata for eth_call.
   */
  function encodeQuote(merchantId, token, usdAmount8) {
    var tokenWord = pad32(token.replace(/^0x/, ''));
    return (
      QUOTE_SELECTOR +
      pad32(decToHex(merchantId)) +
      tokenWord +
      pad32(decToHex(usdAmount8))
    );
  }

  /**
   * Format a raw token amount (uint256 in the token's own decimals) into a
   * short human string for the button, e.g. "29" or "29.5". Trailing zeros are
   * trimmed; values are truncated to 2 fractional digits for display only.
   *
   * @param {bigint} raw - the token amount in base units.
   * @param {number} decimals - the token's decimals.
   * @returns {string} a display-friendly amount.
   */
  function formatTokenAmount(raw, decimals) {
    var s = raw.toString();
    while (s.length <= decimals) s = '0' + s;
    var whole = s.slice(0, s.length - decimals);
    var frac = s.slice(s.length - decimals).slice(0, 2).replace(/0+$/, '');
    return frac ? whole + '.' + frac : whole;
  }

  /**
   * Call `router.quote` via a single `eth_call` against the chain's public RPC.
   * This is a view call: no wallet, no gas, no state change. Resolves to the
   * decoded uint256 token amount, or null on ANY failure (RPC down, revert,
   * placeholder address, malformed response) so the caller can fall back to the
   * USD-only label. Never throws to the host page.
   *
   * @param {{rpc:string,router:string,usdc:string,usdcDecimals:number}} chain
   * @param {string} merchantId - uint256 merchant id (decimal string).
   * @param {string} usdAmount8 - uint256 USD amount, 8 decimals (decimal string).
   * @returns {Promise<bigint|null>} the quoted token amount, or null on failure.
   */
  function quote(chain, merchantId, usdAmount8) {
    // Addresses not deployed/confirmed yet → no quote, show USD only.
    if (
      !chain.router ||
      !chain.usdc ||
      PLACEHOLDER_RE.test(chain.router) ||
      PLACEHOLDER_RE.test(chain.usdc)
    ) {
      return Promise.resolve(null);
    }
    var data = encodeQuote(merchantId, chain.usdc, usdAmount8);
    var body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: chain.router, data: data }, 'latest'],
    });
    return fetch(chain.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body,
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (json) {
        if (!json || json.error || !json.result) return null;
        var hex = json.result;
        if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) return null;
        if (hex === '0x' || BigInt(hex) === 0n) return null;
        return BigInt(hex);
      })
      .catch(function () {
        // RPC unreachable / CORS / timeout — silent fallback, never crash.
        return null;
      });
  }

  /**
   * Build the checkout URL the button opens. Shape:
   *   <origin>/m/{merchantId}?amount={usdAmount8}&chainId={chainId}
   *
   * @param {string} merchantId - the merchant id.
   * @param {string} usdAmount8 - the 8-decimal USD integer string.
   * @param {number} chainId - the chosen chain id.
   * @returns {string} the absolute checkout URL.
   */
  function checkoutUrl(merchantId, usdAmount8, chainId) {
    return (
      EMBED_ORIGIN +
      '/m/' +
      encodeURIComponent(merchantId) +
      '?amount=' +
      encodeURIComponent(usdAmount8) +
      '&chainId=' +
      encodeURIComponent(String(chainId))
    );
  }

  /** Tracks whether the scoped <style> tag has been injected (inject once). */
  var stylesInjected = false;

  /**
   * Inject the scoped button stylesheet exactly once. All rules live under
   * `.a0x1-btn` and use CSS custom properties so merchants can override colors
   * without touching this file. Never touches body/global styles.
   *
   * @returns {void}
   */
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    var css =
      '.a0x1-btn{' +
      '--a0x1-bg:#4F46E5;--a0x1-fg:#ffffff;--a0x1-radius:8px;' +
      'display:inline-flex;align-items:center;gap:.5em;cursor:pointer;' +
      'font:600 14px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
      'padding:10px 16px;border:none;border-radius:var(--a0x1-radius);' +
      'background:var(--a0x1-bg);color:var(--a0x1-fg);' +
      '-webkit-appearance:none;appearance:none;text-align:left;}' +
      '.a0x1-btn:focus-visible{outline:2px solid #818cf8;outline-offset:2px;}' +
      '.a0x1-btn[data-theme="dark"]{--a0x1-bg:#111827;--a0x1-fg:#f9fafb;}' +
      '.a0x1-btn[disabled]{opacity:.55;cursor:not-allowed;}' +
      '.a0x1-btn .a0x1-price{opacity:.85;font-weight:400;}' +
      '.a0x1-btn[data-state="loading"] .a0x1-price{opacity:.6;}';
    var style = document.createElement('style');
    style.setAttribute('data-a0x1', 'embed');
    style.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(style);
  }

  /**
   * Create the button element with its label + price spans. The button starts
   * in the "loading" state (USD shown, crypto pending). It does NOT attach a
   * click handler — `wire()` does that once a valid URL is known.
   *
   * @param {string} label - the button label prefix.
   * @param {string} usdDisplay - the USD price string ("$29.00").
   * @param {string} theme - "light" | "dark".
   * @returns {HTMLButtonElement} the constructed button.
   */
  function makeButton(label, usdDisplay, theme) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'a0x1-btn';
    btn.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
    btn.setAttribute('data-state', 'loading');
    var labelSpan = document.createElement('span');
    labelSpan.className = 'a0x1-label';
    labelSpan.textContent = label;
    var priceSpan = document.createElement('span');
    priceSpan.className = 'a0x1-price';
    priceSpan.textContent = usdDisplay;
    btn.appendChild(labelSpan);
    btn.appendChild(priceSpan);
    return btn;
  }

  /**
   * Place `el` into the DOM. If a `data-container` CSS selector is given and
   * matches, inject inside it; otherwise inject immediately after the
   * `<script>` tag (the default). Falls back to body if the script node is gone.
   *
   * @param {HTMLElement} el - the element to insert.
   * @param {Element|null} scriptEl - the embed's own <script> element.
   * @param {string|null} containerSel - optional CSS selector.
   * @returns {void}
   */
  function placeInDom(el, scriptEl, containerSel) {
    if (containerSel) {
      var container = document.querySelector(containerSel);
      if (container) {
        container.appendChild(el);
        return;
      }
    }
    if (scriptEl && scriptEl.parentNode) {
      scriptEl.parentNode.insertBefore(el, scriptEl.nextSibling);
      return;
    }
    document.body.appendChild(el);
  }

  /**
   * Read this embed's configuration from its own `<script>` tag's data-*
   * attributes. Returns null (with a console warning) if required attributes
   * are missing or invalid — the caller then injects nothing.
   *
   * @param {Element} scriptEl - the embed's <script> element.
   * @returns {{merchantId:string,slug:string|null,usdAmount8:string,usdDisplay:string,chainId:number,label:string,theme:string,container:string|null}|null}
   */
  function readConfig(scriptEl) {
    var d = scriptEl.dataset || {};
    var merchantId = (d.merchant || '').trim();
    var slug = (d.slug || '').trim().toLowerCase();
    var hasMerchant = /^[0-9]+$/.test(merchantId);
    var hasSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
    // A tenant tag may carry EITHER a numeric merchant id OR a checkout slug
    // (or both). At least one valid identifier is required.
    if (!hasMerchant && !hasSlug) {
      console.warn('[access0x1] embed.js: missing/invalid data-merchant / data-slug');
      return null;
    }
    var rawUsd = (d.amountUsd || '').trim();
    var usdAmount8 = usdToAmount8(rawUsd);
    if (!usdAmount8) {
      // Zero / malformed amount: reject before any RPC call (spec verify #5).
      console.warn('[access0x1] embed.js: invalid data-amount-usd "' + rawUsd + '"');
      return null;
    }
    var chainId = parseInt((d.chainId || '').trim(), 10);
    if (!chainId || !CHAIN_DEFAULTS[chainId]) chainId = DEFAULT_CHAIN_ID;
    return {
      merchantId: hasMerchant ? merchantId : '',
      slug: hasSlug ? slug : null,
      usdAmount8: usdAmount8,
      usdDisplay: '$' + rawUsd,
      chainId: chainId,
      label: (d.label || DEFAULT_LABEL).trim() || DEFAULT_LABEL,
      theme: d.theme === 'dark' ? 'dark' : 'light',
      container: (d.container || '').trim() || null,
    };
  }

  /**
   * Build the branding endpoint URL for a slug, same-origin with the embed.
   *
   * @param {string} slug - the merchant's checkout slug.
   * @returns {string} the absolute `/api/branding/{slug}` URL.
   */
  function brandingUrl(slug) {
    return EMBED_ORIGIN + '/api/branding/' + encodeURIComponent(slug);
  }

  /**
   * Build the BRANDED hosted checkout URL for a slug. Shape:
   *   <origin>/c/{slug}?amount={usdAmount8}&chainId={chainId}
   *
   * @param {string} slug - the merchant's checkout slug.
   * @param {string} usdAmount8 - the 8-decimal USD integer string.
   * @param {number} chainId - the chosen chain id.
   * @returns {string} the absolute branded checkout URL.
   */
  function slugCheckoutUrl(slug, usdAmount8, chainId) {
    return (
      EMBED_ORIGIN +
      '/c/' +
      encodeURIComponent(slug) +
      '?amount=' +
      encodeURIComponent(usdAmount8) +
      '&chainId=' +
      encodeURIComponent(String(chainId))
    );
  }

  /**
   * Fetch the public branding for a slug. Resolves to the parsed payload, or
   * null on ANY failure (404, network down, CORS, malformed JSON) so the caller
   * keeps the default button. Never throws to the host page.
   *
   * @param {string} slug - the merchant's checkout slug.
   * @returns {Promise<{name?:string,description?:string,brandColor?:string}|null>}
   */
  function fetchBranding(slug) {
    return fetch(brandingUrl(slug), { method: 'GET' })
      .then(function (r) {
        return r && r.ok ? r.json() : null;
      })
      .then(function (json) {
        return json && typeof json === 'object' && typeof json.name === 'string' ? json : null;
      })
      .catch(function () {
        return null;
      });
  }

  /**
   * Re-validate a brand color to a safe 6/8-char hex before it is ever written
   * into an inline style on the host page (mirrors the server-side CR law). Any
   * malformed value falls back to null so the default button color is kept.
   *
   * @param {string} color - the candidate color from the branding payload.
   * @returns {string|null} a `#RRGGBB`/`#RRGGBBAA` string, or null.
   */
  function safeBrandColor(color) {
    if (typeof color !== 'string') return null;
    var hex = color.replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(hex) || /^[0-9a-fA-F]{8}$/.test(hex)) {
      return '#' + hex;
    }
    return null;
  }

  /**
   * Boot a single embed instance for one `<script>` tag: read config, inject
   * the button, fire the (single) quote call, and update the label. All wrapped
   * so any unexpected error is swallowed — the host page is never broken.
   *
   * @param {Element} scriptEl - the embed's <script> element.
   * @returns {void}
   */
  function boot(scriptEl) {
    try {
      var cfg = readConfig(scriptEl);
      if (!cfg) return; // invalid config → inject nothing (graceful)
      var chain = CHAIN_DEFAULTS[cfg.chainId];

      injectStyles();
      var btn = makeButton(cfg.label, cfg.usdDisplay, cfg.theme);
      var labelSpan = btn.querySelector('.a0x1-label');
      var priceSpan = btn.querySelector('.a0x1-price');
      // A slug tag opens the BRANDED checkout (/c/{slug}); a numeric tag opens
      // the merchant checkout (/m/{merchantId}) exactly as before.
      var url = cfg.slug
        ? slugCheckoutUrl(cfg.slug, cfg.usdAmount8, cfg.chainId)
        : checkoutUrl(cfg.merchantId, cfg.usdAmount8, cfg.chainId);
      btn.addEventListener('click', function () {
        window.open(url, '_blank', 'noopener');
      });
      placeInDom(btn, scriptEl, cfg.container);

      // The single, gas-free quote read. Only runs when a merchant id is known
      // (a slug-only tag has no merchant id yet → no eth_call, USD-only price).
      if (cfg.merchantId) {
        quote(chain, cfg.merchantId, cfg.usdAmount8)
          .then(function (tokenAmount) {
            if (tokenAmount == null) {
              btn.setAttribute('data-state', 'ready');
              return; // USD-only fallback (Law #4: never a stale guess)
            }
            var amt = formatTokenAmount(tokenAmount, chain.usdcDecimals);
            priceSpan.textContent = cfg.usdDisplay + ' · ~' + amt + ' USDC';
            btn.setAttribute('data-state', 'ready');
          })
          .catch(function () {
            btn.setAttribute('data-state', 'ready');
          });
      } else {
        btn.setAttribute('data-state', 'ready');
      }

      // White-label: when a slug is present, fetch the public branding and theme
      // the button (label "Pay {name}", brand color). Best-effort: any failure
      // leaves the default button untouched (graceful degradation).
      if (cfg.slug) {
        fetchBranding(cfg.slug)
          .then(function (b) {
            if (!b) return;
            if (b.name && labelSpan) labelSpan.textContent = 'Pay ' + b.name;
            var color = safeBrandColor(b.brandColor);
            if (color && btn.style && btn.style.setProperty) {
              btn.style.setProperty('--a0x1-bg', color);
            }
          })
          .catch(function () {
            /* keep the default button */
          });
      }
    } catch (_e) {
      // Absolute backstop: never propagate to the host page.
    }
  }

  /**
   * Entry point. Resolve THIS script element (multiple embeds on one page each
   * run their own IIFE copy; `document.currentScript` is correct at parse time)
   * and boot it once the DOM is ready.
   *
   * @returns {void}
   */
  function main() {
    var scriptEl = document.currentScript;
    if (!scriptEl) {
      // Defensive: pick the last embed.js script tag if currentScript is null.
      // Match both the numeric (data-merchant) and the slug (data-slug) tags.
      var scripts = document.querySelectorAll('script[data-merchant],script[data-slug]');
      scriptEl = scripts.length ? scripts[scripts.length - 1] : null;
    }
    if (!scriptEl) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        boot(scriptEl);
      });
    } else {
      boot(scriptEl);
    }
  }

  main();
})();
