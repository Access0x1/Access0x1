import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { namehash, normalize } from 'viem/ens';

// Mock viem's client factory so resolveENS / verifiedPrimaryName never hit the
// network in unit runs. getEnsAddress + readContract are methods on the returned
// client; tests set their return values.
const getEnsAddress = vi.fn();
const readContract = vi.fn();
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({ getEnsAddress, readContract })),
  };
});

import {
  DEFAULT_ENS_UNIVERSAL_RESOLVER,
  EnsResolutionError,
  ensNode,
  isEnsInput,
  nameHashColor,
  nameHashIdenticon,
  resolveENS,
  toCoinType,
  universalResolverAddress,
  verifiedPrimaryName,
} from '../lib/ens';

const ALICE = namehash(normalize('alice.eth'));
const BOB = namehash(normalize('bob.eth'));
const VALID_ADDR = '0x1111111111111111111111111111111111111111';

beforeEach(() => {
  getEnsAddress.mockReset();
  readContract.mockReset();
  // Default the resolver to the built-in constant; individual tests override.
  delete process.env.NEXT_PUBLIC_ENS_UNIVERSAL_RESOLVER;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isEnsInput', () => {
  it('treats alice.eth as ENS', () => {
    expect(isEnsInput('alice.eth')).toBe(true);
  });

  it('treats ensfairy.xyz as ENS (DNS import, NOT caught by endsWith(.eth))', () => {
    expect(isEnsInput('ensfairy.xyz')).toBe(true);
  });

  it('rejects a literal 0x address', () => {
    expect(isEnsInput(VALID_ADDR)).toBe(false);
  });

  it('rejects a short, dotless label', () => {
    expect(isEnsInput('alice')).toBe(false);
  });
});

describe('toCoinType (ENSIP-11, derived not hard-coded)', () => {
  it('derives Base (8453) coinType', () => {
    expect(toCoinType(8453)).toBe(0x80002105);
  });

  it('derives Arc (5042002) coinType as an UNSIGNED 32-bit int', () => {
    // (0x80000000 | chainId) >>> 0 — never the negative int32 the plain OR gives.
    expect(toCoinType(5042002)).toBe((0x80000000 | 5042002) >>> 0);
    expect(toCoinType(5042002)).toBeGreaterThan(0);
  });
});

describe('ensNode', () => {
  it('matches viem namehash(normalize(label))', () => {
    expect(ensNode('alice.eth')).toBe(ALICE);
  });
});

