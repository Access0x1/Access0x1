// Access0x1 — "Notified Settlement" CRE workflow config.
//
// Per-run config (chain, addresses, webhook). Addresses are placeholders for SIMULATE; the booth /
// build session fills the real Arc-Testnet values. NEVER put a secret here — the merchant webhook
// secret is injected via the CRE secrets vault (referenced by name at runtime), not committed.

export interface NotifyConfig {
  // The chain the router + receiver are deployed on (CRE Supported Networks: Base/Base Sepolia,
  // zkSync Era/Sepolia, Arc Testnet 5042002). Arc Testnet is the event target.
  readonly chainSelectorName: string;

  // The Access0x1Router that EMITS PaymentReceived (the EVM-log trigger source). The workflow only
  // READS this log — it never calls the router, never touches the money path.
  readonly routerAddress: `0x${string}`;

  // The Access0x1Receiver (this repo's src/Access0x1Receiver.sol) that the workflow writes the audit
  // entry to, via the KeystoneForwarder. Must be allowlisted to this workflow's owner + name.
  readonly receiverAddress: `0x${string}`;

  // The merchant settlement webhook the workflow HTTP-POSTs the notification to (the external-API
  // half that clears the CRE judging bar). Public URL; the signing secret comes from the vault.
  readonly merchantWebhookUrl: string;

  // Name of the HMAC secret in the CRE secrets vault used to sign the webhook body (NOT the value).
  readonly webhookSecretName: string;
}

// Default = SIMULATE placeholders. Override at build/simulate time (e.g. via a config file passed to
// `cre workflow simulate`). The zero/example addresses make it obvious this is not a live deploy.
export const config: NotifyConfig = {
  chainSelectorName: 'arc-testnet',
  routerAddress: '0x0000000000000000000000000000000000000000',
  receiverAddress: '0x0000000000000000000000000000000000000000',
  merchantWebhookUrl: 'https://example.invalid/access0x1/settlement-webhook',
  webhookSecretName: 'MERCHANT_WEBHOOK_HMAC',
};
