/**
 * @file facts.ts — the judge-facing knowledge base for the /ask assistant.
 *
 * This is a PUBLIC, generic, grounded brief on Access0x1. Every claim here is
 * sourced from the actual repo (README.md, src/*, audit/REPORT.md +
 * audit/FINDINGS.md, web/lib/* sponsor seams) and is written to be true on a
 * testnet build — there are NO mainnet claims and NO invented addresses.
 *
 * Doctrine for the assistant that consumes this module (see app/api/ask/route.ts):
 *  - Answer ONLY from these facts. If a question is not covered, say so and tell
 *    the asker to ask the team — never invent a contract address, a tx hash, a
 *    number, or a claim.
 *  - It is honest about scope: testnet only, internal engineering audit (not a
 *    third-party audit), no mainnet deployments.
 *
 * Keeping the knowledge base as data (plus a single composed string) makes it
 * cheap to unit-test the coverage and to feed verbatim into the system prompt.
 */

/** One topic of the knowledge base: a stable id, a human title, and the grounded body. */
export interface FactSection {
  readonly id: string
  readonly title: string
  readonly body: string
}

/**
 * The grounded sections. Each body is plain prose the model can quote from. The
 * order is roughly "what is it → the invariants → pricing → agents → commerce →
 * chains → sponsors → on/off-chain split → built-this-weekend → proof → business
 * model" so the composed brief reads top-to-bottom like a booth pitch.
 */
