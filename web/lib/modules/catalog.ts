/**
 * The module catalog — the curated, human-facing metadata for every shared-rail
 * contract the console surfaces. It pairs each committed ABI (from
 * `lib/generated/module-abis.ts`) with a category and one honest line about what
 * the module does. The ABI + the deployed address are the machine truth; this
 * file is only the label + the blurb.
 *
 * The `name` of every entry is a {@link ModuleName} — a compile-time union drawn
 * from the ABIs that actually exist in `abis/`. A typo, or a module with no
 * committed ABI, is a TYPE error here, never a runtime "module not found".
 *
 * A module listed here with no address on a given chain renders an honest
 * "not on this chain yet" in the panel (address resolution is `deployments.ts`,
 * the broadcast ground truth) — we never invent a seat for it.
 */
import type { ModuleName } from '@/lib/generated/module-abis'

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
}

/**
 * Every module the console lists, in display order (grouped by category). This
 * is the FULL shared-rail surface: the deployed set resolves to real addresses,
 * and the few that have an ABI but no broadcast entry yet (Rebates, Receiver,
 * SponsorRegistry) list too — honestly flagged "not on this chain yet" until
 * they land, so the surface is complete and self-updates when they deploy.
 */
export const MODULE_CATALOG: readonly ModuleMeta[] = [
  // ── Payments ──────────────────────────────────────────────────────────────
  {
    name: 'Access0x1Router',
    label: 'Router',
    category: 'Payments',
    blurb:
      'The payment rail. Register a merchant, then pay in USDC or the native coin priced in USD through Chainlink, with the platform fee split baked in.',
  },
  {
    name: 'GaslessPayIn',
    label: 'Gasless pay-in',
    category: 'Payments',
    blurb:
      'A relayer-submitted, merchant-bound pay-in so a buyer can settle without holding gas — the authorization can only credit the intended merchant.',
  },
  {
    name: 'PaymentLanes',
    label: 'Payment lanes',
    category: 'Payments',
    blurb:
      'Per-lane payment routing and limits — separate rails for separate flows on a high-volume merchant.',
  },
  {
    name: 'SplitSettler',
    label: 'Split settler',
    category: 'Payments',
    blurb: 'Split one payment across several payees atomically, in a single settlement.',
  },
  // ── Refunds & escrow ──────────────────────────────────────────────────────
  {
    name: 'Access0x1Escrow',
    label: 'Escrow',
    category: 'Refunds & escrow',
    blurb:
      'Hold funds until a signed release authorization, with a timeout refund — buyer-protection escrow that never traps the buyer.',
  },
  {
    name: 'Refunds',
    label: 'Refunds',
    category: 'Refunds & escrow',
    blurb: 'Record and pay refund obligations. Exits are never blockable (money paths roll back).',
  },
  {
    name: 'Receivables',
    label: 'Receivables',
    category: 'Refunds & escrow',
    blurb: 'Tokenize and settle receivables — advance against an outstanding invoice, then repay on collection.',
  },
  // ── Commerce ──────────────────────────────────────────────────────────────
  {
    name: 'Access0x1Bookings',
    label: 'Bookings',
    category: 'Commerce',
    blurb:
      'Reserve a slot against a held deposit; confirm, cancel or refund — with session-key support for delegated cancels.',
  },
  {
    name: 'Access0x1GiftCards',
    label: 'Gift cards',
    category: 'Commerce',
    blurb: 'Issue, top up and redeem on-chain gift-card balances.',
  },
  {
    name: 'Access0x1Invoices',
    label: 'Invoices',
    category: 'Commerce',
    blurb: 'Create a payable invoice, settle it on the rail, and read its paid / void state.',
  },
  {
    name: 'Access0x1Subscriptions',
    label: 'Subscriptions',
    category: 'Commerce',
    blurb: 'Recurring on-chain billing — start a plan, charge it on schedule, cancel any time.',
  },
  {
    name: 'Access0x1Rebates',
    label: 'Rebates',
    category: 'Commerce',
    blurb: 'Accrue and claim rebates on settled volume.',
  },
  // ── Assets ────────────────────────────────────────────────────────────────
  {
    name: 'Access0x1Nft',
    label: 'NFT',
    category: 'Assets',
    blurb: 'The rail’s ERC-721 — mint, transfer and read token ownership and metadata.',
  },
  {
    name: 'Access0x1ProvenanceRegistry',
    label: 'Provenance registry',
    category: 'Assets',
    blurb: 'Anchor a content hash on-chain and verify an item’s provenance and credential level.',
  },
  {
    name: 'HouseTokenFactory',
    label: 'House-token factory',
    category: 'Assets',
    blurb: 'Deploy a branded house token on the shared base and read the tokens it has minted.',
  },
  // ── Infrastructure ────────────────────────────────────────────────────────
  {
    name: 'SessionGrant',
    label: 'Session grant',
    category: 'Infrastructure',
    blurb:
      'Delegated session keys with a spend budget — authorize an agent to pay on your behalf within a hard cap.',
  },
  {
    name: 'AutomationGateway',
    label: 'Automation gateway',
    category: 'Infrastructure',
    blurb: 'The Chainlink-Automation entrypoint that triggers scheduled rail actions (charges, expiries).',
  },
  {
    name: 'PriceOracleAdapter',
    label: 'Price-oracle adapter',
    category: 'Infrastructure',
    blurb: 'The Chainlink price-feed adapter, with the staleness guard that sits behind every quote.',
  },
  {
    name: 'Access0x1SponsorRegistry',
    label: 'Sponsor registry',
    category: 'Infrastructure',
    blurb: 'A record of who sponsors a merchant’s gas. It never gates settlement.',
  },
  {
    name: 'Access0x1Receiver',
    label: 'Cross-chain receiver',
    category: 'Infrastructure',
    blurb: 'Credits a payment that arrives from another chain (the CCIP receive leg).',
  },
]

/** The category order the console renders sections in. */
export const CATEGORY_ORDER: readonly ModuleCategory[] = [
  'Payments',
  'Refunds & escrow',
  'Commerce',
  'Assets',
  'Infrastructure',
]
