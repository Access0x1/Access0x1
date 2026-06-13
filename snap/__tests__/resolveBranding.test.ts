import { encodeFunctionResult, keccak256, stringToBytes } from 'viem/utils';
import { describe, expect, it, vi } from 'vitest';

import {
  fallbackBranding,
  nameMatchesHash,
  normalizeNameForHash,
  resolveBranding,
  shortHashLabel,
  type FetchLike,
  type ResolveDeps,
} from '../src/branding/resolve';
import { MERCHANTS_ABI } from '../src/router/abi';
import type { EthProvider } from '../src/router/merchant';
import type { SnapProvider } from '../src/state';
import type { MerchantBranding, SnapConfigState } from '../src/types';

const ROUTER = '0x9999999999999999999999999999999999999999' as const;
const PAYOUT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const OWNER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const ZERO = '0x0000000000000000000000000000000000000000' as const;
const ZERO_HASH = `0x${'0'.repeat(64)}` as `0x${string}`;

/** A Snap state provider seeded with an optional branding cache. */
function snapWith(state: Partial<SnapConfigState> | null): SnapProvider {
  return {
    request: vi.fn(async ({ params }: { params?: unknown }) => {
      const p = params as { operation?: string };
      if (p?.operation === 'get') {
        return state;
      }
      return null;
    }),
  };
}

/** An eth provider whose merchants() getter returns the given nameHash. */
function providerWithNameHash(
  nameHash: `0x${string}`,
  owner: `0x${string}` = OWNER,
): EthProvider {
  const encoded = encodeFunctionResult({
    abi: MERCHANTS_ABI,
    functionName: 'merchants',
    result: [PAYOUT, owner, ZERO, 0, true, nameHash],
  });
  return { request: vi.fn().mockResolvedValue(encoded) };
}

/** A fetch impl returning a JSON body with the given branding fields. */
function fetchReturning(body: unknown, ok = true): FetchLike {
  return vi.fn(async () => ({ ok, json: async () => body }));
}

/** A fetch impl that always rejects. */
const fetchThatThrows: FetchLike = vi.fn(async () => {
  throw new Error('network down');
});

function deps(over: Partial<ResolveDeps>): ResolveDeps {
  return {
    snap: snapWith(null),
    provider: { request: vi.fn().mockRejectedValue(new Error('no chain')) },
    routerAddress: ROUTER,
    apiBaseUrl: 'https://api.test',
    fetchImpl: fetchThatThrows,
    ...over,
  };
}

const hashOf = (name: string): `0x${string}` =>
  keccak256(stringToBytes(normalizeNameForHash(name)));

describe('nameMatchesHash', () => {
  it('matches a name against keccak256(normalized name)', () => {
    expect(nameMatchesHash("Joe's Barbershop", hashOf("Joe's Barbershop"))).toBe(
      true,
    );
  });

  it('is case/whitespace-insensitive via normalization', () => {
    expect(
      nameMatchesHash("  JOE'S   barbershop ", hashOf("joe's barbershop")),
    ).toBe(true);
  });

  it('returns false for a mismatch, null, or the zero hash', () => {
    expect(nameMatchesHash('Other', hashOf('Joe'))).toBe(false);
    expect(nameMatchesHash('Joe', null)).toBe(false);
    expect(nameMatchesHash('Joe', ZERO_HASH)).toBe(false);
  });
});

describe('resolveBranding ladder', () => {
  it('tier 1: returns cached branding, verified when the hash matches', async () => {
    const cached: MerchantBranding = {
      merchantId: '7',
      name: "Joe's Barbershop",
      description: 'Fresh cuts',
      logoSvg: '<svg><rect/></svg>',
      brandColor: '#123456',
      verified: false,
      updatedAt: 1,
    };
    const result = await resolveBranding(
      7n,
      deps({
        snap: snapWith({ branding: { '7': cached } }),
        provider: providerWithNameHash(hashOf("Joe's Barbershop")),
      }),
    );
    expect(result.name).toBe("Joe's Barbershop");
    expect(result.description).toBe('Fresh cuts');
    expect(result.verified).toBe(true);
  });

  it('tier 1: cached but unverified when the on-chain hash does not match', async () => {
    const cached: MerchantBranding = {
      merchantId: '7',
      name: 'Impostor Inc',
      description: '',
      logoSvg: null,
      brandColor: '#123456',
      verified: false,
      updatedAt: 1,
    };
    const result = await resolveBranding(
      7n,
      deps({
        snap: snapWith({ branding: { '7': cached } }),
        provider: providerWithNameHash(hashOf("Joe's Barbershop")),
      }),
    );
    expect(result.name).toBe('Impostor Inc');
    expect(result.verified).toBe(false);
  });

  it('tier 2: fetches + sanitizes branding when not cached', async () => {
    const result = await resolveBranding(
      9n,
      deps({
        fetchImpl: fetchReturning({
          name: 'Bakery <b>X</b>',
          description: 'Bread & pastries',
          logoSvg: '<svg onload="x()"><rect/></svg>', // unsafe → dropped
          brandColor: 'not-a-color', // → default
        }),
        provider: providerWithNameHash(ZERO_HASH),
      }),
    );
    expect(result.name).toBe('Bakery <b>X</b>');
    expect(result.description).toBe('Bread & pastries');
    expect(result.logoSvg).toBeNull(); // scriptful logo rejected
    expect(result.brandColor).toBe('#4f46e5'); // default
    expect(result.verified).toBe(false);
  });

  it('tier 3: on-chain nameHash short form when nothing else resolves', async () => {
    const nameHash = hashOf('whatever');
    const result = await resolveBranding(
      4n,
      deps({
        snap: snapWith(null),
        fetchImpl: fetchThatThrows,
        provider: providerWithNameHash(nameHash),
      }),
    );
    expect(result.name).toBe('Merchant #4');
    expect(result.verified).toBe(true);
    expect(result.description).toContain(shortHashLabel(nameHash));
  });

  it('tier 4: Merchant #<id> fallback when nothing resolves and no router', async () => {
    const result = await resolveBranding(
      11n,
      deps({ routerAddress: null, snap: snapWith(null) }),
    );
    expect(result.name).toBe('Merchant #11');
    expect(result.verified).toBe(false);
    expect(result.logoSvg).toBeNull();
  });

  it('never throws when fetch and chain both fail', async () => {
    const result = await resolveBranding(
      3n,
      deps({
        snap: snapWith(null),
        fetchImpl: fetchThatThrows,
        provider: { request: vi.fn().mockRejectedValue(new Error('rpc')) },
      }),
    );
    expect(result.name).toBe('Merchant #3');
  });
});

describe('fallbackBranding', () => {
  it('is always renderable and never verified', () => {
    const b = fallbackBranding(5n);
    expect(b.name).toBe('Merchant #5');
    expect(b.verified).toBe(false);
    expect(b.merchantId).toBe('5');
  });
});
