/**
 * privatePayConfig — the env seam for the PRIVATE settlement rail (one place).
 *
 * Mirrors how the World ID env lives in `lib/worldid/config.ts`, the fiat on-ramp in
 * `lib/onramp/config.ts`, and the rest of `lib/unlink/*`: one file reads the on/off
 * flags + per-chain config so a wiring change touches this file only. Nothing here is
 * hardcoded to a single chain (doctrine guardrail #5 / secrets law) — every value comes
 * from env, read at CALL time so booth wiring takes effect with no re-import.
 *
 * PER-CHAIN, NOT ARC-LOCKED (mirrors lib/onramp/config.ts's env-gated pattern): the
 * shielded USDC token resolves from `NEXT_PUBLIC_UNLINK_USDC_<chainId>` for the chain
 * named by `NEXT_PUBLIC_UNLINK_CHAIN_ID`. Arc Testnet stays the DOCUMENTED DEFAULT —
 * `NEXT_PUBLIC_UNLINK_CHAIN_ID` defaults to {@link ARC_TESTNET_ID}, and the long-standing
 * `ARC_TESTNET_USDC` is still honoured as the Arc token fallback so existing Arc booth
 * wiring keeps working unchanged. Pointing the rail at another chain is an ENV change,
 * never a code change.
 *
 * TWO WAYS TO TURN IT ON (both gate the SAME shielded path):
 *  - `UNLINK_PRIVATE_PAY=true` — the agent-side private-AGENT-PAYMENT rail (server flag).
 *  - `NEXT_PUBLIC_EARNINGS_PRIVACY=true` — the MERCHANT-facing "shield my payout from
 *    competitors" knob (the scaffold's documented earnings-privacy switch). It is OFF by
 *    default; when on, a merchant payout is routed through the SAME Unlink shield+withdraw
 *    settlement instead of a plain public transfer.
 *
 * HONESTY / FAIL-SOFT (law #4): the private rail is an ALTERNATE to the default public
 * path, never a replacement. It is OFF unless a flag is on AND the Unlink env
 * (`UNLINK_API_KEY` + the resolved per-chain USDC token) is present. When every flag is
 * off or the config is incomplete, the seam reports `flag_off` / `not_configured` and the
 * route falls back to the unchanged public path — it NEVER throws and NEVER invents an
 * address or a name.
 *
 * The privacy claim stays the honest one from `privateWithdraw.ts`: this breaks the EDGE
 * between the funding wallet and the fresh payee EOA (edge-unlinkability on a thin
 * testnet), it is NOT a mixer and not "anonymous"/"untraceable" (law #4). The actual
 * shield+withdraw SETTLEMENT runs through the booth-installed `@unlink-xyz/sdk`
 * (`shieldAndWithdraw` in `privateWithdraw.ts`); when that SDK is absent the path fails
 * soft to the public rail rather than claiming a shield that did not happen.
 */

import { ARC_TESTNET_ID } from "../chains.js";

/** Server-only env flag gating the agent-side private-payment rail. */
const PRIVATE_PAY_FLAG = "UNLINK_PRIVATE_PAY" as const;

/** Merchant-facing env knob gating earnings-privacy (the scaffold's documented switch). */
const EARNINGS_PRIVACY_FLAG = "NEXT_PUBLIC_EARNINGS_PRIVACY" as const;

/**
 * The chain the Unlink shielded set settles on. Resolves from
 * `NEXT_PUBLIC_UNLINK_CHAIN_ID` at call time, defaulting to Arc Testnet
 * ({@link ARC_TESTNET_ID}) — the app's configured default chain. A blank or non-numeric value
 * falls back to the Arc default rather than guessing a chain for a money flow (law #4).
 *
 * @returns the EVM chain id the Unlink rail uses (Arc Testnet when unset).
 */
export function unlinkChainId(): number {
  const raw = (process.env.NEXT_PUBLIC_UNLINK_CHAIN_ID ?? "").trim();
  const n = Number(raw);
  return raw.length > 0 && Number.isFinite(n) && n > 0 ? n : ARC_TESTNET_ID;
}

/**
 * The shielded USDC token address for the active Unlink chain. Resolves PER CHAIN from
 * `NEXT_PUBLIC_UNLINK_USDC_<chainId>` (mirrors the on-ramp / `lib/chains.ts` per-chain
 * env pattern). For the Arc default chain it falls back to the long-standing
 * `ARC_TESTNET_USDC` so existing Arc booth wiring keeps working unchanged. Blank ⇒ the
 * rail is not configured for that chain (never an invented address — law #4).
 *
 * Read at call time, trimmed. Returns `""` when unset so the caller surfaces a clean
 * config error before any SDK call.
 *
 * SERVER-ONLY: the per-chain key is COMPUTED (`NEXT_PUBLIC_UNLINK_USDC_${chainId}`),
 * which Next.js does NOT inline into the client bundle. This is fine because the whole
 * private-settlement seam runs server-side only (it also reads the `UNLINK_API_KEY`
 * secret); `process.env` is fully populated there at runtime.
 *
 * @returns the configured USDC token, or `""` when unset for the active chain.
 */
