import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, type EnvLike } from '../src/config.js';
import { createContext } from '../src/context.js';
import { createServer } from '../src/server.js';
import type { HttpFetch } from '../src/http.js';

const ROUTER = '0xe92244e3368561faf21648146511DeDE3a475EB5';
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

const MANIFEST_TEXT = JSON.stringify({
  namespace: 'access0x1.v1.',
  router: ROUTER,
  chains: [
    {
      id: 84532,
      name: 'Base Sepolia',
      router: ROUTER,
      usdc: USDC,
      nativeUsdFeed: '0x4aDC67696bA383F43DD60A9e78F2C97FbbFc7cb1',
      explorerUrl: 'https://sepolia.basescan.org',
      rpcUrl: 'https://sepolia.base.org',
      verified: true,
    },
    { id: 16602, name: '0G Galileo Testnet', router: '0x60eb647d166b70662e0567551af7e575f13e8008' },
  ],
});

/** A subgraph fetch stub that routes by GraphQL operation name in the body. */
function subgraphStub(): HttpFetch {
  return vi.fn(async (_url: string, init) => {
    const body = String(init?.body ?? '');
    let payload: unknown = { data: {} };
    if (body.includes('MerchantLookup')) {
      payload = {
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
      };
    } else if (body.includes('MerchantPayments')) {
      payload = {
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
      };
    } else if (body.includes('NetworkLeaderboard')) {
      payload = {
        data: {
          merchants: [{ merchantId: '7', owner: null, paymentCount: '20', totalUsd8: '900000000', lastPaymentAt: '1752700000' }],
          _meta: { block: { number: 43_900_002 }, hasIndexingErrors: false },
        },
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  });
}

/** A fetch stub for the agent-pay route that echoes what it received. */
function webStub(): HttpFetch {
  return vi.fn(async (url: string, init) => {
    if (url.endsWith('/api/agent/pay')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, receivedSecret: init?.headers?.['x-internal-secret'] ?? null }),
      };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  });
}

interface Harness {
  client: Client;
  fetchImpl: HttpFetch;
  close(): Promise<void>;
}

/** Build a connected in-memory client/server pair over the given env + fetch. */
async function connect(env: EnvLike, fetchImpl: HttpFetch = subgraphStub()): Promise<Harness> {
  const config = loadConfig(env);
  const ctx = await createContext(config, {
    readFile: async () => MANIFEST_TEXT,
    fetch: fetchImpl,
    now: () => 1_752_800_000_000,
  });
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    fetchImpl,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const BASE_ENV: EnvLike = { ACCESS0X1_MANIFEST_PATH: './m.json' };

/** Read a call result's structuredContent as a record. */
function structured(result: CallToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

let open: Harness | null = null;
afterEach(async () => {
  if (open) {
    await open.close();
    open = null;
  }
});

describe('list_chains', () => {
  it('lists chains from the manifest, sorted by id, with provenance', async () => {
    open = await connect(BASE_ENV);
    const res = (await open.client.callTool({ name: 'list_chains', arguments: {} })) as CallToolResult;
    const s = structured(res);
    expect(s.count).toBe(2);
    const chains = s.chains as Array<{ id: number; router: string }>;
    expect(chains.map((c) => c.id)).toEqual([16602, 84532]);
    expect((s.provenance as { source: string }).source).toBe('manifest');
  });

  it('advertises exactly the eight rail tools', async () => {
    open = await connect(BASE_ENV);
    const { tools } = await open.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'agent_pay_request',
        'chain_facts',
        'checkout_link',
        'list_chains',
        'merchant_lookup',
        'merchant_payments',
        'network_leaderboard',
        'verify_payment',
      ].sort(),
    );
  });
});

