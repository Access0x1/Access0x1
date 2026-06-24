# Clear signing — Access0x1Router (ERC-7730 + ERC-8213)

**What you see is what you sign.** Access0x1 is a payments router, so its users sign exactly the
transactions that [Clear Signing](https://clearsigning.org/) exists to make readable. Without a
descriptor a hardware-wallet customer paying for a booking signs blind hex; with the descriptor in this
folder their device shows **"Pay $29.00 to merchant #7 (order 0x1a2b…)"**.

Blind signing — approving calldata you can't actually read — is the root cause behind the Bybit (~$1.5B)
and Radiant (~$50M) drains. This folder is Access0x1's contribution to fixing it for its own surface.

## Files

| File | What it is |
| --- | --- |
| [`erc7730-access0x1-router.json`](erc7730-access0x1-router.json) | The [ERC-7730](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-7730.md) descriptor: maps every user/admin function of `Access0x1Router` to a human-readable intent + per-field format. One descriptor binds all eight CREATE3-mirror chains via `context.contract.deployments[]` (one address, `0xe92244e3…`, on every `✅ mirror` chain). |
| [`abi/Access0x1Router.abi.json`](abi/Access0x1Router.abi.json) | The flat implementation ABI the descriptor's `context.contract.abi` points at. Generated from the compiled artifact — **never hand-edit**: re-run `forge build` then `jq '.abi' out/Access0x1Router.sol/Access0x1Router.json` after any signature change. |

## The field formats that matter (why a generic decode is not enough)

A wrong descriptor can make a malicious tx look benign, so the formats are the load-bearing part:

- **`usdAmount8`** (`payNative`/`payToken`) is an **8-decimal USD price** (`USD_DECIMALS = 8`; `$1.00 = 1e8`),
  *not* a token or native amount. It renders via `unit` with `base:"$"`, `decimals:8`, `prefix:true` →
  `$29.00`. Rendering it as `tokenAmount`/`amount` would show a meaningless native-coin figure — the exact
  "less alarming hex" trap.
- **`token`** → `addressName` (resolve to the ERC-20 symbol). **addresses** (`payout`, `feeRecipient`,
  `feed`, `newOwner`, …) → `addressName`.
- **`feeBps`/`newBps`** → `unit` `base:"bps"` (basis points, denominator 10 000, capped at 10%) — never a
  bare integer.
- **`maxStaleness`** → `unit` `base:"s"` (seconds). **`orderId`/`nameHash`** → `raw` bytes32 (opaque, no
  preimage). **`merchantId`/`id`** → `raw` integer.

The overloaded `setPriceFeed(address,address)` and `setPriceFeed(address,address,uint256)` are
disambiguated by full signature (distinct selectors).

## ERC-8213 — the digest fallback (shipped in `@access0x1/react`)

For the cases ERC-7730 can't reach (a brand-new merchant deployment with no descriptor yet), the
[ERC-8213](https://erc8213.eth.limo/) calldata digest — `keccak256(uint256(len) ‖ calldata)` — lets a buyer
cross-verify on a second device that the bytes their wallet is about to sign match the bytes the checkout
built. The viem-native helper is **live in `@access0x1/react`**: `calldataDigest(calldata)` (the raw
ERC-8213 primitive) plus `paymentCalldataDigest({ merchantId, usdAmount8, orderId, token? })`, which digests
the exact `payNative`/`payToken` calldata `usePayment` sends — so the checkout shows the buyer the same
fingerprint their wallet will. `chainId` is intentionally excluded (the digest commits to the call, not the
network). Verified against Foundry's `cast keccak` (`packages/react/src/clearSigning.test.ts`). It does not
make the data human-readable (that's ERC-7730's job) — it makes it *verifiable*, the weaker but
always-applicable guarantee.

The same intent — *the buyer ends up with exactly the payment they signed* — is enforced on the watch
side too. `@access0x1/react`'s `usePayment` binds the `PaymentReceived` receipt it surfaces to **this
payment's `orderId`** (`orderId` is not an indexed event arg, so the hook matches it on the decoded log,
not just the indexed `{merchantId, buyer}`): a concurrent same-buyer/same-merchant payment for a
*different* order can no longer resolve the wrong receipt. The watch also **races a 120 s timeout** rather
than hanging forever, so a dropped/late log surfaces as a clean timeout instead of a spinner that never
resolves.

## Validate + submit (owner-gated)

```sh
# Lint against the ERC-7730 schema before any registry submission:
uvx erc7730 lint clear-signing/erc7730-access0x1-router.json   # or: pip install erc7730

# Bootstrap/refresh from the verified ABI (Arc is the source-verified chain):
clearsig generate --chain-id 5042002 --to 0xe92244e3368561faf21648146511dede3a475eb5
```

- **EF registry:** submit to [`ethereum/clear-signing-erc7730-registry`](https://github.com/ethereum/clear-signing-erc7730-registry)
  (registry filename prefix `calldata-`) so wallets pick it up.
- **ERC-8176 attestation:** an independent auditor (e.g. Cyfrin) attests the descriptor faithfully
  represents the contract, on the Ethereum Attestation Service. Wallets decide whose attestations they trust.

Both submission steps are **owner-gated** (they publish under the Access0x1 identity). The descriptor here
is verified in-repo: every one of its 20 function signatures + field paths is cross-checked against the
compiled `Access0x1Router` ABI, and the deployment addresses match `web/lib/deployments.ts`.

An integrator's thin subclass of `Access0x1Router` (e.g. `MyAppRouter`) reuses this same
descriptor (identical ABI) under its own mirror address.
