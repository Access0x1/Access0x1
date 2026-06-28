/**
 * wallet.ts — the mocked injected-wallet + network fixture for the Playwright
 * e2e journeys.
 *
 * WHY THIS EXISTS
 * The two critical web journeys (merchant onboarding and buyer checkout) both
 * sit behind a wallet and a live chain: the onboard form keys its branding to
 * `primaryWallet.address`, and checkout reads the merchant on-chain, fetches a
 * USD→token quote, and settles with `payToken(...)`. Running those for real
 * would need a funded key, a live RPC, and the Dynamic backend — none of which
 * belong in CI. So we mock every external boundary deterministically and use NO
 * real keys or funds:
 *
 *   1. An EIP-1193 + EIP-6963 injected provider (`window.ethereum`) backed by a
 *      fixed dummy account. Dynamic discovers it through wagmi's 6963 path
 *      (`multiInjectedProviderDiscovery: true` in app/providers.tsx) and routes
 *      all signing through it. `eth_sendTransaction` returns a fixed tx hash —
 *      no chain, no gas.
 *   2. `page.route` over the chain's JSON-RPC URL so every viem read the browser
 *      makes (`merchants()`, `quote()`, ERC-20 `allowance()`) and the post-send
 *      receipt poll (`eth_getTransactionReceipt`) resolve to fixtures. The
 *      `PaymentReceived` log is ABI-encoded with viem so the app's real
 *      `parseEventLogs` decodes it exactly as it would on-chain.
 *   3. `page.route` over the app's own `/api/branding/{slug}` and `/api/quote`
 *      routes (the checkout's two app-level fetches), and over Dynamic's SDK
 *      init endpoints so the provider mounts offline.
 *
 * SCOPE / STABILITY
 * The EIP-1193 provider and the chain/app route mocks are the stable core and
 * almost never change. The Dynamic-specific pieces (the `connect-only` config
 * stub + the modal-click `connectWallet` helper) are the only version-sensitive
 * surface and are deliberately quarantined here, so a Dynamic SDK bump touches
 * exactly one file. Everything is keyed off the same constants below.
 *
 * The fixture targets BASE SEPOLIA (chain 84532) on purpose: it is the one
 * supported chain whose router/USDC come from static `NEXT_PUBLIC_*_84532` env
 * keys (settable from playwright.config.ts) AND whose explorer is known, so the
 * receipt renders a real `https://sepolia.basescan.org/tx/...` link — the
 * tx-hash-link assertion the checkout journey makes.
 */

import { test as base, expect, type Page, type Route } from '@playwright/test'
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  pad,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem'

// ── Fixed, deterministic test data (no real keys, no real funds) ─────────────

/** The chain the journeys run on (Base Sepolia — has a real explorer + static env keys). */
export const TEST_CHAIN_ID = 84532

/** The chain id in the 0x form an EIP-1193 `eth_chainId` returns. */
const TEST_CHAIN_ID_HEX = toHex(TEST_CHAIN_ID)

/** The dummy buyer/merchant account the injected wallet "owns". Never holds real funds. */
export const TEST_ACCOUNT: Address = getAddress('0x1111111111111111111111111111111111111111')

/** The merchant's payout address (read back from the mocked `merchants()` call). */
export const TEST_PAYOUT: Address = getAddress('0x2222222222222222222222222222222222222222')

/** The router + USDC addresses the app resolves from `NEXT_PUBLIC_*_84532` (set in the config). */
export const TEST_ROUTER: Address = getAddress('0x3333333333333333333333333333333333333333')
export const TEST_USDC: Address = getAddress('0x4444444444444444444444444444444444444444')

/** The fixed tx hash every mocked send resolves to — what the receipt links to. */
export const TEST_TX_HASH: Hex = '0xabc1230000000000000000000000000000000000000000000000000000000def'

/** The on-chain merchant id the checkout slug resolves to. */
export const TEST_MERCHANT_ID = 7n

