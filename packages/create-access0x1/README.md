# create-access0x1

Scaffold a complete [Access0x1](https://github.com/Access0x1/Access0x1) project in **one command** —
like `create-next-app`, but for a non-custodial, USD-priced (Chainlink) crypto payments stack.

```bash
npm create access0x1@latest my-checkout
# or
npx create-access0x1 my-checkout --chain base --features checkout,invoices --yes
```

## What it generates

```
my-checkout/
├── app/            Minimal Next.js checkout using @access0x1/react <PayButton>
│   ├── app/page.tsx            working quote → (approve) → pay → receipt flow
│   ├── access0x1.config.ts     chain + router (from env) + sponsor seams
│   ├── public/embed.js         the one-tag, no-build embed
│   └── .env.example            EVERY sponsor seam as a fill-in blank
└── contracts/      Your OWN Foundry contracts (the real Access0x1Router)
    ├── src/  script/           Solidity + DeployAll.s.sol + HelperConfig.s.sol
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

- **Zero runtime dependencies.** The CLI uses only Node builtins, so `npx` is instant.
- **LAW #4 — truth in copy.** The scaffolder NEVER writes an invented router / feed / USDC address.
  Every address is an env placeholder with a "confirm at booth / fill from your own deploy" note.
- **Non-custodial by construction.** The generated contracts are *yours*; buyers pay your router
  directly. Nothing depends on Access0x1 infrastructure.

## Requirements

- Node.js >= 18
- (For the contracts) [Foundry](https://book.getfoundry.sh) — `forge build && forge script DeployAll`

## License

MIT
