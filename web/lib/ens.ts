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
  // ENSIP-11 coinType = `0x80000000 | chainId` requires a 31-bit chain id. The
  // bitwise `|` runs `ToInt32(chainId)` first, so a chainId >= 2^31 WRAPS and
  // silently collides with `(chainId mod 2^31)`'s coinType — routing real USDC
  // to a DIFFERENT chain's address. Refuse to mis-encode: an out-of-range /
  // negative / non-integer chain id throws rather than producing a wrong
  // coinType (money-path safety; the cosmetic reverse path catches this to null).
  if (!Number.isInteger(chainId) || chainId < 0 || chainId >= 0x80000000) {
    throw new Error(`toCoinType: chainId out of ENSIP-11 range (0..2^31-1): ${chainId}`);
  }
  // `>>> 0` coerces the bitwise-OR result back to an UNSIGNED 32-bit integer
  // (the sign bit is set, so a plain `|` reads NEGATIVE in JS). ENSIP-11
  // coinTypes are unsigned.
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
 * Name-math constants, mirrored from `src/NameMath.sol`.
 *
 * These are NOT free parameters — every one of them is a consensus-visible
 * value in the on-chain library. Changing one here without changing it there
 * re-opens the exact divergence {@link nameHashIdenticon} documents.
 */
const NAME_MATH_BG = 0xf4f4f5; // NameMath.BG — neutral zinc-100 backdrop
const NAME_MATH_NUDGE = 0x111111; // NameMath.NUDGE — legibility XOR (audit I-4)
const NAME_MATH_N = 5; // NameMath.N — grid is 5x5
const NAME_MATH_CELL = 100; // NameMath.CELL — cell edge in viewBox units
const NAME_MATH_SIZE = 500; // NameMath.SIZE — N * CELL

/** Render a 24-bit RRGGBB int the way `NameMath._hexColor` does: `#` + UPPERCASE hex. */
function nameMathHex(rgb: number): `#${string}` {
  return `#${rgb.toString(16).toUpperCase().padStart(6, '0')}`;
}

/**
 * Deterministic brand color from the ENS namehash.
 *
 * Mirrors `NameMath.colorOf` byte-for-byte:
 * `bytes3(keccak256(abi.encode("color", node)))`, then the background-collision
 * NUDGE. Same node always yields the same color, on-chain and off.
 *
 * TWO CORRECTNESS NOTES, both of which this function got wrong before
 * 2026-08-28 and both of which are now pinned by parity tests:
 *
 * 1. **The NUDGE is not optional.** `NameMath.colorOf` ends with
 *    `color == BG ? color ^ NUDGE : color`. For the ~1-in-2^24 namehash whose
 *    color hashes exactly to the backdrop `#F4F4F5`, the chain paints
 *    `#E5E5E4` while an un-nudged mirror paints `#F4F4F5` — an invisible
 *    avatar AND a brand that disagrees with its own contract. The Solidity
 *    NatSpec is explicit that the SDK "MUST use the SAME nudged value".
 * 2. **`bytes3(hash)` is the HIGH 3 bytes, not the low ones.** Solidity's
 *    `bytesN` conversion truncates from the LEFT. `uint24(uint256(hash))`
 *    would take the low 3 and is a different colour entirely (for
 *    `alice.eth`: high `#21F8EC` vs low `#E04942`). The library's own doc
 *    block said "low 3 bytes" while its code said `bytes3(...)`; the code is
 *    canonical and the doc has been corrected to match.
 *
 * @param node The ENS namehash (bytes32 hex).
 * @returns A `#RRGGBB` CSS color string (uppercase, as the contract emits it).
 */
export function nameHashColor(node: Hex): `#${string}` {
  const hash = keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'bytes32' }],
      ['color', node],
    ),
  );
  // `bytes3(keccak256(...))` truncates from the LEFT → chars [2, 8) = high 3 bytes.
  const raw = Number.parseInt(hash.slice(2, 8), 16);
  return nameMathHex(raw === NAME_MATH_BG ? raw ^ NAME_MATH_NUDGE : raw);
}

