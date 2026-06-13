/**
 * @file Optional read-only hook: ERC-6909 lane balance from `Access0x1Lanes`.
 *
 * Given a credited asset + recipient + source-chain selector, derive the lane's ERC-6909 token id
 * (`laneId`, a pure function) and read `balanceOf(owner, id)`. Read-only — this unit issues no
 * writes against the lanes contract (credits are minted by the router/cross-chain receiver, never
 * the SDK; guardrail #1, zero custody).
 */

import { useEffect, useState } from 'react';
import { LANES_ABI } from '../abi.js';
import type { Access0x1Client } from '../client.js';
import { toAccess0x1Error, type Access0x1Error } from '../errors.js';
import { NATIVE_TOKEN, type Hex } from '../types.js';

/** The reactive surface returned by {@link usePaymentLanes}. */
export interface UsePaymentLanesReturn {
  /** The derived ERC-6909 lane token id, or `null` before the first read. */
  laneId: bigint | null;
  /** The recipient's balance in that lane, or `null` before the first read. */
  balance: bigint | null;
  /** `true` while either read is in flight. */
  isLoading: boolean;
  /** A typed error if a read failed. */
  error: Access0x1Error | null;
}

/**
 * Read an ERC-6909 lane balance for `(chainSelector, asset, owner)`.
 *
 * @param lanesAddress  The deployed `Access0x1Lanes` contract.
 * @param owner         The recipient whose lane balance to read.
 * @param asset         The credited asset ({@link NATIVE_TOKEN} for native).
 * @param chainSelector The CCIP-style source chain selector; `0n` = local chain (default).
 * @param client        The viem-backed client (read-only is sufficient).
 * @returns See {@link UsePaymentLanesReturn}.
 */
export function usePaymentLanes(
  lanesAddress: Hex,
  owner: Hex,
  asset: Hex = NATIVE_TOKEN,
  chainSelector: bigint = 0n,
  client?: Access0x1Client,
): UsePaymentLanesReturn {
  const [laneId, setLaneId] = useState<bigint | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Access0x1Error | null>(null);

  useEffect(() => {
    if (client == null) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const run = async (): Promise<void> => {
      const id = await client.readContract<bigint>({
        address: lanesAddress,
        abi: LANES_ABI as unknown as import('viem').Abi,
        functionName: 'laneId',
        args: [chainSelector, asset, owner],
      });
      if (cancelled) return;
      setLaneId(id);

      const bal = await client.readContract<bigint>({
        address: lanesAddress,
        abi: LANES_ABI as unknown as import('viem').Abi,
        functionName: 'balanceOf',
        args: [owner, id],
      });
      if (cancelled) return;
      setBalance(bal);
    };

    run()
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(toAccess0x1Error(e));
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [lanesAddress, owner, asset, chainSelector, client]);

  return { laneId, balance, isLoading, error };
}
