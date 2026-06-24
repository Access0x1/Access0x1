/**
 * @file The core payment hook: quote → (approve) → pay → watch receipt.
 *
 * `usePayment` is the engine behind `<PayButton>`; integrators may use it directly to build a custom
 * checkout UI. It is zero-custody by construction (doctrine guardrail #1): the only writes it ever
 * issues are `approve` (exact gross, to the router) and `payNative` / `payToken` (to the router).
 * There is no DEX or bridge call here (off-CEI, guardrail #4) — any swap leg is another unit's job.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ROUTER_ABI, ERC20_ABI } from '../abi.js';
import type { Access0x1Client, DecodedEventLog } from '../client.js';
import { toAccess0x1Error, Access0x1Error } from '../errors.js';
import { NATIVE_TOKEN, ZERO_BYTES32, type Hex, type PaymentReceipt, type PaymentStatus } from '../types.js';
import { keccak256, toBytes, toHex } from 'viem';

/** Options for {@link usePayment}. */
export interface UsePaymentOptions {
  /** The merchant to pay (the id returned by `registerMerchant`). */
  merchantId: bigint;
  /** Human USD price (e.g. `29.00`); converted to 8-decimal internally. */
  usdAmount: number;
  /** The ERC-20 to pay in; omit for a native payment. */
  token?: Hex;
  /** A human-readable order reference; `keccak256`'d to bytes32 internally. */
  orderId?: string;
  /** The deployed `Access0x1Router` on the settlement chain (required — never hardcoded). */
  routerAddress: Hex;
  /** The viem-backed client the hook drives. Supply via {@link clientFromViem} or a wagmi adapter. */
  client?: Access0x1Client;
  /** Called once with the decoded receipt on success. */
  onSuccess?: (receipt: PaymentReceipt) => void;
  /** Called with the typed error on failure. */
  onError?: (err: Access0x1Error) => void;
}

/** The reactive surface returned by {@link usePayment}. */
export interface UsePaymentReturn {
  /** The current lifecycle status. */
  status: PaymentStatus;
  /** The quoted token amount from `router.quote()`; `null` while loading or before first quote. */
  quote: bigint | null;
  /** A quote-specific error (feed stale, token not allowed), if the quote itself failed. */
  quoteError: Access0x1Error | null;
  /** A general error for the pay flow, if any step failed. */
  error: Access0x1Error | null;
  /** Run the full pay flow: quote → (approve) → pay → await receipt. */
  pay: () => Promise<void>;
  /** The settlement tx hash, once broadcast. */
  txHash: Hex | null;
  /** The decoded `PaymentReceived` receipt, once settled. */
  receipt: PaymentReceipt | null;
  /** Reset back to `idle` (clears txHash, receipt, errors). */
  reset: () => void;
}

/** Convert a human USD amount to the router's 8-decimal fixed-point. */
function toUsdAmount8(usd: number): bigint {
  return BigInt(Math.round(usd * 1e8));
}

/** Convert a human order reference to bytes32, or {@link ZERO_BYTES32} when absent. */
function toOrderIdHex(orderId?: string): Hex {
  if (orderId == null || orderId.length === 0) return ZERO_BYTES32;
  return keccak256(toBytes(orderId));
}

/** Decode a `PaymentReceived` event log into a {@link PaymentReceipt}. */
function decodeReceipt(log: DecodedEventLog): PaymentReceipt | null {
  const a = log.args;
  if (a == null) return null;
  return {
    merchantId: a['merchantId'] as bigint,
    buyer: a['buyer'] as Hex,
    token: a['token'] as Hex,
    grossAmount: a['grossAmount'] as bigint,
    feeAmount: a['feeAmount'] as bigint,
    netAmount: a['netAmount'] as bigint,
    usdAmount8: a['usdAmount8'] as bigint,
    orderId: (a['orderId'] as Hex) ?? ZERO_BYTES32,
    srcChainSelector: (a['srcChainSelector'] as bigint) ?? 0n,
    txHash: log.transactionHash ?? ('0x' as Hex),
    blockNumber: log.blockNumber ?? 0n,
  };
}

/**
 * Drive a single same-chain payment end-to-end.
 *
 * Lifecycle: `idle → quoting → confirm → pending → success` (or `error` at any step). For an ERC-20
 * payment the hook first checks the existing allowance and only sends an `approve` (for the exact
 * gross) when it is insufficient (gas-tight, guardrail #6). It then sends `payToken`/`payNative` and
 * watches `PaymentReceived` filtered to this `merchantId` + buyer to populate the receipt.
 *
 * @param options See {@link UsePaymentOptions}.
 * @returns See {@link UsePaymentReturn}.
 */
