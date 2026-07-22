# 3-Minute Presentation — access0x1-0g

A timed script + slide outline for the demo. Fill the `⟨…⟩` blanks. Total 3:00.
Rule: **show, don't tell** — the live demo is the middle 70 seconds and carries the
pitch. Practice once against a clock.

---

## One-liner (memorize this)

> **access0x1-0g is the trust layer for AI agents: every action is identified,
> private, paid, bounded, and un-extractable — so an agent can safely work for you,
> and one day be owned and traded.** Claude by default, 0G's private TEE on demand.

## The clock

| Time | Beat | Say (fill the blanks) | Show |
| --- | --- | --- | --- |
| **0:00–0:20** | **Hook / problem** | "Everyone's building AI agents that spend money and act for you. Nobody trusts them — because you can't *prove* what they did. ⟨one-line stat or anecdote⟩" | Title slide |
| **0:20–0:45** | **What it is** | "We built the trust layer. An agent that's **identified, private, paid, bounded, un-extractable** — on access0x1's payment rails, powered by 0G." | Slide: the 5 pillars |
| **0:45–1:55** | **LIVE DEMO** (the core) | narrate each receipt as it appears ↓ | The app at `/agent` |
| **1:55–2:20** | **Why 0G** | "The private + verifiable part is 0G: inference runs in a **TEE**, and we get an **attestation** — proof it ran privately, not just a promise. Claude stays the default; 0G plugs in where privacy matters and unplugs if it's ever down." | Slide: Claude ⇄ 0G swap + attestation |
| **2:20–2:45** | **The payoff** | "Because every action is provable, the agent becomes an **asset**. It earns via x402, its memory + track record live on **0G Storage** by hash, and ownership is an access0x1 token — so you can **sell or trade an income-producing agent** with a history a buyer can trust." | Slide: agent-as-RWA |
| **2:45–3:00** | **Close / ask** | "0G brings verification, private compute, and portable storage; access0x1 brings payments, ownership, and RWA rails. ⟨the ask: prize track / feedback / what's next⟩. Thank you." | Closing slide (repo + contact) |

## The demo (0:45–1:55) — script it exactly

Run these in order; each produces a visible receipt. If one fails, skip to the next.

1. **Ask + pay (x402 seller).** Send a question to `/agent`. → Show the **402 →
   payment → streamed answer** and the **`PAYMENT-RESPONSE`** receipt. Say: *"The
   agent just got paid in USDC to answer — one request, one micropayment."*
2. **Flip to private (0G TEE).** Toggle `private` / `AI_PROVIDER=0g` and ask
   something sensitive. → Show the streamed answer **plus the `AI-ATTESTATION`**.
   Say: *"Same agent, now running in 0G's TEE — and here's the proof it ran
   privately."*
3. **Earn AND spend (buyer loop).** Ask something that needs a paid tool. → Show the
   agent **autonomously paying** an allowlisted endpoint (`/api/agent/pay` receipt)
   inside its own answer. Say: *"It just earned and spent in one turn — an actual
   agent economy."*
4. *(optional if time)* **Human-in-the-loop / MEV.** Trigger an over-threshold action
   → **`402 HumanApprovalRequired`**. Say: *"Above a limit, a human approves — and
   the money path is MEV-safe: it reverts rather than get sandwiched."*

## Slides (5, keep them sparse)

1. **Title** — name + one-liner + "Lisbon 0G AI Builder Day."
2. **Problem → 5 pillars** — identified · private · paid · bounded · un-extractable.
3. **Architecture** — the earn/spend loop diagram + Claude⇄0G swap.
4. **Agent-as-asset** — earns (x402) · state on 0G Storage · owned via access0x1 RWA.
5. **Close** — "0G verifies + computes + stores; access0x1 pays + owns." Repo/contact + the ask.

## Fill-in checklist (before you present)

- ⟨Prize track / theme you're submitting to⟩
- ⟨The specific 0G products you actually used in the demo⟩
- ⟨Live numbers: settlement time, fee, model id, chain⟩
- ⟨Repo URL: SebasTN-Rhys/access0x1-0g⟩
- ⟨Team / contact⟩

## Fallbacks (assume the wifi betrays you)

- **Pre-record a 40s screen capture** of the full demo loop; play it if live fails.
- Have **screenshots** of each receipt (`PAYMENT-RESPONSE`, `AI-ATTESTATION`,
  buyer-loop) as static backup.
- If 0G is down, demo on **Claude** and say the line: *"provider seam — it fails open
  to Claude; that's the point."* The failure *is* the feature.
- Keep testnet USDC pre-funded in the payer + agent wallets; don't fund live on stage.

## Judge Q&A — have answers ready

- *"Is this just an OpenAI wrapper?"* → No — Claude default, 0G TEE for verifiable
  private inference; "OpenAI-compatible" is only a wire format.
- *"What's actually on 0G?"* → private compute + attestation, and (stretch) storage of
  receipts/memory by root hash. Used, not depended on.
- *"What's real vs. vision?"* → The trust-layer demo is real; tradeable-agent is the
  roadmap the trust layer unlocks. Be honest about the line.
- *"Why does access0x1 matter here?"* → payments, ownership, and RWA rails already
  shipped — 0G supplies the verification and compute.
