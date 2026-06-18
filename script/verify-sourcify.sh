#!/usr/bin/env bash
#
# verify-sourcify.sh — additionally verify every contract from a DeployAll broadcast on Sourcify, the
# decentralized, KEYLESS verification registry (sourcify.dev). Complements the Etherscan/Blockscout/
# Routescan verifiers: many tools + wallets read Sourcify, and it is chain-agnostic + needs no API key,
# so it is the cheapest way to "verify to the fullest extent" everywhere we deploy.
#
# Deploy-path-INDEPENDENT: reads the RECORDED broadcast, no keystore, no transaction. Constructor args
# via --guess-constructor-args. Idempotent (already-verified ⇒ no-op). Sourcify supports a finite set
# of chains — an unsupported chain reports a clear error and is skipped (best-effort).
#
# Usage: script/verify-sourcify.sh <chainId> <rpcUrl>
#
set -uo pipefail

CHAIN_ID="${1:?usage: verify-sourcify.sh <chainId> <rpcUrl>}"
RPC="${2:?missing rpc URL}"
BCAST="broadcast/DeployAll.s.sol/${CHAIN_ID}/run-latest.json"
THROTTLE="${VERIFY_THROTTLE:-2}"

[ -f "$BCAST" ] || {
  echo "No broadcast at $BCAST — deploy to chain ${CHAIN_ID} first." >&2
  exit 1
}

fail=0
while read -r NAME ADDR; do
  [ -n "$NAME" ] && [ "$NAME" != "null" ] || { echo "skip (unnamed CREATE) $ADDR"; continue; }
  echo "==> verifying ${NAME} @ ${ADDR} (Sourcify)"
  if forge verify-contract "$ADDR" "src/${NAME}.sol:${NAME}" \
      --verifier sourcify --chain "$CHAIN_ID" \
      --rpc-url "$RPC" --guess-constructor-args --watch --retries 12 --delay 5; then
    echo "    OK ${NAME}"
    [ -n "${VERIFY_RESULTS:-}" ] && printf 'PASS\t%s\t%s\n' "$CHAIN_ID" "$NAME" >> "$VERIFY_RESULTS"
  else
    echo "    FAILED ${NAME} — Sourcify may not support chain ${CHAIN_ID}, or re-run later"
    [ -n "${VERIFY_RESULTS:-}" ] && printf 'FAIL\t%s\t%s\n' "$CHAIN_ID" "$NAME" >> "$VERIFY_RESULTS"
    fail=1
  fi
  sleep "$THROTTLE"
done < <(jq -r '.transactions[] | select(.transactionType=="CREATE" and .contractName != null) | "\(.contractName) \(.contractAddress)"' "$BCAST")

exit $fail
