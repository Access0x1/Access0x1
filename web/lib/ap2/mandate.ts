/**
 * @file mandate.ts — the AP2 mandate adapter (the interop SURFACE, not the trust root).
 *
 * Access0x1's core is on-chain and self-sovereign: SessionGrant (the budget-capped, time-bounded,
 * owner-revocable ERC-7702/6492 mandate), World ID (the verified-human proof), x402 / EIP-3009 (the
 * rail). That stack is canonical and enforcing. This file is a PURE, additive view layer that
 * re-expresses a SessionGrant authorization in the nouns of Google's open agent stack so an
 * AP2/A2A-aware counterparty (a non-EVM agent, a merchant gateway) can verify our agent acted within
 * a bounded, user-authorized mandate.
 *
 * Mapping (verified against build-specs/agent-verification.adr.md §4 — the HYBRID seam):
 *   - AP2 **Intent Mandate** ← a SessionGrant authorization. The user pre-signs spending SCOPE; that
 *     scope IS the SessionGrant's (budgetCap + token + expiry + delegate + sessionId). The on-chain
 *     grant remains the source of truth; the VC is its portable wire form.
 *   - AP2 **Cart Mandate** ← the assembled cart, hash-bound to the Intent Mandate (non-repudiable
 *     chain: tampering with the intent breaks the cart's `boundTo` digest).
 *   - AP2 **Payment Mandate** ← authorizes the final charge, hash-bound to the Cart Mandate, and
 *     references the x402 rail (the SAME rail AP2's x402 extension uses).
 *
 * Doctrine:
 *  - This module moves NO money and holds NO custody — it serializes/derives only (off the money path
 *    by construction, like Access0x1Receiver and the Unlink payout leg).
 *  - law #4 (truth in copy): the proof is a documented STUB until the DID method + JWS signing key are
 *    confirmed at the booth — `proof.type` says so plainly; we never emit a forged/empty signature
 *    dressed up as real. The on-chain SessionGrant is what is actually verifiable today.
 *  - Pure + deterministic: every function is a pure transform of its inputs (the only impurity is the
 *    optional caller-supplied `issuanceDate`/`now`, injected for testability). No env, no network, no I/O.
 *
 * BOOTH-CONFIRM (honest, isolated to the `proof` + `did:` shapes):
 *  - the DID method we publish under (`did:web:` for the domain vs `did:pkh:eip155:` for the EVM
 *    address) — placeholder `did:web:` here;
 *  - the JWS signing key / suite for the VC `proof` — emitted as a typed STUB, never a fake signature.
 */

import { createHash } from "node:crypto";

import { agentNameHash } from "../agent/identity.js";

/** A 0x-prefixed hex string (an EVM address or a keccak/sha digest), as used across the web app. */
export type Hex = `0x${string}`;

/** The W3C VC + AP2 JSON-LD contexts every mandate in the chain carries. */
export const AP2_CONTEXTS = [
  "https://www.w3.org/ns/credentials/v2",
  "https://ap2.dev/contexts/v0.2",
] as const;

/** Stable AP2 type tags (W3C VC `type` array entries). */
export const MANDATE_TYPES = {
  intent: "AP2IntentMandate",
  cart: "AP2CartMandate",
  payment: "AP2PaymentMandate",
} as const;

/**
 * The `proof.type` we emit. It is deliberately self-describing: until the DID method and JWS signing
 * key are confirmed at the booth, the proof is an UNSIGNED stub, and the type says exactly that — no
 * caller can mistake it for a verified signature (law #4). On deploy, the signer swaps this for a real
 * `DataIntegrityProof` / RFC-7515 JWS keyed off the domain key.
 */
export const UNSIGNED_PROOF_TYPE = "Ap2UnsignedProofStub" as const;

/* ───────────────────────────── inputs ───────────────────────────── */

/**
 * A SessionGrant authorization, mirroring `ISessionGrant.Session` + its identity fields. This is the
 * canonical, on-chain mandate; every field below is read from (or derivable from) the chain, so the
 * VC this produces is a faithful view, never an independent claim.
 */
