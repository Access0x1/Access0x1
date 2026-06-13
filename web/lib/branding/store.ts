/**
 * store.ts — the `tenant_branding` model + a minimal server-side store
 * (ADR units 1 + D3 Tier 1).
 *
 * A business that signs in (Dynamic) and fills in the "Make it yours" screen is
 * a ROW here: one `TenantBranding` per tenant, 1:1, keyed by `tenant_id`, with a
 * UNIQUE `checkout_slug`. This is the hosted source of truth the checkout page,
 * the embed's `GET /api/branding/{slug}`, and the Snap read at runtime.
 *
 * PERSISTENCE CHOICE (hackathon-appropriate, per the prompt): the repo has NO
 * database — the one existing server-side store is the bounded in-memory ring in
 * `lib/payment-ledger.ts`. We mirror that pattern: a process-lifetime in-memory
 * map, pinned on `globalThis` so Next.js's dev hot-reload and the several route
 * module instances share ONE store rather than each getting a fresh empty map.
 * No heavy DB is stood up. The interface (`upsertBranding` / `getBySlug` /
 * `getByMerchantId`) is the seam a real KV/Postgres swaps behind later with zero
 * call-site changes.
 *
 * Pure normalization helpers (slug/name/hash) are exported and unit-tested
 * offline; the store CRUD is exercised through the API route tests.
 */

import { keccak256, toHex } from 'viem';
import { DEFAULT_BRAND_COLOR, normalizeBrandColor } from './logo.js';

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

/** Where a verified-human proof is checked (World ID ADR D2). Off-chain default. */
export type HumanVerifier = 'offchain' | 'onchain';

/** The default checkout mode — sensible, non-breaking (ADR D5). */
export const DEFAULT_CHECKOUT_MODE: CheckoutMode = 'standard';
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
 * Sanitize a one-line description to plain text: strip ALL markup/angle brackets
 * (no `<…>` ever reaches the Snap — ADR D2 step 2), collapse whitespace, clamp
 * length. Display data only; never gates money.
 *
 * @param raw - the merchant-typed description.
 * @returns the clamped plain-text description.
 */
export function sanitizeDescription(raw: string | undefined | null): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<[^>]*>/g, '') // drop any tag
    .replace(/[<>]/g, '') // and stray brackets
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);
}

/** Sanitize/clamp a display name to plain text. */
export function sanitizeDisplayName(raw: string): string {
  return (raw ?? '')
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

  const brandColor = normalizeBrandColor(input.brandColor ?? existing?.brandColor ?? DEFAULT_BRAND_COLOR);
  const description = sanitizeDescription(
    input.description ?? existing?.description ?? '',
  );

  const now = Date.now();
  const row: TenantBranding = {
    tenantId,
    displayName,
    description,
    logoUrl: input.logoUrl !== undefined ? input.logoUrl : (existing?.logoUrl ?? null),
    // logoSvgInline is required to render; the caller passes a sanitized SVG or
    // we keep the existing one. (The onboarding screen always supplies one —
    // an uploaded+sanitized logo or an auto-monogram.)
    logoSvgInline: input.logoSvgInline ?? existing?.logoSvgInline ?? '',
    brandColor,
    checkoutSlug: slug,
    merchantId:
      input.merchantId !== undefined ? input.merchantId : (existing?.merchantId ?? null),
    nameHash: nameHashOf(displayName),
    logoBlobId:
      input.logoBlobId !== undefined ? input.logoBlobId : (existing?.logoBlobId ?? null),
    checkoutMode:
      input.checkoutMode !== undefined
        ? asCheckoutMode(input.checkoutMode)
        : (existing?.checkoutMode ?? DEFAULT_CHECKOUT_MODE),
    humanVerifier:
      input.humanVerifier !== undefined
        ? asHumanVerifier(input.humanVerifier)
        : (existing?.humanVerifier ?? DEFAULT_HUMAN_VERIFIER),
    verifiedOperator:
      input.verifiedOperator !== undefined
        ? Boolean(input.verifiedOperator)
        : (existing?.verifiedOperator ?? false),
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
  return row;
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

/** Test-only: wipe the store. NOT used in production paths. */
export function __resetBrandingStore(): void {
  const g = globalThis as unknown as Record<string, BrandingStore | undefined>;
  g[GLOBAL_KEY] = { byTenant: new Map(), bySlug: new Map(), byMerchant: new Map() };
}
