/**
 * store.ts — the `tenant_branding` model + a minimal server-side store
 * (ADR units 1 + D3 Tier 1).
 *
 * A business that signs in (Dynamic) and fills in the "Make it yours" screen is
 * a ROW here: one `TenantBranding` per tenant, 1:1, keyed by `tenant_id`, with a
 * UNIQUE `checkout_slug`. This is the hosted source of truth the checkout page,
 * the embed's `GET /api/branding/{slug}`, and the Snap read at runtime.
 *
 * PERSISTENCE. A process-lifetime in-memory map, pinned on `globalThis` so
 * Next.js's dev hot-reload and the several route module instances share ONE store,
 * is the SYNCHRONOUS hot read surface (so `getBySlug` etc. stay sync — no call site
 * changes). When a durable backend is configured (`NULLIFIER_STORE_URL` /
 * `DATABASE_URL`) it is mirrored DURABLY via `lib/storage/durableKv.ts`:
 * `upsertBranding` write-throughs each row to Postgres, and the module HYDRATES the
 * in-memory map from Postgres at load — so a tenant's branding/checkout identity
 * SURVIVES a Cloud Run scale-to-zero instead of evaporating. With no DB configured
 * it is fail-soft: the unchanged in-memory behaviour with a one-time warning.
 *
 * Pure normalization helpers (slug/name/hash) are exported and unit-tested
 * offline; the store CRUD is exercised through the API route tests.
 */

import { keccak256, toHex } from 'viem';
import { DEFAULT_BRAND_COLOR, normalizeBrandColor, sanitizeSvg } from './logo.js';
import { asTrustTier, type TrustTier } from '../verification/tiers.js';
import { durableSet, hydrate } from '../storage/durableKv.js';

/** The durable-KV namespace for tenant branding rows (key = tenantId). */
const KV_NAMESPACE = 'branding:tenant';

/** Max chars we keep for a one-line description (ADR D2 step 2: ~140). */
export const MAX_DESCRIPTION_CHARS = 140;
/** Max chars for a display name. */
export const MAX_DISPLAY_NAME_CHARS = 80;
/** Slug length bounds (readable link tail). */
export const MIN_SLUG_LEN = 2;
export const MAX_SLUG_LEN = 48;

/**
 * The per-merchant checkout identity/privacy choice (World ID ADR D0). One
 * plain-English question, three options, opposite poles:
 *   - 'verified-human' → World ID gate in front of pay (proof-of-personhood)
 *   - 'private'        → the existing Unlink confidential payout leg
 *   - 'standard'       → today's behavior (the default; nothing breaks)
 * They are mutually exclusive per single checkout (a payment is identity OR
 * privacy, never both — enforced in `lib/worldid/gateConfig.ts`).
 */
export type CheckoutMode = 'verified-human' | 'private' | 'standard';

/**
 * The merchant's business category (Casino vertical, World prize). Almost every
 * tenant is 'standard' (the default — nothing changes). 'casino' marks a tenant
 * whose checkout sells play/wagering access; for that vertical World ID becomes
 * LOAD-BEARING:
 *   - the operator MUST complete World ID proof-of-personhood (verifiedOperator)
 *     before the casino can be saved / go live (enforced in `upsertBranding`),
 *   - `checkoutMode` is FORCED to 'verified-human' so a player must pass the
 *     World ID gate — it is NOT operator-overridable while vertical = 'casino'.
 * This is the "what breaks without World ID" answer: a casino simply cannot be
 * brought online without a real, unique human behind it AND a human gate in
 * front of every player. It says NOTHING about a gambling licence, the player's
 * age, or legal eligibility — World ID only proves unique personhood (law #4).
 */
export type MerchantVertical = 'standard' | 'casino';

/** The default vertical — the existing, unchanged behaviour (non-breaking). */
export const DEFAULT_VERTICAL: MerchantVertical = 'standard';

/** Where a verified-human proof is checked (World ID ADR D2). Off-chain default. */
export type HumanVerifier = 'offchain' | 'onchain';

/** The default checkout mode — sensible, non-breaking (ADR D5). */
export const DEFAULT_CHECKOUT_MODE: CheckoutMode = 'standard';

