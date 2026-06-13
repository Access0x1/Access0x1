# ERC-7715 / ERC-7710 interop seam

This directory makes Access0x1 **speak ERC-7715** — the emerging wallet spend-permissions standard —
on top of the **existing** on-chain `SessionGrant` contract, at near-zero cost and **off-chain only**.
It is the twin of `lib/ap2/` (the AP2/A2A seam): a pure, additive view layer, never a source of truth.

The enforcing core is unchanged: `SessionGrant` (`src/SessionGrant.sol`) — the budget-capped,
time-bounded, owner-revocable ERC-7702/6492/1271 mandate — is canonical. This seam re-labels its
grant / spend / revoke in the nouns of ERC-7715 (grant) and ERC-7710 (redeem), so a 7715-aware wallet
and a 7710-aware delegate can talk to Access0x1 with no bespoke code.

## The mapping (what we actually implemented)

| ERC-7715 / ERC-7710 concept | Access0x1 SessionGrant equivalent | Where |
|---|---|---|
| `wallet_requestExecutionPermissions` — a user grants an agent a scoped, expiring, budget-capped spend permission | `openSessionFor(owner, delegate, budgetCap, expiry, signature)` | `grantToSessionParams()` |
| the 7715 `signer` (the session/delegate account) | `delegate` | `grantToSessionParams()` |
| the 7715 allowance (`allowance` / `amount` / `periodAmount`) | `budgetCap` (uint256, decimal string) | `extractAllowance()` |
| the 7715 `expiry` rule (unix seconds) | `expiry` | `grantToSessionParams()` |
| the granting `account` (signs the grant) | `owner` (SessionGrant accepts ECDSA / 1271 / 6492) | `grantToSessionParams()` |
| the opaque 7715 `context` returned to the app | `abi.encode(address sessionGrant, bytes32 sessionId)` | `encodeContext()` / `decodeContext()` |
| `redeemDelegations(permissionContexts, modes, executionCallDatas)` | `spend(sessionId, amount)` | `buildRedemptionDescriptor()` |
| owner revocation | `revoke(sessionId)` | (on-chain; surfaced as `revocable`) |

The opaque `context` is the load-bearing piece: it is the minimal `(SessionGrant address, sessionId)`
pointer a 7710 redemption needs to know **which** SessionGrant and **which** session to spend against.
A wallet stores it opaque; a delegate replays it as the 7710 `permissionContext`.

### A note on `token` (honest)

`SessionGrant` is a pure **authorization ledger** — it stores `budgetCap + expiry + delegate + nonce`,
**not** the token (denomination/custody lives on the consuming router, by money-safety invariant). So an ERC-20
permission's `token` is carried through this adapter as **interop metadata** on the params/descriptor,
**not** as a SessionGrant constructor arg. We never pretend SessionGrant enforces the asset.

## Scope — what is REAL here vs DEFERRED (law #4, truth in copy)

**Real today (pure, deterministic, unit-tested):**
- `grantToSessionParams()` — maps a 7715 permission request onto `openSessionFor` params, validating
  the permission type, addresses, expiry, allowance, and (for erc20-*) the token.
- `encodeContext()` / `decodeContext()` — the opaque `abi.encode(address, bytes32)` context codec
  (round-trips exactly; uses the same `viem` ABI codec the rest of the app uses).
- `buildRedemptionDescriptor()` — the ERC-7710 `redeemDelegations`-shaped descriptor pointed at
  `SessionGrant.spend`.

**Deferred to post-event (touches the money path / needs audit — NOT built here):**
- The on-chain **ERC-7710 `redeemDelegations` router facade** that would *consume* the descriptor and
  call `SessionGrant.spend` then transfer value. This is a contract change on the money path; per
  `build-specs/emerging-erc.adr.md` it is roadmap, not a 24h build.
- The **Coinbase `SpendPermissionManager` ↔ SessionGrant bridge** (the "neutral across both wallet
  forks" play) — needs Coinbase's non-standard ABI + testing.

**The honest claim this unlocks:** Access0x1 *speaks ERC-7715/7710 in the interop / SDK layer.* It does
**not** change the on-chain money path. A SessionGrant is the truth; this seam is its 7715 wire form.

## API

```ts
import {
  grantToSessionParams,        // 7715 request  → openSessionFor params
  encodeContext, decodeContext, // (sessionGrant, sessionId) ⇄ opaque 7715 context
  buildRedemptionDescriptor,    // context + amount → 7710 redeemDelegations descriptor (→ spend)
} from "@/lib/erc7715/permissions";
```

All functions are pure: no env, no network, no clock, no randomness — every output is a deterministic
function of its inputs, so the unit type-checks and is testable before any live address is pinned.
