# Recipes — the commerce contracts

The four commerce contracts turn the [money spine](./ARCHITECTURE.md) into real
merchant products. **They all compose the same `Access0x1Router` + `SessionGrant`
spine** — none re-derives fee math; every charge is USD-priced in-transaction,
settles through the router's pay path, and keeps the same `net + fee == gross`,
zero-custody guarantees. So once you understand
[GETTING-STARTED](./GETTING-STARTED.md), these are just four more entry points.

> **USD-8 fixed point.** Every `*Usd8` amount is a USD value with **8 decimals**:
> `$29.00` is `2_900_000_000`. (Same convention as the router's `quote`.)
> The function signatures below are copied verbatim from the source — click the
> line link for the full NatSpec (params, reverts, events).

---

## Subscriptions — recurring USD billing

[`src/Access0x1Subscriptions.sol`](../src/Access0x1Subscriptions.sol). Charges
recur against a [`SessionGrant`](../src/SessionGrant.sol) budget (the
never-negative meter), so renewals don't re-prompt the buyer's wallet.

**1. Merchant defines a plan** — price + period:

```solidity
function setPlan(
    uint256 merchantId, uint8 planKey,
    uint256 priceUsd8, uint32 periodSecs, bool active
) external;   // onlyMerchantOwner
```
→ [`setPlan`](../src/Access0x1Subscriptions.sol#L210)

**2. Buyer subscribes** (optionally with a SessionGrant `sessionId` for auto-renew
+ a trial):

```solidity
function subscribe(
    uint256 merchantId, uint8 planKey, address token,
    bytes32 sessionId, bool withTrial
) external returns (uint256 subId);
```
→ [`subscribe`](../src/Access0x1Subscriptions.sol#L228)

**3. Renew the cycle** (anyone / a keeper can call it when due):

```solidity
function renew(uint256 subId) external returns (uint256 chargedToken);
```
→ [`renew`](../src/Access0x1Subscriptions.sol#L357) · also `cancel(subId)` / `reactivate(subId)`

---

## Bookings — deposit escrow with a never-blockable refund

[`src/Access0x1Bookings.sol`](../src/Access0x1Bookings.sol). Holds a USD deposit
in escrow; the refund leg is unconditional (a stale oracle can never block a
refund).

**1. Buyer reserves a slot** (deposit now, balance due later):

```solidity
function reserve(
    uint256 merchantId, bytes32 slotKey, uint64 slotTimestamp, address token,
    uint256 depositUsd8, uint256 balanceDueUsd8,
    Policy calldata policy, uint64 holdSecs, bytes32 clientNonce
) external returns (uint256 id);
```
→ [`reserve`](../src/Access0x1Bookings.sol#L220)

**2. Resolve the booking:**

```solidity
function confirm(uint256 id) external;                 // pay the balance, lock it in
function cancel(uint256 id, ActorType actorType) external;  // policy-driven refund
function claimRefund(address token) external;          // pull a queued refund
```
→ [`confirm`](../src/Access0x1Bookings.sol#L297) · [`cancel`](../src/Access0x1Bookings.sol#L375) · [`claimRefund`](../src/Access0x1Bookings.sol#L466) (also `complete` / `markNoShow` / `expireHold`)

---

## Invoices — pay-once requests

[`src/Access0x1Invoices.sol`](../src/Access0x1Invoices.sol). A merchant bills a
specific payer a fixed USD amount; the payer settles once.

**1. Merchant creates the invoice:**

```solidity
function createInvoice(
    uint256 merchantId, address payer, address token,
    uint256 amountUsd8, uint64 dueBy, bytes32 memoHash
) external returns (uint256 id);   // onlyMerchantOwner
```
→ [`createInvoice`](../src/Access0x1Invoices.sol#L122)

**2. Payer pays** (token or native), with a client nonce for idempotency:

```solidity
function pay(uint256 id, bytes32 clientNonce) external;
function payNative(uint256 id, bytes32 clientNonce) external payable;
```
→ [`pay`](../src/Access0x1Invoices.sol#L165) · [`payNative`](../src/Access0x1Invoices.sol#L200) · `void(id)` to cancel

---

## Gift cards — prepaid USD balance

[`src/Access0x1GiftCards.sol`](../src/Access0x1GiftCards.sol). A prepaid,
hard-never-negative USD balance, plus coupons. Balances are ERC-6909-style
(per-card-id).

**1. Merchant issues a card** to a recipient for a face value:

```solidity
function issueCard(
    uint256 merchantId, bytes32 code, address recipient, uint256 faceUsd8
) external returns (uint256 id);   // onlyMerchantOwner
```
→ [`issueCard`](../src/Access0x1GiftCards.sol#L174)

**2. Holder redeems** against it (idempotent via `redemptionId`):

```solidity
function redeem(uint256 cardId_, uint256 amountUsd8, bytes32 redemptionId) external;
```
→ [`redeem`](../src/Access0x1GiftCards.sol#L197) · also `transfer`, `setCoupon` / `applyCoupon`

---

## Where to go next

- The spine these build on: [ARCHITECTURE.md](./ARCHITECTURE.md)
- Integrate a plain payment first: [GETTING-STARTED.md](./GETTING-STARTED.md)
- A term you don't recognize: [GLOSSARY.md](./GLOSSARY.md)