/**
 * The minimum Super Verification trust tier a buyer must hold to pay this
 * merchant (Super Verification feature). 'standard' = anyone (the default,
 * non-breaking). 'verified' / 'super-verified' compose the existing World ID
 * gate with the other methods (ENS / Dynamic / on-chain). This is SEPARATE from
 * `checkoutMode` (identity-vs-privacy): a merchant can require a tier AND still
 * pick verified-human or private, and the checkout enforces both.
 */
export const DEFAULT_REQUIRED_TIER: TrustTier = 'standard';
/** The default verifier when mode = verified-human (no gas, no contract). */
export const DEFAULT_HUMAN_VERIFIER: HumanVerifier = 'offchain';

/** Narrow an untrusted value into a {@link CheckoutMode}, defaulting to standard. */
export function asCheckoutMode(v: unknown): CheckoutMode {
  return v === 'verified-human' || v === 'private' || v === 'standard'
    ? v
    : DEFAULT_CHECKOUT_MODE;
}

/** Narrow an untrusted value into a {@link HumanVerifier}, defaulting to off-chain. */
export function asHumanVerifier(v: unknown): HumanVerifier {
  return v === 'onchain' ? 'onchain' : DEFAULT_HUMAN_VERIFIER;
}

/** Narrow an untrusted value into a {@link MerchantVertical}, defaulting to standard. */
export function asVertical(v: unknown): MerchantVertical {
  return v === 'casino' ? 'casino' : DEFAULT_VERTICAL;
}

/** Is this merchant a casino (World ID load-bearing vertical)? */
export function isCasino(v: unknown): boolean {
  return asVertical(v) === 'casino';
}

/**
 * Thrown when a casino save is blocked because the operator has not yet
 * completed World ID proof-of-personhood. Distinct code so the onboarding UI can
 * branch on it and show the "Casinos must verify with World ID" step.
 */
export const CASINO_NEEDS_OPERATOR_CODE = 'CASINO_NEEDS_OPERATOR';

/**
 * One tenant's branding row (ADR D3 Tier-1 table). `merchant_id`, `name_hash`,
 * and `logo_blob_id` are null until the tenant goes on-chain / publishes to
 * Walrus (the Snap-invoke + Walrus seams attach there later — unit 8).
 */
export interface TenantBranding {
  /** Who this is — from Dynamic sign-in. PK. */
  tenantId: string;
  /** "Joe's Barbershop" — what the customer reads. */
  displayName: string;
  /** The one-liner, plain text, sanitized. */
  description: string;
  /** The served logo URL (CDN/object store), or null (we ship the inline SVG). */
  logoUrl: string | null;
  /** The logo as an inline-SVG string — what the Snap's `Image` needs. */
  logoSvgInline: string;
  /** A validated 6/8-char hex brand color. */
  brandColor: string;
  /** The readable link tail. UNIQUE across tenants. */
  checkoutSlug: string;
  /** On-chain merchant id, or null until they register on the Router. */
  merchantId: string | null;
  /** keccak256(normalized display_name) we wrote / will write on-chain. */
  nameHash: `0x${string}`;
  /** Walrus blob id for the durable logo copy, or null until published. */
  logoBlobId: string | null;
  /**
   * The D0 checkout choice (World ID ADR D3 table). Default 'standard' so an
   * existing tenant is untouched. 'verified-human' mounts the World ID gate;
   * 'private' runs the existing Unlink leg.
   */
  checkoutMode: CheckoutMode;
  /** Where a verified-human proof is checked. Only meaningful when mode = verified-human. */
  humanVerifier: HumanVerifier;
  /**
   * The minimum Super Verification trust tier a BUYER must hold to pay this
   * merchant ('standard' = anyone, the default). Composes with `checkoutMode`.
   */
  requiredTier: TrustTier;
  /**
   * The merchant's business category (Casino vertical). Default 'standard' so an
   * existing tenant is untouched. 'casino' makes World ID load-bearing: the
   * operator must be verified and `checkoutMode` is forced to 'verified-human'.
   */
  vertical: MerchantVertical;
  /** Merchant-side "operated by a verified real human" trust badge (ADR D1.4). */
  verifiedOperator: boolean;
  /**
   * The merchant's onboarding-action nullifier (decimal string) when they
   * proved operator personhood, or null. A DISTINCT action from the buyer gate.
   */
  operatorNullifier: string | null;
  /** Record create / last-update timestamps (Date.now()). */
  createdAt: number;
  updatedAt: number;
}

