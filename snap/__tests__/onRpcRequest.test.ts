import { MethodNotFoundError } from '@metamask/snaps-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { onRpcRequest } from '../src/index';
import type { SerializedPaymentSummary, SnapConfigState } from '../src/types';

/**
 * Tests for the `onRpcRequest` dispatch table (`src/index.ts`).
 *
 * Covers the two doc-vs-reality fixes:
 *  - O-13: `getLastPaymentReceipt` is implemented and returns the most-recent
 *    tracked receipt (or `null`), matching its JSDoc.
 *  - O-14: the removed `initiatePrivatePayout` method is no longer dispatched —
 *    an unknown method now yields `MethodNotFoundError`, so docs + manifest +
 *    code agree (the `snap_getBip44Entropy` permission was dropped with it).
 *
 * The Snap `snap` global is not present under Node, so each test installs a
 * minimal `snap_manageState` mock on `globalThis` before invoking the handler.
 */

/** A JSON-safe receipt fixture (`bigint` fields already stringified). */
function receipt(orderIdLabel: string): SerializedPaymentSummary {
  return {
    merchantId: '7',
    usdAmount8: '2900000000',
    token: null,
    tokenAmount: '0',
    orderId: '0x6f72646572',
    orderIdLabel,
    chainId: 5042002,
    chainLabel: 'Arc Testnet',
  };
}

/** Install a `snap` global whose `snap_manageState get` returns `state`. */
function installSnap(state: SnapConfigState | null): void {
  (globalThis as unknown as { snap: unknown }).snap = {
    request: vi.fn(async ({ method }: { method: string }) =>
      method === 'snap_manageState' ? state : null,
    ),
  };
}

const ORIGINAL_SNAP = (globalThis as unknown as { snap?: unknown }).snap;

beforeEach(() => {
  installSnap(null);
});

afterEach(() => {
  (globalThis as unknown as { snap?: unknown }).snap = ORIGINAL_SNAP;
  vi.restoreAllMocks();
});

/** Invoke `onRpcRequest` with a bare `{ method }` request. */
async function invoke(method: string): Promise<unknown> {
  return onRpcRequest({
    origin: 'https://dapp.example',
    request: { jsonrpc: '2.0', id: 1, method, params: {} },
  } as Parameters<typeof onRpcRequest>[0]);
}

describe('onRpcRequest — getLastPaymentReceipt (O-13)', () => {
  it('returns the most-recent receipt (head of the most-recent-first log)', async () => {
    const latest = receipt('order-latest');
    installSnap({
      routerAddress: '0x9999999999999999999999999999999999999999',
      chainIds: [5042002],
      receipts: [latest, receipt('order-older')],
    });

    const result = await invoke('getLastPaymentReceipt');
    expect(result).toEqual(latest);
  });

  it('returns null when no payment has been recorded', async () => {
    installSnap({
      routerAddress: '0x9999999999999999999999999999999999999999',
      chainIds: [5042002],
      receipts: [],
    });

    expect(await invoke('getLastPaymentReceipt')).toBeNull();
  });

  it('returns null when the Snap is unconfigured (no state at all)', async () => {
    installSnap(null);
    expect(await invoke('getLastPaymentReceipt')).toBeNull();
  });
});

describe('onRpcRequest — dropped methods (O-14)', () => {
  it('rejects the removed initiatePrivatePayout method with MethodNotFoundError', async () => {
    await expect(invoke('initiatePrivatePayout')).rejects.toBeInstanceOf(
      MethodNotFoundError,
    );
  });

  it('rejects any other unknown method with MethodNotFoundError', async () => {
    await expect(invoke('definitelyNotAMethod')).rejects.toBeInstanceOf(
      MethodNotFoundError,
    );
  });
});
