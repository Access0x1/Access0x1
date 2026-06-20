#!/usr/bin/env bash
#
# verify-etherscan.sh — verify every contract from a DeployAll broadcast on an Etherscan-compatible
# explorer. Two modes:
#
#   • Etherscan V2 (default): ONE ETHERSCAN_API_KEY covers every Etherscan-family chain
#     (Ethereum / Base / Optimism / Arbitrum / Polygon / …) — keyed by `--chain <id>`. The legacy
#     per-explorer keys (Basescan/Arbiscan/Polygonscan/…) were deprecated 2025-08-15; there is no
#     per-chain key to get, and the rate limit is per ACCOUNT (free tier = 3 calls/sec — raise it with
#     a paid Etherscan tier, not more keys).
#   • Custom Etherscan-compatible (e.g. Routescan / Snowtrace for Avalanche): pass a verifier URL as
#     $3 and an (often placeholder) key as $4. Routescan needs no real key — use `verifyContract`.
#
# Deploy-path-INDEPENDENT: reads the RECORDED broadcast, needs NO keystore, sends NO transaction.
# Constructor args recovered via --guess-constructor-args. Idempotent (already-verified ⇒ no-op).
# Rate-limit-aware: forge backs off via --retries/--delay, and a throttle gap sits between contracts so
# the 3-calls/sec free tier is respected.
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

# Shared resolver — resolves each contract's real source path from its build artifact (universal across
# layouts: src/, src/libraries/, test/mocks/, nested, external), instead of assuming src/<Name>.sol.
# shellcheck source=verify-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify-lib.sh"

CHAIN_ID="${1:?usage: verify-etherscan.sh <chainId> <rpcUrl> [verifierUrl] [apiKey]}"
RPC="${2:?missing rpc URL}"
VERIFIER_URL="${3:-}"
API_KEY="${4:-${ETHERSCAN_API_KEY:-}}"
# Which deploy script's broadcast to read. Defaults to the consolidated DeployAll.s.sol; override with
# BROADCAST_SCRIPT to verify a standalone deploy (e.g. DeployUsdMockFeed.s.sol) or an external project.
BCAST="broadcast/${BROADCAST_SCRIPT:-DeployAll.s.sol}/${CHAIN_ID}/run-latest.json"
THROTTLE="${VERIFY_THROTTLE:-2}"   # seconds between contracts — stay under the 3-calls/sec free tier

# Record a chain-level SKIP to the results file (so a chain that can't even start STILL shows in the
# one-paste digest, instead of silently vanishing) and exit non-zero.
log_skip() {
  [ -n "${VERIFY_RESULTS:-}" ] && printf 'SKIP\t%s\t%s\n' "$CHAIN_ID" "$1" >> "$VERIFY_RESULTS"
  echo "skip: chain ${CHAIN_ID} — $1" >&2
  exit 1
}

[ -f "$BCAST" ] || log_skip "no broadcast (deploy to chain ${CHAIN_ID} first)"

# Build the verifier flags for the chosen mode.
if [ -n "$VERIFIER_URL" ]; then
  # Custom Etherscan-compatible (Routescan/Snowtrace/etc.). Placeholder key is fine where none is needed.
  VERIFIER_ARGS=(--verifier custom --verifier-url "$VERIFIER_URL" --etherscan-api-key "${API_KEY:-verifyContract}")
else
  # Etherscan V2 multichain — one key, routed by chain id.
  [ -n "$API_KEY" ] || log_skip "set ETHERSCAN_API_KEY in .env (one V2 key covers all Etherscan-family chains)"
  VERIFIER_ARGS=(--chain "$CHAIN_ID" --etherscan-api-key "$API_KEY")
fi

fail=0
while read -r NAME ADDR; do
  [ -n "$NAME" ] && [ "$NAME" != "null" ] || { echo "skip (unnamed CREATE) $ADDR"; continue; }
  echo "==> verifying ${NAME} @ ${ADDR}"
  TARGET=$(resolve_target "$NAME")
  if verify_with_retry 5 "$ADDR" "$TARGET" \
      "${VERIFIER_ARGS[@]}" --rpc-url "$RPC" --guess-constructor-args --watch --retries 15 --delay 6; then
    echo "    OK ${NAME}"
    [ -n "${VERIFY_RESULTS:-}" ] && printf 'PASS\t%s\t%s\n' "$CHAIN_ID" "$NAME" >> "$VERIFY_RESULTS"
  else
    echo "    FAILED ${NAME} — re-run when the explorer is reachable / not rate-limited"
    [ -n "${VERIFY_RESULTS:-}" ] && printf 'FAIL\t%s\t%s\n' "$CHAIN_ID" "$NAME" >> "$VERIFY_RESULTS"
    fail=1
  fi
  sleep "$THROTTLE"
done < <(jq -r '.transactions[] | select(.transactionType=="CREATE" and .contractName != null) | "\(.contractName) \(.contractAddress)"' "$BCAST")

exit $fail
