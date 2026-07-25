# Mainnet custody — the one-person multisig runbook

How a solo operator gets institutional-grade key custody before any mainnet
deploy. A multisig needs multiple **keys**, not multiple **people**: one person
holding three keys on three different media is a real 2-of-3 multisig.

This document is the checklist behind the Makefile's `MAINNET_CONFIRM=yes`
deploy confirmation. The deploy command itself is boring by design — custody is
the part that has to be true first. (An external audit is available and welcome
but not a required gate; the operator owns that decision — see
`audit/nfteria-auditor/`.)

---

## 1. The 2-of-3 Safe, one-person edition

Create a [Safe](https://safe.global) (deployed on Ethereum, Base, Arbitrum, OP
Mainnet, Polygon — every audit-gated target in the Makefile) with three signers
you control:

| Signer | What it is | Where it lives |
| --- | --- | --- |
| **1. Hardware wallet** | Ledger/Trezor — bought from the official store ONLY, never a marketplace | Your desk; its seed phrase → paper (§3) |
| **2. Daily wallet** | The MetaMask account you already use | Your phone — a *different device* than #1 |
| **3. Cold backup key** | A fresh key generated offline (`cast wallet new` with networking off) | **Paper only** — never funded, never used, never digital |

Threshold **2 of 3**. What this survives:

- **One key lost** (phone dies, paper burns, device breaks) → the other two
  still control the Safe; swap in a replacement third signer.
- **One key stolen** → the thief holds 1 of 3 and can do nothing; use the other
  two to eject the compromised signer.
- What it does **not** survive: losing two at once — which is why the three
  keys live on different media in different places.

## 2. What the Safe owns (and what it never touches)

- `ROUTER_OWNER=<safe-address>` at deploy time makes the Safe the
  **Ownable2Step admin of every owned contract** from the first block
  (`script/DeployAll.s.sol` reads it; defaults to the broadcaster otherwise).
- **Ownable2Step means two steps**: the Safe must also **accept** ownership as
  its own transaction. An un-accepted transfer leaves admin with the old owner
  — rehearse the accept (§4) so this is never discovered on mainnet day.
- The **deployer keystore** stays what it is today: a gas wallet. It deploys,
  it owns nothing, it holds nothing anyone would want.
- Your **funds account** (the wallet with your ENS + real assets) is signer #2
  of the Safe but is otherwise untouched by the product — no key of yours ever
  enters a file (see the wallet-roles rule in CONTRIBUTING.md: keystore
  deploys, env-key spends pennies, MetaMask stays in MetaMask).

## 3. The paper protocol

Write by hand, with a pen:

1. The **hardware wallet's seed phrase** (numbered words).
2. The **cold backup key** (the offline `cast wallet new` private key).
3. The **Safe address + signer map** (not secret — it's your recovery map).

Rules that matter:

- **Two copies, two physical locations.** One location is a single point of
  failure with extra steps.
- **Never** a photo, never typed into a connected computer, never in a
  password manager, cloud note, or chat with anyone — including an AI.
- **Verify by restoring** before relying on it: wipe the hardware wallet,
  restore from your paper, confirm the same address comes back. An unverified
  backup is a hope, not a backup.
- Steel plates are the upgrade for fire/flood; paper in two places already
  beats any hot keystore.

## 4. Rehearse on testnet first (doctrine: nothing debuts on mainnet)

1. Create a Safe on **Sepolia** with the same three signers.
2. Deploy (or pick an existing testnet deployment) with
   `ROUTER_OWNER=<sepolia-safe>`.
3. From the Safe UI, **accept ownership** (the Ownable2Step second step),
   signing with 2 of your 3 keys.
4. Execute one owner-gated router action through the Safe.
5. Simulate loss: pretend signer #2 is gone, execute with #1 + #3.

When all five steps are muscle memory, mainnet day is:

```bash
ROUTER_OWNER=<your-mainnet-safe> MAINNET_CONFIRM=yes make deploy-ethereum-mainnet
```

## 5. The full checklist, in order

1. Security review done: first-party review (the nfteria auditor + the
   operator's experience) complete, findings resolved. An external audit is
   **optional and welcome** — not a required gate — and `audit/` is the
   ready-to-hand package if one is sought (slither/aderyn dispositions, coverage
   ≥90% on money paths, invariants at the CI profile).
2. Safe created + rehearsed (§4), `ROUTER_OWNER` pointed at it.
3. Paper backups written, split, and restore-verified (§3).
4. Deployer funded with gas ETH only.
5. Mainnet env confirmed from official docs (USDC, feeds, treasury — law 3).
6. Then, and only then: `MAINNET_CONFIRM=yes` (a deliberate real-funds confirmation, no undo).
