# RULES — stack (always on) — eliminate tool ambiguity

Winners' rule: "LLMs produce dramatically more consistent output when you
eliminate ambiguous tool choices." So the stack is PRESCRIBED, not chosen
per-file. Fill the `<…>` facts at the Friday booths before GO.

## Contracts
- **Foundry** (not Hardhat/Truffle). Solidity **0.8.28** (pinned for zksolc +
  cross-chain EVM compat; latest solc is 0.8.35 — BUILD-CONTRACTS patterns are
  verified for 0.8.24–0.8.28), EVM **cancun**. *(versions verified 2026-06-13)*
- **OpenZeppelin 5.6.1** (`SafeERC20`, `Ownable2Step`), **Chainlink contracts
  1.5.0** (`AggregatorV3Interface`, `CCIPReceiver`) via the official deps — NOT
  copied from audit repos.
- Patterns reused from Cyfrin (OracleLib staleness guard, PriceConverter/
  HelperConfig, invariant handler, CCIP local-simulator scripts) — MIT-only,
  attributed in the file header. Refer to Cyfrin (Updraft) for security + Foundry
  patterns; the `updraft` agent sources them.
- **Install → docs + asset (always):** whenever a tool/library is installed,
  git-clone or download its DOCS into `contract-docs/tooling/` AND its brand logo
  into `lib-assets/` (manifest: `lib-assets/MANIFEST.md`). Already done for
  foundry/aderyn/slither/foundry-zksync.

## Frontend / SDK
- **Next.js 16** (App Router) + React 19 + TypeScript + **Tailwind v4 + shadcn/ui
  (MIT)** (brand tokens provided by the owner). **viem 2.x + wagmi 3** (NOT
  ethers.js). *(latest, verified 2026-06-13)*
- **Dynamic SDK 4.x** (`@dynamic-labs/*`) for embedded-wallet auth + Flow + server
  wallets (the agent).
- `qrcode` for QR; framework-agnostic vanilla `public/embed.js`.

## AI assistant (open-source Q&A)
- **Claude API** via a **server-side** route (own dedicated key — see
  `security.md`). Reference the `claude-api` skill. Never call Claude from the
  browser.

## Chain facts (FILL the remaining `<…>` from the booths — never guess; `harness/project-CLAUDE.md` is the source of truth, keep in sync)
- Arc RPC: `<…>` · chain id: `5042002` (`eip155:5042002`, verified Jun 12) · explorer: `https://testnet.arcscan.app`
- Chainlink on Arc — ETH/USD feed: `<…>` · USDC/USD feed: `<…>` · CCIP router: `<…>` · chain selector: `<…>` · live CCIP lane to/from Arc: `<confirm at booth>`
- USDC (Arc testnet): `0x3600000000000000000000000000000000000000` (USDC IS Arc's native gas — system contract, verified) · Gateway Wallet: `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` · LINK: `<…>` · ENS: `merchant.access0x1.eth`
- GOTCHAS to record as found (so the agent doesn't rediscover mid-build): Arc
  fee model, feed decimals (8), CCIP lane availability, CORS on the RPC.