/** USDC display decimals on Base Sepolia (bridged USDC is canonical 6-dec). */
const USDC_DECIMALS = 6

/**
 * The minimal subset of the router ABI the mocked RPC needs to ENCODE replies
 * for. Kept local (not imported from app code) so the fixture stays a black-box
 * contract test of the app's decoders — it must encode exactly what the app's
 * real `lib/contracts.ts` ABI expects to decode.
 */
const ROUTER_REPLY_ABI = [
  {
    type: 'function',
    name: 'merchants',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [
      { name: 'payout', type: 'address' },
      { name: 'owner', type: 'address' },
      { name: 'feeRecipient', type: 'address' },
      { name: 'feeBps', type: 'uint16' },
      { name: 'active', type: 'bool' },
      { name: 'nameHash', type: 'bytes32' },
    ],
  },
  {
    type: 'event',
    name: 'PaymentReceived',
    inputs: [
      { name: 'merchantId', type: 'uint256', indexed: true },
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'grossAmount', type: 'uint256', indexed: false },
      { name: 'feeAmount', type: 'uint256', indexed: false },
      { name: 'netAmount', type: 'uint256', indexed: false },
      { name: 'usdAmount8', type: 'uint256', indexed: false },
      { name: 'orderId', type: 'bytes32', indexed: false },
      { name: 'srcChainSelector', type: 'uint64', indexed: false },
    ],
  },
] as const satisfies Abi

// 4-byte selectors of the view calls the browser makes against the RPC. We
// dispatch on these so the mock answers the right call regardless of arg order.
const SELECTOR = {
  /** keccak256("merchants(uint256)")[:4] */
  merchants: '0x92c8823b',
  /** keccak256("quote(uint256,address,uint256)")[:4] */
  quote: '0x6fc904ca',
  /** keccak256("allowance(address,address)")[:4] — ERC-20 */
  allowance: '0xdd62ed3e',
} as const

/**
 * Per-test scenario knobs. Sensible "happy path" defaults; a spec overrides a
 * field to exercise an edge (e.g. `onChain: false` for a branded-but-not-yet-on
 * merchant, or `quoteError` for a stale-price banner).
 */
export interface WalletScenario {
  /** The display name returned by the branding endpoint (the "Pay {name}" header). */
  merchantName: string
  /** The checkout slug the branding endpoint answers for. */
  slug: string
  /** Whether the merchant is registered on-chain (drives whether the pay card shows). */
  onChain: boolean
  /** Whether the merchant is currently accepting payments (`merchants().active`). */
  active: boolean
  /** Token amount (in 6-dec USDC base units) the quote returns; default ≈ 29.01 USDC. */
  quoteTokenAmount: bigint
  /** When set, `/api/quote` returns this revert name instead of an amount (e.g. stale price). */
  quoteError?: string
}

const DEFAULT_SCENARIO: WalletScenario = {
  merchantName: "Joe's Barbershop",
  slug: 'joes-barbershop',
  onChain: true,
  active: true,
  // 29.01 USDC at 6 decimals — intentionally a hair over $29.00 so the "≈ 29.01
  // USDC" quote line is visibly the QUOTE, not the USD price echoed back.
  quoteTokenAmount: 29_010_000n,
}

// ── EIP-1193 / EIP-6963 injected provider (runs in the page) ─────────────────

/**
 * The init-script source injected into the page BEFORE any app code runs. It
 * installs a fake EIP-1193 provider on `window.ethereum`, announces it over
 * EIP-6963 (the discovery path app/providers.tsx opts into), and answers the
 * handful of RPC methods Dynamic + viem's wallet client call during connect and
 * `eth_sendTransaction`. Read-only `eth_call`s and the receipt poll are NOT
 * handled here — those go to the HTTP RPC, which we intercept with `page.route`
 * so a single source of truth (viem-encoded fixtures) backs every read.
 *
 * Templated with the fixed account + chain so the page needs no imports.
 */
