/**
 * @file payer.ts — {@link Access0x1Payer}, the concrete {@link IAgentPayer} for the
 * Access0x1 rail.
 *
 * The flow, matching the x402 protocol and the rail's real endpoints:
 *   1. DISCOVER — fetch the resource once (the natural unpaid x402 request). A non-402
 *      response passes through unpaid; a 402 body is parsed + validated as an x402
 *      challenge ({@link parseChallenge}).
 *   2. SETTLE — POST the resource URL to the rail's `/api/agent/pay`, which signs and
 *      settles the EIP-3009 USDC payment and performs the paid retry internally.
 *   3. RETURN — surface the rail's `result` as the paid resource content.
 *
 * All configuration is explicit constructor input — the library reads NO ambient env,
 * so it is safe to embed in any agent runtime. The `x-internal-secret` caller-auth
 * header is sent only when a `callerAuth` value is supplied.
 */

import { parseChallenge } from "./challenge.js";
import {
  BudgetExceededError,
  HumanGateRequiredError,
  PaymentRailError,
  PaymentUnresolvedError,
} from "./errors.js";
import type {
  FetchLike,
  IAgentPayer,
  PayerRequestInit,
  PaymentOutcome,
  PaymentSettlement,
  SettleRequest,
} from "./types.js";

/**
 * Configuration for {@link Access0x1Payer}. All inputs are explicit — the library
 * performs NO ambient env reads.
 */
export interface Access0x1PayerConfig {
  /** Base URL of the Access0x1 rail, e.g. "https://pay.example.com" (trailing slash optional). */
  readonly baseUrl: string;
  /** Optional internal shared secret, sent as the `x-internal-secret` header to the rail. */
  readonly callerAuth?: string;
  /** Injected fetch. Defaults to the global `fetch`; override for tests or custom transports. */
  readonly fetchImpl?: FetchLike;
  /** Agent-pay endpoint path (default `/api/agent/pay`). */
  readonly payPath?: string;
  /** AP2 mandate endpoint path (default `/api/ap2/mandate`). */
  readonly mandatePath?: string;
}

/** Coerce an unknown value to a number, or `undefined` when it is not a finite number. */
function numOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Coerce an unknown value to a string, or `undefined` when it is not a string. */
function strOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Coerce an unknown value to a string, falling back to `fallback` when it is not one. */
function strOr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

/**
 * Read a response body as parsed JSON, falling back to text, and to `null` when empty.
 * Never throws — a non-JSON body simply returns its text.
 *
 * @param res - the response to read.
 * @returns the parsed JSON value, the raw text, or `null`.
 */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The concrete {@link IAgentPayer} for the Access0x1 rail. Construct once per rail
 * deployment and reuse across calls.
 *
 * @example
 * ```ts
 * const payer = new Access0x1Payer({ baseUrl: "https://pay.example.com" });
 * const out = await payer.fetch("https://api.example.com/premium");
 * if (out.paid) console.log("paid by", out.agent, "→", out.result);
 * ```
 */
export class Access0x1Payer implements IAgentPayer {
  private readonly baseUrl: string;
  private readonly callerAuth?: string;
  private readonly fetchImpl: FetchLike;
  private readonly payPath: string;
  private readonly mandatePath: string;

