/**
 * Access0x1 MetaMask Snap — entry point.
 *
 * Exports the two Snap lifecycle handlers:
 *  - `onTransaction`: renders the readable payment insight panel before signing.
 *  - `onRpcRequest`: a small dispatch table for dapp-invoked methods
 *    (`configure`, `getRouterConfig`, `getPaymentHistory`, `getLastPaymentReceipt`,
 *    and the WILL-TRY `initiatePrivatePayout`).
 *
 * The Snap holds NO keys and NO funds (doctrine #1). The router address is never
 * hardcoded — it is set by the dapp's `configure` call and persisted in encrypted
 * Snap state (doctrine #7).
 */

import {
  MethodNotFoundError,
  SnapError,
  type Json,
  type OnRpcRequestHandler,
  type OnTransactionHandler,
} from '@metamask/snaps-sdk';
import '@metamask/snaps-sdk/jsx';

import {
  initiatePrivatePayout,
  type InitiatePrivatePayoutParams,
} from './payout/privatePayout';
import { parseRouterCall } from './router/decode';
import { fetchMerchantName } from './router/merchant';
import {
  getState,
  recordReceipt,
  setState,
  type SnapProvider,
} from './state';
import { renderInsightPanel } from './ui/insightPanel';
import type { SnapConfigState } from './types';

/** The minimal EIP-1193 surface this entry uses for `eth_call`. */
type EthRequest = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

/**
 * Parse a CAIP-2 chain id (`"eip155:5042002"`) into a numeric EVM chain id.
 *
 * @param caip2 - The CAIP-2 chain id string from `onTransaction`.
 * @returns The numeric chain id, or `0` if it cannot be parsed.
 */
function caip2ToNumericChainId(caip2: string): number {
  const parts = caip2.split(':');
  const id = Number.parseInt(parts[1] ?? '', 10);
  return Number.isFinite(id) ? id : 0;
}

/**
 * `onTransaction` — renders the Access0x1 payment insight panel.
 *
 * If the transaction is not a router `payNative` / `payToken` call, returns
 * `null` (no panel, no false positive). Merchant lookup degrades gracefully.
 *
 * @param args - The MetaMask `onTransaction` payload.
 * @param args.transaction - The pending transaction (only `data` is decoded).
 * @param args.chainId - The CAIP-2 chain id.
 * @returns `{ content }` with the insight panel, or `null`.
 */
export const onTransaction: OnTransactionHandler = async ({
  transaction,
  chainId,
}) => {
  const numericChainId = caip2ToNumericChainId(chainId);
  const summary = parseRouterCall(
    { data: transaction.data, value: transaction.value },
    numericChainId,
  );
  if (!summary) {
    return null;
  }

  const state = await getState(snap as unknown as SnapProvider);
  const routerAddress = state?.routerAddress ?? null;

  const merchant = await fetchMerchantName(
    summary.merchantId,
    numericChainId,
    routerAddress,
    ethereum as unknown as EthRequest,
  );

  return { content: renderInsightPanel(summary, merchant) };
};

/**
 * `onRpcRequest` — dapp-invoked method dispatch table.
 *
 * Methods:
 *  - `configure({ routerAddress, chainIds })` → persists router config.
 *  - `getRouterConfig()` → `{ routerAddress, chainIds }`.
 *  - `getPaymentHistory({ limit })` → recent serialized receipts (max 50).
 *  - `getLastPaymentReceipt({ txHash })` → decoded `PaymentReceived`, or `null`.
 *  - `initiatePrivatePayout(...)` [WILL-TRY] → `PayoutResult`.
 *
 * @param args - The RPC payload.
 * @param args.request - The JSON-RPC request (`method` + `params`).
 * @returns The method's JSON result.
 * @throws {MethodNotFoundError} for an unknown method.
 */
export const onRpcRequest: OnRpcRequestHandler = async ({ request }) => {
  const snapProvider = snap as unknown as SnapProvider;
  const params = (request.params ?? {}) as Record<string, unknown>;

  switch (request.method) {
    case 'configure': {
      const routerAddress = params.routerAddress as `0x${string}`;
      const chainIds = (params.chainIds as number[] | undefined) ?? [];
      const next: SnapConfigState = {
        routerAddress,
        chainIds,
        receipts: (await getState(snapProvider))?.receipts ?? [],
      };
      await setState(snapProvider, next);
      return { ok: true };
    }

    case 'getRouterConfig': {
      const state = await getState(snapProvider);
      return {
        routerAddress: state?.routerAddress ?? null,
        chainIds: state?.chainIds ?? [],
      };
    }

    case 'getPaymentHistory': {
      const limitRaw = Number(params.limit ?? 10);
      const limit = Math.max(1, Math.min(50, limitRaw));
      const state = await getState(snapProvider);
      return (state?.receipts ?? []).slice(0, limit) as unknown as Json;
    }

    case 'initiatePrivatePayout': {
      const state = await getState(snapProvider);
      if (!state?.routerAddress) {
        throw new SnapError('not_configured');
      }
      const payoutParams = params as unknown as InitiatePrivatePayoutParams;
      const chainId = state.chainIds[0] ?? 5042002;
      const result = await initiatePrivatePayout(payoutParams, {
        apiBaseUrl: (params.apiBaseUrl as string) ?? '',
        chainId,
        deriveAddress: deriveDailyAddress,
        fetchImpl: fetch,
      });
      return { ...result } as unknown as Json;
    }

    default:
      throw new MethodNotFoundError(
        `Method not found: ${request.method}`,
      ) as unknown as Error;
  }
};

/**
 * Derive the fresh daily destination EOA address from MetaMask's own BIP-44
 * entropy (path `m/44'/60'/0'/0/<index>`). The seed never leaves the wallet;
 * the Snap only ever sees the derived public address (zero custody).
 *
 * @param index - The daily address index.
 * @returns The derived address.
 * @warn BOOTH-CONFIRM — wire `snap_getBip44Entropy` + `@metamask/key-tree`'s
 *   `getBIP44AddressKeyDeriver` here; until then this throws so the payout
 *   surface fails closed rather than using a placeholder address.
 */
async function deriveDailyAddress(index: number): Promise<`0x${string}`> {
  throw new SnapError(
    `bip44_deriver_unconfigured (index ${index}) — wire snap_getBip44Entropy at booth`,
  );
}

// Re-export the receipt recorder so dapp-side polling can persist a confirmed
// payment (called from a follow-up RPC once the tx lands).
export { recordReceipt };