export interface SessionGrantAuthorization {
  /** Deterministic on-chain id = keccak256(owner, delegate, nonce). The mandate's stable key. */
  readonly sessionId: Hex;
  /** The granting account (EOA / 7702-EOA / smart account) — the AP2 "user" who set the scope. */
  readonly owner: Hex;
  /** The authorized spender — the agent the mandate delegates to. */
  readonly delegate: Hex;
  /** Total spendable budget, in the session unit's base units (token base units or USD-8dp), as a
   *  decimal string to preserve uint256 precision (never a JS number). */
  readonly budgetCap: string;
  /** Cumulative amount already spent (decimal string), `spent <= budgetCap`. Optional; defaults "0". */
  readonly spent?: string;
  /** Unix-second expiry — the mandate's timing window upper bound. */
  readonly expiry: number;
  /** The owner nonce consumed to open the session (replay context for the chain reader). */
  readonly nonce: number;
  /** The spend token contract (e.g. Arc USDC). Identifies WHAT the budget is denominated in. */
  readonly token: Hex;
  /** EVM chain id the SessionGrant lives on (e.g. Arc Testnet 5042002). */
  readonly chainId: number;
  /** True if the owner has revoked the session early (kill-switch). Optional; defaults false. */
  readonly revoked?: boolean;
}

/** One line item in an AP2 cart. */
export interface CartItem {
  /** Human-readable label. */
  readonly name: string;
  /** Quantity (positive integer). */
  readonly quantity: number;
  /** Unit price in the budget's base units, as a decimal string. */
  readonly unitPrice: string;
}

/** Inputs to derive a Cart Mandate (bound to an Intent Mandate). */
export interface CartInput {
  /** Stable merchant identifier (the counterparty requesting verification). */
  readonly merchantId: string;
  /** The cart contents. */
  readonly items: readonly CartItem[];
  /** Total cart amount in base units, decimal string. MUST equal the sum of line items (asserted). */
  readonly totalAmount: string;
}

/** Inputs to derive a Payment Mandate (bound to a Cart Mandate, referencing the x402 rail). */
export interface PaymentInput {
  /** CAIP-2 / x402 network id, e.g. "eip155:5042002". */
  readonly network: string;
  /** The settlement asset address (USDC), echoing the x402 requirements `asset`. */
  readonly asset: Hex;
  /** The atomic amount being charged on the rail (the x402 `amount`, atomic base-unit string). */
  readonly amount: string;
  /** The seller payout address (the x402 `payTo`). */
  readonly payTo: Hex;
  /** The x402 scheme — only "exact" is meaningful for EIP-3009 transferWithAuthorization. */
  readonly scheme?: "exact";
}

/* ───────────────────────────── outputs ───────────────────────────── */

/** The unsigned proof stub embedded in every mandate until the booth key is wired (law #4). */
export interface UnsignedProofStub {
  readonly type: typeof UNSIGNED_PROOF_TYPE;
  /** The proof purpose, per W3C Data Integrity. */
  readonly proofPurpose: "assertionMethod";
  /** The DID that WILL sign at deploy (verificationMethod placeholder). */
  readonly verificationMethod: string;
  /** A canonical sha-256 digest of the credential body the JWS will cover — lets a verifier confirm
   *  the eventual signature is over THIS exact content. Not itself a signature. */
  readonly contentDigest: Hex;
  /** Plain note that this is unsigned until deploy — never mistaken for a verified signature. */
  readonly note: string;
}

/** Common VC envelope shared by all three mandates. */
interface MandateBase {
  readonly "@context": typeof AP2_CONTEXTS;
  readonly id: string;
  readonly type: readonly string[];
  readonly issuer: string;
  readonly holder: string;
  readonly issuanceDate: string;
  readonly proof: UnsignedProofStub;
}

