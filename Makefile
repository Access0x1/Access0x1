# Access0x1 — Makefile. Run `make` (or `make help`) to see every command.
#
# Foundry here is the zksync fork (installed via foundryup-zksync); ~/.foundry/bin is
# prepended so forge/cast/anvil/chisel resolve in every recipe without touching your
# shell PATH. Deploys are keystore-only: import once with `cast wallet import deployer`
# and set the RPC envs in .env (copy .env.example). NEVER commit .env.

export PATH := $(HOME)/.foundry/bin:$(PATH)
-include .env
ANVIL_SENDER ?= 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
# The cast keystore the deploy targets sign with. Defaults to `deployer`; override in .env to
# match what you actually imported (e.g. DEPLOYER_ACCOUNT=default) — `cast wallet list` shows names.
DEPLOYER_ACCOUNT ?= deployer

# Public RPC defaults — so every `make deploy-<chain>` (and the preview) works with ZERO .env setup.
# A value set in .env always wins (set <CHAIN>_RPC_URL to your Alchemy/Tenderly URL for reliability —
# public endpoints rate-limit). Every endpoint below was verified live + chainId-matched 2026-06-17.
ARC_TESTNET_RPC_URL ?= https://rpc.testnet.arc.network
BASE_SEPOLIA_RPC_URL ?= https://sepolia.base.org
SEPOLIA_RPC_URL ?= https://ethereum-sepolia-rpc.publicnode.com
ARBITRUM_SEPOLIA_RPC_URL ?= https://arbitrum-sepolia-rpc.publicnode.com
OPTIMISM_SEPOLIA_RPC_URL ?= https://sepolia.optimism.io
ZKSYNC_SEPOLIA_RPC_URL ?= https://sepolia.era.zksync.dev
POLYGON_AMOY_RPC_URL ?= https://rpc-amoy.polygon.technology
AVALANCHE_FUJI_RPC_URL ?= https://api.avax-test.network/ext/bc/C/rpc
BNB_TESTNET_RPC_URL ?= https://bsc-testnet-rpc.publicnode.com
SCROLL_SEPOLIA_RPC_URL ?= https://sepolia-rpc.scroll.io
LINEA_SEPOLIA_RPC_URL ?= https://rpc.sepolia.linea.build
MANTLE_SEPOLIA_RPC_URL ?= https://rpc.sepolia.mantle.xyz
BLAST_SEPOLIA_RPC_URL ?= https://sepolia.blast.io
UNICHAIN_SEPOLIA_RPC_URL ?= https://sepolia.unichain.org
ZORA_SEPOLIA_RPC_URL ?= https://sepolia.rpc.zora.energy
FILECOIN_CALIBRATION_RPC_URL ?= https://api.calibration.node.glif.io/rpc/v1
GNOSIS_CHIADO_RPC_URL ?= https://rpc.chiadochain.net
APECHAIN_CURTIS_RPC_URL ?= https://curtis.rpc.caldera.xyz/http
WORLDCHAIN_SEPOLIA_RPC_URL ?= https://worldchain-sepolia.g.alchemy.com/public
ZIRCUIT_GARFIELD_RPC_URL ?= https://garfield-testnet.zircuit.com
CITREA_TESTNET_RPC_URL ?= https://rpc.testnet.citrea.xyz
FLOW_EVM_TESTNET_RPC_URL ?= https://testnet.evm.nodes.onflow.org
CELO_SEPOLIA_RPC_URL ?= https://forno.celo-sepolia.celo-testnet.org

# Verification is OPT-IN. forge REJECTS an empty `--etherscan-api-key`/`--verifier-url` outright (before
# it ever broadcasts), so we pass the verify clause ONLY when its key/URL is set — otherwise the chain
# broadcasts clean and you re-verify later (the broadcast always lands first). ONE Etherscan **V2** key
# (`ETHERSCAN_API_KEY`) verifies every Etherscan-family explorer; set it once in .env.
VERIFY_ES := $(if $(strip $(ETHERSCAN_API_KEY)),--verify --etherscan-api-key $(ETHERSCAN_API_KEY),)
VERIFY_ZK := $(if $(strip $(ZKSYNC_VERIFIER_URL)),--verify --verifier zksync --verifier-url $(ZKSYNC_VERIFIER_URL),)
# Blockscout chains verify the same OPT-IN way: a blank verifier URL would make forge ABORT before it
# broadcasts, so we pass the clause only when the URL is set — else the deploy lands and you re-verify
# later (RESUME=1). Usage in a recipe: $(call bs_verify,$(<CHAIN>_VERIFIER_URL))
bs_verify = $(if $(strip $(1)),--verify --verifier blockscout --verifier-url $(1),)
# RESUME=1 re-uses the existing broadcast (no re-deploy) and just re-attempts verification — the safe
# retry when a flaky explorer 504'd the verify poll AFTER the deploy already landed.
RESUME_FLAG := $(if $(strip $(RESUME)),--resume,)

