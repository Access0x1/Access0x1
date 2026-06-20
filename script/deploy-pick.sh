#!/usr/bin/env bash
#
# deploy-pick.sh — interactive chain picker for the CREATE3 MIRROR deploy.
#
# Why it exists: the mirror deploy lands every contract at ONE address on every chain, but each chain
# still costs gas. Rather than a fire-and-hose `deploy-all` (which could drain the faucet war-chest), this
# shows — per chain — the deployer's GAS balance and whether the mirror is ALREADY deployed, then lets the
# operator pick WHICH chains to do now (some today, some tomorrow; all once an accelerator funds the gas).
# It never auto-deploys: you choose, and each chosen chain's `make deploy-<target>` still asks for the
# keystore password (the broadcast stays owner-physical).
#
# Usage:  make deploy-pick        (or: script/deploy-pick.sh)
#
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.." || exit 1

# Load the operator's configured RPCs/keys (gitignored) so the status checks use the same endpoints the
# deploy will. Export them so child `make` inherits them too.
set -a; [ -f .env ] && . ./.env; set +a

DEPLOYER="${DEPLOYER:-0xA121e1eF31BbF0826aa67dc01e7977e80Af58D73}"
# The CREATE3 mirror Router proxy — identical on every chain for this deployer (proven in
# test/integration/Create3MirrorSpike.t.sol). Code present here ⇒ the mirror is already deployed.
MIRROR_ROUTER=0xe92244e3368561faf21648146511DeDE3a475EB5

# name | make-target | chainId | <RPC env var> | native gas token
# 0G Galileo is omitted until CreateX is bootstrapped there (make bootstrap-createx-galileo).
CHAINS=(
  "arc|deploy-arc|5042002|ARC_TESTNET_RPC_URL|USDC"
  "base|deploy-base-sepolia|84532|BASE_SEPOLIA_RPC_URL|ETH"
  "eth-sep|deploy-ethereum-sepolia|11155111|SEPOLIA_RPC_URL|ETH"
  "op-sep|deploy-optimism-sepolia|11155420|OPTIMISM_SEPOLIA_RPC_URL|ETH"
  "fuji|deploy-avalanche-fuji|43113|AVALANCHE_FUJI_RPC_URL|AVAX"
  "robinhood|deploy-robinhood-testnet|46630|ROBINHOOD_TESTNET_RPC_URL|ETH"
  "arbitrum|deploy-arbitrum-sepolia|421614|ARBITRUM_SEPOLIA_RPC_URL|ETH"
  "celo|deploy-celo-sepolia|11142220|CELO_SEPOLIA_RPC_URL|CELO"
)

echo "CREATE3 mirror deploy — the Router lands at ${MIRROR_ROUTER} on EVERY chain."
echo "Deployer: ${DEPLOYER}"
echo
printf "  %-3s %-10s %-10s %-12s %-7s %s\n" "#" "chain" "chainId" "gas" "native" "mirror status"
printf "  %s\n" "---------------------------------------------------------------------"

targets=()       # index -> make target
names=()         # index -> short name
i=0
for row in "${CHAINS[@]}"; do
  IFS='|' read -r name target cid rpcvar tok <<< "$row"
  rpc="${!rpcvar:-}"
  i=$((i + 1)); targets[i]="$target"; names[i]="$name"

  if [ -z "$rpc" ]; then
    printf "  %-3s %-10s %-10s %-12s %-7s %s\n" "$i" "$name" "$cid" "?" "$tok" "no RPC (set ${rpcvar})"
    continue
  fi
  bal=$(cast balance "$DEPLOYER" --rpc-url "$rpc" 2>/dev/null)
  gas=$(cast from-wei "${bal:-0}" 2>/dev/null | cut -c1-9)
  code=$(cast code "$MIRROR_ROUTER" --rpc-url "$rpc" 2>/dev/null)
  bytes=$(( ${#code} / 2 - 1 )); [ "$bytes" -lt 0 ] && bytes=0
  if [ "$bytes" -gt 0 ]; then status="✓ MIRRORED";
  elif [ -z "$bal" ]; then status="unreachable";
  elif [ "${bal}" = "0" ]; then status="needs deploy (NO GAS — faucet first)";
  else status="needs deploy"; fi
  printf "  %-3s %-10s %-10s %-12s %-7s %s\n" "$i" "$name" "$cid" "${gas:-?}" "$tok" "$status"
done

echo
read -rp "Deploy which? (space-separated #s or names, 'all', blank = cancel): " picks
[ -z "${picks// }" ] && { echo "Cancelled — nothing deployed."; exit 0; }

# Resolve the selection to make targets.
chosen=()
if [ "$picks" = "all" ]; then
  for n in "${targets[@]:1}"; do chosen+=("$n"); done
else
  for p in $picks; do
    if [[ "$p" =~ ^[0-9]+$ ]] && [ -n "${targets[$p]:-}" ]; then chosen+=("${targets[$p]}");
    else
      for k in "${!names[@]}"; do [ "${names[$k]}" = "$p" ] && chosen+=("${targets[$k]}"); done
    fi
  done
fi
[ "${#chosen[@]}" -eq 0 ] && { echo "No valid selection — nothing deployed."; exit 1; }

echo
echo "Will run, one at a time (each asks for the keystore password):"
for t in "${chosen[@]}"; do echo "  make $t"; done
read -rp "Proceed? [y/N]: " ok
[ "$ok" = "y" ] || [ "$ok" = "Y" ] || { echo "Cancelled."; exit 0; }

for t in "${chosen[@]}"; do
  echo; echo "==> make $t"
  make "$t" || echo "   (make $t exited non-zero — fix and re-run just that one)"
done
echo; echo "Done. Record any landed deploy from broadcast/<chainId>/ (verify on-chain first)."
