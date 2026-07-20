/**
 * @file Typed error surfacing for router reverts.
 *
 * The router reverts with named custom errors (`Access0x1__Underpaid`, `Access0x1__MerchantInactive`,
 * `Access0x1__FeeOnTransferToken`, …) and the oracle library reverts with `OracleLib__StalePrice` (plus
 * the sequencer guards `OracleLib__SequencerDown` / `OracleLib__SequencerGracePeriodNotOver`).
 * viem decodes a custom-error revert into a `ContractFunctionRevertedError` whose `.data.errorName`
 * carries the name. This module normalizes any thrown value into a clean `Access0x1Error` with a
 * stable `code`, so the host app's UI can branch on a known set without parsing unstructured text.
 */

/** The set of error codes the SDK recognizes and surfaces to the host app. */
export type Access0x1ErrorCode =
  | 'UNDERPAID'
  | 'FEE_ON_TRANSFER_TOKEN'
  | 'MERCHANT_INACTIVE'
  | 'MERCHANT_NOT_FOUND'
  | 'TOKEN_NOT_ALLOWED'
  | 'STALE_PRICE'
  | 'INVALID_PRICE'
  | 'ZERO_AMOUNT'
  | 'USER_REJECTED'
  | 'WRONG_NETWORK'
  | 'NO_WALLET'
  | 'UNKNOWN';

/** A normalized, typed error. The original thrown value is preserved on {@link cause}. */
export class Access0x1Error extends Error {
  /** A stable, switchable code. */
  readonly code: Access0x1ErrorCode;
  /** The original error, for debugging. */
  readonly cause: unknown;

  constructor(code: Access0x1ErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'Access0x1Error';
    this.code = code;
    this.cause = cause;
  }
}

/** Maps a decoded revert name (router custom error or oracle error) to a friendly message. */
const REVERT_MESSAGES: Record<string, { code: Access0x1ErrorCode; message: string }> = {
  Access0x1__Underpaid: {
    code: 'UNDERPAID',
    message: 'Payment was below the quoted amount. The price may have moved — try again.',
  },
  Access0x1__FeeOnTransferToken: {
    code: 'FEE_ON_TRANSFER_TOKEN',
    message: 'This token takes a fee on transfer and is not supported for payment.',
  },
  Access0x1__MerchantInactive: {
    code: 'MERCHANT_INACTIVE',
    message: 'This merchant is not currently accepting payments.',
  },
  Access0x1__MerchantNotFound: {
    code: 'MERCHANT_NOT_FOUND',
    message: 'Merchant not found or not yet registered.',
  },
  Access0x1__TokenNotAllowed: {
    code: 'TOKEN_NOT_ALLOWED',
    message: 'This token is not an accepted pay-in currency for this router.',
  },
  Access0x1__InvalidPrice: {
    code: 'INVALID_PRICE',
    message: 'The price feed returned an invalid price. Try again shortly.',
  },
  Access0x1__ZeroAmount: {
    code: 'ZERO_AMOUNT',
    message: 'A payment amount of zero is not allowed.',
  },
  // OracleLib guards — viem surfaces the FULLY-QUALIFIED selector name (`OracleLib__StalePrice`, not a
  // bare `StalePrice`) in `data.errorName`, so these are the names that actually arrive at runtime.
  OracleLib__StalePrice: {
    code: 'STALE_PRICE',
    message: 'The price feed is stale. Try again shortly.',
  },
  OracleLib__SequencerDown: {
    code: 'STALE_PRICE',
    message: 'The L2 sequencer is down, so the price feed cannot be trusted right now. Try again shortly.',
  },
  OracleLib__SequencerGracePeriodNotOver: {
    code: 'STALE_PRICE',
    message: 'The L2 sequencer just restarted; pricing is paused for its grace period. Try again shortly.',
  },
  // Belt-and-suspenders text fallback for any source that surfaces the bare selector in a message string.
  StalePrice: {
    code: 'STALE_PRICE',
    message: 'The price feed is stale. Try again shortly.',
  },
};

/** A plain object with unknown values — the safest shape for inspecting arbitrary thrown values. */
type AnyObject = Record<PropertyKey, unknown>;

/** Narrows an arbitrary value to {@link AnyObject} so dynamic field reads stay type-checked. */
function asObject(value: unknown): AnyObject | undefined {
  return value != null && typeof value === 'object' ? (value as AnyObject) : undefined;
}

/** Reads a string-valued field from an object, or `undefined` if absent/not a string. */
function getStringField(obj: AnyObject, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

/** Extract a revert/error name from an arbitrary thrown value, searching nested viem error fields. */
function extractRevertName(err: unknown): string | undefined {
  const e = asObject(err);
  if (e === undefined) return undefined;

  // viem decodes a custom error into `data.errorName`.
  const data = asObject(e['data']);
  if (data !== undefined) {
    const name = getStringField(data, 'errorName');
    if (name !== undefined) return name;
  }

  // Some viem errors expose `cause` or a top-level `name`.
  for (const key of ['cause', 'walk']) {
    const nested = e[key];
    if (nested != null && typeof nested === 'object') {
      const found = extractRevertName(nested);
      if (found != null) return found;
    }
  }

  // Fall back to scanning the message text for a known selector name.
  const message = getStringField(e, 'message') ?? '';
  for (const known of Object.keys(REVERT_MESSAGES)) {
    if (message.includes(known)) return known;
  }
  return undefined;
}

/** Returns `true` if the error is a wallet/transaction chain mismatch (wallet on the wrong network). */
function isWrongNetwork(err: unknown): boolean {
  const e = asObject(err);
  if (e === undefined) return false;
  const name = getStringField(e, 'name') ?? '';
  const message = getStringField(e, 'message') ?? '';
  return (
    name === 'ChainMismatchError' ||
    /does not match the target chain|chain of the wallet .* does not match/i.test(message)
  );
}

/** Returns `true` if the error looks like a user-rejected wallet prompt. */
function isUserRejection(err: unknown): boolean {
  const e = asObject(err);
  if (e === undefined) return false;
  const code = e['code'];
  if (code === 4001) return true; // EIP-1193 user rejected
  const name = getStringField(e, 'name') ?? '';
  const message = getStringField(e, 'message') ?? '';
  return (
    name === 'UserRejectedRequestError' ||
    /user rejected|user denied|rejected the request/i.test(message)
  );
}

/**
 * Normalize any thrown value into a typed {@link Access0x1Error}.
 *
 * @param err The caught value (a viem error, a plain `Error`, or anything).
 * @returns A typed error with a stable {@link Access0x1Error.code}.
 */
export function toAccess0x1Error(err: unknown): Access0x1Error {
  if (err instanceof Access0x1Error) return err;

  if (isUserRejection(err)) {
    return new Access0x1Error('USER_REJECTED', 'You rejected the transaction.', err);
  }

  if (isWrongNetwork(err)) {
    return new Access0x1Error(
      'WRONG_NETWORK',
      'Your wallet is on the wrong network. Switch to the payment network and try again.',
      err,
    );
  }

  const revertName = extractRevertName(err);
  if (revertName != null && revertName in REVERT_MESSAGES) {
    const entry = REVERT_MESSAGES[revertName];
    // entry is always defined here (key membership checked above); narrow for noUncheckedIndexedAccess.
    if (entry != null) {
      return new Access0x1Error(entry.code, entry.message, err);
    }
  }

  const message =
    err != null && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message
      : 'The payment failed. Please try again.';
  return new Access0x1Error('UNKNOWN', message, err);
}
