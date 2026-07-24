/**
 * The module catalog — human-facing metadata for every shared-rail contract the
 * console surfaces, AUTO-DERIVED from the generated ABIs so a new contract never
 * has to be hand-added here.
 *
 * HOW IT STAYS DYNAMIC: {@link MODULE_CATALOG} is BUILT from `MODULE_NAMES` (every
 * ABI in `lib/generated/module-abis.ts`, itself generated from `abis/*.json` — the
 * deployed set plus a small preview lane). Each name gets an entry: a curated label
 * + category + blurb from {@link CURATED} when we've written one, otherwise a sane
 * DEFAULT derived from the contract name. So the moment a contract's ABI lands
 * (a deploy commits it via `scripts/sync-deployed-abis.mjs`, or it's a declared
 * preview), it appears in the console automatically — curating a blurb is optional
 * enrichment, never a gate. `list-missing-blurbs` (below) flags names still on the
 * default so we can enrich them, but they SHOW regardless.
 *
 * The ABI + the deployed address are the machine truth; this file is only the
 * label + the blurb. A module with no address on a chain renders an honest "not on
 * this chain yet" (address resolution is `deployments.ts`); a module deployed on NO
 * chain renders "built · not deployed yet" (the registry derives `preview`).
 */
import { MODULE_NAMES, type ModuleName } from '@/lib/generated/module-abis'

/** The console's top-level grouping for the module list. */
export type ModuleCategory =
  | 'Payments'
  | 'Refunds & escrow'
  | 'Commerce'
  | 'Assets'
  | 'Infrastructure'

/** Curated, human-facing metadata for one shared-rail module. */
export interface ModuleMeta {
  /** The contract name — the key into MODULE_ABIS and the deployments map. */
  readonly name: ModuleName
  /** Short display label for the console (drops the `Access0x1` prefix noise). */
  readonly label: string
  /** Which group the module lists under. */
  readonly category: ModuleCategory
  /** One honest line: what a caller can DO with this module. No marketing. */
  readonly blurb: string
  /** True when only the default (name-derived) metadata is used — no curated blurb yet. */
  readonly curated: boolean
}

/** Curated metadata by contract name (optional overlay). Omit a field to take the default. */
type Curated = { label: string; category: ModuleCategory; blurb: string }

/**
 * The curated overlay — one entry per contract we've written honest copy for.
 * Anything NOT here still lists, using {@link defaultMeta}. Add a new contract's
 * entry to enrich its console card; you never HAVE to, to make it appear.
 */
