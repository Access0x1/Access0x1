/**
 * `@access0x1/react` ENS barrel.
 *
 * Re-exports the ENS resolution SDK so the `PayButton` and onboarding flow can
 * accept an ENS name (or DNS import) as a recipient/payout and resolve it on
 * the merchant's settlement chain before building the pay tx. The resolution
 * logic lives once in `web/lib/ens.ts` (single source of truth, money-path
 * rules enforced there); this package only re-exports it.
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
