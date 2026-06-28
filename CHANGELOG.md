# Changelog

All notable changes to Access0x1 are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Status: testnet only.** Access0x1 is pre-1.0. There are no mainnet deployments
> and no mainnet claims; the public API and on-chain interfaces may change between
> `0.x` releases. Versions are tracked across the npm package (`@access0x1/react`)
> and the Solidity contracts in `src/`, which currently move together.

## [Unreleased]

### Added

### Changed

### Fixed

## [0.1.0] - Unreleased

First public development line, built in the open from the first commit. Everything
below is testnet only — see the [README](README.md) and [SECURITY.md](SECURITY.md)
for current deployment status.

### Added

- **Money spine** — `Access0x1Router` with USD-priced settlement, Chainlink Data
  Feed quoting through `OracleLib`'s staleness guard, `SafeERC20`, `nonReentrant`
  pay paths, CEI ordering, custom errors, and fee-on-transfer rejection. Supporting
  contracts: `PaymentLanes`, `SessionGrant`, `PriceOracleAdapter`, `ChainRegistry`.
- **Commerce set** — `Access0x1Subscriptions`, `Access0x1Bookings`,
  `Access0x1Invoices`, `Access0x1GiftCards`, `Access0x1Nft`, `Access0x1Escrow`,
  `Refunds`, `Receivables`, and `SplitSettler`.
- **Sidecars** — `Access0x1Receiver` (Chainlink CRE audit consumer),
  `AutomationGateway`, `GaslessPayIn`, `HouseToken` / `HouseTokenFactory`,
  `NameMath`, and `Access0x1ProvenanceRegistry`. System contracts are
  UUPS-upgradeable (ERC1967 proxy + `initialize`).
- **`@access0x1/react`** — viem/wagmi-native React SDK exposing a drop-in,
  USD-priced, zero-custody crypto payment button.
- **`embed.js`** — a one-tag hosted checkout embed.
- **Starter template** (`templates/starter`) plus `create-access0x1` for scaffolding
  a new app from a local checkout.
- **CREATE3 mirror deploy** — one router address across every supported chain via
  `DeployAll.s.sol`, with each address read from a committed `broadcast/` record.
- **Clear signing** — an [ERC-7730 descriptor](clear-signing/README.md) for the
  router (What-You-See-Is-What-You-Sign), with an ERC-8213 calldata digest fallback.
- **Identity + integration seams** — ENS (ENSIP-19 verified primary name + Namestone
  gasless subnames), OIDC verify-for-all, World ID proof-of-personhood gate, Dynamic
  embedded wallets, Circle/Arc gas-free USDC settlement, Walrus checkout hosting, and
  the Unlink confidential-payout seam. Every seam is env-gated and fail-soft.
- **MetaMask Snap** (`snap/`) and a **subgraph** (`subgraph/`).
- **Test + audit surface** — unit, attack, and invariant suites with money-safety
  invariants, plus slither/aderyn triage tracked in
  [`audit/FINDINGS.md`](audit/FINDINGS.md).

[Unreleased]: https://github.com/Access0x1/Access0x1/compare/main...HEAD
[0.1.0]: https://github.com/Access0x1/Access0x1/tree/main
