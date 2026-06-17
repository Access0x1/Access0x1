#!/usr/bin/env bash
# Access0x1 — git-style multi-testnet deploy. For EACH chain it compares your locally-compiled
# Access0x1Router bytecode (the "version fingerprint") to what is LIVE on-chain at the recorded
# address, and decides like `git`:
#   • identical        → already up to date, SKIP (nothing to deploy)
#   • different build  → asks you: re-deploy? (default NO — re-deploy mints new addrs + overwrites)
#   • not deployed yet → asks you: deploy?   (default YES)
# Nothing is hardcoded-excluded — the on-chain state decides, so already-live chains (Arc, Base,
# Ethereum Sepolia, …) auto-skip without any manual list-tending.
#
# Read-only checks (chain-id, code, balance) need NO password. Only a chain you choose to deploy
# signs with your cast keystore ($DEPLOYER_ACCOUNT) and prompts you for the password then.
# A target broadcasts BEFORE it verifies, so a "failed" line may have deployed + only failed verify
# (missing key) — check broadcast/DeployAll.s.sol/<chainId>/run-latest.json.
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; . ./.env; set +a; }
: "${DEPLOYER:?set DEPLOYER in .env (the deployer wallet address) before running}"

# Fingerprint the local build once. The Router has no immutables and foundry.toml sets
# bytecode_hash="none", so a freshly-compiled deployedBytecode equals the on-chain runtime EXACTLY
# when the same source+settings are deployed — a clean equality test, no normalisation needed.
echo "==> fingerprinting the local build (forge inspect Access0x1Router)…"
LOCAL_ROUTER=$(forge inspect Access0x1Router deployedBytecode 2>/dev/null | tr 'A-F' 'a-f' | sed 's/^0x//')
[ -n "$LOCAL_ROUTER" ] || { echo "could not compile Access0x1Router — run 'forge build' first."; exit 1; }

# name (make-target) | RPC env-var | faucet hint — the FULL set; live chains skip themselves.
CHAINS='arc|ARC_TESTNET_RPC_URL|faucet.circle.com (Arc Testnet)
base-sepolia|BASE_SEPOLIA_RPC_URL|Base Sepolia faucet / bridge
ethereum-sepolia|SEPOLIA_RPC_URL|sepoliafaucet.com / Alchemy
arbitrum-sepolia|ARBITRUM_SEPOLIA_RPC_URL|bridge Sepolia ETH or Alchemy
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

# Print the deploy-state of a chain by diffing on-chain Router code vs LOCAL_ROUTER → SAME|OUTDATED|ABSENT.
# Also sets the global ROUTER_ADDR for the message.
ROUTER_ADDR=""
deploy_state() {  # chainId rpc
  local cid="$1" rpc="$2" bc addr onchain
  ROUTER_ADDR=""
  [ -z "$cid" ] && { echo ABSENT; return; }
  bc="broadcast/DeployAll.s.sol/$cid/run-latest.json"
  [ -f "$bc" ] || { echo ABSENT; return; }
  addr=$(python3 -c "import json;d=json.load(open('$bc'));print(next((t['contractAddress'] for t in d['transactions'] if t.get('contractName')=='Access0x1Router'),''))" 2>/dev/null)
  [ -z "$addr" ] && { echo ABSENT; return; }
  ROUTER_ADDR="$addr"
  onchain=$(cast code "$addr" --rpc-url "$rpc" 2>/dev/null | tr 'A-F' 'a-f' | sed 's/^0x//')
  [ -z "$onchain" ] || [ "$onchain" = "0x" ] && { echo ABSENT; return; }   # recorded but gone (testnet reset)
  [ "$onchain" = "$LOCAL_ROUTER" ] && echo SAME || echo OUTDATED
}

