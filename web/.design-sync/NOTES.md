# design-sync NOTES — Access0x1 web

## Repo shape
- `Access0x1/web` is a private Next.js 15 app (`"private": true`), not a publishable
  component package — no `main`/`module`/`exports`, no `dist/` build. The converter
  runs in **synth-entry mode**: it scans `components/**` directly (the default
  `srcRoot`) instead of a shipped `.d.ts`.
- Scope is **everything under `components/`** (explicit owner choice, not just the
  generic `components/ui/*` primitives) — includes page-level business views
  (`components/pages/*`) alongside real generic primitives. Weaker `.d.ts` prop
  contracts than a real build would give; re-running the repo's actual `build`
  script doesn't help here since it builds the whole Next app, not a component dist.

## CSS / fonts
- `app/globals.css` is Tailwind directives + `:root`/`.light` token vars, not
  compiled CSS — `cfg.buildCmd` (`.design-sync/build-css.sh`) runs
  `npx tailwindcss` against the real `content` globs to produce
  `.design-sync/.cache/compiled.css` (gitignored, regenerated every build).
- Brand fonts (Inter, Space Grotesk) load via `next/font/google` in
  `app/layout.tsx`, which injects `--font-sans`/`--font-display` as *hashed local
  family names* at Next build time — invisible to a static synth-entry build, so
  the vars would otherwise be undefined and every `font-sans`/`font-display`
  utility would silently fall back to system fonts. Fixed by: `build-css.sh` pins
  `--font-sans: 'Inter Variable'` / `--font-display: 'Space Grotesk Variable'`,
  and `cfg.extraFonts` ships the real woff2s via `@fontsource-variable/inter` +
  `@fontsource-variable/space-grotesk` (installed `--no-save` into
  `web/node_modules` — not app dependencies, purely a design-sync build aid).
  These are the *real* brand fonts, not substitutes — just sourced as static
  files instead of next/font's runtime injection.

## Provider stack — two disjoint stacks, no single global wrapper covers both
- `app/providers.tsx` exports `Providers` (wagmi + react-query only) — the
  CUSTOMER/checkout stack, wired as `cfg.provider`. Covers most components.
- `app/MerchantProviders.tsx` exports `MerchantProviders` (Dynamic +
  wagmi + react-query) — the MERCHANT/dashboard stack. **Fail-soft**: when
  `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` is unset it renders a
  "Wallet sign-in is not configured" notice INSTEAD OF children (never throws,
  but also never shows the real component).
- Both are exposed on the bundle via `cfg.extraEntries` (repo-relative paths,
  not npm package names) so authored previews can `import` either one and
  compose explicitly per-component — `cfg.provider` only supports one global
  wrapper, not a per-component choice.

