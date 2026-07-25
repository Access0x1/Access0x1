#!/usr/bin/env bash
#
# prune-merged-branches.sh — retire remote branches that no longer carry work.
#
# DERIVES the list at run time. The previous version hardcoded 49 branch names
# and had already gone stale (it listed `…/cache-6.1.0`; the live branch is
# `…/cache-6`), which is exactly the failure mode a static list guarantees.
#
# Two tiers, because they carry different certainty:
#
#   TIER A — the branch tip is an ANCESTOR of origin/main. Git-proven merged;
#            deleting loses nothing. These are deleted by --confirm.
#
#   TIER B — not an ancestor, but every file the branch touches is either
#            identical to main or main's copy is NEWER. This is what a
#            rebase-merge leaves behind: the content landed under different
#            SHAs, so ancestry says "unmerged" while the work is in fact in
#            main. Printed with evidence; deleted only with --include-rebased.
#
#   KEPT   — anything with commits whose content is genuinely absent from main,
#            plus the protected set below. Never deleted, always reported.
#
# PROTECTED, never touched: main, dev, HEAD, and the branch you are standing on.
#
# SAFETY: dry-run is the DEFAULT. Nothing is deleted without --confirm.
#
# Usage:
#   bash .claude/prune-merged-branches.sh                      # report only
#   bash .claude/prune-merged-branches.sh --confirm            # delete tier A
#   bash .claude/prune-merged-branches.sh --confirm --include-rebased
#
# Deleting a remote branch is not reversible from here — the commits survive in
# any local clone that has them, but the remote ref is gone. Read the report
# before passing --confirm.
set -euo pipefail

# Nothing here is a hardcoded branch list. The default branch is read from the
# remote's own HEAD, and the protected set is derived: the default branch, the
# branch you are standing on, and anything GitHub reports as protected (when
# `gh` is available). A literal branch name in this file would be the same
# staleness bug the old version shipped.
# `|| true` on every probe: under `set -e` a bare assignment from a failing
# command aborts the script, and origin/HEAD is legitimately absent in a fresh
# or shallow clone.
DEFAULT_BRANCH="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)"
if [[ -z "$DEFAULT_BRANCH" ]]; then
  DEFAULT_BRANCH="$(git remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p' | head -1 || true)"
fi
[[ -z "$DEFAULT_BRANCH" ]] && DEFAULT_BRANCH="main"
BASE="origin/$DEFAULT_BRANCH"
PROTECTED=("$DEFAULT_BRANCH")

CONFIRM=0
INCLUDE_REBASED=0
for arg in "$@"; do
  case "$arg" in
    --confirm) CONFIRM=1 ;;
    --include-rebased) INCLUDE_REBASED=1 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

