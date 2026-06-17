#!/usr/bin/env bash
# Access0x1 — git-style multi-testnet deploy. For EACH chain it compares your locally-compiled
# Access0x1Router bytecode (the "version fingerprint") to what is LIVE on-chain at the recorded
# address, and decides like `git` — FULLY AUTOMATIC, no per-chain prompt:
#   • identical        → already up to date, SKIP (nothing to deploy)
#   • not deployed yet → DEPLOY automatically (if the wallet is funded; unfunded chains skip)
#   • different build  → auto-SKIP with a warning (auto-overwriting a live deploy would mint new
#                        addresses, so that one stays a deliberate `make deploy-<chain>`)
# Nothing is hardcoded-excluded and nothing is asked — the on-chain state + funding decide, so
# already-live chains (Arc, Base, Ethereum Sepolia, …) auto-skip and funded new chains auto-deploy.
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
  # Fully automatic (no per-chain prompt): SAME→skip, ABSENT→deploy if funded, OUTDATED→skip+warn
  # (auto-overwriting a live deployment would mint new addresses, so that one stays a manual,
  # deliberate `make deploy-<chain>`).
  case "$state" in
    SAME)
      echo "  ✓ up to date — live Router $ROUTER_ADDR is byte-identical to local. skip."
      uptodate="$uptodate $name"; continue ;;
    OUTDATED)
      echo "  ⚠ a DIFFERENT build is live ($ROUTER_ADDR) — auto-SKIP (re-deploy mints new addrs)."
      echo "    To intentionally overwrite: make deploy-$name"
      skipped="$skipped $name(outdated)"; continue ;;
    ABSENT)
      echo "  not deployed (chainid ${cid:-?}) — deploying if funded…" ;;
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

# ── Extra Chainlink-faucet testnets (no dedicated HelperConfig branch) ────────────────────────────
# Deployed via the GENERIC FALLBACK: export PLATFORM_TREASURY and HelperConfig reads it; feeds/USDC
# default to address(0) ⇒ a BARE router + commerce stack (USD pricing added per-chain later). Broadcast
# -only + --legacy (many of these RPCs lack eth_feeHistory). Same git-style skip + balance precheck,
# fully automatic (no prompt). Validated live + chainId-matched 2026-06-17; 5 with a dead/wrong RPC were dropped (Shibarium,
# Core, Mind, XDC Apothem, X Layer) — add them back when a working RPC is known.
EXTRA='wemix3-0-testnet|1112|https://api.test.wemix.com/
metis-sepolia|59902|https://sepolia.metisdevops.link
polygon-zkevm-cardona-testnet|2442|https://rpc.cardona.zkevm-rpc.com
mode-sepolia|919|https://sepolia.mode.network
cronos-zkevm-testnet|240|https://testnet.zkevm.cronos.org
cronos-testnet|338|https://evm-t3.cronos.org
soneium-minato|1946|https://rpc.minato.soneium.org
hedera-testnet|296|https://testnet.hashio.io/api
corn-testnet|21000001|https://testnet-rpc.usecorn.com
astar-shibuya|81|https://evm.shibuya.astar.network
sei-testnet-atlantic-2|1328|https://evm-rpc-testnet.sei-apis.com
bob-sepolia|808813|https://bob-sepolia.rpc.gobob.xyz
bitlayer-testnet|200810|https://testnet-rpc.bitlayer.org
plume-testnet|98867|https://testnet-rpc.plume.org
abstract-testnet|11124|https://api.testnet.abs.xyz
lisk-sepolia-testnet|4202|https://rpc.sepolia-api.lisk.com
metal-l2-testnet|1740|https://testnet.rpc.metall2.com/
superseed-sepolia-testnet|53302|https://sepolia.superseed.xyz
opbnb-testnet|5611|https://opbnb-testnet-rpc.bnbchain.org
neo-x-testnet-t4|12227332|https://testnet.rpc.banelabs.org/
kaia-kairos-testnet|1001|https://public-en-kairos.node.kaia.io
tac-saint-petersburg-testnet|2391|https://spb.rpc.tac.build
plasma-testnet|9746|https://testnet-rpc.plasma.to
berachain-bepolia-testnet|80069|https://bepolia.rpc.berachain.com
jovay-testnet|2019775|https://api.zan.top/public/jovay-testnet
ab-core-testnet|26888|https://rpc.core.testnet.ab.org
pharos-atlantic-testnet|688689|https://atlantic.dplabs-internal.com
morph-hoodi-testnet|2910|https://rpc-hoodi.morph.network
ethereum-hoodi-testnet|560048|https://rpc.hoodi.ethpandaops.io
megaeth-testnet|6343|https://carrot.megaeth.com/rpc
monad-testnet|10143|https://testnet-rpc.monad.xyz
dogeos-chiky-testnet|6281971|https://rpc.testnet.dogeos.com/
adi-testnet|99999|https://rpc.ab.testnet.adifoundation.ai/
ronin-saigon-testnet|202601|https://saigon-testnet.roninchain.com/rpc
edge-testnet|33431|https://edge-testnet.g.alchemy.com/public
robinhood-chain-testnet|46630|https://rpc.testnet.chain.robinhood.com
tempo-moderato-testnet|42431|https://rpc.moderato.tempo.xyz
creditcoin-testnet|102031|https://rpc.cc3-testnet.creditcoin.network'

while IFS='|' read -r name cid rpc; do
  [ -z "$name" ] && continue
  echo; echo "================= $name (extra · bare) ================="
  st=$(deploy_state "$cid" "$rpc")
  case "$st" in
    SAME) echo "  ✓ up to date — Router $ROUTER_ADDR identical. skip."; uptodate="$uptodate $name"; continue ;;
    OUTDATED) echo "  ⚠ a different build is live ($ROUTER_ADDR) — auto-SKIP (overwrite manually if intended)."; skipped="$skipped $name(outdated)"; continue ;;
    ABSENT) echo "  not deployed (chainid $cid) — deploying bare if funded…" ;;
  esac
  bal=$(cast balance "$DEPLOYER" --rpc-url "$rpc" 2>/dev/null || echo 0)
  if [ -z "$bal" ] || [ "$bal" = "0" ]; then echo "  0 gas — skip. Fund at faucets.chain.link."; skipped="$skipped $name"; continue; fi
  echo "  funded ($bal) — deploying bare via generic fallback (--legacy, no verify)…"
  if PLATFORM_TREASURY="$DEPLOYER" forge script script/DeployAll.s.sol --rpc-url "$rpc" --account "$DEPLOYER_ACCOUNT" --sender "$DEPLOYER" --broadcast --legacy -vvvv; then
    deployed="$deployed $name"
  elif [ "$(deploy_state "$cid" "$rpc")" = "SAME" ]; then
    echo "  ↳ landed (Router live) despite non-zero — counting deployed."; deployed="$deployed $name"
  else
    echo "  !!! $name did not land — check broadcast/ (RPC? legacy gas? funds?)."; failed="$failed $name"
  fi
done <<< "$EXTRA"

echo; echo "===================== SUMMARY ====================="
echo "  deployed (new / re-deployed):${deployed:- none}"
echo "  up to date (identical, skipped):${uptodate:- none}"
echo "  skipped (declined / unfunded / no RPC):${skipped:- none}"
echo "  failed (or deployed-but-unverified — check broadcast/):${failed:- none}"
echo "  New addresses land in broadcast/DeployAll.s.sol/<chainId>/run-latest.json — paste them to record."
