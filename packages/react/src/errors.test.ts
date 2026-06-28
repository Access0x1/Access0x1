/**
 * @file Tests for the typed error surfacing in `errors.ts`.
 *
 * The router and oracle library revert with named custom errors; viem decodes them into nested error
 * shapes. {@link toAccess0x1Error} is the single public entry point that normalizes any thrown value
 * into a stable {@link Access0x1Error}. The private helpers (`isWrongNetwork`, `isUserRejection`,
 * `extractRevertName`) are exercised through that entry point, since each maps to an observable
 * `code` on the returned error — so these cases cover the helpers' branches without reaching into the
 * module's private surface.
 */

import { describe, it, expect } from 'vitest';
import { Access0x1Error, toAccess0x1Error } from './errors.js';

describe('Access0x1Error', () => {
  it('is an instanceof Error and Access0x1Error', () => {
    const err = new Access0x1Error('UNKNOWN', 'boom');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(Access0x1Error);
  });

  it('sets message, code, and name', () => {
    const err = new Access0x1Error('UNDERPAID', 'too little');
    expect(err.message).toBe('too little');
    expect(err.code).toBe('UNDERPAID');
    expect(err.name).toBe('Access0x1Error');
  });

  it('preserves the original error on cause', () => {
    const original = new Error('original');
    const err = new Access0x1Error('UNKNOWN', 'wrapped', original);
    expect(err.cause).toBe(original);
  });

  it('leaves cause undefined when none is given', () => {
    const err = new Access0x1Error('UNKNOWN', 'no cause');
    expect(err.cause).toBeUndefined();
  });
});

describe('toAccess0x1Error — pass-through', () => {
  it('returns the same instance for an Access0x1Error input', () => {
    const existing = new Access0x1Error('STALE_PRICE', 'stale');
    expect(toAccess0x1Error(existing)).toBe(existing);
  });
});

describe('toAccess0x1Error — user rejection (isUserRejection)', () => {
  it('maps EIP-1193 code 4001 to USER_REJECTED', () => {
    const err = toAccess0x1Error({ code: 4001, message: 'denied' });
    expect(err.code).toBe('USER_REJECTED');
  });

  it('maps a UserRejectedRequestError name to USER_REJECTED', () => {
    const err = toAccess0x1Error({ name: 'UserRejectedRequestError', message: 'nope' });
    expect(err.code).toBe('USER_REJECTED');
  });

  it('matches a /user rejected/ message pattern', () => {
    const err = toAccess0x1Error({ message: 'MetaMask Tx Signature: User rejected the request.' });
    expect(err.code).toBe('USER_REJECTED');
  });

  it('matches a /user denied/ message pattern', () => {
    const err = toAccess0x1Error({ message: 'User denied transaction signature.' });
    expect(err.code).toBe('USER_REJECTED');
  });

  it('matches a /rejected the request/ message pattern', () => {
    const err = toAccess0x1Error({ message: 'The user rejected the request.' });
    expect(err.code).toBe('USER_REJECTED');
  });

  it('surfaces the friendly rejection message and preserves the cause', () => {
    const original = { code: 4001, message: 'denied' };
    const err = toAccess0x1Error(original);
    expect(err.message).toBe('You rejected the transaction.');
    expect(err.cause).toBe(original);
  });
});

describe('toAccess0x1Error — wrong network (isWrongNetwork)', () => {
  it('maps a ChainMismatchError name to WRONG_NETWORK', () => {
    const err = toAccess0x1Error({ name: 'ChainMismatchError', message: 'mismatch' });
    expect(err.code).toBe('WRONG_NETWORK');
  });

  it('matches a /does not match the target chain/ message pattern', () => {
    const err = toAccess0x1Error({
      message: 'The current chain of the wallet (id: 1) does not match the target chain for the transaction.',
    });
    expect(err.code).toBe('WRONG_NETWORK');
  });

  it('matches a /chain of the wallet .* does not match/ message pattern', () => {
    const err = toAccess0x1Error({
      message: 'The chain of the wallet (Ethereum) does not match the configured chain (Base).',
    });
    expect(err.code).toBe('WRONG_NETWORK');
  });

  it('surfaces the friendly wrong-network message and preserves the cause', () => {
    const original = { name: 'ChainMismatchError', message: 'mismatch' };
    const err = toAccess0x1Error(original);
    expect(err.message).toBe(
      'Your wallet is on the wrong network. Switch to the payment network and try again.',
    );
    expect(err.cause).toBe(original);
  });
});

