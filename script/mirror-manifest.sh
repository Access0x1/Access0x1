#!/usr/bin/env bash
#
# mirror-manifest.sh — compute the CREATE3 MIRROR address of every Access0x1
# contract from its salt alone (NO deploy, NO gas), and emit one canonical
# manifest the README + verify scripts read.
#
# Why it exists: the CREATE3 mirror lands each contract at the SAME address on
# every chain, but the factory-deployed contracts show up in a broadcast's
# `additionalContracts` (not as named CREATE txns), so the per-chain row/verify
# tooling (regen_chain_rows.py, verify-lib.sh) can't find them by name. This
# derives the addresses purely from the salts — the single source of truth for
# "what address SHOULD each contract have, everywhere" — so recording + verify +
# the README all read one file instead of re-deriving on-chain per chain.
#
# The salt (mirrors DeployAll.s.sol `_mirrorSalt`, mode-(b) of CreateX):
#   rawSalt = deployer(20B) ‖ 0x00 ‖ bytes11(keccak256("access0x1.v1." ‖ label))
#   guarded = keccak256( bytes32(uint160(deployer)) ‖ rawSalt )
#   address = CreateX.computeCreate3Address(guarded)   (CreateX is the deployer)
# The guard hashes only (deployer, salt) — NO block.chainid — so the address is
# identical on every chain for a fixed deployer.
#
# Usage:  make mirror-manifest      (or: script/mirror-manifest.sh)
# Output: script/mirror-manifest.json  (label -> mirror address)
#
# @author Access0x1

set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.." || exit 1
set -a; [ -f .env ] && . ./.env; set +a

DEPLOYER="${DEPLOYER:-0xA121e1eF31BbF0826aa67dc01e7977e80Af58D73}"
CREATEX="0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed"
NS="access0x1.v1."
# Any chain where CreateX is live works (the address is chain-independent); the
# call is a pure view. Override with MIRROR_MANIFEST_RPC.
RPC="${MIRROR_MANIFEST_RPC:-${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}}"
# The proven mirror Router proxy (test/integration/Create3MirrorSpike.t.sol).
EXPECTED_ROUTER="0xe92244e3368561faf21648146511DeDE3a475EB5"
OUT="script/mirror-manifest.json"

command -v cast >/dev/null 2>&1 || { echo "ERROR: foundry 'cast' not found" >&2; exit 1; }

DEP_NO0X="${DEPLOYER#0x}"
PAD_DEPLOYER="000000000000000000000000${DEP_NO0X}"   # bytes32(uint160(deployer)) = 24 zero-nibbles + 40

# The 17 UUPS contracts (DeployAll deploys each as .impl + .proxy via _deployUUPS),
# plus the standalone Access0x1Receiver (a single deployCreate3). Order mirrors
# DeployAll.s.sol's run() for readability.
UUPS=(
  Access0x1Router PaymentLanes Access0x1Subscriptions Access0x1Escrow
  AutomationGateway Access0x1ProvenanceRegistry Access0x1Bookings
  Access0x1GiftCards Access0x1Invoices Access0x1Nft HouseTokenFactory SessionGrant
  GaslessPayIn Refunds SplitSettler Receivables PriceOracleAdapter
)
SINGLE=( Access0x1Receiver )

# label -> mirror address (computed purely from the salt). Retries the RPC a few
# times: computeCreate3Address is a pure view call, so any non-empty result is
# deterministic and safe to retry; only a transient RPC error (429/timeout on the
# public endpoint) yields empty. Returns non-zero ONLY after all retries fail — the
# caller MUST treat that as fatal, never as address(0).
mirror_addr() {
  local label="$1" tag tag11 raw guarded addr attempt
  tag="$(cast keccak "${NS}${label}")"      # 0x + 64 hex (keccak of the UTF-8 string)
  tag11="${tag:2:22}"                         # bytes11 = leftmost 11 bytes = 22 hex
  raw="${DEP_NO0X}00${tag11}"                 # rawSalt body: 40 + 2 + 22 = 64 hex (32 bytes)
  guarded="$(cast keccak "0x${PAD_DEPLOYER}${raw}")"   # keccak( padded-deployer ‖ rawSalt ) over 64 bytes
  for attempt in 1 2 3 4 5; do
    addr="$(cast call "$CREATEX" "computeCreate3Address(bytes32)(address)" "$guarded" --rpc-url "$RPC" 2>/dev/null)"
    [ -n "$addr" ] && { printf '%s' "$addr"; return 0; }
    sleep 1
  done
  return 1   # all retries exhausted — signal failure, print nothing
}

echo "Computing CREATE3 mirror addresses (deployer ${DEPLOYER}, via ${RPC})…"
echo "{" > "$OUT"
echo "  \"namespace\": \"${NS}\"," >> "$OUT"
echo "  \"deployer\": \"${DEPLOYER}\"," >> "$OUT"
echo "  \"createx\": \"${CREATEX}\"," >> "$OUT"
echo "  \"note\": \"Identical on EVERY chain — computed from the salt, not deployed. Mirrors DeployAll _mirrorSalt.\"," >> "$OUT"
echo "  \"contracts\": {" >> "$OUT"

printf "  %-32s %s\n" "LABEL" "MIRROR ADDRESS"
printf "  %s\n" "------------------------------------------------------------------------"
rows=()
for c in "${UUPS[@]}"; do
  for kind in impl proxy; do rows+=("${c}.${kind}"); done
done
for c in "${SINGLE[@]}"; do rows+=("$c"); done

n=${#rows[@]}; i=0
for label in "${rows[@]}"; do
  i=$((i + 1))
  # Fail loud on a transient RPC error — a manifest with a zero address for a real
  # contract is worse than none (it becomes the "source of truth" for README rows +
  # verify tooling). Abort before the file is trusted; the partial $OUT is left for
  # inspection but the non-zero exit tells `make sync` / CI not to use it.
  if ! a="$(mirror_addr "$label")"; then
    echo "✗ FATAL: could not compute mirror address for '${label}' after retries (RPC ${RPC})." >&2
    echo "  Re-run against a healthier RPC (RPC=<url> $0). Manifest NOT trustworthy — aborting." >&2
    exit 1
  fi
  printf "  %-32s %s\n" "$label" "$a"
  comma=","; [ "$i" -eq "$n" ] && comma=""
  echo "    \"${label}\": \"${a}\"${comma}" >> "$OUT"
done
echo "  }" >> "$OUT"
echo "}" >> "$OUT"

echo
echo "Wrote ${OUT} (${n} addresses)."

# ── Self-check: the Router proxy MUST equal the proven mirror, or the salt math
#    (or namespace) has drifted from DeployAll — fail loud, don't ship a bad manifest.
ROUTER_PROXY="$(mirror_addr "Access0x1Router.proxy")"
# Portable lowercase — macOS ships bash 3.2, which lacks the ${var,,} expansion.
RP_LC="$(printf '%s' "$ROUTER_PROXY" | tr 'A-F' 'a-f')"
EX_LC="$(printf '%s' "$EXPECTED_ROUTER" | tr 'A-F' 'a-f')"
if [ "$RP_LC" = "$EX_LC" ]; then
  echo "✓ VERIFIED: Access0x1Router.proxy == ${EXPECTED_ROUTER} (the proven mirror)"
else
  echo "✗ MISMATCH: Access0x1Router.proxy computed ${ROUTER_PROXY}, expected ${EXPECTED_ROUTER}" >&2
  echo "  The salt formula or SALT_NAMESPACE has drifted from DeployAll.s.sol — investigate before trusting the manifest." >&2
  exit 1
fi
