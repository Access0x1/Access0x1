/**
 * Branding resolution ladder for `onTransaction` (ADR D4 path 2 / build unit 7).
 *
 * Given a decoded `merchantId`, resolve the readable branding to show in-wallet,
 * degrading gracefully through four tiers — and NEVER throwing into
 * `onTransaction` (the insight panel must always render):
 *
 *   1. branding cached in `snap_manageState` for that merchantId (pushed by the
 *      `setMerchantBranding` RPC — instant, offline);
 *   2. else `fetch()` the public `GET /api/branding/by-merchant/{merchantId}`
 *      endpoint (Snap fetches carry `Origin: null`; the endpoint replies CORS-open);
 *   3. else read `merchants(merchantId).nameHash` on-chain and show the verified
 *      short-hash form;
 *   4. else today's `Merchant #<id>` fallback.
 *
 * Whenever a readable name is available AND the on-chain `nameHash` matches
 * `keccak256(normalizedName)`, the result is badged `verified` (law #4: we only
 * claim "verified on-chain" when the hash actually matches).
 *
 * Branding is display-only — nothing here gates or blocks a money path.
 */

import { keccak256, stringToBytes } from 'viem/utils';

import {
  DEFAULT_BRAND_COLOR,
  MAX_DESCRIPTION_LEN,
  MAX_NAME_LEN,
  sanitizeBrandColor,
  sanitizeLogoSvg,
  sanitizeText,
} from './sanitize';
import { getBranding } from './store';
import { fetchMerchantNameHash, type EthProvider } from '../router/merchant';
import { type SnapProvider } from '../state';
import type { MerchantBranding } from '../types';

/** The default public branding API base (overridable via Snap config). */
export const DEFAULT_BRANDING_API_BASE = 'https://api.access0x1.com';

/** How long a `fetch` for branding may take before we give up and degrade. */
const FETCH_TIMEOUT_MS = 4_000;

/** A minimal `fetch` surface (injected for testability). */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** Dependencies the resolver needs, all injectable so unit tests stay offline. */
export type ResolveDeps = {
  /** Snap state provider (the `snap` global at runtime). */
  snap: SnapProvider;
  /** EIP-1193 provider for the on-chain `nameHash` read (the `ethereum` global). */
  provider: EthProvider;
  /** The deployed router address, or `null` if the Snap is not configured. */
  routerAddress: `0x${string}` | null;
  /** Base URL of the public branding API. */
  apiBaseUrl: string;
  /** The `fetch` implementation (the SES global at runtime). */
  fetchImpl: FetchLike;
};

/**
 * Normalize a display name the same way the hosted app does before hashing, so
 * `keccak256(name)` lines up with the on-chain `nameHash`. Lowercased + single
 * spaced + trimmed (a stable, documented normalization).
 *
 * @param name - The readable display name.
 * @returns The normalized form used for `keccak256`.
 */