function injectedProviderScript(account: Address, chainIdHex: Hex, txHash: Hex): string {
  return `(() => {
    const ACCOUNT = ${JSON.stringify(account)};
    const CHAIN_ID = ${JSON.stringify(chainIdHex)};
    const TX_HASH = ${JSON.stringify(txHash)};

    // A minimal, standards-shaped EIP-1193 provider. It is deliberately dumb:
    // connection + signing only; all chain *reads* travel over HTTP where the
    // Playwright route handlers answer them.
    const listeners = {};
    const provider = {
      isMetaMask: true,
      _isMockWallet: true,
      async request({ method, params }) {
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return [ACCOUNT];
          case 'eth_chainId':
            return CHAIN_ID;
          case 'net_version':
            return String(parseInt(CHAIN_ID, 16));
          case 'wallet_switchEthereumChain':
          case 'wallet_addEthereumChain':
            return null;
          case 'eth_sendTransaction':
            // No real broadcast — viem's wallet client gets a hash and then
            // polls the (mocked) RPC for the receipt.
            return TX_HASH;
          case 'personal_sign':
          case 'eth_sign':
            // 65-byte dummy signature — enough for any optional ownership step.
            return '0x' + '00'.repeat(65);
          case 'eth_signTypedData_v4':
            return '0x' + '00'.repeat(65);
          default:
            // Anything else (e.g. eth_blockNumber) is served by the HTTP route.
            throw Object.assign(new Error('Unsupported method: ' + method), { code: 4200 });
        }
      },
      on(event, handler) {
        (listeners[event] ||= []).push(handler);
        return provider;
      },
      removeListener(event, handler) {
        listeners[event] = (listeners[event] || []).filter((h) => h !== handler);
        return provider;
      },
    };

    window.ethereum = provider;

    // EIP-6963: announce the provider so wagmi/Dynamic discover it by rdns.
    const info = {
      uuid: '00000000-0000-0000-0000-000000000000',
      name: 'Mock Wallet',
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
      rdns: 'app.access0x1.mockwallet',
    };
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: Object.freeze({ info, provider }),
        }),
      );
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  })();`
}

// ── viem-encoded RPC reply helpers ───────────────────────────────────────────

/** Encode a `merchants(id)` view result the app's `getMerchant` will decode. */
function encodeMerchantsResult(active: boolean): Hex {
  return encodeFunctionResult({
    abi: ROUTER_REPLY_ABI,
    functionName: 'merchants',
    result: [
      TEST_PAYOUT, // payout
      TEST_ACCOUNT, // owner (non-zero → the page treats the merchant as real)
      TEST_PAYOUT, // feeRecipient
      100, // feeBps (1%)
      active, // active
      pad('0x00', { size: 32 }), // nameHash (none committed)
    ],
  })
}

/** Encode a single ABI word (uint256/allowance) reply. */
function encodeUint(value: bigint): Hex {
  return pad(toHex(value), { size: 32 })
}

/**
 * Build a fully-formed `PaymentReceived` log (topics + data) for the mocked
 * receipt. Encoded with viem so the app's real `parseEventLogs` decodes it into
 * the `PaymentReceivedEvent` the receipt screen renders.
 */
