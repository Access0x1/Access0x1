# Access0x1 — Makefile. Run `make` (or `make help`) to see every command.
#
# Foundry here is the zksync fork (installed via foundryup-zksync); ~/.foundry/bin is
# prepended so forge/cast/anvil/chisel resolve in every recipe without touching your
# shell PATH. Deploys are keystore-only: import once with `cast wallet import deployer`
# and set the RPC envs in .env (copy .env.example). NEVER commit .env.

export PATH := $(HOME)/.foundry/bin:$(PATH)
-include .env

.DEFAULT_GOAL := help

.PHONY: help install build test test-gas coverage snapshot fmt fmt-check clean \
        gate aderyn slither audit anvil \
        deploy-dry deploy-local deploy-arc deploy-base deploy-zksync deploy-sepolia deploy-arbitrum-sepolia deploy-optimism-sepolia \
        web-install web-dev web-build web-typecheck web-test web-gate sdk-build \
        vyper-build vyper-test \
        cre-build cre-sim all

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

test: ## Run all tests: unit + invariant + attack + integration
	forge test

test-gas: ## Run tests with the per-function gas report
	forge test --gas-report

coverage: ## Test coverage over src/
	forge coverage

snapshot: ## Regenerate the gas snapshot (.gas-snapshot)
	forge snapshot

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

audit: aderyn slither coverage ## Full audit pass — then see audit/REPORT.md + audit/FINDINGS.md
	@echo "==> audit done — read audit/REPORT.md + audit/FINDINGS.md"

# ── Local chain ───────────────────────────────────────────────────────────────────
anvil: ## Run a local anvil node
	anvil

# ── Deploy (keystore `deployer`; set RPC + DEPLOYER in .env; mainnet is NOT here) ──
deploy-dry: ## Deploy DRY-RUN — simulation only, no broadcast, no keys
	forge script script/DeployAll.s.sol

deploy-local: ## Deploy to a local anvil (broadcast)
	forge script script/DeployAll.s.sol --rpc-url http://localhost:8545 --broadcast -vvvv

deploy-arc: ## Deploy to Arc testnet (keystore `deployer`)
	forge script script/DeployAll.s.sol --rpc-url $(ARC_TESTNET_RPC_URL) --account deployer --sender $(DEPLOYER) --broadcast -vvvv

deploy-base: ## Deploy to Base Sepolia (keystore `deployer`, verified)
	forge script script/DeployAll.s.sol --rpc-url $(BASE_SEPOLIA_RPC_URL) --account deployer --sender $(DEPLOYER) --broadcast --verify --etherscan-api-key $(BASESCAN_API_KEY) -vvvv

deploy-zksync: ## Deploy to zkSync Sepolia (keystore `deployer`)
	forge script script/DeployAll.s.sol --rpc-url $(ZKSYNC_SEPOLIA_RPC_URL) --account deployer --sender $(DEPLOYER) --broadcast --zksync -vvvv

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
