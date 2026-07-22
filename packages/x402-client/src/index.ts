/**
 * @file index.ts — the public surface of `@access0x1/x402-client`.
 *
 * IAgentPayer is the minimal client an agent runtime uses to pay through the Access0x1
 * rail via x402: it discovers the 402 challenge, settles it through the rail, and
 * returns the paid result. This entry point re-exports the interface, the concrete
 * {@link Access0x1Payer}, the challenge parser, the AP2 mandate types, and the full
 * error taxonomy.
 */

export type {
  FetchLike,
  IAgentPayer,
  PayerRequestInit,
  PaymentChallenge,
  PaymentOutcome,
  PaymentRequirement,
  PaymentSettlement,
  SettleRequest,
} from "./types.js";

export type {
  CartInput,
  CartItem,
  Hex,
  MandateBuildOptions,
  MandateRequest,
  MandateResult,
  PaymentInput,
  SessionGrantAuthorization,
} from "./mandate.js";

export {
  BudgetExceededError,
  HumanGateRequiredError,
  MalformedChallengeError,
  PaymentRailError,
  PaymentUnresolvedError,
  X402ClientError,
} from "./errors.js";

export { parseChallenge } from "./challenge.js";
export { Access0x1Payer, type Access0x1PayerConfig } from "./payer.js";
