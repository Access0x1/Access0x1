#!/usr/bin/env bash
#
# verify-lib.sh — shared helpers for the verify-* scripts. SOURCED, never executed directly.
#
# Its reason to exist: turn the verify-* scripts from "verify this repo's src/-rooted contracts" into a
# UNIVERSAL verifier — one that resolves a deployed contract's real source location from the Foundry
# BUILD ARTIFACT instead of assuming `src/<Name>.sol`. That assumption silently breaks on anything not
# at the src/ root: a nested library (`src/libraries/OracleLib.sol`), a test/mock the deploy actually
# broadcasts (the Arc `$1` USDC/USD `MockV3Aggregator` lives at `test/mocks/`), or any external
# project's tree. Resolving from `out/` makes the same scripts verify ANY contract on ANY layout.
#
# Single source of truth for that resolution (DRY): the three verifiers (etherscan / blockscout /
# sourcify) all call `resolve_target` rather than each hard-coding the path. CWD is assumed to be the
# repo root (the Makefile invokes the verifiers from there), so the relative `out/` / `src/` lookups
# below resolve against the project being verified.

# resolve_target <contractName> — echo the fully-qualified Foundry target "<sourcePath>:<Name>" for a
# deployed contract, resolved from its build artifact so verification is independent of where the
# source physically lives.
#
# Resolution order (each step strictly more general than the legacy `src/<Name>.sol:<Name>` guess, and
# every step falls through on miss so a contract that verified before NEVER regresses):
#   1. The build artifact `out/*.sol/<Name>.json` → its `metadata.settings.compilationTarget` key is the
#      exact source path the compiler used (covers src/, src/libraries/, test/mocks/, nested, external).
#   2. `src/<Name>.sol` on disk → the conventional top-level case (artifact absent, e.g. `out/` cleaned).
#   3. The bare `<Name>` → forge resolves it from the artifacts itself (its own fallback).
resolve_target() {
  local name="$1" art src
  # 1. From the build artifact's recorded compilation target — the authoritative source path.
  art=$(ls out/*.sol/"${name}".json 2>/dev/null | head -1)
  if [ -n "$art" ]; then
    src=$(jq -r '.metadata.settings.compilationTarget | to_entries[0].key // empty' "$art" 2>/dev/null)
    if [ -n "$src" ]; then
      printf '%s:%s\n' "$src" "$name"
      return 0
    fi
  fi
  # 2. The conventional top-level case, when no artifact is present to read.
  if [ -f "src/${name}.sol" ]; then
    printf 'src/%s.sol:%s\n' "$name" "$name"
    return 0
  fi
  # 3. Last resort: hand forge the bare name and let it resolve from out/ (errors loudly if ambiguous).
  printf '%s\n' "$name"
}

# verify_with_retry <maxAttempts> <forge verify-contract args...> — run `forge verify-contract`, retrying
# the WHOLE invocation when the explorer's HTTP gateway flakes on the initial SUBMISSION (a 504/503/502
# "Gateway Time-out", connection reset, "Failed to submit", or response-deserialize error). forge's own
# --retries/--delay only re-polls the verification STATUS *after* a successful submit, so a 504 on the
# submit itself slips straight through to a hard FAIL — that is the flakiness this closes.
#
# Safe to retry: verification is idempotent (an already-verified contract returns success immediately, so
# a retry never double-submits) and sends no transaction. Retries fire ONLY on transient-gateway patterns
# — a genuine verification error (source mismatch, bad constructor args) fails fast on the first attempt,
# unretried. Backoff grows linearly (10s, 20s, …) to give an overloaded testnet explorer room to recover.
# Output is streamed live (tee) so the caller still sees forge's progress while it is captured for the
# transient-vs-genuine pattern match.
verify_with_retry() {
  local max="$1"; shift
  local attempt=0 rc log
  log=$(mktemp "${TMPDIR:-/tmp}/verify.XXXXXX")
  while :; do
    attempt=$((attempt + 1))
    forge verify-contract "$@" 2>&1 | tee "$log"
    rc=${PIPESTATUS[0]}
    if [ "$rc" -eq 0 ]; then rm -f "$log"; return 0; fi
    # Stop on the last attempt, or when the failure is NOT a transient gateway/network hiccup.
    if [ "$attempt" -ge "$max" ] || ! grep -qiE \
        '50[234]|gateway time-?out|timed? out|failed to submit|connection (reset|refused|closed)|deserialize|temporarily|try again' "$log"; then
      rm -f "$log"
      return "$rc"
    fi
    echo "    transient explorer/gateway error — retry $((attempt + 1))/${max} after $((attempt * 10))s backoff" >&2
    sleep $((attempt * 10))
  done
}

# enumerate_deployed <broadcastPath> <chainId> — emit one "ContractName Address" row per verifiable
# deployed contract on this chain. The SINGLE source of the contract list for all three verifiers (DRY).
#
# Source order:
#   1. deployments/<chainId>.json — the manifest DeployAll writes (a JSON array of {name,address}).
#      Deploy-path-independent + logical; preferred when present.
#   2. The broadcast — read BOTH top-level CREATEs (the legacy direct-deploy shape) AND, crucially,
#      `.transactions[].additionalContracts[]` CREATEs (the CreateX CREATE3 shape: every contract is
#      created INSIDE a factory CALL, so it appears ONLY here, never as a top-level CREATE — this is the
#      bug the old `.transactions[] | select(.transactionType=="CREATE")` filter missed, matching 0).
#      CreateX's internal CREATE2 minimal-proxy shims carry no contractName and are skipped.
# Both sources yield the same rows: 12 impls (by real name) + 12 "ERC1967Proxy" proxies (+ optional
# Access0x1Receiver / mocks). Returns non-zero only when NEITHER source exists.
enumerate_deployed() {
  local bcast="$1" chainid="$2"
  local manifest="deployments/${chainid}.json"
  if [ -f "$manifest" ]; then
    jq -r '.[] | "\(.name) \(.address)"' "$manifest"
    return 0
  fi
  [ -f "$bcast" ] || return 1
  jq -r '
    ( [ .transactions[]
        | select(.transactionType == "CREATE" and .contractName != null)
        | { n: .contractName, a: .contractAddress } ]
    + [ .transactions[].additionalContracts[]?
        | select(.transactionType == "CREATE" and .contractName != null)
        | { n: .contractName, a: .address } ]
    ) | .[] | "\(.n) \(.a)"
  ' "$bcast"
}
