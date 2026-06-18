#!/usr/bin/env bash
#
# verify-blockscout.sh — verify every contract from a DeployAll broadcast on a Blockscout explorer.
#
# Deploy-path-INDEPENDENT: reads the RECORDED broadcast (broadcast/DeployAll.s.sol/<chainId>/
# run-latest.json), needs NO keystore, sends NO transaction — source upload only. Constructor args are
# recovered via --guess-constructor-args. Idempotent + retry-friendly: already-verified ⇒ no-op; flaky
# testnet Blockscout (frequent 503 "no healthy upstream") just needs another pass — forge backs off via
# --retries/--delay and a throttle gap sits between contracts.
#
# Arg order matches verify-etherscan.sh: <chainId> <rpcUrl> <verifierUrl>. (An unset verifierUrl now
# surfaces a clear "missing verifier URL" instead of silently shifting the rpc.)
#
# Usage: script/verify-blockscout.sh <chainId> <rpcUrl> <verifierUrl>
#   e.g. script/verify-blockscout.sh 46630 "$ROBINHOOD_TESTNET_RPC_URL" https://explorer.testnet.chain.robinhood.com/api/
#
set -uo pipefail

CHAIN_ID="${1:?usage: verify-blockscout.sh <chainId> <rpcUrl> <verifierUrl>}"
RPC="${2:?missing rpc URL}"
VERIFIER_URL="${3:?missing verifier URL — set the chain VERIFIER_URL in .env, e.g. https://HOST/api/}"
BCAST="broadcast/DeployAll.s.sol/${CHAIN_ID}/run-latest.json"
THROTTLE="${VERIFY_THROTTLE:-2}"   # seconds between contracts — stay under explorer rate limits

[ -f "$BCAST" ] || {
  echo "No broadcast at $BCAST — deploy to chain ${CHAIN_ID} first (e.g. make deploy-robinhood-testnet)." >&2
  exit 1
}

fail=0
while read -r NAME ADDR; do
  [ -n "$NAME" ] && [ "$NAME" != "null" ] || { echo "skip (unnamed CREATE) $ADDR"; continue; }
  echo "==> verifying ${NAME} @ ${ADDR}"
  if forge verify-contract "$ADDR" "src/${NAME}.sol:${NAME}" \
      --verifier blockscout --verifier-url "$VERIFIER_URL" \
      --rpc-url "$RPC" --guess-constructor-args --watch --retries 15 --delay 6; then
    echo "    OK ${NAME}"
    [ -n "${VERIFY_RESULTS:-}" ] && printf 'PASS\t%s\t%s\n' "$CHAIN_ID" "$NAME" >> "$VERIFY_RESULTS"
  else
    echo "    FAILED ${NAME} — re-run when Blockscout is healthy (testnet 503s are common)"
    [ -n "${VERIFY_RESULTS:-}" ] && printf 'FAIL\t%s\t%s\n' "$CHAIN_ID" "$NAME" >> "$VERIFY_RESULTS"
    fail=1
  fi
  sleep "$THROTTLE"
done < <(jq -r '.transactions[] | select(.transactionType=="CREATE" and .contractName != null) | "\(.contractName) \(.contractAddress)"' "$BCAST")

exit $fail