const CURATED: Partial<Record<ModuleName, Curated>> = {
  // ── Payments ──────────────────────────────────────────────────────────────
  Access0x1Router: {
    label: 'Router',
    category: 'Payments',
    blurb:
      'The payment rail. Register a merchant, then pay in USDC or the native coin priced in USD through Chainlink, with the platform fee split baked in.',
  },
  GaslessPayIn: {
    label: 'Gasless pay-in',
    category: 'Payments',
    blurb:
      'A relayer-submitted, merchant-bound pay-in so a buyer can settle without holding gas — the authorization can only credit the intended merchant.',
  },
  PaymentLanes: {
    label: 'Payment lanes',
    category: 'Payments',
    blurb:
      'Per-lane payment routing and limits — separate rails for separate flows on a high-volume merchant.',
  },
  SplitSettler: {
    label: 'Split settler',
    category: 'Payments',
    blurb: 'Split one payment across several payees atomically, in a single settlement.',
  },
  Access0x1PaymentResolver: {
    label: 'ENS payment resolver',
    category: 'Payments',
    blurb:
      'Resolves pay.<merchant>.eth to the merchant’s live on-chain payout — ENS as a programmable payment endpoint, read from the router at query time.',
  },
  Access0x1SwapReceiptHook: {
    label: 'Swap receipt hook',
    category: 'Payments',
    blurb:
      'A Uniswap v4 hook that turns each payout swap through a hooked pool into an attributable on-chain receipt — zero custody, zero added fee.',
  },
  // ── Refunds & escrow ──────────────────────────────────────────────────────
  Access0x1Escrow: {
    label: 'Escrow',
    category: 'Refunds & escrow',
    blurb:
      'Hold funds until a signed release authorization, with a timeout refund — buyer-protection escrow that never traps the buyer.',
  },
  Refunds: {
    label: 'Refunds',
    category: 'Refunds & escrow',
    blurb: 'Record and pay refund obligations. Exits are never blockable (money paths roll back).',
  },
  Receivables: {
    label: 'Receivables',
    category: 'Refunds & escrow',
    blurb:
      'Tokenize and settle receivables — advance against an outstanding invoice, then repay on collection.',
  },
  // ── Commerce ──────────────────────────────────────────────────────────────
  Access0x1Bookings: {
    label: 'Bookings',
    category: 'Commerce',
    blurb:
      'Reserve a slot against a held deposit; confirm, cancel or refund — with session-key support for delegated cancels.',
  },
  Access0x1GiftCards: {
    label: 'Gift cards',
    category: 'Commerce',
    blurb: 'Issue, top up and redeem on-chain gift-card balances.',
  },
  Access0x1Invoices: {
    label: 'Invoices',
    category: 'Commerce',
    blurb: 'Create a payable invoice, settle it on the rail, and read its paid / void state.',
  },
  Access0x1Subscriptions: {
    label: 'Subscriptions',
    category: 'Commerce',
    blurb: 'Recurring on-chain billing — start a plan, charge it on schedule, cancel any time.',
  },
  Access0x1Rebates: {
    label: 'Rebates',
    category: 'Commerce',
    blurb: 'Accrue and claim rebates on settled volume.',
  },
  // ── Assets ────────────────────────────────────────────────────────────────
  Access0x1Nft: {
    label: 'NFT',
    category: 'Assets',
    blurb: 'The rail’s ERC-721 — mint, transfer and read token ownership and metadata.',
  },
  Access0x1ProvenanceRegistry: {
    label: 'Provenance registry',
    category: 'Assets',
    blurb: 'Anchor a content hash on-chain and verify an item’s provenance and credential level.',
  },
  HouseTokenFactory: {
    label: 'House-token factory',
    category: 'Assets',
    blurb: 'Deploy a branded house token on the shared base and read the tokens it has minted.',
  },
  // ── Infrastructure ────────────────────────────────────────────────────────
  SessionGrant: {
    label: 'Session grant',
    category: 'Infrastructure',
    blurb:
      'Delegated session keys with a spend budget — authorize an agent to pay on your behalf within a hard cap.',
  },
  AutomationGateway: {
    label: 'Automation gateway',
    category: 'Infrastructure',
    blurb: 'The Chainlink-Automation entrypoint that triggers scheduled rail actions (charges, expiries).',
  },
  PriceOracleAdapter: {
    label: 'Price-oracle adapter',
    category: 'Infrastructure',
    blurb: 'The Chainlink price-feed adapter, with the staleness guard that sits behind every quote.',
  },
  Access0x1SponsorRegistry: {
    label: 'Sponsor registry',
    category: 'Infrastructure',
    blurb: 'A record of who sponsors a merchant’s gas. It never gates settlement.',
  },
  Access0x1Receiver: {
    label: 'Cross-chain receiver',
    category: 'Infrastructure',
    blurb: 'Credits a payment that arrives from another chain (the CCIP receive leg).',
  },
}

/**
 * The default label for a contract with no curated entry: drop the `Access0x1`
 * prefix, split camelCase into words, and capitalize — e.g. `Access0x1FooBar` →
 * "Foo bar", `HouseTokenFactory` → "House token factory". Honest and readable
 * with zero hand-work, so a brand-new contract still gets a sensible card.
 */
export function defaultLabel(name: string): string {
  const stripped = name.replace(/^Access0x1/, '') || name
  const spaced = stripped
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
  if (!spaced) return name
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

/** The full metadata for a name: curated when present, else a name-derived default. */
function metaFor(name: ModuleName): ModuleMeta {
  const c = CURATED[name]
  if (c) return { name, label: c.label, category: c.category, blurb: c.blurb, curated: true }
  return {
    name,
    label: defaultLabel(name),
    category: 'Infrastructure',
    blurb: 'An on-chain module on the shared rail. See the contract card for its reads, writes, and events.',
    curated: false,
  }
}

/** The category order the console renders sections in. */
export const CATEGORY_ORDER: readonly ModuleCategory[] = [
  'Payments',
  'Refunds & escrow',
  'Commerce',
  'Assets',
  'Infrastructure',
]

/**
 * Every module the console lists, AUTO-DERIVED from the committed ABIs. No hand
 * list to keep in sync: add a contract → its ABI is committed → it appears here,
 * grouped and labeled, with a default card until someone writes it a blurb.
 * Ordered by {@link CATEGORY_ORDER} then, within a category, curated-first and
 * alphabetical, so the surface reads stably across builds.
 */
export const MODULE_CATALOG: readonly ModuleMeta[] = [...MODULE_NAMES]
  .map(metaFor)
  .sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(a.category)
    const cb = CATEGORY_ORDER.indexOf(b.category)
    if (ca !== cb) return ca - cb
    if (a.curated !== b.curated) return a.curated ? -1 : 1
    return a.label.localeCompare(b.label)
  })

/** Names that still ride the default metadata — candidates for a curated blurb. */
export function uncuratedModuleNames(): ModuleName[] {
  return MODULE_CATALOG.filter((m) => !m.curated).map((m) => m.name)
}
