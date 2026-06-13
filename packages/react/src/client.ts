/**
 * @file The thin viem client surface the hooks depend on.
 *
 * The SDK is viem-native: all chain interaction is `readContract` / `writeContract` /
 * `watchContractEvent`. Rather than reach into a wagmi config at call time (which couples the hooks
 * to a full wagmi runtime and makes them hard to unit-test), the hooks consume this narrow
 * `Access0x1Client` interface. A host app builds one from its viem public + wallet clients (which is
 * exactly what wagmi's `getPublicClient` / `getWalletClient` return), or from a wagmi config via
 * {@link clientFromWagmiConfig}.
 *
 * This is the seam that keeps the package auth-agnostic (doctrine: Dynamic / wagmi is always the
 * host app's concern) and 100% unit-testable with plain object mocks.
 */

import type { Abi } from 'viem';
import type { Hex } from './types.js';

/** Arguments for a `readContract` call, narrowed to what the SDK needs. */
export interface ReadArgs {
  address: Hex;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/** Arguments for a `writeContract` call, narrowed to what the SDK needs. */
export interface WriteArgs {
  address: Hex;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  /** msg.value for a payable call (native pay). */
  value?: bigint;
  /** The connected account; the host app's wallet client usually supplies this implicitly. */
  account?: Hex;
}

/** A decoded log handed to the `watchContractEvent` callback. */
export interface DecodedEventLog {
  eventName?: string;
  args?: Record<string, unknown>;
  transactionHash?: Hex;
  blockNumber?: bigint;
}

/** Options for {@link Access0x1Client.watchContractEvent}. */
export interface WatchArgs {
  address: Hex;
  abi: Abi;
  eventName: string;
  /** Indexed-arg filter, e.g. `{ merchantId, buyer }`. */
  args?: Record<string, unknown>;
  onLogs: (logs: DecodedEventLog[]) => void;
}

/**
 * The narrow chain surface the SDK hooks use. Every method maps 1:1 to a viem action; a host app or
 * a test supplies a concrete implementation.
 */
export interface Access0x1Client {
  /** The connected payer address, if a wallet is connected. */
  readonly account?: Hex;
  /** Read a contract view/pure function. */
  readContract<T = unknown>(args: ReadArgs): Promise<T>;
  /** Send a transaction; resolves with the tx hash. */
  writeContract(args: WriteArgs): Promise<Hex>;
  /** Wait for a tx to be mined; resolves with its block number. */
  waitForTransactionReceipt(args: { hash: Hex }): Promise<{ blockNumber: bigint }>;
  /** Subscribe to a contract event; returns an unsubscribe function. */
  watchContractEvent(args: WatchArgs): () => void;
}

/**
 * The minimal shape of a viem public client the SDK reads through. (A real viem `PublicClient`
 * satisfies this structurally.)
 */
export interface MinimalPublicClient {
  readContract(args: unknown): Promise<unknown>;
  waitForTransactionReceipt(args: { hash: Hex }): Promise<{ blockNumber: bigint }>;
  watchContractEvent(args: unknown): () => void;
}

/**
 * The minimal shape of a viem wallet client the SDK writes through.
 */
export interface MinimalWalletClient {
  account?: { address: Hex } | Hex;
  writeContract(args: unknown): Promise<Hex>;
}

/**
 * Build an {@link Access0x1Client} from a viem public client + wallet client. This is the path a
 * host app uses with `wagmi`'s `getPublicClient()` / `getWalletClient()`.
 *
 * @param publicClient A viem public client (reads + event watching + receipt waiting).
 * @param walletClient A viem wallet client (the connected signer); omit for read-only usage.
 * @returns An {@link Access0x1Client}.
 */
export function clientFromViem(
  publicClient: MinimalPublicClient,
  walletClient?: MinimalWalletClient,
): Access0x1Client {
  const account: Hex | undefined =
    walletClient?.account == null
      ? undefined
      : typeof walletClient.account === 'string'
        ? walletClient.account
        : walletClient.account.address;

  return {
    account,
    readContract: <T = unknown>(args: ReadArgs) =>
      publicClient.readContract(args) as Promise<T>,
    writeContract: (args: WriteArgs) => {
      if (walletClient == null) {
        return Promise.reject(
          new Error('Access0x1: no wallet client connected — cannot send a payment transaction.'),
        );
      }
      return walletClient.writeContract({ account, ...args });
    },
    waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args),
    watchContractEvent: (args) => publicClient.watchContractEvent(args),
  };
}