/** AP2 Intent Mandate — the SessionGrant authorization expressed as a W3C VC. */
export interface IntentMandate extends MandateBase {
  readonly type: readonly [typeof MANDATE_TYPES.intent, "VerifiableCredential"];
  readonly credentialSubject: {
    /** DID of the agent the mandate authorizes (derived from the SessionGrant delegate). */
    readonly id: string;
    /**
     * The agent's human DISPLAY NAME, present only when the caller supplied one (the
     * caller holds the plaintext client-side, like the merchant business name). It
     * makes the agent card carry a readable name for an AP2/A2A counterparty to show.
     * Absent when no name was provided — never fabricated (law #4).
     */
    readonly agentName?: string;
    /**
     * keccak256(toHex(agentName)) — the COMMITMENT to the display name, so a
     * counterparty can confirm the shown name matches the on-chain/on-the-wire
     * commitment (mirrors the merchant `nameHash`). Present iff `agentName` is.
     */
    readonly agentNameHash?: Hex;
    /** The bounded spending scope — the heart of the Intent Mandate. */
    readonly spendingScope: {
      readonly budgetCap: string;
      readonly spent: string;
      readonly remaining: string;
      readonly token: Hex;
      readonly chainId: number;
      readonly expiry: number;
      readonly expiresAt: string;
      readonly revocable: true;
      readonly revoked: boolean;
    };
    /** Provenance pointer back to the canonical on-chain mandate (the source of truth). */
    readonly onChainMandate: {
      readonly standard: "Access0x1.SessionGrant";
      readonly sessionId: Hex;
      readonly owner: Hex;
      readonly delegate: Hex;
      readonly nonce: number;
      readonly chainId: number;
    };
  };
}

/** AP2 Cart Mandate — the assembled cart, hash-bound to the Intent Mandate. */
export interface CartMandate extends MandateBase {
  readonly type: readonly [typeof MANDATE_TYPES.cart, "VerifiableCredential"];
  readonly credentialSubject: {
    readonly merchantId: string;
    readonly items: readonly CartItem[];
    readonly totalAmount: string;
    /** Non-repudiable link to the Intent Mandate (id + content digest). */
    readonly boundTo: MandateLink;
  };
}

/** AP2 Payment Mandate — authorizes the charge, hash-bound to the Cart Mandate, on the x402 rail. */
export interface PaymentMandate extends MandateBase {
  readonly type: readonly [typeof MANDATE_TYPES.payment, "VerifiableCredential"];
  readonly credentialSubject: {
    /** The payment rail — x402 / EIP-3009, the same rail AP2's x402 extension uses. */
    readonly rail: {
      readonly protocol: "x402";
      readonly extension: "ap2-x402";
      readonly scheme: "exact";
      readonly network: string;
      readonly asset: Hex;
      readonly amount: string;
      readonly payTo: Hex;
    };
    /** Signal that an AI agent drove this charge (AP2 Payment Mandate semantics). */
    readonly agentPresent: true;
    /** Non-repudiable link to the Cart Mandate. */
    readonly boundTo: MandateLink;
  };
}

/** A non-repudiable link from one mandate to the one it is bound to. */
export interface MandateLink {
  /** The bound-to mandate's `id`. */
  readonly mandateId: string;
  /** sha-256 over the canonical JSON of the bound-to mandate (tamper-evident). */
  readonly contentDigest: Hex;
}

/** The full AP2 mandate chain an AP2-aware counterparty verifies. */
export interface MandateChain {
  readonly intent: IntentMandate;
  readonly cart: CartMandate;
  readonly payment: PaymentMandate;
}

/* ───────────────────────────── helpers (pure) ───────────────────────────── */

/** Default DID method for the issuer/holder placeholders. BOOTH-CONFIRM: did:web vs did:pkh. */
const DEFAULT_DID_METHOD = "did:web:access0x1.xyz";

/** Build a `did:pkh` for an EVM address on a chain — the self-sovereign identifier for the party. */
export function didForAddress(address: Hex, chainId: number): string {
  return `did:pkh:eip155:${chainId}:${address.toLowerCase()}`;
}

/** Deterministic JSON canonicalization: object keys sorted recursively, no whitespace. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** sha-256 over the canonical JSON of `value`, as a 0x-prefixed hex digest. */
export function contentDigest(value: unknown): Hex {
  const hash = createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
  return `0x${hash}`;
}

/** Subtract two non-negative decimal-string integers, clamped at 0 (uint-safe via BigInt). */
function subClampZero(a: string, b: string): string {
  const diff = BigInt(a) - BigInt(b);
  return diff > 0n ? diff.toString() : "0";
}

