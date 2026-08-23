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

# Silence Node's DEP0040 punycode deprecation. It comes from TRANSITIVE deps we do not
# control — @dynamic-labs/iconic -> url@0.11 -> punycode@1.3, and eslint -> ajv -> uri-js
# -> punycode@2.3 — so there is nothing in our source to fix and the warning is pure noise
# on every `make sync`. Suppress the ONE warning id, never all warnings (a blanket
# --no-deprecation would hide a real deprecation in our own code). Appended, so an operator's
# own NODE_OPTIONS survives.
export NODE_OPTIONS := $(strip $(NODE_OPTIONS) --disable-warning=DEP0040)

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
HEDERA_TESTNET_RPC_URL ?= https://testnet.hashio.io/api
CITREA_TESTNET_RPC_URL ?= https://rpc.testnet.citrea.xyz
FLOW_EVM_TESTNET_RPC_URL ?= https://testnet.evm.nodes.onflow.org
CELO_SEPOLIA_RPC_URL ?= https://forno.celo-sepolia.celo-testnet.org
# Hoodi + Tempo defaults verified live + chainId-matched 2026-07-01 (0x88bb0 = 560048, 0xa5bf = 42431).
HOODI_RPC_URL ?= https://ethereum-hoodi-rpc.publicnode.com
TEMPO_RPC_URL ?= https://rpc.testnet.tempo.xyz

# Verification is OPT-IN. forge REJECTS an empty `--etherscan-api-key`/`--verifier-url` outright (before
# it ever broadcasts), so we pass the verify clause ONLY when its key/URL is set — otherwise the chain
# broadcasts clean and you re-verify later (the broadcast always lands first). ONE Etherscan **V2** key
# (`ETHERSCAN_API_KEY`) verifies every Etherscan-family explorer; set it once in .env.
#
# THE KEY IS PASSED BY ENVIRONMENT, NEVER ON THE COMMAND LINE. It used to be spliced in as
# `--etherscan-api-key $(ETHERSCAN_API_KEY)`, which make ECHOED verbatim on every deploy — printing a
# live credential into the terminal, the scrollback, and any screen recording or pasted log. Argv is
# also world-readable via `ps` while the process runs. `forge` reads ETHERSCAN_API_KEY from the
# environment on its own, so exporting it is strictly better and needs no flag.
# Fail LOUD when a deploy target runs without a sender. `DEPLOYER` has no default —
# 67 recipes pass it as `--sender $(DEPLOYER)`, so an unset value silently becomes an EMPTY
# --sender and forge fails deep in its own argument handling, far from the actual cause.
# Scoped to `deploy-*` goals so every other target (build, test, fmt) still works with no .env.
#
# EXCEPTIONS: not every `deploy-*` target deploys a CONTRACT. `deploy-web` ships the
# Next.js app to Cloud Run and `deploy-inventory` only reads committed records — neither
# touches a keystore, and demanding a Solidity deployer address for them blocks a
# perfectly valid command with an error about the wrong subject entirely.
DEPLOY_GOALS := $(filter deploy-%,$(MAKECMDGOALS))
NON_CHAIN_DEPLOY_GOALS := deploy-web deploy-inventory
CHAIN_DEPLOY_GOALS := $(filter-out $(NON_CHAIN_DEPLOY_GOALS),$(DEPLOY_GOALS))
ifneq ($(CHAIN_DEPLOY_GOALS),)
  ifeq ($(strip $(DEPLOYER)),)
    $(error DEPLOYER is not set. Put the address your keystore controls in .env, e.g. DEPLOYER=0x... — `cast wallet list` shows the accounts you have)
  endif
endif

export ETHERSCAN_API_KEY
VERIFY_ES := $(if $(strip $(ETHERSCAN_API_KEY)),--verify,)
VERIFY_ZK := $(if $(strip $(ZKSYNC_VERIFIER_URL)),--verify --verifier zksync --verifier-url $(ZKSYNC_VERIFIER_URL),)
# Blockscout chains verify the same OPT-IN way: a blank verifier URL would make forge ABORT before it
# broadcasts, so we pass the clause only when the URL is set — else the deploy lands and you re-verify
# later (RESUME=1). Usage in a recipe: $(call bs_verify,$(<CHAIN>_VERIFIER_URL))
bs_verify = $(if $(strip $(1)),--verify --verifier blockscout --verifier-url $(1),)

# Robinhood Chain testnet (Blockscout) — known public explorer; defaulted so `make deploy-robinhood-testnet`
# auto-verifies out of the box (broadcast still lands first if the explorer hiccups). Override in .env.
ROBINHOOD_TESTNET_VERIFIER_URL ?= https://explorer.testnet.chain.robinhood.com/api/

# Where the verify-* scripts log one PASS/FAIL line per contract. The verify-all-* targets truncate it
# at the start and print a compact one-line-per-contract digest at the end (copy just that block — no
# verbose forge output). Exported so sub-makes + the scripts share the same path; override with
# VERIFY_RESULTS=/path.
VERIFY_RESULTS ?= /tmp/access0x1-verify-results.tsv
export VERIFY_RESULTS
# RESUME=1 re-uses the existing broadcast (no re-deploy) and just re-attempts verification — the safe
# retry when a flaky explorer 504'd the verify poll AFTER the deploy already landed.
RESUME_FLAG := $(if $(strip $(RESUME)),--resume,)

.DEFAULT_GOAL := help