## Known render-check exclusions (`cfg.overrides.<Name>.skip`)
- **`CheckoutView`, `SlugCheckoutView`**: call `useRouter()` from `next/navigation`
  at the top of the component. That hook hard-throws ("invariant expected app
  router to be mounted") outside Next's real App Router tree — there's no
  sanctioned way to reconstruct that context for a static preview. Genuinely
  can't render statically.
- **15 Dynamic-gated components** (`ConnectButton`, `GatewayBalanceCard`,
  `IdentityChip`, `NetworkBadge`, `RegisterForm`, `SponsorPanel`,
  `BrandingForm`, `CheckoutModeForm`, `ContractPanel`, `SellableForms`,
  `DashboardView`, `JourneyView`, `OnboardView`, `VerificationLevelsPanel`,
  `VerificationLadder`): call `useDynamicContext()`, which throws without a real
  `DynamicContextProvider`. `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` is **empty** in
  the local `.env`, so `MerchantProviders`' fail-soft path would just show the
  "not configured" placeholder, not the real component — worse than an honest
  floor card. **Owner decision (2026-07-17): floor card for now.** Their own
  test suite mocks `useDynamicContext` via `vi.mock(...)` (Vitest module
  mocking) — that technique doesn't transfer to an esbuild-bundled preview, and
  forking `lib/bundle.mjs` to fake module substitution is explicitly
  off-limits per the skill's own rules. Re-visit once either (a) a real
  `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` is available in this environment (wire
  via `$ref` to `buildDynamicSettings()`, never hardcode the literal ID into
  this committed config), or (b) someone invests in a proper offline test-double
  for `useDynamicContext`.
- Correction: `cfg.overrides.<Name>.skip` is NOT a whole-component boolean —
  it's an array of *story IDs* to exclude from an already-authored preview's
  card grid (`emit.mjs` does `new Set(OVERRIDES[c.name]?.skip ?? [])`; a
  boolean crashes with `TypeError: boolean true is not iterable`). For a
  component with no authored `.design-sync/previews/<Name>.tsx` at all, it
  simply ships the floor card automatically — no override needed. The 17
  components above are therefore NOT configured with `skip`; they're just
  left unauthored (floor card) for now, expected to show `[RENDER]` failures
  in the render check, which is the correct/expected outcome until either the
  Dynamic env id or a router stub becomes available.

## guidelinesGlob path gotcha (same root cause as the symlink note below)
- `cfgPath()` resolves package-relative config fields via plain lexical
  `path.resolve(PKG_DIR, rel)` against the (symlinked) `PKG_DIR` — so a `"../"`
  escape doesn't walk the real filesystem, it strips a path segment from the
  symlink's own string, landing somewhere bogus
  (`../design` → `node_modules/@access0x1/design`, which doesn't exist).
  Fixed by adding `web/.design-sync/guidelines-src -> ../../design` (a plain
  symlink with NO `..` in its own target-relative usage from config — forward
  traversal through a symlink resolves fine at the OS level; it's only the
  lexical `..`-stripping that breaks) and pointing `guidelinesGlob` at
  `.design-sync/guidelines-src/*.md` instead of `../design/*.md`. Same fix
  would apply to `docsDir`/`docsMap`/`extraFonts` if they ever needed a `../`
  escape from PKG_DIR on this repo.

## srcDir must be pinned explicitly
- Default source-root priority is `src` \| `lib` \| `components` (first that
  exists wins). `web/lib/` (plain `.ts` utilities — chains, dynamic, branding)
  exists and sorts before `components/`, so without `cfg.srcDir: "components"`
  the converter silently walks `lib/` instead, finds zero `.tsx`/`.jsx` files,
  and reports "0 src files" / `[ZERO_MATCH]` with no error. Always keep
  `srcDir` pinned.

## Self-referential node_modules symlink (required, not optional)
- `package-build.mjs` unconditionally reads `<node_modules>/@access0x1/web/package.json`
  when `--entry` isn't passed (`PKG_DIR = join(NODE_MODULES, PKG)`), even in synth-entry
  mode — a known gap for a DS repo building itself with no `dist/` and no self-install.
  Passing `--entry` to work around it is NOT an option here: `resolveDistEntry`
  short-circuits on any `--entry` override and treats it as THE dist entry, which
  bypasses the `components/**` synth-entry walk entirely (defeats the whole
  "everything in components/" scope).
- Fix: a self-referential symlink, `web/node_modules/@access0x1/web -> ../..`
  (created once per clone, gitignored — `node_modules/` is already ignored
  repo-wide). Safe because `lib/common.mjs`'s `walk()` explicitly skips any
  `node_modules` directory, so nothing ever recurses through the symlink —
  it's only ever a single-file `package.json` read plus a few `existsSync`
  probes for `module`/`exports`/`main` (which correctly find none, since this
  is a private app, and fall through to synth-entry as intended).
- **Re-create this symlink after every `npm ci`/`npm install`** (a clean
  install can prune it) before running the converter:
  `mkdir -p node_modules/@access0x1 && ln -sfn ../.. node_modules/@access0x1/web`.

## Bundle size — 15 Dynamic-gated components excluded from this sync
- `@dynamic-labs/sdk-react-core`'s own dependency graph (WalletConnect/Reown,
  `@metamask/connect-multichain`, `@coinbase/wallet-sdk`, `@turnkey/*`, `ably`,
  `centrifuge`, `pako`, `tldts`, …) measured at **14.95 MB raw input — 58% of
  the entire 25.65 MB bundle** (`.ds-sync/analyze-bundle2.mjs`, a throwaway
  esbuild+metafile script mirroring the converter's own synth entry — not part
  of the converter itself, kept here only as a debugging aid). That alone
  pushed `_ds_bundle.js` to 13.9 MB, over the 12 MB upload cap.
- The 15 components that need it are exactly the ones already floor-carded
  (§ above — no live `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` to render them
  against anyway this pass). Owner decision (2026-07-17): exclude them from
  THIS sync rather than chase bundle tricks — there's no sanctioned way to
  selectively slim a real component's real imports (forking bundle.mjs or
  rewriting the component's own import statements are both off the table per
  the skill's "ship what the customer already built" principle).
- **First attempt — `cfg.componentSrcMap.<Name>: null` — didn't work.** That
  field only prunes the recognized-COMPONENT index; synth-entry mode's file
  list (`comps` in `lib/source-kit.mjs`) is built from a raw walk of
  `cfg.srcDir` filtered only by extension/test-file regex, with zero
  reference to `componentSrcMap`. Bundle size was unchanged (still 13.9 MB)
  after adding the `null` entries — confirmed the exclusion never reached the
  entry file, only the post-hoc name list.
  **Actual fix**: `build-inputs.sh` now copies `components/` into
  `.design-sync/.cache/components-filtered/` minus those 15 files, and
  `cfg.srcDir` points at the copy instead of the real `components/` — so the
  synth-entry walk never sees the files at all. The real app source under
  `web/components/` is untouched. `componentSrcMap` is unused in the current
  config (the file-level exclusion via the filtered copy fully supersedes it
  for this purpose).
- **`cfg.extraEntries` was ALSO still pulling in the full Dynamic stack** even
  after the file-level exclusion above — `./app/MerchantProviders.tsx` itself
  imports `@dynamic-labs/sdk-react-core` + `@dynamic-labs/wagmi-connector`,
  and `extraEntries` bundles unconditionally (that's its whole purpose — merge
  extra entries into the global bundle) regardless of whether any authored
  preview actually references it. Size barely moved (13.9→13.7 MB) after the
  components-filtered fix until `MerchantProviders` was also dropped from
  `extraEntries` (nothing composes it while its 15 components are out of
  scope). Only `./app/providers.tsx` (the customer wagmi/react-query stack,
  wired as `cfg.provider`) stays.
- **Re-sync trigger**: once a real Dynamic env id is available in this
  environment: remove those 15 filenames from the exclusion loop in
  `build-inputs.sh`, add `./app/MerchantProviders.tsx` back to
  `cfg.extraEntries` — they'll both render for real AND the bundle math
  changes (still need to re-check the 12 MB cap at that point; it may need
  `--render-sample` tuning or further scoping if it's still over).
- Current synced scope: 56 of the 71 discovered components (71 minus these 15;
  `CheckoutView`/`SlugCheckoutView` stay in scope as floor cards — the
  `next/navigation` issue is unrelated to bundle size, see above).

## "process is not defined" — every component, [BUNDLE_EXPORT] fatal
- First `package-validate.mjs` run: `[BUNDLE_EXPORT] 49/49 not a component`
  (fatal) plus `[RENDER_ERRORS] ReferenceError: process is not defined` on
  every single preview. Same root cause for both: `lib/chains.ts` (pulled in
  transitively via `app/providers.tsx` → `cfg.provider`) reads several
  `process.env.NEXT_PUBLIC_*` vars (RPC URLs, per-chain router/USDC
  addresses) at MODULE TOP LEVEL. Next.js's own bundler statically replaces
  those at ITS build time; `lib/bundle.mjs`'s esbuild `define` only covers
  the literal `process.env.NODE_ENV` — every other `process.env.X` reference
  survives into the bundle as a bare `process` identifier, which doesn't
  exist as a global in a browser/IIFE context, so `_ds_bundle.js` throws
  during its own top-level evaluation before `window.Access0x1Web` is even
  populated (explains why the smoke test saw ALL 49 as "not found", and why
  every preview card threw before mounting).
- Not fixable via any existing `cfg.*` key (no `define`/env-injection field
  exists; `cfg.storyImports.shim` only matches import SPECIFIERS, not bare
  global references). Forking `lib/bundle.mjs` to add more `define` entries
  is explicitly off-limits (owns the output contract with the app's
  self-check).
- **Fix**: `.design-sync/process-shim.js`, a zero-import leaf module, added
  as the FIRST `cfg.extraEntries` (before `./app/providers.tsx`). Sets
  `globalThis.process = { env: {} }` if missing. Relies on real ES module
  evaluation order — a dependency-free module in the entry graph evaluates
  before any sibling that imports things — to guarantee it runs before
  `lib/chains.ts`. Once `process` exists (even empty), `chains.ts`'s own
  `|| <default>` fallbacks take over exactly as they would in an
  unconfigured real deployment — this isn't hacking around the app's logic,
  it's letting the app's own designed-in fallback path do its job in an
  environment where `process` was never going to be defined regardless.

## [BUNDLE_EXPORT] false failure — missing charset on the local validate server
- After the process-shim fix, `package-validate.mjs` still failed with
  `[BUNDLE_EXPORT] 49/49 not a component on window.Access0x1Web` (fatal),
  even though the per-preview render check showed 43/49 clean and 6 honest
  floor-card blanks — i.e. every real preview card DOES correctly populate
  `window.Access0x1Web` when loaded by normal navigation.
- Root cause, confirmed by direct reproduction: the BUNDLE_EXPORT smoke test
  loads `_ds_bundle.js` via `page.setContent('<script src="/_ds_bundle.js">…')`
  after `page.goto('/')`, rather than by navigating directly to a real
  `<Name>.html` card (which uses relative script paths). Chromium's document
  loaded via `setContent()` doesn't inherit UTF-8 the same way a normal
  navigation does, and `.ds-sync/storybook/http-serve.mjs`'s `MIME` map
  serves `.js`/`.mjs` as `text/javascript` with **no charset** — so the
  externally-fetched `_ds_bundle.js` gets mis-decoded in that one loading
  path. `_ds_bundle.js` inlines `@adraffy/ens-normalize` (viem's ENS
  normalization dep), whose Unicode combining-diacritic character-class
  regex literals contain real multi-byte UTF-8 source characters — those get
  corrupted into an invalid character-class range under the wrong decoding,
  throwing `SyntaxError: Invalid regular expression: /[Ì€-Í¯]/g: Range out of
  order in character class` at module top-level, before `window.Access0x1Web`
  is ever assigned. Confirmed by reproducing the exact harness standalone:
  the error reproduces with the unmodified server and disappears once `.js`/
  `.mjs` are served as `text/javascript; charset=utf-8`.
- This is a harness bug (a local static-file server used only for
  validate/capture/probe), not a defect in the bundle or in this repo's
  config — the same bundle, same bytes, renders correctly for every real
  preview card via normal navigation.
- **Local fix applied**: `.ds-sync/storybook/http-serve.mjs`'s `MIME` map now
  serves `.js`/`.mjs` with an explicit `; charset=utf-8`. This file is one of
  the STAGED scripts (`cp -r` from the skill's own `design-sync/` base dir
  into `.ds-sync/`, gitignored) — **this edit does NOT survive a re-stage**.
  Re-apply after every `cp -r .../storybook .ds-sync/` (i.e. every fresh
  `.ds-sync/` setup or explicit re-stage) until/unless a future version of
  the skill ships this fix upstream: in `.ds-sync/storybook/http-serve.mjs`,
  change `'.js': 'text/javascript', '.mjs': 'text/javascript'` to
  `'.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8'`.
  Not applied via `.design-sync/overrides/` because `package-validate.mjs`
  imports this file by a hardcoded relative path
  (`import(new URL('./storybook/http-serve.mjs', import.meta.url))`), not
  through the `loadLib()`/overrides-checking indirection `package-build.mjs`
  uses — there's no sanctioned override slot for it.

## Preview authoring — two systemic fixes found during solo calibration
Discovered authoring the solo calibration set (Badge, Card family, Progress,
Button, Hero) — both affect EVERY component, not just these, so both are
fixed once at the shared level rather than per-preview:

1. **Dark chassis missing in preview cards.** The app's actual look comes
   from a GLOBAL rule in `app/globals.css` — `html, body { background:
   hsl(var(--background)); color: hsl(var(--foreground)) }` — applied once
   at the real app's root layout. The design-sync story-cell harness mounts
   each preview inside its own light-chrome card with no such ambient
   background. Any component that relies on inheriting `--foreground` text
   color, or has no background of its own, renders near-invisible: Badge's
   `outline` variant (near-white text, no bg, on a white card = blank),
   Button's `ghost` variant (same), Hero's entire headline/body/secondary-CTA
   (all use `text-foreground`/`text-muted-foreground` with no wrapping
   surface — rendered nearly illegible, confirmed by screenshot). **Fix**:
   `.design-sync/preview-chassis.tsx` — a `PreviewChassis` component wrapping
   the real `Providers` (wagmi/react-query) in a `bg-background
   text-foreground rounded-lg p-6` div, wired as `cfg.provider` (replacing
   the bare `Providers` reference) via `cfg.extraEntries`. This is the SAME
   ambient chassis every real render of these components gets — not an
   invented context — and fixes all 49 components' cards at once (floor
   cards included), not just authored ones.
2. **Tailwind content globs don't scan authored previews.** `tailwind.config.ts`'s
   `content` is `['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}',
   './lib/**/*.{ts,tsx}']` — `.design-sync/previews/**` isn't in it. Tailwind's
   JIT compiler only emits CSS for classes it can see in those files, so any
   utility class used ONLY in a preview (not already present somewhere in the
   real app source) silently compiles to nothing — the class sits in the
   rendered HTML with zero effect, no error, no warning. Confirmed on
   `Progress.tsx`'s `bg-[hsl(var(--success))]`: the 100%-value bar rendered
   completely unfilled instead of green (`.text-success` existed already —
   used elsewhere — but the arbitrary `bg-[...]` form did not). **Fix**:
   `.design-sync/tailwind.config.ts` re-exports the real config with
   `.design-sync/previews/**/*.tsx` appended to `content`; `build-inputs.sh`
   now compiles against this extended config instead of the real
   `tailwind.config.ts` directly. The real app's own config is untouched.
   **Consequence for authoring** (mine and any subagent's): prefer utility
   classes that already appear somewhere in the real app source (guaranteed
   compiled either way); arbitrary-value classes (`bg-[...]`, `text-[...]`)
   now compile too via this fix, but a REBUILD is required before they show
   up — a preview using a brand-new class that "looks blank" in a screenshot
   is this bug's signature, not necessarily a real component defect. Check
   the compiled CSS (`grep '<class>' .design-sync/.cache/compiled.css`)
   before concluding a render is broken.

## Fan-out wave learnings (folded 2026-07-17; batches A-F, 43/49 authored good)
Systemic findings from the parallel authoring wave — per-component detail lives
in the grade-file notes; only the reusable rules are kept here:

1. **`position: fixed` components need an in-flow spacer in their story.** The
   single-story card wraps renders in a `transform`ed `.ds-single` div, which
   (per CSS spec, intentionally — emit.mjs documents it) becomes the containing
   block for `fixed` descendants. But a fixed element contributes ZERO height
   to that container, so a component whose whole output is one fixed panel
   (AskAssistant's `fixed bottom-4 right-4` widget) anchors against a near-
   empty box and its TOP clips off-canvas with no error. Fix (per-story, no
   shared file): render `<div style={{height: <tallest-state-px>}} aria-hidden/>`
   as an in-flow sibling — spacer ≳ panel height, total under ~692px. Applies
   to any future toast/bottom-sheet/floating-CTA component. Radix Portal-based
   overlays (Tooltip family) are unaffected (positioned from the trigger rect).
2. **Tall components crop in their own capture PNG — not a defect.** Capture is
   a fixed ~900x700 canvas (`fullPage:false`); Hero, FeatureGrid, CheckoutCard
   all exceed it and their sheets crop while the DOM renders complete. The real
   product scales tall cards to its column with below-fold hover-scroll
   (emit.mjs's own comment). Graded good with notes; deliberately did NOT add
   `cfg.overrides.<Name>.viewport` overrides — validate raised no
   [GRID_OVERFLOW] on any of them, and presentation-only config churn would
   re-key grades for no product-visible gain. Revisit only if a real
   [GRID_OVERFLOW] warn ever fires.
3. **Env-emptiness manifests inside otherwise-good previews** (same root as the
   process-shim note — the shim makes `process.env` EXIST, never populates it):
   (a) CheckoutCard's internal TokenPicker shows USDC "Selected" AND "not
   available on this chain" at once — real code behavior for an unconfigured
   chain; (b) CheckoutCard's live quote hangs on "Fetching live quote…" forever
   (`/api/quote` 404 → `res.json()` throws unhandled, `loadingQuote` stuck) —
   deterministic, harmless for capture; (c) WorldIdGate renders the identical
   honest "not switched on" fail-soft line in every cell regardless of props
   (`NEXT_PUBLIC_WORLD_APP_ID` unset). Re-capture triggers: a real World
   app id (mirrors the Dynamic re-sync trigger) would make WorldIdGate's cells
   diverge; token env vars would fix (a).
4. **The `.light` island is load-bearing for white-label surfaces.** BrandPreview
   and CheckoutCard are DESIGNED for the `.light` token-swap wrapper their real
   call sites use (`<div className="light rounded-2xl border border-border
   bg-card ...">`). Compose previews inside that exact wrapper — on the bare
   dark chassis they'd still render but would misrepresent the intended look.
5. **Page views composing Dynamic-gated children are floor cards too** —
   ContractsView, SettingsBrandingView, SettingsCheckoutView, VerifyView all
   unconditionally render `<ConnectButton>` (+ a gated form each) with zero
   gating props; their real route pages wrap them in `MerchantProviders` for
   exactly this reason. Empirically confirmed once (ContractsView authored →
   `Hook must be used within <DynamicContextProvider>` → empty chassis →
   preview deleted), then inferred for the other three from identical source
   structure. Same re-sync trigger as the 15 leaf components; a fix would be a
   per-component provider override at the chassis level, never per-preview.
6. **Components with no controlled props can still be driven honestly**: the
   AskAssistant preview patches `window.fetch` at MODULE scope (before the
   component's mount-probe effect — patching inside useEffect loses the race)
   and drives the real DOM (native-setter + `dispatchEvent('input')` for
   React-controlled inputs, real clicks) to reach open/answered states. The
   rendered pixels are the real component's, never stand-in JSX.

Final wave tally: 43 authored + graded good, 6 deliberate floor cards
(CheckoutView + SlugCheckoutView via next/navigation; the 4 merchant page
views above via Dynamic) = 49.

## Known render warns (triaged benign — re-syncs check new warns against this list)
- `[RENDER_ERRORS] CheckoutCard: SyntaxError: Failed to execute 'json' on 'Response'`
  — the documented `/api/quote`-has-no-server manifestation (wave learnings §3b);
  card renders fully, quote line reads "Fetching live quote…". Benign.
- `[RENDER_THIN] WorldIdGate: variants render identically` — the documented
  env-empty fail-soft (wave learnings §3c): both cells honestly show the
  "not switched on" line until a real `NEXT_PUBLIC_WORLD_APP_ID` exists. Benign.
- `[GRID_OVERFLOW]` set resolved 2026-07-17 via `cfg.overrides` (5× portal/fixed
  → `single` with a chosen primaryStory; 4× wide → `column`) — the earlier
  "no GRID_OVERFLOW fired" note predates the wave's authored previews.

## Re-sync risks
- `.design-sync/.cache/compiled.css` and the `@fontsource-variable/*` packages
  in `node_modules` are NOT committed — a fresh clone needs `npm ci` (or at
  least `npm install --no-save @fontsource-variable/inter
  @fontsource-variable/space-grotesk`) and a `sh .design-sync/build-css.sh` run
  before the converter, same as this run.
- The 17-component skip list is a point-in-time decision tied to the current
  state of `useDynamicContext`/`useRouter` call sites and the empty Dynamic env
  var — if the app's provider architecture changes, or a real Dynamic env id
  becomes available, re-check this list rather than trusting it blindly.
- Component list comes from a live scan of `components/**` (PascalCase exports),
  not a frozen `.d.ts` — adding/removing/renaming a component file changes the
  synced set on the next build with no explicit signal beyond the build log's
  component count.
