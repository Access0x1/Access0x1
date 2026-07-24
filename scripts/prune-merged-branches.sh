#!/usr/bin/env bash
#
# prune-merged-branches.sh — delete remote branches whose PRs are already MERGED.
#
# Every branch below was confirmed MERGED via the GitHub PR API (its work is in
# main); deleting the branch loses nothing. Structural / ongoing branches (main,
# dev, staging, business-journey), open-PR branches (the feat/* set, the 9 open
# dependabot PRs), and the unified work branch are deliberately NOT listed.
#
# Generated during the Lisbon 0G consolidation. Re-run is safe: an already-deleted
# branch just reports "remote ref does not exist".
#
# Usage:  bash scripts/prune-merged-branches.sh          # delete them
#         DRY_RUN=1 bash scripts/prune-merged-branches.sh # just print
set -euo pipefail

BRANCHES=(
  dependabot/github_actions/actions-minor-patch-01ea2139b9
  dependabot/github_actions/actions/cache-6.1.0
  dependabot/github_actions/actions/checkout-7.0.0
  dependabot/github_actions/actions/setup-node-6.4.0
  dependabot/npm_and_yarn/packages/react/multi-b0dfc253ff
  dependabot/npm_and_yarn/packages/react/react-dom-19.2.7
  dependabot/npm_and_yarn/packages/react/react-minor-patch-af8e04dbc1
  dependabot/npm_and_yarn/packages/react/typescript-6.0.3
  dependabot/npm_and_yarn/snap/snap-minor-patch-638b37306a
  dependabot/npm_and_yarn/snap/typescript-6.0.3
  dependabot/npm_and_yarn/snap/vitest-4.1.9
  dependabot/npm_and_yarn/subgraph/subgraph-minor-patch-b1622deb06
  dependabot/npm_and_yarn/web/next-16.2.9
  dependabot/npm_and_yarn/web/types/node-26.0.1
  dependabot/npm_and_yarn/web/typescript-6.0.3
  dependabot/npm_and_yarn/web/vitest-4.1.9
  dependabot/npm_and_yarn/web/web-minor-patch-2e0ae46299
  fable-brand/plug-mark-sync
  fable/agent-meter-atomic-cap
  fable/agentgate-honest-scope
  fable/attach-onchain-merchant-guard
  fable/branding-require-verified-writes
  fable/branding-store-sanitize-logo
  fable/branding-write-gate-all-routes
  fable/broadcast-mirror-records
  fable/checkout-amount-display-parity
  fable/checkout-exact-amount-format
  fable/checkout-name-param-sanitize
  fable/deps-ws-override
  fable/design-sync-durable
  fable/drop-legacy-sync-meter
  fable/ens-agent-binding
  fable/ens-subname-auth-gate
  fable/ens-verify-hardening
  fable/lanes-commingling-fix
  fable/oidc-route-caller-bind
  fable/opsec-scrub-visible-words
  fable/payout-owner-authorization
  fable/receivables-cancel-holder-guard
  fable/receivables-fee-snapshot
  fable/sanitize-cf-category
  fable/sanitize-invisible-unicode
  fable/strip-nul-durablekv-test
  fable/subscribe-intent-binding
  fable/svg-sanitize-control-bytes
  fable/svg-sanitizer-linear
  fable/svg-strip-del-c1
  fable/verify-bind-onchain-world
  fable/verify-dynamic-require-verified
)

git fetch --prune origin >/dev/null 2>&1 || true
for b in "${BRANCHES[@]}"; do
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    echo "would delete: $b"
  else
    echo "deleting: $b"
    git push origin --delete "$b" || echo "  (skip: $b — already gone or protected)"
  fi
done
echo "done: ${#BRANCHES[@]} merged branches processed."
