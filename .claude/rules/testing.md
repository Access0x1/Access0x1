# RULES — testing (always on)

Winners shipped 1,500+ tests by treating tests as a deliberate pass, not an
afterthought. "Green every step" is only real if every step has a test.

- **Test-as-a-second-pass:** write the function, then IMMEDIATELY write its
  `forge` test(s) before moving on. For a test that must land first to keep the
  build green, the test is its own commit (law #4).
- **The gate before every commit** (the verification-loop): `forge build` →
  `forge test` → `forge fmt --check` must all be green. Frontend changes also run
  typecheck + lint + build. Use `/build-loop` and `/chains-green`.
- **Coverage target ≥ 95% lines** on the router (`forge coverage`); the five
  invariants (fees+net==gross, Σfees, zero-custody residual, merchant isolation,
  fee cap) must hold under the fuzzer.
- **Reuse the proven Cyfrin patterns** (MIT-headed files only, attributed in
  the file header): OracleLib staleness guard, handler-based invariant suite,
  `MockV3Aggregator`, `@chainlink/local` CCIP simulator.
- Never weaken a test or edit a config to make a failure "pass" — fix the code.
