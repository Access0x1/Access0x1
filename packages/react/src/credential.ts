/**
 * @file Credential read seam — a generic, UNBRANDED verification-state primitive.
 *
 * Given an address (and an optional issuer scope), this resolves a single credential LEVEL:
 *
 *   `verified` · `pending` · `revoked` · `none`
 *
 * It is the read half of an on-chain "verified credential" badge: the UI renders a level, this
 * module supplies it. The SDK ships **no baked-in source of truth** — there is no canonical
 * credential/attestation registry address hardcoded here, and absent a host-supplied source the
 * answer is always `none`. That is deliberate (LAW #4, truth in copy): the SDK never fabricates a
 * `verified`. The host wires the source it trusts, exactly the way `<PayButton>` takes a router
 * address as a required prop rather than guessing one.
 *
 * Two ways to supply a source, both host-controlled:
 *
 *  1. {@link onchainCredentialSource} — read an on-chain registry through the same
 *     {@link Access0x1Client} seam the payment hooks use. The host supplies the registry address and
 *     the view's `functionName`; this adapter calls it and maps the raw return to a {@link CredentialLevel}.
 *     No address is baked in — the host points it at a registry it trusts.
 *
 *  2. A plain {@link CredentialSource} function — any async resolver (your own API, a subgraph, an
 *     attestation indexer). The SDK stays agnostic about where the truth lives.
 *
 * @packageDocumentation
 */

import type { Abi } from 'viem';
import type { Access0x1Client } from './client.js';
import type { Hex } from './types.js';

/**
 * The verification state of a credential, as a badge renders it.
 *
 * - `verified` — an active, valid credential for this subject (optionally scoped to an issuer).
 * - `pending`  — a credential exists but is not yet active (awaiting issuance/approval).
 * - `revoked`  — a credential existed and was explicitly revoked; it must NOT read as verified.
 * - `none`     — no credential and no source to read one from. The honest default (LAW #4): the SDK
 *                never upgrades `none` to `verified` on its own.
 */
export type CredentialLevel = 'verified' | 'pending' | 'revoked' | 'none';

/** The set of every {@link CredentialLevel}, for runtime validation of a source's return. */
export const CREDENTIAL_LEVELS: readonly CredentialLevel[] = [
  'verified',
  'pending',
  'revoked',
  'none',
];

/** A credential read result, with optional metadata a source may surface. */
export interface CredentialRecord {
  /** The resolved verification level. */
  level: CredentialLevel;
  /** The subject the credential was read for. */
  subject: Hex;
  /** The issuer scope the read was filtered to, if any. */
  issuer?: Hex;
  /** Unix seconds the credential was issued/last updated, if the source reports it. */
  issuedAt?: number;
}

/** The query a {@link CredentialSource} answers. */
export interface CredentialQuery {
  /** The address whose credential is being read. */
  subject: Hex;
  /** Optional issuer scope — read only a credential issued by this address. */
  issuer?: Hex;
}

/**
 * A host-supplied resolver from a {@link CredentialQuery} to a {@link CredentialRecord}.
 *
 * This is the seam that keeps the primitive UNBRANDED and source-agnostic: the host decides whether
 * the truth lives on-chain ({@link onchainCredentialSource}), in its own API, or in a subgraph. The
 * SDK provides no default implementation, so there is no built-in `verified`.
 */
export type CredentialSource = (query: CredentialQuery) => Promise<CredentialRecord>;

/**
 * Coerce an arbitrary value into a {@link CredentialLevel}, defaulting UNKNOWN values to `none`.
 *
 * Accepts a string level (any case) or the small-integer encoding an on-chain enum typically returns
 * (`0 = none`, `1 = pending`, `2 = verified`, `3 = revoked`). Anything unrecognized maps to `none` —
 * never to `verified` — so a malformed or unexpected source value can never read as trusted (LAW #4).
 *
 * @param raw The value a source returned (a string, a bigint/number enum, or anything).
 * @returns A safe {@link CredentialLevel}.
 */
