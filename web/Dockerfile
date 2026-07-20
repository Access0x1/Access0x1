# syntax=docker/dockerfile:1

# =============================================================================
# Access0x1 web app — production image for Google Cloud Run.
#
# The PUBLIC rail runs on GCP (Cloud Run), fully self-contained. This builds the
# standalone Next.js bundle (`output: 'standalone'` in
# next.config.ts) and runs `node server.js`, which listens on $PORT — the port
# Cloud Run injects at runtime (do NOT hardcode 3000).
#
# Three stages keep the runner small and free of build tooling / dev deps:
#   1. deps    — install production node_modules from the lockfile.
#   2. builder — copy deps + source, run `next build` to emit .next/standalone.
#   3. runner  — copy ONLY the standalone server + static assets + public/,
#                plus the `pg` driver (see below), and run as a non-root user.
#
# pg (R-2 durable nullifier store): Next's output-file tracer does NOT follow
# the lazily-resolved `pg` optional dependency, so it is NOT bundled into
# .next/standalone/node_modules. The runner therefore installs `pg` explicitly
# so the durable Postgres-backed verification store works when
# NULLIFIER_STORE_URL / DATABASE_URL is wired (Cloud SQL) and
# VERIFY_REQUIRE_DURABLE_STORE=true. See web/DEPLOY-GCP.md.
# =============================================================================

# Pin to a Node 22 LTS slim base (the app targets @types/node ^22 / Node 22).
ARG NODE_VERSION=22-slim

# --- Stage 1: deps -----------------------------------------------------------
# Install the full dependency tree (incl. dev deps, needed for `next build`)
# from the committed lockfile so the build is reproducible.
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

# Only the manifests so this layer caches until dependencies change.
COPY package.json package-lock.json ./
# `npm ci` is deterministic and respects the lockfile exactly.
RUN npm ci

# --- Stage 2: builder --------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app

# Public, build-time client config. NEXT_PUBLIC_* values are INLINED into the
# client bundle and baked into public/embed.js by the prebuild step, so they
# MUST be present at build time, not just at runtime. Pass them with
# `docker build --build-arg NEXT_PUBLIC_...` (or Cloud Build substitutions).
# Server-only secrets are NEVER build args — they are injected at runtime via
# Secret Manager (see DEPLOY-GCP.md). Leave any unset to keep that feature off.
ARG NEXT_PUBLIC_DEFAULT_CHAIN_ID
ARG NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID
ARG NEXT_PUBLIC_ROUTER_ARC
ARG NEXT_PUBLIC_USDC_ARC
ARG NEXT_PUBLIC_ROUTER_BASE_SEPOLIA
ARG NEXT_PUBLIC_USDC_BASE_SEPOLIA
ARG NEXT_PUBLIC_ROUTER_ZKSYNC_SEPOLIA
ARG NEXT_PUBLIC_USDC_ZKSYNC_SEPOLIA
ARG NEXT_PUBLIC_ARC_RPC_URL
ARG NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL
ARG NEXT_PUBLIC_ZKSYNC_SEPOLIA_RPC_URL
ARG NEXT_PUBLIC_WORLD_APP_ID
ARG NEXT_PUBLIC_WORLD_ENVIRONMENT
ARG NEXT_PUBLIC_OIDC_CLIENT_ID
ARG NEXT_PUBLIC_ENS_PARENT
# Promote the build args into the build environment so `next build` reads them.
ENV NEXT_PUBLIC_DEFAULT_CHAIN_ID=${NEXT_PUBLIC_DEFAULT_CHAIN_ID} \
    NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID=${NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID} \
    NEXT_PUBLIC_ROUTER_ARC=${NEXT_PUBLIC_ROUTER_ARC} \
    NEXT_PUBLIC_USDC_ARC=${NEXT_PUBLIC_USDC_ARC} \
    NEXT_PUBLIC_ROUTER_BASE_SEPOLIA=${NEXT_PUBLIC_ROUTER_BASE_SEPOLIA} \
    NEXT_PUBLIC_USDC_BASE_SEPOLIA=${NEXT_PUBLIC_USDC_BASE_SEPOLIA} \
    NEXT_PUBLIC_ROUTER_ZKSYNC_SEPOLIA=${NEXT_PUBLIC_ROUTER_ZKSYNC_SEPOLIA} \
    NEXT_PUBLIC_USDC_ZKSYNC_SEPOLIA=${NEXT_PUBLIC_USDC_ZKSYNC_SEPOLIA} \
    NEXT_PUBLIC_ARC_RPC_URL=${NEXT_PUBLIC_ARC_RPC_URL} \
    NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL=${NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL} \
    NEXT_PUBLIC_ZKSYNC_SEPOLIA_RPC_URL=${NEXT_PUBLIC_ZKSYNC_SEPOLIA_RPC_URL} \
    NEXT_PUBLIC_WORLD_APP_ID=${NEXT_PUBLIC_WORLD_APP_ID} \
    NEXT_PUBLIC_WORLD_ENVIRONMENT=${NEXT_PUBLIC_WORLD_ENVIRONMENT} \
    NEXT_PUBLIC_OIDC_CLIENT_ID=${NEXT_PUBLIC_OIDC_CLIENT_ID} \
    NEXT_PUBLIC_ENS_PARENT=${NEXT_PUBLIC_ENS_PARENT} \
    # Disable Next.js telemetry in CI/builds.
    NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The committed lib/deployments.ts + lib/currentBytecode.ts are the source of
# truth for a deploy. The npm `prebuild` hook's `gen-deployments.mjs` step reads
# Foundry artifacts from the REPO ROOT (broadcast/, out/, script/) — paths that
# are NOT in this web-only build context and whose `out/` is not committed.
# Running it here would clobber the committed maps with empties. So we run the
# build's two steps explicitly, KEEPING the self-contained embed-address
# substitution (it only needs web/public/embed.js + the NEXT_PUBLIC_* env) and
# SKIPPING gen-deployments. `--ignore-scripts` on the next call is implicit:
# we bypass the npm `build` lifecycle by invoking the steps directly.
RUN node scripts/replace-embed-addrs.js \
    && node ./node_modules/next/dist/bin/next build --webpack

# --- Stage 3: runner ---------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

# Production runtime. PORT is injected by Cloud Run; default to 8080 (Cloud
# Run's default) for local `docker run` without -e PORT. HOSTNAME 0.0.0.0 makes
# the standalone server bind all interfaces so Cloud Run can reach it.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0

# Run as the unprivileged `node` user that the base image already provides.
# Copy the standalone bundle, static assets, and public/ with that ownership.
#
# The standalone output already contains a TRACED, minimal node_modules and a
# top-level server.js (outputFileTracingRoot pins the trace root to web/, so
# server.js sits at the bundle root — not under a nested package path).
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# R-2 durable store: install the `pg` driver into the runner's node_modules.
# Next does not trace optional deps into the standalone bundle, so without this
# the durable Postgres nullifier store cannot load. `--no-save` / `--no-package-lock`
# keep it out of any manifest; it is added strictly to the runtime image.
RUN npm install --no-save --no-package-lock --omit=dev pg@^8.13.0 \
    && chown -R node:node /app/node_modules/pg

USER node

EXPOSE 8080

# The standalone server reads PORT + HOSTNAME from the environment.
CMD ["node", "server.js"]
