import { useEffect, useRef } from 'react'
import { AskAssistant } from '@access0x1/web'

// AskAssistant (components/AskAssistant.tsx) probes GET /api/ask on mount and
// renders NOTHING until the server confirms `configured: true` (fail-soft —
// no dead button on an unconfigured deployment). Its open/typed/answered
// states are internal useState with no controlled props. This module patches
// window.fetch at MODULE scope (so it's in place before AskAssistant's own
// mount effect fires) to answer as a configured deployment — the realistic
// case a merchant actually ships — then drives the real DOM (click the
// trigger, type a question, submit) to reach states no prop exposes. The
// answer text mirrors the real one-tag embed snippet from components/
// LinkCard.tsx / components/branding/BrandingForm.tsx, not invented copy.
//
// The panel is `fixed bottom-4 right-4` (real app CSS, untouched here). The
// design-sync single-story card wraps each render in a `transform`-ed div
// (.ds-single), which per CSS spec becomes the CONTAINING BLOCK for
// position:fixed descendants — intentional harness behavior so fixed
// overlays render inside the card instead of escaping to the page (see
// .ds-sync/lib/emit.mjs). That container's own box is only as tall as its
// IN-FLOW content, and the fixed panel itself contributes none (out of
// flow) — so with no other content, `bottom-4` anchors just below the
// card's top edge, leaving no room for a panel taller than that and
// clipping its top off-canvas. SPACER gives the container real height so
// the anchor lands with room for the whole panel above it.
const ANSWER =
  'Drop one script tag on your page — <script src="https://yourdomain/embed.js" data-merchant="123" ' +
  'data-amount-usd="29.00"></script> — and Access0x1 renders a full checkout. No contract code, no SDK install ' +
  'needed for the basic embed.'

const real = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input as Request).url
  if (url.endsWith('/api/ask') && (!init || init.method === undefined)) {
    return new Response(JSON.stringify({ configured: true }), { status: 200 })
  }
  if (url.endsWith('/api/ask') && init?.method === 'POST') {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(ANSWER))
        controller.close()
      },
    })
    return new Response(stream, { status: 200 })
  }
  return real(input, init)
}

function waitFor<T extends HTMLElement = HTMLElement>(root: HTMLElement, selector: string, tries = 300): Promise<T> {
  return new Promise((resolve, reject) => {
    const tick = (n: number) => {
      const el = root.querySelector<T>(selector)
      if (el) return resolve(el)
      if (n <= 0) return reject(new Error(`timed out waiting for ${selector}`))
      requestAnimationFrame(() => tick(n - 1))
    }
    tick(tries)
  })
}

const SPACER = <div style={{ height: 620 }} aria-hidden />

export const Collapsed = () => <AskAssistant initialConfigured />

export const Expanded = () => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    void waitFor(root, 'button').then((btn) => btn.click())
  }, [])
  return (
    <div ref={ref}>
      {SPACER}
      <AskAssistant initialConfigured />
    </div>
  )
}

export const Answered = () => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    void (async () => {
      const openBtn = await waitFor(root, 'button')
      openBtn.click()
      const textarea = await waitFor<HTMLTextAreaElement>(root, 'textarea')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'How do I integrate Access0x1 into my checkout?')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      const submitBtn = await waitFor(root, 'button[type="submit"]')
      submitBtn.click()
      await waitFor(root, 'p.whitespace-pre-wrap')
    })()
  }, [])
  return (
    <div ref={ref}>
      {SPACER}
      <AskAssistant initialConfigured />
    </div>
  )
}
