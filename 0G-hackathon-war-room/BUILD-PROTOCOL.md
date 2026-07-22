# BUILD-PROTOCOL.md — the war room rules

**Think like a pursuit war room: one objective at a time, verified, before the next.**
This is how we build access0x1-0g. It is not a suggestion — it is the law of this
repo. Agents are fast; that speed is only safe under strict sequencing.

## The one law

> **ONE thing at a time. Strictly.** Build the smallest shippable slice, prove it
> works, push it, checkpoint — and only THEN pick the next one thing. Never two.

If you feel the urge to add "while I'm here…", stop — that is a second thing. Write
it down for later and finish the first.

## The loop (run it for every single change)

1. **NAME** the one thing — the smallest slice that is independently shippable and
   demonstrable. If it can be split, it's still two things; split it.
2. **BUILD** only that. Touch only the files that slice needs.
3. **VERIFY** — the agent's job is to *verify things*, not to claim them:
   - Gate green: `npm run typecheck && npm run lint && npm test && npm run build`.
   - Behavior proven: run the actual path and see it work (a test or a live call),
     not "should work." No claim without evidence (Law #4).
4. **PUSH** that one thing — one focused PR into `0g-dev`.
5. **CHECKPOINT** — confirm it's green/merged, note it done, THEN choose the next one
   thing. A checkpoint is a full stop, not a rolling handoff.

## Strict sequencing (do not reorder)

- **Core before stretch.** Prompt 1 (provider seam + x402 gate) must be fully built,
  verified, and pushed before ANY of Prompts 2–5 begin.
- **One prompt = one thing = one PR.** Never open two prompts in parallel.
- **Test the major steps.** After each prompt, run the relevant Verify checklist
  (README) end-to-end before advancing. A major step untested is a major step unbuilt.
- **Red gate = stop.** A failing gate or an unproven behavior blocks the next thing.
  Fix forward or revert; never stack a new thing on a broken one.

## Use agents for what they're good at

- **Good at:** a well-specified single slice, mechanical/parallel search, drafting
  tests, and **adversarial verification** (prove the claim wrong before trusting it).
- **Not trusted to:** decide a slice is "done." A checkpoint — a human or an explicit
  test — declares done. The agent proposes; verification disposes.
- Every step must **verify things**: identity, payment, attestation, gate, behavior.
  Verification is the product (the whole thesis is a *trust* layer) and the method.

## Definition of done (per single thing)

- [ ] Scope was ONE slice, nothing extra crept in.
- [ ] Gate green (typecheck · lint · test · build).
- [ ] Behavior demonstrated end-to-end (test or live call), evidence in the PR.
- [ ] Pushed as one focused PR into `0g-dev`.
- [ ] Checkpoint recorded; next one thing named.

## The order of things (the only backlog that matters)

1. **Prompt 1 — CORE:** provider seam (Claude default, 0G swap) + x402 gate. ← start here, finish, verify, push.
2. **Prompt 2:** autonomous buyer loop.
3. **Prompt 3:** 0G chain settlement / 0G Storage.
4. **Prompt 4:** human-in-the-loop approval.
5. **Prompt 5:** MEV-safe swap leg.

Each line is a full stop. Do 1 completely. Then 2. Never 1-and-2.
