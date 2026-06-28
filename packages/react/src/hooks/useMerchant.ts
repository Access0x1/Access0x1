/**
 * @file Read-only hook: fetch the on-chain `Merchant` record for a merchant id.
 *
 * Calls the router's public `merchants(id)` auto-getter, which returns the struct as a tuple, and
 * maps it to a {@link MerchantInfo}. An unregistered id resolves to an all-zero struct; the hook
 * surfaces that faithfully (owner === zero address) without throwing, so the UI can show a clean
 * "merchant not found" state (guardrail #8) rather than a broken view.
 */

import { useEffect, useState } from 'react';
import { ROUTER_ABI } from '../abi.js';
import type { Access0x1Client } from '../client.js';
import { toAccess0x1Error, type Access0x1Error } from '../errors.js';
import { NATIVE_TOKEN as ZERO_ADDRESS, type Hex, type MerchantInfo } from '../types.js';

/** The reactive surface returned by {@link useMerchant}. */
export interface UseMerchantReturn {
  /** The mapped merchant record, or `null` while loading / before the first read. */
  merchant: MerchantInfo | null;
  /** `true` while the read is in flight. */
  isLoading: boolean;
  /** A typed error if the read failed (network / decode), not for an unregistered id. */
  error: Access0x1Error | null;
}

/** The router's `merchants(id)` tuple shape. */
type MerchantTuple = readonly [Hex, Hex, Hex, number, boolean, Hex];

/**
 * Map a raw `merchants(id)` tuple to {@link MerchantInfo}.
 *
 * @internal Exported for unit testing.
 */
export function mapMerchantTuple(id: bigint, t: MerchantTuple): MerchantInfo {
  return {
    id,
    payout: t[0],
    owner: t[1],
    feeRecipient: t[2],
    feeBps: Number(t[3]),
    active: t[4],
    nameHash: t[5],
  };
}

/** `true` if the merchant record is the all-zero (unregistered) sentinel. */
export function isUnregistered(m: MerchantInfo): boolean {
  return m.owner === ZERO_ADDRESS;
}

/**
 * Fetch and return the on-chain `Merchant` struct for `merchantId`.
 *
 * @param routerAddress The deployed `Access0x1Router` (required — never hardcoded).
 * @param merchantId    The merchant id to read.
 * @param client        The viem-backed client (read-only is sufficient).
 * @returns See {@link UseMerchantReturn}.
 */
export function useMerchant(
  routerAddress: Hex,
  merchantId: bigint,
  client?: Access0x1Client,
): UseMerchantReturn {
  const [merchant, setMerchant] = useState<MerchantInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Access0x1Error | null>(null);

  useEffect(() => {
    if (client == null) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    client
      .readContract<MerchantTuple>({
        address: routerAddress,
        abi: ROUTER_ABI as import('viem').Abi,
        functionName: 'merchants',
        args: [merchantId],
      })
      .then((tuple) => {
        if (cancelled) return;
        setMerchant(mapMerchantTuple(merchantId, tuple));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(toAccess0x1Error(e));
        setMerchant(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [routerAddress, merchantId, client]);

  return { merchant, isLoading, error };
}
