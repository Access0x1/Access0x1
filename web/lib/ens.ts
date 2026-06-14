import {
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
} from 'viem';
import { mainnet } from 'viem/chains';
import { getEnsAddress, namehash, normalize } from 'viem/ens';

/**
 * ENS resolution SDK for Access0x1.
 *
 * Resolves an ENS name (or DNS import) to the payout address ON THE MERCHANT'S
 * SETTLEMENT CHAIN, plus the deterministic name-math (brand color + identicon)
 * mirrored from the on-chain brand sidecar derivation.
 *
 * MONEY-PATH LAW (#5 — money paths never swallow): resolution ALWAYS starts on
 * Ethereum Mainnet (ENS lives there even in ENSv2) and ALWAYS passes the
 * settlement chain's `coinType`. The same name resolves to DIFFERENT addresses
 * per chain; omitting `coinType` on an L2 returns the mainnet address, which is
 * NOT guaranteed to exist on the L2 — funds routed there can be unrecoverable.
 * A null resolution THROWS; it never silently falls back to the mainnet address.
 *
 * No custody, no hard-coded addresses (the Universal Resolver is an upgradable
 * proxy targeted by name, not address), no hard-coded coinTypes (always derived
 * via {@link toCoinType}). All ENS work is off-chain — it adds zero gas to the
 * settlement path and never runs inside a Solidity pay path.
 */

/** Ethereum Mainnet chain id — the only chain whose ENS coinType is 60 (no derivation). */
const MAINNET_CHAIN_ID = 1;

/**
 * Thrown when an ENS name resolves to nothing (null / zero address) on the
 * requested settlement chain. Per LAW #5 the SDK throws here rather than
 * silently routing real USDC to a mainnet address that may not exist on the L2.
 */
export class EnsResolutionError extends Error {
  /** The name (or input) that failed to resolve. */
  readonly name = 'EnsResolutionError';
  /** The ENS name that was being resolved. */
  readonly ensName: string;
  /** The settlement chain id resolution was requested for. */
  readonly chainId: number;

  constructor(ensName: string, chainId: number) {
    super(
      `ENS name "${ensName}" did not resolve to an address on chain ${chainId}. ` +
        'Refusing to fall back to a mainnet address (money paths never swallow).',
    );
    this.ensName = ensName;
    this.chainId = chainId;
  }
}

/**
 * ENSIP-11 coinType derivation: `0x80000000 | chainId`.
 *
 * NEVER hard-coded — always derived from the chain id so adding a chain needs
 * no coinType table. Mainnet (chain id 1) is the special case ENS treats as
 * coinType 60, but for resolution we pass the derived coinType only for L2s and
 * let viem use the mainnet default for chain id 1 (see {@link resolveENS}).
 *
 * @param chainId The settlement chain id.
 * @returns The ENSIP-11 coinType for that chain.
 */
export function toCoinType(chainId: number): number {
  // `>>> 0` coerces the bitwise-OR result back to an UNSIGNED 32-bit integer.
  // Plain `0x80000000 | chainId` overflows into a NEGATIVE int32 in JS (the
  // sign bit is set), which would feed a wrong coinType into getEnsAddress and
  // route real USDC to the wrong address. The unsigned cast is the money-path
  // fix — ENSIP-11 coinTypes are unsigned.
  return (0x80000000 | chainId) >>> 0;
}

/**
 * Returns true if the input should be resolved via ENS.
 *
 * Uses `includes('.')` — NOT `endsWith('.eth')` — so DNS imports
 * (`ensfairy.xyz`), subnames, and emoji domains are all caught. A literal
 * `0x…` address returns false (no resolution; it is returned as-is).
 *
 * @param input Raw user input (ENS name, DNS name, or 0x address).
 */
export function isEnsInput(input: string): boolean {
  return input.includes('.') && input.length > 2 && !isAddress(input);
}

/**
 * Build a Mainnet public client for ENS resolution.
 *
 * ENS lives on Ethereum Mainnet even in ENSv2; this client is used for ALL
 * resolution and NEVER for settlement transactions. The Universal Resolver
 * address is never passed — viem targets it by name (UniversalResolver v3),
 * implementing CCIP-Read transparently, so a name may defer to an offchain/L2
 * gateway over HTTP. The resolution runtime must therefore allow outbound HTTP.
 *
 * @param rpcUrl Optional Mainnet RPC URL (e.g. `NEXT_PUBLIC_MAINNET_RPC_URL`).
 *               Falls back to viem's default public transport.
 */
export function mainnetClient(rpcUrl?: string): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });
}

