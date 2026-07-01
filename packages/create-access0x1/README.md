# create-access0x1

Scaffolds the [Access0x1](https://github.com/Access0x1/Access0x1) starter — a non-custodial,
USD-priced (Chainlink) crypto payments stack — from `templates/starter/` at the repo root.

Access0x1 is **distributed from GitHub — it is not published to any npm registry.** You scaffold a
new app by copying the template straight from the repo with [`degit`](https://github.com/Rich-Harris/degit)
(below), or by running this CLI from a checkout of this repo (it does the `{{TOKEN}}` substitution for
you). There is no `npm create` / `npx create-access0x1@latest` path — and that's by design, not a
pending step.

## Get the starter (no CLI needed) — recommended

```bash
npx degit Access0x1/Access0x1/templates/starter my-checkout
cd my-checkout
npm run setup        # detect/install Foundry, install deps, build the contracts
```

`degit` copies `templates/starter/` verbatim; replace the `{{...}}` placeholders by hand, or use the
CLI below to have them filled in.

## Or use this CLI (from a repo checkout)

The CLI runs straight from a checkout of this repo — no registry, no publish:

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

## Distribution (no npm publish)

Access0x1 is **not published to any npm registry — on purpose.** Everything ships from GitHub:

- **Scaffold a new app:** `npx degit Access0x1/Access0x1/templates/starter my-checkout` (copies the
  template straight from the repo — no registry), or run this CLI from a checkout
  (`node packages/create-access0x1/bin/index.mjs …`).
- **Consume the SDK:** reference `@access0x1/react` as a git dependency in your app's `package.json`
  (`"@access0x1/react": "github:Access0x1/Access0x1#main"`), or vendor `packages/react/`.

The CLI is plain ESM (no build step). It reads `templates/starter/` from the repo checkout it runs in,
so it does not need to be packaged — the `degit` path stays the recommended zero-checkout route.

## Requirements

- Node.js >= 18
- (For the contracts) [Foundry](https://book.getfoundry.sh) — `npm run setup` installs it for you.

## License

MIT
