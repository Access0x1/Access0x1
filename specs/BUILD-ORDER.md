# Spec: the build order + the per-unit pipeline

The dependency-ordered plan the AI agents executed. Each unit became one branch and
one merge-commit PR; what actually landed is the public git history, each PR carrying
its green-proof and merge SHA. The per-tier model policy that drove the pipeline is
disclosed in [`../AI_ATTRIBUTION.md`](../AI_ATTRIBUTION.md).

## The build order (dependency order)

The money spine first; everything else composes it. Steps 1–2 alone are a complete,
judgeable product.

1. **`router-core`** — storage + events → `quote()` (feed + 1h staleness, consumed
   **in** the settlement tx) → `payToken` / `payNative` fee-split (CEI,
   `nonReentrant`, `SafeERC20`, fee-on-transfer reject, `net + fee == gross`) →
   `Ownable2Step` admin. ≥95% coverage + the fuzz invariants.
2. **`token-allowlist`** — real USDC + any real ERC-20. **No demo token.**
3. **`payment-lanes`** — ERC-6909 PaymentLanes (the owned-standard differentiator;
   per-lane asset firewall; zero-custody pull-claim).
4. **`multichain`** — Arc / Base / zkSync via the O(1) hash-map `ChainRegistry`.
5. **`arc-x402`** — Circle x402 batched.
6. **`dynamic-agent`** — server-side AI payment agent (never-negative meter).
7. **`unlink-private`** — private-payout leg.
8. **`checkout-web`** — hosted checkout + dashboard (Next.js).
9. **`ens-resolve`** — ENS resolve + name-math (coinType per chain).
10. **Stretches** — `session-grant` (ERC-7702 / ERC-6492), `cre-notify`,
    `walrus-host`, `metamask-snap`, plus the commerce quintet
    (`subscriptions` / `bookings` / `invoices` / `giftcards` / `nft`) and `house-token` /
    `name-math`, all composing the router + SessionGrant spine.

## The first-party surface that resulted

13 contracts under [`../src/`](../src): `Access0x1Router`, `ChainRegistry`,
`PaymentLanes`, `SessionGrant`, `Access0x1Receiver`, `HouseToken`,
`HouseTokenFactory`, `NameMath`, `Access0x1Subscriptions`, `Access0x1Bookings`,
`Access0x1Invoices`, `Access0x1GiftCards`, `Access0x1Nft` (+ the internal `OracleLib`
and per-contract interfaces). One command — `make deploy-arc|deploy-base-sepolia|deploy-zksync-sepolia`
→ [`../script/DeployAll.s.sol`](../script) — deploys + wires the whole set in one
broadcast.

## The per-unit pipeline (how each unit was driven)

One feature branch, e.g. `feat/router-core`:

1. **Sonnet** (research advisors) → research + **pseudocode** + tests-as-spec + the
   exact constants/addresses. **No code.** Hands the packet down.
2. **Opus** (implementer) → implements the pseudocode **one function per commit**,
   gate green, pushes the branch.
3. **Sonnet** (reviewer) → read-only per-function review (COMMIT / FIX-FIRST).
4. **Fable** (red-team) → adversarial exploit tests against the live `src/` under
   `test/attack/**`; a break = a failing PoC handed **back** to step 2.
5. **Fable** (orchestrator) → runs the gate, commits, pushes, opens the draft PR.
   **The owner merges** (merge commit, never squash).

## The code boundary the pipeline enforces

- Only **Opus** authors/edits production code (`src/`, `web/`, the SDK, scripts,
  config) and standard tests.
- The **Fable red-team** writes only under `test/attack/**` — it never touches
  `src/`; when it breaks something, Opus fixes it.
- **Sonnet** never writes final code — it hands pseudocode to Opus.

## Verifying spec → output

The public PR list is the index: one merge-commit PR per unit — *agent-branch ·
what · green-proof · merge SHA*. The per-function commits inside each PR are the
public git log. Read the PR list first, then the log; the code is opened only when
the two don't answer the question.
