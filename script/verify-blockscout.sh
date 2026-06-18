#!/usr/bin/env bash
#
# verify-blockscout.sh — verify every contract from a DeployAll broadcast on a Blockscout explorer.
#
# Deploy-path-INDEPENDENT: it reads the RECORDED broadcast (broadcast/DeployAll.s.sol/<chainId>/
# run-latest.json), needs NO keystore, and sends NO transaction — it only uploads source. That is
# exactly what you want when the deploy tx itself skipped forge's inline `--verify` (e.g. a private /
# direct-to-sequencer submission that bypasses the public mempool): verification is a separate,
# off-chain source upload and can run any time after the contracts are live.
#
# Idempotent + retry-friendly: re-run freely — an already-verified contract just reports "already
# verified", and flaky testnet Blockscout instances (frequent 503 "no healthy upstream") simply need
# another pass. Constructor args are recovered automatically via --guess-constructor-args (forge reads
# each contract's creation tx over --rpc-url), so no per-contract ABI encoding is needed.
#
# Usage: script/verify-blockscout.sh <chainId> <verifierUrl> <rpcUrl>
#   e.g. script/verify-blockscout.sh 46630 https://explorer.testnet.chain.robinhood.com/api/ "$ROBINHOOD_TESTNET_RPC_URL"
#
set -uo pipefail

CHAIN_ID="${1:?usage: verify-blockscout.sh <chainId> <verifierUrl> <rpcUrl>}"
VERIFIER_URL="${2:?missing verifier URL (e.g. https://explorer.testnet.chain.robinhood.com/api/)}"
RPC="${3:?missing rpc URL}"
BCAST="broadcast/DeployAll.s.sol/${CHAIN_ID}/run-latest.json"

[ -f "$BCAST" ] || {
  echo "No broadcast at $BCAST — deploy to chain ${CHAIN_ID} first (e.g. make deploy-robinhood-testnet)." >&2
  exit 1
}

fail=0
# One line per deployed contract: "<ContractName> <address>". Skip raw CREATEs with no contractName.
while read -r NAME ADDR; do
  [ -n "$NAME" ] && [ "$NAME" != "null" ] || { echo "skip (unnamed CREATE) $ADDR"; continue; }
  echo "==> verifying ${NAME} @ ${ADDR}"
  if forge verify-contract "$ADDR" "src/${NAME}.sol:${NAME}" \
      --verifier blockscout --verifier-url "$VERIFIER_URL" \
      --rpc-url "$RPC" --guess-constructor-args --watch; then
    echo "    OK ${NAME}"
  else
    echo "    FAILED ${NAME} — re-run this target when Blockscout is healthy (testnet 503s are common)"
    fail=1
  fi
done < <(jq -r '.transactions[] | select(.transactionType=="CREATE" and .contractName != null) | "\(.contractName) \(.contractAddress)"' "$BCAST")

exit $fail