/** The remaining live budget for an authorization (0 if revoked/expired, mirroring `remaining()`). */
export function remainingBudget(grant: SessionGrantAuthorization, nowSeconds: number): string {
  if (grant.revoked) return "0";
  if (nowSeconds > grant.expiry) return "0";
  return subClampZero(grant.budgetCap, grant.spent ?? "0");
}

/** Build the unsigned proof stub over a credential body (everything except the proof itself). */
function buildProofStub(body: unknown, verificationMethod: string): UnsignedProofStub {
  return {
    type: UNSIGNED_PROOF_TYPE,
    proofPurpose: "assertionMethod",
    verificationMethod,
    contentDigest: contentDigest(body),
    note:
      "UNSIGNED interop stub. The Access0x1 mandate is enforced on-chain by SessionGrant; this VC is " +
      "an additive view. A real RFC-7515 JWS / DataIntegrityProof is applied at deploy with the " +
      "domain signing key (BOOTH-CONFIRM: DID method + JWS suite).",
  };
}

/* ───────────────────────────── builders (pure) ───────────────────────────── */

/** Options shared by the builders (all optional; defaults keep functions pure + deterministic). */
export interface BuildOptions {
  /** Issuer DID override. Defaults to {@link DEFAULT_DID_METHOD}. BOOTH-CONFIRM the method. */
  readonly issuerDid?: string;
  /** ISO-8601 issuance date. Defaults to the epoch of `nowSeconds` so output is deterministic. */
  readonly issuanceDate?: string;
  /** Current time in unix seconds, for `remaining` + default issuanceDate. Defaults to expiry-derived. */
  readonly nowSeconds?: number;
  /** Origin used to mint mandate `id` URNs. Defaults to "https://access0x1.xyz". */
  readonly origin?: string;
  /**
   * The agent's human DISPLAY NAME, to carry on the Intent Mandate's agent card.
   * OPTIONAL: the caller (client-side) holds the plaintext; when supplied, the
   * credentialSubject gains a readable `agentName` + its `agentNameHash` commitment.
   * Omit it and the agent card stays name-less (the on-chain mandate is unaffected).
   * Blank / whitespace is treated as absent — we never fabricate a name (law #4).
   */
  readonly agentName?: string;
}

function resolveOpts(opts: BuildOptions | undefined, grant: SessionGrantAuthorization) {
  const nowSeconds = opts?.nowSeconds ?? 0;
  const issuanceDate = opts?.issuanceDate ?? new Date(nowSeconds * 1000).toISOString();
  return {
    issuerDid: opts?.issuerDid ?? DEFAULT_DID_METHOD,
    nowSeconds,
    issuanceDate,
    origin: opts?.origin ?? "https://access0x1.xyz",
  };
}

/**
 * Map a SessionGrant authorization to an AP2 Intent Mandate VC.
 *
 * The Intent Mandate is the "user pre-signs spending scope" credential. We populate the scope DIRECTLY
 * from the SessionGrant: budgetCap + token + expiry + delegate + the live `remaining`, with a
 * provenance pointer back to the on-chain `sessionId` (the source of truth). `revocable: true` is
 * structural — every SessionGrant carries an owner-only `revoke()`.
 *
 * @param grant - the on-chain SessionGrant authorization to express.
 * @param opts  - optional issuer/time overrides (defaults keep the output deterministic).
 * @returns a typed {@link IntentMandate} with an unsigned proof stub.
 */
