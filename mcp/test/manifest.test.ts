import { describe, expect, it, vi } from 'vitest';
import type { HttpFetch } from '../src/http.js';
import { ManifestError } from '../src/errors.js';
import {
  explorerAddressLink,
  findChain,
  listChains,
  loadManifest,
  parseManifest,
  type RailManifest,
} from '../src/manifest.js';

const PROV = { via: 'path', ref: './m.json', loadedAt: '2026-07-22T00:00:00.000Z' } as const;

const ROUTER = '0xe92244e3368561faf21648146511DeDE3a475EB5';

/** A minimal valid manifest text with two chains, one fully priced. */
function validManifestText(): string {
  return JSON.stringify({
    namespace: 'access0x1.v1.',
    router: ROUTER,
    contracts: { 'Access0x1Router.proxy': ROUTER },
    chains: [
      {
        id: 84532,
        name: 'Base Sepolia',
        router: ROUTER,
        explorerUrl: 'https://sepolia.basescan.org/',
        verified: true,
      },
      {
        id: 11155111,
        name: 'Ethereum Sepolia',
        router: ROUTER,
        usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        nativeUsdFeed: '0x694AA1769357215DE4FAC081bf1f309aDC325306',
        rpcUrl: 'https://sepolia.example/rpc',
      },
    ],
  });
}

/** An HTTP stub that returns the given body/status. */
function stubFetch(body: string, ok = true, status = 200): HttpFetch {
  return vi.fn(async () => ({ ok, status, text: async () => body }));
}

describe('parseManifest', () => {
  it('parses a valid manifest and defaults absent optional fields to null', () => {
    const m = parseManifest(validManifestText(), PROV);
    expect(m.namespace).toBe('access0x1.v1.');
    expect(m.router).toBe(ROUTER);
    expect(m.chains).toHaveLength(2);

    const base = findChain(m, 84532)!;
    expect(base.usdc).toBeNull();
    expect(base.nativeUsdFeed).toBeNull();
    expect(base.verified).toBe(true);
    // A trailing slash on the explorer URL is stripped.
    expect(base.explorerUrl).toBe('https://sepolia.basescan.org');

    const eth = findChain(m, 11155111)!;
    expect(eth.usdc).toBe('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
    // verified omitted → not asserted (null), never coerced to false.
    expect(eth.verified).toBeNull();
  });

  it('rejects invalid JSON', () => {
    expect(() => parseManifest('{ not json', PROV)).toThrow(ManifestError);
  });

  it('rejects a non-object root', () => {
    expect(() => parseManifest('[]', PROV)).toThrow(/root must be a JSON object/);
  });

  it('rejects a missing or empty chains array', () => {
    expect(() => parseManifest(JSON.stringify({ router: ROUTER }), PROV)).toThrow(/chains must be an array/);
    expect(() => parseManifest(JSON.stringify({ chains: [] }), PROV)).toThrow(/must not be empty/);
  });

  it('rejects a chain with a missing/invalid router address', () => {
    const text = JSON.stringify({ chains: [{ id: 1, name: 'X', router: '0xdeadbeef' }] });
    expect(() => parseManifest(text, PROV)).toThrow(/chains\[0\]\.router must be a 0x-prefixed 20-byte address/);
  });

  it('rejects a present-but-malformed optional address', () => {
    const text = JSON.stringify({
      chains: [{ id: 1, name: 'X', router: ROUTER, usdc: '0xnothex' }],
    });
    expect(() => parseManifest(text, PROV)).toThrow(/chains\[0\]\.usdc/);
  });

  it('rejects a non-integer chain id', () => {
    const text = JSON.stringify({ chains: [{ id: 1.5, name: 'X', router: ROUTER }] });
    expect(() => parseManifest(text, PROV)).toThrow(/id must be a positive integer/);
  });

  it('rejects duplicate chain ids', () => {
    const text = JSON.stringify({
      chains: [
        { id: 1, name: 'A', router: ROUTER },
        { id: 1, name: 'B', router: ROUTER },
      ],
    });
    expect(() => parseManifest(text, PROV)).toThrow(/duplicate chain id 1/);
  });

  it('rejects a contracts map with a bad address', () => {
    const text = JSON.stringify({
      contracts: { Foo: '0xnope' },
      chains: [{ id: 1, name: 'X', router: ROUTER }],
    });
    expect(() => parseManifest(text, PROV)).toThrow(/contracts\.Foo/);
  });
});

describe('loadManifest', () => {
  it('loads from the path source and records path provenance', async () => {
    const m = await loadManifest([{ kind: 'path', value: './m.json' }], {
      readFile: async () => validManifestText(),
      fetch: stubFetch('unused', false, 500),
      now: () => Date.parse('2026-07-22T00:00:00.000Z'),
    });
    expect(m.provenance.via).toBe('path');
    expect(m.provenance.ref).toBe('./m.json');
    expect(m.chains).toHaveLength(2);
  });

  it('falls back to the url source when the path source fails', async () => {
    const m = await loadManifest(
      [
        { kind: 'path', value: './missing.json' },
        { kind: 'url', value: 'https://raw/m.json' },
      ],
      {
        readFile: async () => {
          throw new Error('ENOENT');
        },
        fetch: stubFetch(validManifestText()),
      },
    );
    expect(m.provenance.via).toBe('url');
    expect(m.provenance.ref).toBe('https://raw/m.json');
  });

  it('throws with every attempt when all sources fail', async () => {
    await expect(
      loadManifest(
        [
          { kind: 'path', value: './a.json' },
          { kind: 'url', value: 'https://raw/b.json' },
        ],
        {
          readFile: async () => {
            throw new Error('ENOENT');
          },
          fetch: stubFetch('nope', false, 404),
        },
      ),
    ).rejects.toThrow(/could not load a valid manifest from any source/);
  });

  it('treats an HTTP error as a source failure', async () => {
    await expect(
      loadManifest([{ kind: 'url', value: 'https://raw/m.json' }], {
        readFile: async () => 'unused',
        fetch: stubFetch('server error', false, 502),
      }),
    ).rejects.toThrow(/HTTP 502/);
  });
});

describe('accessors', () => {
  const m: RailManifest = parseManifest(validManifestText(), PROV);

  it('lists chains sorted by id', () => {
    expect(listChains(m).map((c) => c.id)).toEqual([84532, 11155111]);
  });

  it('builds an explorer address link, or null when no explorer', () => {
    const base = findChain(m, 84532)!;
    expect(explorerAddressLink(base, ROUTER)).toBe(`https://sepolia.basescan.org/address/${ROUTER}`);
    const eth = findChain(m, 11155111)!;
    expect(explorerAddressLink(eth, ROUTER)).toBeNull();
  });
});
