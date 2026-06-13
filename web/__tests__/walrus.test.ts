/**
 * walrus.test.ts — OFFLINE unit tests for the Walrus host seam.
 *
 * These exercise the pure encode/url/parse logic and the WalrusClient against
 * an INJECTED fetch stub. No network is touched — the gate runs without a Sui
 * node, a publisher, or any connectivity.
 */

import { describe, expect, it } from 'vitest';

import {
  WALRUS_TESTNET_AGGREGATOR,
  WALRUS_TESTNET_PUBLISHER,
  WalrusClient,
  blobUrl,
  parsePublishResponse,
  publishUrl,
} from '../lib/walrus';

describe('publishUrl', () => {
  it('builds the bare /v1/blobs path with no epochs', () => {
    expect(publishUrl('https://pub.example')).toBe('https://pub.example/v1/blobs');
  });

  it('strips a single trailing slash from the base', () => {
    expect(publishUrl('https://pub.example/')).toBe('https://pub.example/v1/blobs');
  });

  it('appends ?epochs= when an epoch count is given', () => {
    expect(publishUrl('https://pub.example', 5)).toBe(
      'https://pub.example/v1/blobs?epochs=5',
    );
  });

  it('rejects a non-positive or non-integer epoch count', () => {
    expect(() => publishUrl('https://pub.example', 0)).toThrow(/positive integer/);
    expect(() => publishUrl('https://pub.example', -3)).toThrow(/positive integer/);
    expect(() => publishUrl('https://pub.example', 1.5)).toThrow(/positive integer/);
  });
});

describe('blobUrl', () => {
  it('builds the aggregator read path for a blob id', () => {
    expect(blobUrl('https://agg.example', 'abc123')).toBe(
      'https://agg.example/v1/blobs/abc123',
    );
  });

  it('trims a trailing slash on the aggregator and whitespace on the id', () => {
    expect(blobUrl('https://agg.example/', '  abc123  ')).toBe(
      'https://agg.example/v1/blobs/abc123',
    );
  });

  it('rejects an empty / whitespace-only blob id', () => {
    expect(() => blobUrl('https://agg.example', '')).toThrow(/non-empty/);
    expect(() => blobUrl('https://agg.example', '   ')).toThrow(/non-empty/);
  });

  it('rejects a blob id with path-breaking characters', () => {
    expect(() => blobUrl('https://agg.example', 'a/b')).toThrow(/illegal path/);
    expect(() => blobUrl('https://agg.example', 'a?x=1')).toThrow(/illegal path/);
    expect(() => blobUrl('https://agg.example', 'a#frag')).toThrow(/illegal path/);
  });
});

describe('parsePublishResponse', () => {
  it('parses a newlyCreated response (blob id + sui object + endEpoch)', () => {
    const body = {
      newlyCreated: {
        blobObject: {
          id: '0xsuiobject',
          blobId: 'BLOB_NEW',
          storage: { endEpoch: 42 },
        },
      },
    };
    const result = parsePublishResponse(body);
    expect(result.blobId).toBe('BLOB_NEW');
    expect(result.newlyCreated).toBe(true);
    expect(result.suiObjectId).toBe('0xsuiobject');
    expect(result.endEpoch).toBe(42);
  });

  it('parses an alreadyCertified response', () => {
    const body = { alreadyCertified: { blobId: 'BLOB_OLD', endEpoch: 7 } };
    const result = parsePublishResponse(body);
    expect(result.blobId).toBe('BLOB_OLD');
    expect(result.newlyCreated).toBe(false);
    expect(result.suiObjectId).toBeUndefined();
    expect(result.endEpoch).toBe(7);
  });

  it('throws on a body with no recognizable blob id', () => {
    expect(() => parsePublishResponse({})).toThrow(/no blobId/);
    expect(() => parsePublishResponse(null)).toThrow(/no blobId/);
    expect(() => parsePublishResponse({ newlyCreated: {} })).toThrow(/no blobId/);
  });
});

describe('WalrusClient (offline, injected fetch)', () => {
  it('defaults to the documented testnet endpoints', () => {
    const client = new WalrusClient({ fetchImpl: (async () => new Response()) as typeof fetch });
    expect(client.urlFor('xyz')).toBe(`${WALRUS_TESTNET_AGGREGATOR}/v1/blobs/xyz`);
  });

  it('publish() PUTs to the publisher and returns the parsed blob id', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchStub = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          newlyCreated: { blobObject: { id: '0xobj', blobId: 'PUB_ID', storage: { endEpoch: 10 } } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const client = new WalrusClient({
      publisher: 'https://pub.test',
      aggregator: 'https://agg.test',
      epochs: 3,
      fetchImpl: fetchStub,
    });

    const result = await client.publish('<html>checkout</html>', 'text/html');

    expect(result.blobId).toBe('PUB_ID');
    expect(result.newlyCreated).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://pub.test/v1/blobs?epochs=3');
    expect(calls[0].init?.method).toBe('PUT');
    expect((calls[0].init?.headers as Record<string, string>)['Content-Type']).toBe('text/html');
    // The string body is UTF-8 encoded to bytes (never sent as a raw string).
    expect(calls[0].init?.body).toBeInstanceOf(Uint8Array);
  });

  it('publish() throws with status detail on a non-2xx response', async () => {
    const fetchStub = (async () =>
      new Response('over quota', { status: 413, statusText: 'Payload Too Large' })) as typeof fetch;
    const client = new WalrusClient({ fetchImpl: fetchStub });
    await expect(client.publish('x')).rejects.toThrow(/publish failed \(413/);
  });

  it('read() GETs the aggregator URL and returns the bytes', async () => {
    let seenUrl = '';
    const fetchStub = (async (url: string) => {
      seenUrl = url;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new WalrusClient({ aggregator: 'https://agg.test', fetchImpl: fetchStub });
    const bytes = await client.read('READ_ID');
    expect(seenUrl).toBe('https://agg.test/v1/blobs/READ_ID');
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it('read() throws with status detail on a non-2xx response', async () => {
    const fetchStub = (async () =>
      new Response('nope', { status: 404, statusText: 'Not Found' })) as typeof fetch;
    const client = new WalrusClient({ fetchImpl: fetchStub });
    await expect(client.read('MISSING')).rejects.toThrow(/read failed \(404/);
  });

  it('exposes the documented testnet publisher constant', () => {
    expect(WALRUS_TESTNET_PUBLISHER).toMatch(/walrus-testnet/);
  });
});
