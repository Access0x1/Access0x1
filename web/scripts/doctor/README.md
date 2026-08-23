# The env doctor

One registry drives everything: [`web/lib/config/integrations.ts`](../../lib/config/integrations.ts)
declares every integration the app can use and every env var it reads. Add a var
there and it automatically appears in the doctor, the intake prompt, the scaffold,
and the deploy. Nothing in this folder hardcodes a variable name.

## The commands (run from `web/`)

| Command | What it does |
| --- | --- |
| `npm run env:doctor` | The report: every integration, set/unset **by name only** — no value is ever printed. `--core` shows only what going live needs; `--strict` exits 1 for CI. |
| `npm run env:doctor -- --tools` | The registry by provenance: **built in-house** vs **partner tools we use** — partners listed with the standing note that we like them and use them either way, sponsoring or not. |
| `npm run env:set` | The intake: walks every integration still missing keys and prompts for each (echo **off**), or `-- <id>` for one. Writes the right file by itself. |
| `npm run env:scaffold` | Writes a blank, annotated slot for every registry var, so the file documents itself. |
| `npm run env:seal` / `env:open` / `env:check` | One encrypted `.env.sealed` instead of N secrets — carry a single passphrase to a new machine. |
| `npm run env:deploy-preview` | What the deploy will ship, names + booleans only. |

## Where values live, where they go

```
you ──ˋenv:setˊ──▶ web/.env.local  (app keys)      ─┐
                   .env  (deploy toolchain keys)    ├─▶ deploy-env.mjs ─▶ Cloud Run
                                                    ┘     ├─ NEXT_PUBLIC_*  → build (public)
                                                          ├─ plain config   → runtime env
                                                          └─ secret: true   → Secret Manager
```

Both files are gitignored, written `0600`, atomically. Blank or placeholder
values are skipped everywhere — a blank slot means that seam stays OFF
(fail-soft), never a broken deploy.

## The rules the tooling enforces

- **No value is ever printed** — not by the doctor, not by the intake, not in
  the deploy summary.
- **Refuses non-gitignored targets** — the intake will not write a secret to a
  file git could stage.
- **Secrets ride to Secret Manager**, never the service's plaintext env; the
  registry's `secret: true` flag decides the road.
- **Never commit a key.** This folder is the whole intake path — a key never
  belongs in a chat, an issue, or a commit.
