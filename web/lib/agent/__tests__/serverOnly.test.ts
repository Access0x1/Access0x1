/**
 * @file serverOnly.test.ts — the import-time browser guard throws in a client context.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

describe("server-only import guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("assertServerOnly throws when a window global is present", async () => {
    const { assertServerOnly } = await import("../serverOnly.js");
    vi.stubGlobal("window", {});
    expect(() => assertServerOnly("agentMeter")).toThrow(/server-only/);
  });

  it("re-importing agentMeter in a simulated browser context throws", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {});
    await expect(import("../agentMeter.js")).rejects.toThrow(/server-only/);
  });

  it("does not throw in a normal server (no window) context", async () => {
    vi.unstubAllGlobals();
    const { assertServerOnly } = await import("../serverOnly.js");
    expect(() => assertServerOnly("agentMeter")).not.toThrow();
  });
});
