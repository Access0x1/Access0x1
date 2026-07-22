/**
 * @file errors.ts — the payment-leg error taxonomy shared by every {@link IAgentPayer}.
 *
 * Both language twins (TypeScript here, Python in `x402-client-py`) raise the SAME
 * error kinds with the SAME meaning, so a runtime that switches languages keeps
 * identical failure handling (see `PARITY.md`). Every error is a distinct class so a
 * caller can branch on `instanceof`; the payer NEVER swallows a money-path failure.
 */

/**
 * Base class for every error the x402 client raises. Not thrown directly — catch a
 * concrete subclass, or this base to catch them all.
 */
export class X402ClientError extends Error {
  /**
   * @param message - a human-readable description with no secret or stack detail.
   */
  constructor(message: string) {
    super(message);
    // `new.target` is the leaf subclass even though this base constructor runs; both
    // lines keep `name` and `instanceof` correct across the hierarchy on every target.
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The resource server answered 402 but the body was not a valid x402 challenge (no
 * non-empty `accepts` array). The payer REFUSES to pay a 402 it cannot recognize —
 * it never blindly settles an unknown challenge, and never reaches the rail.
 */
export class MalformedChallengeError extends X402ClientError {
  /** The raw 402 body that failed validation (parsed JSON or text), for diagnostics. */
  readonly body: unknown;

  /**
   * @param message - why the challenge was rejected.
   * @param body - the raw 402 body that failed validation.
   */
  constructor(message: string, body: unknown) {
    super(message);
    this.body = body;
  }
}

/**
 * The rail rejected the payment because the daily budget cap would be exceeded
 * (rail `402 { error: "BudgetExceeded", spent, cap }`). Surfaced, never swallowed, so
 * an agent stops spending instead of silently retrying into the cap.
 */
export class BudgetExceededError extends X402ClientError {
  /** Cumulative USD already spent this window, as reported by the rail (may be absent). */
  readonly spent?: number;
  /** The daily USD cap, as reported by the rail (may be absent). */
  readonly cap?: number;

  /**
   * @param spent - the rail's reported cumulative spend.
   * @param cap - the rail's reported daily cap.
   */
  constructor(spent?: number, cap?: number) {
    super(`BudgetExceeded: spent=${spent ?? "?"} cap=${cap ?? "?"}`);
    this.spent = spent;
    this.cap = cap;
  }
}

/**
 * The rail requires a verified human behind the agent before it will spend (rail
 * `402 { error: "HumanGateRequired" }`). Distinct from {@link BudgetExceededError} so
 * a caller can route the human through verification rather than treat it as over-spend.
 */
export class HumanGateRequiredError extends X402ClientError {
  constructor() {
    super("HumanGateRequired: the rail requires a verified human for this agent");
  }
}

/**
 * The payment leg ran but the challenge was never resolved (rail
 * `502 { error: "PaymentRequiredUnresolved" }`): the resource still answered 402 after
 * the rail attempted settlement. The rail refunds the reservation on this path.
 */
export class PaymentUnresolvedError extends X402ClientError {
  /** The resource URL that stayed 402 after payment. */
  readonly url: string;

  /**
   * @param url - the resource URL that stayed 402.
   */
  constructor(url: string) {
    super(`PaymentUnresolved: ${url} still returned 402 after payment`);
    this.url = url;
  }
}

/**
 * Any other structured, non-success answer from the rail — `400 BadRequest`,
 * `401 Unauthorized`, `500 Internal`, `503 not_configured`, `502 PrivatePayFailed`, or
 * a `200` without `ok: true`. Carries the HTTP status and the rail's own error code so
 * nothing is hidden from the caller.
 */
export class PaymentRailError extends X402ClientError {
  /** The HTTP status the rail returned. */
  readonly status: number;
  /** The rail's `error` code (e.g. "BadRequest", "Unauthorized", "Internal"). */
  readonly code: string;
  /** The rail's `reason`/`code` detail, when present. */
  readonly detail?: string;
  /** The full parsed rail body, for diagnostics. */
  readonly body: unknown;

  /**
   * @param status - the HTTP status the rail returned.
   * @param code - the rail's `error` code.
   * @param detail - the rail's `reason`/`code` detail, when present.
   * @param body - the full parsed rail body.
   */
  constructor(status: number, code: string, detail: string | undefined, body: unknown) {
    super(`PaymentRailError: ${status} ${code}${detail ? ` — ${detail}` : ""}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.body = body;
  }
}
