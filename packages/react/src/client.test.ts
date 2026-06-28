/**
 * @file Tests for {@link clientFromViem}'s proactive chain-sync.
 *
 * A buyer whose wallet is on the wrong network must get a one-tap switch prompt before the write,
 * not a viem ChainMismatchError dead-end. These assert the switch/add-then-switch behavior and that
 * an already-correct chain is left untouched.
 */

import { describe, it, expect, vi } from 'vitest';
import { clientFromViem, type MinimalPublicClient, type MinimalWalletClient } from './client.js';
import type { Hex } from './types.js';

const pub: MinimalPublicClient = {
  readContract: () => Promise.resolve(0n),
  waitForTransactionReceipt: () => Promise.resolve({ blockNumber: 1n }),
  watchContractEvent: () => () => {},
};

const writeArgs = { address: '0x0' as Hex, abi: [], functionName: 'payNative' };

describe('clientFromViem — proactive chain sync', () => {
  it('switches the wallet to the target chain before writing', async () => {
    const switchChain = vi.fn(() => Promise.resolve());
    const writeContract = vi.fn(() => Promise.resolve('0xhash' as Hex));
    const wallet: MinimalWalletClient = {
      account: { address: '0xabc' as Hex },
      chain: { id: 84532 },
      getChainId: () => Promise.resolve(1), // wallet currently on mainnet
      switchChain,
      writeContract,
    };
    await clientFromViem(pub, wallet).writeContract(writeArgs);
    expect(switchChain).toHaveBeenCalledWith({ id: 84532 });
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('does NOT switch when the wallet is already on the target chain', async () => {
    const switchChain = vi.fn(() => Promise.resolve());
    const wallet: MinimalWalletClient = {
      account: { address: '0xabc' as Hex },
      chain: { id: 84532 },
      getChainId: () => Promise.resolve(84532),
      switchChain,
      writeContract: () => Promise.resolve('0xhash' as Hex),
    };
    await clientFromViem(pub, wallet).writeContract(writeArgs);
    expect(switchChain).not.toHaveBeenCalled();
  });

  it('adds the chain then switches when the wallet does not know it (4902)', async () => {
    const addChain = vi.fn(() => Promise.resolve());
    const switchChain = vi
      .fn()
      .mockRejectedValueOnce({ code: 4902 })
      .mockResolvedValueOnce(undefined);
    const wallet: MinimalWalletClient = {
      account: { address: '0xabc' as Hex },
      chain: { id: 84532 },
      getChainId: () => Promise.resolve(1),
      switchChain,
      addChain,
      writeContract: () => Promise.resolve('0xhash' as Hex),
    };
    await clientFromViem(pub, wallet).writeContract(writeArgs);
    expect(addChain).toHaveBeenCalledTimes(1);
    expect(switchChain).toHaveBeenCalledTimes(2);
  });

  it('skips the switch (no throw) when the wallet exposes no chain-sync members', async () => {
    const writeContract = vi.fn(() => Promise.resolve('0xhash' as Hex));
    const wallet: MinimalWalletClient = {
      account: { address: '0xabc' as Hex },
      writeContract,
    };
    await clientFromViem(pub, wallet).writeContract(writeArgs);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });
});
