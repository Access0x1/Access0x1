/**
 * payoutService — server-side Unlink client + idempotent registration.
 *
 * Unlink requires a userId to be registered (via `createUnlinkAdmin`) before a
 * client can act for it (spec §2e). The Dynamic JWT `sub` is reused as the Unlink
 * `userId` — same identity, no second account. `ensureRegistered` wraps the admin
 * register call idempotently so it is safe to call on every payout.
 *
 * SECRETS: `UNLINK_API_KEY` is read here server-side only. It is NEVER returned to
 * the client and NEVER placed in an error message (law: secrets never leave the box).
 *
 * ⚠️ BOOTH-CONFIRM the admin/client factory names + arg shapes against the live SDK.
 */
import {
  createUnlinkAdmin,
  createUnlinkClient,
  type UnlinkAccount,
  type UnlinkClient,
} from "@unlink-xyz/sdk";

/**
 * Unlink environment string — kebab-case `arc-testnet` (NOT camel `arcTestnet`,
 * which is the Circle Gateway chain id for the SAME chain 5042002 — do not conflate).
 * Read at call time so env wiring at the booth takes effect without a re-import.
 */
function unlinkEnvironment(): "arc-testnet" {
  return (process.env.UNLINK_ENVIRONMENT ?? "arc-testnet") as "arc-testnet";
}

/**
 * Create an Unlink client for a merchant account (server-side with a pre-derived
 * or key-backed account, or browser-side with a seed-backed account).
 *
 * @param account            The merchant's `UnlinkAccount` (from
 *                           `deriveMerchantUnlinkAccount` or `account.fromKeys`).
 * @param userId             The Dynamic JWT `sub`, reused as the Unlink userId.
 * @param authorizationToken Optional Dynamic auth token forwarded to the engine.
 */
export function getMerchantClient(
  account: UnlinkAccount,
  userId: string,
  authorizationToken?: string,
): UnlinkClient {
  if (!userId) {
    throw new Error("getMerchantClient: userId is required");
  }
  return createUnlinkClient({
    environment: unlinkEnvironment(),
    account,
    userId,
    authorizationToken,
  });
}

/**
 * Idempotently register a userId with Unlink. Safe to call before every payout.
 *
 * Asserts: calls `admin.users.register({ userId })` once. If the SDK reports the
 * user is already registered, this swallows ONLY that specific case (the register
 * is a no-op for an existing user — spec §2e). Any other failure re-throws, but the
 * thrown message is sanitized so the secret API key can never leak (law).
 *
 * @param userId  The Dynamic JWT `sub`.
 */
export async function ensureRegistered(userId: string): Promise<void> {
  if (!userId) {
    throw new Error("ensureRegistered: userId is required");
  }
  const apiKey = process.env.UNLINK_API_KEY;
  if (!apiKey) {
    // Do not echo any env contents — just state the missing config by name.
    throw new Error("ensureRegistered: UNLINK_API_KEY is not configured");
  }

  const admin = createUnlinkAdmin({ environment: unlinkEnvironment(), apiKey });
  try {
    await admin.users.register({ userId });
  } catch (err: unknown) {
    if (isAlreadyRegistered(err)) {
      // Idempotent: an already-registered user is the desired end state.
      return;
    }
    // Re-throw a sanitized error — never include the API key or raw SDK payload.
    throw new Error("ensureRegistered: failed to register user with Unlink");
  }
}

/** True when an SDK error indicates the user is already registered (idempotent path). */
function isAlreadyRegistered(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : "";
  return /already.*regist/i.test(message);
}
