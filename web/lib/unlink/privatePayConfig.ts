/**
 * privatePayConfig — the env seam for the PRIVATE agent-payment rail (one place).
 *
 * Mirrors how the World ID env lives in `lib/worldid/config.ts` and Unlink in the
 * rest of `lib/unlink/*`: one file reads the on/off flag so a wiring change touches
 * this file only. Nothing here is hardcoded (doctrine guardrail #5 / secrets law) —
 * every value comes from env, read at CALL time so booth wiring takes effect with no
 * re-import.
 *
 * HONESTY / FAIL-SOFT (law #4): the private rail is an ALTERNATE to the default
 * public x402 path, never a replacement. It is OFF unless `UNLINK_PRIVATE_PAY=true`
 * AND the existing Unlink env (`UNLINK_API_KEY` + `ARC_TESTNET_USDC`) is present.
 * When the flag is off or the config is incomplete, the seam reports `not configured`
 * and the route falls back to the unchanged public path — it NEVER throws and NEVER
 * invents an address or a name.
 *
 * The privacy claim stays the honest one from `privateWithdraw.ts`: this breaks the
 * EDGE between the agent's funding wallet and the fresh payer EOA (edge-unlinkability
 * on a thin testnet), it is NOT a mixer and not "anonymous"/"untraceable" (law #4).
 */

/** Server-only env flag gating the private agent-payment rail. */
const PRIVATE_PAY_FLAG = "UNLINK_PRIVATE_PAY" as const;

/**
 * Is the private-pay FLAG explicitly turned on? Reads `UNLINK_PRIVATE_PAY` at call
 * time; only the literal string `"true"` (case-insensitive, trimmed) enables it, so a
 * blank or any other value keeps the rail OFF (fail-soft default).
 *
 * @returns true when `UNLINK_PRIVATE_PAY` is the string "true".
 */
export function isPrivatePayFlagOn(): boolean {
  return (process.env[PRIVATE_PAY_FLAG] ?? "").trim().toLowerCase() === "true";
}

/**
 * Is the private rail fully configured enough to attempt a shielded payment? Requires
 * the flag ON plus the two existing server-side Unlink values the shield/withdraw legs
 * need (`UNLINK_API_KEY` for registration, `ARC_TESTNET_USDC` for the token). The
 * private merchant key (`UNLINK_PAYOUT_PRIVATE_KEY`) is checked at wiring time by the
 * route, not here, so a missing key surfaces as a clean recoverable error rather than a
 * silent off-state.
 *
 * Server-only: never call from the browser (these are server secrets). The browser
 * never sees this — the rail is selected on the server route only.
 *
 * @returns true when the flag is on AND `UNLINK_API_KEY` + `ARC_TESTNET_USDC` are set.
 */
export function isPrivatePayConfigured(): boolean {
  if (!isPrivatePayFlagOn()) {
    return false;
  }
  const apiKey = (process.env.UNLINK_API_KEY ?? "").trim();
  const usdc = (process.env.ARC_TESTNET_USDC ?? "").trim();
  return apiKey.length > 0 && usdc.length > 0;
}

/**
 * A clear, non-throwing status for the private rail. The route uses this to decide
 * whether to take the private path or fall back to the public x402 path — and to tell
 * the caller exactly WHY the rail is off, without ever leaking a secret value.
 *
 * - `"on"`            — flag on and Unlink env present; attempt the shielded payment.
 * - `"flag_off"`      — `UNLINK_PRIVATE_PAY` is not "true"; use the public path.
 * - `"not_configured"`— flag on but `UNLINK_API_KEY`/`ARC_TESTNET_USDC` missing.
 */
export type PrivatePayStatus = "on" | "flag_off" | "not_configured";

/**
 * Resolve the private rail's status WITHOUT throwing (fail-soft, law #4). Names the
 * missing config by category, never echoes a value.
 *
 * @returns the {@link PrivatePayStatus} for the current env.
 */
export function privatePayStatus(): PrivatePayStatus {
  if (!isPrivatePayFlagOn()) {
    return "flag_off";
  }
  return isPrivatePayConfigured() ? "on" : "not_configured";
}
