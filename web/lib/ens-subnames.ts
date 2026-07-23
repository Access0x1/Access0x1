/**
 * ens-subnames.ts — the WRITE seam: gasless ENS subnames via Namestone.
 *
 * SEE ALSO — the ENSv2 LIVE twin: this module writes STATIC text records once. Its
 * live counterpart is the ENSv2 Payment Resolver (`web/lib/ens/ensv2.ts` +
 * `src/ens/Access0x1PaymentResolver.sol`), which serves the SAME `click.access0x1.*`
 * schema COMPUTED from the router at query time. {SUBNAME_TEXT_KEYS} below is shared
 * by both so the static and live issuers never drift. See docs/ENSV2-PAYMENT-RESOLVER.md.
 *
 * Issues `<label>.<PARENT>.eth` subnames for merchants and writes their
 * USD-pricing / settlement config into ENS TEXT RECORDS, with ZERO gas and no
 * key handling on our side — Namestone is an offchain ENS issuer (CCIP-Read
 * gateway) that signs the records, so the merchant gets a real, resolvable ENS
 * name without a transaction.
 *
 * GENERIC BY DESIGN (HARD RULE): the PARENT name is NEVER hardcoded. It is read
 * from `process.env.ENS_SUBNAME_PARENT` (a server-only value — "your own ENS
 * name", e.g. `yourbrand.eth`). The API key is `NAMESTONE_API_KEY`. Both are
 * read in exactly ONE place here.
 *
 * FAIL-SOFT LAW (#4): when EITHER `NAMESTONE_API_KEY` or `ENS_SUBNAME_PARENT` is
 * unset, EVERY path is a clean NO-OP that returns `{ ok: false, code:
 * 'not_configured' }` and:
 *   - NEVER throws,
 *   - NEVER invents a name, label, parent, or address,
 *   - NEVER calls the network.
 * Mirrors how OIDC degrades to `not_configured` when its audience is blank — an
 * unconfigured optional seam is OFF, never faked. This module touches no money,
 * no private key, and no payout address; it only writes display/config records.
 */

/** Namestone's public API base. Overridable so an installer can point at a
 * self-hosted gateway; defaults to the public endpoint. A PUBLIC standards
 * service, not a tenant secret. */
export const DEFAULT_NAMESTONE_BASE_URL = 'https://namestone.com/api/public_v1'

/** Read the Namestone API base URL from env, falling back to the public default. */
export function namestoneBaseUrl(): string {
  const v = (process.env.NAMESTONE_BASE_URL ?? '').trim()
  return v.length > 0 ? v : DEFAULT_NAMESTONE_BASE_URL
}

/** The Namestone API key (server-only secret). Empty string when unset. */
export function namestoneApiKey(): string {
  return (process.env.NAMESTONE_API_KEY ?? '').trim()
}

/**
 * The ENS subname PARENT — "your own ENS name" (e.g. `yourbrand.eth`).
 *
 * SERVER-ONLY and NEVER hardcoded (HARD RULE): read solely from
 * `ENS_SUBNAME_PARENT`. Returns '' when unset ⇒ the seam reports not_configured.
 * No real name ever appears as a literal in this repo.
 */
export function ensSubnameParent(): string {
  return (process.env.ENS_SUBNAME_PARENT ?? '').trim()
}

/**
 * True only when the WRITE seam can issue for real: BOTH an API key AND a parent
 * are configured. When false, every issue path is a no-op `not_configured`.
 */
export function isSubnameIssuanceConfigured(): boolean {
  return namestoneApiKey().length > 0 && ensSubnameParent().length > 0
}

/** One ENS text record (`key` → `value`) to attach to the subname. */
export interface SubnameText {
  key: string
  value: string
}

/** A successfully issued subname. */
export interface SubnameIssueOk {
  ok: true
  /** The full issued name, `<label>.<parent>` (parent already includes `.eth`). */
  name: string
  /** The label that was issued. */
  label: string
  /** The parent it was issued under (from env — never invented). */
  parent: string
  /** The owner address the subname resolves to. */
  owner: string
}

/** A failed / skipped issue — unconfigured, bad input, or an upstream error. */
export interface SubnameIssueErr {
  ok: false
  /** A machine code the caller/route maps to a status. Never leaks a secret. */
  code: 'not_configured' | 'bad_input' | 'namestone_error'
  /** A short, non-secret detail for logs (e.g. upstream status). Optional. */
  detail?: string
}

export type SubnameIssueResult = SubnameIssueOk | SubnameIssueErr

/**
 * Issue (or update) `<label>.<PARENT>.eth` via Namestone, with the given owner
 * and ENS text records.
 *
 *  - Returns `not_configured` (a clean NO-OP, no network call) when the API key
 *    or the parent is unset — the seam is simply OFF, never faked.
 *  - Returns `bad_input` for a missing/invalid label or owner address (we never
 *    issue against a guessed value).
 *  - On a non-2xx Namestone response ⇒ `namestone_error` (fail-soft; the caller
 *    decides the HTTP status). We never throw.
 *
 * The PARENT is taken from env via {@link ensSubnameParent} and is never a
 * literal; `name` in the OK result is composed from that env value + the label.
 *
 * @param input.label  The subname label (e.g. `merchant-42`).
 * @param input.owner  The 0x address the subname should resolve to.
 * @param input.texts  Optional ENS text records (USD-pricing / settlement config).
 * @returns the issued name, or a machine error code (never a throw).
 */
