/**
 * Barrel for the Unlink private payout leg. Keeps consumer imports clean
 * (e.g. `feat/checkout-web` imports the route + result types from here).
 */
export { deriveMerchantUnlinkAccount, ARC_CHAIN_ID } from "./deriveMerchantAccount.js";
export { getMerchantClient, ensureRegistered } from "./payoutService.js";
export {
  shieldAndWithdraw,
  privateTransfer,
  WithdrawFailedError,
  ShieldFailedError,
  type WithdrawResult,
} from "./privateWithdraw.js";
export { usdToUsdcBaseUnits, toUsdcBigInt, USDC_DECIMALS } from "./amount.js";
export {
  payMerchantPrivately,
  DEFAULT_SHIELD_MULTIPLE,
  type PrivatePayOutcome,
  type PrivatePayDeps,
} from "./privatePay.js";
export {
  isPrivatePayFlagOn,
  isPrivatePayConfigured,
  privatePayStatus,
  type PrivatePayStatus,
} from "./privatePayConfig.js";
