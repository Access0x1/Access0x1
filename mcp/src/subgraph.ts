/**
 * subgraph.ts — read-only reads of the rail's payment-history subgraph, OFF the
 * money path. Mirrors the house idiom (env-gated, fail-soft, `_meta` surfaced):
 *
 *  - Dormant when no endpoint is configured — the CALLER checks that and never
 *    reaches these functions with a dormant URL.
 *  - Fail-soft once configured: any HTTP / GraphQL / shape problem resolves to a
 *    `failed` outcome with a reason, never a throw into the tool layer.
 *  - Every successful read surfaces `_meta.block.number` (as `asOfBlock`) and
 *    `hasIndexingErrors`, so an agent can label data "as of block N" and degrade
 *    conservatively when the index is behind or erroring.
 *
 * The schema entities read here — `Merchant` (merchantId, owner, paymentCount,
 * totalUsd8, lastPaymentAt), `Payment`, and the `_meta` block — match the rail's
 * published subgraph. Amounts arrive as decimal strings and are carried as
 * bigints internally; the tool layer serializes them back to strings for JSON.
 */

import type { HttpFetch } from './http.js';

/** The indexer's own health signals, attached to every successful read. */
export interface IndexMeta {
  /** The indexer's synced block height at query time, or `null` when `_meta` was absent. */
  readonly asOfBlock: bigint | null;
  /** True when the subgraph reports indexing errors — a degraded index. */
  readonly hasIndexingErrors: boolean;
}

/** A merchant aggregate row. */
export interface MerchantAggregate {
  readonly merchantId: bigint;
  /** Current owner, or `null` until the registration event is indexed. */
  readonly owner: string | null;
  /** Payout recipient, or `null` when not indexed. */
  readonly payout: string | null;
  /** Merchant fee in basis points, or `null` when not indexed. */
  readonly feeBps: number | null;
  /** Whether the merchant is active, or `null` when not indexed. */
  readonly active: boolean | null;
  readonly paymentCount: bigint;
  /** Cumulative USD volume, 8 decimals — the unit-safe cross-token total. */
  readonly totalUsd8: bigint;
  /** Block timestamp (seconds) of the most recent indexed payment; `0` when none. */
  readonly lastPaymentAt: bigint;
}

/** A single settled payment row. */
export interface PaymentRow {
  readonly txHash: string;
  readonly buyer: string;
  /** Settlement token (the zero address means native). */
  readonly token: string;
  readonly grossAmount: bigint;
  readonly feeAmount: bigint;
  readonly netAmount: bigint;
  /** USD amount, 8 decimals (the quoted price). */
  readonly usdAmount8: bigint;
  readonly blockNumber: bigint;
  readonly blockTimestamp: bigint;
}

/** A discriminated read outcome: either data + meta, or a reason for failure. */
export type ReadOutcome<T> =
  | { readonly status: 'ok'; readonly data: T; readonly meta: IndexMeta }
  | { readonly status: 'failed'; readonly reason: string };

interface GraphqlEnvelope {
  data?: Record<string, unknown>;
  errors?: unknown;
}

interface MetaShape {
  block?: { number?: number } | null;
  hasIndexingErrors?: boolean;
}

/**
 * POST a GraphQL query and return the parsed `{ data }` envelope, or `null` on
 * ANY problem (non-2xx, GraphQL `errors`, unparseable body, thrown fetch). This
 * is the single fail-soft boundary; typed readers build on it.
 *
 * @param url The subgraph endpoint.
 * @param query The GraphQL query text.
 * @param variables The query variables.
 * @param fetchImpl The injectable fetch.
 * @returns The `data` object, or `null` on any failure.
 */
async function runGraphql(
  url: string,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: HttpFetch,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      return null;
    }
    const json = JSON.parse(await res.text()) as GraphqlEnvelope;
    if (json.errors != null || json.data == null) {
      return null;
    }
    return json.data;
  } catch {
    return null;
  }
}

/**
 * Extract `{ asOfBlock, hasIndexingErrors }` from a `_meta` value.
 *
 * @param meta The raw `_meta` object (may be absent).
 * @returns The parsed index meta.
 */
function parseMeta(meta: unknown): IndexMeta {
  const m = (meta ?? null) as MetaShape | null;
  const blockNumber = m?.block?.number;
  return {
    asOfBlock: typeof blockNumber === 'number' ? BigInt(blockNumber) : null,
    hasIndexingErrors: m?.hasIndexingErrors === true,
  };
}

/** Fields selected for a full merchant aggregate. */
const MERCHANT_FIELDS = `merchantId owner payout feeBps active paymentCount totalUsd8 lastPaymentAt`;

/**
 * Map a raw merchant row to {@link MerchantAggregate}. A malformed numeric field
 * makes `BigInt()` throw, which the caller turns into a `failed` outcome.
 *
 * @param row The raw merchant object.
 * @returns The typed aggregate.
 */
function mapMerchant(row: Record<string, unknown>): MerchantAggregate {
  return {
    merchantId: BigInt(String(row.merchantId)),
    owner: typeof row.owner === 'string' ? row.owner : null,
    payout: typeof row.payout === 'string' ? row.payout : null,
    feeBps: typeof row.feeBps === 'number' ? row.feeBps : null,
    active: typeof row.active === 'boolean' ? row.active : null,
    paymentCount: BigInt(String(row.paymentCount)),
    totalUsd8: BigInt(String(row.totalUsd8)),
    lastPaymentAt: BigInt(String(row.lastPaymentAt)),
  };
}

