/**
 * payment.test.ts — Matchstick unit tests for the PaymentReceived mapping.
 *
 * These run fully offline (no chain, no Graph node): Matchstick feeds synthetic
 * `PaymentReceived` events through `handlePaymentReceived` and asserts the store
 * matches what a dashboard would query. We prove the two things the analytics
 * layer must get right:
 *   1. Aggregate roll-up — each event bumps the right Merchant running totals,
 *      and merchants stay isolated from one another.
 *   2. Decimals — amounts are carried as exact integers (token base units; USD at
 *      8 decimals, matching the Chainlink feed), never coerced or rounded.
 *
 * Run with: `graph test` (Matchstick).
 */
import {
  Address,
  BigInt,
  Bytes,
  ethereum,
} from "@graphprotocol/graph-ts";
import {
  afterEach,
  assert,
  clearStore,
  describe,
  newMockEvent,
  test,
} from "matchstick-as/assembly/index";

import { PaymentReceived } from "../generated/Access0x1Router/Access0x1Router";
import { handlePaymentReceived } from "../src/mapping";

// ---------------------------------------------------------------------------
// Fixtures — realistic, decimal-correct values for a settled payment.
// ---------------------------------------------------------------------------

// USDC is a 6-decimal token: 100 USDC == 100_000000 base units.
const GROSS_1 = BigInt.fromString("100000000"); // 100.000000 USDC gross
const FEE_1 = BigInt.fromString("250000"); //       0.250000 USDC fee (25 bps)
const NET_1 = BigInt.fromString("99750000"); //    99.750000 USDC net
// Chainlink USD feeds report 8 decimals: $100.00000000.
const USD8_1 = BigInt.fromString("10000000000"); // $100, 8-decimal

const GROSS_2 = BigInt.fromString("50000000"); //  50.000000 USDC gross
const FEE_2 = BigInt.fromString("125000"); //       0.125000 USDC fee
const NET_2 = BigInt.fromString("49875000"); //    49.875000 USDC net
const USD8_2 = BigInt.fromString("5000000000"); //  $50, 8-decimal

const BUYER = Address.fromString(
  "0x1111111111111111111111111111111111111111",
);
const TOKEN_USDC = Address.fromString(
  "0x2222222222222222222222222222222222222222",
);
const ORDER_ID = Bytes.fromHexString(
  "0xabcdef00000000000000000000000000000000000000000000000000000000ff",
);
const SRC_SELECTOR_SAME_CHAIN = BigInt.zero(); // 0 == same-chain payment

/**
 * Build a mock `PaymentReceived` event. Parameters are pushed in the exact ABI
 * order the generated bindings index by position:
 *   [merchantId, buyer, token, grossAmount, feeAmount, netAmount,
 *    usdAmount8, orderId, srcChainSelector]
 */
