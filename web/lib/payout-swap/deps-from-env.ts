/**
 * @file deps-from-env.ts — assemble {@link PayoutSwapDeps} from server-side env, fail-soft per rail.
 *
 * The payout-swap worker ({@link runPayoutSwap}) is rail-agnostic — it takes a client built from
 * these deps. This module is the ONE place that reads server env to decide which rails are LIVE,
 * so the worker stays a pure, offline-testable island and this is the only env-touching seam.
 *
 * Each rail is INDEPENDENTLY env-gated: a rail whose env is absent stays `undefined` (dormant), and
 * `selectPayoutSwapClient` then throws "not configured" for that chain — which the route maps to a
 * non-blocking `swapped: false` result (law #5: the merchant keeps settled USDC). Never a crash,
 * never a faked "ready".
 *
 * PUBLIC-SAFE: every value here is a server-only secret/URL read from `process.env`; `.env.example`
 * carries the NAMES only. This file must only be imported from a `runtime = "nodejs"` route — it is
 * never bundled into client code, so the Uniswap key / Blink RPC never reach the browser.
 */
import type { PayoutSwapDeps } from './index.js'
import type { FetchLike } from './rails/uniswapTradingApi.js'
import type { SubmitRawTx } from './rails/uniswapClassic.js'

/** Read a trimmed env var ('' when unset) — the single env accessor, mirrors lib/funding/blink.ts. */
function env(name: string): string {
  return (process.env[name] ?? '').trim()
}

/**
 * The Universal Router version the Trading API is asked to build calldata for.
 *
 * Pinned, not defaulted: the header is OPTIONAL (live-verified 2026-10-01 — omitting it returned
 * the same 2.1.2 router on Ethereum Sepolia), but Uniswap's supported-chains page says the default
 * "can change over time, so set the header explicitly when you need a stable target". The pin also
 * decides the Permit2 spender, so a silent default change would silently invalidate grants.
 *
 * 2.0 and 2.1.1 stop being served on 2026-10-21: after that a request pinning either gets an error
 * response (Uniswap changelog, "Sunset of Universal Router 2.0 and 2.1.1"). This repo sent 2.0
 * until 2026-10-01. Moving 2.0 → 2.1.2 changes the returned calldata (a per-hop `minHopPriceX36`
 * array) and the router address; nothing here decodes that calldata or allowlists that address —
 * the `to`/`data` the API returns go to the wallet owner untouched — so the header is the whole
 * migration. Anything added later that parses the calldata must pass the matching
 * `UniversalRouterVersion` to the SDK parser (`@uniswap/universal-router-sdk` >= 5.12.0).
 */
export const UNISWAP_UNIVERSAL_ROUTER_VERSION = '2.1.2'

/**
 * Wrap fetch to inject the Uniswap Trading API key header when one is configured (else plain fetch).
 *
 * @param apiKey        The `x-api-key` value ('' ⇒ no key header).
 * @param routerVersion The `x-universal-router-version` to pin, or `undefined` to send no version
 *   header and take the API's default for the chain.
 */
