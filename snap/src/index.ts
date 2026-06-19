/**
 * Access0x1 MetaMask Snap — entry point.
 *
 * Exports the two Snap lifecycle handlers:
 *  - `onTransaction`: renders the readable payment insight panel before signing.
 *  - `onRpcRequest`: a small dispatch table for dapp-invoked methods
 *    (`configure`, `setMerchantBranding`, `getRouterConfig`, `getPaymentHistory`,
 *    `getLastPaymentReceipt`).
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
  DEFAULT_BRANDING_API_BASE,
  resolveBranding,
  type FetchLike,
} from './branding/resolve';
import {
  MAX_DESCRIPTION_LEN,
  MAX_NAME_LEN,
  sanitizeBrandColor,
  sanitizeLogoSvg,
  sanitizeText,
} from './branding/sanitize';
import { putBranding } from './branding/store';
import { parseRouterCall } from './router/decode';
import { fetchMerchantName, type EthProvider } from './router/merchant';
import {
  getState,
  recordReceipt,
  setState,
  type SnapProvider,
} from './state';
import { renderBrandedConfirmation } from './ui/brandingPanel';
import { renderInsightPanel } from './ui/insightPanel';
import type { MerchantBranding, SnapConfigState } from './types';

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
 * `onTransaction` — renders the Access0x1 payment insight panel, now with the
 * white-label merchant branding header above it (ADR unit 7).
 *
 * If the transaction is not a router `payNative` / `payToken` call, returns
 * `null` (no panel, no false positive). Both the merchant lookup and the
 * branding resolution degrade gracefully and NEVER throw — branding is
 * display-only (doctrine #1), so a failed resolution simply renders the plain
 * (pre-existing) insight panel; it can never block the signing surface.
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

  const snapProvider = snap as unknown as SnapProvider;
  const state = await getState(snapProvider);
  const routerAddress = state?.routerAddress ?? null;

  const merchant = await fetchMerchantName(
    summary.merchantId,
    numericChainId,
    routerAddress,
    ethereum as unknown as EthRequest,
  );

  // Resolve white-label branding via the D4 ladder (cache → fetch → on-chain
  // nameHash → Merchant #<id>). Wrapped so any unexpected error degrades to the
  // plain panel rather than throwing into onTransaction.
  let branding: MerchantBranding | undefined;
  try {
    branding = await resolveBranding(summary.merchantId, {
      snap: snapProvider,
      provider: ethereum as unknown as EthProvider,
      routerAddress,
      apiBaseUrl: state?.brandingApiBaseUrl ?? DEFAULT_BRANDING_API_BASE,
      fetchImpl: fetch as unknown as FetchLike,
    });
  } catch {
    branding = undefined;
  }

  return { content: renderInsightPanel(summary, merchant, branding) };
};

/**
 * `onRpcRequest` — dapp-invoked method dispatch table.
 *
 * Methods:
 *  - `configure({ routerAddress, chainIds, brandingApiBaseUrl? })` → persists config.
 *  - `getRouterConfig()` → `{ routerAddress, chainIds }`.
 *  - `getPaymentHistory({ limit })` → recent serialized receipts (max 50).
 *  - `getLastPaymentReceipt()` → the most-recent serialized receipt, or `null`.
 *  - `setMerchantBranding({ merchantId, name, description, logoSvg, brandColor, confirm?, amountLabel? })`
 *    → caches sanitized white-label branding (ADR unit 6); optionally shows a
 *    branded pre-sign confirmation dialog. Display-only — never gates a money path.
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
      const prev = await getState(snapProvider);
      const brandingApiBaseUrl =
        typeof params.brandingApiBaseUrl === 'string'
          ? params.brandingApiBaseUrl
          : prev?.brandingApiBaseUrl;
      const next: SnapConfigState = {
        routerAddress,
        chainIds,
        receipts: prev?.receipts ?? [],
        ...(brandingApiBaseUrl ? { brandingApiBaseUrl } : {}),
        ...(prev?.branding ? { branding: prev.branding } : {}),
      };
      await setState(snapProvider, next);
      return { ok: true };
    }

    case 'setMerchantBranding': {
      return (await handleSetMerchantBranding(
        snapProvider,
        params,
      )) as unknown as Json;
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

    case 'getLastPaymentReceipt': {
      const state = await getState(snapProvider);
      // The receipt log is stored most-recent-first (see `recordReceipt`), so
      // the head is the latest payment; `null` when nothing has been recorded.
      const last = state?.receipts?.[0] ?? null;
      return last as unknown as Json;
    }

    default:
      throw new MethodNotFoundError(
        `Method not found: ${request.method}`,
      ) as unknown as Error;
  }
};

/**
 * Parse a merchant id from RPC params into a non-negative `bigint`, or `null` if
 * it is missing / malformed. Accepts a number or a decimal/hex string.
 *
 * @param value - The untrusted `merchantId` param.
 * @returns The parsed id, or `null`.
 */
