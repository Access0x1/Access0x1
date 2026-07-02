/**
 * mapping.ts — turn each Access0x1Router `PaymentReceived` event into a Payment row
 * and roll the per-merchant aggregate the dashboard reads. Read-only / off the money
 * path: indexing failures never touch settlement.
 */
import { BigInt, Bytes } from "@graphprotocol/graph-ts";

import { PaymentReceived } from "../generated/Access0x1Router/Access0x1Router";
import { Merchant, MerchantToken, Payment } from "../generated/schema";

export function handlePaymentReceived(event: PaymentReceived): void {
  // Roll the merchant aggregate first (load-or-create), so the Payment can reference it.
  // Only usdAmount8 is summed here — it is the one cross-token-safe unit. The native
  // token-unit totals (gross/fees/net) roll into a per-(merchant, token) row below,
  // because e.g. 6-decimal USDC and 18-decimal native base units cannot be added.
  const merchant = loadOrCreateMerchant(event.params.merchantId);
  merchant.paymentCount = merchant.paymentCount.plus(BigInt.fromI32(1));
  merchant.totalUsd8 = merchant.totalUsd8.plus(event.params.usdAmount8);
  merchant.lastPaymentAt = event.block.timestamp;
  merchant.save();

  // Per-(merchant, token) native-unit totals — safe to sum because the token is fixed.
  const mt = loadOrCreateMerchantToken(merchant.id, event.params.merchantId, event.params.token);
  mt.paymentCount = mt.paymentCount.plus(BigInt.fromI32(1));
  mt.totalGross = mt.totalGross.plus(event.params.grossAmount);
  mt.totalFees = mt.totalFees.plus(event.params.feeAmount);
  mt.totalNet = mt.totalNet.plus(event.params.netAmount);
  mt.lastPaymentAt = event.block.timestamp;
  mt.save();

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
    merchant.totalUsd8 = BigInt.zero();
    merchant.lastPaymentAt = BigInt.zero();
  }
  return merchant;
}

/**
 * Load the per-(merchant, token) native-unit aggregate, or create a zeroed one.
 * Keyed by "<merchantId>-<tokenHex>" so each token's base-unit totals stay separate
 * (never summed across tokens with different decimals).
 */
function loadOrCreateMerchantToken(
  merchantEntityId: Bytes,
  merchantId: BigInt,
  token: Bytes,
): MerchantToken {
  const id = Bytes.fromUTF8(merchantId.toString() + "-").concat(token);
  let mt = MerchantToken.load(id);
  if (mt == null) {
    mt = new MerchantToken(id);
    mt.merchant = merchantEntityId;
    mt.merchantId = merchantId;
    mt.token = token;
    mt.paymentCount = BigInt.zero();
    mt.totalGross = BigInt.zero();
    mt.totalFees = BigInt.zero();
    mt.totalNet = BigInt.zero();
    mt.lastPaymentAt = BigInt.zero();
  }
  return mt;
}
