/**
 * Snap persisted state (router config + receipt log) via `snap_manageState`.
 *
 * MetaMask encrypts this state at rest. The router address lives here — set by
 * the dapp's `configure` call — so a redeploy is a config change, not a code
 * change (doctrine guardrail #7: no address from memory).
 */

import type {
  PaymentSummary,
  SerializedPaymentSummary,
  SnapConfigState,
} from './types';

/** Hard cap on the persisted receipt log to bound encrypted-state size. */
const MAX_RECEIPTS = 50;

/**
 * The Snap runtime `snap` global, narrowed to the methods this module uses.
 * Declared locally so unit tests can inject a mock without the full sandbox.
 */
export type SnapProvider = {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
};

/**
 * Read the persisted Snap state.
 *
 * @param snap - The Snap runtime provider.
 * @returns The stored config, or `null` if the Snap is not yet configured.
 */
export async function getState(
  snap: SnapProvider,
): Promise<SnapConfigState | null> {
  const state = (await snap.request({
    method: 'snap_manageState',
    params: { operation: 'get' },
  })) as SnapConfigState | null;
  return state ?? null;
}

/**
 * Persist the Snap state.
 *
 * @param snap - The Snap runtime provider.
 * @param state - The full config state to store.
 */
export async function setState(
  snap: SnapProvider,
  state: SnapConfigState,
): Promise<void> {
  await snap.request({
    method: 'snap_manageState',
    params: { operation: 'update', newState: state },
  });
}

/**
 * Serialize a `PaymentSummary` (stringify its `bigint` fields) for JSON storage
 * and the `wallet_invokeSnap` return boundary.
 *
 * @param summary - The in-memory summary.
 * @returns A JSON-safe summary.
 */
export function serializeSummary(
  summary: PaymentSummary,
): SerializedPaymentSummary {
  return {
    ...summary,
    merchantId: summary.merchantId.toString(),
    usdAmount8: summary.usdAmount8.toString(),
    tokenAmount: summary.tokenAmount.toString(),
  };
}

/**
 * Append a receipt to the persisted log (most-recent-first), capped at
 * {@link MAX_RECEIPTS}. Requires the Snap to already be configured.
 *
 * @param snap - The Snap runtime provider.
 * @param summary - The payment summary to record.
 */
export async function recordReceipt(
  snap: SnapProvider,
  summary: PaymentSummary,
): Promise<void> {
  const state = await getState(snap);
  if (!state) {
    return;
  }
  const receipts = [serializeSummary(summary), ...(state.receipts ?? [])].slice(
    0,
    MAX_RECEIPTS,
  );
  await setState(snap, { ...state, receipts });
}
