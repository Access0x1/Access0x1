/**
 * merchant.test.ts — Matchstick unit tests for the merchant-lifecycle mappings.
 *
 * These run fully offline: Matchstick feeds synthetic MerchantRegistered,
 * MerchantUpdated, and MerchantOwnerTransferred events through the handlers and
 * asserts the Merchant aggregate carries the right identity fields. The load-bearing
 * invariant (why MerchantOwnerTransferred exists at all): ownership moves ONLY via
 * the 2-step transfer — a MerchantUpdated must NEVER change `owner`.
 *
 * Run with: `graph test` (Matchstick).
 */
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  afterEach,
  assert,
  clearStore,
  describe,
  newMockEvent,
  test,
} from "matchstick-as/assembly/index";

import {
  MerchantOwnerTransferred,
  MerchantRegistered,
  MerchantUpdated,
} from "../generated/Access0x1Router/Access0x1Router";
import {
  handleMerchantOwnerTransferred,
  handleMerchantRegistered,
  handleMerchantUpdated,
} from "../src/mapping";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
const OWNER = Address.fromString("0x1111111111111111111111111111111111111111");
const NEW_OWNER = Address.fromString("0x2222222222222222222222222222222222222222");
const PAYOUT = Address.fromString("0x3333333333333333333333333333333333333333");
const FEE_RECIPIENT = Address.fromString("0x4444444444444444444444444444444444444444");
const NAME_HASH = Bytes.fromHexString(
  "0xabababababababababababababababababababababababababababababababab01",
);

/** Merchant entity id == merchantId as a UTF-8 string (per the schema comment). */
function merchantEntityId(merchantId: BigInt): string {
  return Bytes.fromUTF8(merchantId.toString()).toHexString();
}

function newMerchantRegistered(
  id: BigInt,
  owner: Address,
  payout: Address,
  feeRecipient: Address,
  feeBps: i32,
  nameHash: Bytes,
): MerchantRegistered {
  const event = changetype<MerchantRegistered>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(
    new ethereum.EventParam("id", ethereum.Value.fromUnsignedBigInt(id)),
  );
  event.parameters.push(
    new ethereum.EventParam("owner", ethereum.Value.fromAddress(owner)),
  );
  event.parameters.push(
    new ethereum.EventParam("payout", ethereum.Value.fromAddress(payout)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "feeRecipient",
      ethereum.Value.fromAddress(feeRecipient),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam("feeBps", ethereum.Value.fromI32(feeBps)),
  );
  event.parameters.push(
    new ethereum.EventParam("nameHash", ethereum.Value.fromFixedBytes(nameHash)),
  );
  return event;
}

function newMerchantUpdated(
  id: BigInt,
  payout: Address,
  feeRecipient: Address,
  feeBps: i32,
  active: boolean,
): MerchantUpdated {
  const event = changetype<MerchantUpdated>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(
    new ethereum.EventParam("id", ethereum.Value.fromUnsignedBigInt(id)),
  );
  event.parameters.push(
    new ethereum.EventParam("payout", ethereum.Value.fromAddress(payout)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "feeRecipient",
      ethereum.Value.fromAddress(feeRecipient),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam("feeBps", ethereum.Value.fromI32(feeBps)),
  );
  event.parameters.push(
    new ethereum.EventParam("active", ethereum.Value.fromBoolean(active)),
  );
  return event;
}

function newMerchantOwnerTransferred(
  id: BigInt,
  previousOwner: Address,
  newOwner: Address,
): MerchantOwnerTransferred {
  const event = changetype<MerchantOwnerTransferred>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(
    new ethereum.EventParam("id", ethereum.Value.fromUnsignedBigInt(id)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "previousOwner",
      ethereum.Value.fromAddress(previousOwner),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam("newOwner", ethereum.Value.fromAddress(newOwner)),
  );
  return event;
}

// ---------------------------------------------------------------------------
describe("merchant lifecycle", () => {
  afterEach(() => {
    clearStore();
  });

  test("MerchantRegistered seeds the identity + fee config on the aggregate", () => {
    const merchantId = BigInt.fromI32(7);
    handleMerchantRegistered(
      newMerchantRegistered(merchantId, OWNER, PAYOUT, FEE_RECIPIENT, 250, NAME_HASH),
    );

    const mid = merchantEntityId(merchantId);
    assert.entityCount("Merchant", 1);
    assert.fieldEquals("Merchant", mid, "merchantId", "7");
    assert.fieldEquals("Merchant", mid, "owner", OWNER.toHexString());
    assert.fieldEquals("Merchant", mid, "payout", PAYOUT.toHexString());
    assert.fieldEquals("Merchant", mid, "feeRecipient", FEE_RECIPIENT.toHexString());
    assert.fieldEquals("Merchant", mid, "feeBps", "250");
    assert.fieldEquals("Merchant", mid, "active", "true");
    assert.fieldEquals("Merchant", mid, "nameHash", NAME_HASH.toHexString());
    // A freshly registered merchant has no payments yet.
    assert.fieldEquals("Merchant", mid, "paymentCount", "0");
    assert.fieldEquals("Merchant", mid, "totalUsd8", "0");
  });

  test("MerchantUpdated refreshes the mutable config but NEVER touches owner", () => {
    const merchantId = BigInt.fromI32(7);
    handleMerchantRegistered(
      newMerchantRegistered(merchantId, OWNER, PAYOUT, FEE_RECIPIENT, 250, NAME_HASH),
    );
    // Update the fee config + deactivate — owner must be unchanged.
    handleMerchantUpdated(
      newMerchantUpdated(merchantId, FEE_RECIPIENT, PAYOUT, 100, false),
    );

    const mid = merchantEntityId(merchantId);
    assert.fieldEquals("Merchant", mid, "payout", FEE_RECIPIENT.toHexString());
    assert.fieldEquals("Merchant", mid, "feeRecipient", PAYOUT.toHexString());
    assert.fieldEquals("Merchant", mid, "feeBps", "100");
    assert.fieldEquals("Merchant", mid, "active", "false");
    // The invariant: an update does not move ownership.
    assert.fieldEquals("Merchant", mid, "owner", OWNER.toHexString());
  });

  test("MerchantOwnerTransferred is the ONLY path that moves ownership", () => {
    const merchantId = BigInt.fromI32(7);
    handleMerchantRegistered(
      newMerchantRegistered(merchantId, OWNER, PAYOUT, FEE_RECIPIENT, 250, NAME_HASH),
    );
    handleMerchantOwnerTransferred(
      newMerchantOwnerTransferred(merchantId, OWNER, NEW_OWNER),
    );

    const mid = merchantEntityId(merchantId);
    assert.fieldEquals("Merchant", mid, "owner", NEW_OWNER.toHexString());
    // Nothing else moved.
    assert.fieldEquals("Merchant", mid, "feeBps", "250");
    assert.fieldEquals("Merchant", mid, "active", "true");
  });
});
