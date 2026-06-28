# Start here — the Access0x1 doc map

Every doc in this repo, ordered the way a newcomer should meet them. Find the row
that matches what you want to do and follow the link.

> First time? Read [GETTING-STARTED.md](./GETTING-STARTED.md) top to bottom, then
> come back here when you need a specific topic.

## 🚀 Start

| Read this when you want to… | Doc |
| --- | --- |
| Get the 60-second pitch + the full feature surface | [README.md](../README.md) |
| Go from zero to a working payment (3 copy-paste paths) | [GETTING-STARTED.md](./GETTING-STARTED.md) |

## 🧩 Build & integrate

| Read this when you want to… | Doc |
| --- | --- |
| Drop a pay button into your React app | [GETTING-STARTED.md → Path 1](./GETTING-STARTED.md#path-1--accept-your-first-payment-react-sdk) · SDK barrel: [`packages/react/src/index.ts`](../packages/react/src/index.ts) |
| Follow one merchant + buyer end to end (register → button → pay → receipt) | [E2E-INTEGRATION.md](./E2E-INTEGRATION.md) |
| Run the whole wired stack locally with no keys | [GETTING-STARTED.md → Path 2](./GETTING-STARTED.md#path-2--run-the-whole-thing-locally-no-keys) |
| Pay by hand with `cast`, contract by contract | [MANUAL-TESTING.md](./MANUAL-TESTING.md) |
| Add subscriptions / bookings / invoices / gift cards | [RECIPES.md](./RECIPES.md) |
| Look up the gas cost of each path | [GAS.md](./GAS.md) |

## 🌐 Deploy

| Read this when you want to… | Doc |
| --- | --- |
| Find a live address / chain id / USDC / feed (the source of truth) | [CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md) |
| Deploy the wired stack to any testnet | [DEPLOY-TESTNETS.md](./DEPLOY-TESTNETS.md) |
| Deploy specifically to Arc | [ARC-DEPLOY.md](./ARC-DEPLOY.md) |
| Deploy to zkSync (the EraVM path is different) | [ZKSYNC-TESTING.md](./ZKSYNC-TESTING.md) |

> Never copy an address from a blog post or an old snapshot — read it from
> [CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md) (each entry traces to a committed
> `broadcast/` record) and confirm it on the explorer. (LAW #4: an address that
> isn't on-chain isn't claimed.)

## 🔍 Understand

| Read this when you want to… | Doc |
| --- | --- |
| Translate a web3 term to something you already know | [GLOSSARY.md](./GLOSSARY.md) |
| See how the contracts fit together (the money spine, line by line) | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Understand the upgrade model + storage layout (you're on UUPS proxies) | [STORAGE-LAYOUT.md](./STORAGE-LAYOUT.md) |
| Read the contracts themselves | [`src/`](../src) — start at [`Access0x1Router.sol`](../src/Access0x1Router.sol) |

## 🛡 Security & audit

| Read this when you want to… | Doc |
| --- | --- |
| Understand the security posture | [SECURITY.md](../SECURITY.md) |
| Read the formal audit write-up | [audit/REPORT.md](../audit/REPORT.md) |
| See every finding + its triage | [audit/FINDINGS.md](../audit/FINDINGS.md) |
| Report a vulnerability (don't open a public issue) | [SECURITY.md](../SECURITY.md) |

## 🤝 Contribute

| Read this when you want to… | Doc |
| --- | --- |
| Make your first change (build loop + green gate + commit laws) | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Understand the audit methodology used here | [AUDIT.md](../AUDIT.md) |

## 📄 Meta

| Read this when you want to… | Doc |
| --- | --- |
| See how AI tooling was used in this build | [AI_ATTRIBUTION.md](../AI_ATTRIBUTION.md) |
| Check third-party licenses | [THIRD-PARTY-LICENSES.md](../THIRD-PARTY-LICENSES.md) |
| Read the project license (MIT) | [LICENSE](../LICENSE) |

---

Still lost? Open an issue at
[github.com/Access0x1/Access0x1](https://github.com/Access0x1/Access0x1) — except
for vulnerabilities, which follow [SECURITY.md](../SECURITY.md).
