#!/usr/bin/env bash
#
# bootstrap-createx-galileo.sh — put the CreateX factory on 0G Galileo (chainId 16602),
# the ONE chain in our set where CreateX is absent, so the CREATE3 mirror engine
# (DeployAll.s.sol) can extend there and land every contract at its canonical mirror
# address.
#
# Method (verified against pcaversaccio/createx, 2026-06-20): CreateX is NOT deployed
# via the 0x4e59 deterministic-deployment-proxy. It ships as an OFFICIAL PRE-SIGNED,
# KEYLESS transaction from a fixed one-time deployer EOA — broadcasting it lands CreateX
# at the canonical 0xba5Ed099...ba5Ed on any EVM chain with Ethereum-equivalent gas
# metering (~2.58M gas used). You fund the deployer EOA once; the tx pays its own gas.
#
# OWNER step (the only one that spends funds): send >= 0.3 0G to the CreateX deployer
#   0xeD456e05CaAb11d66C4c797dD6c1D6f9A7F352b5  on 0G Galileo (chainscan-galileo.0g.ai).
# Then re-run with --publish (anyone can broadcast; the pre-signed tx is self-funded).
#
# Usage:
#   make bootstrap-createx-galileo          # status + the exact runbook (no broadcast)
#   ./script/bootstrap-createx-galileo.sh --publish   # broadcast once the deployer is funded
#
# @author Access0x1

set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.." || exit 1
set -a; [ -f .env ] && . ./.env; set +a

RPC="${GALILEO_RPC_URL:-https://evmrpc-testnet.0g.ai}"
CREATEX="0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed"
CX_DEPLOYER="0xeD456e05CaAb11d66C4c797dD6c1D6f9A7F352b5"   # the keyless CreateX deployer EOA
MIN_WEI="300000000000000000"                               # 0.3 0G (18 dec)
# Default (3,000,000 gas-limit) pre-signed deployment tx from the official repo. Override
# CREATEX_PRESIGNED_URL with the medium/heavy variant for chains that need a bigger limit.
PRESIGNED_URL="${CREATEX_PRESIGNED_URL:-https://raw.githubusercontent.com/pcaversaccio/createx/main/scripts/presigned-createx-deployment-transactions/signed_serialised_transaction_gaslimit_3000000_.json}"

command -v cast >/dev/null 2>&1 || { echo "ERROR: foundry 'cast' not found" >&2; exit 1; }

echo "0G Galileo (16602) — CreateX bootstrap"
echo "RPC: ${RPC}"

# 1. Already deployed?
code="$(cast code "$CREATEX" --rpc-url "$RPC" 2>/dev/null)"
if [ -n "$code" ] && [ "$code" != "0x" ]; then
  echo "✓ CreateX is ALREADY on 0G at ${CREATEX} (${#code} hex chars). Nothing to do —"
  echo "  the mirror can deploy here now:  make deploy-galileo"
  exit 0
fi
echo "• CreateX is ABSENT on 0G — needs bootstrap."

# 2. Is the keyless deployer funded?
bal="$(cast balance "$CX_DEPLOYER" --rpc-url "$RPC" 2>/dev/null || echo 0)"
echo "• CreateX deployer ${CX_DEPLOYER} balance: $(cast from-wei "${bal:-0}" 2>/dev/null) 0G"
funded=0
# string-safe big-int compare (bash 3.2: no 18-digit arithmetic) — compare lengths then lexically
if [ "${#bal}" -gt "${#MIN_WEI}" ] || { [ "${#bal}" -eq "${#MIN_WEI}" ] && [ "$bal" \> "$MIN_WEI" -o "$bal" = "$MIN_WEI" ]; }; then funded=1; fi

if [ "$funded" -ne 1 ]; then
  cat <<EOF

OWNER ACTION (one-time, spends ~0.3 0G):
  Send >= 0.3 0G to the CreateX deployer EOA on 0G Galileo:
    ${CX_DEPLOYER}
  (faucet/explorer: https://chainscan-galileo.0g.ai). Then re-run with --publish.
EOF
  exit 0
fi
echo "✓ deployer is funded."

# 3. Fetch the official pre-signed deployment transaction.
echo "• fetching the official pre-signed CreateX deploy tx…"
RAW="$(curl -fsSL "$PRESIGNED_URL" 2>/dev/null | grep -oE '0x[0-9a-fA-F]{200,}' | head -1)"
if [ -z "$RAW" ]; then
  cat <<EOF
✗ Could not auto-fetch the pre-signed tx from:
    ${PRESIGNED_URL}
  Grab it by hand from pcaversaccio/createx → scripts/presigned-createx-deployment-transactions/
  then:  cast publish <raw_signed_tx> --rpc-url ${RPC}
EOF
  exit 1
fi

# 4. Broadcast (only with --publish). The pre-signed tx pays its own gas from the funded EOA.
if [ "${1:-}" != "--publish" ]; then
  echo
  echo "Ready. Deployer funded + pre-signed tx fetched. To broadcast, run:"
  echo "  ./script/bootstrap-createx-galileo.sh --publish"
  exit 0
fi
echo "• broadcasting (cast publish)…"
cast publish "$RAW" --rpc-url "$RPC" || { echo "✗ publish failed" >&2; exit 1; }

# 5. Verify it landed.
code2="$(cast code "$CREATEX" --rpc-url "$RPC" 2>/dev/null)"
if [ -n "$code2" ] && [ "$code2" != "0x" ]; then
  echo "✓ CreateX deployed on 0G at ${CREATEX}. The mirror can now deploy here: make deploy-galileo"
else
  echo "✗ post-publish check shows no code at ${CREATEX} — verify the tx + gas limit (try the medium/heavy CREATEX_PRESIGNED_URL)." >&2
  exit 1
fi
