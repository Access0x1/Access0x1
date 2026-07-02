import { encodeFunctionResult } from 'viem/utils';
import { describe, expect, it, vi } from 'vitest';

import { MERCHANTS_ABI, PLATFORM_FEE_ABI } from '../src/router/abi';
import { fetchMerchantName } from '../src/router/merchant';
import type { EthProvider } from '../src/router/merchant';

const ROUTER = '0x9999999999999999999999999999999999999999' as const;
const PAYOUT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const OWNER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const ZERO = '0x0000000000000000000000000000000000000000' as const;

/**
 * Build a provider that answers BOTH router reads the fetch makes: the no-arg
 * `platformFeeBps()` call (routed by its argument-less calldata) and the
 * `merchants(id)` tuple. Routing on calldata length keeps the double so a single
 * mock can serve both without ordering assumptions.
 */
function providerReturning(
  payout: `0x${string}`,
  owner: `0x${string}`,
  feeBps: number,
  platformFeeBps = 0,
): EthProvider {
  const merchantsEncoded = encodeFunctionResult({
    abi: MERCHANTS_ABI,
    functionName: 'merchants',
    result: [payout, owner, ZERO, feeBps, true, ('0x' + '0'.repeat(64)) as `0x${string}`],
  });
  const platformEncoded = encodeFunctionResult({
    abi: PLATFORM_FEE_ABI,
    functionName: 'platformFeeBps',
    result: platformFeeBps,
  });
  const request = vi.fn(async (args: { method: string; params?: unknown[] }) => {
    const call = (args.params?.[0] ?? {}) as { data?: string };
    // platformFeeBps() takes no args → calldata is just the 4-byte selector (10 chars).
    if ((call.data ?? '').length <= 10) return platformEncoded;
    return merchantsEncoded;
  });
  return { request };
}

describe('fetchMerchantName', () => {
  it('returns on-chain payout + feeBps + platformFeeBps and ENS name when the resolver succeeds', async () => {
    const provider = providerReturning(PAYOUT, OWNER, 150, 100);
    const ens = vi.fn().mockResolvedValue('demo.access0x1.eth');
    const info = await fetchMerchantName(7n, 5042002, ROUTER, provider, ens);
    expect(info.name).toBe('demo.access0x1.eth');
    expect(info.payout.toLowerCase()).toBe(PAYOUT);
    expect(info.feeBps).toBe(150);
    expect(info.platformFeeBps).toBe(100); // read from platformFeeBps() — the total fee needs it
  });

  it('falls back to "Merchant #<id>" when the ENS resolver misses', async () => {
    const provider = providerReturning(PAYOUT, OWNER, 0);
    const ens = vi.fn().mockResolvedValue(null);
    const info = await fetchMerchantName(42n, 5042002, ROUTER, provider, ens);
    expect(info.name).toBe('Merchant #42');
  });

  it('falls back when no ENS resolver is provided', async () => {
    const provider = providerReturning(PAYOUT, OWNER, 0);
    const info = await fetchMerchantName(5n, 5042002, ROUTER, provider);
    expect(info.name).toBe('Merchant #5');
    expect(info.payout.toLowerCase()).toBe(PAYOUT);
  });

  it('falls back for an unregistered merchant (owner === address(0))', async () => {
    const provider = providerReturning(ZERO, ZERO, 0);
    const ens = vi.fn().mockResolvedValue('should.not.use.eth');
    const info = await fetchMerchantName(9n, 5042002, ROUTER, provider, ens);
    expect(info.name).toBe('Merchant #9');
    expect(ens).not.toHaveBeenCalled();
  });

  it('falls back (never throws) on an eth_call network error', async () => {
    const provider: EthProvider = {
      request: vi.fn().mockRejectedValue(new Error('network down')),
    };
    const info = await fetchMerchantName(3n, 5042002, ROUTER, provider);
    expect(info.name).toBe('Merchant #3');
  });

  it('falls back when no router address is configured', async () => {
    const provider: EthProvider = { request: vi.fn() };
    const info = await fetchMerchantName(1n, 5042002, null, provider);
    expect(info.name).toBe('Merchant #1');
    expect(provider.request).not.toHaveBeenCalled();
  });

  it('keeps the fallback name when the ENS resolver itself throws', async () => {
    const provider = providerReturning(PAYOUT, OWNER, 0);
    const ens = vi.fn().mockRejectedValue(new Error('ens rpc failed'));
    const info = await fetchMerchantName(2n, 5042002, ROUTER, provider, ens);
    expect(info.name).toBe('Merchant #2');
  });
});
