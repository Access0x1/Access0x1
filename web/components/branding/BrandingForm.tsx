'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { DEFAULT_BRAND_COLOR } from '@/lib/branding/logo'
import {
  checkSlug,
  fileToDataUri,
  loadBranding,
  saveBranding,
  uploadLogo,
  type ClientBranding,
} from '@/lib/branding/client'
import { shouldRestoreSavedOnReconnect } from '@/lib/branding/doneScreen'
import { checkoutHost, checkoutOrigin } from '@/lib/branding/checkoutHost'
import { BrandPreview } from './BrandPreview'

type SlugState = {
  checking: boolean
  valid: boolean
  available: boolean
  suggestions: string[]
}

/**
 * BrandingForm — the non-coder "Make it yours" screen (ADR D2) and the flat
 * Settings → Branding card (ADR D2 "Editing later"). Three plain-English fields,
 * a live "Pay {name}" preview, a live checkout-link availability check, and a
 * skip-logo monogram default. One Save. No jargon, no addresses, no gas.
 *
 * `mode="onboard"` shows the done screen (link + copy embed + test it) after the
 * first Save. `mode="settings"` is the compact edit card ("Changes saved").
 */
export function BrandingForm({
  mode = 'onboard',
  onSaved,
}: {
  mode?: 'onboard' | 'settings'
  onSaved?: (b: ClientBranding) => void
}): ReactNode {
  const { primaryWallet } = useDynamicContext()
  const tenantId = primaryWallet?.address?.toLowerCase()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [brandColor, setBrandColor] = useState(DEFAULT_BRAND_COLOR)
  const [slug, setSlug] = useState('') // the editable readable tail
  const [slugTouched, setSlugTouched] = useState(false)
  const [logoSvg, setLogoSvg] = useState<string | undefined>(undefined)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [slugState, setSlugState] = useState<SlugState>({
    checking: false,
    valid: false,
    available: false,
    suggestions: [],
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState<ClientBranding | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // The truthful checkout-link prefix — the real host this deploy serves (or a
  // configured dedicated checkout domain), resolved client-side. Empty during
  // SSR/first paint; we show a neutral placeholder until it hydrates.
  const [linkHost, setLinkHost] = useState('')
  useEffect(() => setLinkHost(checkoutHost()), [])
  const linkPrefix = linkHost ? `${linkHost}/c/` : 'your-domain/c/'

  // Prefill from the tenant's existing row (Settings edit, or returning user).
  useEffect(() => {
    if (!tenantId) return
    let cancelled = false
    void loadBranding(tenantId).then((row) => {
      if (cancelled || !row) return
      setName(row.displayName)
      setDescription(row.description)
      setBrandColor(row.brandColor)
      setSlug(row.checkoutSlug)
      setSlugTouched(true)
      setLogoSvg(row.logoSvgInline || undefined)
      // Restore the saved state on reconnect: in SETTINGS this drives the
      // "Changes saved" affordance; in ONBOARD it restores the DONE screen so a
      // returning merchant lands on their checkout-link/embed/"Test it" screen
      // (with Edit) rather than a blank-looking "Save and get my checkout link".
      if (shouldRestoreSavedOnReconnect(row)) setSaved(row)
    })
    return () => {
      cancelled = true
    }
  }, [tenantId, mode])

  // As they type the name, auto-fill the checkout link tail until they edit it.
  const effectiveSlug = slugTouched ? slug : autoSlug(name)

  // Debounced availability check on the effective slug.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!effectiveSlug) {
      setSlugState({ checking: false, valid: false, available: false, suggestions: [] })
      return
    }
    setSlugState((s) => ({ ...s, checking: true }))
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void checkSlug(effectiveSlug, tenantId).then((r) => {
        setSlugState({
          checking: false,
          valid: r.valid,
          available: r.available,
          suggestions: r.suggestions,
        })
      })
    }, 350)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [effectiveSlug, tenantId])

  const handleLogoFile = useCallback(
    async (file: File) => {
      setLogoError(null)
      if (!tenantId) return
      try {
        const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')
        const raw = isSvg ? await file.text() : await fileToDataUri(file)
        const res = await uploadLogo(tenantId, raw)
        if (res.ok) setLogoSvg(res.logoSvgInline)
        else setLogoError(res.error)
      } catch {
        setLogoError('Could not read that file. Try a PNG, JPG, or SVG.')
      }
    },
    [tenantId],
  )

  async function handleSave(): Promise<void> {
    setSaveError(null)
    if (!tenantId) {
      setSaveError('Sign in to save your branding.')
      return
    }
    if (!name.trim()) {
      setSaveError('What is your business called?')
      return
    }
    setSaving(true)
    const res = await saveBranding({
      tenantId,
      displayName: name,
      description,
      brandColor,
      checkoutSlug: effectiveSlug || undefined,
      logoSvgInline: logoSvg,
    })
    setSaving(false)
    if (res.ok) {
      setSaved(res.branding)
      setSlug(res.branding.checkoutSlug)
      setSlugTouched(true)
      setLogoSvg(res.branding.logoSvgInline || undefined)
      onSaved?.(res.branding)
    } else {
      setSaveError(res.error)
      if (res.code === 'SLUG_TAKEN') setSlugState((s) => ({ ...s, available: false }))
    }
  }

  // Not signed in yet — the whole flow lives in-app; just prompt sign-in.
  if (!tenantId) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p className="text-sm text-neutral-600">
          Sign in to set your name, description, and logo. It takes under two minutes.
        </p>
      </div>
    )
  }

  // Onboarding done screen: link + copy embed + test it.
  if (mode === 'onboard' && saved) {
    return <DoneScreen branding={saved} onEditAgain={() => setSaved(null)} />
  }

  const slugBadge = effectiveSlug
    ? slugState.checking
      ? { text: 'Checking…', cls: 'text-neutral-400' }
      : !slugState.valid
        ? { text: 'Letters, numbers, hyphens', cls: 'text-amber-600' }
        : slugState.available
          ? { text: '✓ available', cls: 'text-green-600' }
          : { text: '✕ taken', cls: 'text-red-600' }
    : null

  return (
    <div className="flex flex-col gap-7">
      {/* 1) Business name + live checkout link */}
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1">
          <span className="font-medium text-ink">What is your business called?</span>
          <span className="text-sm text-neutral-500">
            This is the name customers see when they pay — on your checkout page and right inside
            their wallet.
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Joe's Barbershop"
            maxLength={80}
            className="mt-1 rounded-lg border border-neutral-300 px-3 py-2 outline-none focus:border-rail"
          />
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-ink">Your checkout link</span>
          <div className="flex items-stretch overflow-hidden rounded-lg border border-neutral-300 focus-within:border-rail">
            <span className="flex items-center bg-neutral-100 px-3 text-sm text-neutral-500">
              {linkPrefix}
            </span>
            <input
              type="text"
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true)
                setSlug(e.target.value.toLowerCase())
              }}
              placeholder="joes-barbershop"
              className="grow px-2 py-2 text-sm outline-none"
            />
            {slugBadge ? (
              <span className={`flex items-center px-3 text-xs ${slugBadge.cls}`}>
                {slugBadge.text}
              </span>
            ) : null}
          </div>
          {slugState.suggestions.length > 0 ? (
            <p className="text-xs text-neutral-500">
              Try:{' '}
              {slugState.suggestions.map((s, i) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setSlugTouched(true)
                    setSlug(s)
                  }}
                  className="text-rail underline-offset-2 hover:underline"
                >
                  {s}
                  {i < slugState.suggestions.length - 1 ? ', ' : ''}
                </button>
              ))}
            </p>
          ) : null}
          <p className="text-xs text-neutral-400">
            Pick this carefully — it goes on every receipt and QR code you hand out, so it stays the
            same once you share it.
          </p>
        </div>
      </div>

      {/* 2) One-line description */}
      <label className="flex flex-col gap-1">
        <span className="font-medium text-ink">Tell customers what you do — in one line.</span>
        <span className="text-sm text-neutral-500">
          A short, plain-English description. It shows up under your name when someone pays.
        </span>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Fresh cuts & hot-towel shaves in Brooklyn"
          maxLength={140}
          className="mt-1 rounded-lg border border-neutral-300 px-3 py-2 outline-none focus:border-rail"
        />
      </label>

      {/* 3) Logo + brand color */}
      <div className="flex flex-col gap-2">
        <span className="font-medium text-ink">Add your logo.</span>
        <span className="text-sm text-neutral-500">
          Drag in a square image (we recommend 200×200, PNG, SVG, or JPG). We&apos;ll show it on
          your checkout and in the wallet.
        </span>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50"
          >
            {logoSvg ? 'Replace logo' : 'Choose a file'}
          </button>
          {logoSvg ? (
            <button
              type="button"
              onClick={() => setLogoSvg(undefined)}
              className="text-sm text-neutral-500 underline-offset-2 hover:underline"
            >
              Skip for now — I&apos;ll add a logo later
            </button>
          ) : (
            <span className="text-sm text-neutral-400">
              No logo? We&apos;ll use your initials on your brand color.
            </span>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void handleLogoFile(f)
            }}
          />
          <label className="ml-auto flex items-center gap-2 text-sm text-neutral-500">
            Brand color
            <input
              type="color"
              value={hexForInput(brandColor)}
              onChange={(e) => setBrandColor(e.target.value)}
              className="h-8 w-10 cursor-pointer rounded border border-neutral-300"
              aria-label="Brand color"
            />
          </label>
        </div>
        {logoError ? <p className="text-sm text-red-600">{logoError}</p> : null}
      </div>

      {/* Live preview — the result before saving (CR live-preview law). A
          DELIBERATE `.light` island: this shows the customer-facing checkout,
          which is a bright white-label card, so it stays light on the dark app
          chassis. `.light` re-defines --foreground/--card within it, so
          BrandPreview's `text-ink` reads dark-on-light here. */}
      <div className="light rounded-2xl border border-border bg-card p-5">
        <p className="mb-3 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          This is what customers see
        </p>
        <BrandPreview
          name={name}
          description={description}
          logoSvg={logoSvg}
          brandColor={brandColor}
        />
      </div>

      {saveError ? <p className="text-sm text-red-600">{saveError}</p> : null}
      {mode === 'settings' && saved && !saveError ? (
        <p className="text-sm text-green-600">Changes saved.</p>
      ) : null}

      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={saving || !name.trim()}
        className="rounded-lg bg-rail px-4 py-3 font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving
          ? 'Saving…'
          : mode === 'settings'
            ? 'Save changes'
            : 'Save and get my checkout link'}
      </button>
    </div>
  )
}

