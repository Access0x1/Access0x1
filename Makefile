# Access0x1 — Makefile. Run `make` (or `make help`) to see every command.
#
# Foundry here is the zksync fork (installed via foundryup-zksync); ~/.foundry/bin is
# prepended so forge/cast/anvil/chisel resolve in every recipe without touching your
# shell PATH. Deploys are keystore-only: import once with `cast wallet import deployer`
# and set the RPC envs in .env (copy .env.example). NEVER commit .env.

export PATH := $(HOME)/.foundry/bin:$(PATH)
-include .env
ANVIL_SENDER ?= 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

.DEFAULT_GOAL := help

.PHONY: help install build test test-gas test-scenario coverage coverage-lcov snapshot \
        fmt fmt-check clean sizes storage-layout \
        gate aderyn slither analyze mutation halmos audit anvil \
        deploy-dry deploy-local drive-local deploy-arc deploy-base deploy-zksync deploy-sepolia deploy-arbitrum-sepolia deploy-optimism-sepolia \
        deploy-polygon-amoy deploy-avalanche-fuji deploy-bnb-testnet deploy-scroll-sepolia deploy-linea-sepolia deploy-mantle-sepolia deploy-blast-sepolia deploy-unichain-sepolia \
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
aderyn: ## Static analysis (aderyn)
	FOUNDRY_EVM_VERSION=cancun aderyn . --no-snippets

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
	forge script script/DeployAll.s.sol --rpc-url http://localhost:8545 --broadcast --unlocked --sender $(ANVIL_SENDER) -vvvv

drive-local: ## Deploy + DRIVE the coffee-shop money flow on a local anvil (run `make anvil` first)
	forge script script/Interactions.s.sol:DriveCoffeeShopLocal \
		--rpc-url http://localhost:8545 --broadcast --unlocked \
		--sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 -vvvv

deploy-arc: ## Deploy to Arc testnet (keystore `deployer`)
	forge script script/DeployAll.s.sol --rpc-url $(ARC_TESTNET_RPC_URL) --account deployer --sender $(DEPLOYER) --broadcast --verify --verifier blockscout --verifier-url $(ARC_SCAN_VERIFIER_URL) -vvvv

deploy-base: ## Deploy to Base Sepolia (keystore `deployer`, verified)
	forge script script/DeployAll.s.sol --rpc-url $(BASE_SEPOLIA_RPC_URL) --account deployer --sender $(DEPLOYER) --broadcast --verify --etherscan-api-key $(BASESCAN_API_KEY) -vvvv

deploy-zksync: ## Deploy to zkSync Sepolia (keystore `deployer`)
	forge script script/DeployAll.s.sol --rpc-url $(ZKSYNC_SEPOLIA_RPC_URL) --account deployer --sender $(DEPLOYER) --broadcast --zksync --verify --verifier zksync --verifier-url $(ZKSYNC_VERIFIER_URL) -vvvv

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
	cd cre && cre workflow build || echo "CRE CLI not installed — see sponsors/Chainlink.md"

cre-sim: ## Simulate the CRE workflow (the demoable artifact; deploy is Early-Access)
	cd cre && cre workflow simulate || echo "CRE CLI not installed — see sponsors/Chainlink.md"

# ── Everything ──────────────────────────────────────────────────────────────────
all: install gate ## Install everything, then run the full green gate

# ── More test networks (keystore `deployer`; set each RPC + *SCAN_API_KEY in .env) ──
deploy-sepolia: ## Deploy to Ethereum Sepolia (etherscan verify)
	forge script script/DeployAll.s.sol --rpc-url $(SEPOLIA_RPC_URL) --account deployer --sender $(DEPLOYER) --broadcast --verify --etherscan-api-key $(ETHERSCAN_API_KEY) -vvvv

deploy-arbitrum-sepolia: ## Deploy to Arbitrum Sepolia (arbiscan verify)
	forge script script/DeployAll.s.sol --rpc-url $(ARBITRUM_SEPOLIA_RPC_URL) --account deployer --sender $(DEPLOYER) --broadcast --verify --etherscan-api-key $(ARBISCAN_API_KEY) -vvvv

deploy-optimism-sepolia: ## Deploy to Optimism Sepolia (etherscan verify)
	forge script script/DeployAll.s.sol --rpc-url $(OPTIMISM_SEPOLIA_RPC_URL) --account deployer --sender $(DEPLOYER) --broadcast --verify --etherscan-api-key $(OPTIMISM_API_KEY) -vvvv

deploy-polygon-amoy: ## Deploy to Polygon Amoy (polygonscan verify)
	forge script script/DeployAll.s.sol --rpc-url $(POLYGON_AMOY_RPC_URL) --account deployer --sender $(DEPLOYER) --broadcast --verify --etherscan-api-key $(POLYGONSCAN_API_KEY) -vvvv

deploy-avalanche-fuji: ## Deploy to Avalanche Fuji (snowtrace verify)
	forge script script/DeployAll.s.sol --rpc-url $(AVALANCHE_FUJI_RPC_URL) --account deployer --sender $(DEPLOYER) --broadcast --verify --etherscan-api-key $(SNOWTRACE_API_KEY) -vvvv

deploy-bnb-testnet: ## Deploy to BNB Smart Chain testnet (bscscan verify)
	forge script script/DeployAll.s.sol --rpc-url $(BNB_TESTNET_RPC_URL) --account deployer --sender $(DEPLOYER) --broadcast --verify --etherscan-api-key $(BSCSCAN_API_KEY) -vvvv

deploy-scroll-sepolia: ## Deploy to Scroll Sepolia (scrollscan verify)
	forge script script/DeployAll.s.sol --rpc-url $(SCROLL_SEPOLIA_RPC_URL) --account deployer --sender $(DEPLOYER) --broadcast --verify --etherscan-api-key $(SCROLLSCAN_API_KEY) -vvvv

deploy-linea-sepolia: ## Deploy to Linea Sepolia (lineascan verify)
	forge script script/DeployAll.s.sol --rpc-url $(LINEA_SEPOLIA_RPC_URL) --account deployer --sender $(DEPLOYER) --broadcast --verify --etherscan-api-key $(LINEASCAN_API_KEY) -vvvv

deploy-mantle-sepolia: ## Deploy to Mantle Sepolia (blockscout verify)
	forge script script/DeployAll.s.sol --rpc-url $(MANTLE_SEPOLIA_RPC_URL) --account deployer --sender $(DEPLOYER) --broadcast --verify --verifier blockscout --verifier-url $(MANTLE_SEPOLIA_VERIFIER_URL) -vvvv

deploy-blast-sepolia: ## Deploy to Blast Sepolia (blastscan verify)
	forge script script/DeployAll.s.sol --rpc-url $(BLAST_SEPOLIA_RPC_URL) --account deployer --sender $(DEPLOYER) --broadcast --verify --etherscan-api-key $(BLASTSCAN_API_KEY) -vvvv

deploy-unichain-sepolia: ## Deploy to Unichain Sepolia (uniscan verify)
	forge script script/DeployAll.s.sol --rpc-url $(UNICHAIN_SEPOLIA_RPC_URL) --account deployer --sender $(DEPLOYER) --broadcast --verify --etherscan-api-key $(UNISCAN_API_KEY) -vvvv
