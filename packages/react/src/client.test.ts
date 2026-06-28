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

describe('isChainNotAddedError detection (via ensureWalletOnTargetChain)', () => {
  // isChainNotAddedError is internal; assert its branches through the observable
  // add-then-switch (4902) vs propagate (anything else) behavior.
  const walletThatRejectsSwitchWith = (rejection: unknown) => {
    const addChain = vi.fn(() => Promise.resolve());
    const switchChain = vi
      .fn()
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce(undefined);
    const wallet: MinimalWalletClient = {
      account: { address: '0xabc' as Hex },
      chain: { id: 84532 },
      getChainId: () => Promise.resolve(1),
      switchChain,
      addChain,
      writeContract: () => Promise.resolve('0xhash' as Hex),
    };
    return { wallet, addChain, switchChain };
  };

  it('treats a top-level code 4902 as chain-not-added (adds then retries)', async () => {
    const { wallet, addChain, switchChain } = walletThatRejectsSwitchWith({ code: 4902 });
    await clientFromViem(pub, wallet).writeContract(writeArgs);
    expect(addChain).toHaveBeenCalledTimes(1);
    expect(switchChain).toHaveBeenCalledTimes(2);
  });

  it('treats a nested cause.code 4902 as chain-not-added (adds then retries)', async () => {
    const { wallet, addChain, switchChain } = walletThatRejectsSwitchWith({
      message: 'switch rejected',
      cause: { code: 4902 },
    });
    await clientFromViem(pub, wallet).writeContract(writeArgs);
    expect(addChain).toHaveBeenCalledTimes(1);
    expect(switchChain).toHaveBeenCalledTimes(2);
  });

  it('does NOT treat other error codes (e.g. 4001 user-rejected) as chain-not-added', async () => {
    const { wallet, addChain } = walletThatRejectsSwitchWith({ code: 4001 });
    await expect(clientFromViem(pub, wallet).writeContract(writeArgs)).rejects.toMatchObject({
      code: 4001,
    });
    expect(addChain).not.toHaveBeenCalled();
  });

  it('does NOT treat a code-less error as chain-not-added (propagates)', async () => {
    const { wallet, addChain } = walletThatRejectsSwitchWith(new Error('network down'));
    await expect(clientFromViem(pub, wallet).writeContract(writeArgs)).rejects.toThrow(
      'network down',
    );
    expect(addChain).not.toHaveBeenCalled();
  });
});

describe('ensureWalletOnTargetChain — error handling (via writeContract)', () => {
  it('skips the switch (no throw) when getChainId() throws', async () => {
    const switchChain = vi.fn(() => Promise.resolve());
    const writeContract = vi.fn(() => Promise.resolve('0xhash' as Hex));
    const wallet: MinimalWalletClient = {
      account: { address: '0xabc' as Hex },
      chain: { id: 84532 },
      getChainId: () => Promise.reject(new Error('rpc unavailable')),
      switchChain,
      writeContract,
    };
    // getChainId throwing means "can't tell" — we leave it to viem's own guard, no prompt.
    await clientFromViem(pub, wallet).writeContract(writeArgs);
    expect(switchChain).not.toHaveBeenCalled();
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-4902 switchChain rejection (no addChain fallback)', async () => {
    const addChain = vi.fn(() => Promise.resolve());
    const switchChain = vi.fn(() => Promise.reject({ code: 4001 }));
    const writeContract = vi.fn(() => Promise.resolve('0xhash' as Hex));
    const wallet: MinimalWalletClient = {
      account: { address: '0xabc' as Hex },
      chain: { id: 84532 },
      getChainId: () => Promise.resolve(1),
      switchChain,
      addChain,
      writeContract,
    };
    await expect(clientFromViem(pub, wallet).writeContract(writeArgs)).rejects.toMatchObject({
      code: 4001,
    });
    expect(addChain).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('propagates when addChain() itself throws after a 4902 switch (not caught)', async () => {
    const addChain = vi.fn(() => Promise.reject(new Error('addChain failed')));
    const switchChain = vi.fn(() => Promise.reject({ code: 4902 }));
    const writeContract = vi.fn(() => Promise.resolve('0xhash' as Hex));
    const wallet: MinimalWalletClient = {
      account: { address: '0xabc' as Hex },
      chain: { id: 84532 },
      getChainId: () => Promise.resolve(1),
      switchChain,
      addChain,
      writeContract,
    };
    await expect(clientFromViem(pub, wallet).writeContract(writeArgs)).rejects.toThrow(
      'addChain failed',
    );
    expect(addChain).toHaveBeenCalledTimes(1);
    expect(writeContract).not.toHaveBeenCalled();
  });
});

describe('clientFromViem — account extraction', () => {
  it('uses walletClient.account when it is a 0x string directly', async () => {
    const writeContract = vi.fn(() => Promise.resolve('0xhash' as Hex));
    const wallet: MinimalWalletClient = {
      account: '0xdeadbeef' as Hex,
      writeContract,
    };
    const client = clientFromViem(pub, wallet);
    expect(client.account).toBe('0xdeadbeef');
    await client.writeContract(writeArgs);
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ account: '0xdeadbeef' }),
    );
  });

  it('extracts .address when walletClient.account is an object', async () => {
    const writeContract = vi.fn(() => Promise.resolve('0xhash' as Hex));
    const wallet: MinimalWalletClient = {
      account: { address: '0xfeed' as Hex },
      writeContract,
    };
    const client = clientFromViem(pub, wallet);
    expect(client.account).toBe('0xfeed');
    await client.writeContract(writeArgs);
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ account: '0xfeed' }));
  });

  it('leaves account undefined when the wallet client has none', () => {
    const wallet: MinimalWalletClient = {
      writeContract: () => Promise.resolve('0xhash' as Hex),
    };
    expect(clientFromViem(pub, wallet).account).toBeUndefined();
  });
});