/** The writable fields the onboarding screen / Settings → Branding submit. */
export interface BrandingInput {
  tenantId: string;
  displayName: string;
  description?: string;
  /** Sanitized inline SVG (from the logo upload), or omitted to auto-monogram. */
  logoSvgInline?: string;
  logoUrl?: string | null;
  brandColor?: string;
  /** Desired checkout slug; auto-derived from the name when omitted/blank. */
  checkoutSlug?: string;
  /** Optional on-chain anchors (attached later by the Snap/Walrus seams). */
  merchantId?: string | null;
  logoBlobId?: string | null;
  /** The D0 checkout choice (World ID ADR D0). Omit to keep the existing/default. */
  checkoutMode?: CheckoutMode;
  /** Verifier sub-choice for verified-human. Omit to keep the existing/default. */
  humanVerifier?: HumanVerifier;
  /** Minimum buyer trust tier required to pay (Super Verification). Omit to keep existing/default. */
  requiredTier?: TrustTier;
  /** The merchant's business category (Casino vertical). Omit to keep existing/default. */
  vertical?: MerchantVertical;
  /** Operator-verified badge + its nullifier (set by the operator-verify seam). */
  verifiedOperator?: boolean;
  operatorNullifier?: string | null;
}

/** Thrown on invalid branding input (slug collision, bad name, etc.). */
export class BrandingError extends Error {
  constructor(
    message: string,
    /** A machine code the UI can branch on (e.g. SLUG_TAKEN). */
    public readonly code: string,
  ) {
    super(message);
    this.name = 'BrandingError';
  }
}

// ── Normalization helpers (pure, unit-tested offline) ────────────────────────

/**
 * Normalize a display name for hashing/comparison: trim, collapse internal
 * whitespace, NFC-normalize. The on-chain `nameHash` commits to THIS form so the
 * DB and chain agree regardless of incidental spacing.
 *
 * @param name - the raw display name.
 * @returns the normalized name.
 */
export function normalizeName(name: string): string {
  return (name ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * keccak256 of the normalized display name — the on-chain branding commitment
 * (ADR D3). Matches `RegisterForm`'s `keccak256(toHex(name))` shape so the hash
 * the page wrote on-chain and the hash we store here are identical.
 *
 * @param name - the raw display name (normalized internally).
 * @returns the 0x-prefixed bytes32 hash.
 */
export function nameHashOf(name: string): `0x${string}` {
  return keccak256(toHex(normalizeName(name)));
}

/**
 * Derive a readable checkout-link tail ("slug") from a business name: lowercase,
 * spaces/punctuation → single hyphens, trimmed of leading/trailing hyphens,
 * clamped to {@link MAX_SLUG_LEN}. ADR D2 step 1: the customer never types
 * "slug" — we generate this live under the name field.
 *
 * @param name - the business display name.
 * @returns a slug candidate (may be empty if the name had no usable chars).
 */
export function slugify(name: string): string {
  return (name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, '');
}

/** Validate a slug's shape (chars + length). Does NOT check uniqueness. */
export function isValidSlug(slug: string): boolean {
  return (
    typeof slug === 'string' &&
    slug.length >= MIN_SLUG_LEN &&
    slug.length <= MAX_SLUG_LEN &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
  );
}

/**
 * Invisible / bidi-control / blank-rendering characters that have no legitimate
 * place in a plain merchant name or description but enable visual spoofing.
 *
 * Matched by the whole Unicode FORMAT category `\p{Cf}` (self-maintaining, so a
 * hand-rolled range list can't miss one) — this covers the "Trojan Source" bidi
 * class (embeddings/overrides/isolates U+202A-202E / U+2066-2069, directional
 * marks U+200E/200F, and crucially the Arabic Letter Mark U+061C that a range
 * list misses), zero-width chars (U+200B-200D, U+2060-2064, U+FEFF), the Arabic/
 * Kashmiri number-sign controls, deprecated formats, interlinear-annotation
 * anchors (U+FFF9-FFFB), soft hyphen (U+00AD), and the Plane-14 TAG chars
 * (U+E0000-E007F) that can smuggle hidden text — PLUS the blank-rendering
 * fillers that are NOT `Cf` but display as nothing (Hangul fillers U+115F/1160/
 * 3164/FFA0, Braille blank U+2800).
 *
 * Stripped FIRST (before the tag strip) so they can never break up the `<...>`
 * pattern the markup passes depend on. Ordinary accented letters, CJK, and
 * emoji (incl. VS-16 U+FE0F, a combining mark, not `Cf`) are preserved.
 * Homoglyph/confusable LETTERS (Cyrillic 'a' vs Latin 'a') are a separate,
 * heavier concern, mitigated at checkout by the unspoofable ENSIP-19 identity.
 */
const INVISIBLE_CHARS = /[\p{Cf}\u115F\u1160\u3164\uFFA0\u2800]/gu;

/**
 * Sanitize a one-line description to plain text: strip invisible/bidi controls
 * and ALL markup/angle brackets (no `<…>` ever reaches the Snap — ADR D2 step 2),
 * collapse whitespace, clamp length. Display data only; never gates money.
 *
 * @param raw - the merchant-typed description.
 * @returns the clamped plain-text description.
 */
export function sanitizeDescription(raw: string | undefined | null): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(INVISIBLE_CHARS, '') // drop bidi/zero-width spoofing chars first
    .replace(/<[^>]*>/g, '') // drop any tag
    .replace(/[<>]/g, '') // and stray brackets
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);
}