.DEFAULT_GOAL := help

.PHONY: help install build test test-gas test-scenario coverage coverage-lcov snapshot \
        fmt fmt-check clean sizes storage-layout \
        gate aderyn slither analyze mutation halmos audit anvil \
        deploy-dry deploy-local drive-local deploy-arc deploy-base-sepolia deploy-zksync-sepolia deploy-ethereum-sepolia deploy-arbitrum-sepolia deploy-optimism-sepolia \
        deploy-polygon-amoy deploy-avalanche-fuji deploy-bnb-testnet deploy-scroll-sepolia deploy-linea-sepolia deploy-mantle-sepolia deploy-blast-sepolia deploy-unichain-sepolia \
        deploy-zora-sepolia deploy-filecoin-calibration deploy-gnosis-chiado deploy-apechain-curtis deploy-worldchain-sepolia deploy-zircuit-garfield deploy-citrea-testnet deploy-flow-evm-testnet deploy-celo-sepolia deploy-robinhood-testnet \
        verify-robinhood-testnet verify-ethereum-sepolia verify-base-sepolia verify-optimism-sepolia verify-avalanche-fuji verify-arc verify-all-testnets \
        deploy-ethereum-mainnet deploy-base-mainnet deploy-arbitrum-mainnet deploy-optimism-mainnet deploy-polygon-mainnet deploy-avalanche-mainnet deploy-bnb-mainnet \
        deploy-scroll-mainnet deploy-linea-mainnet deploy-mantle-mainnet deploy-blast-mainnet deploy-unichain-mainnet deploy-zksync-mainnet \
        deploy-zora-mainnet deploy-filecoin-mainnet deploy-gnosis-mainnet deploy-apechain-mainnet deploy-worldchain-mainnet deploy-zircuit-mainnet deploy-citrea-mainnet deploy-flow-evm-mainnet deploy-celo-mainnet deploy-arc-mainnet \
        web-install web-dev web-build web-typecheck web-test web-gate sdk-build \
        vyper-build vyper-test \
        cre-build cre-sim zksync-build all

help: ## Show every command
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

# ── Setup ─────────────────────────────────────────────────────────────────────
install: ## Install all deps: forge submodules + npm (@chainlink) + web + sdk
	git submodule update --init --recursive
	npm install
	cd web && npm install
	cd packages/react && npm install

# ── Contracts (Foundry) ─────────────────────────────────────────────────────────
build: ## Compile the contracts (forge build)
	forge build

test: ## Run all tests: unit + invariant + attack + integration + scenario
	forge test

test-gas: ## Run tests with the per-function gas report
	forge test --gas-report

test-scenario: ## Run ONLY the human-style end-to-end scenario suite (test/scenario/**)
	forge test --match-path 'test/scenario/*'

coverage: ## Test coverage over src/
	forge coverage

# Coverage GATE: emit a machine-readable lcov.info (gitignored) + a summary table. DOCUMENTED
# MINIMUM: 90% line coverage on the money contracts (Router / SessionGrant / the commerce quartet).
# The suite sits well above that today; this target makes the number checkable so a regression shows.
coverage-lcov: ## Coverage as lcov.info (gitignored) + summary — documented floor: 90% lines on money paths
	forge coverage --report lcov --report summary

snapshot: ## Regenerate the gas snapshot (.gas-snapshot)
	forge snapshot

# EIP-170 runtime-size check: every contract must be < 24576 bytes of deployed bytecode. `--sizes`
# prints the runtime + init size per contract and FAILS the build if any runtime exceeds the limit.
sizes: ## forge build --sizes — EIP-170 24KB runtime-size check (fails if any contract is over)
	forge build --sizes

# Auditors verify the storage layout of money contracts (slot packing, no accidental collisions, no
# unexpected re-ordering across versions). Regenerate docs/STORAGE-LAYOUT.md from forge inspect.
storage-layout: ## Regenerate docs/STORAGE-LAYOUT.md from `forge inspect <C> storage-layout`
	@bash script/storage-layout.sh

fmt: ## Format the Solidity (forge fmt)
	forge fmt

fmt-check: ## Check formatting without writing (CI)
	forge fmt --check