function parseMerchantId(value: unknown): bigint | null {
  try {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return BigInt(value);
    }
    if (typeof value === 'string' && /^(?:0x[0-9a-f]+|\d+)$/iu.test(value.trim())) {
      const id = BigInt(value.trim());
      return id >= 0n ? id : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Handle the `setMerchantBranding` RPC (ADR unit 6).
 *
 * Validates and sanitizes the merchant-supplied branding (name, description,
 * inline-SVG logo, brand color — see `branding/sanitize.ts`), caches it in
 * `snap_manageState` keyed by `merchantId`, and — when `confirm: true` — shows a
 * branded `snap_dialog` confirmation. Branding is DISPLAY-ONLY (doctrine #1):
 * the returned `accepted` flag is a UX courtesy and is NEVER the enforcement
 * point for a payment — the dApp sends the pay tx independently.
 *
 * @param snapProvider - The Snap runtime provider.
 * @param params - The RPC params.
 * @returns `{ ok, merchantId, cached, accepted }`.
 * @throws {SnapError} when `merchantId` or `name` is missing/unusable (a config
 *   error on the branding call itself — not a money path).
 */
async function handleSetMerchantBranding(
  snapProvider: SnapProvider,
  params: Record<string, unknown>,
): Promise<{
  ok: boolean;
  merchantId: string;
  cached: boolean;
  accepted: boolean | null;
}> {
  const merchantId = parseMerchantId(params.merchantId);
  if (merchantId === null) {
    throw new SnapError('invalid_merchant_id');
  }

  const name = sanitizeText(params.name, MAX_NAME_LEN);
  if (name.length === 0) {
    throw new SnapError('invalid_branding_name');
  }

  const branding: MerchantBranding = {
    merchantId: merchantId.toString(),
    name,
    description: sanitizeText(params.description, MAX_DESCRIPTION_LEN),
    logoSvg: sanitizeLogoSvg(params.logoSvg),
    brandColor: sanitizeBrandColor(params.brandColor),
    // Verification is decided on-chain by the resolver, never asserted by the
    // pushing page (law #4) — cache as unverified.
    verified: false,
    updatedAt: Date.now(),
  };

  await putBranding(snapProvider, branding);

  // Optional branded pre-sign confirmation (ADR D4 path 1). Best-effort: a
  // dialog failure (e.g. wallet locked, permission absent) never fails the
  // cache write and never blocks the downstream payment.
  let accepted: boolean | null = null;
  if (params.confirm === true) {
    const amountLabel =
      typeof params.amountLabel === 'string' && params.amountLabel.length > 0
        ? sanitizeText(params.amountLabel, 32)
        : 'See amount below';
    try {
      const result = await snapProvider.request({
        method: 'snap_dialog',
        params: {
          type: 'confirmation',
          content: renderBrandedConfirmation(branding, amountLabel),
        },
      });
      accepted = result === true;
    } catch {
      accepted = null;
    }
  }

  return { ok: true, merchantId: branding.merchantId, cached: true, accepted };
}

// Re-export the receipt recorder so dapp-side polling can persist a confirmed
// payment (called from a follow-up RPC once the tx lands).
export { recordReceipt };
