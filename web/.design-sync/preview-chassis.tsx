import type { ReactNode } from 'react'
import { Providers } from '../app/providers'

// design-sync cfg.provider wrapper — every preview card mounts through this.
//
// Why: the app's real dark "night water" chassis comes from a GLOBAL rule in
// app/globals.css — `html, body { background: hsl(var(--background)); color:
// hsl(var(--foreground)) }` — applied once, app-wide, in app/layout.tsx's
// root. The design-sync story-cell harness renders each preview inside its
// own light-chrome card, which doesn't carry that ambient dark background.
// Any component that relies on inheriting --foreground text color or sits on
// no background of its own (Badge's `outline` variant, Button's `ghost`
// variant, Hero's whole body copy) renders near-invisible: near-white text
// on the story cell's white background. Confirmed on Badge (Outline chip
// unreadable), Button (Ghost unreadable), Hero (headline/body/secondary CTA
// all low-contrast to invisible).
//
// This reproduces the SAME chassis every real render of these components
// gets — not an invented context, the actual one.
export function PreviewChassis({ children }: { children: ReactNode }): ReactNode {
  return (
    <Providers>
      <div className="bg-background text-foreground rounded-lg p-6">{children}</div>
    </Providers>
  )
}
