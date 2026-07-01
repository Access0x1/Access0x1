#!/usr/bin/env bash
#
# opsec-scan.sh — OPSEC gate for the PUBLIC Access0x1 repo.
#
# This repo is open-source. Its threat model: never publish a personal identity,
# an internal/private brand name, or a hardcoded secret. This script greps the
# TRACKED tree for those patterns and exits non-zero on any hit, so CI can block
# a PR before a leak is published.
#
# Scope of the scan:
#   * Only TRACKED, regular files (via `git ls-files`), so untracked scratch
#     files and gitignored node_modules are never scanned.
#   * Submodule gitlinks (lib/forge-std, lib/openzeppelin-*) are EXCLUDED — they
#     are third-party checkouts, not our content, and grepping a gitlink path
#     errors ("Is a directory").
#
# It does NOT scan git history/authorship — a past personal-email or real-name
# leak in commit authorship cannot be fixed without rewriting history, which is
# forbidden here (no force-push). This gate is purely forward-looking: it stops
# the NEXT leak from entering file content.
#
# Self-exclusion: this script and the workflow that runs it necessarily CONTAIN
# the very patterns they hunt for, so both are excluded from the scan.
#
# Exit codes: 0 = clean, 1 = at least one finding, 2 = usage/environment error.

set -euo pipefail

# Resolve the repo root so the script works from any CWD.
if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "opsec-scan: not inside a git repository" >&2
  exit 2
fi
cd "$REPO_ROOT"

# Files that legitimately contain the patterns (this scanner + its workflow) and
# must never be flagged. Matched as exact tracked paths.
SELF_EXCLUDE=(
  "scripts/opsec-scan.sh"
  ".github/workflows/opsec.yml"
)

is_excluded() {
  local f="$1" ex
  for ex in "${SELF_EXCLUDE[@]}"; do
    [[ "$f" == "$ex" ]] && return 0
  done
  return 1
}

# Build the scan set: tracked regular files only. `git ls-files -s` prints the
# mode in field 1; mode 160000 is a submodule gitlink — drop those. Everything
# else is a real blob we own. NUL-delimited throughout for path safety.
FILES=()
while IFS= read -r -d '' line; do
  # line = "<mode> <sha> <stage>\t<path>"
  mode="${line%% *}"
  path="${line#*$'\t'}"
  [[ "$mode" == "160000" ]] && continue   # submodule gitlink
  is_excluded "$path" && continue
  FILES+=("$path")
done < <(git ls-files -s -z)

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "opsec-scan: no tracked files to scan" >&2
  exit 2
fi

# run_grep LABEL REGEX [PATH_EXCLUDE_REGEX]
# Greps the scan set for REGEX. Optional PATH_EXCLUDE_REGEX drops matches whose
# file path matches it (used to spare legitimate on-chain proofs / test fixtures
# from the broad hex pattern). Prints findings to stderr; returns 0 if any
# finding remained, 1 if clean. Distinguishes grep's real errors (exit >=2) from
# "no match" (exit 1) so a broken scan can never masquerade as a pass.
run_grep() {
  local label="$1" regex="$2" path_exclude="${3:-}"
  local out rc
  # -I skips binary files, -n line numbers, -H filename, -E extended regex.
  set +e
  out="$(grep -IHnE "$regex" "${FILES[@]}" 2>/dev/null)"
  rc=$?
  set -e
  if [[ "$rc" -ge 2 ]]; then
    echo "opsec-scan: grep failed (exit $rc) while scanning for [$label] — treating as FAIL." >&2
    return 0
  fi
  [[ -z "$out" ]] && return 1
  if [[ -n "$path_exclude" ]]; then
    out="$(printf '%s\n' "$out" | grep -vE "^($path_exclude):" || true)"
  fi
  [[ -z "$out" ]] && return 1
  echo "OPSEC FAIL [$label]:" >&2
  printf '%s\n' "$out" >&2
  echo >&2
  return 0
}

findings=0

# --- Internal/private brands that must never appear in this public repo. -------
# "Rensley" and "Access0x1" are the allowed public identities and are NOT scanned.
run_grep "internal-brand" \
  '(githat|sebastn|clickreserv|quantl|colmado)' \
  && findings=$((findings + 1))

# --- Hardcoded secret literals. -----------------------------------------------
run_grep "stripe-secret-key" \
  'sk_(live|test)_[0-9A-Za-z]{16,}' \
  && findings=$((findings + 1))

run_grep "stripe-webhook-secret" \
  'whsec_[0-9A-Za-z]{16,}' \
  && findings=$((findings + 1))

# A 64-hex bound to a private-key/mnemonic-named identifier is the shape of a
# real leaked key. A BARE 64-hex is NOT scanned as a secret here: this repo is
# full of legitimate 64-hex (tx hashes + contract bytecode in broadcast/ deploy
# proofs, session-id and placeholder fixtures in tests), so a bare pattern would
# be all false positives. We require the secret-name context instead.
run_grep "private-key-literal" \
  '(PRIVATE_KEY|private_?key|secret_?key|mnemonic|seed_?phrase)[^0-9a-fA-F]{1,40}0x[0-9a-fA-F]{64}' \
  && findings=$((findings + 1))

if [[ "$findings" -gt 0 ]]; then
  echo "opsec-scan: $findings pattern group(s) matched — refusing to pass." >&2
  echo "If a hit is a false positive, tighten the pattern or add a scoped exclusion." >&2
  exit 1
fi

echo "opsec-scan: clean — no personal identity, internal brand, or hardcoded secret found in ${#FILES[@]} tracked files."
exit 0
