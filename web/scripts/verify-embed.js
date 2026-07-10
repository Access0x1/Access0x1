#!/usr/bin/env node
/**
 * verify-embed.js — dependency-free verification for the One-Tag Checkout embed.
 *
 * A vanilla browser IIFE has no unit-test framework wired in, so this script
 * provides the automatable slice of embed-js.spec.md's "Test / Verify Cases":
 *
 *   - the ABI quote-selector + calldata encoding,
 *   - the USD-decimal -> 8-decimal-integer conversion (incl. the zero-amount guard),
 *   - the token-amount display formatting,
 *   - the checkout-URL shape,
 *   - the build-time address-replacement script (replace + --check semantics),
 *   - an end-to-end boot of embed.js inside a minimal DOM/fetch shim
 *     (button injection, single eth_call, graceful USD-only fallback,
 *      zero-amount rejection, no window.* pollution).
 *
 * Run: `node scripts/verify-embed.js`  (exit 0 = all pass).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let passed = 0;
/**
 * Run one named assertion and tally it.
 * @param {string} name
 * @param {() => void} fn
 */
function test(name, fn) {
  fn();
  passed += 1;
  console.log('  ok - ' + name);
}

const embedSrc = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'embed.js'),
  'utf8',
);

// ---------------------------------------------------------------------------
// 1) Address-replacement script (directly requirable, no DOM).
// ---------------------------------------------------------------------------
const { replaceAddresses, PLACEHOLDERS } = require('./replace-embed-addrs.js');

test('replace: fills a set env var, leaves unset ones intact', () => {
  const src = 'router=__ROUTER_ADDRESS__ usdc=__ARC_USDC_ADDRESS__';
  const env = { NEXT_PUBLIC_ROUTER_ARC: '0x' + '1'.repeat(40) };
  const { output, replaced, skipped } = replaceAddresses(src, env);
  assert.ok(output.includes('0x' + '1'.repeat(40)));
  assert.ok(output.includes('__ARC_USDC_ADDRESS__'));
  assert.deepStrictEqual(replaced, ['__ROUTER_ADDRESS__']);
  assert.ok(skipped.includes('__ARC_USDC_ADDRESS__'));
});

test('replace: rejects a set-but-malformed address', () => {
  assert.throws(() =>
    replaceAddresses('x=__ROUTER_ADDRESS__', { NEXT_PUBLIC_ROUTER_ARC: 'nope' }),
  );
});

test('replace: placeholder map matches the tokens present in embed.js', () => {
  for (const token of Object.keys(PLACEHOLDERS)) {
    assert.ok(embedSrc.includes(token), 'embed.js missing ' + token);
  }
});

// ---------------------------------------------------------------------------
// 2) Boot embed.js inside a minimal DOM + fetch shim.
// ---------------------------------------------------------------------------

/**
 * A tiny DOM element good enough for embed.js: children, attributes, dataset,
 * classList-free className, textContent, and querySelector by class.
 */
class El {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.className = '';
    this.type = '';
    this._text = '';
    this.parentNode = null;
    this.nextSibling = null;
    this.listeners = {};
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] != null ? this.attrs[k] : null;
  }
  appendChild(c) {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c, _ref) {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  addEventListener(ev, fn) {
    (this.listeners[ev] = this.listeners[ev] || []).push(fn);
  }
  click() {
    (this.listeners.click || []).forEach((f) => f());
  }
  set textContent(v) {
    this._text = v;
  }
  get textContent() {
    return this._text;
  }
  querySelector(sel) {
    const want = sel.replace(/^\./, '');
    const walk = (node) => {
      for (const ch of node.children) {
        if ((ch.className || '').split(/\s+/).includes(want)) return ch;
        const deep = walk(ch);
        if (deep) return deep;
      }
      return null;
    };
    return walk(this);
  }
}

/**
 * Build a fresh sandbox (document/window/location/fetch) and run embed.js with
 * the given script-tag dataset and fetch behavior.
 *
 * @param {object} dataset - data-* values for the embed's <script> tag.
 * @param {(url:string, opts:object) => Promise<any>} fetchImpl
 * @returns {{root: El, win: object, calls: any[]}}
 */
