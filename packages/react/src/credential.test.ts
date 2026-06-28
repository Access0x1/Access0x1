/**
 * @file Unit tests for the credential read seam.
 */

import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_LEVELS,
  isVerified,
  noneRecord,
  normalizeCredentialLevel,
  onchainCredentialSource,
  type CredentialRecord,
} from './credential.js';
import { makeMockClient } from './test/mockClient.js';
import type { Hex } from './types.js';

const SUBJECT: Hex = '0x1111111111111111111111111111111111111111';
const ISSUER: Hex = '0x2222222222222222222222222222222222222222';
const REGISTRY: Hex = '0x3333333333333333333333333333333333333333';
const ZERO: Hex = '0x0000000000000000000000000000000000000000';

describe('normalizeCredentialLevel', () => {
  it('passes through the four known string levels (any case)', () => {
    expect(normalizeCredentialLevel('verified')).toBe('verified');
    expect(normalizeCredentialLevel('PENDING')).toBe('pending');
    expect(normalizeCredentialLevel('Revoked')).toBe('revoked');
    expect(normalizeCredentialLevel('none')).toBe('none');
  });

  it('maps the conventional on-chain enum integers (0..3)', () => {
    expect(normalizeCredentialLevel(0)).toBe('none');
    expect(normalizeCredentialLevel(1)).toBe('pending');
    expect(normalizeCredentialLevel(2)).toBe('verified');
    expect(normalizeCredentialLevel(3)).toBe('revoked');
  });

  it('maps bigint enums identically to number enums', () => {
    expect(normalizeCredentialLevel(2n)).toBe('verified');
    expect(normalizeCredentialLevel(3n)).toBe('revoked');
    expect(normalizeCredentialLevel(0n)).toBe('none');
  });

  it('NEVER fabricates verified — every unknown value falls back to none (LAW #4)', () => {
    expect(normalizeCredentialLevel('approved')).toBe('none'); // not a known level
    expect(normalizeCredentialLevel(99)).toBe('none'); // out-of-range enum
    expect(normalizeCredentialLevel(-1)).toBe('none');
    expect(normalizeCredentialLevel(null)).toBe('none');
    expect(normalizeCredentialLevel(undefined)).toBe('none');
    expect(normalizeCredentialLevel({})).toBe('none');
    expect(normalizeCredentialLevel(true)).toBe('none');
  });

  it('CREDENTIAL_LEVELS lists exactly the four levels', () => {
    expect([...CREDENTIAL_LEVELS].sort()).toEqual(['none', 'pending', 'revoked', 'verified']);
  });
});

describe('isVerified', () => {
  const base: CredentialRecord = { level: 'verified', subject: SUBJECT };
  it('is true only for an active verified record', () => {
    expect(isVerified(base)).toBe(true);
    expect(isVerified({ ...base, level: 'pending' })).toBe(false);
    expect(isVerified({ ...base, level: 'revoked' })).toBe(false);
    expect(isVerified({ ...base, level: 'none' })).toBe(false);
  });
  it('is false for null/undefined (no record is not verified)', () => {
    expect(isVerified(null)).toBe(false);
    expect(isVerified(undefined)).toBe(false);
  });
});

describe('noneRecord', () => {
  it('is the honest empty record — level none, never verified', () => {
    expect(noneRecord(SUBJECT)).toEqual({ level: 'none', subject: SUBJECT });
  });
  it('carries the issuer scope when one is given', () => {
    expect(noneRecord(SUBJECT, ISSUER)).toEqual({
      level: 'none',
      subject: SUBJECT,
      issuer: ISSUER,
    });
  });
});

describe('onchainCredentialSource', () => {
  it('reads the registry view and maps the enum return to a level', async () => {
    const client = makeMockClient({ reads: { credentialLevelOf: () => 2 } });
    const source = onchainCredentialSource({ client, registryAddress: REGISTRY });

    const record = await source({ subject: SUBJECT });

    expect(record).toEqual({ level: 'verified', subject: SUBJECT });
    // It reads from the HOST-SUPPLIED registry address, never a baked-in one.
    expect(client.readContract.mock.calls[0][0].address).toBe(REGISTRY);
    expect(client.readContract.mock.calls[0][0].functionName).toBe('credentialLevelOf');
  });

  it('maps a revoked enum to revoked (a revoked credential never reads as verified)', async () => {
    const client = makeMockClient({ reads: { credentialLevelOf: () => 3 } });
    const source = onchainCredentialSource({ client, registryAddress: REGISTRY });
    expect((await source({ subject: SUBJECT })).level).toBe('revoked');
  });

  it('passes the zero address as the issuer arg when the query is unscoped', async () => {
    const client = makeMockClient({ reads: { credentialLevelOf: () => 1 } });
    const source = onchainCredentialSource({ client, registryAddress: REGISTRY });
    await source({ subject: SUBJECT });
    expect(client.readContract.mock.calls[0][0].args).toEqual([SUBJECT, ZERO]);
  });

  it('forwards a supplied issuer scope and surfaces it on the record', async () => {
    const client = makeMockClient({ reads: { credentialLevelOf: () => 2 } });
    const source = onchainCredentialSource({ client, registryAddress: REGISTRY });
    const record = await source({ subject: SUBJECT, issuer: ISSUER });
    expect(client.readContract.mock.calls[0][0].args).toEqual([SUBJECT, ISSUER]);
    expect(record.issuer).toBe(ISSUER);
  });

  it('honors a custom functionName', async () => {
    const client = makeMockClient({ reads: { levelOf: () => 2 } });
    const source = onchainCredentialSource({
      client,
      registryAddress: REGISTRY,
      functionName: 'levelOf',
    });
    expect((await source({ subject: SUBJECT })).level).toBe('verified');
    expect(client.readContract.mock.calls[0][0].functionName).toBe('levelOf');
  });

  it('maps an unrecognized registry return to none, never verified (LAW #4)', async () => {
    const client = makeMockClient({ reads: { credentialLevelOf: () => 7 } });
    const source = onchainCredentialSource({ client, registryAddress: REGISTRY });
    expect((await source({ subject: SUBJECT })).level).toBe('none');
  });
});
