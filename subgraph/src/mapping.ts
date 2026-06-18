/**
 * mapping.ts — turn each Access0x1Router `PaymentReceived` event into a Payment row
 * and roll the per-merchant aggregate the dashboard reads. Read-only / off the money
 * path: indexing failures never touch settlement.
 */
import { BigInt, Bytes } from "@graphprotocol/graph-ts";

import { PaymentReceived } from "../generated/Access0x1Router/Access0x1Router";
import { Merchant, Payment } from "../generated/schema";

export function handlePaymentReceived(event: PaymentReceived): void {
  // Roll the merchant aggregate first (load-or-create), so the Payment can reference it.
  const merchant = loadOrCreateMerchant(event.params.merchantId);
  merchant.paymentCount = merchant.paymentCount.plus(BigInt.fromI32(1));
  merchant.totalGross = merchant.totalGross.plus(event.params.grossAmount);
  merchant.totalFees = merchant.totalFees.plus(event.params.feeAmount);
  merchant.totalNet = merchant.totalNet.plus(event.params.netAmount);
  merchant.totalUsd8 = merchant.totalUsd8.plus(event.params.usdAmount8);
  merchant.lastPaymentAt = event.block.timestamp;
  merchant.save();

  // One immutable Payment per event, keyed by tx hash + log index.
  const id = event.transaction.hash.concatI32(event.logIndex.toI32());
  const payment = new Payment(id);
  payment.merchant = merchant.id;
  payment.merchantId = event.params.merchantId;
  payment.buyer = event.params.buyer;
  payment.token = event.params.token;
  payment.grossAmount = event.params.grossAmount;
  payment.feeAmount = event.params.feeAmount;
  payment.netAmount = event.params.netAmount;
  payment.usdAmount8 = event.params.usdAmount8;
  payment.orderId = event.params.orderId;
  // srcChainSelector is uint64 → BigInt in the generated bindings.
  payment.srcChainSelector = event.params.srcChainSelector;
  payment.blockNumber = event.block.number;
  payment.blockTimestamp = event.block.timestamp;
  payment.transactionHash = event.transaction.hash;
  payment.save();
}

/** Load the Merchant aggregate for a router merchant id, or create a zeroed one. */
function loadOrCreateMerchant(merchantId: BigInt): Merchant {
  const id = Bytes.fromUTF8(merchantId.toString());
  let merchant = Merchant.load(id);
  if (merchant == null) {
    merchant = new Merchant(id);
    merchant.merchantId = merchantId;
    merchant.paymentCount = BigInt.zero();
    merchant.totalGross = BigInt.zero();
    merchant.totalFees = BigInt.zero();
    merchant.totalNet = BigInt.zero();
    merchant.totalUsd8 = BigInt.zero();
    merchant.lastPaymentAt = BigInt.zero();
  }
  return merchant;
}