function bootEmbed(dataset, fetchImpl) {
  const head = new El('head');
  const body = new El('body');
  const scriptEl = new El('script');
  scriptEl.dataset = Object.assign({}, dataset);
  scriptEl.src = 'https://pay.access0x1.example/embed.js';
  body.appendChild(scriptEl);

  const containers = {};
  const document = {
    currentScript: scriptEl,
    readyState: 'complete',
    head,
    documentElement: new El('html'),
    body,
    createElement: (t) => new El(t),
    createTextNode: (t) => ({ nodeType: 3, text: t }),
    addEventListener: () => {},
    querySelector: (sel) => containers[sel] || null,
    querySelectorAll: () => [scriptEl],
    _containers: containers,
  };
  const opened = [];
  const win = {
    open: (url, target, feat) => {
      opened.push({ url, target, feat });
    },
  };
  const calls = [];
  const sandbox = {
    document,
    window: win,
    location: { href: 'https://merchant.example/', origin: 'https://merchant.example' },
    URL,
    BigInt,
    console: { warn: () => {}, error: () => {}, log: () => {} },
    fetch: (url, opts) => {
      calls.push({ url, opts });
      return fetchImpl(url, opts);
    },
    Promise,
    setTimeout,
  };
  // Embed reads globals bare (document, window, location) — also expose on
  // globalThis so unqualified references resolve inside the VM context.
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(embedSrc, sandbox);
  return { document, win, opened, calls, scriptEl, body };
}

/** A JSON-RPC eth_call success returning a uint256 (token amount). */
function rpcOk(tokenAmountHex) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: tokenAmountHex }),
  });
}

test('boot: injects a button after the script tag (basic injection)', () => {
  const { body } = bootEmbed(
    { merchant: '42', amountUsd: '29.00' },
    () => Promise.reject(new Error('network down')),
  );
  const btn = body.querySelector('.a0x1-btn');
  assert.ok(btn, 'button not injected');
  assert.strictEqual(btn.tagName, 'BUTTON');
  const label = btn.querySelector('.a0x1-label');
  assert.strictEqual(label.textContent, 'Pay with USDC');
});

test('boot: zero amount is rejected before any RPC call (no button)', () => {
  const { body, calls } = bootEmbed(
    { merchant: '42', amountUsd: '0' },
    () => {
      throw new Error('should not fetch');
    },
  );
  assert.strictEqual(calls.length, 0, 'must not call RPC for zero amount');
  assert.strictEqual(body.querySelector('.a0x1-btn'), null, 'no button for zero');
});

test('boot: missing merchant injects nothing', () => {
  const { body } = bootEmbed({ amountUsd: '29.00' }, () =>
    Promise.reject(new Error('x')),
  );
  assert.strictEqual(body.querySelector('.a0x1-btn'), null);
});

test('boot: placeholder router => exactly zero eth_calls, USD-only label', async () => {
  const { body, calls } = bootEmbed(
    { merchant: '7', amountUsd: '29.00' },
    () => rpcOk('0x' + (29n * 10n ** 18n).toString(16)),
  );
  await new Promise((r) => setTimeout(r, 0));
  // Source still has __PLACEHOLDER__ (no build run) → quote is skipped.
  assert.strictEqual(calls.length, 0, 'placeholder must skip the RPC entirely');
  const price = body.querySelector('.a0x1-price');
  assert.strictEqual(price.textContent, '$29.00', 'should show USD only');
});