describe('toAccess0x1Error — custom revert names (extractRevertName)', () => {
  // Each entry: the decoded revert name → the stable code it must normalize to.
  const cases: Array<[string, string]> = [
    ['Access0x1__Underpaid', 'UNDERPAID'],
    ['Access0x1__FeeOnTransferToken', 'FEE_ON_TRANSFER_TOKEN'],
    ['Access0x1__MerchantInactive', 'MERCHANT_INACTIVE'],
    ['Access0x1__MerchantNotFound', 'MERCHANT_NOT_FOUND'],
    ['Access0x1__TokenNotAllowed', 'TOKEN_NOT_ALLOWED'],
    ['Access0x1__InvalidPrice', 'INVALID_PRICE'],
    ['Access0x1__ZeroAmount', 'ZERO_AMOUNT'],
    ['OracleLib__StalePrice', 'STALE_PRICE'],
    ['OracleLib__SequencerDown', 'STALE_PRICE'],
    ['OracleLib__SequencerGracePeriodNotOver', 'STALE_PRICE'],
  ];

  it.each(cases)('maps a viem data.errorName of %s to %s', (errorName, code) => {
    const err = toAccess0x1Error({ data: { errorName } });
    expect(err.code).toBe(code);
  });

  it('reads data.errorName (the viem-decoded custom-error shape)', () => {
    const err = toAccess0x1Error({ data: { errorName: 'Access0x1__Underpaid' } });
    expect(err.code).toBe('UNDERPAID');
  });

  it('recursively searches a nested cause.errorName', () => {
    const err = toAccess0x1Error({
      name: 'ContractFunctionExecutionError',
      message: 'execution reverted',
      cause: { data: { errorName: 'OracleLib__StalePrice' } },
    });
    expect(err.code).toBe('STALE_PRICE');
  });

  it('scans the message text for a known selector name when no structured field is present', () => {
    const err = toAccess0x1Error({
      message: 'execution reverted with custom error Access0x1__MerchantInactive()',
    });
    expect(err.code).toBe('MERCHANT_INACTIVE');
  });

  it('matches the bare StalePrice selector in message text via the text fallback', () => {
    const err = toAccess0x1Error({ message: 'reverted: StalePrice' });
    expect(err.code).toBe('STALE_PRICE');
  });

  it('surfaces the mapped friendly message and preserves the cause', () => {
    const original = { data: { errorName: 'Access0x1__Underpaid' } };
    const err = toAccess0x1Error(original);
    expect(err.message).toBe('Payment was below the quoted amount. The price may have moved — try again.');
    expect(err.cause).toBe(original);
  });
});

describe('toAccess0x1Error — unknown fallback', () => {
  it('maps an unrecognized error object to UNKNOWN, using its message', () => {
    const err = toAccess0x1Error({ message: 'something odd happened' });
    expect(err.code).toBe('UNKNOWN');
    expect(err.message).toBe('something odd happened');
  });

  it('falls back to a generic message when there is none to read', () => {
    const err = toAccess0x1Error({ foo: 'bar' });
    expect(err.code).toBe('UNKNOWN');
    expect(err.message).toBe('The payment failed. Please try again.');
  });

  it('handles null and undefined as UNKNOWN with the generic message', () => {
    for (const input of [null, undefined]) {
      const err = toAccess0x1Error(input);
      expect(err.code).toBe('UNKNOWN');
      expect(err.message).toBe('The payment failed. Please try again.');
    }
  });

  it('handles a primitive (string) input as UNKNOWN with the generic message', () => {
    const err = toAccess0x1Error('plain string error');
    expect(err.code).toBe('UNKNOWN');
    expect(err.message).toBe('The payment failed. Please try again.');
  });

  it('preserves the original value on cause for debugging', () => {
    const original = { message: 'odd', detail: 42 };
    const err = toAccess0x1Error(original);
    expect(err.cause).toBe(original);
  });

  it('does not match a revert name embedded in an unrelated message (returns UNKNOWN)', () => {
    const err = toAccess0x1Error({ message: 'a totally unrelated failure with no known selector' });
    expect(err.code).toBe('UNKNOWN');
  });
});
