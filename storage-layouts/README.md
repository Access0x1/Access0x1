# storage-layouts/ — the committed UUPS storage snapshots

One `<Module>.json` per upgradeable module: the normalized `forge inspect <Module> storage-layout`,
the baseline the storage-layout guard diffs every prospective upgrade against. This is to a bricked
proxy what `abis/` is to a missing ABI — a committed artifact that turns an invisible, irreversible
mistake into a red CI check.

**What each entry is.** `{ label, slot, offset, type, bytes, sig }`. `type` + `bytes` are the readable
top-level type label + width; **`sig` is the real safety signal** — a fully-resolved, astId-free
fingerprint of the entire type tree (struct members with their slots/offsets/types, mapping key+value,
array base+length). A top-level slot like `_escrows :: mapping(uint256 => struct Escrow)` never changes
its top-level label when you reorder or retype a field *inside* `Escrow`, so a label-only check is blind
to exactly the edit that corrupts every existing record — `sig` expands the struct so that edit trips
the guard.

**The invariant** (`scripts/sync-storage-layouts.mjs`, run as `make upgrade-guard`):
- every pre-existing slot stays byte-identical (no reorder / insert-before / retype / removal, at any
  depth), and
- the trailing `__gap`'s END slot never moves — new storage is only ever carved out of the gap.

**Workflow.** Append new vars *before* `__gap`, shrink `__gap` by exactly the slots you added, run
`make upgrade-snapshot`, review the diff, commit. Never edit these files by hand. Do NOT re-snapshot to
make a red guard go green unless the change is a reviewed, append-only one over source that is (or is
about to be) deployed — see `docs/UPGRADING.md`.
