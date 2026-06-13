/**
 * walrus.ts — publish & read blobs on Walrus (Sui decentralized storage).
 *
 * THE SEAM (SEAMS.md "Sui / Walrus = the hosting seam"): the checkout page +
 * brand assets + receipt blobs live on decentralized storage, so the checkout
 * and receipts CANNOT be taken down — no Vercel, no renewal-rot. This is the
 * storage half of the "Unstoppable Checkout" composite (Walrus + on-chain SVG
 * + Router, FEATURES.md). On-chain SVG brand + Router receipts are separate
 * units; this file owns ONLY the Walrus publish/read seam.
 *
 * Walrus exposes a stateless HTTP interface through two daemons:
 *
 *   - a PUBLISHER  — `PUT /v1/blobs`  → stores a blob, returns its blob id;
 *   - an AGGREGATOR — `GET /v1/blobs/{blobId}` → reads a blob back by id.
 *
 * The blob id is a content-addressed identifier (derived from the blob's
 * erasure-coded contents + the Sui object). Given the id, ANY aggregator on the
 * network can serve the bytes — that is what makes the page un-takedownable: it
 * is not hosted at one origin, it is addressable from the whole network.
 *
 * HONEST SCOPE (law #4):
 *   - These are TESTNET endpoints (Walrus testnet publisher/aggregator). Testnet
 *     blobs are best-effort and may be garbage-collected; mainnet uses paid
 *     storage epochs (`epochs` / WAL) — see `WALRUS_MAINNET_*` below.
 *   - This module does the HTTP seam only. It does NOT sign Sui transactions,
 *     pay WAL, or manage storage epochs — a public testnet publisher does that
 *     server-side. For production you run your own publisher or use `@mysten/walrus`
 *     with a funded Sui keypair (noted at the call site, not hardcoded here).
 *   - No "booth-confirm" endpoint is invented: the testnet URLs below are the
 *     documented public defaults and are overridable via the constructor so the
 *     publish script / booth can repoint them without a code change.
 *
 * Zero runtime dependencies: uses the global `fetch` (Node 18+ / the browser).
 * The encode/url helpers are pure and synchronous so they unit-test offline.
 */

/** Default Walrus TESTNET publisher base URL (public, documented default). */
export const WALRUS_TESTNET_PUBLISHER = 'https://publisher.walrus-testnet.walrus.space';

/** Default Walrus TESTNET aggregator base URL (public, documented default). */
export const WALRUS_TESTNET_AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';

/**
 * Mainnet endpoints are intentionally NOT shipped as a default: mainnet
 * publishing costs WAL and must go through a funded publisher you control
 * (`@mysten/walrus` + a Sui keypair, or a self-hosted publisher daemon).
 * Pass `WalrusClientOptions.publisher` / `.aggregator` to target mainnet.
 */
export const WALRUS_MAINNET_NOTE =
  'Mainnet Walrus requires a funded publisher (WAL). Pass explicit publisher/aggregator URLs.';

/** Options for constructing a {@link WalrusClient}. */
export interface WalrusClientOptions {
  /** Publisher base URL (no trailing slash needed). Defaults to testnet. */
  readonly publisher?: string;
  /** Aggregator base URL (no trailing slash needed). Defaults to testnet. */
  readonly aggregator?: string;
  /**
   * Number of storage epochs to keep the blob for (testnet: 1+; publisher
   * may cap it). Omitted → the publisher's default. Mainnet bills per epoch.
   */
  readonly epochs?: number;
  /**
   * Inject a `fetch` implementation (tests / non-global-fetch runtimes).
   * Defaults to the global `fetch`.
   */
  readonly fetchImpl?: typeof fetch;
}

/**
 * The normalized result of a publish. Walrus returns one of two shapes —
 * `newlyCreated` (this call stored it) or `alreadyCertified` (the identical
 * blob was already on the network). Both carry the blob id; we surface the id
 * plus which path it took.
 */
export interface PublishResult {
  /** The content-addressed Walrus blob id (use with {@link blobUrl}). */
  readonly blobId: string;
  /** `true` if this PUT created the blob; `false` if it was already certified. */
  readonly newlyCreated: boolean;
  /**
   * The Sui object id of the blob (present on `newlyCreated`), or undefined
   * when the blob was already certified by a prior publisher.
   */
  readonly suiObjectId?: string;
  /** Last storage epoch the blob is certified through, when the API reports it. */
  readonly endEpoch?: number;
}

/** Internal: strip a single trailing slash so we can join paths cleanly. */
function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Build the publisher URL for storing a blob. `epochs`, when provided, is sent
 * as the `?epochs=` query the Walrus publisher understands.
 *
 * Pure + synchronous — the unit tests assert this without any network.
 *
 * @param publisher - publisher base URL.
 * @param epochs - optional storage-epoch count.
 * @returns the full `PUT /v1/blobs` URL.
 */
export function publishUrl(publisher: string, epochs?: number): string {
  const base = `${trimTrailingSlash(publisher)}/v1/blobs`;
  if (epochs === undefined) {
    return base;
  }
  if (!Number.isInteger(epochs) || epochs < 1) {
    throw new Error(`walrus: epochs must be a positive integer, got ${epochs}`);
  }
  return `${base}?epochs=${epochs}`;
}

/**
 * Build the aggregator read URL for a blob id.
 *
 * Pure + synchronous. The blob id is content-addressed (URL-safe base64 of the
 * blob hash) so it is path-safe; we still reject empty / whitespace ids and
 * anything with a slash or `?` that would break the path or smuggle a query.
 *
 * @param aggregator - aggregator base URL.
 * @param blobId - the Walrus blob id returned by a publish.
 * @returns the full `GET /v1/blobs/{blobId}` URL.
 */
