#!/usr/bin/env bash
#
# deploy-web.sh — build and ship the web app to Cloud Run, in one command.
#
# WHY THIS EXISTS. Deploying was six commands with three traps, and every one of them
# was hit on the first real attempt:
#
#   1. `git pull` aborted on a local README change (the test-count badge `make sync`
#      rewrites), so the build ran against STALE CODE and nobody noticed until the
#      deployed app still 404'd on a route that had been merged hours earlier.
#   2. `cloudbuild.yaml` only BUILDS and pushes an image. It does not deploy. A green
#      build reads like a finished deploy and changes nothing about the live site.
#   3. `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` was passed as a build ARG only. Next inlines
#      those into the browser bundle at build time, but the SERVER reads process.env at
#      RUNTIME — so sign-in worked perfectly and every write was rejected with "a
#      verified sign-in is required", to a person who was signed in.
#
# This does all three in order, refuses to build stale code, and verifies afterwards
# that the thing now serving is the thing that was just built.
#
# Usage:
#   DYN_ENV=<dynamic-environment-id> bash scripts/deploy-web.sh
#   DYN_ENV=... DEFAULT_CHAIN_ID=84532 bash scripts/deploy-web.sh
#
set -euo pipefail

SERVICE="${SERVICE:-access0x1}"
REGION="${REGION:-us-central1}"
DEFAULT_CHAIN_ID="${DEFAULT_CHAIN_ID:-11155111}"
DOMAIN="${DOMAIN:-https://access0x1.click}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v gcloud >/dev/null 2>&1 || {
  echo "deploy-web: gcloud is not installed. This has to run from a machine with the"
  echo "  Google Cloud CLI authenticated against the project."
  exit 1
}

if [[ -z "${DYN_ENV:-}" ]]; then
  echo "deploy-web: set DYN_ENV to the Dynamic environment id."
  echo "  Find it with:  grep NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID web/.env.local"
  echo "  Then:          DYN_ENV=<id> bash scripts/deploy-web.sh"
  exit 1
fi

cd "$REPO_ROOT"

# ── 1. Never build stale code ────────────────────────────────────────────────
# The generated files (README badge, docs corpus) are the usual cause of a blocked
# pull, and they are regenerable — so discarding them is safe and beats aborting.
echo "==> syncing with origin/main"
git fetch --quiet origin main
if ! git diff --quiet || ! git diff --quiet --cached; then
  echo "    local changes present; stashing them (restored at the end)"
  git stash push --quiet --include-untracked -m "deploy-web autostash" || true
  STASHED=1
fi
git merge --ff-only origin/main >/dev/null 2>&1 || {
  echo "deploy-web: cannot fast-forward to origin/main — your branch has diverged."
  echo "  Resolve it by hand; refusing to build something that is neither."
  [[ "${STASHED:-0}" == "1" ]] && git stash pop --quiet || true
  exit 1
}

PROJ="$(gcloud config get-value project 2>/dev/null)"
TAG="$(git rev-parse --short HEAD)"
IMAGE="${REGION}-docker.pkg.dev/${PROJ}/access0x1/web:${TAG}"
echo "    project=${PROJ}  commit=${TAG}"

cd "$REPO_ROOT/web"

# ── 2. Derive EVERY configured integration's env from the registry ───────────
# The deploy used to wire only Dynamic; every other sponsor key sat in .env.local
# and never reached the running service. This reads the registry + .env.local and
# writes a Cloud Run env-vars file covering all of them — Walrus, 0G, Namestone,
# Unlink, Claude, World's signing key, the agent config, and whatever is added to
# the registry next. It prints a NAMES-ONLY summary so you can see the full list
# and fill any blanks with `npm run env:set` before shipping.
WORK="$(mktemp -d -t access0x1-deploy.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
RUNTIME_ENV="$WORK/runtime.yaml"
SECRETS_DIR="$WORK/secrets"
npx tsx scripts/doctor/deploy-env.mjs --runtime-out "$RUNTIME_ENV" --secrets-dir "$SECRETS_DIR"
# These two must exist at runtime regardless of what .env.local held: the commit so
# /api/health can name the live build, and the Dynamic env id so the server can
# verify a sign-in (the whole "verified login" bug). Appended, so they win. Both are
# public, so they belong in the plain env file, not Secret Manager.
{
  echo "NEXT_PUBLIC_BUILD_COMMIT: '${TAG}'"
  [[ -n "${DYN_ENV:-}" ]] && echo "NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID: '${DYN_ENV}'"
} >> "$RUNTIME_ENV"

