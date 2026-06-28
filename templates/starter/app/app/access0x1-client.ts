'use client';

/**
 * access0x1-client.ts — build the SDK's `Access0x1Client` from a plain injected wallet.
 *
 * The `@access0x1/react` SDK is auth-agnostic: it consumes a narrow `Access0x1Client` seam, not a
 * full wagmi runtime. This file builds one from a viem public client (reads/quotes) + a viem wallet
 * client over `window.ethereum` (writes), via `clientFromViem`. That keeps the scaffold booting with
 * ZERO booth credentials — swap in Dynamic/wagmi later without touching the checkout component.
 */

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  defineChain,
  type Chain,
} from 'viem';
import { baseSepolia, zksyncSepoliaTestnet } from 'viem/chains';
import { clientFromViem, type Access0x1Client } from '@access0x1/react';
import { CHAIN, getRpcUrl, getWalletProvider } from '../access0x1.config';

/** Arc Testnet — USDC is the 18-decimal native gas token (the chain the SDK leads with). */
const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: [getRpcUrl() ?? 'https://rpc.testnet.arc.network'] },
  },
  testnet: true,
});

/** Resolve the viem chain object for this project's configured chain id. */
function resolveChain(): Chain {
  // CHAIN.id is a single literal (the chain chosen at scaffold time); widen to `number` so the
  // other supported-chain cases stay comparable (avoids TS2678) and the switch is portable.
  switch (CHAIN.id as number) {
    case 5042002:
      return arcTestnet;
    case 84532:
      return baseSepolia;
    case 300:
      return zksyncSepoliaTestnet;
    default:
      return arcTestnet;
  }
}

/** The injected EIP-1193 provider shape we read at runtime (e.g. MetaMask, Rabbit). */
interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function getInjected(): Eip1193Provider | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
}

/**
 * Build an `Access0x1Client` for <PayButton>, honoring the configured wallet provider
 * ({@link getWalletProvider}). VANILLA DEFAULT = `injected` (window.ethereum, zero credentials).
 *
 * The SDK is auth-agnostic — it consumes a viem wallet client. So for a NON-injected provider
 * (`dynamic` | `privy` | `wagmi`) you pass the viem wallet client that provider gives you as
 * `externalWalletClient`; this file stays free of any provider SDK and the checkout component never
 * changes. Until that client exists (provider not connected yet), the client is read-only (quotes work,
 * writes reject with the SDK's typed NO_WALLET error).
 *
 * @param account             the connected address (injected path; see connectWallet)
 * @param externalWalletClient a viem WalletClient from Dynamic/Privy/wagmi (non-injected providers)
 */
export function buildAccess0x1Client(
  account?: `0x${string}`,
  externalWalletClient?: unknown,
): Access0x1Client | undefined {
  const chain = resolveChain();
  const rpc = getRpcUrl();

  const publicClient = createPublicClient({
    chain,
    transport: rpc ? http(rpc) : http(),
  });

  // Non-injected providers (dynamic/privy/wagmi) supply their own viem wallet client.
  if (getWalletProvider() !== 'injected') {
    return externalWalletClient
      ? clientFromViem(publicClient as never, externalWalletClient as never)
      : clientFromViem(publicClient as never); // read-only until the provider connects
  }

  const injected = getInjected();
  if (!injected || !account) {
    // Read-only: the SDK can quote but writes reject with a typed NO_WALLET error.
    return clientFromViem(publicClient as never);
  }

  const walletClient = createWalletClient({
    account,
    chain,
    transport: custom(injected),
  });

  return clientFromViem(publicClient as never, walletClient as never);
}

/** Prompt the injected wallet to connect; resolves with the selected account, or undefined. */
export async function connectWallet(): Promise<`0x${string}` | undefined> {
  const injected = getInjected();
  if (!injected) return undefined;
  const accounts = (await injected.request({ method: 'eth_requestAccounts' })) as string[];
  return (accounts?.[0] as `0x${string}`) ?? undefined;
}
