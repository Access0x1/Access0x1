# Changelog

All notable changes to Access0x1 are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Testnet only — and we say so.** Access0x1 is an ETHGlobal NY 2026 build.
> Every contract is deployed to **public testnets only**; there are **no mainnet
> deployments and no mainnet claims**. The packages (`@access0x1/react`,
> `create-access0x1`) are at `0.1.0` and are **git-distributed — consumed straight
> from this GitHub repo, not published to any npm registry (by design)**. Consume
> the SDK as a git dependency (`github:Access0x1/Access0x1#main`) or vendor it, and
> scaffold with `npx degit …/templates/starter`, as the docs describe. Because
> nothing has been tagged yet, the current state lives under **[Unreleased]**; it
> will be cut to a tagged version on the first release.
>
> Entries are dated, not invented. Deployment claims here are read from the committed
> `broadcast/DeployAll.s.sol/<chainId>/` records and the live tables in
> [`README.md`](README.md) and [`docs/CHAIN-ADDRESSES.md`](docs/CHAIN-ADDRESSES.md) —
> an address that isn't on-chain isn't claimed.

## [Unreleased]

### Added

- **`/journey` — the ordered business lifecycle** ([`web/app/journey`](web/app/journey/page.tsx)):
  a wallet walks the order a real business operates — connect → `registerMerchant` →
  publish a subscription plan (`setPlan`) → create an invoice (`createInvoice`) → issue a
  gift card (`issueCard`) → share the hosted `/m/<id>` checkout link — each on-chain step
  signed by the connected wallet and confirmed by its parsed creation event
  ([`web/lib/journey/sellables.ts`](web/lib/journey/sellables.ts)). Steps unlock strictly
  in order via a pure, unit-tested state machine
  ([`web/lib/journey/steps.ts`](web/lib/journey/steps.ts)).
- **`/simulate` — the on-chain cost simulator** ([`web/app/simulate`](web/app/simulate/page.tsx)):
  upload an SVG (or raster) and get a provable estimate of what storing it on-chain
  *would have cost if it just ran* — four storage strategies (calldata + keccak anchor,
  SSTORE2 code storage chunked at EIP-170, base64 tokenURI mint, raw storage slots)
  priced from cited protocol constants with a line-by-line formula breakdown
  ([`web/lib/onchain-svg/estimate.ts`](web/lib/onchain-svg/estimate.ts)), cross-checked
  against the live testnet via a zero-value `eth_estimateGas` probe and priced in USD
  through the router's own oracle-guarded `quote()`
  ([`web/app/api/onchain-estimate`](web/app/api/onchain-estimate/route.ts)). Nothing is
  broadcast.
- **Multi-tenant money spine** — a single shared
  [`Access0x1Router`](src/Access0x1Router.sol) prices a USD-denominated charge into
  the pay-in token through a Chainlink feed read *inside the settlement transaction*,
  splits an exact fee, and pushes the net to the merchant in the same tx. The contract
  never holds merchant funds.
- **Commerce surface** on top of the router — subscriptions, bookings, invoices, gift
  cards, escrow, refunds, and receivables
  ([`Access0x1Subscriptions`](src/Access0x1Subscriptions.sol),
  [`Access0x1Bookings`](src/Access0x1Bookings.sol),
  [`Access0x1Invoices`](src/Access0x1Invoices.sol),
  [`Access0x1GiftCards`](src/Access0x1GiftCards.sol),
  [`Access0x1Escrow`](src/Access0x1Escrow.sol), [`Refunds`](src/Refunds.sol),
  [`Receivables`](src/Receivables.sol)).
- **Tokenization kit** — vanilla, cloneable bases so a clone can tokenize out of the
  box: [`Access0x1RwaToken`](src/Access0x1RwaToken.sol), an ERC-7943 (uRWA)
  compliant-asset NFT (per-tokenId freezing, authorized `forcedTransfer`, overridable
  `canSend`/`canReceive` policy gates enforced at the single `_update` choke-point);
  and [`Access0x1Account`](src/Access0x1Account.sol), a minimal non-upgradeable
  ERC-6551 token bound account (the smart-contract wallet an NFT owns — holder-only
  CALL-only `execute`, a never-reverting return-bomb-hardened EIP-6551 + ERC-1271
  signer surface, and
  ERC-20/721/1155 custody with an ownership-cycle guard on the bound token). The
  EIP-6551 interfaces live under [`src/interfaces/`](src/interfaces/); the official
  reference registry is vendored for tests only
  ([`test/vendor/ERC6551Registry.sol`](test/vendor/ERC6551Registry.sol)) — production
  uses the canonical singleton at `0x000000006551c19487814612e58FE06813775758`.
