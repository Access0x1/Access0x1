/**
 * Local type shim for `@unlink-xyz/sdk`.
 *
 * WHY THIS EXISTS
 * ----------------
 * The Unlink SDK is a proprietary package whose exact API surface and argument
 * shapes are confirmed at the ETHGlobal booth against the live `docs.unlink.xyz`
 * pages and the canary dist-tag (see spec §8). To keep this unit's gate green and
 * self-contained off a clean `main` — without pinning a moving canary tarball —
 * we declare ONLY the narrow surface this unit consumes. Swap `paths` in
 * `tsconfig.json` to the real package once the semver is pinned at the booth.
 *
 * ⚠️ BOOTH-CONFIRM every signature below against the live SDK before the live
 * smoke test. These are the shapes the spec (§4) describes; they are intentionally
 * conservative and must be reconciled with the real `depositWithApproval` /
 * `transfer` / `withdraw` arg shapes verbatim from the docs.
 */
declare module "@unlink-xyz/sdk" {
  import type { WalletClient } from "viem";

  /** Unlink environment string. Kebab-case for the SDK (NOT camel `arcTestnet`). */
  export type UnlinkEnvironment = "arc-testnet" | (string & {});

  /** Inputs to derive a deterministic Unlink account from an Ethereum signature. */
  export interface FromEthereumSignatureParams {
    signature: `0x${string}`;
    appId: string;
    chainId: number;
  }

  /** Inputs to build the deterministic seed message the Dynamic signer signs. */
  export interface DeriveSeedMessageParams {
    appId: string;
    chainId: number;
  }

  /**
   * A seed-backed or key-backed Unlink account. Seed-backed accounts
   * (`fromEthereumSignature`) support execute; key-backed (`fromKeys`) do not.
   */
  export interface UnlinkAccount {
    /** The account's public Unlink address (the `unlink1…` bech32 form is separate). */
    readonly address: `0x${string}`;
  }

  /** Namespace object exported as `account`. */
  export interface AccountFactory {
    fromEthereumSignature(params: FromEthereumSignatureParams): Promise<UnlinkAccount>;
    fromKeys(params: { privateKey: `0x${string}` }): Promise<UnlinkAccount>;
  }

  /** The `account` export — factory for deriving Unlink accounts. */
  export const account: AccountFactory;

  /** Build the deterministic seed message to be signed by the Dynamic signer. */
  export function buildDeriveSeedMessage(params: DeriveSeedMessageParams): string;

  /** Result of a settled on-chain Unlink action. */
  export interface TxReceipt {
    txHash: `0x${string}`;
  }

  /** A live Unlink client bound to one account + environment. */
  export interface UnlinkClient {
    /**
     * Shield USDC into the private set. The user pays Arc gas for this leg.
     * ⚠️ BOOTH-CONFIRM the arg shape (decimals/approval ordering).
     */
    depositWithApproval(params: {
      token: `0x${string}`;
      amount: bigint;
    }): Promise<TxReceipt>;

    /**
     * Withdraw from the private set to a destination EOA. Gasless (Unlink relays).
     * ⚠️ BOOTH-CONFIRM the arg shape.
     */
    withdraw(params: {
      amount: bigint;
      destination: `0x${string}`;
    }): Promise<TxReceipt>;

    /**
     * Private transfer inside the shielded set. Gasless (Unlink relays).
     * ⚠️ BOOTH-CONFIRM the arg shape.
     */
    transfer(params: {
      amount: bigint;
      to: string;
    }): Promise<TxReceipt>;

    /** Wait for an Unlink tx to settle. */
    waitForTx(txHash: `0x${string}`): Promise<TxReceipt>;
  }

  export interface CreateUnlinkClientParams {
    environment: UnlinkEnvironment;
    account: UnlinkAccount;
    userId: string;
    authorizationToken?: string;
  }

  /** Instantiate a client for a derived/keyed account. */
  export function createUnlinkClient(params: CreateUnlinkClientParams): UnlinkClient;

  export interface UnlinkAdmin {
    users: {
      register(params: { userId: string }): Promise<void>;
    };
  }

  export interface CreateUnlinkAdminParams {
    environment: UnlinkEnvironment;
    apiKey: string;
  }

  /** Server-only admin client (uses the secret API key). */
  export function createUnlinkAdmin(params: CreateUnlinkAdminParams): UnlinkAdmin;

  /** Re-export so callers can use the viem WalletClient type without a direct dep line. */
  export type { WalletClient };
}
