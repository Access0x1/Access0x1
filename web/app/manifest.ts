import type { MetadataRoute } from 'next'

/**
 * Web app manifest (served at /manifest.webmanifest via Next 15's app-dir
 * convention). Makes the hosted rail installable as a PWA and gives Android /
 * Chrome the branded icon + theme.
 *
 * Colours are the brand chassis (BRAND.md): night-water #0B1020 as both the
 * theme and background so the splash + address bar stay on-brand. Icons point at
 * the PNG marks in /public.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Access0x1',
    short_name: 'Access0x1',
    description: 'Accept USD-priced crypto with one link — zero custody, no contract code.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0B1020',
    theme_color: '#0B1020',
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  }
}
