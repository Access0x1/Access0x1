import { useEffect, useRef } from 'react'
import { OnChainSvgSimulator } from '@access0x1/web'
import { buildReport } from '@/lib/onchain-svg/report'

// OnChainSvgSimulator is the real stateful container (components/
// OnChainSvgSimulator.tsx): it owns file-reading + the POST /api/onchain-
// estimate call, with no controlled prop reaching its internal SimState. The
// idle cell is its true default render (matches app/simulate/page.tsx's bare
// `<OnChainSvgSimulator />`); the "done" cell drives the ACTUAL upload path —
// a synthetic File dropped into the real file input — against a mocked
// /api/onchain-estimate that answers with the app's own buildReport() math
// (lib/onchain-svg/report.ts), so the rendered numbers are real, not invented.
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#0AF"/><path d="M20 34l8 8 16-16" stroke="#fff" stroke-width="5" fill="none"/></svg>'

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

export const Idle = () => <OnChainSvgSimulator />

export const Uploaded = () => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const real = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.endsWith('/api/onchain-estimate') && init?.method === 'POST') {
        const body = {
          ...buildReport(SVG),
          live: {
            chainId: 84532,
            selfSendGas: '28214',
            gasPriceWei: '1000000000',
            weiPerUsd: '500000000000000',
            regime: 'eip7623' as const,
            errors: [] as string[],
          },
        }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return real(input, init)
    }
    void waitFor(root, 'input[type="file"]').then((input) => {
      const file = new File([SVG], 'mark.svg', { type: 'image/svg+xml' })
      const dt = new DataTransfer()
      dt.items.add(file)
      ;(input as HTMLInputElement).files = dt.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }, [])
  return (
    <div ref={ref}>
      <OnChainSvgSimulator />
    </div>
  )
}