export function blobUrl(aggregator: string, blobId: string): string {
  const id = blobId.trim();
  if (id.length === 0) {
    throw new Error('walrus: blobId must be a non-empty string');
  }
  if (/[/?#\s]/.test(id)) {
    throw new Error(`walrus: blobId contains illegal path characters: ${blobId}`);
  }
  return `${trimTrailingSlash(aggregator)}/v1/blobs/${id}`;
}

/**
 * Normalize the publisher's JSON response into a {@link PublishResult}.
 *
 * Walrus returns either:
 *   { "newlyCreated": { "blobObject": { "blobId": "...", "id": "...", "storage": { "endEpoch": N } } } }
 * or:
 *   { "alreadyCertified": { "blobId": "...", "endEpoch": N } }
 *
 * Pure + synchronous so the parsing logic is unit-testable offline (the test
 * feeds both shapes without touching the network).
 *
 * @param body - the parsed JSON body from the publisher.
 * @returns the normalized result.
 * @throws if neither known shape carries a blob id.
 */
export function parsePublishResponse(body: unknown): PublishResult {
  const obj = (body ?? {}) as Record<string, unknown>;

  const newly = obj.newlyCreated as Record<string, unknown> | undefined;
  if (newly && typeof newly === 'object') {
    const blobObject = newly.blobObject as Record<string, unknown> | undefined;
    const blobId = blobObject?.blobId;
    if (typeof blobId === 'string' && blobId.length > 0) {
      const storage = blobObject?.storage as Record<string, unknown> | undefined;
      const endEpoch = storage?.endEpoch;
      const suiObjectId = blobObject?.id;
      return {
        blobId,
        newlyCreated: true,
        suiObjectId: typeof suiObjectId === 'string' ? suiObjectId : undefined,
        endEpoch: typeof endEpoch === 'number' ? endEpoch : undefined,
      };
    }
  }

  const certified = obj.alreadyCertified as Record<string, unknown> | undefined;
  if (certified && typeof certified === 'object') {
    const blobId = certified.blobId;
    if (typeof blobId === 'string' && blobId.length > 0) {
      const endEpoch = certified.endEpoch;
      return {
        blobId,
        newlyCreated: false,
        endEpoch: typeof endEpoch === 'number' ? endEpoch : undefined,
      };
    }
  }

  throw new Error(
    `walrus: unrecognized publisher response (no blobId): ${JSON.stringify(body)}`,
  );
}

/**
 * A thin, dependency-free client over the Walrus HTTP publisher + aggregator.
 *
 * Construct once (with testnet defaults or explicit URLs) and reuse:
 *
 * ```ts
 * const walrus = new WalrusClient();
 * const { blobId } = await walrus.publish(htmlBytes, 'text/html');
 * const url = walrus.urlFor(blobId);            // shareable, network-served
 * const bytes = await walrus.read(blobId);      // read it back from any aggregator
 * ```
 */
export class WalrusClient {
  private readonly publisher: string;
  private readonly aggregator: string;
  private readonly epochs?: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WalrusClientOptions = {}) {
    this.publisher = options.publisher ?? WALRUS_TESTNET_PUBLISHER;
    this.aggregator = options.aggregator ?? WALRUS_TESTNET_AGGREGATOR;
    this.epochs = options.epochs;
    const f = options.fetchImpl ?? globalThis.fetch;
    if (typeof f !== 'function') {
      throw new Error(
        'walrus: no fetch implementation available (Node 18+ or pass fetchImpl)',
      );
    }
    // Bind so a global fetch keeps its expected `this`.
    this.fetchImpl = f.bind(globalThis);
  }

  /**
   * Publish a blob to Walrus. Accepts raw bytes (or a string, encoded UTF-8).
   *
   * @param data - the blob contents (page HTML, SVG, asset bytes, receipt JSON).
   * @param contentType - optional MIME type sent as the `Content-Type` header.
   * @returns the normalized {@link PublishResult} (carrying the blob id).
   * @throws on a non-2xx response or an unrecognized body.
   */
  async publish(
    data: Uint8Array | string,
    contentType?: string,
  ): Promise<PublishResult> {
    const url = publishUrl(this.publisher, this.epochs);
    const headers: Record<string, string> = {};
    if (contentType) {
      headers['Content-Type'] = contentType;
    }
    const res = await this.fetchImpl(url, {
      method: 'PUT',
      headers,
      // TS 5.7 types Uint8Array as generic over its buffer and no longer auto-widens it to
      // BodyInit; the value is a valid fetch body at runtime, so cast it explicitly.
      body: (typeof data === 'string' ? new TextEncoder().encode(data) : data) as BodyInit,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `walrus: publish failed (${res.status} ${res.statusText}) ${text}`.trim(),
      );
    }
    return parsePublishResponse(await res.json());
  }

  /**
   * Read a blob back from the aggregator by id.
   *
   * @param blobId - the Walrus blob id.
   * @returns the blob bytes.
   * @throws on a non-2xx response.
   */
  async read(blobId: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(this.urlFor(blobId), { method: 'GET' });
    if (!res.ok) {
      throw new Error(
        `walrus: read failed (${res.status} ${res.statusText}) for ${blobId}`,
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * The public, network-served URL for a blob id (any aggregator can serve it).
   * Pure passthrough to {@link blobUrl} using this client's aggregator.
   *
   * @param blobId - the Walrus blob id.
   * @returns the shareable aggregator URL.
   */
  urlFor(blobId: string): string {
    return blobUrl(this.aggregator, blobId);
  }
}
