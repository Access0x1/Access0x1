/**
 * call.ts — the ONE place the generic contract console reaches viem with a
 * runtime-chosen ABI + function name. viem's `readContract` / `writeContract`
 * are designed for a `const` ABI + a literal function name (so it can infer arg
 * and return types); the console drives an arbitrary `Abi` + a `string` name at
 * runtime, so the precise inference can't apply. We isolate that single, honest
 * cast HERE (through a loose call signature, never `any`) rather than sprinkling
 * it across the component — the panel stays fully typed.
 *
 * These wrappers move NO money on their own: they submit exactly the function
 * and args the caller entered against the module's real ABI — the same thing a
 * block-explorer "Write Contract" tab does. The address always comes from the
 * broadcast deployments map (never a literal), and a write pins the wallet to the
 * intended chain before it submits.
 */
import type { Abi, Address, Hash, PublicClient, WalletClient } from 'viem'

/** A loose call surface for the two viem methods we drive dynamically. */
type LooseCall<R> = (args: unknown) => Promise<R>

/**
 * Call a `view` / `pure` function and return its raw decoded result. No wallet,
 * no gas — a pure chain read against `address` on the client's chain.
 */
export function readModule(
  client: PublicClient,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): Promise<unknown> {
  const read = client.readContract as unknown as LooseCall<unknown>
  return read({ address, abi, functionName, args })
}

/**
 * Submit a state-changing function and wait for its receipt, returning the tx
 * hash. `value` is forwarded only when the function is `payable` (the caller
 * gates it on `stateMutability`). Throws if the wallet has no account — the panel
 * surfaces that as "connect a wallet".
 */
export async function writeModule(
  wallet: WalletClient,
  publicClient: PublicClient,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  value?: bigint,
): Promise<Hash> {
  const account = wallet.account
  if (!account) throw new Error('Connect a wallet to submit this transaction.')
  const write = wallet.writeContract as unknown as LooseCall<Hash>
  const hash = await write({
    account,
    chain: wallet.chain,
    address,
    abi,
    functionName,
    args,
    // Only carry `value` when set — an undefined value is omitted by viem.
    ...(value !== undefined ? { value } : {}),
  })
  await publicClient.waitForTransactionReceipt({ hash })
  return hash
}
