#!/usr/bin/env bash
#
# deploy-web-box.sh — build the web app on this machine and ship it to the EC2 box
# that serves access0x1.click, with a canary, an image-engine guard and an armed
# rollback. This is the live path: access0x1.click moved off Cloud Run to the box
# on 2026-08-14, and the Cloud Run project's billing is closed, so deploy-web.sh
# can no longer ship (it stays for anyone deploying their own Cloud Run copy).
#
#   1. build     npm ci + next build (standalone) from a commit on origin/main;
#                NEXT_PUBLIC_* come from web/.env.local exactly as deploy-web.sh
#                reads them, and the same no-placeholder refusal applies
#   2. stage     standalone + .next/static + public; every .env* is stripped (server
#                config lives in the box's env file, never in a release); sharp is
#                RETARGETED to the box's linux-x64 engine (scripts/box/retarget-sharp.mjs)
#   3. upload    s3://$BOX_ARTIFACT_BUCKET/deploy/access0x1-web-<sha>.tgz, presigned 1 h
#   4. canary    SSM: unpack to /opt/access0x1/releases/<sha>, run scripts/box/check-sharp.cjs
#                AS THE UNIT'S USER (native engine + a WebP encode, or stop), boot a
#                transient unit on :$CANARY_PORT with the live env file, require
#                /api/health 200 with this commit, ok and store=postgres. Live untouched.
#   5. flip      SSM: symlink + BUILD_ID drop-in, restart, require health with this
#                commit AND /_next/image answering image/webp from the running
#                process; otherwise restore the prior release and report FLIP_ROLLED_BACK
#   6. prune     keep the newest $PRUNE_KEEP releases + live + rollback target (best effort)
#   7. verify    https://access0x1.click/api/health names this commit; auth probe
#
# WHY THE IMAGE ENGINE. `output: standalone` traces sharp's native binary from the
# BUILD machine. Built on an arm64 Mac, the release carried @img/sharp-darwin-arm64
# (plus @img/sharp-wasm32), which the box (Ubuntu x86_64, glibc) cannot load
# natively: /_next/image then serves full-size originals or 500s, silently
# (measured 2026-09-30 on release 1e56a84: "LOAD FAIL"). retarget-sharp.mjs and
# check-sharp.cjs are vendored verbatim from the upstream release tooling.
#
# Config (environment; nothing about the box is committed to this public repo):
#   BOX_INSTANCE_ID       EC2 instance id (required unless DRY_RUN=1)
#   BOX_ARTIFACT_BUCKET   S3 bucket the box can read via presigned URL (required unless DRY_RUN=1)
#   BOX_REGION            default us-east-1
#   CANARY_PORT           default 3105 (reserved for this app's canary on the box)
#   PRUNE_KEEP            default 3
#   DRY_RUN=1             build + stage + pack + print the plan; no upload, no SSM
#   RELEASE_PLATFORM      default linux-x64 (darwin-arm64 for a local smoke run)
#
# Usage:  BOX_INSTANCE_ID=i-... BOX_ARTIFACT_BUCKET=... make deploy-web-box
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SLOT=access0x1; PORT=3014; CANARY_PORT="${CANARY_PORT:-3105}"
ENV_FILE="/opt/$SLOT/shared/env"; REQUIRE_STORE="${REQUIRE_STORE:-postgres}"
REGION="${BOX_REGION:-us-east-1}"; DRY_RUN="${DRY_RUN:-0}"; PRUNE_KEEP="${PRUNE_KEEP:-3}"
DOMAIN="${DOMAIN:-https://access0x1.click}"; IMAGE_PROBE=/icon-512.png
say() { printf '\n== %s\n' "$*"; }
die() { echo "deploy-web-box: $*" >&2; exit 1; }

# ── 0. Refuse before spending a build ────────────────────────────────────────
if [[ "$DRY_RUN" != 1 ]]; then
  [[ -n "${BOX_INSTANCE_ID:-}" ]] || die "BOX_INSTANCE_ID is not set (the EC2 instance serving access0x1.click)"
  [[ "$BOX_INSTANCE_ID" =~ ^i-[0-9a-f]{8,17}$ ]] || die "BOX_INSTANCE_ID does not look like an instance id"
  [[ -n "${BOX_ARTIFACT_BUCKET:-}" ]] || die "BOX_ARTIFACT_BUCKET is not set"
  command -v aws >/dev/null 2>&1 || die "the AWS CLI is not installed"