export const FACT_SECTIONS: readonly FactSection[] = [
  {
    id: 'what-is-it',
    title: 'What Access0x1 is',
    body:
      'Access0x1 is an open-source (MIT), multi-chain, zero-custody layer for getting a ' +
      'business onchain: USD-priced onchain payments, a commerce suite (subscriptions, ' +
      'bookings, invoices, gift cards, NFTs), and identity/auth — white-label for ' +
      'non-coders and agent-native. A business registers once and accepts USD-priced ' +
      'payments in USDC with a single link: no per-merchant contract to deploy, no custody. One ' +
      'shared, multi-tenant Access0x1Router serves every merchant; a permissionless ' +
      'registerMerchant returns a merchantId and the caller owns only their own config. ' +
      'It is built so a developer writes NO Solidity to integrate — they point a drop-in ' +
      'checkout at a router address.',
  },
  {
    id: 'zero-custody',
    title: 'Zero custody and the net + fee == gross invariant',
    body:
      'The router never holds merchant funds. Settlement is atomic in a single ' +
      'transaction: pull the gross from the payer, split an exact capped fee, and push ' +
      'the net to the merchant — all in one tx. The router\'s steady-state balance is ' +
      'zero. A single total fee splits two ways: the platform cut always lands at the ' +
      'treasury (a merchant can never redirect it) and the merchant surcharge at the ' +
      'merchant\'s recipient, and the invariant net + platformFee + merchantFee == gross ' +
      'holds exactly. No payment is ever charged more than MAX_FEE_BPS (10%), even after ' +
      'a fee change under an existing surcharge. The only native the router can ever hold ' +
      'is value owed back through claimRescue when a payee contract rejects a push (the ' +
      'receipt still stands — funds are never stuck). This is proven by fuzz invariants, ' +
      'not just asserted.',
  },
  {
    id: 'refund-never-blocked',
    title: 'The refund-never-blocked invariant',
    body:
      'Money paths roll back rather than swallow, and refunds and rescues are never ' +
      'blocked. In the Bookings deposit-escrow primitive a refund is unconditional: a ' +
      'failed refund push lands in a per-token pull-map the payer can later claim, and a ' +
      'stale or dead price oracle on a resolution leg yields a zero fee and refunds ' +
      'everything. On the router, a failed push is queued to a pull-pattern claimRescue ' +
      'that stays open even while the contract is paused. The design principle is that a ' +
      'payee being uncooperative or an oracle being down can never trap a payer\'s money.',
  },
  {
    id: 'usd-pricing-oracle',
    title: 'Chainlink USD pricing in-transaction and oracle staleness handling',
    body:
      'Every payment is priced in USD. quote() reads a Chainlink <token>/USD Data Feed ' +
      'INSIDE the settlement transaction (not as a frontend preview), through a staleness ' +
      'guard in the internal OracleLib library. So the price that settles is the price ' +
      'on-chain at settlement. OracleLib enforces a staleness window and a ' +
      'completed-round check; a stale, incomplete, or dead feed reverts the pay path (or, ' +
      'on a refund leg, degrades to a zero fee and full refund) rather than settling on a ' +
      'bad price. Decimals are read live from both the feed and the token, which safely ' +
      'handles the Arc trap where native USDC is 18 decimals, ERC-20 USDC is 6 decimals, ' +
      'and the feed is 8 decimals.',
  },
  {
    id: 'agent-sessions',
    title: 'Agent SessionGrant mandate (ERC-7702 / ERC-6492) and x402',
    body:
      'SessionGrant is the "sign once → budget-scoped, time-bounded agent session" ' +
      'primitive. An owner authorizes a delegate to spend up to a budget until an expiry ' +
      'with no per-spend co-signature; it is a pure authorization ledger and never holds ' +
      'funds. It is built on two owned ERCs: ERC-7702 account delegation, where an EOA ' +
      'that has set its code to an Access0x1 delegate can openSession directly; and ' +
      'ERC-6492 predeploy signatures, where openSessionFor validates a relayed EIP-712 ' +
      'grant against EOA / ERC-1271 / ERC-6492 so a counterfactual smart account can ' +
      'authorize a session before it has any deployed code (the "zero wallet deploy" ' +
      'property). On the web side an x402 seam (web/lib/x402.ts) lets an agent settle ' +
      'machine-payable HTTP requests against this rail.',
  },
  {
    id: 'commerce-quartet',
    title: 'The commerce quartet',
    body:
      'Four vertical-agnostic commerce primitives COMPOSE the money spine rather than ' +
      're-implementing it: Subscriptions (recurring, USD-priced, tiered billing — a ' +
      'subscription IS a budget-scoped SessionGrant; each renew debits the budget and ' +
      'hard-reverts past the cap, the on-chain never-negative spend meter), Bookings ' +
      '(deposit-escrow with a never-blockable refund under an immutable policy snapshot), ' +
      'Invoices (a USD-priced pay-once payment request; OPEN → PAID|VOID is one-way and ' +
      'absorbing so a replayed pay reverts), and GiftCards (USD-priced prepaid balance ' +
      'plus a merchant-scoped coupon registry; a debit can never drive a balance negative ' +
      'and no ERC-20 ever enters the contract). Every money leg in the quartet routes ' +
      'through Access0x1Router.payToken / payNative and every USD→token price is read ' +
      'in-tx through Access0x1Router.quote, so the router\'s audited invariants carry to ' +
      'them unchanged. They need no separate router-side registration.',
  },
  {
    id: 'contracts',
    title: 'The contract surface (12 first-party contracts)',
    body:
      'The first-party surface is 12 contracts plus one internal library and 8 ' +
      'interfaces: Access0x1Router (the zero-custody money spine), PaymentLanes (an ' +
      'ERC-6909 non-custodial receipt ledger — a lane is keccak256(chainId, asset, ' +
      'recipient) and a cross-asset firewall guarantees a lane only releases the asset ' +
      'that funded it), SessionGrant (ERC-7702/6492 agent auth), ChainRegistry (a ' +
      'per-chain reference map, a sidecar with no value path), Access0x1Receiver (a ' +
      'Chainlink-CRE "notified settlement" audit consumer, off the money path), ' +
      'HouseTokenFactory + HouseToken (a non-custodial factory: a business deploys its ' +
      'OWN ERC-20 and gets both ownership and the full supply in the same tx, so the ' +
      'factory holds no key or balance), the four commerce primitives (Subscriptions, ' +
      'Bookings, Invoices, GiftCards), and NameMath (a pure on-chain ENS brand layer that ' +
      'derives a deterministic color + identicon SVG from a namehash). The internal ' +
      'OracleLib is the Chainlink staleness guard, inlined into the router. Everything is ' +
      'Solidity 0.8.28 (EVM cancun, via_ir, optimizer 200 runs) on OpenZeppelin 5.x and ' +
      'Chainlink contracts 1.5.0.',
  },
  {
    id: 'multi-chain',
    title: 'Multi-chain deployment',
    body:
      'Arc (Circle), Base Sepolia, and zkSync Sepolia are the deployed settlement ' +
      'testnets. script/DeployAll.s.sol is a chain-aware ' +
      'one-command entrypoint: a single make deploy-arc (or deploy-base-sepolia / deploy-zksync-sepolia, ' +
      'plus Ethereum/Arbitrum/Optimism/Polygon/Avalanche/BNB/Scroll/Linea/Mantle/Blast/' +
      'Unichain testnets) deploys and wires the whole first-party surface in one ' +
      'broadcast. HelperConfig reads the right env block from a block.chainid ladder, so ' +
      'the same script targets every chain by switching --rpc-url. Any address that is ' +
      'not yet confirmed resolves to address(0) and is skipped, never wired. Signing is ' +
      'keystore-only (cast wallet --account, never --private-key) and the deployer is a ' +
      'burner key. Live deploys read every address from the environment — never a ' +
      'hardcoded address.',
  },
  {
    id: 'arc-usdc-native-gas',
    title: 'Arc\'s native gas token is USDC',
    body:
      'Arc Testnet is one of Access0x1\'s supported settlement chains, and its native ' +
      'gas token is USDC itself — an architectural fact about the chain, not a claim ' +
      'about checkout uptime. A payment on Arc needs no separate gas coin and no ' +
      'Paymaster contract. The same payToken(USDC) path also runs on Base Sepolia and ' +
      'zkSync Sepolia.',
  },
  {
    id: 'sponsors',
    title: 'Sponsor integrations',
    body:
      'Access0x1 is a thin layer of its own code on top of sponsor infrastructure. ' +
      'Chainlink: quote() reads a <token>/USD Data Feed in-tx through OracleLib, and ' +
      'Chainlink CRE backs the off-money-path audit consumer Access0x1Receiver. ' +
      'Circle + Arc: USDC is Arc\'s native gas token, so a payment there needs no ' +
      'Paymaster code, and a Circle Gateway / x402 seam (web/app/api/gateway/*) lets a seller read and ' +
      'withdraw their settled USDC. Dynamic (web/lib/dynamic.ts): an email sign-in ' +
      'becomes an embedded wallet so a buyer who has never held a wallet can still complete ' +
      'a USDC checkout. Unlink (web/lib/unlink): a confidential withdrawal leg lets a ' +
      'merchant shield and move settled USDC without exposing the amount, off the money ' +
      'path. World ID (web/components/WorldIdGate.tsx): an optional one-tap ' +
      'proof-of-personhood gate that sits in front of settlement and degrades to standard ' +
      'checkout if misconfigured. OIDC (web/lib/oidc): server-side verification of a ' +
      'provider-signed ID token (e.g. Sign in with Google) that records a verified user ' +
      'or agent. ENS (web/lib/ens.ts, web/lib/ens-subnames.ts): ENSIP-19 verified ' +
      'merchant identity at checkout (forward == reverse) plus gasless Namestone subnames ' +
      'written to ENS text records. Walrus (web/lib/walrus.ts): publishes the checkout ' +
      'and receipt blobs to Walrus (Sui decentralized storage) so the checkout has no ' +
      'single host to take down. Every sponsor seam is env-gated and fail-soft — blank ' +
      'config means a clean no-op, never a fabricated value.',
  },
  {
    id: 'on-chain-vs-off-chain',
    title: 'What is on-chain vs off-chain',
    body:
      'On-chain: the entire money path and its invariants — registerMerchant, ' +
      'quote/payNative/payToken, the fee split, claimRescue, the ERC-6909 receipt ledger ' +
      '(PaymentLanes), the ERC-7702/6492 agent authorization ledger (SessionGrant), the ' +
      'commerce quartet lifecycle/escrow, the house-token factory, the ChainRegistry ' +
      'reference, and the CRE audit log. Off-chain (the web app, web/): the white-label ' +
      'checkout UI and embed, merchant branding, the Dynamic embedded-wallet login, the ' +
      'World ID / OIDC / ENS verification seams, Unlink private payouts, the Circle ' +
      'Gateway balance/withdraw helpers, x402 request settlement, and Walrus publishing. ' +
      'The audited, zero-custody money path is OracleLib → Access0x1Router; every ' +
      'sponsor/identity/receipt feature is a deliberate sidecar the router never blocks ' +
      'on by construction.',
  },
  {
    id: 'built-this-weekend',
    title: 'What was built this weekend vs boilerplate',
    body:
      'Built for this event: all 12 first-party contracts and their invariants (the ' +
      'router, PaymentLanes, SessionGrant, ChainRegistry, Access0x1Receiver, the ' +
      'HouseToken factory/token, the four commerce primitives, NameMath, OracleLib), the ' +
      'minimal audited implementations of the three owned ERCs (6909 / 7702 / 6492), the ' +
      'multi-chain deploy scripts, the white-label web checkout, and the thin integration ' +
      'code for each sponsor seam. NOT built here (the boilerplate Access0x1 stands on): ' +
      'OpenZeppelin 5.x, the Chainlink Data Feeds and CRE infrastructure, Circle/Arc and ' +
      'USDC, Dynamic, World ID, Unlink, Namestone/ENS, and Walrus/Sui. The honest framing ' +
      'is that the sponsors did the hard parts and Access0x1 is the glue plus the audited ' +
      'money spine on top.',
  },
  {
    id: 'proof',
    title: 'The test and audit proof',
    body:
      'The proof is in the suites. forge test runs 864 contract tests green across 84 ' +
      'suites (unit + adversarial/attack + invariant + integration + fuzz + fork), 0 ' +
      'failed, 0 skipped. The web vitest suite runs 768 tests green across 74 test files, ' +
      '0 failed. Combined: 1,617 tests green. The Access0x1Router has 100% line, ' +
      'statement, branch, and function coverage; overall first-party coverage is ~98% ' +
      'lines / ~98% statements / ~89% branches / ~99% functions (forge coverage with ' +
      '--ir-minimum). There are 31 fuzz invariants that hold under fail_on_revert with 0 ' +
      'reverts: 6 router money invariants (native conservation, token conservation, ' +
      'platform cut always to treasury, zero-custody residual, merchant isolation, ' +
      'effective fee ≤ MAX_FEE_BPS), 3 PaymentLanes conservation invariants, and 6 each ' +
      'for Bookings, Invoices, and Subscriptions plus 4 for GiftCards (including the ' +
      'cross-asset firewall). Static analysis: Slither v0.11.5 ran clean (31 results ' +
      'across 12 detectors, all triaged as false-positive / by-design / justified) and ' +
      'Aderyn v0.1.9 produced 4 High + 11 Low, all triaged. IMPORTANT: this is an ' +
      'internal engineering audit and adversarial-testing record, NOT a third-party ' +
      'audit and not a substitute for one — mainnet is gated on an independent ' +
      'third-party audit.',
  },
  {
    id: 'security-posture',
    title: 'Security posture',
    body:
      'SafeERC20 on token transfers, nonReentrant on every pay path, CEI (checks-effects-' +
      'interactions) ordering everywhere, custom errors, events on every state change, a ' +
      'Chainlink staleness guard, fee-on-transfer rejection via a balance-delta check, no ' +
      'unbounded loops, and Ownable2Step admin. Money paths roll back rather than ' +
      'swallow; refunds and rescues are never blocked. Secrets never enter the repo ' +
      '(environment variables plus a cast wallet keystore only) and the deployer is a ' +
      'burner key. No contract address is ever hardcoded — an address that is not on-' +
      'chain is not claimed.',
  },
  {
    id: 'business-model',
    title: 'The business model',
    body:
      'Access0x1 monetizes the platform fee on the settlement split: each payment carries ' +
      'a single capped total fee (≤ MAX_FEE_BPS = 10%) that splits into a platform cut ' +
      '(always routed to the treasury) and an optional merchant surcharge (routed to the ' +
      'merchant\'s own recipient). The merchant sets their own surcharge; the platform ' +
      'cut is the protocol\'s revenue and a merchant can never redirect it. There is no ' +
      'custody and no float — revenue is purely the transparent on-chain fee on real ' +
      'settled volume. The open-source router plus the no-code, white-label checkout and ' +
      'the agent/commerce primitives are the distribution: any business or any app built ' +
      'from the starter template can accept USD-priced onchain payments in minutes, and Access0x1 ' +
      'earns on the volume that flows through the shared router.',
  },
  {
    id: 'scope-honesty',
    title: 'Scope and honesty',
    body:
      'This is an ETHGlobal NY 2026 build and it is testnet only. There are NO mainnet ' +
      'deployments and NO mainnet claims. The on-chain deployment addresses are filled in ' +
      'at deploy time from the broadcast log and are not hand-entered; if an address has ' +
      'not been deployed it is shown as empty, never guessed. Sponsor addresses and ' +
      'endpoints are read from the environment with a "confirm at booth" note. The ' +
      'security audit in the repo is an internal engineering audit, not a third-party ' +
      'audit. If you are asked for a specific live address, a transaction hash, a private ' +
      'key, or any production claim, the honest answer is that those are not part of this ' +
      'testnet build and the asker should confirm with the team at the booth.',
  },
] as const