function buildPaymentReceivedLog(scenario: WalletScenario): {
  address: Address
  topics: Hex[]
  data: Hex
} {
  const gross = scenario.quoteTokenAmount
  const fee = gross / 100n // 1% — matches the mocked feeBps
  const net = gross - fee
  // usdAmount8 for $29.00 (the default checkout amount, 8-dec) — echoed on the receipt.
  const usdAmount8 = 2_900_000_000n
  const orderId = pad('0xdead', { size: 32 })

  const topics = encodeEventTopics({
    abi: ROUTER_REPLY_ABI,
    eventName: 'PaymentReceived',
    args: { merchantId: TEST_MERCHANT_ID, buyer: TEST_ACCOUNT, token: TEST_USDC },
  })

  const data = encodeAbiParameters(
    [
      { name: 'grossAmount', type: 'uint256' },
      { name: 'feeAmount', type: 'uint256' },
      { name: 'netAmount', type: 'uint256' },
      { name: 'usdAmount8', type: 'uint256' },
      { name: 'orderId', type: 'bytes32' },
      { name: 'srcChainSelector', type: 'uint64' },
    ],
    [gross, fee, net, usdAmount8, orderId, 0n],
  )

  return { address: TEST_ROUTER, topics: topics as Hex[], data }
}

// ── JSON-RPC HTTP interception ───────────────────────────────────────────────

let rpcId = 1
const jsonRpcResult = (id: number | string, result: unknown) =>
  JSON.stringify({ jsonrpc: '2.0', id, result })

/**
 * Answer a single JSON-RPC request (the body of a viem HTTP transport call).
 * Reads are dispatched by the `eth_call` selector; the receipt poll returns a
 * success receipt carrying the encoded `PaymentReceived` log.
 */
function handleRpcRequest(body: { id: number | string; method: string; params?: unknown[] }, scenario: WalletScenario): string {
  const { id, method, params = [] } = body

  switch (method) {
    case 'eth_chainId':
      return jsonRpcResult(id, TEST_CHAIN_ID_HEX)
    case 'eth_blockNumber':
      return jsonRpcResult(id, toHex(0x100))
    case 'net_version':
      return jsonRpcResult(id, String(TEST_CHAIN_ID))
    case 'eth_call': {
      const call = params[0] as { data?: Hex; to?: Address }
      const data = (call?.data ?? '0x') as Hex
      const selector = data.slice(0, 10)
      if (selector === SELECTOR.merchants) {
        return jsonRpcResult(id, encodeMerchantsResult(scenario.active))
      }
      if (selector === SELECTOR.quote) {
        return jsonRpcResult(id, encodeUint(scenario.quoteTokenAmount))
      }
      if (selector === SELECTOR.allowance) {
        // Report a generous existing allowance so the pay path skips `approve`
        // and goes straight to the single `payToken` send — fewer round-trips,
        // one deterministic tx to assert on.
        return jsonRpcResult(id, encodeUint(2n ** 200n))
      }
      // Unknown read → empty word (decodes to 0/zero-address; harmless).
      return jsonRpcResult(id, pad('0x00', { size: 32 }))
    }
    case 'eth_getTransactionReceipt':
      return jsonRpcResult(id, {
        transactionHash: TEST_TX_HASH,
        transactionIndex: '0x0',
        blockHash: pad('0xb10c', { size: 32 }),
        blockNumber: toHex(0x100),
        from: TEST_ACCOUNT,
        to: TEST_ROUTER,
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        contractAddress: null,
        logs: [{ ...buildPaymentReceivedLog(scenario), logIndex: '0x0', transactionIndex: '0x0', transactionHash: TEST_TX_HASH, blockHash: pad('0xb10c', { size: 32 }), blockNumber: toHex(0x100), removed: false }],
        logsBloom: '0x' + '00'.repeat(256),
        status: '0x1',
        type: '0x2',
        effectiveGasPrice: '0x1',
      })
    case 'eth_getTransactionByHash':
      return jsonRpcResult(id, {
        hash: TEST_TX_HASH,
        nonce: '0x0',
        blockHash: pad('0xb10c', { size: 32 }),
        blockNumber: toHex(0x100),
        transactionIndex: '0x0',
        from: TEST_ACCOUNT,
        to: TEST_ROUTER,
        value: '0x0',
        gas: '0x5208',
        gasPrice: '0x1',
        input: '0x',
        type: '0x2',
      })
    case 'eth_estimateGas':
      return jsonRpcResult(id, '0x5208')
    case 'eth_gasPrice':
      return jsonRpcResult(id, '0x1')
    case 'eth_getBalance':
      return jsonRpcResult(id, toHex(10n ** 20n))
    case 'eth_sendRawTransaction':
      return jsonRpcResult(id, TEST_TX_HASH)
    default:
      // Be permissive: any unhandled method returns null rather than erroring,
      // so an incidental viem probe never fails the journey.
      return jsonRpcResult(id, null)
  }
}