.PHONY: help install build test test-gas test-scenario coverage coverage-lcov snapshot \
        fmt fmt-check clean sizes storage-layout \
        gate aderyn slither analyze mutation halmos audit anvil sync-test-badge \
        deploy-pick mirror-manifest sync \
        deploy-dry deploy-local drive-local drive-merchant-base drive-merchant-arc drive-merchant-base-dry drive-merchant-arc-dry deploy-arc deploy-base-sepolia deploy-zksync-sepolia deploy-ethereum-sepolia deploy-arbitrum-sepolia deploy-optimism-sepolia \
        deploy-polygon-amoy deploy-avalanche-fuji deploy-bnb-testnet deploy-scroll-sepolia deploy-linea-sepolia deploy-mantle-sepolia deploy-blast-sepolia deploy-unichain-sepolia \
        deploy-zora-sepolia deploy-filecoin-calibration deploy-gnosis-chiado deploy-apechain-curtis deploy-worldchain-sepolia deploy-zircuit-garfield deploy-hedera-testnet deploy-citrea-testnet deploy-flow-evm-testnet deploy-celo-sepolia deploy-robinhood-testnet deploy-hoodi deploy-tempo \
        verify-robinhood-testnet verify-ethereum-sepolia verify-base-sepolia verify-optimism-sepolia verify-avalanche-fuji verify-arc verify-arbitrum-sepolia verify-polygon-amoy verify-galileo verify-chain verify-all-testnets verify-all-sourcify \
        deploy-ethereum-mainnet deploy-base-mainnet deploy-arbitrum-mainnet deploy-optimism-mainnet deploy-polygon-mainnet deploy-avalanche-mainnet deploy-bnb-mainnet \
        deploy-scroll-mainnet deploy-linea-mainnet deploy-mantle-mainnet deploy-blast-mainnet deploy-unichain-mainnet deploy-zksync-mainnet \
        deploy-zora-mainnet deploy-filecoin-mainnet deploy-gnosis-mainnet deploy-apechain-mainnet deploy-worldchain-mainnet deploy-zircuit-mainnet deploy-citrea-mainnet deploy-flow-evm-mainnet deploy-celo-mainnet deploy-arc-mainnet \
        web-install web-dev web-build web-typecheck web-test web-gate sdk-build \
        vyper-build vyper-test \
        cre-build cre-sim zksync-build \
        upgrade-snapshot upgrade-guard upgrade-dry upgrade-base-sepolia upgrade-ethereum-sepolia upgrade-arbitrum-sepolia upgrade-optimism-sepolia upgrade-avalanche-fuji upgrade-arc upgrade-celo-sepolia upgrade-robinhood-testnet upgrade-zksync-sepolia \
        all

help: ## Show every command
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(firstword $(MAKEFILE_LIST)) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

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
	@if command -v forge >/dev/null 2>&1; then \
		forge fmt; \
	else \
		echo "make fmt: Foundry is not installed here, so nothing can be REFORMATTED."; \
		echo "  Running the no-Foundry check instead — it flags newly added over-long lines."; \
		node scripts/sol-line-length.mjs; \
	fi

fmt-check: ## Check formatting without writing (CI). Falls back to a diff-scoped width check without Foundry.
	@if command -v forge >/dev/null 2>&1; then \
		forge fmt --check; \
	else \
		echo 'make fmt-check: Foundry absent — forge fmt --check is the authority and runs in CI.'; \
		echo "  Checking what CAN be checked here: line width on newly added Solidity lines."; \
		node scripts/sol-line-length.mjs; \
	fi

clean: ## Remove build artifacts (forge clean)
	forge clean

# ── The gate (run before any commit) ────────────────────────────────────────────
gate: build test fmt-check web-gate sync-check ## FULL GREEN GATE: contracts build+test+fmt AND web typecheck+test+generated-artifact drift
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
deploy-dry: ## Deploy DRY-RUN — simulation only, no broadcast, no keys (simulates as DEPLOYER when set, so owner-gated config runs and the CREATE3 addresses match the real mirror)
	@forge script script/DeployAll.s.sol $(if $(DEPLOYER),--sender $(DEPLOYER))

deploy-local: ## Deploy to a local anvil (anvil's default unlocked account[0]; no keystore needed)
	@forge script script/DeployAll.s.sol --rpc-url http://localhost:8545 --broadcast $(RESUME_FLAG) --unlocked --sender $(ANVIL_SENDER) -vvvv

drive-local: ## Deploy + DRIVE the coffee-shop money flow on a local anvil (run `make anvil` first)
	forge script script/Interactions.s.sol:DriveCoffeeShopLocal \
		--rpc-url http://localhost:8545 --broadcast --unlocked \
		--sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 -vvvv

deploy-pick: ## Interactive: pick which chains to mirror-deploy (shows gas + mirror status per chain)
	@./script/deploy-pick.sh

mirror-manifest: ## Compute every contract's CREATE3 mirror address from its salt (no deploy) -> script/mirror-manifest.json
	@./script/mirror-manifest.sh

# The tool is only as good as the copy you are running. Three separate sessions were
# lost to a stale local script — two bugs were fixed and pushed, and the same crash
# kept reappearing because the fix had never been pulled. So the target refuses to run
# a script that differs from origin/main rather than trusting the working tree.
_prune-fresh:
	@git fetch --quiet origin main
	@if ! git diff --quiet origin/main -- scripts/prune-merged-branches.sh; then \
		echo "prune: your copy of scripts/prune-merged-branches.sh differs from origin/main."; \
		echo "  This is the failure that has bitten three times — a fixed script that was"; \
		echo "  never pulled. Refusing to run it against 41 remote branches."; \
		echo; \
		echo "  Take the remote version:  git checkout origin/main -- scripts/prune-merged-branches.sh"; \
		echo "  Or keep yours on purpose: bash scripts/prune-merged-branches.sh"; \
		exit 1; \
	fi

prune-branches: _prune-fresh ## List remote branches that no longer carry work (dry run — deletes nothing)
	@bash scripts/prune-merged-branches.sh

prune-branches-confirm: _prune-fresh ## DELETE the git-proven-merged remote branches (asks first)
	@bash scripts/prune-merged-branches.sh | tee /tmp/access0x1-prune.txt
	@if grep -q '^DRY RUN — nothing deleted. 0 branch' /tmp/access0x1-prune.txt; then \
		echo; echo "Nothing to prune — every merged branch is already gone."; \
		rm -f /tmp/access0x1-prune.txt; exit 0; \
	fi
	@echo
	@printf 'Delete the TIER A branches listed above? Type yes to proceed: '
	@read -r reply; [ "$$reply" = "yes" ] || { echo "aborted — nothing deleted."; rm -f /tmp/access0x1-prune.txt; exit 1; }
	@rm -f /tmp/access0x1-prune.txt
	@bash scripts/prune-merged-branches.sh --confirm

deploy-web: ## Build + ship the web app to Cloud Run (Dynamic env id auto-derived from web/.env.local)
	@bash scripts/deploy-web.sh

deploy-inventory: ## What is deployed, what is dead, and is anything deployed twice?
	@node scripts/deploy-inventory.mjs

check-claims: ## Assert every count written in README prose matches what actually proves it
	@node web/scripts/check-chain-claims.mjs
	@node web/scripts/check-contract-claims.mjs