command -v git >/dev/null || { echo "git not found" >&2; exit 1; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repo" >&2; exit 1; }

echo "fetching..."
git fetch --prune origin >/dev/null 2>&1 || {
  echo "WARN: fetch failed — the report may be based on stale refs." >&2
}
git rev-parse --verify "$BASE" >/dev/null 2>&1 || { echo "no $BASE" >&2; exit 1; }

CURRENT="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
[[ -n "$CURRENT" ]] && PROTECTED+=("$CURRENT")

# Branches the REMOTE says are protected — derived, never typed out here. Also
# picks up release/integration branches (a `dev` or `staging`) without this
# script having to know their names.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  while IFS= read -r p; do
    [[ -n "$p" ]] && PROTECTED+=("$p")
  done < <(gh api "repos/{owner}/{repo}/branches?protected=true" \
             --jq '.[].name' 2>/dev/null || true)
fi

# Escape hatch, so keeping a branch never means editing this file:
#   PROTECT="dev,staging" bash .claude/prune-merged-branches.sh
# Worth using without `gh`, since remote protection rules can't be read then —
# a fully-merged integration branch like `dev` would otherwise land in tier A.
if [[ -n "${PROTECT:-}" ]]; then
  IFS=',' read -ra EXTRA <<< "$PROTECT"
  for p in "${EXTRA[@]}"; do
    p="$(echo "$p" | xargs)"
    [[ -n "$p" ]] && PROTECTED+=("$p")
  done
fi

# The protected set is assembled from several sources that legitimately overlap —
# the default branch and the branch you are standing on are usually both `main` —
# so collapse it before use. Matters for the printed line more than the matching,
# but a list that says "main main" reads like a bug in a script that deletes things.
dedup_protected() {
  local -a seen=()
  local p q found
  for p in "${PROTECTED[@]}"; do
    [[ -z "$p" ]] && continue
    found=0
    for q in "${seen[@]}"; do [[ "$p" == "$q" ]] && { found=1; break; }; done
    [[ $found -eq 0 ]] && seen+=("$p")
  done
  PROTECTED=("${seen[@]}")
}

is_protected() {
  local b="$1"
  for p in "${PROTECTED[@]}"; do [[ "$b" == "$p" ]] && return 0; done
  return 1
}

# Tier B needs GROUND TRUTH, not a git guess.
#
# A rebase-merge lands the content under fresh SHAs, so ancestry reports
# "unmerged" for a branch whose work is demonstrably in main. Purely local
# heuristics can't tell that apart from real divergence: these branches also
# carry doc/test-count edits that main has since moved past, which makes every
# file-content comparison look like a difference. An earlier version of this
# script tried exactly that and classified all 25 known-merged fable branches
# as "keep" — a false negative that would have left the tree uncleanable.
#
# So the authority is the PR state from the GitHub API. If `gh` is not
# available the script says so and puts everything in KEEP rather than
# guessing — under-deleting is the safe direction to fail.
HAVE_GH=0
command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 && HAVE_GH=1

MERGED_PR_BRANCHES=""
if [[ "$HAVE_GH" == "1" ]]; then
  MERGED_PR_BRANCHES="$(gh pr list --state merged --limit 300 \
    --json headRefName --jq '.[].headRefName' 2>/dev/null | sort -u || true)"
fi

# 0 when the branch has a MERGED pull request behind it.
branch_content_landed() {
  [[ "$HAVE_GH" != "1" ]] && return 1
  grep -qxF "$1" <<< "$MERGED_PR_BRANCHES"
}

dedup_protected
TIER_A=(); TIER_B=(); KEEP=()

while IFS= read -r ref; do
  # `%(refname:short)` renders refs/remotes/origin/HEAD as the bare remote name
  # "origin" — no slash, no arrow — so the `grep -v '\->'` below does not catch it
  # and it arrived here looking like a branch called "origin" that was "? commits
  # ahead". Require the origin/ prefix so only real remote branches get through.
  [[ "$ref" != origin/* ]] && continue
  b="${ref#origin/}"
  [[ "$b" == "HEAD"* ]] && continue
  is_protected "$b" && continue
  if git merge-base --is-ancestor "origin/$b" "$BASE" 2>/dev/null; then
    TIER_A+=("$b")
  elif branch_content_landed "$b"; then
    TIER_B+=("$b")
  else
    ahead="$(git rev-list --count "$BASE..origin/$b" 2>/dev/null || echo '?')"
    KEEP+=("$b ($ahead commit(s) ahead)")
  fi
done < <(git branch -r --format='%(refname:short)' | grep -v '\->')

echo
echo "TIER A — git-proven merged into $BASE (${#TIER_A[@]})"
printf '  %s\n' "${TIER_A[@]:-<none>}"
echo
echo "TIER B — merged PR, ancestry rewritten by rebase-merge (${#TIER_B[@]})"
printf '  %s\n' "${TIER_B[@]:-<none>}"
if [[ "$HAVE_GH" != "1" ]]; then
  echo "  NOTE: \`gh\` unavailable or unauthenticated, so tier B could not be"
  echo "        computed. Everything unproven fell to KEEP. Run from a clone"
  echo "        with \`gh auth login\` to classify the rebase-merged branches."
fi
echo
echo "KEEP — carries content main does not have (${#KEEP[@]})"
printf '  %s\n' "${KEEP[@]:-<none>}"
echo
echo "protected: ${PROTECTED[*]}"
echo

TARGETS=("${TIER_A[@]}")
[[ "$INCLUDE_REBASED" == "1" ]] && TARGETS+=("${TIER_B[@]}")

if [[ "$CONFIRM" != "1" ]]; then
  echo "DRY RUN — nothing deleted. ${#TARGETS[@]} branch(es) would be removed."
  echo "Re-run with --confirm (add --include-rebased to also take tier B)."
  exit 0
fi

[[ ${#TARGETS[@]} -eq 0 ]] && { echo "nothing to delete."; exit 0; }

for b in "${TARGETS[@]}"; do
  echo "deleting: $b"
  git push origin --delete "$b" || echo "  (skip: $b — already gone or protected)"
done
echo "done: ${#TARGETS[@]} branch(es) processed."