describe('chain_facts', () => {
  it('returns the full address set for a known chain', async () => {
    open = await connect(BASE_ENV);
    const res = (await open.client.callTool({ name: 'chain_facts', arguments: { chainId: 84532 } })) as CallToolResult;
    const chain = structured(res).chain as Record<string, unknown>;
    expect(chain.router).toBe(ROUTER);
    expect(chain.usdc).toBe(USDC);
    expect(chain.routerExplorerLink).toBe(`https://sepolia.basescan.org/address/${ROUTER}`);
  });

  it('returns null (never invents) for a fact the manifest omits', async () => {
    open = await connect(BASE_ENV);
    const res = (await open.client.callTool({ name: 'chain_facts', arguments: { chainId: 16602 } })) as CallToolResult;
    const chain = structured(res).chain as Record<string, unknown>;
    expect(chain.usdc).toBeNull();
    expect(chain.routerExplorerLink).toBeNull();
    expect(chain.verified).toBeNull();
  });

  it('errors for an unknown chain id', async () => {
    open = await connect(BASE_ENV);
    const res = (await open.client.callTool({ name: 'chain_facts', arguments: { chainId: 99999999 } })) as CallToolResult;
    expect(res.isError).toBe(true);
  });
});

describe('merchant_lookup', () => {
  it('is dormant when no subgraph is configured', async () => {
    open = await connect(BASE_ENV);
    const res = (await open.client.callTool({ name: 'merchant_lookup', arguments: { merchantId: '49' } })) as CallToolResult;
    expect(structured(res).status).toBe('dormant');
  });

  it('resolves a merchant once the subgraph is configured', async () => {
    open = await connect({ ...BASE_ENV, ACCESS0X1_SUBGRAPH_URL: 'https://sg/q' });
    const res = (await open.client.callTool({ name: 'merchant_lookup', arguments: { merchantId: '49' } })) as CallToolResult;
    const s = structured(res);
    expect(s.found).toBe(true);
    expect((s.merchant as { paymentCount: string }).paymentCount).toBe('7');
    expect((s.provenance as { asOfBlock: string }).asOfBlock).toBe('43900000');
  });

  it('errors when neither selector is given', async () => {
    open = await connect({ ...BASE_ENV, ACCESS0X1_SUBGRAPH_URL: 'https://sg/q' });
    const res = (await open.client.callTool({ name: 'merchant_lookup', arguments: {} })) as CallToolResult;
    expect(res.isError).toBe(true);
  });

  it('reports a configured-but-failed read as an error, not dormant', async () => {
    const failing: HttpFetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => '{}' }));
    open = await connect({ ...BASE_ENV, ACCESS0X1_SUBGRAPH_URL: 'https://sg/q' }, failing);
    const res = (await open.client.callTool({ name: 'merchant_lookup', arguments: { merchantId: '49' } })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(String(structured(res).message)).toContain('read failed');
  });
});

describe('merchant_payments', () => {
  it('is dormant without a subgraph', async () => {
    open = await connect(BASE_ENV);
    const res = (await open.client.callTool({ name: 'merchant_payments', arguments: { merchantId: '49' } })) as CallToolResult;
    expect(structured(res).status).toBe('dormant');
  });

  it('lists payments with serialized bigints and provenance', async () => {
    open = await connect({ ...BASE_ENV, ACCESS0X1_SUBGRAPH_URL: 'https://sg/q' });
    const res = (await open.client.callTool({ name: 'merchant_payments', arguments: { merchantId: '49', limit: 5 } })) as CallToolResult;
    const payments = structured(res).payments as Array<{ usdAmount8: string }>;
    expect(payments[0]!.usdAmount8).toBe('100000000');
  });
});

describe('network_leaderboard', () => {
  it('is dormant without a subgraph', async () => {
    open = await connect(BASE_ENV);
    const res = (await open.client.callTool({ name: 'network_leaderboard', arguments: {} })) as CallToolResult;
    expect(structured(res).status).toBe('dormant');
  });

  it('ranks merchants by indexed volume', async () => {
    open = await connect({ ...BASE_ENV, ACCESS0X1_SUBGRAPH_URL: 'https://sg/q' });
    const res = (await open.client.callTool({ name: 'network_leaderboard', arguments: { limit: 3 } })) as CallToolResult;
    const merchants = structured(res).merchants as Array<{ rank: number; totalUsd8: string }>;
    expect(merchants[0]!.rank).toBe(1);
    expect(merchants[0]!.totalUsd8).toBe('900000000');
  });
});

