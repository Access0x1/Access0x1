# create-access0x1

Scaffolds the [Access0x1](https://github.com/Access0x1/Access0x1) starter — a non-custodial,
USD-priced (Chainlink) crypto payments stack — from `templates/starter/` at the repo root.

Once published it runs as the standard npm initializer: `npm create access0x1@latest my-app`.

> **Publish gate (owner-only).** The metadata here is publish-ready, but `package.json` keeps
> `"private": true` on purpose. The single step to ship it is the owner's call — see
> **[Publishing](#publishing-owner-only)** below.
>
> Until then, end users fetch the template directly with `degit` (below); this CLI also works as a
> thin wrapper from a local checkout of this repo (it does the `{{TOKEN}}` substitution for you).

## Get the starter (no CLI needed) — recommended

```bash
npx degit Access0x1/Access0x1/templates/starter my-checkout
cd my-checkout
npm run setup        # detect/install Foundry, install deps, build the contracts
```

`degit` copies `templates/starter/` verbatim; replace the `{{...}}` placeholders by hand, or use the
CLI below to have them filled in.

## Or use this CLI

Once published (see [Publishing](#publishing-owner-only)), as the standard npm initializer:

```bash
npm create access0x1@latest my-checkout -- --chain base --features checkout,invoices --yes
npx create-access0x1 my-checkout --chain base --features checkout,invoices --yes
```

Or directly from a checkout of this repo (no publish required):

```bash
node packages/create-access0x1/bin/index.mjs my-checkout --chain base --features checkout,invoices --yes
```

It copies the SAME `templates/starter/` tree and substitutes `{{PROJECT_NAME}}` / `{{CHAIN}}` /
`{{CHAIN_ID}}` / `{{ROUTER_ENV}}` / `{{FEATURES}}` for you, then materializes a blank `.env.local`.

## What it generates

```
my-checkout/
├── package.json    `npm run setup` (toolchain bootstrap) + dev/build wrappers
├── scripts/setup.mjs
├── app/            Minimal Next.js checkout using @access0x1/react <PayButton>
│   ├── app/page.tsx            working quote → (approve) → pay → receipt flow
│   ├── access0x1.config.ts     chain + router (from env) + integration seams
│   ├── public/embed.js         the one-tag, no-build embed
│   └── .env.example            EVERY integration seam as a fill-in blank
└── contracts/      Your OWN Foundry contracts — the real Access0x1Router + the commerce set
    ├── src/                    Subscriptions / Bookings / Invoices / GiftCards, plus
    │                           ChainRegistry / PaymentLanes / SessionGrant / HouseToken(Factory) / NameMath
    ├── script/                 DeployAll.s.sol + DeployAccess0x1Router.s.sol + HelperConfig.s.sol
    ├── foundry.toml remappings.txt package.json
    └── DEPLOY.md               deploy-your-own runbook (zero dependency on us)
```

A `.env.local` is created from `.env.example` (values stay blank — fill them in yourself).

## Options

| Flag | Values | Default | Meaning |
|---|---|---|---|
| `--chain` | deployed: `arc` \| `base` \| `zksync`; deploy-PENDING (config only): `zerog` \| `monad` \| `bera` \| `sei` \| `megaeth` | `arc` | Settlement chain (`arc` = 5042002, `base` = 84532, `zksync` = 300; the PENDING chains scaffold config only — fill the router from your own deploy) |
| `--features` | comma list of `checkout,subscriptions,bookings,invoices` | `checkout` | Enabled features (`checkout` is always on — it's the base flow) |
| `--yes`, `-y` | — | off | Skip prompts, accept defaults |
| `--help`, `-h` | — | — | Print usage and exit |

Without `--yes` (and on a TTY), the CLI prompts interactively for the directory, chain, and features. The target directory is required when prompts are skipped, and the CLI refuses to scaffold into a non-empty directory.

## Doctrine

- **Zero runtime dependencies.** The CLI uses only Node builtins, so it is instant.
- **LAW #4 — truth in copy.** The scaffolder NEVER writes an invented router / feed / USDC address.
  Every address is an env placeholder with a "confirm at booth / fill from your own deploy" note.
- **Non-custodial by construction.** The generated contracts are *yours*; buyers pay your router
  directly. Nothing depends on Access0x1 infrastructure.
- **No-deploy default.** The generated app runs against a router you configure in `.env.local`, so
  it boots out of the box once you paste a router address you trust. Deploying your own is optional.

## Publishing (owner-only)

The metadata in `package.json` is publish-ready (`bin`, `files`, `engines`, `repository`, `homepage`,
`bugs`, `keywords`, `publishConfig.access: public`). **The one remaining step is the owner's call:**

```bash
# 1. Flip the publish gate: set "private": false in packages/create-access0x1/package.json
# 2. From the package directory, publish:
cd packages/create-access0x1 && npm publish
```

That's it — there is no build step (the CLI is plain ESM). `publishConfig.access` is already `public`,
so the unscoped `create-access0x1` name publishes publicly.

> **Stub note — template distribution.** `files` ships only `bin`, `README.md`, and `LICENSE`; the
> `templates/starter/` tree lives at the repo root and is **not** bundled into the npm tarball. A
> freshly `npx`'d `create-access0x1` therefore needs the template resolvable on disk (running from a
> checkout) OR the publish step must first vendor `templates/starter/` into the package and add it to
> `files`. Wire that in before flipping the gate if you want a standalone `npx` to scaffold without a
> local checkout; until then the recommended path stays `npx degit …/templates/starter` (above).

## Requirements

- Node.js >= 18
- (For the contracts) [Foundry](https://book.getfoundry.sh) — `npm run setup` installs it for you.

## License

MIT
