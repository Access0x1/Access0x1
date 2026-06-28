// server.mjs — consume the Access0x1 "Notified Settlement" CRE audit stream.
//
// The Chainlink CRE workflow in ../../cre watches the router's PaymentReceived log and, on every
// settlement, HTTP-POSTs THIS endpoint (and writes an on-chain audit entry to Access0x1Receiver).
// This server is the MERCHANT side of that webhook. It:
//   1. verifies the bearer token the workflow sends (pulled from the CRE secrets vault by id),
//   2. parses the deterministic JSON body (all amounts are decimal STRINGS — never JS floats),
//   3. acks each settlement EXACTLY ONCE, keyed by orderId (the stream may retry; stay idempotent),
//   4. returns 2xx so the workflow records the notification as delivered.
//
// The body shape is byte-for-byte what cre/workflow.ts emits (stableBody) — fixed key order so every
// DON node produces an identical body. This handler never touches the money path; it only records.
//
// Run:  WEBHOOK_SECRET=<the value behind config.webhookSecretId>  node server.mjs
// Then POST a sample:  see the curl in README.md.
//
// Zero dependencies — Node's built-in http only.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8787);
const SECRET = process.env.WEBHOOK_SECRET ?? '';

// Idempotency ledger: orderId -> already processed. Swap for your DB in production (a unique index on
// orderId is the durable version of this Set). The stream may deliver a settlement more than once.
const seen = new Set();

// Constant-time bearer check — avoids leaking the secret length/prefix via response timing.
function bearerOk(authHeader) {
  if (!SECRET) return false; // refuse to run wide open
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return false;
  const got = Buffer.from(authHeader.slice('Bearer '.length));
  const want = Buffer.from(SECRET);
  return got.length === want.length && timingSafeEqual(got, want);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('body too large')); // simple flood guard
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method !== 'POST' || req.url !== '/webhooks/access0x1') {
    return send(404, { error: 'not found' });
  }
  if (!bearerOk(req.headers.authorization)) {
    return send(401, { error: 'unauthorized' });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return send(400, { error: 'invalid json' });
  }

  // Validate the expected event + the fields the workflow always sends (decimal strings).
  if (body.event !== 'PaymentReceived' || typeof body.orderId !== 'string') {
    return send(400, { error: 'unexpected payload' });
  }

  // Idempotent ack — process a given orderId exactly once. A retry returns 200 without re-acting.
  if (seen.has(body.orderId)) {
    return send(200, { status: 'duplicate-ignored', orderId: body.orderId });
  }
  seen.add(body.orderId);

  // === Your business logic goes here ===
  // amounts arrive as decimal strings; use BigInt (or your decimal lib), NEVER Number(), for money.
  const gross = BigInt(body.grossAmount);
  const net = BigInt(body.netAmount);
  const fee = BigInt(body.feeAmount);
  console.log(
    `settlement: merchant=${body.merchantId} order=${body.orderId} ` +
      `gross=${gross} net=${net} fee=${fee} token=${body.token} usd8=${body.usdAmount8}`,
  );
  // e.g. mark the order paid, email a receipt, release a digital good. This entry is also written
  // on-chain to Access0x1Receiver, so you can cross-check against the immutable audit log.

  return send(200, { status: 'recorded', orderId: body.orderId });
});

server.listen(PORT, () => {
  if (!SECRET) console.warn('WARNING: WEBHOOK_SECRET is unset — every request will 401.');
  console.log(`listening on http://localhost:${PORT}/webhooks/access0x1`);
});
