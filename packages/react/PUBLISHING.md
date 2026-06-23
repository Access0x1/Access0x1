# Publishing `@access0x1/react` to npm

This is the owner-only release runbook. The package is prepped for publish; the
only thing left is the authenticated `npm publish`, which requires the owner's
npm credentials. **Do not run these in CI or hand them to an agent — they move a
real artifact onto the public registry under the `@access0x1` scope.**

## Prerequisites (one time)

1. An npm account that owns (or is a member of) the **`@access0x1`** organization
   scope on npmjs.com. Create the org at https://www.npmjs.com/org/create if it
   does not exist yet — the scope must exist before a scoped public package can
   be published.
2. If 2FA is enabled for publishes (recommended), have your authenticator ready;
   npm will prompt for a one-time password during `npm publish`.
3. Node >= 18 and npm >= 9 locally.

## Step 1 — authenticate

```bash
npm login
# Username, password, email, and (if enabled) the 2FA OTP.
# Confirm you are the expected user:
npm whoami
```

## Step 2 — publish `@access0x1/react`

Run everything from the package directory:

```bash
cd packages/react

# Clean install so the build is reproducible (optional but recommended):
npm ci

# Sanity-check exactly what will ship — dist + types + README + LICENSE, no src/tests:
npm pack --dry-run

# Publish. `prepublishOnly` runs `npm run build` automatically (tsc -> dist with .d.ts),
# so dist is always freshly built from source before the tarball is created.
npm publish --access public
```

Notes:

- `publishConfig.access` is already set to `public` in `package.json`, so
  `--access public` is belt-and-suspenders for the scoped package — keep it for
  clarity.
- The first publish of a brand-new scoped package **must** be public (or you need
  a paid org for private). This package is intended to be public.
- `dist/` is git-ignored on purpose; it is never committed. The tarball is built
  on demand by `prepublishOnly`, so a fresh `node_modules` (e.g. `npm ci`) is all
  that is required before publishing.

## Step 3 — verify the publish

```bash
npm view @access0x1/react version
npm view @access0x1/react dist-tags
```

Then, in a scratch directory, confirm a clean consumer install resolves the
types and entry point:

```bash
mkdir -p /tmp/a0x1-smoke && cd /tmp/a0x1-smoke
npm init -y >/dev/null
npm install @access0x1/react viem wagmi react react-dom
node -e "import('@access0x1/react').then(m => console.log(Object.keys(m)))"
# Expect: PayButton, usePayment, useMerchant, usePaymentLanes, clientFromViem, ... 
```

## Bumping a version for the next release

```bash
cd packages/react
npm version patch    # or: minor | major
# This updates package.json, then publish as above:
npm publish --access public
git push --follow-tags
```

---

## `create-access0x1` (scaffolder) — present, but NOT published

`packages/create-access0x1` already exists (the scaffolder that drops a starter
checkout into a new app — the `npm create access0x1@latest` wrapper it *would*
become once published), but its `package.json` is marked `"private": true` and it
is **intentionally not published** — only `@access0x1/react` goes to npm. End users
fetch the template directly:

```bash
npx degit Access0x1/Access0x1/templates/starter my-checkout
```

So there is no `npm publish` step for it; leave it private unless that decision
changes.

Requirements for `create-access0x1` to be publish-ready (mirror what was done for
`@access0x1/react`):

- `package.json`: `name` = `create-access0x1`, a `bin` entry pointing at the
  built CLI (so `npm create access0x1` works), `files` allowlist, `engines`
  node >= 18, MIT license, repository/homepage/bugs pointing at
  `Access0x1/Access0x1` with `directory: packages/create-access0x1`.
- A `prepublishOnly` build script.
- A README with the `npm create access0x1@latest` quickstart and a LICENSE.

Verify it the same way: `npm pack --dry-run`, then a scratch
`npm create access0x1@latest my-app` once published.

---

## Hard rules (do not break)

- Never publish from an agent/CI session — the owner runs `npm login` +
  `npm publish` by hand with their own credentials.
- Never run `npm publish` with uncommitted source changes you have not reviewed.
- Run `npm pack --dry-run` and read the file list **before** every publish.