/** Route the chain's HTTP RPC (Base Sepolia public endpoints) to the handler. */
async function routeRpc(page: Page, scenario: WalletScenario): Promise<void> {
  const handler = async (route: Route) => {
    let raw: unknown
    try {
      raw = route.request().postDataJSON()
    } catch {
      raw = undefined
    }
    // viem batches are arrays; single calls are objects.
    const reply = Array.isArray(raw)
      ? '[' + raw.map((b) => handleRpcRequest(b as never, scenario)).join(',') + ']'
      : handleRpcRequest((raw as never) ?? { id: rpcId++, method: 'unknown' }, scenario)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: reply,
    })
  }
  // Cover the public Base Sepolia endpoints viem may use, plus any override.
  await page.route('**/sepolia.base.org/**', handler)
  await page.route('https://sepolia.base.org/', handler)
  await page.route('**base-sepolia**', handler)
}

// ── App-level fetch interception (`/api/branding/{slug}`, `/api/quote`) ───────

/** The public branding payload the checkout page fetches (a subset; the rest is harmless extra). */
function brandingPayload(scenario: WalletScenario) {
  return {
    name: scenario.merchantName,
    description: 'Fresh cuts & hot-towel shaves in Brooklyn',
    logoSvg: '',
    brandColor: '#22d3ee',
    merchantId: scenario.onChain ? TEST_MERCHANT_ID.toString() : null,
    router: TEST_ROUTER,
    chainId: TEST_CHAIN_ID,
    onChain: scenario.onChain,
    checkoutMode: 'standard',
    humanVerifier: 'offchain',
    requiredTier: 'standard',
    vertical: 'other',
    verifiedOperator: false,
  }
}

/** Route the app's own data endpoints used by the checkout journey. */
async function routeAppApis(page: Page, scenario: WalletScenario): Promise<void> {
  await page.route('**/api/branding/**', async (route) => {
    const url = new URL(route.request().url())
    // Only the public `{slug}` lookup is mocked here; sub-routes fall through.
    const isSlugLookup = /\/api\/branding\/[^/]+$/.test(url.pathname)
    if (!isSlugLookup) return route.fallback()
    const slug = decodeURIComponent(url.pathname.split('/').pop() ?? '')
    if (slug !== scenario.slug) {
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not_found' }) })
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(brandingPayload(scenario)),
    })
  })

  await page.route('**/api/quote**', async (route) => {
    const body = scenario.quoteError
      ? { error: scenario.quoteError }
      : { tokenAmount: scenario.quoteTokenAmount.toString() }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })

  // The onboard branding form posts/saves + checks slug availability. Stub those
  // so onboarding completes offline with a deterministic checkout slug.
  await page.route('**/api/branding', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const post = (route.request().postDataJSON() ?? {}) as { displayName?: string; checkoutSlug?: string }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        branding: {
          tenantId: TEST_ACCOUNT.toLowerCase(),
          displayName: post.displayName ?? scenario.merchantName,
          description: '',
          brandColor: '#22d3ee',
          checkoutSlug: post.checkoutSlug ?? scenario.slug,
          logoSvgInline: '',
          merchantId: null,
          nameHash: undefined,
        },
      }),
    })
  })

  await page.route('**/api/branding/check-slug**', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ valid: true, available: true, suggestions: [] }),
    }),
  )

  // No existing row for the fresh test tenant (the form's prefill load).
  await page.route('**/api/branding/by-merchant/**', async (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not_found' }) }),
  )
}

