/**
 * Per-merchant branding cache, persisted in `snap_manageState` (ADR D4 path 1).
 *
 * The hosted page/embed calls `setMerchantBranding` just before sending the pay
 * tx; we stash the sanitized branding here keyed by `merchantId` so the very next
 * `onTransaction` can render it instantly and offline. Per ADR D5 this cache is
 * an OPTIMIZATION only — `snap_manageState` is per-device, so the fetch and
 * on-chain paths always backfill a fresh device. Branding is display-only and
 * never touches a money path (doctrine #1).
 */

import { getState, setState, type SnapProvider } from '../state';
import type { MerchantBranding } from '../types';

/** Hard cap on cached merchant-branding entries, to bound encrypted-state size. */
export const MAX_BRANDING_ENTRIES = 50;

/**
 * Read cached branding for a merchant id, or `null` if none is cached.
 *
 * Never throws — a missing/empty state degrades to `null` so `onTransaction`
 * can fall through to the next resolution tier.
 *
 * @param snap - The Snap runtime provider.
 * @param merchantId - The merchant id (bigint).
 * @returns The cached {@link MerchantBranding}, or `null`.
 */
export async function getBranding(
  snap: SnapProvider,
  merchantId: bigint,
): Promise<MerchantBranding | null> {
  try {
    const state = await getState(snap);
    return state?.branding?.[merchantId.toString()] ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist sanitized branding for a merchant id, capping the total number of
 * cached entries (most-recently-written kept). Requires the Snap to already be
 * configured; if it is not, this is a no-op (the `onTransaction` resolver will
 * simply re-fetch next time).
 *
 * @param snap - The Snap runtime provider.
 * @param branding - The already-sanitized branding to cache.
 */
export async function putBranding(
  snap: SnapProvider,
  branding: MerchantBranding,
): Promise<void> {
  const state = await getState(snap);
  if (!state) {
    // Not configured yet — nothing to attach the cache to. The fetch / on-chain
    // paths will resolve branding live, so this is a safe no-op (never throws).
    return;
  }

  const existing = state.branding ?? {};
  const next: Record<string, MerchantBranding> = {
    ...existing,
    [branding.merchantId]: branding,
  };

  // Evict the oldest entries if we exceed the cap (by `updatedAt`, ascending).
  const keys = Object.keys(next);
  if (keys.length > MAX_BRANDING_ENTRIES) {
    const sorted = keys.sort(
      (a, b) => next[a].updatedAt - next[b].updatedAt,
    );
    for (const stale of sorted.slice(0, keys.length - MAX_BRANDING_ENTRIES)) {
      delete next[stale];
    }
  }

  await setState(snap, { ...state, branding: next });
}
