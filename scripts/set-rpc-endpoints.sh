#!/usr/bin/env bash
# set-rpc-endpoints.sh — interactive, validated entry of per-chain RPC endpoints into `.env`.
# Run via `make rpc-setup` (the Makefile is the interface; this file is its implementation).
#
# WHY THIS EXISTS. Every deploy target reads `<CHAIN>_RPC_URL` with the rule ".env always wins":
# the Makefile ships keyless public defaults, and you override any of them with your own provider
# URL (Alchemy, Tenderly, etc.) for reliability. Provider URLs embed API keys, so they are
# SECRETS and never belong in the Makefile, in shell history, or on screen. This tool:
#
#   • prompts per network with HIDDEN input (`read -rs`) — nothing echoes, nothing is logged;
#   • VALIDATES each URL before storing it: the endpoint is asked `eth_chainId` and the answer
#     must match the network — a URL pasted under the wrong network is rejected, not stored;
#   • backs up `.env` once per run (mode-preserved) and only ever upserts single `VAR=` lines —
#     every other line is preserved byte-for-byte; file mode is re-asserted to 600;
#   • treats EMPTY input as SKIP, so re-running never disturbs values you already trust.
#
# Set once, keep forever: `.env` is gitignored (no git operation touches it) and nothing in this
# repo regenerates it. The only way to lose values is deleting the file itself.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENVF="$REPO_ROOT/.env"
[ -f "$ENVF" ] || { cp "$REPO_ROOT/.env.example" "$ENVF" && chmod 600 "$ENVF" && echo "created .env from .env.example (mode 600)"; }

# name|MAKEFILE_VAR|expected_chain_id — ids sourced from web/lib/deployments.ts where deployed,
# public chain registries otherwise. A wrong id here fails CLOSED (a valid URL gets rejected);
# fix the row and re-run.
NETWORKS='
Ethereum Sepolia|SEPOLIA_RPC_URL|11155111
OP Sepolia|OPTIMISM_SEPOLIA_RPC_URL|11155420
Base Sepolia|BASE_SEPOLIA_RPC_URL|84532
Arbitrum Sepolia|ARBITRUM_SEPOLIA_RPC_URL|421614
ZKsync Sepolia|ZKSYNC_SEPOLIA_RPC_URL|300
Unichain Sepolia|UNICHAIN_SEPOLIA_RPC_URL|1301
Celo Sepolia|CELO_SEPOLIA_RPC_URL|11142220
Arc Testnet|ARC_TESTNET_RPC_URL|5042002
Avalanche Fuji|AVALANCHE_FUJI_RPC_URL|43113
Hoodi|HOODI_RPC_URL|560048
Tempo Testnet|TEMPO_RPC_URL|42431
Polygon Amoy|POLYGON_AMOY_RPC_URL|80002
Scroll Sepolia|SCROLL_SEPOLIA_RPC_URL|534351
Filecoin Calibration|FILECOIN_CALIBRATION_RPC_URL|314159
Gnosis Chiado|GNOSIS_CHIADO_RPC_URL|10200
ApeChain Curtis|APECHAIN_CURTIS_RPC_URL|33111
World Chain Sepolia|WORLDCHAIN_SEPOLIA_RPC_URL|4801
Zircuit Garfield|ZIRCUIT_GARFIELD_RPC_URL|48898
Citrea Testnet|CITREA_TESTNET_RPC_URL|5115
Flow EVM Testnet|FLOW_EVM_TESTNET_RPC_URL|545
Zora Sepolia|ZORA_SEPOLIA_RPC_URL|999999999
BNB Testnet|BNB_TESTNET_RPC_URL|97
Linea Sepolia|LINEA_SEPOLIA_RPC_URL|59141
Mantle Sepolia|MANTLE_SEPOLIA_RPC_URL|5003
Blast Sepolia|BLAST_SEPOLIA_RPC_URL|168587773
Hedera Testnet|HEDERA_TESTNET_RPC_URL|296
'

TS="$(date +%s)"
cp -p "$ENVF" "$ENVF.bak-$TS"
echo "backup: .env.bak-$TS (mode preserved)"
echo "Paste each network's FULL provider HTTPS URL. Input is hidden. Empty = skip (keeps current value)."
echo

chain_id_of() {
  curl -sS --max-time 10 -X POST -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$1" 2>/dev/null \
    | python3 -c 'import sys,json
try: print(int(json.load(sys.stdin)["result"],16))
except Exception: pass' 2>/dev/null || true
}

upsert() {
  VAR="$1" VAL="$2" python3 - "$ENVF" <<'PY'
import os, sys
path, var, val = sys.argv[1], os.environ["VAR"], os.environ["VAL"]
lines = open(path).read().splitlines()
out, done = [], False
for l in lines:
    if l.startswith(var + "="):
        out.append(f"{var}={val}"); done = True
    else:
        out.append(l)
if not done:
    out.append(f"{var}={val}")
open(path, "w").write("\n".join(out) + "\n")
PY
}

STORED=0; SKIPPED=0; FAILED=0
while IFS='|' read -r NAME VAR EXPECT; do
  [ -z "${NAME:-}" ] && continue
  printf '%-22s (chain %-9s → %s)\n' "$NAME" "$EXPECT" "$VAR"
  read -rs -p "  endpoint (hidden): " URL </dev/tty; echo
  if [ -z "$URL" ]; then echo "  ── skipped (current value kept)"; SKIPPED=$((SKIPPED+1)); continue; fi
  GOT="$(chain_id_of "$URL")"
  if [ "$GOT" = "$EXPECT" ]; then
    upsert "$VAR" "$URL"
    echo "  ✅ chain id $GOT verified — stored"
    STORED=$((STORED+1))
  else
    echo "  ❌ REJECTED — endpoint answered chain id '${GOT:-no response}', expected $EXPECT. Not stored."
    FAILED=$((FAILED+1))
  fi
done <<EOF
$NETWORKS
EOF

chmod 600 "$ENVF"
echo
echo "done: $STORED stored · $SKIPPED skipped · $FAILED rejected · .env mode 600"
