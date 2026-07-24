/**
 * grantConfig.ts — the three-field agent setup brain (pure, server-only-safe, tested).
 *
 * "One setup page, three fields: wallet, cap, allowlist" (FLOWS-SIMPLIFY). This is
 * the load-bearing logic under that: it validates + NORMALIZES the operator's three
 * inputs into the exact `AGENT_*` config the rail reads today, and returns the env
 * lines to set. No network, no money, no on-chain write — the actual spend authority
 * stays where it is (agentMeter's daily cap + the /api/agent/pay SSRF allowlist);
 * this just makes configuring it correct-by-construction.
 *
 * The key value: an allowlist entry is matched by the pay route as
 * `new URL(requestUrl).origin`, so a hand-typed entry like `https://api.x.com/`
 * (trailing slash) or `API.X.com` silently never matches. {@link normalizeAllowlist}
 * canonicalizes every entry through `new URL().origin` and drops the un-parseable
 * ones, so what the operator saves is guaranteed to match what the route checks.
 */

/** The operator's raw three-field input. */
export interface AgentGrantInput {
  /** The agent's MPC wallet id (AGENT_WALLET_ID). */
  readonly walletId?: string
  /** Daily USD spend cap (AGENT_DAILY_USD_CAP). */
  readonly dailyCapUsd?: string | number
  /** Allowed pay endpoints — a comma/newline list or an array (AGENT_URL_ALLOWLIST). */
  readonly allowlist?: string | readonly string[]
}

/** The validated, normalized config + human warnings for the operator. */
export interface AgentGrantConfig {
  readonly walletId: string
  readonly dailyCapUsd: number
  /** Canonical `scheme://host[:port]` origins, deduped — matches the route's check. */
  readonly allowlist: string[]
  /** Entries that couldn't be parsed as a URL origin (dropped, surfaced honestly). */
  readonly rejectedAllowlist: string[]
  /** Plain-English things the operator should know before saving. */
  readonly warnings: string[]
}

/** Split a raw allowlist (string or array) into trimmed, non-empty tokens. */
function tokenize(raw: string | readonly string[] | undefined): string[] {
  if (raw === undefined) return []
  const parts = Array.isArray(raw) ? raw : String(raw).split(/[\n,]/)
  return parts.map((s) => s.trim()).filter((s) => s.length > 0)
}

/**
 * Canonicalize an allowlist to the exact origins the pay route matches on. Each
 * token is run through `new URL().origin`; a bare host ("api.x.com") is retried as
 * `https://api.x.com`. Deduped, order-preserving. Unparseable tokens are rejected.
 */
export function normalizeAllowlist(
  raw: string | readonly string[] | undefined,
): { origins: string[]; rejected: string[] } {
  const seen = new Set<string>()
  const origins: string[] = []
  const rejected: string[] = []
  for (const token of tokenize(raw)) {
    const origin = toOrigin(token)
    if (!origin) {
      rejected.push(token)
      continue
    }
    if (!seen.has(origin)) {
      seen.add(origin)
      origins.push(origin)
    }
  }
  return { origins, rejected }
}

/** A single token → its canonical origin, or null if it isn't a usable URL/host. */
function toOrigin(token: string): string | null {
  const tryParse = (s: string): string | null => {
    try {
      const o = new URL(s).origin
      return o && o !== 'null' ? o : null
    } catch {
      return null
    }
  }
  // A full URL with a scheme parses directly (path/query/trailing slash all collapse to origin).
  const direct = tryParse(token)
  if (direct) return direct
  // A bare host[:port][/path] → assume https, but require a DOTTED host (or localhost) so a
  // single-label typo like "junk" is rejected, not silently accepted as a hostname.
  const https = tryParse(`https://${token}`)
  if (https) {
    const host = new URL(https).hostname
    if (host.includes('.') || host === 'localhost') return https
  }
  return null
}

/** Parse a USD cap: a finite, non-negative number, or null when unset/invalid. */
export function parseCapUsd(raw: string | number | undefined): number | null {
  if (raw === undefined || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Validate + normalize the three fields into the rail's config, with warnings.
 * Never throws — a missing/invalid field becomes a safe default + a warning, so
 * the setup surface can always render an honest state.
 */
export function buildAgentGrantConfig(input: AgentGrantInput): AgentGrantConfig {
  const warnings: string[] = []

  const walletId = (input.walletId ?? '').trim()
  if (!walletId) warnings.push('No agent wallet set — the agent can’t sign until AGENT_WALLET_ID is configured.')

  const cap = parseCapUsd(input.dailyCapUsd)
  const dailyCapUsd = cap ?? 0
  if (cap === null && input.dailyCapUsd !== undefined && input.dailyCapUsd !== '') {
    warnings.push('Daily cap wasn’t a valid number — defaulting to 0 (all agent spend blocked).')
  }
  if (dailyCapUsd === 0) warnings.push('Daily cap is 0 — every agent payment is blocked until you raise it.')

  const { origins: allowlist, rejected: rejectedAllowlist } = normalizeAllowlist(input.allowlist)
  if (allowlist.length === 0) warnings.push('Allowlist is empty — the agent may pay no endpoints (deny-all).')
  if (rejectedAllowlist.length > 0) {
    warnings.push(`${rejectedAllowlist.length} allowlist entr${rejectedAllowlist.length === 1 ? 'y was' : 'ies were'} not a valid URL and were dropped.`)
  }

  return { walletId, dailyCapUsd, allowlist, rejectedAllowlist, warnings }
}

/**
 * The exact server-only env lines for this config (operator copy-paste). Values
 * are the NORMALIZED ones, so what they paste is what the rail matches. Never emit
 * a private key here — the wallet id is an opaque reference, not a secret.
 */
export function toEnvLines(config: AgentGrantConfig): string {
  return [
    `AGENT_WALLET_ID=${config.walletId}`,
    `AGENT_DAILY_USD_CAP=${config.dailyCapUsd}`,
    `AGENT_URL_ALLOWLIST=${config.allowlist.join(',')}`,
  ].join('\n')
}