# ── 2b. Real credentials → Secret Manager, NOT plaintext env config ──────────
# Going-live discipline (DEPLOY-GCP.md §2): a secret lives vaulted, versioned and
# access-controlled — never in the service's env config where any project viewer
# reads it. Flipping a flag convinces nobody; vaulting the secret is what makes the
# difference real. Each secret is created (or a new version added) from a 0600 file,
# never from argv, then referenced by name at deploy time.
SET_SECRETS=""
if [[ -s "$SECRETS_DIR/manifest.txt" ]]; then
  echo "==> vaulting $(wc -l < "$SECRETS_DIR/manifest.txt" | tr -d ' ') secret(s) in Secret Manager"
  # The runtime service account that must be allowed to READ them. On an existing
  # service, its configured SA; otherwise the project's default compute SA.
  RUNTIME_SA="$(gcloud run services describe "$SERVICE" --region "$REGION" \
    --format='value(spec.template.spec.serviceAccountName)' 2>/dev/null || true)"
  if [[ -z "$RUNTIME_SA" ]]; then
    PROJ_NUM="$(gcloud projects describe "$PROJ" --format='value(projectNumber)' 2>/dev/null || true)"
    [[ -n "$PROJ_NUM" ]] && RUNTIME_SA="${PROJ_NUM}-compute@developer.gserviceaccount.com"
  fi
  while read -r ENV_VAR SECRET_NAME; do
    [[ -z "$ENV_VAR" ]] && continue
    if gcloud secrets describe "$SECRET_NAME" --project "$PROJ" >/dev/null 2>&1; then
      gcloud secrets versions add "$SECRET_NAME" --project "$PROJ" \
        --data-file="$SECRETS_DIR/val__$ENV_VAR" >/dev/null
    else
      gcloud secrets create "$SECRET_NAME" --project "$PROJ" \
        --replication-policy=automatic --data-file="$SECRETS_DIR/val__$ENV_VAR" >/dev/null
    fi
    # Let the runtime SA read this secret (idempotent).
    if [[ -n "$RUNTIME_SA" ]]; then
      gcloud secrets add-iam-policy-binding "$SECRET_NAME" --project "$PROJ" \
        --member="serviceAccount:${RUNTIME_SA}" \
        --role="roles/secretmanager.secretAccessor" >/dev/null 2>&1 || true
    fi
    SET_SECRETS="${SET_SECRETS:+$SET_SECRETS,}${ENV_VAR}=${SECRET_NAME}:latest"
  done < "$SECRETS_DIR/manifest.txt"
fi

# ── 3. Build the image ───────────────────────────────────────────────────────
# Public NEXT_PUBLIC_* vars are inlined at build from .env.local (copied into the
# context) plus the substitutions below; server vars are set at runtime in step 4.
# ── 2c. NO PLACEHOLDERS (owner law, 2026-07-25): a paying-customer build never ──
# ships an embed with __PLACEHOLDER__ addresses on a chain we are live on. The
# values live in web/.env.local (canonical sources: script/mirror-manifest.json +
# web/lib/chains.ts); the build receives them as substitutions. Missing any of
# the four live-chain values ABORTS the deploy — loud beats dormant. The zkSync
# pair is optional (chain never broadcast; its USD-only fallback is the honest
# state until an EraVM broadcast exists).
# `|| true` because a var that is legitimately absent (the optional zkSync pair)
# makes grep exit 1 — under `set -euo pipefail` that killed the whole deploy
# silently right after secret-vaulting. Absent stays absent; the gate below
# decides which ones are allowed to be.
embed_var() { grep "^${1}=" "$REPO_ROOT/web/.env.local" | head -1 | cut -d= -f2- || true; }
ROUTER_ARC="$(embed_var NEXT_PUBLIC_ROUTER_ARC)"
USDC_ARC="$(embed_var NEXT_PUBLIC_USDC_ARC)"
ROUTER_BASE="$(embed_var NEXT_PUBLIC_ROUTER_BASE_SEPOLIA)"
USDC_BASE="$(embed_var NEXT_PUBLIC_USDC_BASE_SEPOLIA)"
ROUTER_ZK="$(embed_var NEXT_PUBLIC_ROUTER_ZKSYNC_SEPOLIA)"
USDC_ZK="$(embed_var NEXT_PUBLIC_USDC_ZKSYNC_SEPOLIA)"
MISSING_ADDRS=""
[[ -n "$ROUTER_ARC" ]] || MISSING_ADDRS="$MISSING_ADDRS NEXT_PUBLIC_ROUTER_ARC"
[[ -n "$USDC_ARC" ]] || MISSING_ADDRS="$MISSING_ADDRS NEXT_PUBLIC_USDC_ARC"
[[ -n "$ROUTER_BASE" ]] || MISSING_ADDRS="$MISSING_ADDRS NEXT_PUBLIC_ROUTER_BASE_SEPOLIA"
[[ -n "$USDC_BASE" ]] || MISSING_ADDRS="$MISSING_ADDRS NEXT_PUBLIC_USDC_BASE_SEPOLIA"
if [[ -n "$MISSING_ADDRS" ]]; then
  echo "deploy-web: REFUSING to build — live-chain embed addresses missing from web/.env.local:"
  echo "   $MISSING_ADDRS"
  echo "  Fill them from script/mirror-manifest.json + web/lib/chains.ts. No placeholders in prod."
  exit 1