sync: ## Refresh ALL broadcast-derived data + docs (run after every deploy): web maps + README mirror status + deployed ABIs + test-count badge
	@echo "sync 1/6  web deployment maps"
	@node web/scripts/gen-deployments.mjs
	@echo "sync 2/6  README mirror-status table"
	@node web/scripts/sync-readme-status.mjs
	@echo "sync 3/6  README pre-mirror address table"
	@node web/scripts/gen-premirror-table.mjs
	@echo "sync 4/6  deployed-contract ABIs"
	@if [ -d out ]; then \
		node scripts/sync-deployed-abis.mjs --write; \
	else \
		echo "          skipped: out/ is absent (it is gitignored and needs 'forge build')."; \
		echo "          The committed abis/ keep their values; CI regenerates them."; \
	fi
	@echo "sync 5/6  Foundry test-count badge  (runs 'forge test --list' — this COMPILES the"
	@echo "          whole project, so expect a long quiet pause here on a cold cache)"
	@if command -v forge >/dev/null 2>&1; then \
		node scripts/sync-test-badge.mjs --write; \
	else \
		echo "          skipped: Foundry not installed — the badge keeps its committed value,"; \
		echo "          and CI re-derives it."; \
	fi
	@echo "sync 6/6  web test-count claims"
	@node web/scripts/sync-web-test-badge.mjs --write
	@echo "==> sync complete."

sync-check: ## Verify every generated artifact matches its source (no writes) — what CI runs
	@node web/scripts/sync-readme-status.mjs --check
	@node web/scripts/gen-premirror-table.mjs --check
	@node web/scripts/gen-module-abis.mjs --check
	@node web/scripts/gen-docs-corpus.mjs --check
	@node web/scripts/sync-web-test-badge.mjs --check
	@echo "==> generated artifacts are in sync with their sources."

sync-test-badge: build ## Regenerate the README test-count badge from `forge test --list`, then drift-check it
	@node scripts/sync-test-badge.mjs --write
	@node scripts/sync-test-badge.mjs

abis: build ## Regenerate abis/ (committed ABI for EVERY deployed contract) + enforce the ABI law
	@node scripts/sync-deployed-abis.mjs --write
	@node scripts/sync-deployed-abis.mjs

