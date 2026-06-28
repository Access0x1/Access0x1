/**
 * config.ts — the PER-CHAIN x402 / Circle Nanopayments env seam.
 *
 * The x402 seller spine (lib/x402.ts) and the SessionGrant settlement leg need
 * four protocol values to build a payment requirement on a given chain:
 *   - the CAIP-2 network id        (e.g. "eip155:5042002")
 *   - the settlement USDC address  (the `asset` the payer authorizes)
 *   - the Gateway Wallet address   (the EIP-712 `verifyingContract`)
 *   - the facilitator base URL      (where verify/settle are POSTed)
 *
 * Historically these were hardcoded to Arc Testnet (see lib/arc-constants.ts).
 * This module GENERALIZES that: each value is resolved PER CHAIN from env —
 * `NEXT_PUBLIC_X402_NETWORK_<chainId>`, `_USDC_<chainId>`, `_GATEWAY_<chainId>`,
 * `_FACILITATOR_URL_<chainId>` — so x402 can run on any chain a deployment
 * configures. Pointing the seam at a new chain is an ENV change, never a code
 * change (mirrors lib/onramp/config.ts and lib/paymaster/config.ts).
 *
 * ARC STAYS THE DOCUMENTED DEFAULT: for chain {@link ARC_TESTNET_ID} (5042002)
 * the booth-confirmed Arc constants in lib/arc-constants.ts are the fallback when
 * the matching env var is blank — so existing Arc behavior is UNCHANGED. For any
 * OTHER chain there is NO baked-in default (we never invent a Gateway Wallet or a
 * USDC address — law #4 / doctrine guardrail #5); a missing value leaves that
 * chain UNCONFIGURED and {@link resolveX402Config} throws a clear error rather
 * than guessing.
 *
 * NOTE on Next.js inlining: `NEXT_PUBLIC_*` vars are inlined into the client
 * bundle ONLY when the key is a literal string at the call site. The x402 seller
 * spine runs SERVER-SIDE (route handlers), so the computed-key reads below are
 * fine — they resolve at request time on the server. The static literal map for
 * Arc (the one chain we ship a default for) keeps the lead chain working even in
 * a browser-evaluated path.
 */

import {
  ARC_TESTNET_FACILITATOR_URL,
  ARC_TESTNET_GATEWAY_WALLET,
  ARC_TESTNET_NETWORK,
  ARC_TESTNET_USDC,
} from '../arc-constants.js'
import { ARC_TESTNET_ID } from '../chains.js'

/** The four protocol values x402 needs to build a payment requirement on a chain. */
export interface X402ChainConfig {
  /** The chain id these values belong to. */
  readonly chainId: number
  /** CAIP-2 network id, e.g. "eip155:5042002". */
  readonly network: string
  /** Settlement USDC token address (the x402 `asset`). */
  readonly asset: string
  /** Gateway Wallet address — the EIP-712 `verifyingContract` the payer signs against. */
  readonly gatewayWallet: string
  /** Facilitator base URL — verify/settle are POSTed here. */
  readonly facilitatorUrl: string
}

/**
 * The booth-confirmed Arc Testnet defaults (chain 5042002). These are the SAME
 * constants the seller spine used before per-chain config existed, re-exposed
 * here as the documented fallback for the lead chain so Arc behavior is unchanged.
 */
const ARC_DEFAULTS: X402ChainConfig = {
  chainId: ARC_TESTNET_ID,
  network: ARC_TESTNET_NETWORK,
  asset: ARC_TESTNET_USDC,
  gatewayWallet: ARC_TESTNET_GATEWAY_WALLET,
  facilitatorUrl: ARC_TESTNET_FACILITATOR_URL,
}

/**
 * Per-chain DEFAULTS map. Only Arc ships a baked-in default (it is the one chain
 * whose values are booth-confirmed in lib/arc-constants.ts). Every other chain is
 * env-only — undefined here, resolved from `NEXT_PUBLIC_X402_*_<chainId>`, and a
 * blank value leaves it unconfigured rather than guessing (law #4).
 */
const X402_DEFAULTS_BY_CHAIN: Readonly<Partial<Record<number, X402ChainConfig>>> = {
  [ARC_TESTNET_ID]: ARC_DEFAULTS,
}

/** Read a `NEXT_PUBLIC_X402_<suffix>_<chainId>` var, trimmed; '' when blank/unset. */
function readChainEnv(suffix: string, chainId: number): string {
  return (process.env[`NEXT_PUBLIC_X402_${suffix}_${chainId}`] ?? '').trim()
}

/**
 * The CAIP-2 network id for a chain: `NEXT_PUBLIC_X402_NETWORK_<chainId>`, else the
 * chain's documented default (Arc), else the conventional `eip155:<chainId>`. The
 * eip155 fallback is a pure, deterministic derivation of the chain id (NOT an
 * invented address), so it is safe to compute for any chain.
 */
export function x402Network(chainId: number): string {
  const fromEnv = readChainEnv('NETWORK', chainId)
  if (fromEnv.length > 0) return fromEnv
  return X402_DEFAULTS_BY_CHAIN[chainId]?.network ?? `eip155:${chainId}`
}