export function sessionGrantToIntentMandate(
  grant: SessionGrantAuthorization,
  opts?: BuildOptions,
): IntentMandate {
  const { issuerDid, nowSeconds, issuanceDate, origin } = resolveOpts(opts, grant);
  const spent = grant.spent ?? "0";
  const remaining = remainingBudget(grant, nowSeconds);
  // The agent's human name is OPTIONAL and held client-side: when supplied we carry
  // both the readable name and its commitment hash on the agent card; when absent we
  // add neither field (never fabricate a name — law #4). This is the ONLY addition to
  // the credential body; the proof stub is still built over the body unchanged, so the
  // unsigned-stub honesty (it covers exactly THIS content, signature still deferred) holds.
  const trimmedAgentName = (opts?.agentName ?? "").trim();
  const agentNameFields: { agentName: string; agentNameHash: Hex } | Record<string, never> =
    trimmedAgentName.length > 0
      ? { agentName: trimmedAgentName, agentNameHash: agentNameHash(trimmedAgentName) as Hex }
      : {};
  const body = {
    "@context": AP2_CONTEXTS,
    id: `${origin}/ap2/intent/${grant.sessionId}`,
    type: [MANDATE_TYPES.intent, "VerifiableCredential"] as const,
    issuer: issuerDid,
    holder: didForAddress(grant.owner, grant.chainId),
    issuanceDate,
    credentialSubject: {
      id: didForAddress(grant.delegate, grant.chainId),
      ...agentNameFields,
      spendingScope: {
        budgetCap: grant.budgetCap,
        spent,
        remaining,
        token: grant.token,
        chainId: grant.chainId,
        expiry: grant.expiry,
        expiresAt: new Date(grant.expiry * 1000).toISOString(),
        revocable: true as const,
        revoked: grant.revoked ?? false,
      },
      onChainMandate: {
        standard: "Access0x1.SessionGrant" as const,
        sessionId: grant.sessionId,
        owner: grant.owner,
        delegate: grant.delegate,
        nonce: grant.nonce,
        chainId: grant.chainId,
      },
    },
  };
  return { ...body, proof: buildProofStub(body, issuerDid) };
}

/**
 * Build an AP2 Cart Mandate hash-bound to an Intent Mandate. The cart total MUST NOT exceed the
 * Intent Mandate's remaining budget (the scope is enforcing, even in the view layer — law #5: a cart
 * that overshoots the mandate is rejected, never silently accepted), and the line items MUST sum to
 * the stated total.
 *
 * @param intent - the Intent Mandate this cart is bound to (its digest is recorded for non-repudiation).
 * @param cart   - the cart contents + total.
 * @param opts   - optional issuer/time overrides.
 * @returns a typed {@link CartMandate}.
 * @throws if the items do not sum to `totalAmount`, or the total exceeds the mandate's remaining budget.
 */
export function buildCartMandate(
  intent: IntentMandate,
  cart: CartInput,
  opts?: BuildOptions,
): CartMandate {
  const issuerDid = opts?.issuerDid ?? DEFAULT_DID_METHOD;
  const nowSeconds = opts?.nowSeconds ?? 0;
  const issuanceDate = opts?.issuanceDate ?? new Date(nowSeconds * 1000).toISOString();
  const origin = opts?.origin ?? "https://access0x1.xyz";

  const itemsSum = cart.items.reduce(
    (acc, it) => acc + BigInt(it.unitPrice) * BigInt(it.quantity),
    0n,
  );
  if (itemsSum !== BigInt(cart.totalAmount)) {
    throw new Error(
      `Cart line items sum (${itemsSum}) does not equal totalAmount (${cart.totalAmount}).`,
    );
  }
  const remaining = BigInt(intent.credentialSubject.spendingScope.remaining);
  if (BigInt(cart.totalAmount) > remaining) {
    throw new Error(
      `Cart total (${cart.totalAmount}) exceeds the Intent Mandate remaining budget (${remaining}).`,
    );
  }

  const body = {
    "@context": AP2_CONTEXTS,
    id: `${origin}/ap2/cart/${intent.credentialSubject.onChainMandate.sessionId}`,
    type: [MANDATE_TYPES.cart, "VerifiableCredential"] as const,
    issuer: issuerDid,
    holder: intent.holder,
    issuanceDate,
    credentialSubject: {
      merchantId: cart.merchantId,
      items: cart.items,
      totalAmount: cart.totalAmount,
      boundTo: { mandateId: intent.id, contentDigest: contentDigest(intent) } as MandateLink,
    },
  };
  return { ...body, proof: buildProofStub(body, issuerDid) };
}

/**
 * Build an AP2 Payment Mandate hash-bound to a Cart Mandate, referencing the x402 rail. The payment
 * amount MUST equal the cart total (law #5: the charge is exactly what the cart authorized — no skim).
 *
 * @param cartMandate - the Cart Mandate this payment is bound to.
 * @param payment     - the x402 rail parameters (network, asset, amount, payTo).
 * @param opts        - optional issuer/time overrides.
 * @returns a typed {@link PaymentMandate}.
 * @throws if the payment amount does not equal the bound cart's total.
 */
