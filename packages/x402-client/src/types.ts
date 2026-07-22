/**
 * @file types.ts — the {@link IAgentPayer} contract and its data shapes.
 *
 * IAgentPayer is the payment LEG only: given a resource, it discovers an x402 402
 * challenge, settles it through the Access0x1 rail, and returns the paid result. It is
 * not an agent runtime and decides nothing about WHAT to fetch. The identical contract
 * exists in the Python twin (`x402-client-py`); see `PARITY.md`.
 */

/**
 * A minimal fetch, so the payer is transport-injectable and unit-testable with a mock.
 * Matches the browser/Node global `fetch` signature.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * One `PaymentRequirements` entry from an x402 402 challenge (x402 v1 `accepts[]`).
 * Field names mirror the x402 specification exactly. Values arrive from an UNTRUSTED
 * resource server and are surfaced as-provided — the parser guarantees only that the
 * enclosing `accepts` array is present and non-empty, not that any field below is set.
 * Treat every field defensively; scheme-specific data rides in `extra`.
 */
export interface PaymentRequirement {
  /** Payment scheme identifier (e.g. "exact"). */
  readonly scheme: string;
  /** Blockchain network identifier (e.g. "base-sepolia"). */
  readonly network: string;
  /** Required payment amount in atomic token units, as a decimal string. */
  readonly maxAmountRequired: string;
  /** Token contract address. */
  readonly asset: string;
  /** Recipient wallet address for the payment. */
  readonly payTo: string;
  /** URL of the protected resource. */
  readonly resource: string;
  /** Human-readable description of the resource. */
  readonly description?: string;
  /** MIME type of the expected response. */
  readonly mimeType?: string;
  /** Maximum seconds allowed to complete payment. */
  readonly maxTimeoutSeconds?: number;
  /** Scheme-specific additional information. */
  readonly extra?: Record<string, unknown>;
}

/**
 * A parsed, validated x402 challenge (the 402 payment-required response body).
 * "Validated" means the body is a JSON object carrying a non-empty `accepts` array —
 * the x402 v1 signal that this is a genuine payment challenge. Individual requirement
 * fields are NOT validated (see {@link PaymentRequirement}).
 */
export interface PaymentChallenge {
  /** Protocol version identifier, when present. */
  readonly x402Version?: number;
  /** The acceptable payment methods (guaranteed non-empty by the parser). */
  readonly accepts: readonly PaymentRequirement[];
  /** The server's human-readable reason, when present. */
  readonly error?: string;
  /** The full parsed 402 body, for callers that need fields beyond the typed set. */
  readonly raw: unknown;
}

/**
 * Options for a single {@link IAgentPayer.fetch} call. Kept small and framework-free
 * so the Python twin mirrors it exactly.
 */
export interface PayerRequestInit {
  /** HTTP method for the resource probe (default "GET"). */
  readonly method?: string;
  /** Extra headers for the resource probe. */
  readonly headers?: Record<string, string>;
  /** Request body for the resource probe (rarely needed for a GET resource). */
  readonly body?: string;
  /**
   * USD to authorize for this call, forwarded to the rail as `pricePerCallUsd`. Omit
   * to let the rail apply its configured default. The rail's meter is the budget
   * authority — this is a per-call ceiling, not a client-held wallet.
   */
  readonly pricePerCallUsd?: number;
}

/**
 * A resolved settlement from the rail's agent-pay endpoint (`POST /api/agent/pay`).
 * Exactly one of {@link PaymentSettlement.result} / {@link PaymentSettlement.results}
 * is set, depending on whether a nano-loop (`count > 1`) was requested.
 */
export interface PaymentSettlement<T = unknown> {
  /** Always `true`: a settlement exists only when the rail answered `ok: true`. */
  readonly paid: true;
  /** Single-call resource result (rail `result`), present when `count <= 1`. */
  readonly result?: T;
  /** Nano-loop results (rail `results`), present when `count > 1`. */
  readonly results?: readonly T[];
  /** The paying agent's address (rail `agent`), when reported. */
  readonly agent?: string;
  /** The full parsed rail body (forward-compatible: `rail`, `quote`, tx hashes, …). */
  readonly raw: unknown;
}

/**
 * The outcome of {@link IAgentPayer.fetch}: either a paid-and-settled resource, or an
 * unpaid passthrough when the resource did not answer 402.
 */
export interface PaymentOutcome<T = unknown> {
  /** `true` when the rail settled a payment; `false` for a non-402 passthrough. */
  readonly paid: boolean;
  /** Final HTTP status: `200` on a paid settlement; the resource's status on passthrough. */
  readonly status: number;
  /** The resource content — rail `result` when paid, else the resource body. */
  readonly result: T;
  /** The paying agent's address, when paid. */
  readonly agent?: string;
  /** The discovered x402 challenge, when paid. */
  readonly challenge?: PaymentChallenge;
  /** The full settlement, when paid. */
  readonly settlement?: PaymentSettlement<T>;
}

/**
 * A direct settle request — the payment leg in isolation, for runtimes that performed
 * their own fetch and already hold the 402. Fields map 1:1 to the rail's
 * `POST /api/agent/pay` body; no field here is invented.
 */
export interface SettleRequest {
  /** The resource URL the rail pays for and fetches (rail `url`). */
  readonly url: string;
  /**
   * A discovered challenge. When provided it is re-validated (malformed → refuse to
   * settle); omit only when the caller already knows the URL is x402-protected.
   */
  readonly challenge?: PaymentChallenge;
  /** USD to authorize → rail `pricePerCallUsd`. Omit for the rail default. */
  readonly pricePerCallUsd?: number;
  /** Fire N sequential micro-calls → rail `count` (nano-loop). Omit or `1` for a single call. */
  readonly count?: number;
  /** Opt into the rail's private settlement path → rail `private`. */
  readonly private?: boolean;
  /** Merchant payee for the private path → rail `merchant` (required when `private`). */
  readonly merchant?: string;
  /** Price this call in another token → rail `quoteToken` (additive; never affects settlement). */
  readonly quoteToken?: string;
}

/**
 * IAgentPayer — the minimal payment leg an agent runtime uses to pay through the
 * Access0x1 rail via x402. Two methods, one contract, mirrored in both language twins.
 */
export interface IAgentPayer {
  /**
   * Fetch `url`. On a non-402 response, pass it through unpaid. On a 402, discover and
   * validate the x402 challenge, settle it through the rail, and return the paid
   * result. At most ONE settle attempt — no automatic re-probe (the rail owns its own
   * internal x402 pay-and-retry).
   *
   * @param url - the resource to fetch.
   * @param init - optional probe options + the per-call price ceiling.
   * @returns the paid outcome, or an unpaid passthrough.
   * @throws {MalformedChallengeError} a 402 whose body is not a valid x402 challenge.
   * @throws {BudgetExceededError} the rail rejected the spend on budget.
   * @throws {HumanGateRequiredError} the rail requires a verified human.
   * @throws {PaymentUnresolvedError} the rail could not resolve the challenge.
   * @throws {PaymentRailError} any other structured rail failure.
   */
  fetch<T = unknown>(url: string, init?: PayerRequestInit): Promise<PaymentOutcome<T>>;

  /**
   * Settle an already-discovered challenge through the rail — the payment leg in
   * isolation. Same error taxonomy as {@link IAgentPayer.fetch}.
   *
   * @param request - the settle request (maps 1:1 to the rail body).
   * @returns the resolved settlement.
   */
  settle<T = unknown>(request: SettleRequest): Promise<PaymentSettlement<T>>;
}
