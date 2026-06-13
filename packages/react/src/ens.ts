/**
 * `@access0x1/react` ENS barrel.
 *
 * Re-exports the ENS resolution SDK so the `PayButton` and onboarding flow can
 * accept an ENS name (or DNS import) as a recipient/payout and resolve it on
 * the merchant's settlement chain before building the pay tx. The resolution
 * logic lives once in `web/lib/ens.ts` (single source of truth, money-path
 * rules enforced there); this package only re-exports it.
 *
 * INTEGRATION NOTE: this barrel reaches across the package boundary into the
 * web app (`../../../web/lib/ens`), so it is intentionally EXCLUDED from the
 * publishable SDK build (see `packages/react/tsconfig.json` exclude). It is not
 * re-exported from `src/index.ts`. When the ENS layer is promoted into the
 * published package, move `web/lib/ens.ts` under `src/` (or consume the
 * published `@access0x1/web`) and drop the exclude.
 *
 * @packageDocumentation
 */

export {
  EnsResolutionError,
  ensNode,
  isEnsInput,
  mainnetClient,
  nameHashColor,
  nameHashIdenticon,
  resolveENS,
  toCoinType,
} from '../../../web/lib/ens';
