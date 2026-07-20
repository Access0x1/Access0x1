import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig([
  globalIgnores([
    "public/embed.js",
    // Generated/vendored tooling output (gitignored — see .gitignore's design-sync
    // block) — `next lint`'s implicit defaults used to skip these; the raw ESLint
    // CLI needs them explicit, or it lints a vendored copy of React's own source.
    "ds-bundle/**",
    ".design-sync/.cache/**",
    ".design-sync/node_modules/**",
  ]),
  {
    extends: [...nextCoreWebVitals],
    rules: {
      // eslint-config-next 16 bundles the React Compiler rules. Two are too
      // aggressive to adopt on this pass: `set-state-in-effect` flags the
      // standard `useEffect(() => setX(...), [deps])` fetch-on-mount/sync
      // pattern used throughout checkout/dashboard/branding — 19 instances,
      // every one an established, correct pattern, not a bug. Migrating them
      // to the Compiler's preferred style is a real refactor of payment-
      // adjacent UI, not something to force through on a dependency bump.
      // `preserve-manual-memoization` just means the Compiler skipped
      // optimizing two existing, correct `useCallback`s — not a defect.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
  {
    // Playwright fixtures declare an async callback literally named `use`
    // (test.extend's fixture signature) — react-hooks/rules-of-hooks
    // pattern-matches on the name and misreads it as a React hook. This is
    // test-runner code, never a React component; the whole hooks ruleset
    // doesn't apply.
    files: ["e2e/**"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
]);