fi
cd "$REPO_ROOT"
[[ -z "$(git status --porcelain -- web scripts)" ]] || die "web/ or scripts/ has uncommitted changes; a release must equal a commit"
git fetch --quiet origin main
if ! git merge-base --is-ancestor HEAD origin/main; then
  [[ "$DRY_RUN" == 1 ]] || die "HEAD is not on origin/main; merge first (what is live must be on main)"
  echo "deploy-web-box: DRY RUN of a commit not yet on origin/main"
fi
SHA="$(git rev-parse --short=7 HEAD)"
REL="/opt/$SLOT/releases/$SHA"; KEY="deploy/access0x1-web-$SHA.tgz"

# Same public build inputs, and the same refusals, as deploy-web.sh. Names only.
envval() { grep "^${1}=" web/.env.local 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r' | sed 's/[[:space:]]*#.*$//' || true; }
DYN="$(envval NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID)"
[[ "$DYN" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
  || die "NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID in web/.env.local is missing or not a UUID; sign-in would ship dead"
MISSING=""
for v in NEXT_PUBLIC_ROUTER_ARC NEXT_PUBLIC_USDC_ARC NEXT_PUBLIC_ROUTER_BASE_SEPOLIA NEXT_PUBLIC_USDC_BASE_SEPOLIA; do
  [[ -n "$(envval "$v")" ]] || MISSING="$MISSING $v"
done
[[ -z "$MISSING" ]] || die "live-chain embed addresses missing from web/.env.local:$MISSING (no placeholders in prod)"

TMP="$(mktemp -d -t access0x1-box.XXXXXX)"; trap 'rm -rf "$TMP"' EXIT
STAGE="$TMP/stage"; TARBALL="$TMP/web.tgz"

say "1/7 build $SHA"
( cd web && npm ci --no-audit --no-fund --loglevel=error && NEXT_PUBLIC_BUILD_COMMIT="$SHA" npm run build )
[[ -f web/.next/standalone/server.js ]] || die "no standalone server.js; next.config output must be standalone (flat, outputFileTracingRoot)"

say "2/7 stage"
mkdir -p "$STAGE/.next"
cp -R web/.next/standalone/. "$STAGE/"
cp -R web/.next/static "$STAGE/.next/static"
[[ -d web/public ]] && cp -R web/public "$STAGE/public"
# Server config comes from the box's env file. A .env* in the tree (Next copies
# them into standalone) would ship this machine's secrets and shadow the box's.
find "$STAGE" -maxdepth 3 -name '.env*' -not -path '*/node_modules/*' -exec rm -f {} +
LEFT="$(find "$STAGE" -maxdepth 3 -name '.env*' -not -path '*/node_modules/*')"
[[ -z "$LEFT" ]] || die "a .env file survived staging: $LEFT"
rm -rf "$STAGE/.next/cache"
printf '%s\n' "$(git rev-parse HEAD)" > "$STAGE/BUILD_SHA"
node scripts/box/retarget-sharp.mjs "$STAGE" "${RELEASE_PLATFORM:-linux-x64}"

say "3/7 pack"
( cd "$STAGE" && COPYFILE_DISABLE=1 tar -czf "$TARBALL" . )
ls -la "$TARBALL" | awk '{print "  " $5 " bytes"}'

if [[ "$DRY_RUN" == 1 ]]; then
  say "DRY RUN: would upload $KEY, stage $REL, canary :$CANARY_PORT, flip $SLOT :$PORT, prune to $PRUNE_KEEP"
  exit 0
fi

say "4/7 upload + presign"
aws sts get-caller-identity --query Arn --output text >/dev/null || die "no AWS identity"
aws s3 cp --region "$REGION" "$TARBALL" "s3://$BOX_ARTIFACT_BUCKET/$KEY" --only-show-errors
URL="$(aws s3 presign --region "$REGION" "s3://$BOX_ARTIFACT_BUCKET/$KEY" --expires-in 3600)"

ssm_run() { # $1 comment, $2 params-json-file -> stdout; dies unless Success
  local cid st=Pending
  cid="$(aws ssm send-command --region "$REGION" --instance-ids "$BOX_INSTANCE_ID" --document-name AWS-RunShellScript \
    --comment "$1" --parameters "file://$2" --query Command.CommandId --output text)"
  for _ in $(seq 1 150); do
    st="$(aws ssm get-command-invocation --region "$REGION" --command-id "$cid" --instance-id "$BOX_INSTANCE_ID" --query Status --output text 2>/dev/null || echo Pending)"
    case "$st" in Success|Failed|TimedOut|Cancelled) break ;; esac; sleep 3
  done
  aws ssm get-command-invocation --region "$REGION" --command-id "$cid" --instance-id "$BOX_INSTANCE_ID" --query StandardOutputContent --output text
  [[ "$st" == Success ]] || { aws ssm get-command-invocation --region "$REGION" --command-id "$cid" --instance-id "$BOX_INSTANCE_ID" \
    --query StandardErrorContent --output text | tail -20 >&2; return 1; }
}
cmds() { node scripts/box/ssm-commands.mjs "$1" "$2" > "$3"; }

say "5/7 stage + guard + canary on :$CANARY_PORT (live $SLOT untouched)"
cmds stage "$(printf '{"url":"%s","rel":"%s","slot":"%s","canaryPort":%s,"sha":"%s","envFile":"%s","requireStore":"%s","checkPath":"%s"}' \
  "$URL" "$REL" "$SLOT" "$CANARY_PORT" "$SHA" "$ENV_FILE" "$REQUIRE_STORE" "scripts/box/check-sharp.cjs")" "$TMP/stage.json"
OUT="$(ssm_run "access0x1 $SHA: stage + canary" "$TMP/stage.json" || true)"; echo "$OUT" | sed 's/^/  /'
echo "$OUT" | grep -q '^SHARP_OK ' || die "the release cannot load sharp's native engine on the box as the unit's user; aborting BEFORE the flip (live untouched)"
echo "$OUT" | grep -q '^CANARY_OK' || die "the canary did not serve $SHA healthy (store=$REQUIRE_STORE); aborting BEFORE the flip (live untouched)"

say "6/7 flip $SLOT -> $REL (rollback armed)"
cmds flip "$(printf '{"rel":"%s","slot":"%s","port":%s,"sha":"%s","imagePath":"%s"}' "$REL" "$SLOT" "$PORT" "$SHA" "$IMAGE_PROBE")" "$TMP/flip.json"
OUT="$(ssm_run "access0x1 $SHA: flip" "$TMP/flip.json" || true)"; echo "$OUT" | sed 's/^/  /'
echo "$OUT" | grep -q '^FLIP_OK' || die "flip failed; see above (FLIP_ROLLED_BACK means the prior release answers again)"
PRIOR="$(printf '%s\n' "$OUT" | sed -n 's/^PRIOR_RELEASE=//p' | head -1)"
[[ "$PRIOR" =~ ^/opt/$SLOT/releases/[0-9a-f]{7,40}$ ]] || PRIOR=NONE

say "7/7 prune (keep $PRUNE_KEEP newest + live + rollback target $PRIOR; best effort) and verify $DOMAIN"
cmds prune "$(printf '{"slot":"%s","keep":%s,"prior":"%s"}' "$SLOT" "$PRUNE_KEEP" "$PRIOR")" "$TMP/prune.json"
if POUT="$(ssm_run "access0x1 $SHA: prune" "$TMP/prune.json")"; then echo "$POUT" | sed 's/^/  /'
else echo "  PRUNE_FAILED: the release is live and healthy regardless; old releases were left in place"; fi

HEALTH="$(curl -sS --max-time 20 "$DOMAIN/api/health" || true)"
LIVE="$(printf '%s' "$HEALTH" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p')"
[[ "$LIVE" == "$SHA" ]] || die "$DOMAIN/api/health names '${LIVE:-nothing}', not $SHA (the box itself is healthy; check the proxy)"
echo "  public health: commit $LIVE"
AUTH="$(curl -sS --max-time 20 "$DOMAIN/api/branding?probe=auth" || true)"
if printf '%s' "$AUTH" | grep -q '"writesBlockedByServerConfig":false'; then echo "  auth OK: merchant writes will save"
else echo "  WARNING: writes blocked by server config: ${AUTH:0:200}"; fi
say "DONE: $DOMAIN serves $SHA from $REL; rollback target $PRIOR"
