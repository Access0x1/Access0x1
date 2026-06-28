<!--
Thanks for the contribution! Keep the PR scoped to one coherent change — a diff
carrying two ideas is two PRs. See CONTRIBUTING.md for the build loop and the gate.
-->

## Description

<!-- What changed and **why**. The reviewer should understand the intent without
     reading the diff first. -->

## Relates to

<!-- Link the issue this addresses (e.g. `Closes #123`). If there's no issue, say
     why this stands alone. -->

Closes #

## Test plan

<!-- How you proved this works. Name the gate(s) you ran for every surface you
     touched, and the tests you added or updated. -->

- [ ] Contracts: `forge build` + `forge test` + `forge fmt --check` green
- [ ] Web / SDK: `make web-gate` (typecheck + unit tests) green
- [ ] Added or updated tests for the behavior changed
- [ ] Static analysis run for contract changes (`make analyze`), findings resolved or justified in `audit/FINDINGS.md`

<!-- Delete the lines above that don't apply to your surface. -->

## Checklist

- [ ] The green gate passes for every surface I touched
- [ ] Tests pass and cover the behavior I changed
- [ ] Docs updated (README / `docs/**` / NatSpec / JSDoc) where behavior or APIs changed
- [ ] No secrets — no private keys, mnemonics, RPC/API keys in source, tests, configs, or commit messages
- [ ] Conventional-commit messages, one idea per commit, no `--no-verify`
- [ ] This is **not** a security vulnerability (those follow [`SECURITY.md`](SECURITY.md), never a public PR)