describe('nameHashColor', () => {
  it('returns # + 6 hex chars', () => {
    const color = nameHashColor(ALICE);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('is deterministic on the same node', () => {
    expect(nameHashColor(ALICE)).toBe(nameHashColor(ALICE));
  });

  it('differs for different nodes (collision-resistance smoke test)', () => {
    expect(nameHashColor(ALICE)).not.toBe(nameHashColor(BOB));
  });
});

describe('nameHashIdenticon', () => {
  it('returns a string starting with <svg', () => {
    expect(nameHashIdenticon(ALICE).startsWith('<svg')).toBe(true);
  });

  it('embeds the brand color and is deterministic', () => {
    const svg = nameHashIdenticon(ALICE);
    expect(svg).toContain(nameHashColor(ALICE));
    expect(svg).toBe(nameHashIdenticon(ALICE));
  });

  it('is left/right symmetric (a left-edge cell implies a right-edge cell)', () => {
    const svg = nameHashIdenticon(BOB);
    expect(svg.includes('x="0"')).toBe(svg.includes('x="160"'));
  });
});

describe('resolveENS', () => {
  it('returns a literal address unchanged with NO network call', async () => {
    const out = await resolveENS(VALID_ADDR, 8453);
    expect(out).toBe(VALID_ADDR);
    expect(getEnsAddress).not.toHaveBeenCalled();
  });

  it('throws EnsResolutionError on a null resolution (never silently null)', async () => {
    getEnsAddress.mockResolvedValue(null);
    await expect(resolveENS('alice.eth', 8453)).rejects.toBeInstanceOf(
      EnsResolutionError,
    );
  });

  it('throws EnsResolutionError on the zero address (money paths never swallow)', async () => {
    getEnsAddress.mockResolvedValue(
      '0x0000000000000000000000000000000000000000',
    );
    await expect(resolveENS('alice.eth', 8453)).rejects.toBeInstanceOf(
      EnsResolutionError,
    );
  });

  it('passes the derived coinType for an L2 settlement chain', async () => {
    getEnsAddress.mockResolvedValue(
      '0x7d3a48269416507e6d207a9449e7800971823ffa',
    );
    await resolveENS('test.ses.eth', 8453);
    expect(getEnsAddress).toHaveBeenCalledWith(
      expect.objectContaining({ coinType: BigInt(toCoinType(8453)) }),
    );
  });

  it('does NOT pass a coinType for mainnet (chain id 1 uses ENS default 60)', async () => {
    getEnsAddress.mockResolvedValue(VALID_ADDR);
    await resolveENS('alice.eth', 1);
    const arg = getEnsAddress.mock.calls[0]?.[0];
    expect(arg?.coinType).toBeUndefined();
  });

  it('throws for non-ENS, non-address junk input', async () => {
    await expect(resolveENS('alice', 8453)).rejects.toBeInstanceOf(
      EnsResolutionError,
    );
  });
});

describe('universalResolverAddress', () => {
  it('defaults to the built-in (confirm-on-Etherscan) constant', () => {
    expect(universalResolverAddress()).toBe(DEFAULT_ENS_UNIVERSAL_RESOLVER);
  });

  it('uses NEXT_PUBLIC_ENS_UNIVERSAL_RESOLVER when set', () => {
    process.env.NEXT_PUBLIC_ENS_UNIVERSAL_RESOLVER = VALID_ADDR;
    expect(universalResolverAddress()).toBe(VALID_ADDR);
  });

  it('returns null for an invalid override (fail-soft, no throw)', () => {
    process.env.NEXT_PUBLIC_ENS_UNIVERSAL_RESOLVER = 'not-an-address';
    expect(universalResolverAddress()).toBeNull();
  });
});

describe('verifiedPrimaryName (ENSIP-19 reverse + forward check)', () => {
  // A real merchant payout address + the name that (in these mocks) round-trips.
  const MERCHANT = '0x7d3a48269416507e6d207a9449e7800971823ffa';

  it('returns the name when forward == reverse (verified pass)', async () => {
    // reverse(addr, coinType) → [name, resolvedAddress, …]; resolved == input.
    readContract.mockResolvedValue(['acme.eth', MERCHANT, MERCHANT, MERCHANT]);
    const name = await verifiedPrimaryName(MERCHANT, 8453);
    expect(name).toBe('acme.eth');
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  it('compares forward vs reverse case-insensitively (checksum-safe)', async () => {
    // The resolver returns the CHECKSUMMED (mixed-case) form; the input merchant
    // address is all-lowercase. getAddress normalizes both, so they still match.
    const CHECKSUMMED = '0x7d3a48269416507E6d207a9449E7800971823Ffa';
    expect(CHECKSUMMED.toLowerCase()).toBe(MERCHANT); // same address, just cased
    readContract.mockResolvedValue(['acme.eth', CHECKSUMMED, MERCHANT, MERCHANT]);
    expect(await verifiedPrimaryName(MERCHANT, 8453)).toBe('acme.eth');
  });

  it('returns null when forward != reverse (mismatch is NOT trusted)', async () => {
    // The primary name forward-resolves to a DIFFERENT address ⇒ reject.
    readContract.mockResolvedValue([
      'evil.eth',
      '0x1111111111111111111111111111111111111111',
      MERCHANT,
      MERCHANT,
    ]);
    expect(await verifiedPrimaryName(MERCHANT, 8453)).toBeNull();
  });

  it('returns null when no resolver is configured (fail-soft, no network)', async () => {
    process.env.NEXT_PUBLIC_ENS_UNIVERSAL_RESOLVER = 'not-an-address';
    expect(await verifiedPrimaryName(MERCHANT, 8453)).toBeNull();
    expect(readContract).not.toHaveBeenCalled();
  });

  it('returns null for an empty primary name', async () => {
    readContract.mockResolvedValue(['', MERCHANT, MERCHANT, MERCHANT]);
    expect(await verifiedPrimaryName(MERCHANT, 8453)).toBeNull();
  });

  it('returns null (never throws) when the resolver call reverts', async () => {
    readContract.mockRejectedValue(new Error('execution reverted'));
    await expect(verifiedPrimaryName(MERCHANT, 8453)).resolves.toBeNull();
  });

  it('returns null for a non-address input without a network call', async () => {
    expect(await verifiedPrimaryName('not-an-address', 8453)).toBeNull();
    expect(readContract).not.toHaveBeenCalled();
  });

  it('derives the ENSIP-11 coinType for an L2 (8453 → 0x80002105)', async () => {
    readContract.mockResolvedValue(['acme.eth', MERCHANT, MERCHANT, MERCHANT]);
    await verifiedPrimaryName(MERCHANT, 8453);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ args: [MERCHANT, BigInt(toCoinType(8453))] }),
    );
  });

  it('uses coinType 60 for mainnet (chain id 1)', async () => {
    readContract.mockResolvedValue(['acme.eth', MERCHANT, MERCHANT, MERCHANT]);
    await verifiedPrimaryName(MERCHANT, 1);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ args: [MERCHANT, 60n] }),
    );
  });
});
