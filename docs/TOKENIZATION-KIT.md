# Tokenization kit

The tokenization kit is the set of **vanilla, cloneable** asset/attestation contracts that ship with
Access0x1 so a cloner can tokenize things out of the box. Every contract here follows the same
reusable-base rules as the rest of the estate: **no hardcoded addresses**, the admin/authority set is a
**constructor param**, and nothing is privileged to the first-party deployment — clone it, set your own
admin, and run it your way.

> **Status — in-repo, testnet-only, NOT deployed.** These contracts are built and fully tested in this
> repository. They are **not** part of `script/DeployAll.s.sol`, carry **no** entry in the on-chain
> address tables, and are intended for **testnet** demonstration; any mainnet use is owner-gated and
> post-audit. Nothing in this doc claims an on-chain deployment.

## Contracts

| Contract | Standard(s) | What it is |
| --- | --- | --- |
| [`Access0x1RwaToken`](../src/Access0x1RwaToken.sol) | **ERC-7943 (uRWA)** on ERC-721 | A compliant real-world-asset NFT: per-tokenId freezing, authorized `forcedTransfer` (court order / lost-key recovery), and `canSend`/`canReceive` policy gates enforced on every mint and transfer. Ships a `WHITELIST_ROLE` allowlist as the reference compliance mechanism; a deployment with real KYC/KYB overrides the `can*` views and inherits enforcement unchanged. |
| [`CredentialSbt`](../src/CredentialSbt.sol) | **ERC-5192** (soulbound) on ERC-721, **EIP-712** vouchers, **ERC-1271 / ERC-6492** | A soulbound (non-transferable) verified-credential badge with **levels**. One contract serves many credential kinds via a caller-chosen `bytes32 credType`; each badge carries a `uint8 level`, an optional `expiresAt`, and a revoked flag. |

## `CredentialSbt` — the verified-credential badge

A soulbound ERC-721 that an **issuer** grants to a **subject** as an on-chain, level-bearing,
optionally-expiring attestation. It is the generic primitive behind a "verified-credential badge" — the
`credType` key makes it domain-agnostic, so one deployment can attest business-verification,
KYC-attestation, membership tiers, or anything else without a new contract.

### Model

- **One contract, many credential kinds.** A badge is issued under a `credType` (`bytes32`, e.g.
  `keccak256("business-verified")`). Exactly **one active badge per `(subject, credType)`** — a second
  issue for a live pair reverts `CredentialSbt__AlreadyIssued`; the slot frees on burn so a fresh badge
  can be issued later.
- **Levels.** Every badge carries a `uint8 level` (non-zero; `0` is the "no badge" sentinel). The issuer
  can **raise or lower** it via `setLevel`, emitting `LevelChanged`.
- **Soulbound (ERC-5192).** `locked(tokenId)` is always `true` for an existing badge, `Locked` is emitted
  at mint (never `Unlocked`), and ERC-165 advertises the ERC-5192 id `0xb45a3c0e`. Every transfer path
  (`transferFrom`, `safeTransferFrom`, approved-operator) hard-reverts `CredentialSbt__Soulbound`, and so
  do `approve` / `setApprovalForAll` — an approval can only ever enable a (forbidden) transfer.
- **Expiry.** An optional `expiresAt` (unix seconds; `0` = never). `isValid(tokenId)` and
  `hasValidCredential(subject, credType)` return true only while the badge exists, is not revoked, and is
  not past expiry. Expiry does **not** burn the token — it flips validity, and the badge can be re-leveled
  or revoked as usual.

### Issuance

Two paths, both mint the same soulbound badge:

1. **Direct** — `issue(subject, credType, level, expiresAt)`, callable by any holder of `ISSUER_ROLE`.
2. **Gasless voucher** — the issuer signs an **EIP-712** `Credential` struct offline; anyone (typically
   the subject, but any relayer) submits it via
   `claim(issuer, subject, credType, level, expiresAt, nonce, deadline, signature)`. The signature is
   validated against `issuer` accepting **EOA, ERC-1271** (deployed smart account), and **ERC-6492**
   (counterfactual / not-yet-deployed smart account) — the same predeploy-aware validator `SessionGrant`
   uses. The recovered signer must hold `ISSUER_ROLE`; the badge always lands on the **voucher's**
   `subject`, so a relayer cannot redirect it. Replay is guarded by a **per-issuer nonce** (a claimed
   `(issuer, nonce)` can never mint twice), and vouchers carry a `deadline`.

### Revocation

- **Issuer revoke** — `revoke(tokenId)` (holder of `ISSUER_ROLE`) burns the badge and frees the pair.
- **Subject renounce** — `renounce(tokenId)` lets the subject burn **their own** badge; a person can always
  renounce a credential, independent of the issuer.

Burn semantics follow ERC-5484: both the issuer and the subject may burn (a fixed policy for a credential
primitive, chosen over a per-token `BurnAuth` enum to keep the surface lean).

### Roles

Configured entirely by the constructor `admin_` (`DEFAULT_ADMIN_ROLE`); no address is baked in.

| Role | Grants |
| --- | --- |
| `DEFAULT_ADMIN_ROLE` | The `admin_` constructor param. Grants/revokes `ISSUER_ROLE`. |
| `ISSUER_ROLE` | `issue`, `setLevel`, `revoke`, and is the signer authority whose vouchers `claim` accepts. A deployment may grant it to many attestors (including ERC-1271 smart accounts). |

### Custody

**None.** `CredentialSbt` is a pure attestation registry — no value transfer, no `payable` function. The
only external interaction is signature validation on the `claim` path (the ERC-6492 factory `prepare`
call), which precedes every state change (checks-effects-interactions); the voucher nonce is marked used
before the mint, so a re-entrant claim on the same voucher reverts.

## Tests

- [`test/unit/CredentialSbt.t.sol`](../test/unit/CredentialSbt.t.sol) — the full lifecycle: direct
  issue, gasless claim (EOA / ERC-1271 / ERC-6492 issuers), level raise/lower, issuer revoke, subject
  renounce, expiry validity flip, the one-active-badge-per-pair invariant, every soulbound transfer +
  approval revert, ERC-5192 `locked`, ERC-165 id detection, signature negatives (wrong signer, tampered
  field, non-issuer signer, replayed nonce, expired deadline, malformed 6492 wrapper), and fuzz over
  issue / claim / soulbound-transfer.
- [`test/unit/Access0x1RwaToken.t.sol`](../test/unit/Access0x1RwaToken.t.sol) — the ERC-7943 surface and
  its `_update` enforcement.