deployed=""; uptodate=""; skipped=""; failed=""
while IFS='|' read -r name rpcvar faucet; do
  [ -z "$name" ] && continue
  rpc="${!rpcvar:-}"
  echo; echo "================= $name ================="
  [ -z "$rpc" ] && { echo "  no \$$rpcvar in .env — skip"; skipped="$skipped $name"; continue; }

  # zkSync (EraVM) is a documented special case, NOT a batch target. foundry-zksync only allows
  # cheatcodes at the script root — not inside a CREATE/CALL dispatched to the zkEVM — so the standard
  # DeployAll (which does `new HelperConfig()` whose constructor reads env via vm.envAddress) reverts
  # under --zksync ("empty code / Not enough gas"). The zksolc BUILD is fine; deploying needs an
  # env-at-root script. Skip here so it never stalls the batch. See docs/ZKSYNC-TESTING.md.
  if [ "$name" = "zksync-sepolia" ]; then
    echo "  ⚠ zkSync skipped by the batch — needs a dedicated EraVM deploy (foundry-zksync cheatcode-in-CREATE limit)."
    echo "    The build compiles clean; see docs/ZKSYNC-TESTING.md. Not a stall, not our contract code."
    skipped="$skipped zksync-sepolia(EraVM-special-case)"; continue
  fi

  cid=$(cast chain-id --rpc-url "$rpc" 2>/dev/null || echo "")
  state=$(deploy_state "$cid" "$rpc")
  case "$state" in
    SAME)
      echo "  ✓ up to date — live Router $ROUTER_ADDR is byte-identical to your local build. Nothing to do."
      uptodate="$uptodate $name"; continue ;;
    OUTDATED)
      echo "  ⚠ a DIFFERENT Access0x1 build is live here (Router $ROUTER_ADDR)."
      echo "    Re-deploying mints NEW addresses and OVERWRITES the recorded deployment + anything wired to it."
      read -r -p "    Re-deploy $name anyway? [y/N] " ans </dev/tty || ans=""
      [[ "${ans:-}" =~ ^[Yy] ]] || { echo "    kept the existing deployment."; skipped="$skipped $name"; continue; } ;;
    ABSENT)
      read -r -p "  $name is NOT deployed (chainid ${cid:-unreachable}). Deploy the full stack? [Y/n] " ans </dev/tty || ans="Y"
      [[ "${ans:-Y}" =~ ^[Nn] ]] && { echo "    skipped."; skipped="$skipped $name"; continue; } ;;
  esac

  # Only now (we're going to deploy) does gas matter.
  bal=$(cast balance "$DEPLOYER" --rpc-url "$rpc" 2>/dev/null || echo 0)
  if [ -z "$bal" ] || [ "$bal" = "0" ]; then
    echo "  $DEPLOYER has 0 gas on $name — can't deploy. Fund: $faucet"; skipped="$skipped $name"; continue
  fi
  echo "  funded ($bal wei) — deploying… (keystore password prompt next)"
  if make "deploy-$name"; then
    deployed="$deployed $name"
  else
    # `make` returned non-zero — but a flaky explorer routinely 504s the VERIFY poll AFTER the
    # broadcast already landed (forge then exits 1 on "not all contracts verified", even though the
    # deploy succeeded). So re-check on-chain: if the Router is now live AND byte-identical, the
    # deploy SUCCEEDED and only verification timed out → auto-retry verify with --resume (no re-deploy).
    if [ "$(deploy_state "$cid" "$rpc")" = "SAME" ]; then
      echo "  ↳ deploy LANDED (Router $ROUTER_ADDR live + identical) — the non-zero was the verify poll."
      echo "    retrying verification with --resume (re-uses the broadcast, no new deploy)…"
      if RESUME=1 make "deploy-$name"; then echo "  ✓ verified on --resume retry."; else
        echo "  ⚠ verify still flaky (explorer down) — THE DEPLOY IS LIVE. Re-verify any time: RESUME=1 make deploy-$name"; fi
      deployed="$deployed $name"
    else
      echo "  !!! deploy-$name did NOT land (no matching Router on-chain) — a real failure. Check broadcast/."
      failed="$failed $name"
    fi
  fi
done <<< "$CHAINS"

echo; echo "===================== SUMMARY ====================="
echo "  deployed (new / re-deployed):${deployed:- none}"
echo "  up to date (identical, skipped):${uptodate:- none}"
echo "  skipped (declined / unfunded / no RPC):${skipped:- none}"
echo "  failed (or deployed-but-unverified — check broadcast/):${failed:- none}"
echo "  New addresses land in broadcast/DeployAll.s.sol/<chainId>/run-latest.json — paste them to record."