/**
 * Deterministic 5x5 identicon SVG from the ENS namehash.
 *
 * Mirrors `NameMath.identiconRawSVG` byte-for-byte, so the avatar a merchant
 * sees off-chain is the same markup the contract would emit for that node.
 *
 * REWRITTEN 2026-08-28 — the previous implementation was not a mirror at all.
 * It diverged from the contract in four independent ways, any one of which
 * produces a different picture:
 *
 * | | contract (`NameMath`) | old TS |
 * |---|---|---|
 * | seed | `keccak256(abi.encode("identicon", node))` | the raw `node` bytes — no hash, no domain tag |
 * | bit index | `(seed >> (r * 3 + c)) & 1` | `byte[(col*5+row) % 32] & 1` |
 * | canvas | 500x500, `CELL` 100 | 200x200, cell 40 |
 * | backdrop | explicit `<rect fill="#F4F4F5">` | none; colour hung on the `<svg>` `fill` |
 *
 * The domain tag is the load-bearing one: `"identicon"` keeps the avatar seed
 * independent of the `"color"` seed, so the two derivations can never
 * correlate. Reading the node directly threw that away and made the glyph a
 * function of the raw namehash bits.
 *
 * Cell geometry: columns 0,1,2 are seed-driven and columns 3,4 mirror columns
 * 1,0, giving a vertically symmetric glyph. Emission order matches the
 * contract's loop exactly (`c` then its mirror, row-major) because the parity
 * test compares the STRING, not a parsed DOM.
 *
 * @param node The ENS namehash (bytes32 hex).
 * @returns An inline `<svg>…</svg>` string, identical to the contract's.
 */
export function nameHashIdenticon(node: Hex): string {
  const fg = nameHashColor(node);
  const seed = BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: 'string' }, { type: 'bytes32' }],
        ['identicon', node],
      ),
    ),
  );

  const cell = (row: number, col: number) =>
    `<rect x="${col * NAME_MATH_CELL}" y="${row * NAME_MATH_CELL}" ` +
    `width="${NAME_MATH_CELL}" height="${NAME_MATH_CELL}" fill="${fg}"/>`;

  let svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${NAME_MATH_SIZE}" ` +
    `height="${NAME_MATH_SIZE}" viewBox="0 0 ${NAME_MATH_SIZE} ${NAME_MATH_SIZE}">` +
    `<rect width="${NAME_MATH_SIZE}" height="${NAME_MATH_SIZE}" ` +
    `fill="${nameMathHex(NAME_MATH_BG)}"/>`;

  for (let r = 0; r < NAME_MATH_N; r++) {
    for (let c = 0; c < 3; c++) {
      if (((seed >> BigInt(r * 3 + c)) & 1n) === 1n) {
        svg += cell(r, c);
        // mirror column c → column (N-1-c): col0→col4, col1→col3; col2 is the axis
        if (c < 2) svg += cell(r, NAME_MATH_N - 1 - c);
      }
    }
  }

  return `${svg}</svg>`;
}

// ── ENSIP-19: verified merchant primary name (reverse + forward check) ────────

/**
 * Default ENS Universal Resolver address — the ENSv2 canonical entrypoint.
 *
 * ✅ CONFIRMED 2026-08-28 (was marked CONFIRM-ON-ETHERSCAN). Two independent
 * sources, both recorded so the claim can be re-checked rather than trusted:
 *
 * 1. **ENS's own documentation**, verbatim: "`0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe`
 *    is the official deployment address on Ethereum Mainnet and testnets, which
 *    is a proxy contract owned by ENS DAO that will be upgraded to support
 *    ENSv2 in the future." — docs.ens.domains, Universal Resolver page.
 * 2. **On-chain**, against a mainnet fork: the address carries 2,491 bytes of
 *    code and its EIP-1967 implementation slot is populated
 *    (`0xed73a03f19e8d849e44a39252d222c6ad5217e1e`), i.e. it really is the
 *    upgradeable proxy the docs describe, not an EOA or an empty address.
 *
 * Re-verify in one command:
 *   cast codesize 0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe --rpc-url <mainnet>
 *
 * Because it is a DAO-owned proxy, the ADDRESS is stable across implementation
 * upgrades — which is precisely why ENS tells integrators to target it and why
 * pinning it here is safe. It stays overridable via
 * `NEXT_PUBLIC_ENS_UNIVERSAL_RESOLVER` for forks and private testnets.
 *
 * Unlike the resolution path (which targets the resolver by ENS *name* via
 * viem, satisfying the "no hard-coded values" rule), the ENSIP-19 reverse call
 * addresses the resolver directly, so an address must be supplied — hence this
 * overridable default.
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

  try {
    // ENSIP-11 coinType: 60 for mainnet (chain id 1), else the derived L2 value.
    // Inside the try so an out-of-range chainId (toCoinType throws) degrades to
    // null — the reverse/cosmetic path NEVER throws (it only ever shows or hides
    // a name), unlike the forward money path which fails loud.
    const coinType = chainId === MAINNET_CHAIN_ID ? 60n : BigInt(toCoinType(chainId));

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
