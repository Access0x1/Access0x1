# Deploying the Access0x1 web app to Google Cloud Run

The PUBLIC rail runs on **Google Cloud Run**, fully decoupled from any private
infrastructure. This document is the codified deploy path referenced by
`Dockerfile` and `cloudbuild.yaml`.

Two rules shape everything below:

1. **`NEXT_PUBLIC_*` values are build-time.** Next.js inlines them into the
   client bundle at `next build` (and the prebuild step bakes them into
   `public/embed.js`). They MUST be present when the image is built — they cannot
   be supplied at runtime. They are PUBLIC (shipped to every browser), so they
   are passed as `--build-arg` / Cloud Build substitutions, never as secrets.
2. **Server-only secrets are runtime-only.** `NULLIFIER_STORE_URL` /
   `DATABASE_URL` (the durable Postgres store), `ANTHROPIC_API_KEY`, and any
   other server secret are injected at container start via **Secret Manager**,
   never baked into the image and never a build arg.

The app is BYO-keys and fail-soft: any value you leave unset simply keeps that
feature OFF. See `.env.example` for the authoritative variable catalogue.

---

## Prerequisites

- A GCP project with billing enabled.
- `gcloud` CLI authenticated (`gcloud auth login`) and the project set
  (`gcloud config set project <PROJECT_ID>`).
- Enable the required APIs once:

  ```
  gcloud services enable \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    artifactregistry.googleapis.com \
    secretmanager.googleapis.com \
    sqladmin.googleapis.com
  ```

- An Artifact Registry Docker repo (once):

  ```
  gcloud artifacts repositories create access0x1 \
    --repository-format=docker --location=us-central1
  ```

Pick a region and reuse it everywhere (examples use `us-central1`). The image
tag pattern is:

```
us-central1-docker.pkg.dev/<PROJECT_ID>/access0x1/web:<TAG>
```

---

## 1. Build the image (Cloud Build)

`cloudbuild.yaml` builds `Dockerfile` and forwards every `NEXT_PUBLIC_*`
build-arg the `next build` consumes as a substitution. Only `_IMAGE` is
required; every `NEXT_PUBLIC_*` substitution defaults to empty (feature OFF).

```
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=\
_IMAGE=us-central1-docker.pkg.dev/<PROJECT_ID>/access0x1/web:v1,\
_DYNAMIC_ENV=<dynamic-environment-id>,\
_DEFAULT_CHAIN_ID=5042002,\
_ROUTER_ARC=0x<router-on-arc>,\
_USDC_ARC=0x<usdc-on-arc>,\
_ARC_RPC_URL=https://<arc-rpc>,\
_ROUTER_BASE_SEPOLIA=0x<router-on-base-sepolia>,\
_USDC_BASE_SEPOLIA=0x<usdc-on-base-sepolia>,\
_BASE_SEPOLIA_RPC_URL=https://<base-sepolia-rpc>,\
_ROUTER_ZKSYNC_SEPOLIA=0x<router-on-zksync-sepolia>,\
_USDC_ZKSYNC_SEPOLIA=0x<usdc-on-zksync-sepolia>,\
_ZKSYNC_SEPOLIA_RPC_URL=https://<zksync-sepolia-rpc> \
  .
```

Substitution → build-arg → env var mapping (all PUBLIC):

| Substitution | Build arg (`NEXT_PUBLIC_*`) | Meaning |
|---|---|---|
| `_DYNAMIC_ENV` | `DYNAMIC_ENVIRONMENT_ID` | Dynamic auth environment id |
| `_DEFAULT_CHAIN_ID` | `DEFAULT_CHAIN_ID` | Embed's default chain (`5042002` = Arc Testnet) |
| `_ROUTER_ARC` / `_USDC_ARC` / `_ARC_RPC_URL` | `ROUTER_ARC` / `USDC_ARC` / `ARC_RPC_URL` | Arc router, USDC, RPC |
| `_ROUTER_BASE_SEPOLIA` / `_USDC_BASE_SEPOLIA` / `_BASE_SEPOLIA_RPC_URL` | `ROUTER_BASE_SEPOLIA` / `USDC_BASE_SEPOLIA` / `BASE_SEPOLIA_RPC_URL` | Base Sepolia (chain 84532) |
| `_ROUTER_ZKSYNC_SEPOLIA` / `_USDC_ZKSYNC_SEPOLIA` / `_ZKSYNC_SEPOLIA_RPC_URL` | `ROUTER_ZKSYNC_SEPOLIA` / `USDC_ZKSYNC_SEPOLIA` / `ZKSYNC_SEPOLIA_RPC_URL` | zkSync Sepolia (chain 300) |