/** The "you're live" screen: checkout link + copy embed + test it (ADR D2 step 4). */
function DoneScreen({
  branding,
  onEditAgain,
}: {
  branding: ClientBranding
  onEditAgain: () => void
}): ReactNode {
  // Honor a configured dedicated checkout domain, else the real deploy origin —
  // the same truthful base as the editing prefix (never a hardcoded brand host).
  const [origin, setOrigin] = useState('')
  useEffect(() => setOrigin(checkoutOrigin()), [])
  const link = origin ? `${origin}/c/${branding.checkoutSlug}` : ''
  const embed = origin
    ? `<script src="${origin}/embed.js" data-slug="${branding.checkoutSlug}" data-amount-usd="29.00"></script>`
    : ''

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-ink">{branding.displayName} is set up.</h2>
        <p className="text-sm text-neutral-500">
          Your branded checkout page is ready to share. To start accepting USDC, finish the quick
          one-time on-chain setup from your dashboard.
        </p>
      </div>

      {/* The customer-facing preview stays a bright white-label island (`.light`)
          on the dark chassis, so BrandPreview's `text-ink` reads dark-on-light. */}
      <div className="light rounded-2xl border border-border bg-card p-5">
        <BrandPreview
          name={branding.displayName}
          description={branding.description}
          logoSvg={branding.logoSvgInline || undefined}
          brandColor={branding.brandColor}
        />
      </div>

      <CopyRow label="Your checkout link" value={link} />
      <CopyRow label="Copy embed tag" value={embed} mono />

      {/* PRIMARY next step: switch on payments. The slug stays "not yet live"
          until the merchant finishes the one-time on-chain register on the
          dashboard — so this is the real CTA, not the "Test it" preview. */}
      <a
        href="/dashboard"
        className="rounded-lg bg-rail px-4 py-3 text-center text-sm font-medium text-white transition-opacity hover:opacity-90"
      >
        Switch on payments →
      </a>
      <p className="-mt-3 text-xs text-neutral-500">
        Your link is branded and ready to share, but it can’t take USDC until you finish the quick
        one-time on-chain setup on your dashboard.
      </p>

      {/* Secondary: preview the (not-yet-live) page, and edit. "Test it" opens
          the real checkout page, which honestly shows "hasn't switched on
          payments yet" until the on-chain step is done (law #4 — no fake live
          checkout). */}
      <div className="flex flex-wrap items-center gap-3">
        <a
          href={link || '#'}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-ink hover:bg-neutral-50"
        >
          Test it
        </a>
        <button
          type="button"
          onClick={onEditAgain}
          className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-ink hover:bg-neutral-50"
        >
          Edit name, description, or logo
        </button>
      </div>
    </div>
  )
}

/** A label + read-only value + Copy button row with transient "Copied" feedback. */
function CopyRow({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}): ReactNode {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink">{label}</span>
      <div className="flex items-start gap-2">
        <code
          className={`grow break-all rounded-lg bg-neutral-100 px-3 py-2 ${mono ? 'text-xs' : 'text-sm'}`}
        >
          {value}
        </code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
          className="shrink-0 rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

/** Auto-derive the readable link tail from the typed name (client mirror of slugify). */
function autoSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
}

/** Coerce a stored brand color into a 6-char hex the native color input accepts. */
function hexForInput(color: string): string {
  const hex = color.replace(/^#/, '')
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex}`
  if (/^[0-9a-fA-F]{8}$/.test(hex)) return `#${hex.slice(0, 6)}`
  return DEFAULT_BRAND_COLOR
}
