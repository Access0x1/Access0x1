import { describe, expect, it, vi } from 'vitest';
import type { HttpFetch } from '../src/http.js';
import { readLeaderboard, readMerchant, readMerchantPayments } from '../src/subgraph.js';

const URL = 'https://subgraph.example/q';

/** A fetch stub returning a JSON body with the given HTTP status. */
function jsonFetch(payload: unknown, ok = true, status = 200): HttpFetch {
  return vi.fn(async () => ({ ok, status, text: async () => JSON.stringify(payload) }));
}

/** A fetch stub that throws (network down). */
function throwingFetch(): HttpFetch {
  return vi.fn(async () => {
    throw new Error('network down');
  });
}

describe('readMerchant', () => {
  it('parses a merchant aggregate and surfaces _meta', async () => {
    const fetchImpl = jsonFetch({
      data: {
        merchants: [
          {
            merchantId: '49',
            owner: '0x1111111111111111111111111111111111111111',
            payout: '0x2222222222222222222222222222222222222222',
            feeBps: 250,
            active: true,
            paymentCount: '7',
            totalUsd8: '500000000',
            lastPaymentAt: '1752700000',
          },
        ],
        _meta: { block: { number: 43_900_000 }, hasIndexingErrors: false },
      },
    });
    const out = await readMerchant(URL, { by: 'merchantId', merchantId: 49n }, fetchImpl);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.data.merchant?.paymentCount).toBe(7n);
    expect(out.data.merchant?.totalUsd8).toBe(500_000_000n);
    expect(out.meta.asOfBlock).toBe(43_900_000n);
    expect(out.meta.hasIndexingErrors).toBe(false);
  });

  it('returns an absent merchant (null) when the id is not indexed', async () => {
    const fetchImpl = jsonFetch({ data: { merchants: [], _meta: { block: { number: 1 }, hasIndexingErrors: false } } });
    const out = await readMerchant(URL, { by: 'merchantId', merchantId: 999n }, fetchImpl);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.data.merchant).toBeNull();
    expect(out.meta.asOfBlock).toBe(1n);
  });

  it('looks up by lowercased owner address', async () => {
    const fetchImpl = jsonFetch({ data: { merchants: [], _meta: { block: { number: 2 }, hasIndexingErrors: false } } });
    await readMerchant(URL, { by: 'owner', owner: '0xABCabcABCabcABCabcABCabcABCabcABCabcABCa' }, fetchImpl);
    const call = (fetchImpl as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0]!;
    const body = JSON.parse(call[1].body) as { variables: { key: string } };
    expect(body.variables.key).toBe('0xabcabcabcabcabcabcabcabcabcabcabcabcabca');
  });

  it('fails soft on a GraphQL error', async () => {
    const out = await readMerchant(URL, { by: 'merchantId', merchantId: 1n }, jsonFetch({ errors: [{ message: 'bad' }] }));
    expect(out.status).toBe('failed');
  });

  it('fails soft on a non-2xx response', async () => {
    const out = await readMerchant(URL, { by: 'merchantId', merchantId: 1n }, jsonFetch({}, false, 500));
    expect(out.status).toBe('failed');
  });

  it('fails soft when fetch throws', async () => {
    const out = await readMerchant(URL, { by: 'merchantId', merchantId: 1n }, throwingFetch());
    expect(out.status).toBe('failed');
  });

  it('fails soft on a malformed numeric field', async () => {
    const fetchImpl = jsonFetch({
      data: {
        merchants: [{ merchantId: '1', paymentCount: 'not-a-number', totalUsd8: '1', lastPaymentAt: '1' }],
        _meta: { block: { number: 1 }, hasIndexingErrors: false },
      },
    });
    const out = await readMerchant(URL, { by: 'merchantId', merchantId: 1n }, fetchImpl);
    expect(out.status).toBe('failed');
  });
});

describe('readMerchantPayments', () => {
  it('parses payment rows newest-first and surfaces _meta', async () => {
    const fetchImpl = jsonFetch({
      data: {
        payments: [
          {
            transactionHash: '0xtx1',
            buyer: '0xbuyer',
            token: '0x0000000000000000000000000000000000000000',
            grossAmount: '1000000',
            feeAmount: '10000',
            netAmount: '990000',
            usdAmount8: '100000000',
            blockNumber: '43900001',
            blockTimestamp: '1752700001',
          },
        ],
        _meta: { block: { number: 43_900_001 }, hasIndexingErrors: false },
      },
    });
    const out = await readMerchantPayments(URL, 49n, 10, fetchImpl);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.data.payments).toHaveLength(1);
    expect(out.data.payments[0]!.usdAmount8).toBe(100_000_000n);
    expect(out.meta.asOfBlock).toBe(43_900_001n);
  });

  it('fails soft on a missing payments array', async () => {
    const out = await readMerchantPayments(URL, 1n, 10, jsonFetch({ data: { _meta: { hasIndexingErrors: false } } }));
    expect(out.status).toBe('failed');
  });
});

describe('readLeaderboard', () => {
  it('parses ranked merchants and surfaces _meta', async () => {
    const fetchImpl = jsonFetch({
      data: {
        merchants: [
          { merchantId: '7', owner: null, paymentCount: '20', totalUsd8: '900000000', lastPaymentAt: '1752700000' },
          { merchantId: '3', owner: null, paymentCount: '5', totalUsd8: '100000000', lastPaymentAt: '1752600000' },
        ],
        _meta: { block: { number: 43_900_002 }, hasIndexingErrors: true },
      },
    });
    const out = await readLeaderboard(URL, 10, fetchImpl);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.data.merchants.map((m) => m.merchantId)).toEqual([7n, 3n]);
    // Even a degraded index surfaces the flag, never hides it.
    expect(out.meta.hasIndexingErrors).toBe(true);
    expect(out.meta.asOfBlock).toBe(43_900_002n);
  });

  it('reports null asOfBlock when _meta.block is absent', async () => {
    const out = await readLeaderboard(URL, 10, jsonFetch({ data: { merchants: [], _meta: { hasIndexingErrors: false } } }));
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.meta.asOfBlock).toBeNull();
  });
});
