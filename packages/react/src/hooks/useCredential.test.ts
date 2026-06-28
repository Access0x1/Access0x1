/**
 * @file Unit tests for {@link useCredential}.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCredential } from './useCredential.js';
import type { CredentialRecord, CredentialSource } from '../credential.js';
import type { Hex } from '../types.js';

const SUBJECT: Hex = '0x1111111111111111111111111111111111111111';
const SUBJECT_2: Hex = '0x2222222222222222222222222222222222222222';
const ISSUER: Hex = '0x3333333333333333333333333333333333333333';

/** A source that always resolves the given level. */
function fixedSource(level: CredentialRecord['level']): CredentialSource {
  return vi.fn(async ({ subject, issuer }) =>
    issuer == null ? { level, subject } : { level, subject, issuer },
  );
}

describe('useCredential', () => {
  it('resolves a verified record from the source', async () => {
    const source = fixedSource('verified');
    const { result } = renderHook(() => useCredential(SUBJECT, source));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.credential).toEqual({ level: 'verified', subject: SUBJECT });
    expect(result.current.error).toBeNull();
  });

  it('resolves `none` WITHOUT reading when no source is supplied (no baked-in source, LAW #4)', () => {
    const { result } = renderHook(() => useCredential(SUBJECT, undefined));

    // Synchronous none — there is nowhere truthful to read a `verified` from.
    expect(result.current.credential).toEqual({ level: 'none', subject: SUBJECT });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('carries the issuer scope into the `none` default', () => {
    const { result } = renderHook(() => useCredential(SUBJECT, undefined, ISSUER));
    expect(result.current.credential).toEqual({ level: 'none', subject: SUBJECT, issuer: ISSUER });
  });

  it('reads nothing and stays neutral when no subject is given', () => {
    const source = fixedSource('verified');
    const { result } = renderHook(() => useCredential(undefined, source));

    expect(result.current.credential).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(source).not.toHaveBeenCalled();
  });

  it('forwards the issuer scope to the source', async () => {
    const source = fixedSource('verified');
    renderHook(() => useCredential(SUBJECT, source, ISSUER));

    await waitFor(() => expect(source).toHaveBeenCalled());
    expect(source).toHaveBeenCalledWith({ subject: SUBJECT, issuer: ISSUER });
  });

  it('surfaces a revoked level faithfully (must not read as verified)', async () => {
    const source = fixedSource('revoked');
    const { result } = renderHook(() => useCredential(SUBJECT, source));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.credential?.level).toBe('revoked');
  });

  it('normalizes a source failure into a typed error and CLEARS the credential', async () => {
    const source: CredentialSource = vi.fn(async () => {
      throw new Error('registry read failed');
    });
    const { result } = renderHook(() => useCredential(SUBJECT, source));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.code).toBe('UNKNOWN');
    expect(result.current.error?.message).toContain('registry read failed');
    // A failed read must NOT leave a record that could render as verified.
    expect(result.current.credential).toBeNull();
  });

  it('cancels the in-flight read when subject changes mid-load (no stale write)', async () => {
    const deferred = new Map<Hex, { resolve: (r: CredentialRecord) => void }>();
    const source: CredentialSource = vi.fn(
      ({ subject }) =>
        new Promise<CredentialRecord>((resolve) => {
          deferred.set(subject, { resolve });
        }),
    );

    const { result, rerender } = renderHook(({ s }) => useCredential(s, source), {
      initialProps: { s: SUBJECT },
    });

    await waitFor(() => expect(deferred.has(SUBJECT)).toBe(true));
    expect(result.current.isLoading).toBe(true);

    rerender({ s: SUBJECT_2 });
    await waitFor(() => expect(deferred.has(SUBJECT_2)).toBe(true));

    // Resolve the second (current) read; then resolve the stale first read — it must be dropped.
    deferred.get(SUBJECT_2)!.resolve({ level: 'verified', subject: SUBJECT_2 });
    await waitFor(() => expect(result.current.credential?.subject).toBe(SUBJECT_2));

    deferred.get(SUBJECT)!.resolve({ level: 'revoked', subject: SUBJECT });
    await Promise.resolve();
    expect(result.current.credential?.subject).toBe(SUBJECT_2);
    expect(result.current.credential?.level).toBe('verified');
  });
});
