# Handoff prompt — Data Hub link pursuit (paste into a new Claude Code session)

> **Start the new session with `doble196/pursuit-data-project` as the initial source repo.**
> This is mandatory: the previous session was rooted in `Access0x1/Access0x1`, and `add_repo`
> refuses cross-owner adds ("cross-tier adds are not supported in v1"). Rooting the session in
> the doble196 repo is the only way in.

---

## MISSION

Find the exact **Data Hub link** (URL). The owner (rensley@nfteria.cc, GitHub `doble196`)
says it belongs to "the Pursuit with the doble repo" — i.e. the Pursuit program/data project
under the `doble196` account, **not** anything under Access0x1.

Primary target: `doble196/pursuit-data-project` (private, last push 2026-07-29).
Secondary target if not found there: `doble196/pursuit-ai-native-kit` (private, last push 2026-08-11).

## WHAT WAS ALREADY DONE (do not repeat)

The previous session (branch `claude/data-hub-link-r858ae` on `Access0x1/Access0x1`) touched
these apps/surfaces, with the logic behind each touch. **Everything was read-only; no files
were modified and nothing was committed or pushed anywhere.**

1. **`Access0x1/Access0x1` (local clone, full tree + all remote branches)**
   - *Logic:* it was the session's scoped repo, so the obvious first place a "data hub" link would live.
   - *Did:* case-insensitive grep for `data hub` / `datahub` / `data-hub` / `data_hub` across the whole
     tree; swept every URL in `.md/.ts/.tsx/.toml/.env.example` matching data|hub|dash|console|portal;
     enumerated `web/app` routes; fetched and grepped all ~30 remote branches (dev, dependabot/*, fable/*).
   - *Result:* **zero hits.** The phrase exists nowhere in the repo. Nearest things: the merchant
     dashboard route `https://access0x1.xyz/dashboard` and the `subgraph/` indexer — neither is a data hub.
2. **Gmail (MCP)**
   - *Logic:* if the link isn't in code, it may have been emailed.
   - *Did:* searched threads for `"data hub"`, `datahub`, `data-hub`. *Result:* no matching threads.
3. **Claude Code Remote — `list_repos`**
   - *Logic:* user said "the pursuit with the doble repo," so enumerate the account's fleet to find it.
   - *Result:* found the two Pursuit repos above.
4. **`add_repo doble196/pursuit-data-project`**
   - *Logic:* attach the target repo to read it. *Result:* **blocked** — cross-tier add
     (session already owned by `access0x1`). This is why you, the new session, exist.

## THE FLEET (context — the account's repo estate, from `list_repos`)

- **Access0x1 org** — the startup's public face:
  - `Access0x1/Access0x1` — the monorepo: Solidity rail (`src/` Router, Escrow, Subscriptions,
    Bookings, Invoices, GiftCards, RWA/tokenization kit…), `web/` Next.js app (access0x1.xyz),
    `snap/` MetaMask snap, `subgraph/`, SDK `packages/` (react, x402-client, create-access0x1).
    Live on ten testnets; no mainnet.
  - `Access0x1/access0x1.com` (private site), `Access0x1.github.io`, `.github`, `a0x-private-evidence` (private).
- **doble196 personal** — active: `pursuit-data-project` ← **target**, `pursuit-ai-native-kit`,
  `fleet` (private), `freshroute-demo`, `colmado-app`, `doble196.github.io`, `doble196` (profile),
  `0g`, `QuantL`, `claude-toolkit`, `anapimod`, `Colaboratory`, `CLaude_4.8`; plus a long tail of
  older fintech/bootcamp/starter projects (CRYVESTO, GMX trading bots, subscription starters,
  many archived — not relevant here).
- **ClickReserv org** — booking product: `app`, `mfe` (both private, active), `.github`.
- **GitHat-IO** — `create-githat-app`, `nextjs-sdk`, `GitHat-IO.github.io`.
- **QuantLinc / QuantL-Inc** — trading: `gmxQuantL`, `Motivation`.
- **Pursei** — `FamilyAI` (public).
- **NFTeria / Colmado / SebasTN / ClickReserv variants** — mostly `.github` org placeholders.

None of these were modified. Only Access0x1/Access0x1 was read; the rest were merely listed.

## INSTRUCTIONS

1. In `doble196/pursuit-data-project`, search for the link:
   `grep -rniE "data[ _-]?hub|hub\.|lookerstudio|datastudio|streamlit|tableau|powerbi|bigquery|notion\.so|airtable" .`
   plus the README, any `docs/`, `.env*`, deploy configs, and notebook outputs.
2. If nothing, repeat in `doble196/pursuit-ai-native-kit` (same-owner add is allowed there).
3. Deliver the **exact URL** (and where it was found: file + line). If several candidates exist,
   list them all and say which looks canonical.
4. If it's genuinely absent from both repos, say so plainly and ask the user whether the
   "Data Hub" is a Pursuit-program platform link (e.g. an LMS/portal) that never entered git.
5. Do **not** push anything to any Access0x1 repo from that session, and do not publish
   private repo names anywhere public.
