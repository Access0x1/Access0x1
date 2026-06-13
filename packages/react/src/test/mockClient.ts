/**
 * @file A mockable {@link Access0x1Client} for unit tests.
 *
 * Lets each test arrange `readContract` / `writeContract` / `watchContractEvent` behavior with plain
 * vi mocks — no anvil, no real RPC. This is the seam that makes the viem-native hooks fully
 * unit-testable.
 */

import { vi, type Mock } from 'vitest';
import type {
  Access0x1Client,
  DecodedEventLog,
  ReadArgs,
  WatchArgs,
  WriteArgs,
} from '../client.js';
import type { Hex } from '../types.js';

/** A test double with the underlying mocks exposed for assertions. */
export interface MockClient extends Access0x1Client {
  readContract: Mock;
  writeContract: Mock;
  waitForTransactionReceipt: Mock;
  watchContractEvent: Mock;
  /** Manually fire the registered `PaymentReceived` watcher with a decoded log. */
  emitEvent: (log: DecodedEventLog) => void;
}

/** Options to seed the mock client. */
export interface MockClientOptions {
  account?: Hex;
  /** Resolver for `readContract`, keyed by functionName. */
  reads?: Partial<Record<string, (args: ReadArgs) => unknown>>;
  /** Resolver for `writeContract`, keyed by functionName; returns a tx hash or throws. */
  writes?: Partial<Record<string, (args: WriteArgs) => Hex | Promise<Hex>>>;
  /** Block number returned by `waitForTransactionReceipt`. */
  blockNumber?: bigint;
}

const DEFAULT_ACCOUNT: Hex = '0x1111111111111111111111111111111111111111';

/** Build a {@link MockClient}. */
export function makeMockClient(opts: MockClientOptions = {}): MockClient {
  let watcher: WatchArgs | null = null;

  const readContract = vi.fn(async (args: ReadArgs) => {
    const fn = opts.reads?.[args.functionName];
    if (fn == null) {
      throw new Error(`mock readContract: no resolver for ${args.functionName}`);
    }
    return fn(args);
  });

  const writeContract = vi.fn(async (args: WriteArgs) => {
    const fn = opts.writes?.[args.functionName];
    if (fn == null) {
      throw new Error(`mock writeContract: no resolver for ${args.functionName}`);
    }
    return fn(args);
  });

  const waitForTransactionReceipt = vi.fn(async () => ({
    blockNumber: opts.blockNumber ?? 100n,
  }));

  const watchContractEvent = vi.fn((args: WatchArgs) => {
    watcher = args;
    return () => {
      watcher = null;
    };
  });

  return {
    account: opts.account ?? DEFAULT_ACCOUNT,
    readContract: readContract as unknown as MockClient['readContract'],
    writeContract: writeContract as unknown as MockClient['writeContract'],
    waitForTransactionReceipt:
      waitForTransactionReceipt as unknown as MockClient['waitForTransactionReceipt'],
    watchContractEvent: watchContractEvent as unknown as MockClient['watchContractEvent'],
    emitEvent: (log: DecodedEventLog) => {
      if (watcher == null) throw new Error('emitEvent: no active watcher');
      watcher.onLogs([log]);
    },
  };
}

/** A revert error shaped like viem's decoded custom-error revert. */
export function revertError(errorName: string): Error {
  const e = new Error(`execution reverted: ${errorName}`);
  (e as unknown as { data: { errorName: string } }).data = { errorName };
  return e;
}
