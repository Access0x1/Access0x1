/**
 * The module registry — the single seam that joins the three sources of truth
 * for a shared-rail module:
 *
 *   1. its INTERFACE   — the committed ABI (lib/generated/module-abis.ts)
 *   2. its ADDRESS     — the broadcast deployment (lib/deployments.ts), proxy-aware
 *   3. its METADATA    — the curated label + blurb (lib/modules/catalog.ts)
 *
 * Everything the contract console renders comes through {@link listModules} /
 * {@link getModule}. No address is ever hand-typed; a module with no address on a
 * chain resolves to `address: null`, which the panel renders as an honest "not on
 * this chain yet" — never an invented seat (law #4 / guardrail #5).
 */
import type { Abi, AbiFunction, AbiEvent, Address } from 'viem'
import { MODULE_ABIS, type ModuleName } from '@/lib/generated/module-abis'
import { DEPLOYMENTS } from '@/lib/deployments'
import { MODULE_CATALOG, CATEGORY_ORDER, type ModuleMeta, type ModuleCategory } from './catalog'

/**
 * Resolve a module's on-chain address on `chainId` from the broadcast map. UUPS
 * chains record `<Name>.impl` + `<Name>.proxy`; the PROXY is the live address a
 * caller interacts with, so we prefer `<Name>.proxy`, then a plain `<Name>`
 * single-address entry, and never return an `.impl`. A module absent from the
 * chain's deployments resolves to `null` (honest "not on this chain yet").
 */
export function moduleAddressFor(chainId: number, name: string): Address | null {
  const chain = DEPLOYMENTS.find((c) => c.chainId === chainId)
  if (!chain) return null
  const proxy = chain.deployments.find((d) => d.contractName === `${name}.proxy`)
  if (proxy) return proxy.address as Address
  const plain = chain.deployments.find((d) => d.contractName === name)
  if (plain) return plain.address as Address
  return null
}

/** A module's ABI split into the three things the panel renders. */
export interface ModuleAbiParts {
  /** `view` / `pure` functions — callable with just a public client. */
  readonly reads: readonly AbiFunction[]
  /** `nonpayable` / `payable` functions — need a connected wallet. */
  readonly writes: readonly AbiFunction[]
  /** Declared events (shown as the module's on-chain signals). */
  readonly events: readonly AbiEvent[]
}

/** Is this ABI function a read (view/pure) rather than a state-changing write? */
export function isRead(fn: AbiFunction): boolean {
  return fn.stateMutability === 'view' || fn.stateMutability === 'pure'
}

/**
 * Split an ABI into reads / writes / events, dropping constructor, fallback,
 * receive and error entries (nothing a caller "invokes" from a panel). Functions
 * are sorted by name so the panel order is stable across builds.
 */
export function splitAbi(abi: Abi): ModuleAbiParts {
  const fns = abi.filter((e): e is AbiFunction => e.type === 'function')
  const byName = (a: AbiFunction, b: AbiFunction) => a.name.localeCompare(b.name)
  return {
    reads: fns.filter(isRead).slice().sort(byName),
    writes: fns.filter((f) => !isRead(f)).slice().sort(byName),
    events: abi.filter((e): e is AbiEvent => e.type === 'event'),
  }
}

/** True when a module has an address on NO chain in the broadcast map — i.e. it is
 *  BUILT but not deployed anywhere yet (the "preview" state). Derived, so a contract
 *  stops being preview automatically the moment its first deployment is recorded. */
export function isDeployedAnywhere(name: string): boolean {
  return DEPLOYMENTS.some(
    (c) =>
      c.deployments.some((d) => d.contractName === `${name}.proxy` || d.contractName === name),
  )
}

/** A fully-resolved module: metadata + interface + (chain-resolved) address. */
export interface ResolvedModule {
  readonly meta: ModuleMeta
  readonly abi: Abi
  readonly parts: ModuleAbiParts
  /** The live address on the queried chain, or `null` when not deployed there. */
  readonly address: Address | null
  /** True when the module is deployed on NO chain yet — render "built · not deployed yet". */
  readonly preview: boolean
}

/** The ABI for a module by name (always present — the union guarantees it). */
export function getModuleAbi(name: ModuleName): Abi {
  return MODULE_ABIS[name]
}

/** Resolve one module (metadata + abi + address) on a chain, or null if unknown. */
export function getModule(name: ModuleName, chainId: number): ResolvedModule | null {
  const meta = MODULE_CATALOG.find((m) => m.name === name)
  if (!meta) return null
  const abi = MODULE_ABIS[name]
  return {
    meta,
    abi,
    parts: splitAbi(abi),
    address: moduleAddressFor(chainId, name),
    preview: !isDeployedAnywhere(name),
  }
}

/**
 * Every catalog module, resolved against `chainId`, in the catalog's display
 * order. Modules with no address on the chain are still returned (address:
 * null) so the console lists the complete surface and self-reveals each module
 * as it lands on a chain.
 */
export function listModules(chainId: number): ResolvedModule[] {
  return MODULE_CATALOG.map((meta) => ({
    meta,
    abi: MODULE_ABIS[meta.name],
    parts: splitAbi(MODULE_ABIS[meta.name]),
    address: moduleAddressFor(chainId, meta.name),
    preview: !isDeployedAnywhere(meta.name),
  }))
}

/** Group resolved modules by category, in {@link CATEGORY_ORDER}. Empty groups drop out. */
export function groupByCategory(
  modules: readonly ResolvedModule[],
): { category: ModuleCategory; modules: ResolvedModule[] }[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    modules: modules.filter((m) => m.meta.category === category),
  })).filter((g) => g.modules.length > 0)
}

/** How many of `modules` are actually live (have an address) on the chain. */
export function liveCount(modules: readonly ResolvedModule[]): number {
  return modules.filter((m) => m.address !== null).length
}
