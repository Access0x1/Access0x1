/**
 * mvp-presentation.mts — the judge artifact: a 1 tx/sec round-robin x402 MVP presentation loop.
 *
 * Usage:  npx tsx web/scripts/mvp-presentation.mts [--limit N]
 *
 * Fires many sub-cent authorizations across the priced endpoints so Circle
 * accumulates them into ONE on-chain batch settlement tx visible on Arcscan
 * (the track's literal bar — provably NOT one big transfer).
 *
 * The buyer is BUYER_PRIVATE_KEY from web/.env.local (persistent, fund once) or a
 * fresh ephemeral EOA when unset. The pay
 * loop core (`runDemoLoop`) is exported and gateway-injectable so the integration
 * smoke test can drive it against a mock without touching the Arc testnet.
 */
import { loadLocalEnv } from "./load-local-env.mts";
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

/** Result of a MVP presentation loop run, for tests + the on-stage summary. */
export type DemoLoopResult = {
  calls: number;
  totalSpent: number;
};

/** Options controlling a MVP presentation loop run. */
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
 * Run the round-robin x402 MVP presentation loop against a gateway.
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
    throw new Error("mvp-presentation: no priced calls to fire.");
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
    `mvp-presentation done: ${count} calls, total ${totalSpent.toFixed(6)} USDC`,
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

/** CLI entrypoint: buyer wallet (env key or ephemeral) → deposit → round-robin loop. */
async function main(): Promise<void> {
  loadLocalEnv();
  const { GatewayClient } = await import("@circle-fin/x402-batching/client");

  const baseUrl = process.env.LOOP_BASE_URL ?? "http://localhost:3000";
  const depositAmount = process.env.LOOP_DEPOSIT ?? "5.00";
  const limit = parseLimit(process.argv);

  // The buyer wallet. BUYER_PRIVATE_KEY (the same key fund-gateway.mts uses) when
  // set — a PERSISTENT testnet EOA you fund once and reuse across runs. Only when
  // it is blank do we fall back to a fresh ephemeral EOA, and we say so loudly:
  // an ephemeral key evaporates at exit, so funding its printed address and
  // re-running strands the USDC on an address whose key no longer exists.
  const envKey = (process.env.BUYER_PRIVATE_KEY ?? "").trim();
  const privateKey = (envKey || generatePrivateKey()) as `0x${string}`;
  const account = privateKeyToAccount(privateKey);
  if (envKey) {
    console.log(`Buyer EOA (BUYER_PRIVATE_KEY): ${account.address}`);
  } else {
    console.log(`Ephemeral buyer EOA (this run only): ${account.address}`);
    console.log(
      "⚠ No BUYER_PRIVATE_KEY set — this key is DISCARDED at exit. Do NOT fund this",
    );
    console.log(
      "  address for later; set BUYER_PRIVATE_KEY in web/.env.local (a testnet key",
    );
    console.log(
      "  you generate, e.g. `cast wallet new`), fund THAT once, and re-run.",
    );
  }

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
    console.log("\nStopping MVP presentation loop…");
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
  /mvp-presentation\.mts$/.test(process.argv[1]);

if (invokedDirectly) {
  main().catch((err) => {
    console.error("mvp-presentation failed:", err);
    process.exitCode = 1;
  });
}
