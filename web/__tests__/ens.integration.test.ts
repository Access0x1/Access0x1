import { describe, expect, it } from 'vitest';
import { resolveENS } from '../lib/ens';

/**
 * ENS CI integration vectors (the three from ENS.md).
 *
 * These require LIVE Mainnet HTTP (CCIP-Read egress must work) and are tagged
 * `@integration`. Exclude them from offline unit runs:
 *   `npm test -- --exclude '**\/*.integration.test.ts'`
 * or run them only when a Mainnet RPC is reachable.
 */
describe('ENS resolution — integration vectors (@integration, live network)', () => {
  // Allow extra time for CCIP-Read round-trips.
  const TIMEOUT = 30_000;

  it(
    'Vector 1 — ur.integration-tests.eth resolves via Universal Resolver v3',
    async () => {
      const addr = await resolveENS('ur.integration-tests.eth', 1 /* mainnet */);
      // 0x2222… proves UR v3. 0x1111… would mean viem is too old (bump >=2.35.0).
      expect(addr.toLowerCase()).toBe(
        '0x2222222222222222222222222222222222222222',
      );
    },
    TIMEOUT,
  );

  it(
    'Vector 2 — test.offchaindemo.eth resolves (proves CCIP-Read HTTP egress)',
    async () => {
      const addr = await resolveENS('test.offchaindemo.eth', 1 /* mainnet */);
      expect(addr.toLowerCase()).toBe(
        '0x779981590e7ccc0cfae8040ce7151324747cdb97',
      );
    },
    TIMEOUT,
  );

  it(
    'Vector 3 — test.ses.eth: mainnet addr != Base addr (coinType money-path rule)',
    async () => {
      const mainnetAddr = await resolveENS('test.ses.eth', 1 /* mainnet, coinType 60 */);
      const baseAddr = await resolveENS('test.ses.eth', 8453 /* Base = 0x80002105 */);

      expect(mainnetAddr.toLowerCase()).toBe(
        '0x2b0f09f23193de2fb66258a10886b9f06903276c',
      );
      expect(baseAddr.toLowerCase()).toBe(
        '0x7d3a48269416507e6d207a9449e7800971823ffa',
      );
      // The proof: same name, different addresses ⇒ always pass coinType for L2.
      expect(mainnetAddr.toLowerCase()).not.toBe(baseAddr.toLowerCase());
    },
    TIMEOUT,
  );
});
