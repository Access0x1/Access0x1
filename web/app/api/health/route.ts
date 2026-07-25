import { NextResponse } from 'next/server'

/**
 * GET /api/health — "is the app actually serving, and WHICH build is it?"
 *
 * This exists because of a real failure that cost an evening: `/api/integrations`
 * returned 404 on the live domain while the repo plainly contains that route and
 * `next.config.ts` has no static export. A 404 on an API route from a Next.js
 * SERVER build is not possible — so the 404 proved the domain was not reaching the
 * app at all. Without a known-good endpoint to compare against, that looked
 * indistinguishable from an auth bug, and the debugging went the wrong way for an hour.
 *
 * This route is the control in that experiment. It has NO dependencies: no env var,
 * no database, no chain read, no auth. If it answers, the app is serving and routing
 * works, and any other endpoint's 404 is that endpoint's problem. If it 404s or
 * hangs, nothing else about the app is worth debugging yet — the request never
 * reached the server, and the place to look is the CDN/proxy in front of it.
 *
 * The classic cause on this stack: a CDN (CloudFront) in front of Cloud Run whose
 * default cache behaviour serves a static origin, so `/_next/*` and the pages work
 * while every `/api/*` path falls through to a 404 that never touches the app.
 *
 * SAFETY: names and booleans only. `commit` is public information (it is in the
 * repo), and no env VALUE is read or echoed — an unauthenticated caller learns
 * nothing they could not learn from the public git history.
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      ok: true,
      service: 'access0x1-web',
      /** Which build is live. Set by the deploy pipeline; 'unknown' when unset. */
      commit: (process.env.NEXT_PUBLIC_BUILD_COMMIT ?? '').trim() || 'unknown',
      /**
       * Proves API routes are reachable. If you can read this line, a 404 on any
       * other `/api/*` path means that route is missing from THIS build — not that
       * the deployment is broken.
       */
      apiRoutesReachable: true,
      runtime: 'nodejs',
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