/**
 * Resolve an ENS name (or DNS import) to the payout address on the target
 * settlement chain. Throws {@link EnsResolutionError} if it resolves to null.
 *
 * MONEY-PATH RULE: `coinType` is ALWAYS set from `settlementChainId` for L2s.
 * Never call `getEnsAddress` without a coinType on an L2 (doctrine #9, the
 * coinType ban) — this function enforces it.
 *
 * A literal `0x…` address is returned unchanged with no network call.
 *
 * @param input             Raw user input (ENS name, DNS name, or 0x address).
 * @param settlementChainId The chain id where funds will actually be routed.
 * @param rpcUrl            Optional Mainnet RPC URL for the resolution client.
 * @returns The resolved payout address on the settlement chain.
 */
export async function resolveENS(
  input: string,
  settlementChainId: number,
  rpcUrl?: string,
): Promise<Address> {
  // 1. Literal address — no resolution, no network call.
  if (isAddress(input)) {
    return input;
  }

  // 2. Not an ENS-shaped input — refuse rather than guess.
  if (!isEnsInput(input)) {
    throw new EnsResolutionError(input, settlementChainId);
  }

  const client = mainnetClient(rpcUrl);
  const name = normalize(input);

  // 3. Resolve on mainnet, requesting the settlement chain's coinType for L2s.
  //    Mainnet (chain id 1) uses ENS's default coinType (60) — no derivation.
  // viem wants coinType as a bigint; toCoinType stays `number` (the spec's
  // public contract) and is widened here at the single call site.
  const resolved = await client.getEnsAddress(
    settlementChainId === MAINNET_CHAIN_ID
      ? { name }
      : { name, coinType: BigInt(toCoinType(settlementChainId)) },
  );

  // 4. Null / zero ⇒ throw. Never silently fall back to a mainnet address.
  if (!resolved || resolved === '0x0000000000000000000000000000000000000000') {
    throw new EnsResolutionError(input, settlementChainId);
  }

  return resolved;
}

/**
 * Compute the ENS namehash `node` for a label, client-side.
 *
 * The router stores this as `nameHash` (a write-only identity commitment, no
 * preimage on-chain). Resolution and name-math are 100% SDK/client-side.
 *
 * @param label Human-readable ENS label (will be normalized).
 * @returns The ENS namehash node as a `0x`-prefixed bytes32 hex string.
 */
export function ensNode(label: string): Hex {
  return namehash(normalize(label));
}

/**
 * Deterministic brand color from the ENS namehash.
 *
 * Mirrors the on-chain brand sidecar derivation:
 * `bytes3(keccak256(abi.encode("color", node)))` → the first 3 bytes as a
 * 6-hex-char CSS color. Same node always yields the same color.
 *
 * @param node The ENS namehash (bytes32 hex).
 * @returns A `#rrggbb` CSS color string.
 */
export function nameHashColor(node: Hex): `#${string}` {
  const hash = keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'bytes32' }],
      ['color', node],
    ),
  );
  // hash is `0x` + 64 hex chars; the first 3 bytes = chars [2, 8).
  return `#${hash.slice(2, 8)}`;
}

/**
 * Deterministic 5x5 identicon SVG seeded from the ENS namehash.
 *
 * The grid is mirrored left/right (columns 0/4, 1/3 share a fill bit) so the
 * identicon reads as a symmetric glyph. Fill bits are taken from the namehash
 * bytes; the foreground color is {@link nameHashColor}. No external deps — the
 * returned value is a self-contained inline `<svg>` string (200x200, 40px cells).
 *
 * @param node The ENS namehash (bytes32 hex).
 * @returns An inline `<svg>…</svg>` string.
 */
export function nameHashIdenticon(node: Hex): string {
  const color = nameHashColor(node);
  const hex = node.slice(2); // 64 hex chars = 32 bytes
  const cell = 40;
  const size = cell * 5;

  // 15 fill bits seed the left half + center column (columns 0,1,2); columns
  // 3,4 mirror columns 1,0. One namehash byte per (col, row) cell.
  const rects: string[] = [];
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 5; row++) {
      const byteIndex = (col * 5 + row) % 32;
      const byte = parseInt(hex.slice(byteIndex * 2, byteIndex * 2 + 2), 16);
      const filled = (byte & 1) === 1;
      if (!filled) continue;
      const y = row * cell;
      // Place the cell and its mirror (column 4-col), skipping the duplicate
      // for the center column (col === 2 mirrors to itself).
      const cols = col === 2 ? [2] : [col, 4 - col];
      for (const c of cols) {
        rects.push(
          `<rect x="${c * cell}" y="${y}" width="${cell}" height="${cell}"/>`,
        );
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}" fill="${color}" role="img" ` +
    `aria-label="identicon">${rects.join('')}</svg>`
  );
}

// ── ENSIP-19: verified merchant primary name (reverse + forward check) ────────

