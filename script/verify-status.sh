#!/usr/bin/env bash
# verify-status.sh — ask the EXPLORER which contracts are actually source-verified.
#
# WHY THIS EXISTS. `forge verify-contract --watch` is the usual "did it work?" answer, but some
# Etherscan-protocol forks (0G Galileo's Conflux-scan fork, chain 16602) return the submit GUID in a
# field forge does not read, so its poll asks for `guid=undefined` and reports failure while the
# contract has ALREADY verified. Trusting that output under-reports the truth. This asks the explorer
# directly — the only authority — and prints one line per contract plus a verified/total tally.
#
# Usage: script/verify-status.sh <chainId>
set -uo pipefail
CHAIN_ID="${1:?usage: verify-status.sh <chainId>}"

case "$CHAIN_ID" in
  16602) API="${GALILEO_VERIFIER_URL:-https://chainscan-galileo.0g.ai/open/api}" ;;
  *) echo "verify-status: no explorer API mapped for chain ${CHAIN_ID}"; exit 1 ;;
esac

MANIFEST="deployments/${CHAIN_ID}.json"
[ -f "$MANIFEST" ] || { echo "verify-status: no ${MANIFEST}"; exit 1; }

python3 - "$MANIFEST" "$API" <<'PY'
import json, sys, urllib.parse, urllib.request
manifest, api = sys.argv[1], sys.argv[2]
seen, ok, total = set(), 0, 0
for e in json.load(open(manifest)):
    name, addr = e.get("name"), e.get("address")
    if not addr or addr.lower() in seen:
        continue
    seen.add(addr.lower()); total += 1
    q = urllib.parse.urlencode({"module": "contract", "action": "getsourcecode", "address": addr})
    try:
        with urllib.request.urlopen(f"{api}?{q}", timeout=20) as r:
            res = json.load(r).get("result") or [{}]
            got = (res[0] if isinstance(res, list) else res).get("ContractName") or ""
    except Exception as exc:
        got = f"(query failed: {exc})"
    mark = "OK  " if got and not got.startswith("(") else "--  "
    if mark == "OK  ": ok += 1
    print(f"  {mark}{name:<34} {addr}  {got}")
print(f"\n  {ok}/{total} source-verified on chain {manifest.split('/')[-1].split('.')[0]}")
PY
