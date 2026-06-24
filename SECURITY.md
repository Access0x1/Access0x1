# Security Policy

Access0x1 is a **non-custodial, on-chain payments + auth + agents** layer. The code
is public from the first commit and deploys to live testnets, so we treat security
reports as a first-class contribution. Thank you for helping keep it safe.

## Scope at a glance

- **Contracts** (`src/**`) — the money spine (`Access0x1Router`, `OracleLib`,
  `PaymentLanes`, `SessionGrant`), the commerce set (`Access0x1Subscriptions`,
  `Access0x1Bookings`, `Access0x1Invoices`, `Access0x1GiftCards`, `Access0x1Nft`,
  `Access0x1Escrow`, `Refunds`, `Receivables`, `SplitSettler`), and the sidecars
  (`ChainRegistry`, `PriceOracleAdapter`, `Access0x1Receiver`, `AutomationGateway`,
  `GaslessPayIn`, `HouseToken`/`HouseTokenFactory`, `NameMath`,
  `Access0x1ProvenanceRegistry`). The system contracts are UUPS-upgradeable
  (ERC1967 proxy + `initialize`), so proxy/upgrade-path issues (uninitialized impl,
  storage-layout collisions, an unauthorized `upgradeToAndCall`) are in scope too.
- **Web app + API routes** (`web/**`) — the hosted checkout, the server-side API
  routes, the AI assistant proxy.
- **SDK + embed** (`packages/**`, `web/public/embed.js`) — the drop-in integration
  surface.
- **MetaMask Snap** (`snap/**`) and the **subgraph** (`subgraph/**`).

> **Current status: testnet only.** There are no mainnet deployments and no mainnet
> claims. A finding is still valuable even if it is only *production-blocking* rather
> than *exploitable on testnet right now* — we are hardening toward a real-user
> launch, so please report it.

## Reporting a vulnerability

**Please report privately. Do not open a public GitHub issue, pull request, or
discussion for a security vulnerability**, and do not disclose it publicly until we
have published a fix.

Use **GitHub's private vulnerability reporting** — the preferred channel because it
keeps the report confidential and threaded with the maintainers and requires no
shared secret:

1. Go to the repository's **Security** tab →
   <https://github.com/Access0x1/Access0x1/security/advisories>.
2. Click **Report a vulnerability** and fill in the advisory form.

This opens a private security advisory visible only to you and the maintainers.

If private advisory reporting is unavailable to you, open a **minimal** GitHub issue
that says only *"security report — please open a private channel"* (no details), and
a maintainer will follow up to take the report privately.

## What to include

The more of this you can provide, the faster we can confirm and fix:

- The affected component and file path(s) (and a commit hash if you can).
- The vulnerability class (e.g. reentrancy, access-control gap, oracle manipulation,
  fee-math error, upgrade-path / storage-collision, SDK receipt-confusion (resolving a
  payment against the wrong on-chain event), XSS / open redirect, auth bypass, SSRF,
  replay).
- The impact — what an attacker gains (funds, identity, data, denial of service).
- A reproduction: a failing `forge` test or PoC under `test/attack/**` for contracts,
  or concrete request/response steps for the web surface, is ideal.
- Any suggested fix or mitigation.

## Our commitment

- **Acknowledgement** within **3 business days** of your report.
- An initial **severity assessment and triage** within **7 business days**.
- We will keep you updated on remediation progress and coordinate a **disclosure
  timeline** with you, and credit you in the fix (advisory + release notes) unless you
  prefer to remain anonymous.
- We ask for reasonable time to ship a fix before any public disclosure.

## Safe harbor

We will not pursue or support legal action against anyone who, in good faith:

- reports a vulnerability through the private channel above,
- makes a good-faith effort to **avoid privacy violations, data destruction, and
  service interruption**, and
- uses only **testnet** assets and their own accounts — never another user's data,
  funds, or wallet.

Testing must stay within the scope above and must not target third-party
infrastructure (Chainlink, Circle/Arc, Dynamic, World ID, ENS, npm, GitHub, or any
RPC provider). Report findings in their systems to them directly.

## Out of scope

- Findings that require a compromised user device, a malicious browser extension, or
  social engineering of a maintainer.
- Best-practice / hardening suggestions with no demonstrable impact — those are very
  welcome as a normal GitHub issue or pull request, not a security report.
- Vulnerabilities in dependencies that are already public and patched upstream (open a
  normal PR bumping the dependency instead).

## Reward

This is an open-source hackathon project with no funded bug-bounty program; we cannot
offer monetary rewards at this time. We are grateful for every report and will credit
researchers publicly in the corresponding security advisory.
