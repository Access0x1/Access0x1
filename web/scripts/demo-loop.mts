/**
 * demo-loop.mts — the judge artifact: a 1 tx/sec round-robin x402 pay loop.
 *
 * Usage:  npx tsx web/scripts/demo-loop.mts [--limit N]
 *
 * Fires many sub-cent authorizations across the priced endpoints so Circle
 * accumulates them into ONE on-chain batch settlement tx visible on Arcscan
 * (the track's literal bar — provably NOT one big transfer).
 *
 * The buyer is a FRESH ephemeral EOA per run (unlinkability hygiene). The pay
 * loop core (`runDemoLoop`) is exported and gateway-injectable so the integration
 * smoke test can drive it against a mock without touching the Arc testnet.
 */
import {
  generatePrivateKey,
  privateKeyToAccount,
} from "viem/accounts";

import { ARC_TESTNET_GATEWAY_CHAIN } from "../lib/arc-constants.js";

/** A priced endpoint to exercise in the round-robin. */
export type PricedCall = {
  url: string;
  method: "GET" | "POST";
  body?: unknown;
};

/** The pay surface this loop needs (the real GatewayClient satisfies it). */
export type PayGateway = {
  pay: (
    url: string,
    options?: { method?: "GET" | "POST"; body?: unknown },
  ) => Promise<{ formattedAmount: string }>;
  getBalances?: () => Promise<{ gateway: { formattedAvailable: string } }>;
  deposit?: (amount: string) => Promise<unknown>;
};

/** Result of a demo loop run, for tests + the on-stage summary. */
export type DemoLoopResult = {
  calls: number;
  totalSpent: number;
};

/** Options controlling a demo loop run. */
export type DemoLoopOptions = {
  /** The priced calls to round-robin through. */
  calls: PricedCall[];
  /** Stop after this many pays (default: undefined → run until aborted). */
  limit?: number;
  /** Delay between pays in ms (default 1000 = 1 tx/sec). */
  intervalMs?: number;
  /** Re-deposit below this available balance, in USDC (default 0.5). */
  redepositThreshold?: number;
  /** Decimal USDC to re-deposit when below threshold (default "1.00"). */
  redepositAmount?: string;
  /** Abort signal to stop an unbounded loop (Ctrl-C wiring). */
  signal?: AbortSignal;
  /** Sleep implementation (overridable in tests to avoid real timers). */
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_REDEPOSIT_THRESHOLD = 0.5;
const DEFAULT_REDEPOSIT_AMOUNT = "1.00";

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the round-robin x402 pay loop against a gateway.
 *
 * On each tick it pays the next priced call, accumulates `totalSpent`, and (when
 * the gateway exposes balance + deposit) auto-redeposits below the threshold.
 *
 * @param gateway - the pay surface (real GatewayClient or a mock)
 * @param opts - the calls, limit, interval, and redeposit policy
 * @returns the number of calls made and the total USDC spent
 */
export async function runDemoLoop(
  gateway: PayGateway,
  opts: DemoLoopOptions,
): Promise<DemoLoopResult> {
  const {
    calls,
    limit,
    intervalMs = DEFAULT_INTERVAL_MS,
    redepositThreshold = DEFAULT_REDEPOSIT_THRESHOLD,
    redepositAmount = DEFAULT_REDEPOSIT_AMOUNT,
    signal,
    sleep = realSleep,
  } = opts;

  if (calls.length === 0) {
    throw new Error("demo-loop: no priced calls to fire.");
  }

  let count = 0;
  let totalSpent = 0;

  while (limit === undefined || count < limit) {
    if (signal?.aborted) break;

    // Auto-redeposit below threshold (best-effort; never blocks a pay).
    if (gateway.getBalances && gateway.deposit) {
      try {
        const balances = await gateway.getBalances();
        const available = Number(balances.gateway.formattedAvailable);
        if (Number.isFinite(available) && available < redepositThreshold) {
          await gateway.deposit(redepositAmount);
        }
      } catch {
        // Redeposit is opportunistic — a failure here never stops the loop.
      }
    }

    const call = calls[count % calls.length];
    const started = Date.now();
    const result = await gateway.pay(call.url, {
      method: call.method,
      body: call.body,
    });
    const elapsed = Date.now() - started;
    const spent = Number(result.formattedAmount);
    if (Number.isFinite(spent)) totalSpent += spent;
    count += 1;

    console.log(
      `#${count} ${call.method} ${call.url} -> ${result.formattedAmount} USDC (${elapsed}ms)`,
    );

    if (limit !== undefined && count >= limit) break;
    if (signal?.aborted) break;
    await sleep(intervalMs);
  }

  console.log(
    `demo-loop done: ${count} calls, total ${totalSpent.toFixed(6)} USDC`,
  );
  return { calls: count, totalSpent };
}

/** Build the round-robin call list against a base URL. */
export function defaultCalls(baseUrl: string): PricedCall[] {
  return [
    { url: `${baseUrl}/api/premium/quote`, method: "GET" },
    { url: `${baseUrl}/api/premium/dataset`, method: "GET" },
    {
      url: `${baseUrl}/api/premium/compute`,
      method: "POST",
      body: { input: "access0x1" },
    },
  ];
}

/** Parse `--limit N` from argv. */
function parseLimit(argv: string[]): number | undefined {
  const i = argv.indexOf("--limit");
  if (i >= 0 && argv[i + 1]) {
    const n = Number(argv[i + 1]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
}

/** CLI entrypoint: ephemeral buyer wallet → deposit → round-robin pay loop. */
async function main(): Promise<void> {
  const { GatewayClient } = await import("@circle-fin/x402-batching/client");

  const baseUrl = process.env.DEMO_BASE_URL ?? "http://localhost:3000";
  const depositAmount = process.env.DEMO_DEPOSIT ?? "5.00";
  const limit = parseLimit(process.argv);

  // Fresh ephemeral EOA per run (unlinkability hygiene; the Gateway payer is a
  // plain EOA, never an Unlink execution account).
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  console.log(`Ephemeral buyer EOA: ${account.address}`);
  console.log(
    "Fund this address with Arc Testnet USDC (native gas + ERC-20) before depositing.",
  );

  const gateway = new GatewayClient({
    chain: ARC_TESTNET_GATEWAY_CHAIN,
    privateKey,
    rpcUrl: process.env.ARC_TESTNET_RPC_URL,
  });

  console.log(`Depositing ${depositAmount} USDC into Gateway…`);
  await gateway.deposit(depositAmount);
  const balances = await gateway.getBalances();
  console.log(`Gateway available: ${balances.gateway.formattedAvailable} USDC`);

  const controller = new AbortController();
  process.on("SIGINT", () => {
    console.log("\nStopping demo loop…");
    controller.abort();
  });

  await runDemoLoop(gateway, {
    calls: defaultCalls(baseUrl),
    limit,
    signal: controller.signal,
  });
}

// Run only when invoked directly (not when imported by tests).
const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  /demo-loop\.mts$/.test(process.argv[1]);

if (invokedDirectly) {
  main().catch((err) => {
    console.error("demo-loop failed:", err);
    process.exitCode = 1;
  });
}
