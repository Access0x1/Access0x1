import { SnapError } from '@metamask/snaps-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  ERR_BUDGET_EXCEEDED,
  ERR_SHIELD_FAILED,
  ERR_WITHDRAW_FAILED,
  dailyAddressIndex,
  initiatePrivatePayout,
} from '../src/payout/privatePayout';
import type { PrivatePayoutDeps } from '../src/payout/privatePayout';

const FRESH = '0xcccccccccccccccccccccccccccccccccccccccc' as const;
const DEPOSIT = '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' as const;
const WITHDRAW = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as const;

function makeDeps(
  fetchImpl: PrivatePayoutDeps['fetchImpl'],
  overrides: Partial<PrivatePayoutDeps> = {},
): PrivatePayoutDeps {
  return {
    apiBaseUrl: 'https://checkout.example',
    chainId: 5042002,
    deriveAddress: vi.fn().mockResolvedValue(FRESH),
    fetchImpl,
    now: 1_700_000_000_000,
    ...overrides,
  };
}

describe('dailyAddressIndex', () => {
  it('produces a new index each UTC day, derived from the clock (not hardcoded)', () => {
    const day0 = dailyAddressIndex(0);
    const day1 = dailyAddressIndex(86_400_000);
    expect(day1).toBe(day0 + 1);
  });
});

describe('initiatePrivatePayout', () => {
  it('POSTs to /api/payout and returns both tx hashes with explorer links', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, depositTx: DEPOSIT, withdrawTx: WITHDRAW }),
    });
    const deps = makeDeps(fetchImpl);
    const result = await initiatePrivatePayout(
      { userId: 'u1', amountUsd: 50, depositAmountUsd: 100 },
      deps,
    );

    expect(result.depositTx).toBe(DEPOSIT);
    expect(result.withdrawTx).toBe(WITHDRAW);
    expect(result.arcscanDepositUrl).toBe(
      `https://testnet.arcscan.app/tx/${DEPOSIT}`,
    );

    // Body carries the freshly-derived destination, not a hardcoded address.
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.destination).toBe(FRESH);
    expect(body.amountUsd).toBe(50);
  });

  it('derives the destination from the daily BIP-44 index', async () => {
    const deriveAddress = vi.fn().mockResolvedValue(FRESH);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, depositTx: DEPOSIT, withdrawTx: WITHDRAW }),
    });
    await initiatePrivatePayout(
      { userId: 'u1', amountUsd: 10, depositAmountUsd: 100 },
      makeDeps(fetchImpl, { deriveAddress, now: 86_400_000 * 5 }),
    );
    expect(deriveAddress).toHaveBeenCalledWith(5);
  });

  it('rejects amounts over the deposit budget with -32001', async () => {
    const deps = makeDeps(vi.fn());
    await expect(
      initiatePrivatePayout(
        { userId: 'u1', amountUsd: 200, depositAmountUsd: 100 },
        deps,
      ),
    ).rejects.toMatchObject({ code: ERR_BUDGET_EXCEEDED });
  });

  it('maps a shield failure to -32002', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, error: 'shield_failed' }),
    });
    await expect(
      initiatePrivatePayout(
        { userId: 'u1', amountUsd: 10, depositAmountUsd: 100 },
        makeDeps(fetchImpl),
      ),
    ).rejects.toMatchObject({ code: ERR_SHIELD_FAILED });
  });

  it('maps a withdraw failure to -32003 with recoverable: true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        ok: false,
        error: 'withdraw_failed',
        depositTx: DEPOSIT,
      }),
    });
    let thrown: unknown;
    try {
      await initiatePrivatePayout(
        { userId: 'u1', amountUsd: 10, depositAmountUsd: 100 },
        makeDeps(fetchImpl),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SnapError);
    const err = thrown as SnapError;
    expect(err.code).toBe(ERR_WITHDRAW_FAILED);
    expect((err.data as { recoverable?: boolean }).recoverable).toBe(true);
  });

  it('never leaks the private key or API token in an error message', async () => {
    const deriveAddress = vi
      .fn()
      .mockRejectedValue(new Error('0xPRIVATEKEYLEAK secret-api-token'));
    const fetchImpl = vi.fn();
    let thrown: unknown;
    try {
      await initiatePrivatePayout(
        { userId: 'u1', amountUsd: 10, depositAmountUsd: 100 },
        makeDeps(fetchImpl, { deriveAddress }),
      );
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message;
    expect(message).toBe('shield_failed');
    expect(message).not.toContain('PRIVATEKEY');
    expect(message).not.toContain('secret-api-token');
  });
});