clean: ## Remove build artifacts (forge clean)
	forge clean

# ── The gate (run before any commit) ────────────────────────────────────────────
gate: build test fmt-check web-gate ## FULL GREEN GATE: contracts build+test+fmt AND web typecheck+test
	@echo "==> GATE GREEN"

# ── Security / audit ─────────────────────────────────────────────────────────────
aderyn: ## Static analysis (aderyn — auto-skips on the foundry-zksync fork, which aderyn 0.1.9 can't parse)
	@if forge --version 2>/dev/null | grep -qi zksync; then \
		echo "==> aderyn SKIPPED: the active forge is the foundry-zksync fork ('$$(forge --version | head -1)')."; \
		echo "    aderyn 0.1.9 panics on it — both the non-semver version string and the fork's 'osaka'"; \
		echo "    evm default (its bundled cyfrin-foundry-config predates osaka). For a FRESH aderyn report,"; \
		echo "    switch to vanilla foundry (foundryup) and re-run. src/ is unchanged since the committed"; \
		echo "    audit/ run, so the existing aderyn findings remain valid. Continuing the audit (slither + coverage)."; \
	else \
		FOUNDRY_EVM_VERSION=cancun aderyn . --no-snippets; \
	fi

slither: ## Static analysis (slither)
	slither .

# Static-analysis UMBRELLA beyond slither+aderyn. Runs 4naly3er (the Cyfrin/Solodit go-to gas+QA
# pass) via npx when reachable; no-ops gracefully if the network/tool is unavailable, then always
# runs the two installed analysers so `make analyze` is never a dead end.
analyze: ## Umbrella static pass: 4naly3er (npx, best-effort) + aderyn + slither
	@echo "==> 4naly3er (npx @picodes/4naly3er; best-effort, needs network)"
	@npx --yes @picodes/4naly3er@latest analyze src 2>/dev/null \
		&& echo "==> 4naly3er OK (report.md written)" \
		|| echo "4naly3er unavailable (offline or unpublished tag) — skipping; run the two below"
	@$(MAKE) --no-print-directory aderyn
	@$(MAKE) --no-print-directory slither

