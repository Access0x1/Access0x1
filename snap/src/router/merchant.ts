/**
 * Merchant identity resolution for the insight panel.
 *
 * `fetchMerchantName` reads the router's `merchants(id)` getter via `eth_call`
 * and, if an ENS resolver is wired, resolves a readable label. Every failure
 * path (network error, unregistered merchant, ENS miss) degrades to
 * `"Merchant #<id>"` — this function NEVER throws into `onTransaction`.
 */

import {
  decodeFunctionResult,
  encodeFunctionData,
  isAddressEqual,
} from 'viem/utils';

import { MERCHANTS_ABI, PLATFORM_FEE_ABI } from './abi';
import type { MerchantInfo } from '../types';

/** The zero address — an unregistered merchant slot returns this for `owner`. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Read the router's `platformFeeBps()`. Best-effort: on any failure returns 0 so
 * the panel degrades to showing the merchant surcharge only (never throws into
 * `onTransaction`). The total on-chain fee is `platformFeeBps + merchant.feeBps`.
 */
async function fetchPlatformFeeBps(
  routerAddress: `0x${string}`,
  provider: EthProvider,
): Promise<number> {
  try {
    const data = encodeFunctionData({
      abi: PLATFORM_FEE_ABI,
      functionName: 'platformFeeBps',
    });
    const raw = (await provider.request({
      method: 'eth_call',
      params: [{ to: routerAddress, data }, 'latest'],
    })) as `0x${string}`;
    return Number(
      decodeFunctionResult({
        abi: PLATFORM_FEE_ABI,
        functionName: 'platformFeeBps',
        data: raw,
      }),
    );
  } catch {
    return 0;
  }
}

/**
 * A minimal EIP-1193 request surface — the MetaMask Snap `ethereum` provider,
 * or any object exposing `request({ method, params })`. Injected for testability.
 */
export type EthProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

/**
 * Optional ENS reverse-resolver. If `feat/ens-resolve` is merged, the dapp can
 * supply a resolver that maps a merchant payout/owner address to its ENS label.
 * When absent, the name falls back to `"Merchant #<id>"`.
 */
export type EnsResolver = (
  address: `0x${string}`,
  chainId: number,
) => Promise<string | null>;

/**
 * Build the default `"Merchant #<id>"` fallback name.
 *
 * @param id - The merchant id.
 * @returns The fallback display name.
 */
export function fallbackMerchantName(id: bigint): string {
  return `Merchant #${id.toString()}`;
}

/**
 * Resolve a merchant's display name and on-chain config.
 *
 * Reads `merchants(id)` via `eth_call`, then (optionally) reverse-resolves an
 * ENS label for the payout address. Any error or an unregistered slot yields
 * the `"Merchant #<id>"` fallback so the insight panel always renders.
 *
 * @param id - The merchant id from the decoded call.
 * @param chainId - Numeric EVM chain id (for the ENS resolver).
 * @param routerAddress - The deployed router address (from Snap config; never hardcoded).
 * @param provider - EIP-1193 provider for the `eth_call`.
 * @param ensResolver - Optional ENS reverse resolver.
 * @returns A `MerchantInfo`; on any failure, name is the `"Merchant #<id>"` fallback.
 * @warn Never throws — `onTransaction` relies on this degrading gracefully.
 */
export async function fetchMerchantName(
  id: bigint,
  chainId: number,
  routerAddress: `0x${string}` | null,
  provider: EthProvider,
  ensResolver?: EnsResolver,
): Promise<MerchantInfo> {
  const fallback: MerchantInfo = {
    id,
    name: fallbackMerchantName(id),
    payout: ZERO_ADDRESS,
    feeBps: 0,
    platformFeeBps: 0,
  };

  if (!routerAddress) {
    return fallback;
  }

  // Read the platform fee once, up front — the panel needs platformFeeBps + feeBps
  // to show the true total. Best-effort; a miss just yields 0 (merchant-surcharge only).
  const platformFeeBps = await fetchPlatformFeeBps(routerAddress, provider);

  try {
    const data = encodeFunctionData({
      abi: MERCHANTS_ABI,
      functionName: 'merchants',
      args: [id],
    });

    const raw = (await provider.request({
      method: 'eth_call',
      params: [{ to: routerAddress, data }, 'latest'],
    })) as `0x${string}`;

    const [payout, owner, , feeBps] = decodeFunctionResult({
      abi: MERCHANTS_ABI,
      functionName: 'merchants',
      data: raw,
    });

    // Unregistered slot ⇒ owner is the zero address.
    if (isAddressEqual(owner, ZERO_ADDRESS)) {
      return { ...fallback, platformFeeBps };
    }

    let name = fallbackMerchantName(id);
    if (ensResolver) {
      try {
        const label = await ensResolver(payout, chainId);
        if (label) {
          name = label;
        }
      } catch {
        // ENS miss ⇒ keep the fallback name.
      }
    }

    return { id, name, payout, feeBps: Number(feeBps), platformFeeBps };
  } catch {
    // Network error / decode failure ⇒ never throw into onTransaction.
    return fallback;
  }
}

/**
 * Read a merchant's on-chain `nameHash` (the branding trust anchor, ADR D3).
 *
 * Reads `merchants(id)` via `eth_call` and returns the `bytes32 nameHash` field.
 * The chain stores the HASH, never the readable name — a surface verifies a name
 * by checking `keccak256(name) === nameHash`. Returns `null` on any failure or
 * for an unregistered slot, so the branding resolver degrades gracefully. NEVER
 * throws into `onTransaction`.
 *
 * @param id - The merchant id from the decoded call.
 * @param routerAddress - The deployed router address (from Snap config; never hardcoded).
 * @param provider - EIP-1193 provider for the `eth_call`.
 * @returns The 32-byte `nameHash`, or `null`.
 */
export async function fetchMerchantNameHash(
  id: bigint,
  routerAddress: `0x${string}` | null,
  provider: EthProvider,
): Promise<`0x${string}` | null> {
  if (!routerAddress) {
    return null;
  }
  try {
    const data = encodeFunctionData({
      abi: MERCHANTS_ABI,
      functionName: 'merchants',
      args: [id],
    });
    const raw = (await provider.request({
      method: 'eth_call',
      params: [{ to: routerAddress, data }, 'latest'],
    })) as `0x${string}`;
    const [, owner, , , , nameHash] = decodeFunctionResult({
      abi: MERCHANTS_ABI,
      functionName: 'merchants',
      data: raw,
    });
    if (isAddressEqual(owner, ZERO_ADDRESS)) {
      return null;
    }
    return nameHash;
  } catch {
    return null;
  }
}
