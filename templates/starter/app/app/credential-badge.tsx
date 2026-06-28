'use client';

/**
 * credential-badge.tsx — a GENERIC, UNBRANDED verified-credential badge.
 *
 * Renders the credential LEVEL of an address — `verified | pending | revoked | none` — as a small
 * pill. It reads the level through the SDK's `useCredential` hook, which is source-AGNOSTIC: you
 * supply the source it reads from. This component bakes in NO source, so out of the box every address
 * resolves to `none` (the honest default — the SDK never fabricates a `verified`, LAW #4).
 *
 * Wire a source when you have a credential registry you trust:
 *
 *   import { onchainCredentialSource } from '@access0x1/react';
 *   const source = onchainCredentialSource({ client, registryAddress: '0xYourRegistry' });
 *   <CredentialBadge subject={account} source={source} />
 *
 * `onchainCredentialSource` reads an on-chain registry view through the same client `<PayButton>`
 * uses; no registry address is baked into the SDK — you point it at one you trust. Any async resolver
 * (your own API, a subgraph) also satisfies the `CredentialSource` type.
 *
 * Styling: this is a reference. It uses minimal inline styles so it drops in anywhere; pass a
 * `className` to restyle with your own CSS/Tailwind, or copy it and rewrite the markup entirely.
 */

import type { ReactNode } from 'react';
import {
  useCredential,
  type CredentialLevel,
  type CredentialSource,
  type Hex,
} from '@access0x1/react';

/** Props for {@link CredentialBadge}. */
export interface CredentialBadgeProps {
  /** The address whose credential to show. Omit to render nothing. */
  subject?: Hex;
  /**
   * The credential source to read from. Omit to leave the badge in its honest `none` state (there is
   * no baked-in source — the SDK never invents a `verified`).
   */
  source?: CredentialSource;
  /** Optional issuer scope — show only a credential issued by this address. */
  issuer?: Hex;
  /** Hide the badge entirely when the level is `none` (default `false` — show a neutral "unverified"). */
  hideWhenNone?: boolean;
  /** Pass-through class for your own CSS / Tailwind (styles below are a minimal default). */
  className?: string;
}

/** Truthful, neutral copy per level — never claims more than the credential states. */
const LABELS: Record<CredentialLevel, string> = {
  verified: 'Verified',
  pending: 'Pending',
  revoked: 'Revoked',
  none: 'Unverified',
};

/** Minimal, host-overridable default colors per level (border + text). */
const COLORS: Record<CredentialLevel, { fg: string; border: string }> = {
  verified: { fg: '#34d399', border: '#34d39955' },
  pending: { fg: '#fbbf24', border: '#fbbf2455' },
  revoked: { fg: '#f87171', border: '#f8717155' },
  none: { fg: '#9ca3af', border: '#9ca3af55' },
};

/**
 * A small, unbranded credential badge.
 *
 * @param props See {@link CredentialBadgeProps}.
 */
export function CredentialBadge(props: CredentialBadgeProps): ReactNode {
  const { subject, source, issuer, hideWhenNone = false, className } = props;
  const { credential, isLoading, error } = useCredential(subject, source, issuer);

  if (subject == null) return null;

  // Resolve the level to render. A read error is surfaced as `none` copy (never as verified) — the
  // badge must never imply trust it could not actually confirm (LAW #4).
  const level: CredentialLevel = error != null ? 'none' : (credential?.level ?? 'none');
  if (hideWhenNone && level === 'none' && !isLoading) return null;

  const color = COLORS[level];
  const label = isLoading ? 'Checking…' : LABELS[level];

  return (
    <span
      className={className}
      data-credential-level={level}
      role="status"
      title={`Credential: ${LABELS[level]}`}
      style={
        className == null
          ? {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35em',
              padding: '2px 8px',
              fontSize: 12,
              fontWeight: 600,
              lineHeight: 1.6,
              borderRadius: 999,
              color: color.fg,
              border: `1px solid ${color.border}`,
            }
          : undefined
      }
    >
      <span aria-hidden="true" style={{ fontSize: '0.9em' }}>
        {level === 'verified' ? '✓' : level === 'revoked' ? '✕' : '•'}
      </span>
      {label}
    </span>
  );
}
