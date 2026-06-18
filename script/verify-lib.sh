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