// ── Dynamic SDK init interception (mounts the provider offline) ───────────────

/**
 * Stub Dynamic's SDK init traffic so the provider mounts without the real
 * backend. We answer the environment/project read with a minimal connect-only
 * config and 204 the analytics/telemetry beacons. This is the ONLY
 * Dynamic-version-sensitive surface in the suite — if a Dynamic bump changes the
 * init shape, this one function is where it is updated.
 */
async function routeDynamic(page: Page): Promise<void> {
  await page.route('**app.dynamicauth.com/**', async (route) => {
    const url = route.request().url()
    // Telemetry / logging beacons → empty 204, never block the UI.
    if (/\/(events|analytics|visits|logs)\b/.test(url)) {
      return route.fulfill({ status: 204, body: '' })
    }
    // Everything else (env config, well-known, etc.) → permissive empty-OK JSON.
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
  await page.route('**logs.dynamicauth.com/**', (route) => route.fulfill({ status: 204, body: '' }))
  await page.route('**dynamic-static-assets.com/**', (route) => route.fulfill({ status: 200, body: '' }))
}

// ── The exported fixture ─────────────────────────────────────────────────────

/**
 * The mock-wallet test fixture. Use `test`/`expect` from here instead of
 * `@playwright/test`. Each test receives a pre-wired `wallet` whose `setup()`
 * installs the injected provider + every network mock, with an optional scenario
 * override.
 */
export interface WalletFixture {
  /** The dummy connected account. */
  account: Address
  /** Install the injected provider + all route mocks for the given scenario. Call before `goto`. */
  setup(overrides?: Partial<WalletScenario>): Promise<WalletScenario>
  /**
   * Connect the injected wallet on the BUYER checkout. The checkout uses plain
   * wagmi now (no Dynamic — keeps shoppers off the MAU meter), so this clicks the
   * wagmi `BuyerConnectButton`. With one EIP-6963-discovered connector ("Mock
   * Wallet") that single click connects directly (no modal); if a picker appears
   * we click the wallet by name. Best-effort + resilient: if the connected
   * address chip is already present it returns immediately. Returns true once a
   * connected address is visible.
   */
  connect(): Promise<boolean>
}

export const test = base.extend<{ wallet: WalletFixture }>({
  wallet: async ({ page }, use) => {
    let scenario: WalletScenario = DEFAULT_SCENARIO

    const fixture: WalletFixture = {
      account: TEST_ACCOUNT,

      async setup(overrides) {
        scenario = { ...DEFAULT_SCENARIO, ...overrides }
        // Provider must exist before the app's first script runs.
        await page.addInitScript(injectedProviderScript(TEST_ACCOUNT, TEST_CHAIN_ID_HEX, TEST_TX_HASH))
        await routeDynamic(page)
        await routeRpc(page, scenario)
        await routeAppApis(page, scenario)
        return scenario
      },

      async connect() {
        // Already connected? The BuyerConnectButton swaps to a truncated-address chip.
        const addrChip = page.getByText(/0x1111…1111/i)
        if (await addrChip.isVisible().catch(() => false)) return true

        const connectBtn = page.getByRole('button', { name: /connect wallet/i }).first()
        if (await connectBtn.isVisible().catch(() => false)) {
          await connectBtn.click()
          // Single discovered connector ("Mock Wallet") connects on that click. If
          // wagmi surfaced several, BuyerConnectButton shows a picker listing each
          // wallet by name — click ours by its announced EIP-6963 name if present.
          const entry = page.getByRole('button', { name: /mock wallet/i }).first()
          await entry.click({ timeout: 2_000 }).catch(() => undefined)
        }

        // Wait for the connected chip, however the connection resolved.
        return addrChip
          .first()
          .waitFor({ state: 'visible', timeout: 10_000 })
          .then(() => true)
          .catch(() => false)
      },
    }

    await use(fixture)
  },
})

export { expect }