function makeKeyedFetch(apiKey: string, routerVersion?: string): FetchLike {
  // The API's Cloudflare front rejects some non-browser client signatures (error 1010) — an
  // explicit product User-Agent keeps server-side calls deterministic. Accept per the official
  // quickstart. These ride every request whether or not a key is set.
  const base = {
    accept: 'application/json',
    'user-agent': 'access0x1-payout-rail/1.0',
    ...(routerVersion ? { 'x-universal-router-version': routerVersion } : {}),
  }
  return (url, init) =>
    fetch(url, {
      ...init,
      headers: {
        ...base,
        ...(init?.headers ?? {}),
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
    })
}

/** Wrap fetch to inject the 1inch `Authorization: Bearer <key>` header (else plain fetch). */
function makeBearerFetch(apiKey: string): FetchLike {
  if (!apiKey) return (url, init) => fetch(url, init)
  return (url, init) =>
    fetch(url, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${apiKey}` } })
}

/** A raw-tx submitter against a JSON-RPC endpoint (`eth_sendRawTransaction`). Throws on RPC error. */
function makeRpcSubmit(rpcUrl: string): SubmitRawTx {
  return async (rawTx: string): Promise<string> => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [rawTx] }),
    })
    const data = (await res.json()) as { result?: string; error?: { message?: string } }
    if (data.error) throw new Error(data.error.message ?? 'rpc submit rejected')
    if (!data.result) throw new Error('rpc submit returned no tx hash')
    return data.result
  }
}

/**
 * Build the per-chain rail deps from server env. Returns ONLY the rails whose env is present;
 * absent rails are left `undefined` so the worker degrades to a safe no-op for those chains.
 * Never throws — a missing var just leaves that rail dormant.
 */
export function buildPayoutSwapDeps(): PayoutSwapDeps {
  const deps: {
    uniswapTradingApi?: PayoutSwapDeps['uniswapTradingApi']
    uniswapClassic?: PayoutSwapDeps['uniswapClassic']
    circleAppKit?: PayoutSwapDeps['circleAppKit']
    oneInch?: PayoutSwapDeps['oneInch']
  } = {}

  // Uniswap Trading API (Base, gasless UniswapX) + Uniswap classic (zkSync). Both share the
  // Trading API base URL and key, but NOT the router-version pin. The classic rail additionally
  // needs a chain RPC to submit the signed tx, with optional Blink Recovery tried first.
  const tradingApiUrl = env('UNISWAP_TRADING_API_URL')
  if (tradingApiUrl) {
    const apiKey = env('UNISWAP_TRADING_API_KEY')
    deps.uniswapTradingApi = {
      baseUrl: tradingApiUrl,
      fetchImpl: makeKeyedFetch(apiKey, UNISWAP_UNIVERSAL_ROUTER_VERSION),
    }

    const zkRpc = env('ZKSYNC_SEPOLIA_RPC_URL')
    if (zkRpc) {
      const blinkRpc = env('BLINK_RPC_URL') // base.blinklabs.xyz/v1/{key} — recovery, tried first
      deps.uniswapClassic = {
        baseUrl: tradingApiUrl,
        // No version header on zkSync. Per Uniswap's supported-chains page zkSync "has no 2.1.2
        // and runs 2.0 only", and requesting a version a chain lacks returns an error — so
        // pinning 2.1.2 is wrong there, and pinning 2.0 is the value being sunset. Omitting the
        // header takes the API default, which is the one version zkSync has. Documented, NOT
        // live-observed: on 2026-10-01 zkSync (324) answered "No quotes available" under every
        // header, and zkSync Sepolia (300) is not a chain id the API accepts at all.
        fetchImpl: makeKeyedFetch(apiKey),
        submitDirect: makeRpcSubmit(zkRpc),
        submitBlink: blinkRpc ? makeRpcSubmit(blinkRpc) : undefined,
      }
    }
  }

  // Arc → Circle App Kit Swap. The `@circle-fin/app-kit` SDK is not installed yet, so this rail
  // stays dormant. When the SDK is wired (see PROGRESS), build it here:
  //   if (env('CIRCLE_APP_KIT_ENABLED')) deps.circleAppKit = buildAppKitSdk(/* viem adapter */)

  // 1inch aggregator rail. Independently env-gated: absent `ONEINCH_API_URL` ⇒ dormant. The 1inch
  // API key (if any) rides a `Authorization: Bearer` fetch; blank key ⇒ plain fetch.
  const oneInchUrl = env('ONEINCH_API_URL')
  if (oneInchUrl) {
    deps.oneInch = { baseUrl: oneInchUrl, fetchImpl: makeBearerFetch(env('ONEINCH_API_KEY')) }
  }

  return deps
}