/** Sanitize/clamp a display name to plain text. */
export function sanitizeDisplayName(raw: string): string {
  return (raw ?? '')
    .replace(INVISIBLE_CHARS, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DISPLAY_NAME_CHARS);
}

// ── The store (in-memory, globalThis-pinned singleton) ───────────────────────

interface BrandingStore {
  byTenant: Map<string, TenantBranding>;
  bySlug: Map<string, string>; // slug -> tenantId
  byMerchant: Map<string, string>; // merchantId -> tenantId
}

/** Pin ONE store on globalThis so dev hot-reload / route instances share it. */
const GLOBAL_KEY = '__ax1_branding_store__';

function store(): BrandingStore {
  const g = globalThis as unknown as Record<string, BrandingStore | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { byTenant: new Map(), bySlug: new Map(), byMerchant: new Map() };
  }
  return g[GLOBAL_KEY] as BrandingStore;
}

/**
 * Create or update a tenant's branding row (idempotent per tenant).
 *
 * - Derives a slug from the name when none is given; ensures it is UNIQUE,
 *   suggesting `-2`, `-3`, … on collision (the CR check-slug UX).
 * - Re-validates the brand color to a safe hex.
 * - Recomputes `nameHash` from the (normalized) name on every write so the DB
 *   stays in lockstep with what the page would write on-chain.
 * - Preserves on-chain anchors (`merchantId`/`logoBlobId`/`logoUrl`) across
 *   edits unless the caller explicitly supplies them.
 *
 * @param input - the writable branding fields.
 * @returns the persisted row.
 * @throws {BrandingError} on an empty name or a slug collision with a DIFFERENT tenant.
 */
