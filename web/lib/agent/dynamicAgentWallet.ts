/**
 * @file dynamicAgentWallet.ts — lazy Dynamic node-SDK auth singleton + MPC wallet
 * create/get for the autonomous agent.
 *
 * Design decision #1 (lazy singleton auth): `authenticateApiToken()` is called ONCE per
 * process — re-authing on every request would hit Dynamic's rate limit. The client and the
 * agent account are memoised at module scope.
 *
 * The exact node-SDK class (`@dynamic-labs-wallet/node-evm`) is a booth-confirm dependency,
 * so its surface is captured here as the narrow {@link DynamicEvmWalletClient} interface and
 * obtained via an injectable factory ({@link setDynamicClientFactory}). Every other file in
 * this unit depends only on the stable shapes exported here — never on the concrete package —
 * which keeps the unit type-checking and unit-testable before the package major is pinned.
 *
 * Server-only (doctrine guardrail #4 / #7): reads `DYNAMIC_*` and `WALLET_PASSWORD` from the
 * server env; these never reach the browser.
 */

import { assertServerOnly } from "./serverOnly.js";

assertServerOnly("dynamicAgentWallet");

/** A 0x-prefixed lowercase hex string. */
export type Hex = `0x${string}`;

/** EIP-712 typed-data payload passed to the MPC signer. Structurally minimal on purpose. */
export interface TypedData {
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, unknown>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
}

/**
 * The Dynamic node SDK MPC wallet account shape this unit relies on. Field names match the
 * Dynamic node SDK's `createWalletAccount` / `getWalletAccount` return.
 */
export interface AgentAccount {
  /** The on-chain EVM address of the MPC wallet. */
  readonly accountAddress: Hex;
  /** The wallet's public key, hex-encoded. */
  readonly publicKeyHex: string;
  /** Stable wallet id — persist this as `AGENT_WALLET_ID` to reuse the wallet. */
  readonly walletId: string;
}

/**
 * The minimal Dynamic node-SDK surface the agent uses. The concrete client
 * (`@dynamic-labs-wallet/node-evm`) is booth-confirmed; this interface is the only contract
 * the rest of the unit knows about.
 *
 * @warn BOOTH-CONFIRM: confirm the exact method names against
 *   `github.com/dynamic-labs-oss/dynamic-agent-payments` before wiring the real package.
 */
export interface DynamicEvmWalletClient {
  /** Authenticate the server API token. Called at most once per process. */
  authenticateApiToken(token: string): Promise<void>;
  /** Create a new MPC wallet account, encrypting the client share with `password`. */
  createWalletAccount(args: { password: string }): Promise<AgentAccount>;
  /** Fetch an existing MPC wallet account by id, decrypting with `password`. */
  getWalletAccount(args: { walletId: string; password: string }): Promise<AgentAccount>;
  /** Sign EIP-712 typed data with the MPC wallet identified by `walletId`. */
  signTypedData(args: { walletId: string; password: string; typedData: TypedData }): Promise<Hex>;
  /** Sign a raw message with the MPC wallet identified by `walletId`. */
  signMessage(args: { walletId: string; password: string; message: string | Uint8Array }): Promise<Hex>;
}

/** Factory that constructs a {@link DynamicEvmWalletClient} for a given environment id. */
export type DynamicClientFactory = (environmentId: string) => DynamicEvmWalletClient;

/** Thrown when a required server env var is missing — never leaks the value (there is none). */
export class ConfigMissing extends Error {
  constructor(varName: string) {
    super(`ConfigMissing: required server env var ${varName} is not set`);
    this.name = "ConfigMissing";
  }
}

/**
 * The default factory. Throws until the booth-confirmed package is pinned and wired — the
 * unit ships with its real client injected at app boot via {@link setDynamicClientFactory},
 * and tests inject a mock. Keeping the default a throw (rather than a half-real client)
 * makes a missing wiring loud instead of silent.
 */
let clientFactory: DynamicClientFactory = () => {
  throw new ConfigMissing("DYNAMIC_CLIENT_FACTORY");
};

/**
 * Inject the Dynamic client factory. Called once at app boot with the real
 * `@dynamic-labs-wallet/node-evm` constructor, and by tests with a mock. Resets the memoised
 * singleton so a fresh factory takes effect.
 *
 * @param factory The factory used to build the client, or `null` to restore the default throw.
 * @returns void
 */
export function setDynamicClientFactory(factory: DynamicClientFactory | null): void {
  clientFactory = factory ?? (() => {
    throw new ConfigMissing("DYNAMIC_CLIENT_FACTORY");
  });
  client = null;
  authPromise = null;
  account = null;
  accountPromise = null;
}

/** Read a required server env var or throw {@link ConfigMissing}. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new ConfigMissing(name);
  }
  return value;
}

let client: DynamicEvmWalletClient | null = null;
let authPromise: Promise<DynamicEvmWalletClient> | null = null;
let account: AgentAccount | null = null;
let accountPromise: Promise<AgentAccount> | null = null;

/**
 * Get the authenticated Dynamic client, authenticating exactly once per process
 * (design decision #1). Concurrent callers await the same in-flight auth promise, so
 * `authenticateApiToken` is never invoked more than once.
 *
 * @returns The memoised, authenticated {@link DynamicEvmWalletClient}.
 * @throws {ConfigMissing} if `DYNAMIC_ENVIRONMENT_ID` or `DYNAMIC_AUTH_TOKEN` is unset.
 */
export async function getAgentClient(): Promise<DynamicEvmWalletClient> {
  if (client) {
    return client;
  }
  if (!authPromise) {
    const environmentId = requireEnv("DYNAMIC_ENVIRONMENT_ID");
    const authToken = requireEnv("DYNAMIC_AUTH_TOKEN");
    const fresh = clientFactory(environmentId);
    authPromise = fresh.authenticateApiToken(authToken).then(() => {
      client = fresh;
      return fresh;
    });
  }
  return authPromise;
}

/**
 * Get the agent's MPC wallet account, creating it once on first boot and reusing it
 * thereafter. When `AGENT_WALLET_ID` is set the existing wallet is fetched (never
 * re-created); otherwise a new wallet is created and its id should be persisted to
 * `AGENT_WALLET_ID` for the next boot. The result is memoised — repeated calls return the
 * same object with no extra create/get.
 *
 * @returns The agent's {@link AgentAccount}.
 * @throws {ConfigMissing} if `WALLET_PASSWORD` (or any auth env var) is unset.
 */
export async function getOrCreateAgentAccount(): Promise<AgentAccount> {
  if (account) {
    return account;
  }
  if (!accountPromise) {
    accountPromise = (async () => {
      const c = await getAgentClient();
      const password = requireEnv("WALLET_PASSWORD");
      const walletId = process.env.AGENT_WALLET_ID;
      const acct = walletId
        ? await c.getWalletAccount({ walletId, password })
        : await c.createWalletAccount({ password });
      account = acct;
      return acct;
    })();
  }
  return accountPromise;
}

/**
 * Shorthand for the agent's on-chain address — handy for the API response and any UI.
 *
 * @returns The agent MPC wallet's `0x…` address.
 * @throws {ConfigMissing} if any required auth env var is unset.
 */
export async function agentAddress(): Promise<Hex> {
  const acct = await getOrCreateAgentAccount();
  return acct.accountAddress;
}

/**
 * Reset the memoised client and account. Test-only hook so each test file starts from a
 * clean singleton; production never calls this.
 *
 * @returns void
 */
export function __resetWalletForTests(): void {
  client = null;
  authPromise = null;
  account = null;
  accountPromise = null;
}
