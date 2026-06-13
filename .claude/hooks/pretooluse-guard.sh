#!/usr/bin/env bash
# PreToolUse(Bash) guard for Access0x1. Exit 2 = block the tool call.
# Enforces git-workflow.md + security.md so the laws hold by harness, not goodwill.
set -euo pipefail
input="$(cat)"
cmd="$(printf '%s' "$input" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null || printf '%s' "$input")"

SECRET_RE='sk-ant-[A-Za-z0-9_-]{20}|sk-[A-Za-z0-9]{20}|ghp_[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}|PRIVATE_KEY=0x?[0-9a-fA-F]{40,}|--private-key[= ]0x?[0-9a-fA-F]{64}|MNEMONIC=[^[:space:]"'"'"']{8,}'

is_commit=false
printf '%s' "$cmd" | grep -qE '(^|&&|;|\|)[[:space:]]*git[[:space:]]+commit' && is_commit=true
is_merge=false
printf '%s' "$cmd" | grep -qE '(^|&&|;|\|)[[:space:]]*git[[:space:]]+merge' && is_merge=true

# 1) never bypass hooks (long and short form)
if printf '%s' "$cmd" | grep -qE 'git[[:space:]]+commit[^|;&]*(--no-verify|[[:space:]]-n([[:space:]]|$))'; then
  echo "BLOCKED: 'git commit --no-verify' (and -n) is forbidden — commit only on green (git-workflow.md)." >&2
  exit 2
fi

# 2) the no-backticks / no -m law: messages go through a tmpfile (-F), always
if $is_commit && printf '%s' "$cmd" | grep -qE 'git[[:space:]]+commit[^|;&]*([[:space:]]-m([[:space:]]|$)|--message|`)'; then
  echo "BLOCKED: commit messages go via tmpfile only — printf '%s\\n' '<msg>' > /tmp/cw && git commit -F /tmp/cw (no -m, no backticks; git-workflow.md)." >&2
  exit 2
fi

# 3) secrets must never enter a command (incl. forge --private-key 0x<64hex>)
if printf '%s' "$cmd" | grep -qE "$SECRET_RE"; then
  echo "BLOCKED: looks like a secret (API/private key/mnemonic) in the command. Use env + 'cast wallet' keystore (security.md)." >&2
  exit 2
fi

# 4) no force-push, anywhere (law #6)
if printf '%s' "$cmd" | grep -qE 'git[[:space:]]+push[^|;&]*([[:space:]]--force(-with-lease)?([[:space:]]|$|=)|[[:space:]]-f([[:space:]]|$))'; then
  echo "BLOCKED: force-push is forbidden everywhere, main or branches (law #6)." >&2
  exit 2
fi

# 5) commit-time checks (the branch law + leak scan + dump heuristic + green gate)
if $is_commit || $is_merge; then
  # 5a) feature work happens on feat/* branches, never main (post-bootstrap:
  #     bootstrap commits land before any src/*.sol exists, so they pass)
  if $is_commit && [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ] \
     && ls src/*.sol >/dev/null 2>&1; then
    echo "BLOCKED: feature commits go on a feat/* branch — git switch -c feat/<unit>, then PR; the owner merges (git-workflow.md)." >&2
    exit 2
  fi
  # 5b) file-borne secret leak scan: staged + working-tree + untracked
  if git rev-parse --git-dir >/dev/null 2>&1; then
    if { git diff HEAD 2>/dev/null || git diff --cached 2>/dev/null; } | grep -qE "$SECRET_RE"; then
      echo "BLOCKED: a secret pattern is present in the changes about to be committed. Remove it (security.md); never bypass." >&2
      exit 2
    fi
    if git ls-files --others --exclude-standard 2>/dev/null | head -50 | xargs -r grep -lE "$SECRET_RE" 2>/dev/null | grep -q .; then
      echo "BLOCKED: a secret pattern is present in an untracked file about to be added. Remove it (security.md)." >&2
      exit 2
    fi
  fi
  # 5c) skeleton-dump heuristic (law #1/#7): a feature commit touching >12 files
  if $is_commit && ls src/*.sol >/dev/null 2>&1; then
    if printf '%s' "$cmd" | grep -qE 'git[[:space:]]+add[[:space:]]+(-A|--all|\.)'; then
      n="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    else
      n="$(git diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')"
    fi
    if [ "${n:-0}" -gt 12 ]; then
      echo "BLOCKED: $n files in one commit looks like a batch/skeleton dump — ONE idea per commit (law #1). Split it." >&2
      exit 2
    fi
  fi
  # 5d) green gate before ANY commit or local merge (testing.md, law #4)
  if [ -f foundry.toml ]; then
    if ! forge build >/dev/null 2>&1; then echo "BLOCKED: forge build failed — fix before commit/merge." >&2; exit 2; fi
    if ! forge test  >/dev/null 2>&1; then echo "BLOCKED: forge test failed — green every step (law #4)." >&2; exit 2; fi
    if ! forge fmt --check >/dev/null 2>&1; then echo "BLOCKED: forge fmt --check failed — run 'forge fmt' first (testing.md)." >&2; exit 2; fi
  fi
fi
exit 0