  /**
   * @param config - the rail base URL plus optional caller-auth, fetch, and path overrides.
   * @throws {Error} when `baseUrl` is missing or empty.
   */
  constructor(config: Access0x1PayerConfig) {
    if (typeof config?.baseUrl !== "string" || config.baseUrl.length === 0) {
      throw new Error("Access0x1Payer: `baseUrl` is required");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.callerAuth = config.callerAuth;
    const injected = config.fetchImpl;
    // Default to the global fetch, wrapped so the receiver stays correct when injected.
    this.fetchImpl = injected ?? ((url, init) => fetch(url, init));
    this.payPath = config.payPath ?? "/api/agent/pay";
    this.mandatePath = config.mandatePath ?? "/api/ap2/mandate";
  }

  /** @inheritdoc */
  async fetch<T = unknown>(url: string, init?: PayerRequestInit): Promise<PaymentOutcome<T>> {
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("Access0x1Payer.fetch: `url` is required");
    }
    const probe = await this.fetchImpl(url, {
      method: init?.method ?? "GET",
      headers: init?.headers,
      body: init?.body,
    });

    // Non-402 → unpaid passthrough. The payer takes no view on non-payment statuses;
    // the caller inspects `status`.
    if (probe.status !== 402) {
      return { paid: false, status: probe.status, result: (await readBody(probe)) as T };
    }

    // 402 → discover + validate the challenge (throws MalformedChallengeError, never
    // reaching the rail, if the body is not a genuine x402 challenge).
    const challenge = parseChallenge(await readBody(probe));

    const settlement = await this.settle<T>({
      url,
      challenge,
      pricePerCallUsd: init?.pricePerCallUsd,
    });
    return {
      paid: true,
      status: 200,
      result: settlement.result as T,
      agent: settlement.agent,
      challenge,
      settlement,
    };
  }

  /** @inheritdoc */
  async settle<T = unknown>(request: SettleRequest): Promise<PaymentSettlement<T>> {
    if (typeof request?.url !== "string" || request.url.length === 0) {
      throw new Error("Access0x1Payer.settle: `url` is required");
    }
    // Re-validate a supplied challenge — refuse to settle a malformed one, even when the
    // caller discovered the 402 themselves.
    if (request.challenge !== undefined) {
      parseChallenge(request.challenge as unknown);
    }

    // Build the rail body from ONLY the fields the endpoint accepts (nothing invented).
    const body: Record<string, unknown> = { url: request.url };
    if (request.count !== undefined) body.count = request.count;
    if (request.pricePerCallUsd !== undefined) body.pricePerCallUsd = request.pricePerCallUsd;
    if (request.private !== undefined) body.private = request.private;
    if (request.merchant !== undefined) body.merchant = request.merchant;
    if (request.quoteToken !== undefined) body.quoteToken = request.quoteToken;

    const res = await this.postJson(this.payPath, body);
    return this.mapPayResponse<T>(request.url, res.status, await readBody(res));
  }

  /**
   * POST a JSON body to a rail path, attaching the caller-auth header when configured.
   *
   * @param path - the rail path (e.g. `/api/agent/pay`).
   * @param body - the JSON-serializable request body.
   * @returns the raw response.
   */
  private async postJson(path: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.callerAuth) {
      headers["x-internal-secret"] = this.callerAuth;
    }
    return this.fetchImpl(this.baseUrl + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  /**
   * Map a rail `/api/agent/pay` response to a {@link PaymentSettlement}, or throw the
   * matching taxonomy error. Every non-success path throws — the money path is never
   * swallowed into a silent success.
   *
   * @param url - the resource URL (for {@link PaymentUnresolvedError}).
   * @param status - the rail HTTP status.
   * @param data - the parsed rail body.
   * @returns the settlement on `200 { ok: true }`.
   */
  private mapPayResponse<T>(url: string, status: number, data: unknown): PaymentSettlement<T> {
    const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;

    if (status === 200 && d.ok === true) {
      return {
        paid: true,
        result: d.result as T | undefined,
        results: d.results as readonly T[] | undefined,
        agent: strOrUndefined(d.agent),
        raw: data,
      };
    }
    if (status === 402) {
      if (d.error === "BudgetExceeded") {
        throw new BudgetExceededError(numOrUndefined(d.spent), numOrUndefined(d.cap));
      }
      if (d.error === "HumanGateRequired") {
        throw new HumanGateRequiredError();
      }
      throw new PaymentRailError(status, strOr(d.error, "PaymentRequired"), strOrUndefined(d.reason), data);
    }
    if (status === 502 && d.error === "PaymentRequiredUnresolved") {
      throw new PaymentUnresolvedError(url);
    }
    // 400 / 401 / 500 / 503 / 502-PrivatePayFailed / a 200 without ok:true — surface it.
    throw new PaymentRailError(
      status,
      strOr(d.error, "PaymentRailError"),
      strOrUndefined(d.reason) ?? strOrUndefined(d.code),
      data,
    );
  }
}
