import { describe, expect, it, vi } from "vitest";

import {
  defaultCalls,
  runDemoLoop,
  type PayGateway,
} from "../../scripts/demo-loop.mts";

const PRICES: Record<string, string> = {
  quote: "0.001",
  dataset: "0.01",
  compute: "0.03",
};

function priceFor(url: string): string {
  if (url.endsWith("/quote")) return PRICES.quote;
  if (url.endsWith("/dataset")) return PRICES.dataset;
  return PRICES.compute;
}

describe("demo-loop integration smoke", () => {
  it("runs 5 iterations: correct URL+method per call, totalSpent accumulates", async () => {
    const seen: Array<{ url: string; method?: string }> = [];
    const gateway: PayGateway = {
      pay: vi.fn(async (url, options) => {
        seen.push({ url, method: options?.method });
        return { formattedAmount: priceFor(url) };
      }),
    };

    const calls = defaultCalls("http://localhost:3000");
    const result = await runDemoLoop(gateway, {
      calls,
      limit: 5,
      sleep: async () => {},
    });

    expect(result.calls).toBe(5);
    // round-robin of 3 over 5 calls: quote, dataset, compute, quote, dataset
    expect(seen.map((s) => s.url)).toEqual([
      "http://localhost:3000/api/premium/quote",
      "http://localhost:3000/api/premium/dataset",
      "http://localhost:3000/api/premium/compute",
      "http://localhost:3000/api/premium/quote",
      "http://localhost:3000/api/premium/dataset",
    ]);
    expect(seen[2].method).toBe("POST");
    expect(seen[0].method).toBe("GET");
    // 0.001 + 0.01 + 0.03 + 0.001 + 0.01 = 0.052
    expect(result.totalSpent).toBeCloseTo(0.052, 6);
  });

  it("auto-redeposits below threshold", async () => {
    const deposit = vi.fn(async () => undefined);
    const gateway: PayGateway = {
      pay: vi.fn(async () => ({ formattedAmount: "0.001" })),
      getBalances: vi.fn(async () => ({
        gateway: { formattedAvailable: "0.10" },
      })),
      deposit,
    };
    await runDemoLoop(gateway, {
      calls: defaultCalls("http://x"),
      limit: 2,
      redepositThreshold: 0.5,
      sleep: async () => {},
    });
    expect(deposit).toHaveBeenCalled();
  });

  it("throws if no calls supplied", async () => {
    const gateway: PayGateway = { pay: vi.fn() };
    await expect(
      runDemoLoop(gateway, { calls: [], limit: 1, sleep: async () => {} }),
    ).rejects.toThrow();
  });
});
