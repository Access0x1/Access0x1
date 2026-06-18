#!/usr/bin/env bash
#
# verify-summary.sh — print a compact, copy-pasteable PASS/FAIL digest from the results written by the
# verify-* scripts (one tab-separated line per contract: STATUS \t chainId \t ContractName). Designed so
# the owner copies JUST this block — one line per contract, no verbose forge output, no swiping.
#
# Usage: script/verify-summary.sh [resultsFile]   (defaults to $VERIFY_RESULTS)
#
set -uo pipefail

FILE="${1:-${VERIFY_RESULTS:-/tmp/access0x1-verify-results.tsv}}"
[ -f "$FILE" ] || { echo "(no verify results at $FILE — run a verify target first)"; exit 0; }

name_for() {
  case "$1" in
    11155111) echo "ethereum-sepolia" ;;
    84532)    echo "base-sepolia" ;;
    11155420) echo "optimism-sepolia" ;;
    421614)   echo "arbitrum-sepolia" ;;
    43113)    echo "avalanche-fuji" ;;
    80002)    echo "polygon-amoy" ;;
    5042002)  echo "arc-testnet" ;;
    46630)    echo "robinhood-testnet" ;;
    *)        echo "chain-$1" ;;
  esac
}

echo "════════ VERIFY SUMMARY ════════"
pass=0
fail=0
skip=0
while IFS=$'\t' read -r STATUS CID NAME; do
  [ -n "${STATUS:-}" ] || continue
  label=$(name_for "$CID")
  case "$STATUS" in
    PASS) printf 'PASS  %-18s %s\n' "$label" "$NAME"; pass=$((pass + 1)) ;;
    SKIP) printf 'SKIP  %-18s %s\n' "$label" "$NAME"; skip=$((skip + 1)) ;;
    *)    printf 'FAIL  %-18s %s\n' "$label" "$NAME"; fail=$((fail + 1)) ;;
  esac
done < "$FILE"
echo "────────────────────────────────"
echo "${pass} passed · ${fail} failed · ${skip} skipped"
