/**
 * Access0x1 embed — vanilla JS, no bundler, no framework, no external deps.
 *
 * Usage (drop into any HTML page, no build step):
 *   <script src="https://<host>/embed.js"
 *           data-merchant="42"
 *           data-amount-usd="29.00"></script>
 *
 * Optional:
 *   data-host="https://<host>"   override the checkout origin (defaults to the
 *                                origin this script was served from)
 *   data-label="Pay with Crypto" override the button text
 *
 * On click it opens the hosted checkout in a popup:
 *   <host>/m/<merchant>?amount=<amount>
 *
 * No API key is ever present here (the Claude key is server-side only).
 */
(function () {
  'use strict';

  // `document.currentScript` is the <script> tag executing right now.
  var script = document.currentScript;
  if (!script) {
    return;
  }

  var merchant = script.getAttribute('data-merchant');
  var amountUsd = script.getAttribute('data-amount-usd');
  var label = script.getAttribute('data-label') || 'Pay with Crypto';

  if (!merchant) {
    // Nothing to do without a merchant id — fail quietly, don't break the host page.
    return;
  }

  // Default the host to the origin this script was loaded from.
  var host = script.getAttribute('data-host');
  if (!host) {
    var src = script.getAttribute('src') || '';
    try {
      host = new URL(src, window.location.href).origin;
    } catch (e) {
      host = window.location.origin;
    }
  }

  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'ax1-pay-button';
  button.textContent = label;
  button.style.cssText =
    'display:inline-block;cursor:pointer;border:0;border-radius:8px;' +
    'padding:10px 18px;font:600 14px system-ui,sans-serif;' +
    'color:#fff;background:#6366F1;';

  button.addEventListener('click', function () {
    var url = host + '/m/' + encodeURIComponent(merchant);
    if (amountUsd) {
      url += '?amount=' + encodeURIComponent(amountUsd);
    }
    window.open(url, '_blank', 'width=420,height=680');
  });

  // Insert the button right after this script tag so it lands where embedded.
  if (script.parentNode) {
    script.parentNode.insertBefore(button, script.nextSibling);
  } else {
    document.body.appendChild(button);
  }
})();
