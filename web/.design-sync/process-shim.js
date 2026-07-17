// design-sync extraEntries shim — must stay a zero-import leaf module so it
// evaluates before every other extraEntries/component module (ESM evaluates
// dependency-free modules first; this has none).
//
// Next.js's own bundler statically replaces every `process.env.NEXT_PUBLIC_*`
// reference at ITS build time; our raw esbuild bundle only defines
// `process.env.NODE_ENV` (lib/bundle.mjs). lib/chains.ts reads several other
// NEXT_PUBLIC_* vars at module top level (RPC URLs, router/USDC addresses per
// chain) with `|| <default>` fallbacks — those fallbacks are exactly what
// should fire here, but only once `process` itself exists as an identifier;
// without it the property access throws `ReferenceError: process is not
// defined` before any component can render. This shim exists so those
// fallbacks can do their job instead.
if (typeof globalThis.process === 'undefined') {
  globalThis.process = { env: {} };
}
export {};