deploy-arc: ## Deploy to Arc testnet (keystore `deployer`)
	@forge script script/DeployAll.s.sol --rpc-url $(ARC_TESTNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(ARC_SCAN_VERIFIER_URL)) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-base-sepolia: ## Deploy to Base Sepolia (keystore `deployer`, verified)
	@forge script script/DeployAll.s.sol --rpc-url $(BASE_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

# ── Be a merchant on the LIVE mirror + settle ONE real native payment (no faucet — pays from gas) ──
# DriveMerchant registers a merchant and settles a real payNative in the chain's native token; the
# broadcaster (router owner) pays from the balance it already holds. `*-dry` simulates against the live
# chain with NO keystore/broadcast — run it first to preview the split, then run the broadcast target.
drive-merchant-base-dry: ## Preview (no key): be a merchant + native pay on Base Sepolia
	forge script script/DriveMerchant.s.sol --rpc-url $(BASE_SEPOLIA_RPC_URL) $(if $(DEPLOYER),--sender $(DEPLOYER)) -vvv

drive-merchant-arc-dry: ## Preview (no key): be a merchant + native pay on Arc testnet
	forge script script/DriveMerchant.s.sol --rpc-url $(ARC_TESTNET_RPC_URL) $(if $(DEPLOYER),--sender $(DEPLOYER)) -vvv

drive-merchant-base: ## Be a merchant + settle one native payment on Base Sepolia (keystore `deployer`)
	forge script script/DriveMerchant.s.sol --rpc-url $(BASE_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) -vvv

drive-merchant-arc: ## Be a merchant + settle one native payment on Arc testnet (keystore `deployer`)
	forge script script/DriveMerchant.s.sol --rpc-url $(ARC_TESTNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) -vvv

deploy-zksync-sepolia: ## Deploy to zkSync Era Sepolia via its EVM interpreter (keystore `deployer`) — PLAIN EVM path, NO --zksync: zksolc cannot compile the ERC-6551 account (EXTCODECOPY unsupported on native EraVM) and native-EraVM CREATE derivation would break the mirror; Era's EVM bytecode emulation executes standard EVM initcode with EVM CREATE3 math (proven: CreateX live at its canonical address + computeCreate3Address identical to L1 + full-script simulation lands the Router at the mirror 0xe92244…5EB5)
	@forge script script/DeployAll.s.sol --rpc-url $(ZKSYNC_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

bootstrap-createx-galileo: ## Status + runbook to put CreateX on 0G Galileo (16602) so the mirror can deploy there (pre-signed keyless tx; owner funds 0xeD456e... once)
	@./script/bootstrap-createx-galileo.sh

deploy-galileo: ## Deploy to 0G Galileo testnet 16602 (keystore `deployer`) — set GALILEO_RPC_URL + GALILEO_PLATFORM_TREASURY first; 0G has no Chainlink feed, run `make deploy-usd-mock-feed RPC=$(GALILEO_RPC_URL)` for $1 USDC pricing
	@forge script script/DeployAll.s.sol --rpc-url $(or $(GALILEO_RPC_URL),https://evmrpc-testnet.0g.ai) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) --priority-gas-price 2000000000 -vvvv
	@$(MAKE) --no-print-directory sync

# Deploy a $1.00 USDC/USD mock feed to ANY chain that has real Circle USDC but no Chainlink USDC/USD
# feed (Linea/Unichain/World Chain/Celo/Optimism Sepolia). Real USDC stays the token; this is the
# missing PRICE feed only (the Arc pattern). Set <CHAIN>_USDC_USD_FEED to the printed address, then
# run that chain's deploy. See script/DeployUsdMockFeed.s.sol + docs/CHAIN-ADDRESSES.md.
deploy-usd-mock-feed: ## Deploy a $1 USDC/USD mock feed to a chain that lacks one — make deploy-usd-mock-feed RPC=<url>
	forge script script/DeployUsdMockFeed.s.sol --rpc-url $(RPC) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-createx: ## Put canonical CreateX (0xba5Ed…ba5Ed) on a chain that lacks it — the keyless presigned deploy (vendored from pcaversaccio/createx, signer + target re-verified from the signature): funds the one-time signer EXACTLY 0.3 native (3M gas @ 100 gwei, unrecoverable if the chain rejects pre-EIP-155 — probe first with `cast publish` unfunded), then publishes. make deploy-createx RPC=<url>
	@test -n "$(RPC)" || { echo "usage: make deploy-createx RPC=<rpcUrl>"; exit 1; }
	cast send 0xeD456e05CaAb11d66C4c797dD6c1D6f9A7F352b5 --value 0.3ether --rpc-url $(RPC) --account $(DEPLOYER_ACCOUNT)
	cast publish "$$(cat script/createx-presigned-3m.rawtx)" --rpc-url $(RPC)
	@echo "CreateX code bytes now on chain:" && cast code 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed --rpc-url $(RPC) | wc -c

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
		vyper --evm-version cancun vyper/src/NameMath.vy vyper/src/NameDie.vy >/dev/null && echo "==> vyper-build OK (cancun)"; \
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

# ── Upgrade EVERY live mirror module on a chain to a fresh impl — ONE broadcast, one ──
# ── password; impls auto-verify under VERIFY_ES. Same address, today's code. ──
# Complements the per-module `upgrade-<chain> MODULE=X` rail below: same Upgrade dispatch, same
# `upgrade-guard` storage gate in front, but all 19 modules in a single signed run. The prep step
# derives the module→proxy set from script/mirror-manifest.json (broadcast-derived, never typed);
# UpgradeAll skips modules with no code on the chain and skips-with-a-loud-WARN any module the
# sender does not own (the known misowned pairs), so one bad pair never blocks a whole chain.
out/upgrade-set.json: script/mirror-manifest.json
	@mkdir -p out
	@python3 -c "import json; m=json.load(open('script/mirror-manifest.json'))['contracts']; json.dump({'targets':[{'name':k[:-6],'proxy':v} for k,v in sorted(m.items()) if k.endswith('.proxy')]}, open('out/upgrade-set.json','w'))"

upgrade-all-ethereum-sepolia: upgrade-guard out/upgrade-set.json ## Upgrade ALL live modules on Ethereum Sepolia (one broadcast)
	@DEPLOYER=$(DEPLOYER) UPGRADE_SET=out/upgrade-set.json forge script script/UpgradeAll.s.sol --rpc-url $(SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

upgrade-all-base-sepolia: upgrade-guard out/upgrade-set.json ## Upgrade ALL live modules on Base Sepolia (one broadcast)
	@DEPLOYER=$(DEPLOYER) UPGRADE_SET=out/upgrade-set.json forge script script/UpgradeAll.s.sol --rpc-url $(BASE_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

upgrade-all-arc: upgrade-guard out/upgrade-set.json ## Upgrade ALL live modules on Arc testnet (one broadcast)
	@DEPLOYER=$(DEPLOYER) UPGRADE_SET=out/upgrade-set.json forge script script/UpgradeAll.s.sol --rpc-url $(ARC_TESTNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(ARC_SCAN_VERIFIER_URL)) -vvvv

# 0G note: the CREATE3 mirror set answers live on Galileo (verify: `cast call` the manifest
# addresses) but its original deploy broadcast was never committed — THIS run writes the fresh,
# committed, dated record against those same mirror addresses. 2 gwei priority per deploy-galileo.
upgrade-all-galileo: upgrade-guard out/upgrade-set.json ## Upgrade ALL live modules on 0G Galileo (one broadcast)
	@DEPLOYER=$(DEPLOYER) UPGRADE_SET=out/upgrade-set.json forge script script/UpgradeAll.s.sol --rpc-url $(or $(GALILEO_RPC_URL),https://evmrpc-testnet.0g.ai) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) --with-gas-price 4000000000 --priority-gas-price 2000000000 -vvvv

# ── More test networks (keystore `deployer`; set each RPC + *SCAN_API_KEY in .env) ──
deploy-ethereum-sepolia: ## Deploy to Ethereum Sepolia (etherscan verify)
	@forge script script/DeployAll.s.sol --rpc-url $(SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-arbitrum-sepolia: ## Deploy to Arbitrum Sepolia (arbiscan verify)
	@forge script script/DeployAll.s.sol --rpc-url $(ARBITRUM_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-optimism-sepolia: ## Deploy to Optimism Sepolia (etherscan verify)
	@forge script script/DeployAll.s.sol --rpc-url $(OPTIMISM_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-polygon-amoy: ## Deploy to Polygon Amoy (polygonscan verify)
	@forge script script/DeployAll.s.sol --rpc-url $(POLYGON_AMOY_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-avalanche-fuji: ## Deploy to Avalanche Fuji (snowtrace verify)
	@forge script script/DeployAll.s.sol --rpc-url $(AVALANCHE_FUJI_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) -vvvv
	@echo "Fuji broadcast complete — verify with: make verify-avalanche-fuji (Routescan, keyless). Etherscan V2 does not cover Fuji."
	@$(MAKE) --no-print-directory sync

deploy-bnb-testnet: ## Deploy to BNB Smart Chain testnet (bscscan verify)
	@forge script script/DeployAll.s.sol --rpc-url $(BNB_TESTNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-scroll-sepolia: ## Deploy to Scroll Sepolia (scrollscan verify)
	@forge script script/DeployAll.s.sol --rpc-url $(SCROLL_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

# Robinhood Chain testnet (Arbitrum Orbit L2, chainId 46630). Native = ETH; Blockscout explorer (no
# Etherscan key, so no verify flag here). NOTE: Chainlink Data Feeds are NOT live on RH Chain yet, so
# the router deploys but same-chain USD quote() is unavailable until a feed lands — its role today is a
# CCIP cross-chain LANE endpoint (selector 2032988798112970440). Set ROBINHOOD_TESTNET_RPC_URL +
# ROBINHOOD_TESTNET_PLATFORM_TREASURY in .env first; the deployer keystore signs.
deploy-robinhood-testnet: ## Deploy to Robinhood Chain testnet (CCIP-lane endpoint; no price feed yet)
	@forge script script/DeployAll.s.sol --rpc-url $(ROBINHOOD_TESTNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(ROBINHOOD_TESTNET_VERIFIER_URL)) -vvvv
	@$(MAKE) --no-print-directory sync

# Verify the ALREADY-DEPLOYED Robinhood Chain contracts on Blockscout — standalone + deploy-path-
# INDEPENDENT (no --broadcast, no keystore: it only uploads source). --resume re-reads the last
# broadcast (broadcast/DeployAll.s.sol/46630/run-latest.json) so forge has each contract's address +
# the exact constructor args, then submits source to the Blockscout verifier. Use this when the deploy
# itself ran WITHOUT --verify — e.g. a private / direct-to-sequencer submission that bypasses forge's
# inline auto-verify. RH Blockscout is flaky (503s); just re-run until it sticks. No Etherscan key.
verify-robinhood-testnet: ## Verify deployed RH Chain contracts on Blockscout (standalone; no keystore)
	./script/verify-blockscout.sh 46630 $(ROBINHOOD_TESTNET_RPC_URL) $(ROBINHOOD_TESTNET_VERIFIER_URL)

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

verify-avalanche-fuji: ## Verify deployed Avalanche Fuji contracts (Routescan / Snowtrace; keyless)
	./script/verify-etherscan.sh 43113 $(AVALANCHE_FUJI_RPC_URL) https://api.routescan.io/v2/network/testnet/evm/43113/etherscan verifyContract

verify-arc: ## Verify deployed Arc testnet contracts (Blockscout / arcscan; set ARC_SCAN_VERIFIER_URL)
	./script/verify-blockscout.sh 5042002 $(ARC_TESTNET_RPC_URL) $(ARC_SCAN_VERIFIER_URL)

verify-arbitrum-sepolia: ## Verify deployed Arbitrum Sepolia contracts (Etherscan V2)
	@ETHERSCAN_API_KEY="$(ETHERSCAN_API_KEY)" ./script/verify-etherscan.sh 421614 $(ARBITRUM_SEPOLIA_RPC_URL)

verify-polygon-amoy: ## Verify deployed Polygon Amoy contracts (Etherscan V2)
	@ETHERSCAN_API_KEY="$(ETHERSCAN_API_KEY)" ./script/verify-etherscan.sh 80002 $(POLYGON_AMOY_RPC_URL)

# 0G Galileo's explorer is a CONFLUX-SCAN FORK, not Blockscout — its action list carries `cfxsupply`,
# and forge's `--verifier blockscout` call shape gets rejected with "unknown action type" (proven
# 2026-07-26). It DOES speak the Etherscan module/action protocol (`verifysourcecode` +
# `checkverifystatus`) at /open/api — note /api and /api/v2 return the explorer's SPA HTML, so the
# path matters. Hence the etherscan script with an explicit verifier URL, and a placeholder key (the
# endpoint takes no key; the flag is required by forge).
verify-galileo: ## Verify deployed 0G Galileo contracts (Etherscan-protocol at /open/api — no key needed)
	VERIFY_NO_WATCH=1 ./script/verify-etherscan.sh 16602 $(or $(GALILEO_RPC_URL),https://evmrpc-testnet.0g.ai) $(or $(GALILEO_VERIFIER_URL),https://chainscan-galileo.0g.ai/open/api) none
	@echo ""
	@echo "Submitted. This explorer verifies asynchronously and forge cannot poll it — confirm with:"
	@echo "  make verify-status CHAIN=16602"

verify-status: ## Read REAL verification status from the explorer: CHAIN=<id> (reads deployments/<id>.json)
	@test -n "$(CHAIN)" || { echo "set CHAIN=<chainId>"; exit 1; }
	@./script/verify-status.sh $(CHAIN)

# Generic verifier for ANY chain that lacks a dedicated verify-<chain> target above (deployed now or in
# the future) — so every chain "just works" without 50 near-identical targets. Etherscan V2 by default
# (one key, routed by chain id); pass VERIFIER_URL for a Blockscout chain. Examples:
#   make verify-chain CHAIN=560048 RPC=$HOODI_RPC_URL                                   # Etherscan V2 (Hoodi)
#   make verify-chain CHAIN=42431  RPC=$TEMPO_RPC_URL VERIFIER_URL=https://explore.testnet.tempo.xyz/api/
# ⚠️ V2-era chains (e.g. Unichain Sepolia 1301): forge's `--chain <id>` alias routes to the LEGACY
#   per-chain explorer API, which rejects the unified V2 key ("Invalid API Key") — and VERIFIER_URL=
#   here routes to the BLOCKSCOUT script, which is wrong too. Call the etherscan script directly with
#   the V2 endpoint as $3 (proven on 1301, 38/38 verified 2026-08-17):
#   ETHERSCAN_API_KEY=$KEY script/verify-etherscan.sh 1301 $RPC "https://api.etherscan.io/v2/api?chainid=1301" "$KEY"
verify-chain: ## Verify ANY deployed chain: CHAIN=<id> RPC=<url> [VERIFIER_URL=<blockscout-api>]
	@test -n "$(CHAIN)" || { echo "set CHAIN=<chainId>"; exit 1; }
	@test -n "$(RPC)" || { echo "set RPC=<rpcUrl>"; exit 1; }
	$(if $(strip $(VERIFIER_URL)),./script/verify-blockscout.sh $(CHAIN) $(RPC) $(VERIFIER_URL),@ETHERSCAN_API_KEY="$(ETHERSCAN_API_KEY)" ./script/verify-etherscan.sh $(CHAIN) $(RPC))

# One-shot: verify EVERY deployed testnet best-effort (the leading `-` keeps going past a chain whose
# explorer is down / rate-limited). The per-chain targets above give granular control + clearer errors.
verify-all-testnets: ## Verify all deployed testnet contracts (best-effort) + a one-line-per-contract digest
	@: > $(VERIFY_RESULTS)
	-@$(MAKE) verify-ethereum-sepolia
	-@$(MAKE) verify-base-sepolia
	-@$(MAKE) verify-optimism-sepolia
	-@$(MAKE) verify-avalanche-fuji
	-@$(MAKE) verify-arc
	-@$(MAKE) verify-robinhood-testnet
	-@$(MAKE) verify-arbitrum-sepolia
	-@$(MAKE) verify-polygon-amoy
	-@$(MAKE) verify-galileo
	@echo ""; ./script/verify-summary.sh

# Additionally verify on Sourcify — the decentralized, KEYLESS registry (sourcify.dev) that wallets +
# tooling read. "Verify to the fullest extent": a second, chain-agnostic source-of-truth on top of the
# explorer verifiers. Best-effort (leading `-`) over the Sourcify-supported chains; Arc/Robinhood (Orbit
# testnets) are typically not in Sourcify's chain list and are intentionally omitted.
verify-all-sourcify: ## Also verify on Sourcify (keyless, decentralized) — supported chains + digest
	@: > $(VERIFY_RESULTS)
	-./script/verify-sourcify.sh 11155111 $(SEPOLIA_RPC_URL)
	-./script/verify-sourcify.sh 84532 $(BASE_SEPOLIA_RPC_URL)
	-./script/verify-sourcify.sh 11155420 $(OPTIMISM_SEPOLIA_RPC_URL)
	-./script/verify-sourcify.sh 43113 $(AVALANCHE_FUJI_RPC_URL)
	@echo ""; ./script/verify-summary.sh

deploy-linea-sepolia: ## Deploy to Linea Sepolia (lineascan verify)
	@forge script script/DeployAll.s.sol --rpc-url $(LINEA_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-mantle-sepolia: ## Deploy to Mantle Sepolia (blockscout verify)
	@forge script script/DeployAll.s.sol --rpc-url $(MANTLE_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(MANTLE_SEPOLIA_VERIFIER_URL)) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-blast-sepolia: ## Deploy to Blast Sepolia (blastscan verify)
	@forge script script/DeployAll.s.sol --rpc-url $(BLAST_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-unichain-sepolia: ## Deploy to Unichain Sepolia (uniscan verify)
	@forge script script/DeployAll.s.sol --rpc-url $(UNICHAIN_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

# ── Even more test networks (the faucet list: blockscout/sourcify/etherscan-family verify per chain) ──
deploy-zora-sepolia: ## Deploy to Zora Sepolia (chainId 999999999, ETH; blockscout verify)
	@forge script script/DeployAll.s.sol --rpc-url $(ZORA_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(ZORA_SEPOLIA_VERIFIER_URL)) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-filecoin-calibration: ## Deploy to Filecoin Calibration (chainId 314159, tFIL; blockscout verify)
	@forge script script/DeployAll.s.sol --rpc-url $(FILECOIN_CALIBRATION_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(FILECOIN_CALIBRATION_VERIFIER_URL)) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-gnosis-chiado: ## Deploy to Gnosis Chiado (chainId 10200, XDAI; blockscout verify)
	@forge script script/DeployAll.s.sol --rpc-url $(GNOSIS_CHIADO_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(GNOSIS_CHIADO_VERIFIER_URL)) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-apechain-curtis: ## Deploy to ApeChain Curtis (chainId 33111, APE; blockscout verify)
	@forge script script/DeployAll.s.sol --rpc-url $(APECHAIN_CURTIS_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(APECHAIN_CURTIS_VERIFIER_URL)) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-worldchain-sepolia: ## Deploy to World Chain Sepolia (chainId 4801, ETH; worldscan/etherscan verify)
	@forge script script/DeployAll.s.sol --rpc-url $(WORLDCHAIN_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-zircuit-garfield: ## Deploy to Zircuit Garfield testnet (chainId 48898, ETH; sourcify verify)
	@forge script script/DeployAll.s.sol --rpc-url $(ZIRCUIT_GARFIELD_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) --verify --verifier sourcify -vvvv
	@$(MAKE) --no-print-directory sync

deploy-hedera-testnet: ## Deploy to Hedera testnet (chainId 296, HBAR via Hashio; sourcify verify) — set HEDERA_TESTNET_PLATFORM_TREASURY first; Hedera has no Chainlink feed, run `make deploy-usd-mock-feed RPC=$(HEDERA_TESTNET_RPC_URL)` for $1 USDC pricing
	@forge script script/DeployAll.s.sol --rpc-url $(HEDERA_TESTNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) --verify --verifier sourcify -vvvv
	@$(MAKE) --no-print-directory sync

deploy-citrea-testnet: ## Deploy to Citrea testnet (chainId 5115, cBTC; blockscout verify)
	@forge script script/DeployAll.s.sol --rpc-url $(CITREA_TESTNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(CITREA_TESTNET_VERIFIER_URL)) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-flow-evm-testnet: ## Deploy to Flow EVM testnet (chainId 545, FLOW; blockscout verify)
	@forge script script/DeployAll.s.sol --rpc-url $(FLOW_EVM_TESTNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(FLOW_EVM_TESTNET_VERIFIER_URL)) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-celo-sepolia: ## Deploy to Celo Sepolia (chainId 11142220, CELO; celoscan/etherscan-v2 verify)
	@forge script script/DeployAll.s.sol --rpc-url $(CELO_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

# Ethereum Hoodi + Tempo Moderato — the last two pre-mirror chains that previously had NO Makefile
# target (docs/MIRROR-CUTOVER.md sent you to a raw `forge script` invocation). Same generic CREATE3
# mirror deploy as every sibling; HelperConfig has no dedicated branch for either, so the generic
# fallback reads PLATFORM_TREASURY (see .env.example "Shared"). Hoodi is Etherscan-family — the one
# V2 key verifies it inline. Tempo CAVEATS (docs/CHAIN-ADDRESSES.md): it has NO native gas token
# (fees are USD-denominated in TIP-20 stablecoins — the generic native-gas flow may not pay fees;
# the earlier run landed only a partial 8-contract set), and its explorer verify API is
# non-Etherscan/non-Blockscout — TEMPO_VERIFIER_URL is deliberately UNSET by default (bs_verify
# collapses to a clean broadcast; verify manually, or via `make verify-chain CHAIN=42431
# RPC=$(TEMPO_RPC_URL) VERIFIER_URL=<api>` once a working verifier endpoint is confirmed).
deploy-hoodi: ## Deploy to Ethereum Hoodi (chainId 560048, ETH; etherscan-v2 verify)
	@forge script script/DeployAll.s.sol --rpc-url $(HOODI_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-tempo: ## Deploy to Tempo Moderato (chainId 42431; TIP-20 stablecoin fees — see caveat above)
	@forge script script/DeployAll.s.sol --rpc-url $(TEMPO_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(TEMPO_VERIFIER_URL)) -vvvv
	@$(MAKE) --no-print-directory sync

# ══════════════════════════════════════════════════════════════════════════════════════════════════
#  ⛔ MAINNET — AUDIT-GATED, REAL FUNDS. DO NOT RUN UNTIL A THIRD-PARTY AUDIT IS COMPLETE.            ⛔
# ══════════════════════════════════════════════════════════════════════════════════════════════════
#  This repo is TESTNET-ONLY today and UNAUDITED. There is NO mainnet deployment and NO mainnet
#  claim. The targets below exist ONLY so each chain has a mainnet PROFILE alongside its testnet one
#  (config/readiness). They move REAL money on a LIVE chain, with no undo. The operator owns the
#  security posture (an external audit is available/welcome but NOT a required gate — see
#  audit/first-party-auditor/ + docs/MAINNET-CUSTODY.md). Each recipe deliberately STOPS with a
#  real-funds confirm gate (`MAINNET_CONFIRM=yes`) so an accidental `make deploy-<chain>-mainnet`
#  is a no-op, never a fat-fingered broadcast. HelperConfig reads every address from
#  `<CHAIN>_MAINNET_*` env (default address(0) ⇒ skipped); NOTHING is hardcoded. Verifier per chain
#  mirrors the testnet target.
#
#  To actually deploy: set MAINNET_CONFIRM=yes on the command line, e.g.
#    make deploy-base-mainnet MAINNET_CONFIRM=yes
# ══════════════════════════════════════════════════════════════════════════════════════════════════

# The real-funds confirm gate. Every mainnet recipe runs this FIRST; it aborts unless
# MAINNET_CONFIRM=yes is passed — fat-finger protection for a live-chain broadcast, not an audit claim.
MAINNET_CONFIRM ?= no
define MAINNET_GATE
	@if [ "$(MAINNET_CONFIRM)" != "yes" ]; then \
		echo "⛔ MAINNET deploy BLOCKED — real funds on a live chain."; \
		echo "   This deploys to mainnet with REAL money. There is no undo."; \
		echo "   The operator is responsible for the security posture (an external audit is"; \
		echo "   available but NOT required — see audit/first-party-auditor/ + docs/MAINNET-CUSTODY.md)."; \
		echo "   To proceed deliberately, re-run with: MAINNET_CONFIRM=yes"; \
		exit 1; \
	fi
	@echo "⚠️  MAINNET deploy proceeding with MAINNET_CONFIRM=yes — real funds on a live chain, no undo."
endef

deploy-ethereum-mainnet: ## ⛔ AUDIT-GATED: deploy to Ethereum mainnet (etherscan verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(ETHEREUM_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-base-mainnet: ## ⛔ AUDIT-GATED: deploy to Base mainnet (basescan verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(BASE_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-arbitrum-mainnet: ## ⛔ AUDIT-GATED: deploy to Arbitrum One (arbiscan verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(ARBITRUM_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-optimism-mainnet: ## ⛔ AUDIT-GATED: deploy to OP Mainnet (etherscan verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(OPTIMISM_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-polygon-mainnet: ## ⛔ AUDIT-GATED: deploy to Polygon mainnet (polygonscan verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(POLYGON_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-avalanche-mainnet: ## ⛔ AUDIT-GATED: deploy to Avalanche C-Chain (snowtrace verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(AVALANCHE_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-bnb-mainnet: ## ⛔ AUDIT-GATED: deploy to BNB Smart Chain (bscscan verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(BNB_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-scroll-mainnet: ## ⛔ AUDIT-GATED: deploy to Scroll mainnet (scrollscan verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(SCROLL_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-linea-mainnet: ## ⛔ AUDIT-GATED: deploy to Linea mainnet (lineascan verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(LINEA_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-mantle-mainnet: ## ⛔ AUDIT-GATED: deploy to Mantle mainnet (blockscout verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(MANTLE_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(MANTLE_MAINNET_VERIFIER_URL)) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-blast-mainnet: ## ⛔ AUDIT-GATED: deploy to Blast mainnet (blastscan verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(BLAST_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-unichain-mainnet: ## ⛔ AUDIT-GATED: deploy to Unichain mainnet (uniscan verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(UNICHAIN_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-zksync-mainnet: ## ⛔ AUDIT-GATED: deploy to zkSync Era mainnet (zksync verify, --zksync) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(ZKSYNC_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) --zksync --verify --verifier zksync --verifier-url $(ZKSYNC_MAINNET_VERIFIER_URL) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-zora-mainnet: ## ⛔ AUDIT-GATED: deploy to Zora mainnet (chainId 7777777, ETH; blockscout verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(ZORA_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(ZORA_MAINNET_VERIFIER_URL)) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-filecoin-mainnet: ## ⛔ AUDIT-GATED: deploy to Filecoin mainnet (chainId 314, FIL; blockscout verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(FILECOIN_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(FILECOIN_MAINNET_VERIFIER_URL)) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-gnosis-mainnet: ## ⛔ AUDIT-GATED: deploy to Gnosis Chain (chainId 100, XDAI; gnosisscan verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(GNOSIS_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-apechain-mainnet: ## ⛔ AUDIT-GATED: deploy to ApeChain (chainId 33139, APE; apescan verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(APECHAIN_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-worldchain-mainnet: ## ⛔ AUDIT-GATED: deploy to World Chain (chainId 480, ETH; worldscan verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(WORLDCHAIN_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-zircuit-mainnet: ## ⛔ AUDIT-GATED: deploy to Zircuit mainnet (chainId 48900, ETH; sourcify verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(ZIRCUIT_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) --verify --verifier sourcify -vvvv
	@$(MAKE) --no-print-directory sync

deploy-citrea-mainnet: ## ⛔ AUDIT-GATED: deploy to Citrea mainnet (chainId 4114, cBTC; blockscout verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(CITREA_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(CITREA_MAINNET_VERIFIER_URL)) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-flow-evm-mainnet: ## ⛔ AUDIT-GATED: deploy to Flow EVM mainnet (chainId 747, FLOW; blockscout verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(FLOW_EVM_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(FLOW_EVM_MAINNET_VERIFIER_URL)) -vvvv
	@$(MAKE) --no-print-directory sync

deploy-celo-mainnet: ## ⛔ AUDIT-GATED: deploy to Celo mainnet (chainId 42220, CELO; celoscan verify) — real funds
	$(MAINNET_GATE)
	@forge script script/DeployAll.s.sol --rpc-url $(CELO_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv
	@$(MAKE) --no-print-directory sync

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
	@forge script script/DeployAll.s.sol --rpc-url $(ARC_MAINNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast $(RESUME_FLAG) $(call bs_verify,$(ARC_MAINNET_VERIFIER_URL)) -vvvv
	@$(MAKE) --no-print-directory sync

# ═══════════════════════════════════════════════════════════════════════════════════════════════════
# UUPS UPGRADES — storage-safe, keystore-signed, ONE module per chain. Full runbook: docs/UPGRADING.md.
# Parameterized by MODULE (e.g. MODULE=Access0x1Escrow). PROXY is resolved from the mirror manifest via
# script/proxy-of.mjs; override with PROXY=0x... (REQUIRED for ChainRegistry — it is per-chain-distinct
# and NOT in the mirror manifest). Signing is keystore-only, identical to the deploy targets.
# The impl is a plain `new` deploy (a top-level CREATE), so the inline verify clause auto-verifies it.
# Every broadcast target runs the MODULE-scoped storage-layout guard first (fail-closed on a brick risk).
# ═══════════════════════════════════════════════════════════════════════════════════════════════════

# Resolve the proxy: honor an explicit PROXY, else look it up from the mirror manifest by MODULE.
_resolve_proxy = P="$${PROXY:-$$(node script/proxy-of.mjs $(MODULE))}"; \
	test -n "$(MODULE)" || { echo "set MODULE=<Contract> (e.g. MODULE=Access0x1Escrow)"; exit 1; }; \
	test -n "$$P" || { echo "could not resolve PROXY for MODULE=$(MODULE); pass PROXY=0x..."; exit 1; }

upgrade-snapshot: build ## (Re)generate storage-layouts/<Module>.json (set MODULE=<C> to scope) — review + commit the diff
	@MODULE=$(MODULE) node scripts/sync-storage-layouts.mjs --write

upgrade-guard: build ## STORAGE-LAYOUT GATE (set MODULE=<C> to scope; else all 20) — blocks any layout that would brick a proxy
	@MODULE=$(MODULE) node scripts/sync-storage-layouts.mjs

upgrade-dry: upgrade-guard ## Simulate the impl swap against a live chain (no keys): make upgrade-dry MODULE=Access0x1Escrow RPC=<url>
	@test -n "$(DEPLOYER)" || { echo "set DEPLOYER=0x... so the simulated --sender is the module owner"; exit 1; }
	@$(_resolve_proxy); \
	echo "==> DRY-RUN upgrade $(MODULE) proxy=$$P on $(or $(RPC),$(BASE_SEPOLIA_RPC_URL))"; \
	MODULE=$(MODULE) PROXY=$$P forge script script/Upgrade.s.sol \
		--rpc-url $(or $(RPC),$(BASE_SEPOLIA_RPC_URL)) --sender $(DEPLOYER) -vvvv

upgrade-base-sepolia: upgrade-guard ## Upgrade MODULE on Base Sepolia (keystore `deployer`, verified)
	@$(_resolve_proxy); \
	MODULE=$(MODULE) PROXY=$$P forge script script/Upgrade.s.sol \
		--rpc-url $(BASE_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) \
		--broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

upgrade-ethereum-sepolia: upgrade-guard ## Upgrade MODULE on Ethereum Sepolia (etherscan verify)
	@$(_resolve_proxy); \
	MODULE=$(MODULE) PROXY=$$P forge script script/Upgrade.s.sol \
		--rpc-url $(SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) \
		--broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

upgrade-arbitrum-sepolia: upgrade-guard ## Upgrade MODULE on Arbitrum Sepolia (arbiscan verify)
	@$(_resolve_proxy); \
	MODULE=$(MODULE) PROXY=$$P forge script script/Upgrade.s.sol \
		--rpc-url $(ARBITRUM_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) \
		--broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

upgrade-optimism-sepolia: upgrade-guard ## Upgrade MODULE on Optimism Sepolia (etherscan verify)
	@$(_resolve_proxy); \
	MODULE=$(MODULE) PROXY=$$P forge script script/Upgrade.s.sol \
		--rpc-url $(OPTIMISM_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) \
		--broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

upgrade-avalanche-fuji: upgrade-guard ## Upgrade MODULE on Avalanche Fuji
	@$(_resolve_proxy); \
	MODULE=$(MODULE) PROXY=$$P forge script script/Upgrade.s.sol \
		--rpc-url $(AVALANCHE_FUJI_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) \
		--broadcast $(RESUME_FLAG) -vvvv

upgrade-arc: upgrade-guard ## Upgrade MODULE on Arc testnet (Blockscout verify)
	@$(_resolve_proxy); \
	MODULE=$(MODULE) PROXY=$$P forge script script/Upgrade.s.sol \
		--rpc-url $(ARC_TESTNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) \
		--broadcast $(RESUME_FLAG) $(call bs_verify,$(ARC_SCAN_VERIFIER_URL)) -vvvv

upgrade-celo-sepolia: upgrade-guard ## Upgrade MODULE on Celo Sepolia (11142220; celoscan/etherscan-v2 verify)
	@$(_resolve_proxy); \
	MODULE=$(MODULE) PROXY=$$P forge script script/Upgrade.s.sol \
		--rpc-url $(CELO_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) \
		--broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

upgrade-robinhood-testnet: upgrade-guard ## Upgrade MODULE on Robinhood Chain testnet (46630; Blockscout verify)
	@$(_resolve_proxy); \
	MODULE=$(MODULE) PROXY=$$P forge script script/Upgrade.s.sol \
		--rpc-url $(ROBINHOOD_TESTNET_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) \
		--broadcast $(RESUME_FLAG) $(call bs_verify,$(ROBINHOOD_TESTNET_VERIFIER_URL)) -vvvv

# zkSync Era Sepolia — PLAIN EVM path, NO --zksync (mirrors deploy-zksync-sepolia). The mirror proxies
# run under Era's EVM interpreter; a zksolc/EraVM-compiled impl would break delegatecall/bytecode
# semantics and can HARD-BRICK the proxy. Always upgrade zkSync with the plain path.
upgrade-zksync-sepolia: upgrade-guard ## Upgrade MODULE on zkSync Era Sepolia (300) — PLAIN EVM, NO --zksync
	@$(_resolve_proxy); \
	MODULE=$(MODULE) PROXY=$$P forge script script/Upgrade.s.sol \
		--rpc-url $(ZKSYNC_SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) \
		--broadcast $(RESUME_FLAG) $(VERIFY_ES) -vvvv

show-contracts: ## Where is the actual code? Every contract's PROXY vs IMPLEMENTATION + explorer links (add --verify to read the live EIP-1967 slot)
	@node scripts/show-contracts.mjs $(ARGS)

# ── RPC endpoints + the hook live-fire (Makefile is the interface; scripts/ implements) ──────────

rpc-setup: ## Interactively set per-chain RPC URLs in .env (hidden input, chain-id validated, skip = keep)
	@bash scripts/set-rpc-endpoints.sh

livefire-sepolia: ## LIVE-FIRE the SwapReceiptHook on Ethereum Sepolia: fresh pool + 1 attributed swap (~0.002 ETH)
	@forge script script/LiveFireSwapReceipt.s.sol --rpc-url $(SEPOLIA_RPC_URL) --account $(DEPLOYER_ACCOUNT) --sender $(DEPLOYER) --broadcast --slow -vv

.PHONY: rpc-setup livefire-sepolia