export function upsertBranding(input: BrandingInput): TenantBranding {
  const s = store();
  const tenantId = (input.tenantId ?? '').trim();
  if (!tenantId) throw new BrandingError('Missing tenant id.', 'NO_TENANT');

  const displayName = sanitizeDisplayName(input.displayName);
  if (!displayName) throw new BrandingError('Enter a business name.', 'NO_NAME');

  const existing = s.byTenant.get(tenantId);

  // Resolve the slug: explicit (validated) > existing (kept) > derived-unique.
  let slug: string;
  if (typeof input.checkoutSlug === 'string' && input.checkoutSlug.trim()) {
    const candidate = input.checkoutSlug.trim().toLowerCase();
    if (!isValidSlug(candidate)) {
      throw new BrandingError(
        'Your checkout link can use letters, numbers, and hyphens only.',
        'BAD_SLUG',
      );
    }
    const owner = s.bySlug.get(candidate);
    if (owner && owner !== tenantId) {
      throw new BrandingError('That checkout link is already taken.', 'SLUG_TAKEN');
    }
    slug = candidate;
  } else if (existing) {
    slug = existing.checkoutSlug;
  } else {
    slug = ensureUniqueSlug(slugify(displayName) || 'shop', s, tenantId);
  }

  // Mirror the slug guard for the on-chain `merchantId` anchor. `byMerchant` is a GLOBAL
  // index (merchantId -> tenantId) surfaced by the public, CORS-open
  // /api/branding/by-merchant/[id] that the MetaMask Snap reads for its "who am I paying"
  // insight. merchant ids are public on-chain and this route only proves the caller owns
  // THEIR OWN tenant row — so without a uniqueness check a verified attacker could bind a
  // merchantId they do NOT own to their row, overwriting the index to spoof another
  // merchant's name/logo (anti-phishing bypass) and deny that merchant's branding. Reject a
  // merchantId already held by a DIFFERENT tenant. Checked BEFORE any write (like the slug
  // guard) so a rejection never leaves a partial mutation.
  const effectiveMerchantId =
    input.merchantId !== undefined ? input.merchantId : (existing?.merchantId ?? null);
  if (effectiveMerchantId) {
    const merchantOwner = s.byMerchant.get(effectiveMerchantId);
    if (merchantOwner && merchantOwner !== tenantId) {
      throw new BrandingError('That merchant id is already claimed.', 'MERCHANT_TAKEN');
    }
  }

  const brandColor = normalizeBrandColor(input.brandColor ?? existing?.brandColor ?? DEFAULT_BRAND_COLOR);
  const description = sanitizeDescription(
    input.description ?? existing?.description ?? '',
  );

  // ── Casino vertical: World ID is load-bearing (World prize) ────────────────
  // Resolve the effective vertical (explicit input > existing > default). Almost
  // every tenant is 'standard' and falls straight through; only 'casino' adds
  // rules. The rules are enforced HERE, in the one write path, so no caller can
  // route around them: the checkout mode forced below + the operator block.
  const vertical: MerchantVertical =
    input.vertical !== undefined
      ? asVertical(input.vertical)
      : (existing?.vertical ?? DEFAULT_VERTICAL);

  // Resolve the operator-verified flag the SAME way the row build does below, so
  // the casino block sees the value this very write will persist (e.g. the
  // operator just verified in this request).
  const verifiedOperatorResolved =
    input.verifiedOperator !== undefined
      ? Boolean(input.verifiedOperator)
      : (existing?.verifiedOperator ?? false);

  // Resolve the requested checkout mode (explicit > existing > default). For a
  // casino this is then OVERRIDDEN to 'verified-human' regardless — a casino is
  // never operator-overridable to standard/private while it stays a casino.
  let checkoutMode: CheckoutMode =
    input.checkoutMode !== undefined
      ? asCheckoutMode(input.checkoutMode)
      : (existing?.checkoutMode ?? DEFAULT_CHECKOUT_MODE);

  if (vertical === 'casino') {
    // 2a) FORCE verified-human so every player must pass the World ID gate. Not
    // user-overridable while vertical = casino (any other choice is ignored).
    checkoutMode = 'verified-human';
    // 2b) BLOCK the save (cannot go live) until the operator has completed World
    // ID proof-of-personhood. This is the "what breaks without World ID": a
    // casino simply cannot exist without a verified real human behind it.
    if (!verifiedOperatorResolved) {
      throw new BrandingError(
        'Casinos must verify with World ID before going live. Complete the operator World ID step to prove a real, unique person is running this casino.',
        CASINO_NEEDS_OPERATOR_CODE,
      );
    }
  }

  const now = Date.now();
  // Defense in depth: re-sanitize the inline SVG at the STORAGE boundary, the
  // same place displayName/description are sanitized. The onboarding screen
  // passes an already-sanitized logo, but a caller that reaches upsertBranding
  // another way (a direct POST of `logoSvgInline` to /api/branding bypasses the
  // /api/branding/logo sanitizer) must never persist executable/fetching SVG.
  // sanitizeSvg is idempotent, so re-scrubbing a clean logo is a no-op and it
  // also heals any row written before this guard; '' stays ''.
  const rawLogo = input.logoSvgInline ?? existing?.logoSvgInline ?? '';
  const logoSvgInline = rawLogo ? sanitizeSvg(rawLogo) : '';
  const row: TenantBranding = {
    tenantId,
    displayName,
    description,
    logoUrl: input.logoUrl !== undefined ? input.logoUrl : (existing?.logoUrl ?? null),
    logoSvgInline,
    brandColor,
    checkoutSlug: slug,
    merchantId:
      input.merchantId !== undefined ? input.merchantId : (existing?.merchantId ?? null),
    nameHash: nameHashOf(displayName),
    logoBlobId:
      input.logoBlobId !== undefined ? input.logoBlobId : (existing?.logoBlobId ?? null),
    // Casino forced this to 'verified-human' above; otherwise it's the resolved
    // explicit/existing/default value.
    checkoutMode,
    humanVerifier:
      input.humanVerifier !== undefined
        ? asHumanVerifier(input.humanVerifier)
        : (existing?.humanVerifier ?? DEFAULT_HUMAN_VERIFIER),
    requiredTier:
      input.requiredTier !== undefined
        ? asTrustTier(input.requiredTier)
        : (existing?.requiredTier ?? DEFAULT_REQUIRED_TIER),
    vertical,
    verifiedOperator: verifiedOperatorResolved,
    operatorNullifier:
      input.operatorNullifier !== undefined
        ? input.operatorNullifier
        : (existing?.operatorNullifier ?? null),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  // Re-index slug (a name/slug edit moves the slug key).
  if (existing && existing.checkoutSlug !== slug) {
    s.bySlug.delete(existing.checkoutSlug);
  }
  s.bySlug.set(slug, tenantId);

  // Re-index merchantId mapping when it changes.
  if (existing?.merchantId && existing.merchantId !== row.merchantId) {
    s.byMerchant.delete(existing.merchantId);
  }
  if (row.merchantId) s.byMerchant.set(row.merchantId, tenantId);

  s.byTenant.set(tenantId, row);
  // Write-through to the durable backend (best-effort, fail-soft, no-op without a
  // DB). The tenantId is the durable key; the full row is the value, so a restart
  // can rebuild the maps + secondary indexes from it via `indexRow` on hydrate.
  durableSet(KV_NAMESPACE, tenantId, row);
  return row;
}

/**
 * Rebuild the in-memory maps + secondary indexes for one already-built row. Used
 * by hydration (durable → memory at boot): it does NOT re-validate or re-persist,
 * it just re-indexes the durable copy. Tolerant of a partial/legacy persisted row.
 */
function indexRow(row: TenantBranding): void {
  if (!row || typeof row.tenantId !== 'string' || !row.tenantId) return;
  const s = store();
  s.byTenant.set(row.tenantId, row);
  if (row.checkoutSlug) s.bySlug.set(row.checkoutSlug, row.tenantId);
  if (row.merchantId) s.byMerchant.set(row.merchantId, row.tenantId);
}

/** Find a unique slug, appending `-2`, `-3`, … until free (ADR collision UX). */
function ensureUniqueSlug(base: string, s: BrandingStore, tenantId: string): string {
  let candidate = base.slice(0, MAX_SLUG_LEN).replace(/-+$/g, '');
  if (candidate.length < MIN_SLUG_LEN) candidate = `${candidate}-shop`.slice(0, MAX_SLUG_LEN);
  let n = 1;
  while (true) {
    const owner = s.bySlug.get(candidate);
    if (!owner || owner === tenantId) return candidate;
    n += 1;
    const suffix = `-${n}`;
    candidate = `${base.slice(0, MAX_SLUG_LEN - suffix.length)}${suffix}`;
  }
}

/**
 * Is a slug available (free, or already owned by this tenant)? Powers the live
 * green-check / red-X availability under the name field (ADR D2 step 1).
 *
 * @param slug - the candidate slug.
 * @param tenantId - the asking tenant (their own slug counts as available).
 * @returns true when the slug is valid AND not taken by another tenant.
 */
export function isSlugAvailable(slug: string, tenantId?: string): boolean {
  if (!isValidSlug(slug)) return false;
  const owner = store().bySlug.get(slug);
  return !owner || owner === tenantId;
}

/** Suggest free slug alternatives for a taken base (e.g. joes-barbershop-2). */
export function suggestSlugs(base: string, tenantId?: string, count = 3): string[] {
  const root = slugify(base) || 'shop';
  const out: string[] = [];
  let n = 1;
  while (out.length < count && n < 100) {
    n += 1;
    const suffix = `-${n}`;
    const candidate = `${root.slice(0, MAX_SLUG_LEN - suffix.length)}${suffix}`;
    if (isSlugAvailable(candidate, tenantId)) out.push(candidate);
  }
  return out;
}

/** Read a tenant's branding by tenant id. */
export function getByTenant(tenantId: string): TenantBranding | null {
  return store().byTenant.get((tenantId ?? '').trim()) ?? null;
}

/** Read a tenant's branding by checkout slug (the hosted page + embed lookup). */
export function getBySlug(slug: string): TenantBranding | null {
  const tenantId = store().bySlug.get((slug ?? '').trim().toLowerCase());
  return tenantId ? (store().byTenant.get(tenantId) ?? null) : null;
}

/** Read a tenant's branding by on-chain merchant id (the Snap by-merchant lookup). */
export function getByMerchantId(merchantId: string): TenantBranding | null {
  const tenantId = store().byMerchant.get((merchantId ?? '').trim());
  return tenantId ? (store().byTenant.get(tenantId) ?? null) : null;
}

/**
 * Attach (or update) the on-chain anchors after a tenant registers on the Router
 * — the seam the Snap-invoke / Walrus mirror (unit 8) calls. Keeps the slug +
 * branding intact; just wires `merchantId` / `logoBlobId` and re-indexes.
 *
 * @returns the updated row, or null if the tenant has no branding yet.
 */
export function attachOnChain(
  tenantId: string,
  anchors: { merchantId?: string | null; logoBlobId?: string | null },
): TenantBranding | null {
  const existing = getByTenant(tenantId);
  if (!existing) return null;
  return upsertBranding({
    tenantId,
    displayName: existing.displayName,
    description: existing.description,
    logoSvgInline: existing.logoSvgInline,
    logoUrl: existing.logoUrl,
    brandColor: existing.brandColor,
    checkoutSlug: existing.checkoutSlug,
    merchantId: anchors.merchantId !== undefined ? anchors.merchantId : existing.merchantId,
    logoBlobId: anchors.logoBlobId !== undefined ? anchors.logoBlobId : existing.logoBlobId,
  });
}

/**
 * Hydrate the in-memory store from the durable backend (durable → memory at boot),
 * rebuilding every tenant row + its slug/merchant indexes. No-op without a DB.
 * Returns the number of rows restored. Exposed so a deployment / test can await a
 * deterministic hydrate; the module also kicks it off once at load (below).
 */
export async function hydrateBrandingFromDurable(): Promise<number> {
  return hydrate(KV_NAMESPACE, (_key, value) => indexRow(value as TenantBranding));
}

/** Test-only: wipe the store. NOT used in production paths. */
export function __resetBrandingStore(): void {
  const g = globalThis as unknown as Record<string, BrandingStore | undefined>;
  g[GLOBAL_KEY] = { byTenant: new Map(), bySlug: new Map(), byMerchant: new Map() };
}

// ── Featured-merchant seed (optional, env-driven, fail-soft) ─────────────────
// Seed ONE stable default brand at module load IF the deployment set the
// FEATURED_MERCHANT_* env (see ./seed.ts). This runs once per process, here at
// the BOTTOM of the module so `upsertBranding` is already defined (no circular
// init), and is wrapped so a bad env value can never crash the store on import.
// When the env is unset it is a no-op — the open-source default is the unchanged
// empty store. Pinned on globalThis so it seeds at most once across hot-reloads.
import { seedFeaturedMerchant } from './seed.js';

const SEED_FLAG_KEY = '__ax1_featured_seeded__';
{
  const g = globalThis as unknown as Record<string, boolean | undefined>;
  if (!g[SEED_FLAG_KEY]) {
    g[SEED_FLAG_KEY] = true;
    try {
      seedFeaturedMerchant(upsertBranding);
    } catch {
      // Fail-soft: never let the seed break the store module load.
    }
  }
}

// ── Durable hydration (durable → memory) on first load, once per process ──────
// When a DB is configured, restore every persisted tenant row into the in-memory
// map so a Cloud Run cold start doesn't begin with an empty store. Fire-and-forget
// + fail-soft (a DB error just leaves the store at its in-memory/seed state). When
// no DB is configured this is a cheap no-op. Pinned on globalThis so it runs at
// most once across hot-reloads.
const HYDRATE_FLAG_KEY = '__ax1_branding_hydrated__';
{
  const g = globalThis as unknown as Record<string, boolean | undefined>;
  if (!g[HYDRATE_FLAG_KEY]) {
    g[HYDRATE_FLAG_KEY] = true;
    void hydrateBrandingFromDurable().catch(() => {
      // Fail-soft: never let hydration break the store module load.
    });
  }
}
