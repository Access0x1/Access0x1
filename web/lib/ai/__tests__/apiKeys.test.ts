/**
 * @file apiKeys.test.ts — the API-key registry.
 *
 * Pins: a registered key resolves to its binding; a wrong/short/unknown key
 * resolves to null; the plaintext key is never stored (only its hash); a too-short
 * key is rejected at registration.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  registerKey,
  resolveKey,
  KEY_PREFIX,
  __resetApiKeysForTests,
  type KeyBinding,
} from "../apiKeys.js";
import type { SessionId } from "../sessionMeter.js";

const SID = "0x3333333333333333333333333333333333333333333333333333333333333333" as SessionId;
const KEY = "ak_live_demo_0123456789abcdef";
const BINDING: KeyBinding = { sessionId: SID, pricePerCallAtomic: 1000n, label: "demo" };

beforeEach(() => {
  __resetApiKeysForTests();
});

describe("registerKey / resolveKey", () => {
  it("resolves a registered key to its binding", () => {
    registerKey(KEY, BINDING);
    expect(resolveKey(KEY)).toEqual(BINDING);
  });

  it("returns null for an unknown key", () => {
    registerKey(KEY, BINDING);
    expect(resolveKey("ak_unknown_key_000000000")).toBeNull();
  });

  it("returns null for a key that is too short to be a credential", () => {
    expect(resolveKey("short")).toBeNull();
  });

  it("rejects registering a key that is too short", () => {
    expect(() => registerKey("tiny", BINDING)).toThrow(RangeError);
  });

  it("does not confuse two distinct keys", () => {
    const KEY2 = "ak_live_other_fedcba9876543210";
    const B2: KeyBinding = { sessionId: SID, pricePerCallAtomic: 5000n, label: "other" };
    registerKey(KEY, BINDING);
    registerKey(KEY2, B2);
    expect(resolveKey(KEY)).toEqual(BINDING);
    expect(resolveKey(KEY2)).toEqual(B2);
  });

  it("never stores the plaintext key (registry holds only the hash)", () => {
    registerKey(KEY, BINDING);
    const g = globalThis as unknown as Record<string, Map<string, unknown> | undefined>;
    const store = g["__ax1_ai_api_keys__"];
    const serialized = JSON.stringify(Array.from(store!.values()), (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(serialized).not.toContain(KEY);
    expect(serialized).toContain("hashHex");
  });

  it("exposes the visible non-secret key prefix", () => {
    expect(KEY_PREFIX).toBe("ak_");
  });
});