export async function issueSubname(input: {
  label: string
  owner: string
  texts?: SubnameText[]
}): Promise<SubnameIssueResult> {
  // Fail-soft FIRST: an unconfigured seam never inspects input or hits network.
  if (!isSubnameIssuanceConfigured()) {
    return { ok: false, code: 'not_configured' }
  }

  const label = (input.label ?? '').trim().toLowerCase()
  const owner = (input.owner ?? '').trim()
  // Shape-guard the label (ENS label charset) and the owner (0x-40-hex). We do
  // NOT import viem's isAddress here to keep this a thin, dependency-light client;
  // a strict regex is sufficient and avoids ever issuing against junk.
  if (!/^[a-z0-9-]{1,63}$/.test(label) || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
    return { ok: false, code: 'bad_input' }
  }

  const parent = ensSubnameParent() // from env only — never a literal.
  const texts = Array.isArray(input.texts) ? input.texts : []
  // Namestone wants text records as a flat key→value object.
  const text_records: Record<string, string> = {}
  for (const t of texts) {
    if (t && typeof t.key === 'string' && t.key.length > 0 && typeof t.value === 'string') {
      text_records[t.key] = t.value
    }
  }

  let res: Response
  try {
    res = await fetch(`${namestoneBaseUrl()}/set-name`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Namestone authenticates with the raw API key in the Authorization header.
        Authorization: namestoneApiKey(),
      },
      body: JSON.stringify({
        domain: parent,
        name: label,
        address: owner,
        text_records,
      }),
    })
  } catch (err) {
    // Network failure ⇒ fail-soft (the optional seam is best-effort, off the
    // money path). Never throw; never claim a name we didn't get.
    return {
      ok: false,
      code: 'namestone_error',
      detail: err instanceof Error ? err.name : 'fetch_failed',
    }
  }

  if (!res.ok) {
    return { ok: false, code: 'namestone_error', detail: `status_${res.status}` }
  }

  return {
    ok: true,
    name: `${label}.${parent}`,
    label,
    parent,
    owner,
  }
}

// ── Onboarding hook ──────────────────────────────────────────────────────────

/**
 * Generic TEXT-record key namespace for the config we write onto a merchant
 * subname. GENERIC (no owner/brand name): `click.access0x1.*`. These are the keys a
 * resolver/integrator reads back to discover a merchant's pricing/settlement.
 */
export const SUBNAME_TEXT_KEYS = {
  /** The on-chain / internal merchant id. */
  merchantId: 'click.access0x1.merchantId',
  /** The router address that settles this merchant's payments. */
  router: 'click.access0x1.router',
  /** The settlement chain id (decimal string). */
  chainId: 'click.access0x1.chainId',
  /** The USD-pricing currency tag (always "USD" for this app's USD-priced router). */
  pricingCurrency: 'click.access0x1.pricingCurrency',
} as const

/**
 * On merchant onboarding, issue `merchant-<id>.<PARENT>.eth` and write the
 * merchant's USD-pricing / settlement config into ENS text records.
 *
 * This is the WRITE-seam entrypoint the onboarding flow calls. It is a thin
 * wrapper over {@link issueSubname} that (a) derives the `merchant-<id>` label
 * and (b) maps the merchant config into the generic `click.access0x1.*` text-key
 * namespace. Inherits the fail-soft contract: unconfigured ⇒ `not_configured`
 * NO-OP, no network, no invented name.
 *
 * @param merchant.id       The merchant id (becomes the `merchant-<id>` label).
 * @param merchant.owner    The 0x address the subname resolves to (the operator).
 * @param merchant.router   Optional router address → `click.access0x1.router`.
 * @param merchant.chainId  Optional settlement chain id → `click.access0x1.chainId`.
 * @returns the issued name, or a machine error code (never a throw).
 */
export async function issueMerchantSubname(merchant: {
  id: string | number | bigint
  owner: string
  router?: string
  chainId?: number
}): Promise<SubnameIssueResult> {
  // Fail-soft mirror so callers can short-circuit without composing a label
  // against an unconfigured parent (defense-in-depth; issueSubname re-checks).
  if (!isSubnameIssuanceConfigured()) {
    return { ok: false, code: 'not_configured' }
  }

  const idStr = String(merchant.id).trim()
  if (idStr.length === 0) return { ok: false, code: 'bad_input' }
  const label = `merchant-${idStr}`

  const texts: SubnameText[] = [
    { key: SUBNAME_TEXT_KEYS.merchantId, value: idStr },
    // The router USD-prices every payment; tag the currency so a reader knows
    // these records describe a USD-priced merchant (truthful, generic).
    { key: SUBNAME_TEXT_KEYS.pricingCurrency, value: 'USD' },
  ]
  if (typeof merchant.router === 'string' && merchant.router.trim().length > 0) {
    texts.push({ key: SUBNAME_TEXT_KEYS.router, value: merchant.router.trim() })
  }
  if (typeof merchant.chainId === 'number' && Number.isFinite(merchant.chainId)) {
    texts.push({ key: SUBNAME_TEXT_KEYS.chainId, value: String(merchant.chainId) })
  }

  return issueSubname({ label, owner: merchant.owner, texts })
}