describe('verify_payment', () => {
  it('is dormant without a subgraph', async () => {
    open = await connect(BASE_ENV);
    const res = (await open.client.callTool({ name: 'verify_payment', arguments: { merchantId: '49' } })) as CallToolResult;
    expect(structured(res).status).toBe('dormant');
  });

  it('verifies a merchant that clears the thresholds on a healthy index', async () => {
    open = await connect({ ...BASE_ENV, ACCESS0X1_SUBGRAPH_URL: 'https://sg/q' });
    const res = (await open.client.callTool({
      name: 'verify_payment',
      arguments: { merchantId: '49', minUsd: 1 },
    })) as CallToolResult;
    const s = structured(res);
    expect(s.verified).toBe(true);
    expect(s.indexingHealthy).toBe(true);
    expect(s.asOfBlock).toBe('43900000');
  });

  it('degrades to not-verified when the configured read fails', async () => {
    const failing: HttpFetch = vi.fn(async () => ({ ok: false, status: 502, text: async () => '{}' }));
    open = await connect({ ...BASE_ENV, ACCESS0X1_SUBGRAPH_URL: 'https://sg/q' }, failing);
    const res = (await open.client.callTool({ name: 'verify_payment', arguments: { merchantId: '49' } })) as CallToolResult;
    const s = structured(res);
    expect(s.verified).toBe(false);
    expect(s.indexingHealthy).toBe(false);
  });
});

describe('checkout_link', () => {
  it('is dormant without a web base URL', async () => {
    open = await connect(BASE_ENV);
    const res = (await open.client.callTool({ name: 'checkout_link', arguments: { merchantId: '49' } })) as CallToolResult;
    expect(structured(res).status).toBe('dormant');
  });

  it('builds the /m/{id} link with amount and chainId', async () => {
    open = await connect({ ...BASE_ENV, ACCESS0X1_WEB_BASE_URL: 'https://pay.example.com' });
    const res = (await open.client.callTool({
      name: 'checkout_link',
      arguments: { merchantId: '49', amountUsd: 1.5, chainId: 84532 },
    })) as CallToolResult;
    const s = structured(res);
    expect(s.url).toBe('https://pay.example.com/m/49?amount=150000000&chainId=84532');
    expect(s.usdAmount8).toBe('150000000');
  });

  it('omits query params when amount and chain are not given', async () => {
    open = await connect({ ...BASE_ENV, ACCESS0X1_WEB_BASE_URL: 'https://pay.example.com' });
    const res = (await open.client.callTool({ name: 'checkout_link', arguments: { merchantId: '49' } })) as CallToolResult;
    expect(structured(res).url).toBe('https://pay.example.com/m/49');
  });
});

describe('agent_pay_request', () => {
  it('is dormant without a web base URL', async () => {
    open = await connect(BASE_ENV, webStub());
    const res = (await open.client.callTool({
      name: 'agent_pay_request',
      arguments: { merchantId: '49', usdAmount: 0.01, resourceUrl: 'https://api.example.com/x402' },
    })) as CallToolResult;
    expect(structured(res).status).toBe('dormant');
  });

  it('POSTs the route and forwards the caller-auth secret without echoing it', async () => {
    open = await connect(
      { ...BASE_ENV, ACCESS0X1_WEB_BASE_URL: 'https://pay.example.com', ACCESS0X1_AGENT_INTERNAL_SECRET: 'topsecret' },
      webStub(),
    );
    const res = (await open.client.callTool({
      name: 'agent_pay_request',
      arguments: { merchantId: '49', usdAmount: 0.01, resourceUrl: 'https://api.example.com/x402' },
    })) as CallToolResult;
    const s = structured(res);
    expect(s.accepted).toBe(true);
    expect(s.httpStatus).toBe(200);
    // The route received the secret header...
    expect((s.response as { receivedSecret: string }).receivedSecret).toBe('topsecret');
    // ...but the tool result never re-echoes the secret value anywhere else.
    expect(JSON.stringify(s.request)).not.toContain('topsecret');
    expect((s.provenance as { source: string }).source).toBe('web');
  });

  it('reports a failure when the route is unreachable', async () => {
    const throwing: HttpFetch = vi.fn(async () => {
      throw new Error('connection refused');
    });
    open = await connect({ ...BASE_ENV, ACCESS0X1_WEB_BASE_URL: 'https://pay.example.com' }, throwing);
    const res = (await open.client.callTool({
      name: 'agent_pay_request',
      arguments: { merchantId: '49', usdAmount: 0.01, resourceUrl: 'https://api.example.com/x402' },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
  });
});