You can also build locally with the same args:

```
docker build -f Dockerfile \
  --build-arg NEXT_PUBLIC_DEFAULT_CHAIN_ID=5042002 \
  --build-arg NEXT_PUBLIC_ROUTER_ARC=0x... \
  --build-arg NEXT_PUBLIC_USDC_ARC=0x... \
  --build-arg NEXT_PUBLIC_ARC_RPC_URL=https://... \
  -t us-central1-docker.pkg.dev/<PROJECT_ID>/access0x1/web:v1 .
```

---

## 2. Server secrets (Secret Manager)

Server-only values are stored in Secret Manager, **not** in the image. Create
only the ones the features you enable need. The durable store is the important
one: without `NULLIFIER_STORE_URL` (or `DATABASE_URL`), replay/nullifier data
lives only in memory, and with `VERIFY_REQUIRE_DURABLE_STORE=true` (or
`NODE_ENV=production`) verification **fails closed**.

```
# Cloud SQL Postgres connection string for the durable nullifier / KV store.
printf '%s' 'postgres://USER:PASSWORD@/DB?host=/cloudsql/<INSTANCE_CONNECTION_NAME>' \
  | gcloud secrets create nullifier-store-url --data-file=-

# Optional: Claude API key for the server-side agent features.
printf '%s' 'sk-ant-...' | gcloud secrets create anthropic-api-key --data-file=-
```

Grant the Cloud Run runtime service account access:

```
gcloud secrets add-iam-policy-binding nullifier-store-url \
  --member="serviceAccount:<RUNTIME_SA>" \
  --role="roles/secretmanager.secretAccessor"
```

(`<RUNTIME_SA>` is the service account the Cloud Run service runs as — the
default compute SA `PROJECT_NUMBER-compute@developer.gserviceaccount.com` unless
you set a dedicated one.)

---

## 3. Cloud SQL (durable store — optional but recommended)

The durable Postgres nullifier / KV store (R-2) backs replay protection,
branding, API keys, and meter data. Create a small instance and database:

```
gcloud sql instances create access0x1-db \
  --database-version=POSTGRES_15 --tier=db-f1-micro --region=us-central1
gcloud sql databases create access0x1 --instance=access0x1-db
```

The `INSTANCE_CONNECTION_NAME` is `<PROJECT_ID>:us-central1:access0x1-db`; use it
in the `nullifier-store-url` secret's `?host=/cloudsql/<INSTANCE_CONNECTION_NAME>`
and attach it to the service in the next step. The runner image already installs
the `pg` driver, so no code change is needed.

---

## 4. Deploy to Cloud Run

```
gcloud run deploy access0x1-web \
  --image=us-central1-docker.pkg.dev/<PROJECT_ID>/access0x1/web:v1 \
  --region=us-central1 \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --add-cloudsql-instances=<PROJECT_ID>:us-central1:access0x1-db \
  --set-secrets=NULLIFIER_STORE_URL=nullifier-store-url:latest \
  --set-secrets=ANTHROPIC_API_KEY=anthropic-api-key:latest \
  --set-env-vars=VERIFY_REQUIRE_DURABLE_STORE=true
```

Notes:

- `--allow-unauthenticated` makes the public checkout reachable without a Google
  identity (this is a public site).
- `--port=8080` matches the Dockerfile's default; Cloud Run also injects `$PORT`
  and the standalone server honours it — do not hardcode `3000`.
- Add `--set-secrets`/`--set-env-vars` only for the features you enabled. Drop
  the Cloud SQL flags entirely if you are not running the durable store (the app
  then keeps state in memory and, in production, verification fails closed unless
  you also unset `VERIFY_REQUIRE_DURABLE_STORE`).
- To change a `NEXT_PUBLIC_*` value you must rebuild the image (they are baked in
  at build time), then deploy the new tag.

---

## 5. Verify

```
SERVICE_URL=$(gcloud run services describe access0x1-web \
  --region=us-central1 --format='value(status.url)')
curl -sS -o /dev/null -w '%{http_code}\n' "$SERVICE_URL/"
```

A `200` means the standalone server is live. Load the URL in a browser to
confirm the embed renders with your configured chain(s).

---

## Redeploying a new version

1. `gcloud builds submit --config cloudbuild.yaml --substitutions=_IMAGE=...:v2,... .`
2. `gcloud run deploy access0x1-web --image=...:v2 --region=us-central1 ...`

Cloud Run keeps the previous revision, so a rollback is
`gcloud run services update-traffic access0x1-web --to-revisions=<PREV>=100`.
