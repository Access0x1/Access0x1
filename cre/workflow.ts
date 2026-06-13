// Access0x1 — "Notified Settlement" Chainlink CRE workflow (TypeScript SDK -> WASM).
//
// FLOW:  EVM-log trigger on Access0x1Router.PaymentReceived
//          -> (a) HTTP-notify the merchant settlement webhook  (external API)
//          -> (b) writeReport an audit entry to Access0x1Receiver via the KeystoneForwarder
//
// The on-chain write (b) is what clears the CRE judging bar: an orchestration layer integrating a
// blockchain (the EVM log + the audit write) with an external API/system (the merchant webhook).
//
// OFF THE MONEY PATH: this workflow only READS the PaymentReceived log and WRITES to the standalone
// Access0x1Receiver. It never calls Access0x1Router, never blocks settlement, never rolls anything
// back. The router emits the event fire-and-forget; settlement is identical whether CRE runs or not.
//
// DETERMINISM (DON consensus requires it): use runtime.now() — NEVER Date.now(); all amounts are
// bigint / parseUnits — NEVER JS floats. Non-deterministic ops fail consensus across DON nodes.
//
// ARTIFACT STATUS: BUILD + SIMULATE only. Deploy is Chainlink Early-Access (approval-gated;
// `cre whoami` shows "Deploy Access: Not enabled"). The free, event-available path is
// `cre workflow build` + `cre workflow simulate [--broadcast]`. Do NOT claim a self-served live deploy.
//
// SDK NOTE: written against the documented @chainlink/cre-sdk TS surface (>=1.3.1, required for Arc
// Testnet). The package is installed at the build session (`npm install` in this dir) — see README.

import {
  cre,
  type Runtime,
  type EVMLogEvent,
  encodeAbiParameters,
  parseAbiItem,
} from '@chainlink/cre-sdk';
import { config, type NotifyConfig } from './config.js';

// The router's PaymentReceived signature — the EVM-log trigger topic. Mirrors
// Access0x1Router.sol exactly (do not reorder; topic hash + decode depend on it).
const PAYMENT_RECEIVED = parseAbiItem(
  'event PaymentReceived(uint256 indexed merchantId, address indexed buyer, address indexed token, uint256 grossAmount, uint256 feeAmount, uint256 netAmount, uint256 usdAmount8, bytes32 orderId, uint64 srcChainSelector)',
);

// The Access0x1Receiver.AuditEntry tuple the receiver's onReport abi.decodes. Field order MUST match
// the Solidity struct in src/Access0x1Receiver.sol — this is the report body the Forwarder delivers.
const AUDIT_ENTRY_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'merchantId', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'grossAmount', type: 'uint256' },
      { name: 'usdAmount8', type: 'uint256' },
      { name: 'orderId', type: 'bytes32' },
      { name: 'srcChainSelector', type: 'uint64' },
      { name: 'notifiedAt', type: 'uint64' },
    ],
  },
] as const;

interface PaymentReceivedArgs {
  merchantId: bigint;
  buyer: `0x${string}`;
  token: `0x${string}`;
  grossAmount: bigint;
  feeAmount: bigint;
  netAmount: bigint;
  usdAmount8: bigint;
  orderId: `0x${string}`;
  srcChainSelector: bigint;
}

// Handler: runs once per PaymentReceived log the DON observes.
const onPaymentReceived = async (
  runtime: Runtime<NotifyConfig>,
  event: EVMLogEvent<PaymentReceivedArgs>,
): Promise<void> => {
  const cfg = runtime.config;
  const p = event.args;

  // Deterministic timestamp — runtime.now(), never Date.now() (consensus-safe).
  const notifiedAt = BigInt(runtime.runInNodeMode(() => runtime.now()));

  // (a) EXTERNAL API: HTTP-notify the merchant. Body is deterministic (all values from the log +
  // runtime.now()). The HMAC signing secret is pulled from the CRE vault BY NAME — never inlined.
  const http = new cre.capabilities.HTTPClient();
  const secret = await runtime.getSecret(cfg.webhookSecretName);
  await http
    .sendRequest(runtime, {
      url: cfg.merchantWebhookUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access0x1-Event': 'PaymentReceived',
        'X-Access0x1-Signature': secret.sign(
          stableBody(p, notifiedAt),
        ),
      },
      body: stableBody(p, notifiedAt),
    })
    .result();

  // (b) ON-CHAIN AUDIT WRITE: encode the AuditEntry and writeReport it to Access0x1Receiver via the
  // KeystoneForwarder. This is the state change the CRE/Connect-the-World rule asks for.
  const report = encodeAbiParameters(AUDIT_ENTRY_ABI, [
    {
      merchantId: p.merchantId,
      token: p.token,
      grossAmount: p.grossAmount,
      usdAmount8: p.usdAmount8,
      orderId: p.orderId,
      srcChainSelector: p.srcChainSelector,
      notifiedAt,
    },
  ]);

  const evmClient = new cre.capabilities.EVMClient(cfg.chainSelectorName);
  await evmClient
    .writeReport(runtime, {
      receiver: cfg.receiverAddress,
      report,
    })
    .result();
};

// Deterministic JSON body for the webhook (bigint -> decimal string; stable key order).
const stableBody = (p: PaymentReceivedArgs, notifiedAt: bigint): string =>
  JSON.stringify({
    event: 'PaymentReceived',
    merchantId: p.merchantId.toString(),
    buyer: p.buyer,
    token: p.token,
    grossAmount: p.grossAmount.toString(),
    feeAmount: p.feeAmount.toString(),
    netAmount: p.netAmount.toString(),
    usdAmount8: p.usdAmount8.toString(),
    orderId: p.orderId,
    srcChainSelector: p.srcChainSelector.toString(),
    notifiedAt: notifiedAt.toString(),
  });

// Workflow init: register the EVM-log trigger on the router's PaymentReceived event.
const initWorkflow = (cfg: NotifyConfig) => {
  const evm = new cre.capabilities.EVMClient(cfg.chainSelectorName);
  return [
    cre.handler(
      evm.logTrigger({
        address: cfg.routerAddress,
        event: PAYMENT_RECEIVED,
      }),
      onPaymentReceived,
    ),
  ];
};

export async function main(): Promise<void> {
  const runner = await cre.newRunner<NotifyConfig>({ config });
  await runner.run(initWorkflow);
}

main();
