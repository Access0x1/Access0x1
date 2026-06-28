/**
 * @file apiKeys.ts — the API-key registry for "connect an AI API". This is the
 * developer-facing front door: an AI agent (or an MCP client) connects with one
 * API key, and that key resolves to a budget-capped {@link SessionId} on the
 * SessionGrant rail plus the per-call price for the metered endpoint.
 *
 * THE SHAPE. "Connecting an AI API" = being issued an API key that is bound to a
 * SessionGrant session. Each request the agent makes presents the key; the gateway
 * looks the key up here, finds the bound session id + per-call price, reserves the
 * price against the session budget (`lib/ai/sessionMeter.ts`, the off-chain mirror
 * of `SessionGrant.remaining`/`spend`), then settles the payment via x402
 * (`lib/x402.ts`). One key, one budget ceiling, pay-per-use.
 *
 * SECURITY (doctrine guardrail #7 / law #4):
 *  - The plaintext key is NEVER stored. We store a SHA-256 hash and compare
 *    constant-time, so a registry dump cannot reveal a usable key.
 *  - Lookup is by hash and uses {@link timingSafeEqual} on the hash bytes, so a
 *    wrong key cannot be recovered byte-by-byte via response timing.
 *  - The key prefix (`ak_…`) is a non-secret label kept for display/audit only;
 *    it is never sufficient to authenticate.
 *
 * PERSISTENCE: an in-process map pinned on `globalThis` (same pattern as the OIDC
 * subject store + the session meter). The `issueKey` / `resolveKey` interface is
 * the SEAM a durable KV/Postgres `api_keys` table swaps behind later — a real
 * deployment would issue keys out of band and load them here at boot; this module
 * never invents a key it did not register.
 *
 * Server-only by construction: it reads no browser-visible state and the hash is
 * computed with `node:crypto`.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { SessionId } from "./sessionMeter.js";

/** What an API key resolves to: the SessionGrant session it spends on + the price. */
export interface KeyBinding {
  /** The SessionGrant session id this key's spend is metered against. */
  readonly sessionId: SessionId;
  /** Per-call price in atomic USDC (6-decimal), e.g. `1000n` for $0.001. */
  readonly pricePerCallAtomic: bigint;
  /** A non-secret label for dashboards/audit (e.g. "claude-haiku demo"). */
  readonly label: string;
}

/** The stored form of a key: its hash + binding. The plaintext is never kept. */
interface StoredKey {
  /** SHA-256 of the plaintext key (hex). */
  readonly hashHex: string;
  readonly binding: KeyBinding;
}

/** Pinned registry: key prefix → stored key. The prefix is a non-secret index. */
const GLOBAL_KEY = "__ax1_ai_api_keys__";

function registry(): Map<string, StoredKey> {
  const g = globalThis as unknown as Record<string, Map<string, StoredKey> | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map<string, StoredKey>();
  return g[GLOBAL_KEY] as Map<string, StoredKey>;
}

/** The visible, non-secret prefix every Access0x1 AI key carries. */
export const KEY_PREFIX = "ak_";

/** SHA-256 hex of a string — the only form of a key we persist. */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The non-secret index for a key: its prefix plus the first 8 hash chars. Enough
 * to index distinct keys without storing anything that authenticates. Plaintext
 * keys that are too short to index are rejected at issue time.
 */
function indexOf(plaintextKey: string): string {
  return `${KEY_PREFIX}${sha256Hex(plaintextKey).slice(0, 8)}`;
}

/** Constant-time hex compare (length-checked first). */
function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * Register an API key and the SessionGrant binding it authenticates. The caller
 * supplies the plaintext key it will hand to the developer (generated out of band
 * — e.g. `ak_` + random bytes); we store only its hash.
 *
 * @param plaintextKey The full plaintext API key (kept by the caller, never logged).
 * @param binding      The SessionGrant session + per-call price this key spends on.
 * @throws {RangeError} if the key is too short to be a credential (< 16 chars).
 */
export function registerKey(plaintextKey: string, binding: KeyBinding): void {
  if (plaintextKey.length < 16) {
    throw new RangeError("registerKey: key must be at least 16 characters");
  }
  registry().set(indexOf(plaintextKey), { hashHex: sha256Hex(plaintextKey), binding });
}

/**
 * Resolve a presented API key to its SessionGrant binding, or `null` if unknown.
 * Constant-time on the hash so a wrong key reveals nothing via timing.
 *
 * @param presentedKey The key from the request (e.g. the `Authorization: Bearer` value).
 * @returns The {@link KeyBinding} for a valid key, or `null` for an unknown/invalid key.
 */
export function resolveKey(presentedKey: string): KeyBinding | null {
  if (typeof presentedKey !== "string" || presentedKey.length < 16) return null;
  const stored = registry().get(indexOf(presentedKey));
  if (!stored) return null;
  if (!hashesEqual(stored.hashHex, sha256Hex(presentedKey))) return null;
  return stored.binding;
}

/** Test-only: wipe the registry. NOT used in production paths. */
export function __resetApiKeysForTests(): void {
  const g = globalThis as unknown as Record<string, Map<string, StoredKey> | undefined>;
  g[GLOBAL_KEY] = new Map<string, StoredKey>();
}
