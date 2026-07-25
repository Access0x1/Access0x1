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
RUNTIME_ENV="$(mktemp -t access0x1-runtime.XXXXXX.yaml)"
trap 'rm -f "$RUNTIME_ENV"' EXIT
node scripts/deploy-env.mjs --runtime-out "$RUNTIME_ENV"
# These two must exist at runtime regardless of what .env.local held: the commit so
# /api/health can name the live build, and the Dynamic env id so the server can
# verify a sign-in (the whole "verified login" bug). Appended, so they win.
{
  echo "NEXT_PUBLIC_BUILD_COMMIT: '${TAG}'"
  [[ -n "${DYN_ENV:-}" ]] && echo "NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID: '${DYN_ENV}'"
} >> "$RUNTIME_ENV"

# ── 3. Build the image ───────────────────────────────────────────────────────
# Public NEXT_PUBLIC_* vars are inlined at build from .env.local (copied into the
# context) plus the substitutions below; server vars are set at runtime in step 4.
echo "==> building ${IMAGE}"
gcloud builds submit --config cloudbuild.yaml \
  --substitutions="_IMAGE=${IMAGE},_DYNAMIC_ENV=${DYN_ENV},_DEFAULT_CHAIN_ID=${DEFAULT_CHAIN_ID}" \
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