/**
 * The settlement USDC address for a chain: `NEXT_PUBLIC_X402_USDC_<chainId>`, else
 * the chain's documented default (Arc only). '' when neither is set — an unset
 * USDC is a HARD STOP (we never guess a token address); {@link resolveX402Config}
 * surfaces that as a throw.
 */
export function x402Usdc(chainId: number): string {
  const fromEnv = readChainEnv('USDC', chainId)
  if (fromEnv.length > 0) return fromEnv
  return X402_DEFAULTS_BY_CHAIN[chainId]?.asset ?? ''
}

/**
 * The Gateway Wallet (EIP-712 `verifyingContract`) for a chain:
 * `NEXT_PUBLIC_X402_GATEWAY_<chainId>`, else the chain's documented default (Arc
 * only). '' when neither is set — an unset Gateway Wallet is a HARD STOP (a wrong
 * verifyingContract = a silent settle fail).
 */
export function x402GatewayWallet(chainId: number): string {
  const fromEnv = readChainEnv('GATEWAY', chainId)
  if (fromEnv.length > 0) return fromEnv
  return X402_DEFAULTS_BY_CHAIN[chainId]?.gatewayWallet ?? ''
}

/**
 * The facilitator base URL for a chain: `NEXT_PUBLIC_X402_FACILITATOR_URL_<chainId>`,
 * else the chain's documented default (Arc only). '' when neither is set — an unset
 * facilitator is a HARD STOP (there is nowhere to verify/settle against).
 */
export function x402FacilitatorUrl(chainId: number): string {
  const fromEnv = readChainEnv('FACILITATOR_URL', chainId)
  if (fromEnv.length > 0) return fromEnv
  return X402_DEFAULTS_BY_CHAIN[chainId]?.facilitatorUrl ?? ''
}

/**
 * True when a chain has a complete x402 config — a USDC address, a Gateway Wallet,
 * AND a facilitator URL are all resolvable (from env or the chain's documented
 * default). The network id always resolves (eip155 fallback), so it is not gating.
 *
 * Use this to DECIDE whether to offer x402 on a chain without throwing. The
 * money path itself calls {@link resolveX402Config}, which throws on a gap so a
 * misconfiguration can never produce a silent wrong settle.
 */
export function isX402Configured(chainId: number): boolean {
  return (
    x402Usdc(chainId).length > 0 &&
    x402GatewayWallet(chainId).length > 0 &&
    x402FacilitatorUrl(chainId).length > 0
  )
}

/**
 * Resolve the full {@link X402ChainConfig} for a chain, or THROW a clear error
 * naming the exact missing env var. Doctrine guardrail #5 / law #4: a missing
 * USDC / Gateway / facilitator is a hard stop — we never guess a token address, a
 * verifyingContract, or a facilitator endpoint. Chain 5042002 (Arc) always
 * resolves from the booth-confirmed defaults; any other chain must be configured
 * via `NEXT_PUBLIC_X402_*_<chainId>`.
 *
 * @param chainId - the chain to build the x402 requirement for (default Arc).
 * @throws if USDC, the Gateway Wallet, or the facilitator URL is unresolved.
 */
export function resolveX402Config(chainId: number = ARC_TESTNET_ID): X402ChainConfig {
  const asset = x402Usdc(chainId)
  if (asset.length === 0) {
    throw new Error(
      `x402: no settlement USDC for chain ${chainId} — set NEXT_PUBLIC_X402_USDC_${chainId} (no token address is guessed).`,
    )
  }
  const gatewayWallet = x402GatewayWallet(chainId)
  if (gatewayWallet.length === 0) {
    throw new Error(
      `x402: no Gateway Wallet for chain ${chainId} — set NEXT_PUBLIC_X402_GATEWAY_${chainId} (the EIP-712 verifyingContract; never guessed).`,
    )
  }
  const facilitatorUrl = x402FacilitatorUrl(chainId)
  if (facilitatorUrl.length === 0) {
    throw new Error(
      `x402: no facilitator URL for chain ${chainId} — set NEXT_PUBLIC_X402_FACILITATOR_URL_${chainId} (where verify/settle are POSTed).`,
    )
  }
  return {
    chainId,
    network: x402Network(chainId),
    asset,
    gatewayWallet,
    facilitatorUrl,
  }
}

/**
 * A one-line, honest "configure me" note for logs / a health endpoint. Names the
 * per-chain env vars an installer sets to enable x402 on a NEW chain — and states
 * that Arc (5042002) needs none (it ships booth-confirmed defaults).
 */
export const X402_CONFIGURE_NOTE =
  'x402 chain 5042002 (Arc Testnet) ships booth-confirmed defaults — no env needed. ' +
  'For any OTHER chain set NEXT_PUBLIC_X402_NETWORK_<chainId> (optional; defaults to ' +
  'eip155:<chainId>), NEXT_PUBLIC_X402_USDC_<chainId>, NEXT_PUBLIC_X402_GATEWAY_<chainId> ' +
  '(the EIP-712 verifyingContract), and NEXT_PUBLIC_X402_FACILITATOR_URL_<chainId>. ' +
  'A missing USDC / Gateway / facilitator is a hard stop — never guessed (law #4).'