export function buildPaymentMandate(
  cartMandate: CartMandate,
  payment: PaymentInput,
  opts?: BuildOptions,
): PaymentMandate {
  const issuerDid = opts?.issuerDid ?? DEFAULT_DID_METHOD;
  const nowSeconds = opts?.nowSeconds ?? 0;
  const issuanceDate = opts?.issuanceDate ?? new Date(nowSeconds * 1000).toISOString();
  const origin = opts?.origin ?? "https://access0x1.xyz";

  if (BigInt(payment.amount) !== BigInt(cartMandate.credentialSubject.totalAmount)) {
    throw new Error(
      `Payment amount (${payment.amount}) does not equal the bound cart total ` +
        `(${cartMandate.credentialSubject.totalAmount}).`,
    );
  }

  const body = {
    "@context": AP2_CONTEXTS,
    id: `${origin}/ap2/payment/${cartMandate.credentialSubject.boundTo.mandateId.split("/").pop()}`,
    type: [MANDATE_TYPES.payment, "VerifiableCredential"] as const,
    issuer: issuerDid,
    holder: cartMandate.holder,
    issuanceDate,
    credentialSubject: {
      rail: {
        protocol: "x402" as const,
        extension: "ap2-x402" as const,
        scheme: payment.scheme ?? ("exact" as const),
        network: payment.network,
        asset: payment.asset,
        amount: payment.amount,
        payTo: payment.payTo,
      },
      agentPresent: true as const,
      boundTo: {
        mandateId: cartMandate.id,
        contentDigest: contentDigest(cartMandate),
      } as MandateLink,
    },
  };
  return { ...body, proof: buildProofStub(body, issuerDid) };
}

/**
 * Build the full AP2 mandate chain (Intent ← Cart ← Payment) from a SessionGrant authorization, a
 * cart, and the x402 rail parameters. The chain is hash-linked end to end: any tamper at one level
 * breaks the next level's `boundTo.contentDigest`, making the chain non-repudiable.
 *
 * @param grant   - the on-chain SessionGrant authorization (the Intent Mandate source).
 * @param cart    - the cart contents + total.
 * @param payment - the x402 rail parameters for the Payment Mandate.
 * @param opts    - optional issuer/time overrides.
 * @returns the full {@link MandateChain}.
 */
export function buildMandateChain(
  grant: SessionGrantAuthorization,
  cart: CartInput,
  payment: PaymentInput,
  opts?: BuildOptions,
): MandateChain {
  const intent = sessionGrantToIntentMandate(grant, opts);
  const cartMandate = buildCartMandate(intent, cart, opts);
  const paymentMandate = buildPaymentMandate(cartMandate, payment, opts);
  return { intent, cart: cartMandate, payment: paymentMandate };
}

/**
 * Verify a mandate chain's hash links are intact (the part a counterparty can check with NO key — the
 * digests are sha-256, not signatures). Returns the first broken link, or null if the chain is sound.
 *
 * @param chain - a {@link MandateChain} to validate.
 * @returns null if every `boundTo.contentDigest` matches, else a description of the first mismatch.
 */
export function verifyChainLinks(chain: MandateChain): string | null {
  const intentDigest = contentDigest(chain.intent);
  if (chain.cart.credentialSubject.boundTo.contentDigest !== intentDigest) {
    return "Cart Mandate boundTo digest does not match the Intent Mandate.";
  }
  if (chain.cart.credentialSubject.boundTo.mandateId !== chain.intent.id) {
    return "Cart Mandate boundTo id does not match the Intent Mandate id.";
  }
  const cartDigest = contentDigest(chain.cart);
  if (chain.payment.credentialSubject.boundTo.contentDigest !== cartDigest) {
    return "Payment Mandate boundTo digest does not match the Cart Mandate.";
  }
  if (chain.payment.credentialSubject.boundTo.mandateId !== chain.cart.id) {
    return "Payment Mandate boundTo id does not match the Cart Mandate id.";
  }
  return null;
}