export function normalizeCredentialLevel(raw: unknown): CredentialLevel {
  if (typeof raw === 'string') {
    const lower = raw.toLowerCase();
    return (CREDENTIAL_LEVELS as readonly string[]).includes(lower)
      ? (lower as CredentialLevel)
      : 'none';
  }
  // On-chain enums commonly arrive as a bigint/number; map the conventional ordering.
  if (typeof raw === 'bigint' || typeof raw === 'number') {
    switch (Number(raw)) {
      case 1:
        return 'pending';
      case 2:
        return 'verified';
      case 3:
        return 'revoked';
      default:
        return 'none'; // 0 and every other value
    }
  }
  return 'none';
}

/** `true` only for an active, valid credential — the single place a badge should treat as "trusted". */
export function isVerified(record: CredentialRecord | null | undefined): boolean {
  return record?.level === 'verified';
}

/** The honest empty record: no credential, no source. Never `verified`. */
export function noneRecord(subject: Hex, issuer?: Hex): CredentialRecord {
  return issuer == null ? { level: 'none', subject } : { level: 'none', subject, issuer };
}

/**
 * Options for {@link onchainCredentialSource}.
 *
 * The host points this at a registry IT trusts — no address is baked into the SDK (LAW #4). The
 * registry's read view is expected to take `(subject)` or `(subject, issuer)` and return a level
 * (a string or the conventional enum integer; see {@link normalizeCredentialLevel}).
 */
export interface OnchainCredentialSourceOptions {
  /** The viem-backed client (read-only is sufficient). */
  client: Access0x1Client;
  /** The credential registry address — host-supplied; never hardcoded by the SDK. */
  registryAddress: Hex;
  /**
   * The registry's read view name. Defaults to `credentialLevelOf`. The view must return a value
   * {@link normalizeCredentialLevel} understands (a level string or a 0–3 enum).
   */
  functionName?: string;
  /**
   * The registry ABI. Optional: defaults to a single-fragment ABI for `functionName` taking
   * `(address subject, address issuer)` and returning `uint8`. Supply your own ABI if the view has a
   * different signature (e.g. it omits `issuer`, or returns a string/struct).
   */
  abi?: Abi;
}

/**
 * Build a {@link CredentialSource} that reads an on-chain credential registry through the
 * {@link Access0x1Client} seam.
 *
 * STUB NOTE / TRUTH (LAW #4): the SDK does NOT deploy or pin a credential registry. This adapter is a
 * *seam*, not a source — it only works once the host supplies a `registryAddress` it trusts. There is
 * no Access0x1-canonical credential contract address baked in anywhere. If your registry view has a
 * shape other than the default `credentialLevelOf(address,address) → uint8`, pass a matching
 * `abi` + `functionName`.
 *
 * @param opts See {@link OnchainCredentialSourceOptions}.
 * @returns A {@link CredentialSource}.
 */
export function onchainCredentialSource(opts: OnchainCredentialSourceOptions): CredentialSource {
  const functionName = opts.functionName ?? 'credentialLevelOf';
  const abi: Abi =
    opts.abi ??
    ([
      {
        type: 'function',
        name: functionName,
        stateMutability: 'view',
        inputs: [
          { name: 'subject', type: 'address' },
          { name: 'issuer', type: 'address' },
        ],
        outputs: [{ name: 'level', type: 'uint8' }],
      },
    ] as Abi);

  return async ({ subject, issuer }: CredentialQuery): Promise<CredentialRecord> => {
    // Pass issuer through as the zero address when unscoped, so a `(subject, issuer)` view still binds.
    const issuerArg: Hex =
      issuer ?? ('0x0000000000000000000000000000000000000000' as Hex);
    const raw = await opts.client.readContract<unknown>({
      address: opts.registryAddress,
      abi,
      functionName,
      args: [subject, issuerArg],
    });
    const record: CredentialRecord = { level: normalizeCredentialLevel(raw), subject };
    if (issuer != null) record.issuer = issuer;
    return record;
  };
}