function newPaymentReceived(
  merchantId: BigInt,
  buyer: Address,
  token: Address,
  grossAmount: BigInt,
  feeAmount: BigInt,
  netAmount: BigInt,
  usdAmount8: BigInt,
  orderId: Bytes,
  srcChainSelector: BigInt,
  logIndex: BigInt,
): PaymentReceived {
  const event = changetype<PaymentReceived>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  event.logIndex = logIndex; // distinct log index => distinct immutable Payment id

  event.parameters.push(
    new ethereum.EventParam(
      "merchantId",
      ethereum.Value.fromUnsignedBigInt(merchantId),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam("buyer", ethereum.Value.fromAddress(buyer)),
  );
  event.parameters.push(
    new ethereum.EventParam("token", ethereum.Value.fromAddress(token)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "grossAmount",
      ethereum.Value.fromUnsignedBigInt(grossAmount),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "feeAmount",
      ethereum.Value.fromUnsignedBigInt(feeAmount),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "netAmount",
      ethereum.Value.fromUnsignedBigInt(netAmount),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "usdAmount8",
      ethereum.Value.fromUnsignedBigInt(usdAmount8),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "orderId",
      ethereum.Value.fromFixedBytes(orderId),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "srcChainSelector",
      ethereum.Value.fromUnsignedBigInt(srcChainSelector),
    ),
  );

  return event;
}

/** Merchant entity id == merchantId as a UTF-8 string (per the schema comment). */
function merchantEntityId(merchantId: BigInt): string {
  return Bytes.fromUTF8(merchantId.toString()).toHexString();
}

// The per-(merchant, token) row id — "<merchantId>-" UTF-8 bytes, then the token
// bytes concatenated, matching loadOrCreateMerchantToken in the mapping. The
// native-unit totals (gross/fees/net) live HERE, never on Merchant.
function merchantTokenEntityId(merchantId: BigInt, token: Address): string {
  return Bytes.fromUTF8(merchantId.toString() + "-").concat(token).toHexString();
}

/** Payment entity id == txHash.concatI32(logIndex), as the handler keys it. */
function paymentEntityId(
  event: PaymentReceived,
): string {
  return event.transaction.hash.concatI32(event.logIndex.toI32()).toHexString();
}

describe("handlePaymentReceived", () => {
  afterEach(() => {
    clearStore();
  });

  test("creates an immutable Payment row carrying exact, decimal-correct fields", () => {
    const merchantId = BigInt.fromI32(1);
    const event = newPaymentReceived(
      merchantId,
      BUYER,
      TOKEN_USDC,
      GROSS_1,
      FEE_1,
      NET_1,
      USD8_1,
      ORDER_ID,
      SRC_SELECTOR_SAME_CHAIN,
      BigInt.fromI32(0),
    );

    handlePaymentReceived(event);

    const id = paymentEntityId(event);
    assert.entityCount("Payment", 1);
    assert.fieldEquals("Payment", id, "merchantId", "1");
    assert.fieldEquals("Payment", id, "buyer", BUYER.toHexString());
    assert.fieldEquals("Payment", id, "token", TOKEN_USDC.toHexString());
    // Amounts are stored as exact base-unit / 8-decimal integers — no rounding.
    assert.fieldEquals("Payment", id, "grossAmount", GROSS_1.toString());
    assert.fieldEquals("Payment", id, "feeAmount", FEE_1.toString());
    assert.fieldEquals("Payment", id, "netAmount", NET_1.toString());
    assert.fieldEquals("Payment", id, "usdAmount8", USD8_1.toString());
    assert.fieldEquals("Payment", id, "orderId", ORDER_ID.toHexString());
    assert.fieldEquals("Payment", id, "srcChainSelector", "0");
    // The Payment links to its Merchant aggregate by the UTF-8 merchant id.
    assert.fieldEquals("Payment", id, "merchant", merchantEntityId(merchantId));
  });

  test("fee math holds in the stored row: netAmount + feeAmount == grossAmount", () => {
    const merchantId = BigInt.fromI32(7);
    const event = newPaymentReceived(
      merchantId,
      BUYER,
      TOKEN_USDC,
      GROSS_1,
      FEE_1,
      NET_1,
      USD8_1,
      ORDER_ID,
      SRC_SELECTOR_SAME_CHAIN,
      BigInt.fromI32(0),
    );

    handlePaymentReceived(event);

    // The router's invariant (net + fee == gross) must survive indexing exactly.
    assert.fieldEquals(
      "Payment",
      paymentEntityId(event),
      "grossAmount",
      NET_1.plus(FEE_1).toString(),
    );
  });

  test("rolls the Merchant aggregate up across two payments", () => {
    const merchantId = BigInt.fromI32(1);
    const mid = merchantEntityId(merchantId);

    const first = newPaymentReceived(
      merchantId,
      BUYER,
      TOKEN_USDC,
      GROSS_1,
      FEE_1,
      NET_1,
      USD8_1,
      ORDER_ID,
      SRC_SELECTOR_SAME_CHAIN,
      BigInt.fromI32(0),
    );
    handlePaymentReceived(first);

    const second = newPaymentReceived(
      merchantId,
      BUYER,
      TOKEN_USDC,
      GROSS_2,
      FEE_2,
      NET_2,
      USD8_2,
      ORDER_ID,
      SRC_SELECTOR_SAME_CHAIN,
      BigInt.fromI32(1),
    );
    handlePaymentReceived(second);

    // One Merchant aggregate, two immutable Payment rows.
    assert.entityCount("Merchant", 1);
    assert.entityCount("Payment", 2);

    // Running totals are the exact integer sums of both events.
    assert.fieldEquals("Merchant", mid, "merchantId", "1");
    assert.fieldEquals("Merchant", mid, "paymentCount", "2");
    // Cross-token-safe USD total lives on the Merchant aggregate.
    assert.fieldEquals(
      "Merchant",
      mid,
      "totalUsd8",
      USD8_1.plus(USD8_2).toString(),
    );
    // Native-unit totals live on the per-(merchant, token) row (both payments in USDC).
    const mtid = merchantTokenEntityId(merchantId, TOKEN_USDC);
    assert.fieldEquals(
      "MerchantToken",
      mtid,
      "totalGross",
      GROSS_1.plus(GROSS_2).toString(),
    );
    assert.fieldEquals(
      "MerchantToken",
      mtid,
      "totalFees",
      FEE_1.plus(FEE_2).toString(),
    );
    assert.fieldEquals(
      "MerchantToken",
      mtid,
      "totalNet",
      NET_1.plus(NET_2).toString(),
    );
    // lastPaymentAt tracks the most recent event's block timestamp.
    assert.fieldEquals(
      "Merchant",
      mid,
      "lastPaymentAt",
      second.block.timestamp.toString(),
    );
  });

  test("keeps merchants isolated — a second merchant has its own aggregate", () => {
    const merchantA = BigInt.fromI32(1);
    const merchantB = BigInt.fromI32(2);

    handlePaymentReceived(
      newPaymentReceived(
        merchantA,
        BUYER,
        TOKEN_USDC,
        GROSS_1,
        FEE_1,
        NET_1,
        USD8_1,
        ORDER_ID,
        SRC_SELECTOR_SAME_CHAIN,
        BigInt.fromI32(0),
      ),
    );
    handlePaymentReceived(
      newPaymentReceived(
        merchantB,
        BUYER,
        TOKEN_USDC,
        GROSS_2,
        FEE_2,
        NET_2,
        USD8_2,
        ORDER_ID,
        SRC_SELECTOR_SAME_CHAIN,
        BigInt.fromI32(1),
      ),
    );

    assert.entityCount("Merchant", 2);

    // Each merchant carries only its own single payment — no cross-contamination.
    const midA = merchantEntityId(merchantA);
    const midB = merchantEntityId(merchantB);

    assert.fieldEquals("Merchant", midA, "paymentCount", "1");
    assert.fieldEquals("Merchant", midA, "totalUsd8", USD8_1.toString());
    assert.fieldEquals(
      "MerchantToken",
      merchantTokenEntityId(merchantA, TOKEN_USDC),
      "totalGross",
      GROSS_1.toString(),
    );

    assert.fieldEquals("Merchant", midB, "paymentCount", "1");
    assert.fieldEquals("Merchant", midB, "totalUsd8", USD8_2.toString());
    assert.fieldEquals(
      "MerchantToken",
      merchantTokenEntityId(merchantB, TOKEN_USDC),
      "totalGross",
      GROSS_2.toString(),
    );
  });

  test("preserves a cross-chain (CCIP) source selector instead of zeroing it", () => {
    const merchantId = BigInt.fromI32(42);
    // A non-zero selector marks a CCIP cross-chain settlement (uint64 range).
    const ccipSelector = BigInt.fromString("10344971235874465080"); // Base Sepolia
    const event = newPaymentReceived(
      merchantId,
      BUYER,
      TOKEN_USDC,
      GROSS_1,
      FEE_1,
      NET_1,
      USD8_1,
      ORDER_ID,
      ccipSelector,
      BigInt.fromI32(0),
    );

    handlePaymentReceived(event);

    assert.fieldEquals(
      "Payment",
      paymentEntityId(event),
      "srcChainSelector",
      ccipSelector.toString(),
    );
  });
});