describe('clientFromViem — read-only client (no wallet)', () => {
  it('creates a read-only client with an undefined account', () => {
    const client = clientFromViem(pub, undefined);
    expect(client.account).toBeUndefined();
  });

  it('still reads through the public client', async () => {
    const readContract = vi.fn(() => Promise.resolve(42n));
    const client = clientFromViem({ ...pub, readContract }, undefined);
    await expect(
      client.readContract({ address: '0x0' as Hex, abi: [], functionName: 'balance' }),
    ).resolves.toBe(42n);
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  it('throws "no wallet client connected" when writeContract is called read-only', async () => {
    const client = clientFromViem(pub, undefined);
    await expect(client.writeContract(writeArgs)).rejects.toThrow(/no wallet client connected/);
  });
});

describe('clientFromViem — chain-sync retry & error propagation', () => {
  it('retries switchChain after adding the chain (add, then switch again)', async () => {
    const addChain = vi.fn(() => Promise.resolve());
    const switchChain = vi
      .fn()
      .mockRejectedValueOnce({ code: 4902 })
      .mockResolvedValueOnce(undefined);
    const writeContract = vi.fn(() => Promise.resolve('0xhash' as Hex));
    const wallet: MinimalWalletClient = {
      account: { address: '0xabc' as Hex },
      chain: { id: 84532 },
      getChainId: () => Promise.resolve(1),
      switchChain,
      addChain,
      writeContract,
    };
    await clientFromViem(pub, wallet).writeContract(writeArgs);
    expect(switchChain).toHaveBeenNthCalledWith(1, { id: 84532 });
    expect(addChain).toHaveBeenCalledWith({ chain: { id: 84532 } });
    expect(switchChain).toHaveBeenNthCalledWith(2, { id: 84532 });
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back to addChain when the wallet cannot add chains (propagates 4902)', async () => {
    const switchChain = vi.fn(() => Promise.reject({ code: 4902 }));
    const writeContract = vi.fn(() => Promise.resolve('0xhash' as Hex));
    const wallet: MinimalWalletClient = {
      account: { address: '0xabc' as Hex },
      chain: { id: 84532 },
      getChainId: () => Promise.resolve(1),
      switchChain,
      // no addChain
      writeContract,
    };
    await expect(clientFromViem(pub, wallet).writeContract(writeArgs)).rejects.toMatchObject({
      code: 4902,
    });
    expect(writeContract).not.toHaveBeenCalled();
  });
});