/**
 * Default ENS Universal Resolver address.
 *
 * ⚠️ CONFIRM-ON-ETHERSCAN: this is the address documented by ENS for the
 * Universal Resolver (the proxy that implements ENSIP-10 wildcard resolution,
 * ENSIP-19 reverse, and CCIP-Read). It is NOT asserted here as audited fact —
 * VERIFY it against the ENS docs / Etherscan for the network you point at, and
 * OVERRIDE it via `NEXT_PUBLIC_ENS_UNIVERSAL_RESOLVER` rather than trusting this
 * literal in production. Unlike the resolution path (which targets the resolver
 * by ENS *name* via viem), the ENSIP-19 reverse call addresses the resolver
 * directly, so the address must be supplied — hence this overridable default.
 */
export const DEFAULT_ENS_UNIVERSAL_RESOLVER =
  '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe' as const;

/**
 * Resolve the Universal Resolver address to call for ENSIP-19 reverse.
 *
 * Reads `NEXT_PUBLIC_ENS_UNIVERSAL_RESOLVER` first (the override an operator
 * fills after confirming on Etherscan); falls back to
 * {@link DEFAULT_ENS_UNIVERSAL_RESOLVER}. Returns null when the configured value
 * is not a valid address so callers fail soft (no name) instead of throwing —
 * the merchant-identity badge is OFF the money path and must never block a page.
 */
export function universalResolverAddress(): Address | null {
  const raw = (process.env.NEXT_PUBLIC_ENS_UNIVERSAL_RESOLVER ?? '').trim();
  const candidate = raw.length > 0 ? raw : DEFAULT_ENS_UNIVERSAL_RESOLVER;
  return isAddress(candidate) ? (candidate as Address) : null;
}

/**
 * ENSIP-19 reverse ABI on the Universal Resolver.
 *
 * `reverse(bytes lookupAddress, uint256 coinType)` returns the primary `name`
 * for an address under the given coinType AND the addresses needed to verify it
 * forward-resolves back — the resolver performs the reverse→forward round-trip
 * internally and reverts when they disagree. We additionally re-check
 * forward==reverse ourselves (belt-and-suspenders) before trusting a name.
 */
const UNIVERSAL_RESOLVER_REVERSE_ABI = parseAbi([
  'function reverse(bytes lookupAddress, uint256 coinType) view returns (string name, address resolvedAddress, address reverseResolver, address resolver)',
]);

/**
 * The ENSIP-19 verified PRIMARY name for an address on a given chain, or null.
 *
 * This is the READ seam behind the checkout "Paying acme.eth ✓" badge. It:
 *   1. derives the chain's coinType via ENSIP-11 ({@link toCoinType}; mainnet
 *      uses coinType 60, the ENS default);
 *   2. calls the Universal Resolver's ENSIP-19 `reverse(address, coinType)`,
 *      which returns the primary name AND the address it forward-resolves to;
 *   3. returns the name ONLY when that forward address equals the input address
 *      (checksum-insensitive) — i.e. forward == reverse. Any mismatch, empty
 *      name, missing/!misconfigured resolver, or RPC error ⇒ null.
 *
 * It NEVER fabricates a name and NEVER throws (LAW #4): a badge is purely
 * cosmetic and sits off the money path, so every failure mode degrades to "show
 * the truncated address" rather than crashing checkout. No name is ever returned
 * that does not provably round-trip back to `address` on `chainId`.
 *
 * @param address  The merchant payout address to look up a primary name for.
 * @param chainId  The chain whose reverse namespace to read (ENSIP-11 coinType).
 * @param rpcUrl   Optional Mainnet RPC URL for the resolution client.
 * @returns The verified primary name (e.g. `acme.eth`) or null.
 */
export async function verifiedPrimaryName(
  address: string,
  chainId: number,
  rpcUrl?: string,
): Promise<string | null> {
  // Guard inputs: a non-address in ⇒ no name (never guess, never throw).
  if (!isAddress(address)) return null;

  const resolver = universalResolverAddress();
  if (!resolver) return null; // unconfigured / invalid resolver ⇒ fail soft.

  // ENSIP-11 coinType: 60 for mainnet (chain id 1), else the derived L2 value.
  const coinType =
    chainId === MAINNET_CHAIN_ID ? 60n : BigInt(toCoinType(chainId));

  try {
    const client = mainnetClient(rpcUrl);
    const [name, resolvedAddress] = await client.readContract({
      address: resolver,
      abi: UNIVERSAL_RESOLVER_REVERSE_ABI,
      functionName: 'reverse',
      args: [address as Address, coinType],
    });

    // No primary name set ⇒ nothing to show.
    if (!name || name.trim().length === 0) return null;

    // FORWARD == REVERSE: only trust a name that resolves back to this exact
    // address. getAddress checksums both sides so the compare is case-correct;
    // a non-address / zero resolvedAddress fails the guard and yields null.
    if (!isAddress(resolvedAddress)) return null;
    if (getAddress(resolvedAddress) !== getAddress(address)) return null;

    return name;
  } catch {
    // Any RPC / decode / revert (incl. the resolver's own forward-check revert)
    // ⇒ no verified name. Cosmetic badge, off the money path: never throw.
    return null;
  }
}