/** How to select a merchant: by router id, or by current owner address. */
export type MerchantSelector =
  | { readonly by: 'merchantId'; readonly merchantId: bigint }
  | { readonly by: 'owner'; readonly owner: string };

/**
 * Look up a single merchant aggregate by id or owner. A successful read whose
 * merchant is absent returns `data.merchant === null` (not indexed) with meta.
 *
 * @param url The subgraph endpoint (caller has already checked it is configured).
 * @param selector The lookup key.
 * @param fetchImpl The injectable fetch.
 * @returns The outcome carrying `{ merchant }` or a failure reason.
 */
export async function readMerchant(
  url: string,
  selector: MerchantSelector,
  fetchImpl: HttpFetch,
): Promise<ReadOutcome<{ merchant: MerchantAggregate | null }>> {
  const where =
    selector.by === 'merchantId'
      ? `where: { merchantId: $key }`
      : `where: { owner: $key }`;
  const varType = selector.by === 'merchantId' ? 'BigInt!' : 'Bytes!';
  const key = selector.by === 'merchantId' ? selector.merchantId.toString() : selector.owner.toLowerCase();

  const query = `query MerchantLookup($key: ${varType}) {
    merchants(first: 1, ${where}) { ${MERCHANT_FIELDS} }
    _meta { block { number } hasIndexingErrors }
  }`;

  const data = await runGraphql(url, query, { key }, fetchImpl);
  if (data === null) {
    return { status: 'failed', reason: 'subgraph read failed (network, HTTP, GraphQL, or shape error)' };
  }
  try {
    const rows = data.merchants;
    if (!Array.isArray(rows)) {
      return { status: 'failed', reason: 'subgraph response missing merchants array' };
    }
    const first = rows[0] as Record<string, unknown> | undefined;
    const merchant = first ? mapMerchant(first) : null;
    return { status: 'ok', data: { merchant }, meta: parseMeta(data._meta) };
  } catch (err) {
    return { status: 'failed', reason: `malformed merchant row: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Read a merchant's most-recent payments, newest first.
 *
 * @param url The subgraph endpoint.
 * @param merchantId The router merchant id.
 * @param limit Row cap (already clamped by the caller).
 * @param fetchImpl The injectable fetch.
 * @returns The outcome carrying `{ payments }` or a failure reason.
 */
export async function readMerchantPayments(
  url: string,
  merchantId: bigint,
  limit: number,
  fetchImpl: HttpFetch,
): Promise<ReadOutcome<{ payments: PaymentRow[] }>> {
  const query = `query MerchantPayments($mid: BigInt!, $first: Int!) {
    payments(first: $first, orderBy: blockNumber, orderDirection: desc, where: { merchantId: $mid }) {
      transactionHash buyer token grossAmount feeAmount netAmount usdAmount8 blockNumber blockTimestamp
    }
    _meta { block { number } hasIndexingErrors }
  }`;

  const data = await runGraphql(url, query, { mid: merchantId.toString(), first: limit }, fetchImpl);
  if (data === null) {
    return { status: 'failed', reason: 'subgraph read failed (network, HTTP, GraphQL, or shape error)' };
  }
  try {
    const rows = data.payments;
    if (!Array.isArray(rows)) {
      return { status: 'failed', reason: 'subgraph response missing payments array' };
    }
    const payments: PaymentRow[] = rows.map((r) => {
      const p = r as Record<string, unknown>;
      return {
        txHash: String(p.transactionHash),
        buyer: String(p.buyer),
        token: String(p.token),
        grossAmount: BigInt(String(p.grossAmount)),
        feeAmount: BigInt(String(p.feeAmount)),
        netAmount: BigInt(String(p.netAmount)),
        usdAmount8: BigInt(String(p.usdAmount8)),
        blockNumber: BigInt(String(p.blockNumber)),
        blockTimestamp: BigInt(String(p.blockTimestamp)),
      };
    });
    return { status: 'ok', data: { payments }, meta: parseMeta(data._meta) };
  } catch (err) {
    return { status: 'failed', reason: `malformed payment row: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Read the top merchants by indexed USD volume across the whole rail. This is a
 * cross-entity ranking a per-contract on-chain scan structurally cannot do — the
 * value a shared index adds.
 *
 * @param url The subgraph endpoint.
 * @param limit Row cap (already clamped by the caller).
 * @param fetchImpl The injectable fetch.
 * @returns The outcome carrying `{ merchants }` or a failure reason.
 */
export async function readLeaderboard(
  url: string,
  limit: number,
  fetchImpl: HttpFetch,
): Promise<ReadOutcome<{ merchants: MerchantAggregate[] }>> {
  const query = `query NetworkLeaderboard($first: Int!) {
    merchants(first: $first, orderBy: totalUsd8, orderDirection: desc, where: { paymentCount_gt: "0" }) {
      ${MERCHANT_FIELDS}
    }
    _meta { block { number } hasIndexingErrors }
  }`;

  const data = await runGraphql(url, query, { first: limit }, fetchImpl);
  if (data === null) {
    return { status: 'failed', reason: 'subgraph read failed (network, HTTP, GraphQL, or shape error)' };
  }
  try {
    const rows = data.merchants;
    if (!Array.isArray(rows)) {
      return { status: 'failed', reason: 'subgraph response missing merchants array' };
    }
    const merchants = rows.map((r) => mapMerchant(r as Record<string, unknown>));
    return { status: 'ok', data: { merchants }, meta: parseMeta(data._meta) };
  } catch (err) {
    return { status: 'failed', reason: `malformed merchant row: ${err instanceof Error ? err.message : String(err)}` };
  }
}
