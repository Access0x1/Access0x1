/**
 * @file Read-only hook: resolve a subject's credential LEVEL from a host-supplied source.
 *
 * The unbranded "verified credential" read. Given an address (and an optional issuer scope), it
 * returns one of `verified | pending | revoked | none` for a badge to render. The truth comes from a
 * host-supplied {@link CredentialSource} — an on-chain registry adapter ({@link onchainCredentialSource})
 * or any async resolver. With NO source, the hook resolves to `none` without reading anything: the SDK
 * ships no baked-in credential registry and never fabricates a `verified` (LAW #4).
 *
 * Cancellation + error handling mirror {@link useMerchant}: a stale read never clobbers state, and a
 * read failure surfaces as a typed {@link Access0x1Error} (it does NOT silently read as `verified`).
 */

import { useEffect, useState } from 'react';
import {
  noneRecord,
  type CredentialRecord,
  type CredentialSource,
} from '../credential.js';
import { toAccess0x1Error, type Access0x1Error } from '../errors.js';
import type { Hex } from '../types.js';

/** The reactive surface returned by {@link useCredential}. */
export interface UseCredentialReturn {
  /** The resolved credential record, or `null` while loading / before the first read. */
  credential: CredentialRecord | null;
  /** `true` while a source read is in flight. */
  isLoading: boolean;
  /** A typed error if the source read failed; the credential is cleared (never assumed verified). */
  error: Access0x1Error | null;
}

/**
 * Resolve `subject`'s credential level from `source`.
 *
 * @param subject The address whose credential to read. Omit (`undefined`) to read nothing.
 * @param source  The host-supplied credential source. Omit to resolve `none` with no read (the honest
 *                default — there is no baked-in source).
 * @param issuer  Optional issuer scope — read only a credential issued by this address.
 * @returns See {@link UseCredentialReturn}.
 */
export function useCredential(
  subject?: Hex,
  source?: CredentialSource,
  issuer?: Hex,
): UseCredentialReturn {
  const [credential, setCredential] = useState<CredentialRecord | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Access0x1Error | null>(null);

  useEffect(() => {
    if (subject == null) {
      // Nothing to read for: clear to a neutral state without touching any source.
      setCredential(null);
      setError(null);
      return;
    }

    // No source ⇒ the honest default. Resolve `none` synchronously without a network read; the SDK
    // never invents a `verified` when it has nowhere truthful to read one from (LAW #4).
    if (source == null) {
      setCredential(noneRecord(subject, issuer));
      setError(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    source({ subject, issuer })
      .then((record) => {
        if (cancelled) return;
        setCredential(record);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(toAccess0x1Error(e));
        // Clear rather than leave a stale record — a failed read must NOT read as verified.
        setCredential(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [subject, source, issuer]);

  return { credential, isLoading, error };
}
