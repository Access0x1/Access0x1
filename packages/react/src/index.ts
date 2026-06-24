/**
 * @file `@access0x1/react` — public barrel.
 *
 * A viem/wagmi-native, zero-custody payment SDK for Access0x1. Drop `<PayButton>` into any React app
 * to accept USD-priced crypto in a single on-chain tx (buyer → router → merchant + treasury in the
 * same block). The SDK never holds keys or funds.
 *
 * @packageDocumentation
 */

// Primary component.
export { PayButton } from './components/PayButton.js';
export type { PayButtonProps } from './components/PayButton.js';

// Hooks.
export { usePayment } from './hooks/usePayment.js';
export type { UsePaymentOptions, UsePaymentReturn } from './hooks/usePayment.js';

export { useMerchant, isUnregistered } from './hooks/useMerchant.js';
export type { UseMerchantReturn } from './hooks/useMerchant.js';

export { usePaymentLanes } from './hooks/usePaymentLanes.js';
export type { UsePaymentLanesReturn } from './hooks/usePaymentLanes.js';

// Client seam (build one from your viem public/wallet clients).
export { clientFromViem } from './client.js';
export type {
  Access0x1Client,
  MinimalPublicClient,
  MinimalWalletClient,
} from './client.js';

// Errors.
export { Access0x1Error, toAccess0x1Error } from './errors.js';
export type { Access0x1ErrorCode } from './errors.js';

// Chain registry.
export { CHAINS, getChainConfig } from './chains.js';
export type { ChainConfig, ChainKey } from './chains.js';

// Types + constants.
export { NATIVE_TOKEN, ZERO_BYTES32 } from './types.js';
export type { Hex, PaymentStatus, PaymentReceipt, MerchantInfo } from './types.js';

// ABI fragments (for advanced custom integrations).
export { ROUTER_ABI, ERC20_ABI, LANES_ABI } from './abi.js';

// Clear signing — ERC-8213 calldata digest (the verifiable fallback to the ERC-7730 descriptor).
export { calldataDigest, encodePaymentCalldata, paymentCalldataDigest } from './clearSigning.js';
export type { PaymentCalldataParams } from './clearSigning.js';