export function unlinkUsdcToken(): string {
  const chainId = unlinkChainId();
  const perChain = (process.env[`NEXT_PUBLIC_UNLINK_USDC_${chainId}`] ?? "").trim();
  if (perChain.length > 0) {
    return perChain;
  }
  // Arc default fallback: honour the original ARC_TESTNET_USDC so Arc wiring is unbroken.
  if (chainId === ARC_TESTNET_ID) {
    return (process.env.ARC_TESTNET_USDC ?? "").trim();
  }
  return "";
}

/**
 * Is the agent-side private-pay FLAG explicitly turned on? Reads `UNLINK_PRIVATE_PAY` at
 * call time; only the literal string `"true"` (case-insensitive, trimmed) enables it, so a
 * blank or any other value keeps the rail OFF (fail-soft default).
 *
 * @returns true when `UNLINK_PRIVATE_PAY` is the string "true".
 */
export function isPrivatePayFlagOn(): boolean {
  return (process.env[PRIVATE_PAY_FLAG] ?? "").trim().toLowerCase() === "true";
}

/**
 * Is the MERCHANT earnings-privacy knob explicitly turned on? Reads
 * `NEXT_PUBLIC_EARNINGS_PRIVACY` at call time; only the literal string `"true"`
 * (case-insensitive, trimmed) enables it. OFF by default — vanilla settlements stay
 * public + verifiable (law #4: never shield silently).
 *
 * @returns true when `NEXT_PUBLIC_EARNINGS_PRIVACY` is the string "true".
 */
export function isEarningsPrivacyFlagOn(): boolean {
  return (process.env[EARNINGS_PRIVACY_FLAG] ?? "").trim().toLowerCase() === "true";
}

/**
 * Is EITHER privacy switch on? The agent rail (`UNLINK_PRIVATE_PAY`) and the merchant
 * earnings-privacy knob (`NEXT_PUBLIC_EARNINGS_PRIVACY`) both route through the SAME
 * Unlink shield+withdraw settlement, so the gate treats either-on as "attempt the private
 * path". Off when both are off (the vanilla public path).
 *
 * @returns true when at least one privacy flag is on.
 */
export function isPrivacyFlagOn(): boolean {
  return isPrivatePayFlagOn() || isEarningsPrivacyFlagOn();
}

/**
 * Is the private rail fully configured enough to attempt a shielded payment? Requires a
 * privacy flag ON plus the two server-side Unlink values the shield/withdraw legs need
 * (`UNLINK_API_KEY` for registration, and the resolved per-chain USDC token for the
 * shielded asset). The private merchant key (`UNLINK_PAYOUT_PRIVATE_KEY`) is checked at
 * wiring time by the route, not here, so a missing key surfaces as a clean recoverable
 * error rather than a silent off-state.
 *
 * Server-only: never call from the browser (these are server secrets). The browser never
 * sees this — the rail is selected on the server route only.
 *
 * @returns true when a flag is on AND `UNLINK_API_KEY` + the per-chain USDC token are set.
 */
export function isPrivatePayConfigured(): boolean {
  if (!isPrivacyFlagOn()) {
    return false;
  }
  const apiKey = (process.env.UNLINK_API_KEY ?? "").trim();
  const usdc = unlinkUsdcToken();
  return apiKey.length > 0 && usdc.length > 0;
}

/**
 * A clear, non-throwing status for the private rail. The route uses this to decide
 * whether to take the private path or fall back to the public path — and to tell the
 * caller exactly WHY the rail is off, without ever leaking a secret value.
 *
 * - `"on"`            — a flag on and Unlink env present; attempt the shielded payment.
 * - `"flag_off"`      — neither `UNLINK_PRIVATE_PAY` nor `NEXT_PUBLIC_EARNINGS_PRIVACY`
 *                       is "true"; use the public path.
 * - `"not_configured"`— a flag on but `UNLINK_API_KEY` / the per-chain USDC token missing.
 */
export type PrivatePayStatus = "on" | "flag_off" | "not_configured";

/**
 * Resolve the private rail's status WITHOUT throwing (fail-soft, law #4). Names the
 * missing config by category, never echoes a value.
 *
 * @returns the {@link PrivatePayStatus} for the current env.
 */
export function privatePayStatus(): PrivatePayStatus {
  if (!isPrivacyFlagOn()) {
    return "flag_off";
  }
  return isPrivatePayConfigured() ? "on" : "not_configured";
}
