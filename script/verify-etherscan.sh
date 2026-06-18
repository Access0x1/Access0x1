#!/usr/bin/env bash
#
# verify-etherscan.sh — verify every contract from a DeployAll broadcast on an Etherscan-family
# explorer (Etherscan V2 multichain: ONE ETHERSCAN_API_KEY covers Sepolia / Base / Optimism /
# Arbitrum / Polygon / … keyed by --chain). Sibling of verify-blockscout.sh for the OTHER verifier
# family.
#
# Deploy-path-INDEPENDENT: reads the RECORDED broadcast (broadcast/DeployAll.s.sol/<chainId>/
# run-latest.json), needs NO keystore, sends NO transaction — source upload only. Constructor args are
# recovered via --guess-constructor-args (forge reads each creation tx over --rpc-url). Idempotent:
# already-verified ⇒ no-op; re-run freely.
#
# The API key is read from the ENV (not a positional arg) so it never lands in argv/logs — the Makefile
# target passes it via an env assignment with `@` (echo suppressed).
#
# Usage: ETHERSCAN_API_KEY=... script/verify-etherscan.sh <chainId> <rpcUrl>
#
set -uo pipefail

CHAIN_ID="${1:?usage: verify-etherscan.sh <chainId> <rpcUrl>}"
RPC="${2:?missing rpc URL}"
: "${ETHERSCAN_API_KEY:?set ETHERSCAN_API_KEY in .env (Etherscan V2 key covers every Etherscan-family chain)}"
BCAST="broadcast/DeployAll.s.sol/${CHAIN_ID}/run-latest.json"

[ -f "$BCAST" ] || {
  echo "No broadcast at $BCAST — deploy to chain ${CHAIN_ID} first." >&2
  exit 1
}

fail=0
while read -r NAME ADDR; do
  [ -n "$NAME" ] && [ "$NAME" != "null" ] || { echo "skip (unnamed CREATE) $ADDR"; continue; }
  echo "==> verifying ${NAME} @ ${ADDR}"
  if forge verify-contract "$ADDR" "src/${NAME}.sol:${NAME}" \
      --chain "$CHAIN_ID" --etherscan-api-key "$ETHERSCAN_API_KEY" \
      --rpc-url "$RPC" --guess-constructor-args --watch; then
    echo "    OK ${NAME}"
  else
    echo "    FAILED ${NAME} — re-run when the explorer is reachable / not rate-limited"
    fail=1
  fi
done < <(jq -r '.transactions[] | select(.transactionType=="CREATE" and .contractName != null) | "\(.contractName) \(.contractAddress)"' "$BCAST")

exit $fail
