# create-access0x1 (internal convenience CLI)

Scaffolds the [Access0x1](https://github.com/Access0x1/Access0x1) starter — a non-custodial,
USD-priced (Chainlink) crypto payments stack — from `templates/starter/` at the repo root.

> **This package is `private` and is NOT published to npm.** Only `@access0x1/react` is published.
> End users fetch the template directly with `degit` (below); this CLI is a thin wrapper for working
> from a local checkout of this repo (it does the `{{TOKEN}}` substitution for you).

## Get the starter (no CLI needed) — recommended

```bash
npx degit Access0x1/Access0x1/templates/starter my-checkout
cd my-checkout
npm run setup        # detect/install Foundry, install deps, build the contracts
```

`degit` copies `templates/starter/` verbatim; replace the `{{...}}` placeholders by hand, or use the
CLI below to have them filled in.

## Or use this CLI (from a checkout of this repo)

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
└── contracts/      Your OWN Foundry contracts (the real Access0x1Router + the commerce quartet:
    ├── src/  script/           Subscriptions / Bookings / Invoices / GiftCards)
    ├── foundry.toml remappings.txt package.json
    └── DEPLOY.md               deploy-your-own runbook (zero dependency on us)
```

A `.env.local` is created from `.env.example` (values stay blank — fill them in yourself).

## Options

| Flag | Values | Default | Meaning |
|---|---|---|---|
| `--chain` | `arc` \| `base` \| `zksync` | `arc` | Settlement chain |
| `--features` | comma list of `checkout,subscriptions,bookings,invoices` | `checkout` | Enabled features |
| `--yes`, `-y` | — | off | Skip prompts, accept defaults |

Without `--yes`, the CLI prompts interactively for the directory, chain, and features.

## Doctrine

- **Zero runtime dependencies.** The CLI uses only Node builtins, so it is instant.
- **LAW #4 — truth in copy.** The scaffolder NEVER writes an invented router / feed / USDC address.
  Every address is an env placeholder with a "confirm at booth / fill from your own deploy" note.
- **Non-custodial by construction.** The generated contracts are *yours*; buyers pay your router
  directly. Nothing depends on Access0x1 infrastructure.
- **No-deploy default.** The generated app runs against a router you configure in `.env.local`, so
  it boots out of the box once you paste a router address you trust. Deploying your own is optional.

## Requirements

- Node.js >= 18
- (For the contracts) [Foundry](https://book.getfoundry.sh) — `npm run setup` installs it for you.

## License

MIT
