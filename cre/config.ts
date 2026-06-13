// Access0x1 — "Notified Settlement" CRE workflow config (Zod schema + type).
//
// The CRE CLI reads the per-run values from a co-located config.json (see ./config.json) and the
// SDK validates them against this Zod schema at `Runner.newRunner({ configSchema })`. Addresses are
// SIMULATE placeholders; the booth / build session fills the real Arc-Testnet values in config.json.
//
// NEVER put a secret here (or in config.json). The merchant webhook key is injected via the CRE
// secrets vault and referenced BY NAME (`webhookSecretId`) — pulled at runtime with runtime.getSecret,
// never committed, never inlined.

import { z } from 'zod';

// 0x-prefixed 20-byte EVM address (hex). Validated so a malformed address fails fast at startup.
const evmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte hex address');

export const configSchema = z.object({
  // The chain the router + receiver are deployed on. Resolved to a CRE chain selector via
  // getNetwork({ chainFamily: 'evm', chainSelectorName, isTestnet: true }). CRE Supported Networks:
  // Base/Base Sepolia, zkSync Era/Sepolia, Arc Testnet ('arc-testnet', 5042002) — the event target.
  chainSelectorName: z.string().min(1),

  // The Access0x1Router that EMITS PaymentReceived (the EVM-log trigger source). The workflow only
  // READS this log — it never calls the router, never touches the money path.
  routerAddress: evmAddress,

  // The Access0x1Receiver (src/Access0x1Receiver.sol) the workflow writes the audit entry to, via the
  // KeystoneForwarder. Must be allowlisted to this workflow's owner + name on the receiver.
  receiverAddress: evmAddress,

  // The merchant settlement webhook the workflow HTTP-POSTs the notification to (the external-API
  // half that clears the CRE judging bar). Public URL; the signing/auth key comes from the vault.
  merchantWebhookUrl: z.string().url(),

  // The ID of the webhook auth key in the CRE secrets vault (NOT the value). Pulled at runtime with
  // runtime.getSecret({ id }) and sent as a bearer header — never committed.
  webhookSecretId: z.string().min(1),
});

export type NotifyConfig = z.infer<typeof configSchema>;
