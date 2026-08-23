/**
 * wiringLatch.dualBundle.test.ts — the bundle-duality regression, offline.
 *
 * The bug this pins (webpack `next dev`, found 2026-07-25): dev bundlers
 * compile `instrumentation.ts` and each route as SEPARATE compilations, so
 * `dynamicAgentWallet.ts` / `payPerCall.ts` exist as TWO live module
 * instances in one Node process. Boot wired copy A's module-scope latch; the
 * pay route read copy B's default throw and answered 503 `not_configured`
 * despite a successful boot wiring. The fix backs every wiring latch with a
 * `Symbol.for`-keyed `globalThis` slot — per-PROCESS state, not per-instance.
 *
 * `vi.resetModules()` + a dynamic re-import IS a second module instance (a
 * fresh module registry over the same globalThis), so these tests reproduce
 * the dual-bundle topology exactly. Each one fails against a module-scope
 * latch and passes against the global one.
 *
 * All collaborators injected/faked — zero network, no real SDK auth.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  setDynamicClientFactory,
  __resetWalletForTests,
  type AgentAccount,
  type DynamicEvmWalletClient,
} from "../dynamicAgentWallet.js";
import { setWrapFetchWithPayment } from "../payPerCall.js";
import { __resetDynamicBootForTests } from "../dynamicBoot.js";
import { __resetMeterForTests } from "../agentMeter.js";

const ADDRESS = "0x00000000000000000000000000000000000000aa" as const;

const ACCOUNT: AgentAccount = {
  accountAddress: ADDRESS,
  publicKeyHex: "04ab",
  walletId: ADDRESS,
};

/** A fully-faked narrow client — auth + wallet ops resolve locally. */
function makeClient(): DynamicEvmWalletClient {
  return {
    authenticateApiToken: vi.fn().mockResolvedValue(undefined),
    createWalletAccount: vi.fn().mockResolvedValue(ACCOUNT),
    getWalletAccount: vi.fn().mockResolvedValue(ACCOUNT),
    signTypedData: vi.fn().mockResolvedValue(("0x" + "11".repeat(65)) as `0x${string}`),
    signMessage: vi.fn().mockResolvedValue(("0x" + "22".repeat(65)) as `0x${string}`),
  };
}

afterEach(() => {
  // The latches are per-process (that is the point) — restore the default
  // throws through the statically-imported copy; the globals are shared.
  setDynamicClientFactory(null);
  setWrapFetchWithPayment(null);
  __resetWalletForTests();
  __resetDynamicBootForTests();
  __resetMeterForTests();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("bundle duality: the wiring survives a second module instance", () => {
  it("a client factory wired in copy A is live in a freshly-imported copy B", async () => {
    const client = makeClient();
    // Copy A (this file's static import) wires the seam — instrumentation's role.
    setDynamicClientFactory(() => client);

    // Copy B: a fresh module registry over the same process — the route's bundle.
    vi.resetModules();
    const copyB = await import("../dynamicAgentWallet.js");

    vi.stubEnv("DYNAMIC_ENVIRONMENT_ID", "env-test");
    vi.stubEnv("DYNAMIC_AUTH_TOKEN", "token-test");

    // Pre-fix this threw ConfigMissing("DYNAMIC_CLIENT_FACTORY") — copy B's
    // module-scope default. Post-fix copy B reads the one per-process latch.
    await expect(copyB.getAgentClient()).resolves.toBe(client);
    expect(client.authenticateApiToken).toHaveBeenCalledTimes(1);
  });

  it("an x402 wrapper wired in copy A pays a call issued from copy B", async () => {
    const client = makeClient();
    setDynamicClientFactory(() => client);
    const paidJson = { ok: true, paid: 1 };
    const paidFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(paidJson), { status: 200 }),
    );
    setWrapFetchWithPayment(() => paidFetch);

    vi.resetModules();
    const copyB = await import("../payPerCall.js");

    vi.stubEnv("DYNAMIC_ENVIRONMENT_ID", "env-test");
    vi.stubEnv("DYNAMIC_AUTH_TOKEN", "token-test");
    vi.stubEnv("WALLET_PASSWORD", "pw-test");
    vi.stubEnv("AGENT_WALLET_ID", ADDRESS);
    vi.stubEnv("AGENT_DAILY_USD_CAP", "1");

    // Pre-fix copy B's module-scope seam threw "x402-fetch not wired".
    await expect(
      copyB.agentPay({ url: "https://paid.example/x", maxValueUsd: 0.001 }),
    ).resolves.toEqual(paidJson);
    expect(paidFetch).toHaveBeenCalledTimes(1);
  });

  it("a duplicate boot from copy B does not clobber an already-wired factory", async () => {
    // Copy A boots for real — the global idempotency flag flips.
    const { wireAgentRuntime } = await import("../dynamicBoot.js");
    expect(wireAgentRuntime()).toEqual({ wired: true });

    // A test (or a later caller) replaces the factory with its own.
    const client = makeClient();
    setDynamicClientFactory(() => client);

    // Copy B re-boots — with a module-scope flag this re-wired the REAL
    // factory over the injected one; the global flag makes it a no-op.
    vi.resetModules();
    const bootB = await import("../dynamicBoot.js");
    expect(bootB.wireAgentRuntime()).toEqual({ wired: true });

    vi.stubEnv("DYNAMIC_ENVIRONMENT_ID", "env-test");
    vi.stubEnv("DYNAMIC_AUTH_TOKEN", "token-test");
    const walletB = await import("../dynamicAgentWallet.js");
    await expect(walletB.getAgentClient()).resolves.toBe(client);
  });
});