/** Short, human one-liner used in the page header and as the assistant's self-description. */
export const JUDGE_BOT_TAGLINE =
  'Ask anything about Access0x1 — the open, zero-custody, USD-priced onchain payments + ' +
  'agents + commerce layer. Answers are grounded in the repo (testnet build).'

/**
 * Compose the full grounded brief as a single string. This is what gets embedded
 * verbatim into the system prompt. Numbered sections keep the model anchored and
 * make "I don't know" the obvious fallback for anything outside them.
 */
export function buildFactsBrief(): string {
  return FACT_SECTIONS.map(
    (s, i) => `## ${i + 1}. ${s.title}\n${s.body}`,
  ).join('\n\n')
}

/**
 * The system prompt for the judge-facing assistant: the grounding rules followed
 * by the full brief. The route passes this as `system`.
 */
export function buildSystemPrompt(): string {
  return [
    'You are the Access0x1 assistant. People exploring Access0x1 (developers, ' +
      'businesses, the curious) ask you questions about the product and you give ' +
      'accurate, grounded answers.',
    '',
    'RULES — follow them exactly:',
    '1. Answer ONLY from the FACTS below. Do not use outside knowledge about other ' +
      'projects or invent details.',
    '2. If the answer is not in the FACTS, say plainly that you do not know and the ' +
      'asker should check with the team. Never guess.',
    '3. NEVER invent a contract address, a transaction hash, a private key, a deployment, ' +
      'a number, or a claim. This is a testnet build with no mainnet claims and no ' +
      'hand-entered addresses.',
    '4. Be honest about scope: testnet only, and the in-repo security audit is an ' +
      'internal engineering audit, not a third-party audit.',
    '5. Be concise and direct. A judge wants the real answer, not marketing. Plain ' +
      'language, no hype, no emojis.',
    '',
    '=== FACTS ===',
    buildFactsBrief(),
    '=== END FACTS ===',
  ].join('\n')
}