- **Auth + agent primitives** — ERC-6909 [`PaymentLanes`](src/PaymentLanes.sol)
  multi-token receipts, and ERC-7702 / ERC-6492 [`SessionGrant`](src/SessionGrant.sol)
  for budget-scoped, time-bounded agent allowances authorized with one signature.
- **Swappable pricing seam** — [`PriceOracleAdapter`](src/PriceOracleAdapter.sol) so a
  chain without a Chainlink push feed can price through an alternate oracle (or run
  unpriced) instead of being wired to a placeholder.
- **Chainlink CRE audit consumer** — [`Access0x1Receiver`](src/Access0x1Receiver.sol)
  for notified settlement, off the money path by construction (see [`cre/`](cre/)).
- **React SDK** — [`@access0x1/react`](packages/react) (`0.1.0`): a viem/wagmi-native,
  zero-custody, USD-priced payment button that drops into any React app.
- **Project scaffold** — [`create-access0x1`](packages/create-access0x1) (`0.1.0`) to
  bootstrap an integrator app.
- **Documentation set** — quickstart, getting-started, architecture, glossary, recipes,
  per-chain deploy guides, and a verified [chain-address map](docs/CHAIN-ADDRESSES.md);
  plus a truthful self-audit ([`AUDIT.md`](AUDIT.md)) and security policy
  ([`SECURITY.md`](SECURITY.md)).

### Changed

- **CREATE3 mirror cutover** — the first-party surface now deploys at **one address on
  every chain** via CreateX, so [`Access0x1Router`](src/Access0x1Router.sol) resolves to
  the same address (`0xe92244e3368561faf21648146511DeDE3a475EB5`) on every mirrored
  chain. The salt embeds the deployer EOA, never `block.chainid`. See
  [`docs/MIRROR-CUTOVER.md`](docs/MIRROR-CUTOVER.md). Per-chain router addresses recorded
  before the cutover are treated as stale; the broadcast-derived
  [`web/lib/deployments.ts`](web/lib/deployments.ts) is the source of truth.

### Deployed

- **Testnet broadcast** — deployed on eleven testnets. The CREATE3 mirror is live on
  eight (Arc `5042002`, Base Sepolia `84532`, Ethereum Sepolia `11155111`, Optimism
  Sepolia `11155420`, Avalanche Fuji `43113`, Robinhood `46630`, Arbitrum Sepolia
  `421614`, Celo Sepolia `11142220`) and source-verified on seven of them. Three earlier
  chains (Ethereum Hoodi `560048`, 0G Galileo `16602`, Tempo `42431`) carry pre-mirror
  per-chain deploys. More chains are per-chain ready (`make deploy-<chain>`) but not yet
  broadcast. **No mainnet deployments.**

### Security

- **GaslessPayIn merchant-binding hardening** — the gasless pay-in rails now bind the
  buyer's signature to the exact `merchantId` / `usdAmount8` / `orderId`, closing a
  relayer-redirection defect (a permissionless relayer could settle a buyer's pay-in to a
  *different* merchant, and on the permit rails re-pull the residual allowance). The
  EIP-3009 rail requires `auth.nonce == keccak256(abi.encode(chainid, this, merchantId,
  token, usdAmount8, buyer, orderId))` (a **structured nonce** — no new state; the token's
  single-use marking still provides replay protection). The EIP-2612 / ERC-7597 permit
  rails now require a second, Access0x1-domain **`PayInIntent` EIP-712 co-signature**
  (verified via OZ `SignatureChecker`, so ERC-1271 smart accounts still work) plus a
  single-use `orderId` ledger that defeats the residual-allowance re-pull. Because
  Access0x1 is **testnet-only pre-mainnet**, the `payInWithPermit` / `payInWithPermit7597`
  signatures were changed *directly* (added `maxValue`, `intentDeadline`, `intentSig`)
  rather than adding parallel functions — off-chain signers must emit the structured nonce
  / intent signature in lockstep. One `__gap` slot was consumed for the new `_orderUsed`
  mapping (50 → 49); `EIP712Upgradeable` adds no linear storage. See
  [`GaslessPayIn`](src/GaslessPayIn.sol) and
  [`test/integration/GaslessMerchantBinding.t.sol`](test/integration/GaslessMerchantBinding.t.sol).
- **Truthful self-audit** published in [`AUDIT.md`](AUDIT.md) — states exactly what is
  deployed, tested, and verifiable, and exactly what is a seam or not yet built.
  Test suite and Slither/coverage status are reported in the [README](README.md) badges.

## [0.1.0] - 2026-06-12

### Added

- Initial public build at ETHGlobal NY 2026 — the `router-core` money spine on a public
  branch from the first commit, testnet only.

[Unreleased]: https://github.com/Access0x1/Access0x1/compare/main...HEAD
[0.1.0]: https://github.com/Access0x1/Access0x1/releases/tag/v0.1.0
