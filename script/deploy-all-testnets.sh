#!/usr/bin/env bash
# Access0x1 — deploy the full first-party stack to EVERY funded testnet, in one command.
#
# Reads each chain's RPC URL + the DEPLOYER address from .env; signs with the `deployer`
# cast keystore (you are prompted for the password ONCE PER FUNDED CHAIN — keystore signing
# cannot be cached, and an agent must never enter it). A read-only `cast balance` precheck
# runs first per chain: a chain with 0 gas is SKIPPED (fund it from the printed faucet and
# re-run). The loop continues past failures and prints a summary.
#
# ⛔ Arc + Base Sepolia + Ethereum Sepolia are intentionally EXCLUDED: all already LIVE, and re-deploying
#    would mint NEW contract addresses and break the recorded deployment + the live app + deck.
# ℹ️ Each target broadcasts BEFORE it verifies, so a chain shown as "failed" may have actually
#    deployed and only failed source-verification (missing *SCAN_API_KEY) — check
#    broadcast/DeployAll.s.sol/<chainId>/run-latest.json before assuming it didn't land.
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; . ./.env; set +a; }
: "${DEPLOYER:?set DEPLOYER in .env (the deployer wallet address) before running}"

# make-target | RPC env-var | faucet hint  (arc + base + ethereum-sepolia excluded — already live)
CHAINS='arbitrum-sepolia|ARBITRUM_SEPOLIA_RPC_URL|bridge Sepolia ETH or Alchemy faucet
optimism-sepolia|OPTIMISM_SEPOLIA_RPC_URL|Superchain faucet / Alchemy
zksync-sepolia|ZKSYNC_SEPOLIA_RPC_URL|bridge Sepolia ETH at portal.zksync.io
polygon-amoy|POLYGON_AMOY_RPC_URL|faucet.polygon.technology
avalanche-fuji|AVALANCHE_FUJI_RPC_URL|faucet.avax.network
bnb-testnet|BNB_TESTNET_RPC_URL|testnet.bnbchain.org/faucet-smart
scroll-sepolia|SCROLL_SEPOLIA_RPC_URL|bridge at sepolia.scroll.io/bridge
linea-sepolia|LINEA_SEPOLIA_RPC_URL|bridge / Infura faucet
mantle-sepolia|MANTLE_SEPOLIA_RPC_URL|faucet.sepolia.mantle.xyz
blast-sepolia|BLAST_SEPOLIA_RPC_URL|faucet.quicknode.com/blast/sepolia
unichain-sepolia|UNICHAIN_SEPOLIA_RPC_URL|Alchemy faucet
zora-sepolia|ZORA_SEPOLIA_RPC_URL|bridge Sepolia ETH
filecoin-calibration|FILECOIN_CALIBRATION_RPC_URL|faucet.calibnet.chainsafe-fil.io
gnosis-chiado|GNOSIS_CHIADO_RPC_URL|gnosisfaucet.com
apechain-curtis|APECHAIN_CURTIS_RPC_URL|curtis.hub.caldera.xyz
worldchain-sepolia|WORLDCHAIN_SEPOLIA_RPC_URL|bridge Sepolia ETH
zircuit-garfield|ZIRCUIT_GARFIELD_RPC_URL|faucet.zircuit.com
citrea-testnet|CITREA_TESTNET_RPC_URL|citrea.xyz faucet
flow-evm-testnet|FLOW_EVM_TESTNET_RPC_URL|faucet.flow.com
celo-sepolia|CELO_SEPOLIA_RPC_URL|faucet.celo.org'

deployed=""; skipped=""; failed=""
while IFS='|' read -r name rpcvar faucet; do
  [ -z "$name" ] && continue
  rpc="${!rpcvar:-}"
  echo; echo "================= $name ================="
  if [ -z "$rpc" ]; then echo "  no \$$rpcvar in .env — SKIP"; skipped="$skipped $name"; continue; fi
  bal=$(cast balance "$DEPLOYER" --rpc-url "$rpc" 2>/dev/null || echo 0)
  if [ -z "$bal" ] || [ "$bal" = "0" ]; then
    echo "  $DEPLOYER has 0 gas on $name — SKIP. Fund: $faucet"; skipped="$skipped $name"; continue
  fi
  echo "  funded ($bal wei native gas) — deploying the full stack…"
  if make "deploy-$name"; then deployed="$deployed $name"; else
    echo "  !!! deploy-$name returned non-zero (gas? RPC? verify?) — continuing. Check broadcast/ for $name."
    failed="$failed $name"
  fi
done <<< "$CHAINS"

echo; echo "===================== SUMMARY ====================="
echo "  deployed:${deployed:- none}"
echo "  skipped (unfunded / no RPC):${skipped:- none}"
echo "  failed (or deployed-but-unverified — check broadcast/):${failed:- none}"
echo "  (arc + base + ethereum-sepolia excluded — already live; re-deploy would mint new addresses)"
echo "  Record new addresses: they are in broadcast/DeployAll.s.sol/<chainId>/run-latest.json"
