import { AskView } from '@access0x1/web'

// app/ask/page.tsx: `<AskView />` — the judge-facing /ask chat UI, zero props
// in real usage (the mount probe decides `capability` itself).
//
// `initialCapability` is documented as a "test/SSR seam only" — the component's
// own header says "the mount probe still corrects it in the browser." Confirmed:
// a second `Unconfigured` cell (`initialCapability="unconfigured"`) rendered
// pixel-identical to Default in this harness, because the mount effect's
// `fetch('/api/ask')` always resolves (404s against the static preview server,
// caught, falls open to "ready") before capture — same mechanism the component's
// own doc calls out, just not reachable live without inventing a fake /api/ask
// backend. See .design-sync/learnings/batch-E.md. One honest cell instead.
export const Default = () => <AskView />