export function usePayment(options: UsePaymentOptions): UsePaymentReturn {
  const { merchantId, usdAmount, token, orderId, routerAddress, client, onSuccess, onError } =
    options;

  const [status, setStatus] = useState<PaymentStatus>('idle');
  const [quote, setQuote] = useState<bigint | null>(null);
  const [quoteError, setQuoteError] = useState<Access0x1Error | null>(null);
  const [error, setError] = useState<Access0x1Error | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);

  // Keep latest callbacks in a ref so `pay` stays stable and doesn't re-fire effects.
  const onSuccessRef = useRef(onSuccess);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
    onErrorRef.current = onError;
  }, [onSuccess, onError]);

  const usdAmount8 = useMemo(() => toUsdAmount8(usdAmount), [usdAmount]);
  const orderIdHex = useMemo(() => toOrderIdHex(orderId), [orderId]);
  const isNative = token == null || token === NATIVE_TOKEN;

  const reset = useCallback(() => {
    setStatus('idle');
    setQuote(null);
    setQuoteError(null);
    setError(null);
    setTxHash(null);
    setReceipt(null);
  }, []);

  const fail = useCallback((raw: unknown, kind: 'quote' | 'pay') => {
    const typed = toAccess0x1Error(raw);
    if (kind === 'quote') setQuoteError(typed);
    setError(typed);
    setStatus('error');
    onErrorRef.current?.(typed);
  }, []);

  const pay = useCallback(async () => {
    if (client == null) {
      fail(new Access0x1Error('NO_WALLET', 'No wallet client connected.'), 'pay');
      return;
    }
    setError(null);
    setQuoteError(null);
    setReceipt(null);
    setTxHash(null);

    const buyer = client.account;
    if (buyer == null) {
      fail(new Access0x1Error('NO_WALLET', 'Connect a wallet to pay.'), 'pay');
      return;
    }

    // 1. Quote — reads the feed price (the SDK passes merchantId through for future per-merchant pricing).
    setStatus('quoting');
    let gross: bigint;
    try {
      gross = await client.readContract<bigint>({
        address: routerAddress,
        abi: ROUTER_ABI as unknown as import('viem').Abi,
        functionName: 'quote',
        args: [merchantId, isNative ? NATIVE_TOKEN : (token as Hex), usdAmount8],
      });
      setQuote(gross);
    } catch (e) {
      fail(e, 'quote');
      return;
    }

    let unwatch: (() => void) | undefined;
    let receiptTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // 2. (ERC-20 only) approve exactly `gross` if allowance is short — minimum necessary approval.
      if (!isNative) {
        const erc20 = token as Hex;
        const allowance = await client.readContract<bigint>({
          address: erc20,
          abi: ERC20_ABI as unknown as import('viem').Abi,
          functionName: 'allowance',
          args: [buyer, routerAddress],
        });
        if (allowance < gross) {
          setStatus('confirm');
          const approveHash = await client.writeContract({
            address: erc20,
            abi: ERC20_ABI as unknown as import('viem').Abi,
            functionName: 'approve',
            args: [routerAddress, gross],
          });
          await client.waitForTransactionReceipt({ hash: approveHash });
        }
      }

      // 3. Start watching for the receipt BEFORE broadcasting so we never miss the event.
      const seen = { done: false };
      const receiptPromise = new Promise<PaymentReceipt>((resolve) => {
        unwatch = client.watchContractEvent({
          address: routerAddress,
          abi: ROUTER_ABI as unknown as import('viem').Abi,
          eventName: 'PaymentReceived',
          args: { merchantId, buyer },
          onLogs: (logs) => {
            for (const log of logs) {
              const r = decodeReceipt(log);
              // Bind the receipt to THIS payment's order. The event filter can only
              // match the indexed {merchantId, buyer}; orderId is not indexed, so
              // without this check a concurrent payment by the same buyer to the
              // same merchant for a DIFFERENT order (e.g. a second checkout tab)
              // would resolve this hook with the wrong receipt (wrong order/amount).
              // Both sides are viem lowercase bytes32 hex, so === is exact.
              if (r != null && r.orderId === orderIdHex && !seen.done) {
                seen.done = true;
                resolve(r);
                return;
              }
            }
          },
        });
      });

      // 4. Pay. payNative carries msg.value = gross; payToken pulls the approved gross.
      setStatus('confirm');
      const hash = isNative
        ? await client.writeContract({
            address: routerAddress,
            abi: ROUTER_ABI as unknown as import('viem').Abi,
            functionName: 'payNative',
            args: [merchantId, usdAmount8, orderIdHex],
            value: gross,
          })
        : await client.writeContract({
            address: routerAddress,
            abi: ROUTER_ABI as unknown as import('viem').Abi,
            functionName: 'payToken',
            args: [merchantId, token as Hex, usdAmount8, orderIdHex],
          });
      setTxHash(hash);
      setStatus('pending');

      // 5. Wait for inclusion, then for the decoded receipt.
      const txReceipt = await client.waitForTransactionReceipt({ hash });
      // Race the receipt against a ceiling: if the PaymentReceived event never
      // arrives or its log can't be decoded, fail loud instead of hanging the pay
      // flow forever (the watcher is torn down in the finally below either way).
      const decoded = await Promise.race([
        receiptPromise,
        new Promise<never>((_, reject) => {
          receiptTimeout = setTimeout(
            () => reject(new Error('Timed out waiting for the on-chain payment receipt')),
            120_000,
          );
        }),
      ]);
      const finalReceipt: PaymentReceipt = {
        ...decoded,
        txHash: decoded.txHash !== '0x' ? decoded.txHash : hash,
        blockNumber: decoded.blockNumber !== 0n ? decoded.blockNumber : txReceipt.blockNumber,
      };
      setReceipt(finalReceipt);
      setStatus('success');
      onSuccessRef.current?.(finalReceipt);
    } catch (e) {
      fail(e, 'pay');
    } finally {
      unwatch?.();
      if (receiptTimeout) clearTimeout(receiptTimeout);
    }
  }, [client, routerAddress, merchantId, token, isNative, usdAmount8, orderIdHex, fail]);

  return { status, quote, quoteError, error, pay, txHash, receipt, reset };
}

/** Internal re-export so tests can assert the conversion helpers without poking private state. */
export const __internals = { toUsdAmount8, toOrderIdHex, decodeReceipt };
export { toHex };
