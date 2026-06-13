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
// DETERMINISM (DON consensus requires it): time comes from runtime.now() — NEVER Date.now(); all
// amounts are bigint (the event args decode as bigint) — NEVER JS floats. The WASM runtime is Javy
// (QuickJS), not Node — no node:crypto/fetch/Date.now; non-deterministic ops fail DON consensus.
//
// ARTIFACT STATUS: BUILD + SIMULATE only. Deploy is Chainlink Early-Access (approval-gated;
// `cre whoami` shows "Deploy Access: Not enabled"). The free, event-available path is
// `cre workflow build` + `cre workflow simulate [--broadcast]`. Do NOT claim a self-served live deploy.
//
// SDK NOTE: written against the installed @chainlink/cre-sdk surface (v1.11; >=1.3.1 required for
// Arc Testnet). `npm install` in this dir pulls the SDK + viem; `npm run typecheck` type-checks it.

import {
  cre,
  consensusIdenticalAggregation,
  getNetwork,
  logTriggerConfig,
  prepareReportRequest,
  bytesToHex,
  Runner,
  type EVMLog,
  type HTTPSendRequester,
  type Runtime,
} from '@chainlink/cre-sdk';
import { decodeEventLog, encodeAbiParameters, parseAbiItem, toEventHash } from 'viem';
import { configSchema, type NotifyConfig } from './config.js';

// The router's PaymentReceived signature — the EVM-log trigger source. Mirrors Access0x1Router.sol
// EXACTLY (do not reorder; the topic0 hash + the decode both depend on this byte-for-byte).
const PAYMENT_RECEIVED = parseAbiItem(
  'event PaymentReceived(uint256 indexed merchantId, address indexed buyer, address indexed token, uint256 grossAmount, uint256 feeAmount, uint256 netAmount, uint256 usdAmount8, bytes32 orderId, uint64 srcChainSelector)',
);

// topic0 = keccak256 of the event signature. Pinned here for the README/booth + used as the log
// trigger's topics[0] filter. MUST equal:
//   0x0e7e4f9badfadd9437d5fe53bdba0ca985b1b3414cb35b09a4459416e1735eea
const PAYMENT_RECEIVED_TOPIC0 = toEventHash(PAYMENT_RECEIVED);

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

// Decode a raw EVM Log (protobuf: address/topics/data as bytes) into the PaymentReceived args, using
// the canonical viem decoder. topics + data come straight off the DON-observed log.
const decodePaymentReceived = (log: EVMLog) =>
  decodeEventLog({
    abi: [PAYMENT_RECEIVED],
    topics: log.topics.map(bytesToHex) as [`0x${string}`, ...`0x${string}`[]],
    data: bytesToHex(log.data),
  }).args;

// Deterministic JSON body for the webhook (bigint -> decimal string; fixed key order so every DON
// node produces a byte-identical body — required for consensus).
const stableBody = (
  args: ReturnType<typeof decodePaymentReceived>,
  notifiedAt: bigint,
): string =>
  JSON.stringify({
    event: 'PaymentReceived',
    merchantId: args.merchantId.toString(),
    buyer: args.buyer,
    token: args.token,
    grossAmount: args.grossAmount.toString(),
    feeAmount: args.feeAmount.toString(),
    netAmount: args.netAmount.toString(),
    usdAmount8: args.usdAmount8.toString(),
    orderId: args.orderId,
    srcChainSelector: args.srcChainSelector.toString(),
    notifiedAt: notifiedAt.toString(),
  });

// The handler's return — a small, fully-serializable audit summary (all decimal strings). Returning
// a CRE-serializable value (not void) keeps the workflow report deterministic across the DON.
interface AuditSummary {
  merchantId: string;
  orderId: `0x${string}`;
  notifiedAt: string;
  webhookStatus: number;
}

// Handler: runs once per PaymentReceived log the DON observes.
const onPaymentReceived = (runtime: Runtime<NotifyConfig>, log: EVMLog): AuditSummary => {
  const cfg = runtime.config;
  const args = decodePaymentReceived(log);

  // Deterministic timestamp — runtime.now() (DON-consensus Date), never Date.now(). Seconds, as the
  // receiver's AuditEntry.notifiedAt is a uint64 unix-seconds field.
  const notifiedAt = BigInt(Math.floor(runtime.now().getTime() / 1000));
  const body = stableBody(args, notifiedAt);

  // (a) EXTERNAL API: HTTP-notify the merchant. The auth key is pulled from the CRE vault BY ID
  // (never inlined) and sent as a bearer header. The HTTP call runs in node mode and is reduced to a
  // single consensus value across the DON (identical bodies -> identical status).
  const key = runtime.getSecret({ id: cfg.webhookSecretId }).result().value;
  const httpClient = new cre.capabilities.HTTPClient();
  const notify = (sendRequester: HTTPSendRequester): number => {
    const res = sendRequester
      .sendRequest({
        url: cfg.merchantWebhookUrl,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Access0x1-Event': 'PaymentReceived',
          Authorization: `Bearer ${key}`,
        },
        body,
      })
      .result();
    return res.statusCode;
  };
  const webhookStatus = httpClient
    .sendRequest(runtime, notify, consensusIdenticalAggregation<number>())()
    .result();

  // (b) ON-CHAIN AUDIT WRITE: ABI-encode the AuditEntry and writeReport it to Access0x1Receiver via
  // the KeystoneForwarder. This is the state change the CRE / Connect-the-World rule asks for.
  const network = getNetwork({
    chainFamily: 'evm',
    chainSelectorName: cfg.chainSelectorName,
    isTestnet: true,
  });
  if (!network) throw new Error(`unsupported chainSelectorName: ${cfg.chainSelectorName}`);

  const encodedPayload = encodeAbiParameters(AUDIT_ENTRY_ABI, [
    {
      merchantId: args.merchantId,
      token: args.token,
      grossAmount: args.grossAmount,
      usdAmount8: args.usdAmount8,
      orderId: args.orderId,
      srcChainSelector: args.srcChainSelector,
      notifiedAt,
    },
  ]);

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const report = runtime.report(prepareReportRequest(encodedPayload)).result();

  // JSON-shaped WriteCreReportRequest: the SDK hexToBytes-es `receiver` for us (createWriteCreReportRequest).
  evmClient
    .writeReport(runtime, {
      receiver: cfg.receiverAddress,
      report,
    })
    .result();

  return {
    merchantId: args.merchantId.toString(),
    orderId: args.orderId,
    notifiedAt: notifiedAt.toString(),
    webhookStatus,
  };
};

// Workflow init: register the EVM-log trigger on the router's PaymentReceived event, filtered to the
// configured router address + the PaymentReceived topic0. FINALIZED confidence so the audit write
// only ever fires on a settled, non-reorgable log.
const initWorkflow = (cfg: NotifyConfig) => {
  const network = getNetwork({
    chainFamily: 'evm',
    chainSelectorName: cfg.chainSelectorName,
    isTestnet: true,
  });
  if (!network) throw new Error(`unsupported chainSelectorName: ${cfg.chainSelectorName}`);

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  return [
    cre.handler(
      evmClient.logTrigger(
        logTriggerConfig({
          addresses: [cfg.routerAddress as `0x${string}`],
          topics: [[PAYMENT_RECEIVED_TOPIC0]],
          confidence: 'FINALIZED',
        }),
      ),
      onPaymentReceived,
    ),
  ];
};

export async function main(): Promise<void> {
  const runner = await Runner.newRunner<NotifyConfig>({ configSchema });
  await runner.run(initWorkflow);
}

main();