test('boot (built): exactly ONE eth_call, label shows the live quote', async () => {
  // Simulate a post-build embed.js with real addresses.
  const built = embedSrc
    .split('__ROUTER_ADDRESS__')
    .join('0x' + 'a'.repeat(40))
    .split('__ARC_USDC_ADDRESS__')
    .join('0x' + 'b'.repeat(40));
  const head = new El('head');
  const body = new El('body');
  const scriptEl = new El('script');
  scriptEl.dataset = { merchant: '42', amountUsd: '29.00' };
  scriptEl.src = 'https://pay.access0x1.example/embed.js';
  body.appendChild(scriptEl);
  const calls = [];
  const document = {
    currentScript: scriptEl,
    readyState: 'complete',
    head,
    documentElement: new El('html'),
    body,
    createElement: (t) => new El(t),
    createTextNode: (t) => ({ nodeType: 3, text: t }),
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [scriptEl],
  };
  const sandbox = {
    document,
    window: { open: () => {} },
    location: { href: 'https://m.example/', origin: 'https://m.example' },
    URL,
    BigInt,
    console: { warn() {}, error() {}, log() {} },
    fetch: (url, opts) => {
      calls.push({ url, opts });
      return rpcOk('0x' + (29n * 10n ** 18n).toString(16)); // 29 USDC @ 18 dec
    },
    Promise,
    setTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(built, sandbox);
  await new Promise((r) => setTimeout(r, 0));

  assert.strictEqual(calls.length, 1, 'exactly one eth_call expected');
  assert.strictEqual(calls[0].url, 'https://rpc.testnet.arc.network');
  const sentBody = JSON.parse(calls[0].opts.body);
  assert.strictEqual(sentBody.method, 'eth_call');
  assert.strictEqual(sentBody.params[0].to, '0x' + 'a'.repeat(40));
  // calldata = selector + merchantId(42) + usdc + usdAmount8(2.9e9)
  assert.ok(sentBody.params[0].data.startsWith('0x6fc904ca'));
  assert.ok(sentBody.params[0].data.includes('b'.repeat(40)), 'token word present');
  const price = body.querySelector('.a0x1-price');
  assert.strictEqual(price.textContent, '$29.00 · ~29 USDC');
});

test('boot: graceful fallback when RPC rejects (built addrs, network down)', async () => {
  const built = embedSrc
    .split('__ROUTER_ADDRESS__')
    .join('0x' + 'a'.repeat(40))
    .split('__ARC_USDC_ADDRESS__')
    .join('0x' + 'b'.repeat(40));
  const head = new El('head');
  const body = new El('body');
  const scriptEl = new El('script');
  scriptEl.dataset = { merchant: '42', amountUsd: '29.00' };
  scriptEl.src = 'https://pay.access0x1.example/embed.js';
  body.appendChild(scriptEl);
  const document = {
    currentScript: scriptEl,
    readyState: 'complete',
    head,
    documentElement: new El('html'),
    body,
    createElement: (t) => new El(t),
    createTextNode: (t) => ({ nodeType: 3, text: t }),
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [scriptEl],
  };
  const sandbox = {
    document,
    window: { open: () => {} },
    location: { href: 'https://m.example/', origin: 'https://m.example' },
    URL,
    BigInt,
    console: { warn() {}, error() {}, log() {} },
    fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    Promise,
    setTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(built, sandbox);
  await new Promise((r) => setTimeout(r, 0));
  const price = body.querySelector('.a0x1-price');
  assert.strictEqual(price.textContent, '$29.00', 'USD-only on RPC failure');
  const btn = body.querySelector('.a0x1-btn');
  assert.strictEqual(btn.getAttribute('data-state'), 'ready');
});

test('boot: click opens checkout with merchantId, amount8, chainId', () => {
  const { body, win, opened } = bootEmbed(
    { merchant: '42', amountUsd: '29.00', chainId: '84532' },
    () => Promise.reject(new Error('x')),
  );
  // chainId 84532 router is also a placeholder → no fetch, button still works.
  const btn = body.querySelector('.a0x1-btn');
  btn.click();
  assert.strictEqual(opened.length, 1);
  const u = new URL(opened[0].url);
  assert.strictEqual(u.pathname, '/m/42');
  assert.strictEqual(u.searchParams.get('amount'), '2900000000');
  assert.strictEqual(u.searchParams.get('chainId'), '84532');
  assert.strictEqual(opened[0].target, '_blank');
});

test('boot: dark theme sets the data-theme attribute', () => {
  const { body } = bootEmbed(
    { merchant: '1', amountUsd: '5.00', theme: 'dark' },
    () => Promise.reject(new Error('x')),
  );
  assert.strictEqual(
    body.querySelector('.a0x1-btn').getAttribute('data-theme'),
    'dark',
  );
});

test('boot: data-container injects into the selected element', () => {
  const head = new El('head');
  const body = new El('body');
  const scriptEl = new El('script');
  scriptEl.dataset = { merchant: '1', amountUsd: '5.00', container: '#slot' };
  scriptEl.src = 'https://pay.example/embed.js';
  body.appendChild(scriptEl);
  const slot = new El('div');
  const document = {
    currentScript: scriptEl,
    readyState: 'complete',
    head,
    documentElement: new El('html'),
    body,
    createElement: (t) => new El(t),
    createTextNode: (t) => ({ nodeType: 3, text: t }),
    addEventListener: () => {},
    querySelector: (sel) => (sel === '#slot' ? slot : null),
    querySelectorAll: () => [scriptEl],
  };
  const sandbox = {
    document,
    window: { open: () => {} },
    location: { href: 'https://m.example/', origin: 'https://m.example' },
    URL,
    BigInt,
    console: { warn() {}, error() {}, log() {} },
    fetch: () => Promise.reject(new Error('x')),
    Promise,
    setTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(embedSrc, sandbox);
  assert.ok(slot.querySelector('.a0x1-btn'), 'button must be inside #slot');
});

test('no window.* pollution (no a0x1* globals leak)', () => {
  const { win } = bootEmbed(
    { merchant: '1', amountUsd: '5.00' },
    () => Promise.reject(new Error('x')),
  );
  const leaked = Object.keys(win).filter((k) => k.toLowerCase().startsWith('a0x1'));
  assert.deepStrictEqual(leaked, []);
});

console.log('\n' + passed + ' checks passed.');
