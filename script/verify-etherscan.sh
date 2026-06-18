#!/usr/bin/env bash
#
# verify-etherscan.sh — verify every contract from a DeployAll broadcast on an Etherscan-compatible
# explorer. Two modes:
#
#   • Etherscan V2 (default): ONE ETHERSCAN_API_KEY covers every Etherscan-family chain
#     (Ethereum / Base / Optimism / Arbitrum / Polygon / …) — keyed by `--chain <id>`. The legacy
#     per-explorer keys (Basescan/Arbiscan/Polygonscan/…) were deprecated 2025-08-15; there is no
#     per-chain key to get, and the rate limit is per ACCOUNT (raise it with a paid Etherscan tier).
#   • Custom Etherscan-compatible (e.g. Routescan / Snowtrace for Avalanche): pass a verifier URL as
#     $3 and an (often placeholder) key as $4. Routescan needs no real key — use `verifyContract`.
#
# Deploy-path-INDEPENDENT: reads the RECORDED broadcast (broadcast/DeployAll.s.sol/<chainId>/
# run-latest.json), needs NO keystore, sends NO transaction. Constructor args recovered via
# --guess-constructor-args. Idempotent (already-verified ⇒ no-op).
#
# The V2 key is read from the ENV (ETHERSCAN_API_KEY) so it never lands in argv/logs — the Makefile
# passes it via an env assignment with `@` (echo suppressed). A custom-verifier placeholder key is not
# secret, so it may be passed as $4.
#
# Usage:
#   ETHERSCAN_API_KEY=... script/verify-etherscan.sh <chainId> <rpcUrl>                       # V2
#   script/verify-etherscan.sh <chainId> <rpcUrl> <verifierUrl> [apiKey]                      # custom
#
set -uo pipefail

CHAIN_ID="${1:?usage: verify-etherscan.sh <chainId> <rpcUrl> [verifierUrl] [apiKey]}"
RPC="${2:?missing rpc URL}"
VERIFIER_URL="${3:-}"
API_KEY="${4:-${ETHERSCAN_API_KEY:-}}"
BCAST="broadcast/DeployAll.s.sol/${CHAIN_ID}/run-latest.json"

[ -f "$BCAST" ] || {
  echo "No broadcast at $BCAST — deploy to chain ${CHAIN_ID} first." >&2
  exit 1
}

# Build the verifier flags for the chosen mode.
if [ -n "$VERIFIER_URL" ]; then
  # Custom Etherscan-compatible (Routescan/Snowtrace/etc.). Placeholder key is fine where none is needed.
  VERIFIER_ARGS=(--verifier custom --verifier-url "$VERIFIER_URL" --etherscan-api-key "${API_KEY:-verifyContract}")
else
  # Etherscan V2 multichain — one key, routed by chain id.
  [ -n "$API_KEY" ] || { echo "Set ETHERSCAN_API_KEY in .env (one Etherscan V2 key covers all Etherscan-family chains)." >&2; exit 1; }
  VERIFIER_ARGS=(--chain "$CHAIN_ID" --etherscan-api-key "$API_KEY")
fi

fail=0
while read -r NAME ADDR; do
  [ -n "$NAME" ] && [ "$NAME" != "null" ] || { echo "skip (unnamed CREATE) $ADDR"; continue; }
  echo "==> verifying ${NAME} @ ${ADDR}"
  if forge verify-contract "$ADDR" "src/${NAME}.sol:${NAME}" \
      "${VERIFIER_ARGS[@]}" --rpc-url "$RPC" --guess-constructor-args --watch; then
    echo "    OK ${NAME}"
  else
    echo "    FAILED ${NAME} — re-run when the explorer is reachable / not rate-limited"
    fail=1
  fi
done < <(jq -r '.transactions[] | select(.transactionType=="CREATE" and .contractName != null) | "\(.contractName) \(.contractAddress)"' "$BCAST")

exit $fail
