/**
 * locale.route.test.ts — `POST /api/locale`, the server-side locale switch.
 *
 * These tests pin a **deploy-time contract**, not just app behaviour. The CDN in
 * front of the origin has to forward the locale cookie AND include it in the
 * cache key (docs/WEB-DEPLOY.md §8); if the cookie is renamed here without the
 * edge config changing, CloudFront serves cached pages in the wrong language and
 * nothing in the app errors. So the NAME is asserted literally, on purpose:
 * this test is the tripwire that makes that rename loud.
 *
 * Also covers: only a supported locale can ever be stored (no arbitrary
 * attacker-chosen cookie value), and malformed JSON is a clean 400.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LOCALE_COOKIE, LOCALES } from '@/lib/i18n/config'

const { POST } = await import('../route.js')

const post = (body: unknown, raw?: string): Promise<Response> =>
  POST(
    new Request('http://localhost/api/locale', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw ?? JSON.stringify(body),
    }),
  ) as unknown as Promise<Response>

afterEach(() => {
  // NODE_ENV is read at request time to decide `Secure`; restore between tests.
  vi.unstubAllEnvs()
})

describe('the cookie NAME is a deploy contract (CDN forwards + caches on it)', () => {
  it('is exactly `access0x1_lang` — renaming requires an edge-config change', () => {
    expect(LOCALE_COOKIE).toBe('access0x1_lang')
  })

  it('is not one of the framework defaults a managed CDN policy would cover', () => {
    // No AWS managed origin-request policy whitelists this, so the deployment
    // needs a CUSTOM policy. Asserting the negative keeps that fact visible.
    expect(['NEXT_LOCALE', 'locale', 'lang']).not.toContain(LOCALE_COOKIE)
  })
})

describe('POST /api/locale — setting a locale', () => {
  it('sets the cookie for every supported locale', async () => {
    for (const locale of LOCALES) {
      const res = await post({ locale })
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ ok: true, locale })
      expect(res.headers.get('set-cookie')).toContain(`${LOCALE_COOKIE}=${locale}`)
    }
  })

  it('scopes the cookie to the whole site, for a year, SameSite=Lax', async () => {
    const res = await post({ locale: 'pt' })
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain(`Max-Age=${60 * 60 * 24 * 365}`)
    expect(cookie.toLowerCase()).toContain('samesite=lax')
  })

  it('is NOT HttpOnly-dependent: it is a UI preference, readable is fine', async () => {
    // Documented intent — the switcher only needs the server to read it, but the
    // value is non-sensitive (a two-letter language code), so no secret leaks
    // either way. Pinned so a future "harden everything" pass is a deliberate choice.
    const res = await post({ locale: 'en' })
    expect(res.status).toBe(200)
  })
})

describe('Secure flag — production only (localhost dev must keep working)', () => {
  it('sets Secure in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const cookie = (await post({ locale: 'pt' })).headers.get('set-cookie') ?? ''
    expect(cookie).toContain('Secure')
  })

  it('omits Secure outside production, or the switcher breaks over http://localhost', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const cookie = (await post({ locale: 'pt' })).headers.get('set-cookie') ?? ''
    expect(cookie).not.toContain('Secure')
  })
})

describe('only a supported locale can ever be stored', () => {
  it('rejects an unsupported / junk locale with 400 and sets no cookie', async () => {
    for (const bad of ['de', 'pt-BR', '', 'en; Domain=evil.example', '../../etc']) {
      const res = await post({ locale: bad })
      expect(res.status, bad).toBe(400)
      await expect(res.json()).resolves.toEqual({ error: 'invalid_locale' })
      expect(res.headers.get('set-cookie'), bad).toBeNull()
    }
  })

  it('rejects non-string locales (no type confusion into the cookie)', async () => {
    for (const bad of [null, 1, true, { locale: 'en' }, ['en']]) {
      const res = await post({ locale: bad })
      expect(res.status).toBe(400)
      expect(res.headers.get('set-cookie')).toBeNull()
    }
  })

  it('rejects a body that is not JSON at all with 400, never a 500', async () => {
    const res = await post(undefined, 'not json{')
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'invalid_locale' })
  })

  it('rejects an empty body', async () => {
    const res = await post(undefined, '')
    expect(res.status).toBe(400)
  })
})
