# 3-Minute Presentation — access0x1, the EVM-native Agent OS

A timed script + slide outline for the demo. Fill the `⟨…⟩` blanks. Total 3:00.
Rule: **show, don't tell** — the live demo is the middle 70 seconds and carries the
pitch. Practice once against a clock. Competitor-silent: no names, no comparisons.

---

## The hook (open with this — say it verbatim)

> **"We build bots a business can run for the rest of its life — trustless and
> permissionless."**

Then land the how in one breath:

## One-liner (memorize this)

> **access0x1 is the trust layer for AI agents: every action is identified,
> private, paid, bounded, and un-extractable — so an agent can safely work for you,
> for the rest of your business's life, and one day be owned and traded.** Any EVM
> chain, any model backend — swap with one env var.

## The clock

| Time | Beat | Say (fill the blanks) | Show |
| --- | --- | --- | --- |
| **0:00–0:20** | **Hook / problem** | "Everyone's building AI agents that spend money and act for you. Nobody trusts them — because you can't *prove* what they did. ⟨one-line stat or anecdote⟩" | Title slide |
| **0:20–0:45** | **What it is** | "We built the trust layer. An agent that's **identified, private, paid, bounded, un-extractable** — on access0x1's own payment, identity, and storage rails, on plain EVM." | Slide: the 5 pillars |
| **0:45–1:55** | **LIVE DEMO** (the core) | narrate each receipt as it appears ↓ | The app |
| **1:55–2:20** | **Own, don't rent** | "The agent's wallet is a Dynamic MPC server wallet. Its memory is content-addressed on decentralized storage and **anchored on-chain** — verifiable by anyone, owned by you. No vendor account holds its state; nothing can switch it off." | Slide: memory → blobId → anchor tx |
| **2:20–2:45** | **The payoff** | "Because every action is provable, the agent becomes an **asset**. It earns via x402, its track record is anchored by hash, and ownership rides our RWA rails — you can **sell or trade an income-producing agent** with a history a buyer can trust." | Slide: agent-as-asset |
| **2:45–3:00** | **Close / ask** | "Storage, identity, payments, ownership — one stack, any EVM chain, no new blockchain. ⟨the ask: prize track / feedback / what's next⟩. Thank you." | Closing slide (repo + contact) |

## The demo (0:45–1:55) — script it exactly

Run these in order; each produces a visible receipt. If one fails, skip to the next.

1. **Ask + pay (x402 seller).** Send a paid request. → Show the **402 → payment →
   answer** and the **`PAYMENT-RESPONSE`** receipt. Say: *"The agent just got paid
   in USDC to answer — one request, one micropayment."*
2. **Earn AND spend (buyer loop).** Trigger a request that needs a priced tool. →
   Show the agent **autonomously paying** an allowlisted endpoint
   (`/api/agent/pay` receipt) — signed by its **Dynamic MPC wallet**. Say: *"It
   just earned and spent in one turn, from its own wallet — an actual agent
   economy."*
3. **Remember, verifiably (earn → store → own).** Show the same response's
   **`stateAnchor`**: the receipt's Walrus `blobId`, its `contentHash`, and the
   **on-chain anchor tx** on the ProvenanceRegistry. Open the explorer link. Say:
   *"Its memory is content-addressed and anchored on-chain — anyone can verify it,
   only the owner controls it."*
4. *(optional if time)* **Bounded.** Trigger an over-cap action → the budget/mandate
   refusal. Say: *"Above a limit, it stops — bounded authority, human-approvable."*

## Slides (5, keep them sparse)

1. **Title** — name + one-liner.
2. **Problem → 5 pillars** — identified · private · paid · bounded · un-extractable.
3. **Architecture** — the earn/spend loop + memory-anchor diagram.
4. **Agent-as-asset** — earns (x402) · anchored history · owned via RWA rails.
5. **Close** — "Storage, identity, payments, ownership — yours, on any EVM chain."
   Repo/contact + the ask.

## Fill-in checklist (before you present)

- ⟨Prize track / theme you're submitting to⟩
- ⟨Live numbers: settlement time, fee, chain id⟩
- ⟨The agent's Dynamic wallet address + one anchored blobId/tx to show⟩
- ⟨Repo URL⟩
- ⟨Team / contact⟩

## Fallbacks (assume the wifi betrays you)

- **Pre-record a 40s screen capture** of the full demo loop; play it if live fails.
- Have **screenshots** of each receipt (`PAYMENT-RESPONSE`, buyer-loop receipt,
  `stateAnchor` with the explorer page) as static backup.
- If the model backend is down, swap it with the env var and say: *"provider seam —
  the OS doesn't care whose model it is."* The swap *is* the feature.
- Keep testnet USDC pre-funded in the payer + agent wallets; don't fund live on stage.

## Judge Q&A — have answers ready

- *"Is this a wrapper around some AI platform?"* → No — the model backend is a
  one-env-var seam; the product is the trust layer: payments, identity, memory,
  bounds, ownership. All of that is ours, on plain EVM.
- *"What's real vs. vision?"* → Shipped: the x402 earn/spend loop, the live Dynamic
  MPC agent wallet, and verifiable anchored memory — 1,592 tests green. Vision:
  the agent-as-tradeable-asset marketplace on our RWA rails. Be honest about the line.
- *"Why not build your own chain?"* → Because you don't need one. Portable contracts
  on any EVM chain are the more decentralized answer — no vendor L1, no silo.
- *"What about private inference?"* → The seam accepts any backend, including
  TEE-attested providers; attestation headers pass through as receipts when present.
