'use client';

/**
 * ens.ts — OPTIONAL ENS pay-to-name resolution for the bundled checkout.
 *
 * Resolves a human name (e.g. `alice.eth`) to a recipient/payout address ON THIS PROJECT'S SETTLEMENT
 * CHAIN, off the money path (a read-only call against Ethereum Mainnet, where ENS lives even in ENSv2).
 * Self-contained on viem so the scaffold has zero new deps; the published `@access0x1/react` package
 * does not re-export the web app's ENS layer, so this mirrors its money-path rules locally:
 *
 *   LAW #4 (truth in copy)  — never INVENTS an address. A name that does not resolve THROWS a clear
 *                             error; the checkout surfaces it and refuses to pay.
 *   LAW #5 (money paths)    — ALWAYS resolves with the settlement chain's ENSIP-11 coinType for L2s, so
 *                             the same name maps to the CORRECT per-chain address. It NEVER falls back
 *                             to the mainnet address (which may not exist on the L2 — funds there could
 *                             be unrecoverable).
 *
 * Resolver override (NEXT_PUBLIC_ENS_RESOLVER) and the mainnet RPC (NEXT_PUBLIC_MAINNET_RPC_URL) are
 * read from access0x1.config.ts. No address is baked in here.
 */

import { createPublicClient, http, isAddress, type Address } from 'viem';
import { mainnet } from 'viem/chains';
import { getEnsAddress, normalize } from 'viem/ens';
import { getEnsResolverOverride, getMainnetRpcUrl } from '../access0x1.config';

/** Ethereum Mainnet chain id — the only chain whose ENS coinType is 60 (no derivation). */
const MAINNET_CHAIN_ID = 1;

/** The zero address — a resolution to this is treated as "no address set", same as null. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Thrown when an ENS name does not resolve to a usable address on the settlement chain. */
export class EnsResolutionError extends Error {
  override readonly name = 'EnsResolutionError';
  readonly ensName: string;
  readonly chainId: number;

  constructor(ensName: string, chainId: number) {
    super(
      `Could not resolve "${ensName}" to an address on chain ${chainId}. ` +
        'Check the name and that it has an address set for this chain. ' +
        'Refusing to invent an address or fall back to mainnet (money paths never swallow).',
    );
    this.ensName = ensName;
    this.chainId = chainId;
  }
}

/**
 * ENSIP-11 coinType derivation: `0x80000000 | chainId`, coerced to UNSIGNED 32-bit.
 *
 * `>>> 0` is the money-path fix: a plain bitwise-OR overflows into a NEGATIVE int32 in JS (the sign bit
 * is set), which would feed a wrong coinType into getEnsAddress and route funds to the wrong address.
 */
export function toCoinType(chainId: number): number {
  return (0x80000000 | chainId) >>> 0;
}

/**
 * True when the input should be resolved via ENS. Uses `includes('.')` — not `endsWith('.eth')` — so
 * DNS imports and subnames are caught too. A literal `0x…` address returns false (used as-is).
 */
export function isEnsInput(input: string): boolean {
  return input.includes('.') && input.length > 2 && !isAddress(input);
}

/**
 * Resolve an ENS name (or DNS import) to the payout address on `settlementChainId`. A literal `0x…`
 * address is returned unchanged with no network call. Throws {@link EnsResolutionError} on a null/zero
 * resolution — never invents an address, never falls back to the mainnet address on an L2.
 *
 * @param input             Raw user input (ENS name, DNS name, or 0x address).
 * @param settlementChainId The chain where funds will actually be routed.
 */
export async function resolveEnsRecipient(
  input: string,
  settlementChainId: number,
): Promise<Address> {
  const trimmed = input.trim();

  // 1. Literal address — no resolution, no network call.
  if (isAddress(trimmed)) return trimmed;

  // 2. Not ENS-shaped — refuse rather than guess.
  if (!isEnsInput(trimmed)) throw new EnsResolutionError(trimmed, settlementChainId);

  // 3. Resolve on mainnet (ENS lives there), requesting the settlement chain's coinType for L2s.
  //    Mainnet (chain id 1) uses ENS's default coinType (60) — no derivation. The optional resolver
  //    override targets a Universal Resolver the operator confirmed on Etherscan (else viem targets the
  //    canonical resolver by name — no address baked in here).
  const client = createPublicClient({ chain: mainnet, transport: http(getMainnetRpcUrl()) });
  const resolverOverride = getEnsResolverOverride();
  const resolved = await client.getEnsAddress({
    name: normalize(trimmed),
    ...(settlementChainId === MAINNET_CHAIN_ID
      ? {}
      : { coinType: BigInt(toCoinType(settlementChainId)) }),
    ...(resolverOverride ? { universalResolverAddress: resolverOverride } : {}),
  });

  // 4. Null / zero ⇒ throw. Never silently fall back to a mainnet address.
  if (!resolved || resolved === ZERO_ADDRESS) {
    throw new EnsResolutionError(trimmed, settlementChainId);
  }
  return resolved;
}