export function normalizeNameForHash(name: string): string {
  return name.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * Whether a readable name commits to the given on-chain `nameHash`.
 *
 * @param name - The readable name.
 * @param nameHash - The 32-byte hash read from `merchants(id).nameHash`.
 * @returns `true` if `keccak256(normalize(name)) === nameHash`.
 */
export function nameMatchesHash(
  name: string,
  nameHash: `0x${string}` | null,
): boolean {
  if (!nameHash || /^0x0{64}$/iu.test(nameHash)) {
    return false;
  }
  try {
    const computed = keccak256(stringToBytes(normalizeNameForHash(name)));
    return computed.toLowerCase() === nameHash.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * The short-hash display form for the on-chain-only tier: `nameHash#1234…cdef`.
 *
 * @param nameHash - The 32-byte hash.
 * @returns A compact, truthful label derived from the hash.
 */
export function shortHashLabel(nameHash: `0x${string}`): string {
  return `${nameHash.slice(0, 6)}…${nameHash.slice(-4)}`;
}

/**
 * Coerce an arbitrary JSON value (from the public endpoint, untrusted) into a
 * sanitized `MerchantBranding`, or `null` if it has no usable name.
 *
 * @param merchantId - The merchant id (for the cache key and fallback).
 * @param raw - The untrusted JSON payload.
 * @returns Sanitized branding, or `null`.
 */
function coerceBranding(
  merchantId: bigint,
  raw: unknown,
): MerchantBranding | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const name = sanitizeText(obj.name, MAX_NAME_LEN);
  if (name.length === 0) {
    return null;
  }
  return {
    merchantId: merchantId.toString(),
    name,
    description: sanitizeText(obj.description, MAX_DESCRIPTION_LEN),
    logoSvg: sanitizeLogoSvg(obj.logoSvg),
    brandColor: sanitizeBrandColor(obj.brandColor),
    verified: false,
    updatedAt: Date.now(),
  };
}

/**
 * Fetch branding from the public endpoint, sanitized. Times out and degrades to
 * `null` on any error (never throws).
 *
 * @param merchantId - The merchant id.
 * @param deps - The resolver dependencies.
 * @returns Sanitized branding from the endpoint, or `null`.
 */
async function fetchBranding(
  merchantId: bigint,
  deps: ResolveDeps,
): Promise<MerchantBranding | null> {
  const base = deps.apiBaseUrl.replace(/\/+$/u, '');
  const url = `${base}/api/branding/by-merchant/${merchantId.toString()}`;
  const controller =
    typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    : null;
  try {
    const res = await deps.fetchImpl(url, {
      headers: { accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res.ok) {
      return null;
    }
    return coerceBranding(merchantId, await res.json());
  } catch {
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * The pure `Merchant #<id>` fallback branding (tier 4) — always renderable.
 *
 * @param merchantId - The merchant id.
 * @returns A neutral, never-verified branding record.
 */
export function fallbackBranding(merchantId: bigint): MerchantBranding {
  return {
    merchantId: merchantId.toString(),
    name: `Merchant #${merchantId.toString()}`,
    description: '',
    logoSvg: null,
    brandColor: DEFAULT_BRAND_COLOR,
    verified: false,
    updatedAt: Date.now(),
  };
}

/**
 * Resolve the branding to display for a merchant, walking the D4 ladder.
 *
 * Always returns a renderable `MerchantBranding`; never throws. Whenever a
 * readable name is present and the router is configured, the on-chain `nameHash`
 * is read to (a) set the `verified` badge when it matches, and (b) supply the
 * tier-3 short-hash label when no readable name was found anywhere.
 *
 * @param merchantId - The decoded merchant id.
 * @param deps - The injected dependencies (snap state, provider, fetch, config).
 * @returns The branding to render.
 */
export async function resolveBranding(
  merchantId: bigint,
  deps: ResolveDeps,
): Promise<MerchantBranding> {
  // Tier 1 — cache.
  const cached = await getBranding(deps.snap, merchantId);

  // Tier 2 — public endpoint (only if not cached, to keep the panel instant).
  const resolved = cached ?? (await fetchBranding(merchantId, deps));

  // Read the on-chain nameHash once for verification / the tier-3 label.
  let nameHash: `0x${string}` | null = null;
  if (deps.routerAddress) {
    nameHash = await fetchMerchantNameHash(
      merchantId,
      deps.routerAddress,
      deps.provider,
    );
  }

  if (resolved) {
    return {
      ...resolved,
      verified: nameMatchesHash(resolved.name, nameHash),
    };
  }

  // Tier 3 — on-chain nameHash short form (verified by construction).
  if (nameHash && !/^0x0{64}$/iu.test(nameHash)) {
    return {
      merchantId: merchantId.toString(),
      name: `Merchant #${merchantId.toString()}`,
      description: `On-chain id ${shortHashLabel(nameHash)}`,
      logoSvg: null,
      brandColor: DEFAULT_BRAND_COLOR,
      verified: true,
      updatedAt: Date.now(),
    };
  }

  // Tier 4 — Merchant #<id> fallback.
  return fallbackBranding(merchantId);
}