fi

echo "==> building ${IMAGE}"
# _CACHE_DEPS keeps a deps-stage image in the registry so `npm ci` only re-runs
# when the lockfile actually changed — a cold Cloud Build machine pulls it and
# the dependency layer cache-hits instead of reinstalling the world every deploy.
CACHE_DEPS="${REGION}-docker.pkg.dev/${PROJ}/access0x1/web:deps-cache"
gcloud builds submit --config cloudbuild.yaml \
  --substitutions="_IMAGE=${IMAGE},_DYNAMIC_ENV=${DYN_ENV},_DEFAULT_CHAIN_ID=${DEFAULT_CHAIN_ID},_CACHE_DEPS=${CACHE_DEPS},_ROUTER_ARC=${ROUTER_ARC},_USDC_ARC=${USDC_ARC},_ROUTER_BASE_SEPOLIA=${ROUTER_BASE},_USDC_BASE_SEPOLIA=${USDC_BASE},_ROUTER_ZKSYNC_SEPOLIA=${ROUTER_ZK},_USDC_ZKSYNC_SEPOLIA=${USDC_ZK}" \
  .

# ── 4. Deploy it, WITH every integration's runtime env ───────────────────────
# `--env-vars-file` sets the service's env to exactly this derived set — the single
# source of truth is the registry + .env.local, so the live service matches what
# `env:set` collected. Values travel in the file, never in argv (no secret in shell
# history or `ps`). A blank integration simply isn't in the file, so it stays OFF.
echo "==> deploying to Cloud Run service '${SERVICE}' (${REGION}) with all configured integrations"
gcloud run deploy "$SERVICE" \
  --region "$REGION" \
  --image "$IMAGE" \
  --env-vars-file "$RUNTIME_ENV" \
  ${SET_SECRETS:+--set-secrets "$SET_SECRETS"} \
  --quiet

# ── 4. Prove the live site is the build we just made ─────────────────────────
echo "==> verifying ${DOMAIN}"
sleep 5
HEALTH="$(curl -sS --max-time 20 "${DOMAIN}/api/health" || true)"
if printf '%s' "$HEALTH" | grep -q '"apiRoutesReachable":true'; then
  LIVE="$(printf '%s' "$HEALTH" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p')"
  echo "    health OK — live commit: ${LIVE}"
  [[ "$LIVE" == "$TAG" ]] || echo "    ⚠ live commit != ${TAG}; the CDN or a revision may be lagging"
else
  echo "    ⚠ /api/health did not answer as expected. Response:"
  printf '    %s\n' "${HEALTH:0:200}"
fi

AUTH="$(curl -sS --max-time 20 "${DOMAIN}/api/branding?probe=auth" || true)"
if printf '%s' "$AUTH" | grep -q '"writesBlockedByServerConfig":false'; then
  echo "    auth OK — merchant writes will save"
else
  echo "    ⚠ writes still blocked by server config. Response:"
  printf '    %s\n' "${AUTH:0:200}"
fi

[[ "${STASHED:-0}" == "1" ]] && { echo "==> restoring your stashed changes"; git -C "$REPO_ROOT" stash pop --quiet || true; }
echo "==> done."
