/**
 * deriveMerchantAccount — browser-side derivation of a merchant's Unlink account.
 *
 * The merchant's private account is derived deterministically from their Dynamic
 * embedded wallet via the `fromEthereumSignature` path (spec §2a): the same signer
 * that authenticates the user signs a deterministic seed message, and Unlink derives
 * the seed-backed account LOCALLY. No mnemonic, no envelope, nothing persisted —
 * re-deriving with the same (signer, appId, chainId) recovers the same balance.
 *
 * ⚠️ BOOTH-CONFIRM the exact import names + arg shapes against the live
 * `@unlink-xyz/sdk` canary at the booth (docs.unlink.xyz/accounts-and-keys.md).
 */
import type { UnlinkAccount, WalletClient } from "@unlink-xyz/sdk";
import { ARC_TESTNET_ID } from "../chains.js";
import { loadUnlinkSdk } from "./loadSdk.js";

/** Arc chain id (5042002) — same chain for Unlink env `arc-testnet` AND Circle `arcTestnet`.
 * Derived from the canonical {@link ARC_TESTNET_ID} (single source of truth in `lib/chains.ts`). */
export const ARC_CHAIN_ID = ARC_TESTNET_ID;

/**
 * Derive a merchant's Unlink account deterministically from their Dynamic signer.
 *
 * Asserts:
 *  - `buildDeriveSeedMessage` is called with `{ appId, chainId: ARC_CHAIN_ID }`.
 *  - the Dynamic signer signs exactly that message (no extra prefixing here).
 *  - `account.fromEthereumSignature` is called with `{ signature, appId, chainId }`.
 *
 * Determinism invariant: same `(signer, appId, chainId=5042002)` always yields the
 * same Unlink account address — the seed message and signature are deterministic.
 *
 * Non-custody guarantee: the seed never leaves the browser. This function MUST run
 * client-side only; calling it on the server (no `window`) throws to make the
 * boundary loud (the backend uses `account.fromKeys` via payoutService instead).
 *
 * @param signer  A viem WalletClient (from `useUserWallet().getSigner()`).
 * @param appId   `UNLINK_APP_ID` (public — passed to the seed message).
 * @returns       A seed-backed `UnlinkAccount` (supports deposit/transfer/withdraw/execute).
 */
export async function deriveMerchantUnlinkAccount(
  signer: WalletClient,
  appId: string,
): Promise<UnlinkAccount> {
  // Server-only guard: this derivation is browser-only — the seed must never be
  // produced server-side. If there is no `window`, refuse loudly (spec §6 test).
  if (typeof window === "undefined") {
    throw new Error(
      "deriveMerchantUnlinkAccount must run in the browser (the seed never leaves the client). " +
        "Server payouts use account.fromKeys via payoutService.",
    );
  }
  if (!appId) {
    throw new Error("deriveMerchantUnlinkAccount: appId is required");
  }
  const accountAddress = signer.account?.address;
  if (!accountAddress) {
    throw new Error("deriveMerchantUnlinkAccount: signer has no account address");
  }

  // Load the SDK at call time (optional/dynamic) so a missing package never
  // breaks the build or module load — only this derivation, when actually used.
  const { account: UnlinkAccountFactory, buildDeriveSeedMessage } = await loadUnlinkSdk();

  const message = buildDeriveSeedMessage({ appId, chainId: ARC_CHAIN_ID });
  const signature = await signer.signMessage({
    account: signer.account!,
    message,
  });

  return UnlinkAccountFactory.fromEthereumSignature({
    signature,
    appId,
    chainId: ARC_CHAIN_ID,
  });
}