# MUTATION TESTING — "test the tests." Seeds faults into src/ and re-runs the suite; a SURVIVING
# mutant is a gap in the tests. Tries gambit (Certora) first, then vertigo-rs; no-ops with a clear
# message + install hint if neither is present (mirrors the cre-build style).
mutation: ## Mutation testing (gambit or vertigo-rs); no-op with install hint if neither installed
	@if command -v gambit >/dev/null 2>&1; then \
		echo "==> gambit mutate (Certora) over src/"; \
		gambit mutate --json gambit.conf.json 2>/dev/null || gambit mutate --solc-binary solc src/*.sol; \
	elif command -v vertigo-rs >/dev/null 2>&1; then \
		echo "==> vertigo-rs run (mutation score over the forge suite)"; \
		vertigo-rs run; \
	else \
		echo "mutation: no engine installed. Install ONE of:"; \
		echo "  cargo install --git https://github.com/Certora/gambit  (Certora Gambit)"; \
		echo "  pipx install vertigo-rs                                 (Vertigo-rs)"; \
		echo "then re-run 'make mutation'. See audit/CHECKLIST.md for the documented target."; \
	fi

# HALMOS symbolic execution: prove the money invariants (fee-split conservation, never-negative
# budget) for ALL inputs, not just fuzz samples. Tries to install via uv/pip if absent, then runs the
# check_-prefixed proofs in test/symbolic/. No-ops with a clear message if it cannot be installed.
halmos: ## Symbolic execution (Halmos) over test/symbolic/; installs via uv/pip if absent
	@if ! command -v halmos >/dev/null 2>&1; then \
		echo "==> halmos not found — attempting 'uv tool install halmos'"; \
		(command -v uv >/dev/null 2>&1 && uv tool install halmos) \
			|| (command -v pip3 >/dev/null 2>&1 && pip3 install --user halmos) \
			|| true; \
	fi
	@if command -v halmos >/dev/null 2>&1; then \
		echo "==> halmos over test/symbolic/ (functions prefixed check_)"; \
		forge build --ast >/dev/null 2>&1; \
		halmos --match-contract 'FeeSplitSymbolic|SessionBudgetSymbolic'; \
	else \
		echo "halmos not installed and auto-install failed (offline?). Install:"; \
		echo "  uv tool install halmos    (or)    pip3 install --user halmos"; \
		echo "then re-run 'make halmos'. The check_ proofs live in test/symbolic/."; \
	fi

audit: aderyn slither coverage sizes ## Full audit pass — then see audit/REPORT.md + FINDINGS.md + CHECKLIST.md
	@echo "==> core audit pass done. Optional deeper passes: make halmos | make mutation | make analyze"
	@echo "==> read audit/REPORT.md + audit/FINDINGS.md + audit/CHECKLIST.md"

# ── Local chain ───────────────────────────────────────────────────────────────────
anvil: ## Run a local anvil node
	anvil

# ── Deploy (keystore `deployer`; set RPC + DEPLOYER in .env; mainnet is NOT here) ──
deploy-dry: ## Deploy DRY-RUN — simulation only, no broadcast, no keys
	forge script script/DeployAll.s.sol

deploy-local: ## Deploy to a local anvil (anvil's default unlocked account[0]; no keystore needed)
	forge script script/DeployAll.s.sol --rpc-url http://localhost:8545 --broadcast $(RESUME_FLAG) --unlocked --sender $(ANVIL_SENDER) -vvvv

drive-local: ## Deploy + DRIVE the coffee-shop money flow on a local anvil (run `make anvil` first)
	forge script script/Interactions.s.sol:DriveCoffeeShopLocal \
		--rpc-url http://localhost:8545 --broadcast --unlocked \
		--sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 -vvvv

deploy-arc: ## Deploy to Arc testnet (keystore `deployer`)
	forge script script/DeployAll.s.sol --rpc-url $(ARC_TESTNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(ARC_SCAN_VERIFIER_URL)) -vvvv

deploy-base-sepolia: ## Deploy to Base Sepolia (keystore `deployer`, verified)
	forge script script/DeployAll.s.sol --rpc-url $(BASE_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-zksync-sepolia: ## Deploy to zkSync Sepolia (keystore `deployer`)
	forge script script/DeployAll.s.sol --rpc-url $(ZKSYNC_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) --zksync $(VERIFY_ZK) -vvvv

# Deploy a $1.00 USDC/USD mock feed to ANY chain that has real Circle USDC but no Chainlink USDC/USD
# feed (Linea/Unichain/World Chain/Celo/Optimism Sepolia). Real USDC stays the token; this is the
# missing PRICE feed only (the Arc pattern). Set <CHAIN>_USDC_USD_FEED to the printed address, then
# run that chain's deploy. See script/DeployUsdMockFeed.s.sol + docs/CHAIN-ADDRESSES.md.
deploy-usd-mock-feed: ## Deploy a $1 USDC/USD mock feed to a chain that lacks one — make deploy-usd-mock-feed RPC=<url>
	forge script script/DeployUsdMockFeed.s.sol --rpc-url $(RPC) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) -vvvv

# Compile against the zkEVM (zksolc) — the ONLY way to catch zkSync-specific build/size/opcode issues.
# `forge test` runs the EVM, not the zkEVM (see docs/ZKSYNC-TESTING.md): EVM-green != zkSync-green.
# Requires the foundry-zksync fork (foundryup-zksync); no-ops with a clear message if --zksync is
# unsupported by the installed forge.
zksync-build: ## forge build --zksync (zksolc) — zkEVM build check; see docs/ZKSYNC-TESTING.md
	@if forge build --zksync --help >/dev/null 2>&1; then \
		echo "==> forge build --zksync (zksolc); EVM-green != zkSync-green — this is the zkEVM build"; \
		forge build --zksync; \
	else \
		echo "this forge has no --zksync (not the foundry-zksync fork). Install:"; \
		echo "  curl -L https://raw.githubusercontent.com/matter-labs/foundry-zksync/main/install-foundry-zksync | bash"; \
		echo "  foundryup-zksync"; \
		echo "then re-run 'make zksync-build'. See docs/ZKSYNC-TESTING.md."; \
	fi

# ── Web app (Next.js) ─────────────────────────────────────────────────────────────
web-install: ## Install the web app deps
	cd web && npm install

web-dev: ## Run the web app locally (next dev)
	cd web && npm run dev

web-build: ## Production build of the web app (next build)
	cd web && npm run build

web-typecheck: ## Web typecheck (tsc --noEmit)
	cd web && npm run typecheck

web-test: ## Web unit tests (vitest, integration excluded)
	cd web && npm test

web-gate: ## Web gate: embed check + typecheck + unit tests
	cd web && npm run gate

sdk-build: ## Typecheck the @access0x1/react SDK
	cd packages/react && npx tsc --noEmit

# ── Vyper conformance demonstrator (ISOLATED under vyper/; NOT in the Foundry gate) ──────────────
# `src` in foundry.toml is "src", so forge never sees vyper/*.vy. These targets no-op with a clear
# message when the snake toolchain (vyper + mox) is absent, so the repo still builds without it.
# Toolchain: `uv tool install moccasin` + `uv tool install vyper` (Python 3.13). See vyper/README.md.
vyper-build: ## Compile the Vyper NameMath demonstrator (cancun); no-op if vyper not installed
	@if command -v vyper >/dev/null 2>&1; then \
		vyper --evm-version cancun vyper/src/NameMath.vy >/dev/null && echo "==> vyper-build OK (cancun)"; \
	else \
		echo "vyper not installed — skipping (see vyper/README.md: uv tool install vyper)"; \
	fi

vyper-test: ## Run the Vyper==Solidity byte-for-byte conformance test; no-op if mox not installed
	@if command -v mox >/dev/null 2>&1; then \
		cd vyper && mox test; \
	else \
		echo "mox (moccasin) not installed — skipping (see vyper/README.md: uv tool install moccasin)"; \
	fi

# ── Chainlink CRE (Notified-Settlement workflow; deploy is Early-Access) ──────────
cre-build: ## Build the CRE workflow (needs the CRE CLI)
	cd cre && cre workflow build || echo "CRE CLI not installed — see docs/chainlink-cre.md"

cre-sim: ## Simulate the CRE workflow (the demoable artifact; deploy is Early-Access)
	cd cre && cre workflow simulate || echo "CRE CLI not installed — see docs/chainlink-cre.md"

# ── Everything ──────────────────────────────────────────────────────────────────
all: install gate ## Install everything, then run the full green gate

# ── More test networks (keystore `deployer`; set each RPC + *SCAN_API_KEY in .env) ──
deploy-ethereum-sepolia: ## Deploy to Ethereum Sepolia (etherscan verify)
	forge script script/DeployAll.s.sol --rpc-url $(SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-arbitrum-sepolia: ## Deploy to Arbitrum Sepolia (arbiscan verify)
	forge script script/DeployAll.s.sol --rpc-url $(ARBITRUM_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-optimism-sepolia: ## Deploy to Optimism Sepolia (etherscan verify)
	forge script script/DeployAll.s.sol --rpc-url $(OPTIMISM_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-polygon-amoy: ## Deploy to Polygon Amoy (polygonscan verify)
	forge script script/DeployAll.s.sol --rpc-url $(POLYGON_AMOY_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-avalanche-fuji: ## Deploy to Avalanche Fuji (snowtrace verify)
	forge script script/DeployAll.s.sol --rpc-url $(AVALANCHE_FUJI_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-bnb-testnet: ## Deploy to BNB Smart Chain testnet (bscscan verify)
	forge script script/DeployAll.s.sol --rpc-url $(BNB_TESTNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-scroll-sepolia: ## Deploy to Scroll Sepolia (scrollscan verify)
	forge script script/DeployAll.s.sol --rpc-url $(SCROLL_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

# Robinhood Chain testnet (Arbitrum Orbit L2, chainId 46630). Native = ETH; Blockscout explorer (no
# Etherscan key, so no verify flag here). NOTE: Chainlink Data Feeds are NOT live on RH Chain yet, so
# the router deploys but same-chain USD quote() is unavailable until a feed lands — its role today is a
# CCIP cross-chain LANE endpoint (selector 2032988798112970440). Set ROBINHOOD_TESTNET_RPC_URL +
# ROBINHOOD_TESTNET_PLATFORM_TREASURY in .env first; the deployer keystore signs.
deploy-robinhood-testnet: ## Deploy to Robinhood Chain testnet (CCIP-lane endpoint; no price feed yet)
	forge script script/DeployAll.s.sol --rpc-url $(ROBINHOOD_TESTNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) -vvvv

# Verify the ALREADY-DEPLOYED Robinhood Chain contracts on Blockscout — standalone + deploy-path-
# INDEPENDENT (no --broadcast, no keystore: it only uploads source). --resume re-reads the last
# broadcast (broadcast/DeployAll.s.sol/46630/run-latest.json) so forge has each contract's address +
# the exact constructor args, then submits source to the Blockscout verifier. Use this when the deploy
# itself ran WITHOUT --verify — e.g. a private / direct-to-sequencer submission that bypasses forge's
# inline auto-verify. RH Blockscout is flaky (503s); just re-run until it sticks. No Etherscan key.
verify-robinhood-testnet: ## Verify deployed RH Chain contracts on Blockscout (standalone; no keystore)
	./script/verify-blockscout.sh 46630 https://explorer.testnet.chain.robinhood.com/api/ $(ROBINHOOD_TESTNET_RPC_URL)

# Post-hoc verification for the OTHER deployed testnets. Same standalone, no-keystore, no-tx model —
# reads each chain's recorded broadcast and uploads source. Etherscan-family chains use the one
# Etherscan V2 key (passed via env with `@` so it never echoes); Blockscout chains use their verifier
# URL. All idempotent: already-verified ⇒ no-op, so re-run freely.
verify-ethereum-sepolia: ## Verify deployed Ethereum Sepolia contracts (Etherscan V2)
	@ETHERSCAN_API_KEY="$(ETHERSCAN_API_KEY)" ./script/verify-etherscan.sh 11155111 $(SEPOLIA_RPC_URL)

verify-base-sepolia: ## Verify deployed Base Sepolia contracts (Etherscan V2 / Basescan)
	@ETHERSCAN_API_KEY="$(ETHERSCAN_API_KEY)" ./script/verify-etherscan.sh 84532 $(BASE_SEPOLIA_RPC_URL)

verify-optimism-sepolia: ## Verify deployed Optimism Sepolia contracts (Etherscan V2)
	@ETHERSCAN_API_KEY="$(ETHERSCAN_API_KEY)" ./script/verify-etherscan.sh 11155420 $(OPTIMISM_SEPOLIA_RPC_URL)

verify-avalanche-fuji: ## Verify deployed Avalanche Fuji contracts (Etherscan V2 / Snowtrace)
	@ETHERSCAN_API_KEY="$(ETHERSCAN_API_KEY)" ./script/verify-etherscan.sh 43113 $(AVALANCHE_FUJI_RPC_URL)

verify-arc: ## Verify deployed Arc testnet contracts (Blockscout / arcscan)
	./script/verify-blockscout.sh 5042002 $(ARC_SCAN_VERIFIER_URL) $(ARC_TESTNET_RPC_URL)

# One-shot: verify EVERY deployed testnet best-effort (the leading `-` keeps going past a chain whose
# explorer is down / rate-limited). The per-chain targets above give granular control + clearer errors.
verify-all-testnets: ## Verify all deployed testnet contracts (best-effort across explorers)
	-@$(MAKE) verify-ethereum-sepolia
	-@$(MAKE) verify-base-sepolia
	-@$(MAKE) verify-optimism-sepolia
	-@$(MAKE) verify-avalanche-fuji
	-@$(MAKE) verify-arc
	-@$(MAKE) verify-robinhood-testnet

deploy-linea-sepolia: ## Deploy to Linea Sepolia (lineascan verify)
	forge script script/DeployAll.s.sol --rpc-url $(LINEA_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-mantle-sepolia: ## Deploy to Mantle Sepolia (blockscout verify)
	forge script script/DeployAll.s.sol --rpc-url $(MANTLE_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(MANTLE_SEPOLIA_VERIFIER_URL)) -vvvv

deploy-blast-sepolia: ## Deploy to Blast Sepolia (blastscan verify)
	forge script script/DeployAll.s.sol --rpc-url $(BLAST_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-unichain-sepolia: ## Deploy to Unichain Sepolia (uniscan verify)
	forge script script/DeployAll.s.sol --rpc-url $(UNICHAIN_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

# ── Even more test networks (the faucet list: blockscout/sourcify/etherscan-family verify per chain) ──
deploy-zora-sepolia: ## Deploy to Zora Sepolia (chainId 999999999, ETH; blockscout verify)
	forge script script/DeployAll.s.sol --rpc-url $(ZORA_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(ZORA_SEPOLIA_VERIFIER_URL)) -vvvv

deploy-filecoin-calibration: ## Deploy to Filecoin Calibration (chainId 314159, tFIL; blockscout verify)
	forge script script/DeployAll.s.sol --rpc-url $(FILECOIN_CALIBRATION_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(FILECOIN_CALIBRATION_VERIFIER_URL)) -vvvv

deploy-gnosis-chiado: ## Deploy to Gnosis Chiado (chainId 10200, XDAI; blockscout verify)
	forge script script/DeployAll.s.sol --rpc-url $(GNOSIS_CHIADO_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(GNOSIS_CHIADO_VERIFIER_URL)) -vvvv

deploy-apechain-curtis: ## Deploy to ApeChain Curtis (chainId 33111, APE; blockscout verify)
	forge script script/DeployAll.s.sol --rpc-url $(APECHAIN_CURTIS_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(APECHAIN_CURTIS_VERIFIER_URL)) -vvvv

deploy-worldchain-sepolia: ## Deploy to World Chain Sepolia (chainId 4801, ETH; worldscan/etherscan verify)
	forge script script/DeployAll.s.sol --rpc-url $(WORLDCHAIN_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-zircuit-garfield: ## Deploy to Zircuit Garfield testnet (chainId 48898, ETH; sourcify verify)
	forge script script/DeployAll.s.sol --rpc-url $(ZIRCUIT_GARFIELD_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) --verify --verifier sourcify -vvvv

deploy-citrea-testnet: ## Deploy to Citrea testnet (chainId 5115, cBTC; blockscout verify)
	forge script script/DeployAll.s.sol --rpc-url $(CITREA_TESTNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(CITREA_TESTNET_VERIFIER_URL)) -vvvv

deploy-flow-evm-testnet: ## Deploy to Flow EVM testnet (chainId 545, FLOW; blockscout verify)
	forge script script/DeployAll.s.sol --rpc-url $(FLOW_EVM_TESTNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(FLOW_EVM_TESTNET_VERIFIER_URL)) -vvvv

deploy-celo-sepolia: ## Deploy to Celo Sepolia (chainId 11142220, CELO; celoscan/etherscan-v2 verify)
	forge script script/DeployAll.s.sol --rpc-url $(CELO_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

# ══════════════════════════════════════════════════════════════════════════════════════════════════
#  ⛔ MAINNET — AUDIT-GATED, REAL FUNDS. DO NOT RUN UNTIL A THIRD-PARTY AUDIT IS COMPLETE.            ⛔
# ══════════════════════════════════════════════════════════════════════════════════════════════════
#  This repo is TESTNET-ONLY today and UNAUDITED. There is NO mainnet deployment and NO mainnet
#  claim. The targets below exist ONLY so each chain has a mainnet PROFILE alongside its testnet one
#  (config/readiness). They move REAL money on a LIVE chain — running one before a completed
#  third-party security audit is forbidden (money paths, law #5 + #4). Each recipe deliberately STOPS
#  with a confirm gate (`MAINNET_AUDITED=yes`) so an accidental `make deploy-<chain>-mainnet` is a
#  no-op, never a broadcast. HelperConfig reads every address from `<CHAIN>_MAINNET_*` env (default
#  address(0) ⇒ skipped); NOTHING is hardcoded. Verifier per chain mirrors the testnet target.
#
#  To actually deploy AFTER an audit: set MAINNET_AUDITED=yes on the command line, e.g.
#    make deploy-base-mainnet MAINNET_AUDITED=yes
# ══════════════════════════════════════════════════════════════════════════════════════════════════

# The audit gate. Every mainnet recipe runs this FIRST; it aborts unless MAINNET_AUDITED=yes is passed.
MAINNET_AUDITED ?= no
define MAINNET_GATE
	@if [ "$(MAINNET_AUDITED)" != "yes" ]; then \
		echo "⛔ MAINNET deploy BLOCKED — AUDIT-GATED."; \
		echo "   This is testnet-only, unaudited software. No mainnet deployment exists or is claimed."; \
		echo "   Do NOT run on mainnet until a third-party audit is complete (real funds, law #5)."; \
		echo "   If (and only if) the audit is done, re-run with: MAINNET_AUDITED=yes"; \
		exit 1; \
	fi
	@echo "⚠️  MAINNET deploy proceeding with MAINNET_AUDITED=yes — real funds on a live chain."
endef

deploy-ethereum-mainnet: ## ⛔ AUDIT-GATED: deploy to Ethereum mainnet (etherscan verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(ETHEREUM_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-base-mainnet: ## ⛔ AUDIT-GATED: deploy to Base mainnet (basescan verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(BASE_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-arbitrum-mainnet: ## ⛔ AUDIT-GATED: deploy to Arbitrum One (arbiscan verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(ARBITRUM_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-optimism-mainnet: ## ⛔ AUDIT-GATED: deploy to OP Mainnet (etherscan verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(OPTIMISM_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-polygon-mainnet: ## ⛔ AUDIT-GATED: deploy to Polygon mainnet (polygonscan verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(POLYGON_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-avalanche-mainnet: ## ⛔ AUDIT-GATED: deploy to Avalanche C-Chain (snowtrace verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(AVALANCHE_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-bnb-mainnet: ## ⛔ AUDIT-GATED: deploy to BNB Smart Chain (bscscan verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(BNB_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-scroll-mainnet: ## ⛔ AUDIT-GATED: deploy to Scroll mainnet (scrollscan verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(SCROLL_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-linea-mainnet: ## ⛔ AUDIT-GATED: deploy to Linea mainnet (lineascan verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(LINEA_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-mantle-mainnet: ## ⛔ AUDIT-GATED: deploy to Mantle mainnet (blockscout verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(MANTLE_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(MANTLE_MAINNET_VERIFIER_URL)) -vvvv

deploy-blast-mainnet: ## ⛔ AUDIT-GATED: deploy to Blast mainnet (blastscan verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(BLAST_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-unichain-mainnet: ## ⛔ AUDIT-GATED: deploy to Unichain mainnet (uniscan verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(UNICHAIN_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-zksync-mainnet: ## ⛔ AUDIT-GATED: deploy to zkSync Era mainnet (zksync verify, --zksync) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(ZKSYNC_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) --zksync --verify --verifier zksync --verifier-url $(ZKSYNC_MAINNET_VERIFIER_URL) -vvvv

deploy-zora-mainnet: ## ⛔ AUDIT-GATED: deploy to Zora mainnet (chainId 7777777, ETH; blockscout verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(ZORA_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(ZORA_MAINNET_VERIFIER_URL)) -vvvv

deploy-filecoin-mainnet: ## ⛔ AUDIT-GATED: deploy to Filecoin mainnet (chainId 314, FIL; blockscout verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(FILECOIN_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(FILECOIN_MAINNET_VERIFIER_URL)) -vvvv

deploy-gnosis-mainnet: ## ⛔ AUDIT-GATED: deploy to Gnosis Chain (chainId 100, XDAI; gnosisscan verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(GNOSIS_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-apechain-mainnet: ## ⛔ AUDIT-GATED: deploy to ApeChain (chainId 33139, APE; apescan verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(APECHAIN_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-worldchain-mainnet: ## ⛔ AUDIT-GATED: deploy to World Chain (chainId 480, ETH; worldscan verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(WORLDCHAIN_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

deploy-zircuit-mainnet: ## ⛔ AUDIT-GATED: deploy to Zircuit mainnet (chainId 48900, ETH; sourcify verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(ZIRCUIT_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) --verify --verifier sourcify -vvvv

deploy-citrea-mainnet: ## ⛔ AUDIT-GATED: deploy to Citrea mainnet (chainId 4114, cBTC; blockscout verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(CITREA_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(CITREA_MAINNET_VERIFIER_URL)) -vvvv

deploy-flow-evm-mainnet: ## ⛔ AUDIT-GATED: deploy to Flow EVM mainnet (chainId 747, FLOW; blockscout verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(FLOW_EVM_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(FLOW_EVM_MAINNET_VERIFIER_URL)) -vvvv

deploy-celo-mainnet: ## ⛔ AUDIT-GATED: deploy to Celo mainnet (chainId 42220, CELO; celoscan verify) — real funds
	$(MAINNET_GATE)
	forge script script/DeployAll.s.sol --rpc-url $(CELO_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

# Arc MAINNET is NOT launched (Arc is testnet-only today). Its chain id is TBD, so the HelperConfig
# branch is selected only when ARC_MAINNET_CHAIN_ID is set to the real id at launch (never invented).
# CANDIDATE (verified Jun 16, 2026, NOT live): ethereum-lists/chains pre-registers chain 5042
# ("arc-mainnet", native USDC) — the likely id — but with empty rpc/explorer; Arc is still public
# testnet ("mainnet beta, summer 2026"). Set ARC_MAINNET_CHAIN_ID=5042 only once Circle ships a live RPC.
# This target is doubly gated: AUDIT-GATED above, AND it errors if ARC_MAINNET_CHAIN_ID is unset.
deploy-arc-mainnet: ## ⛔ AUDIT-GATED + NOT LAUNCHED: deploy to Arc mainnet (set ARC_MAINNET_CHAIN_ID first)
	$(MAINNET_GATE)
	@if [ -z "$(ARC_MAINNET_CHAIN_ID)" ]; then \
		echo "⛔ Arc mainnet is NOT launched — ARC_MAINNET_CHAIN_ID is unset (the id is TBD, never invented)."; \
		echo "   Set ARC_MAINNET_CHAIN_ID to the real id at launch before this target can run."; \
		exit 1; \
	fi
	forge script script/DeployAll.s.sol --rpc-url $(ARC_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(ARC_MAINNET_VERIFIER_URL)) -vvvv
