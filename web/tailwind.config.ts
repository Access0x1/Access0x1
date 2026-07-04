import type { Config } from 'tailwindcss'

/**
 * Tailwind config for checkout-web.
 *
 * Brand tokens are DRIVEN BY the CSS variables in globals.css — never hardcoded
 * here — so a whole-app rebrand is a token swap in one place and every legacy
 * `text-ink` / `bg-rail` class re-themes with the chassis:
 *   - text / ink:   hsl(var(--foreground))  (chassis text — #F5F7FB on the dark
 *                             default; flips to dark inside a `.light` island)
 *   - accent (rail) hsl(var(--primary))     (the lit path — cyan #22D3EE on the
 *                             dark default; a merchant's on-chain brandColor
 *                             still overrides this at render time via inline style)
 */
const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        // Brand typography (BRAND.md): Inter for UI/body, Space Grotesk for the
        // display/wordmark. The CSS variables are set by next/font in layout.tsx;
        // a system stack follows as the fallback before the fonts load.
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: [
          'var(--font-display)',
          'var(--font-sans)',
          'ui-sans-serif',
          'system-ui',
          'sans-serif',
        ],
      },
      colors: {
        // The app's legacy brand tokens — now CHASSIS-DRIVEN (not hardcoded
        // light-era hexes). `text-ink` == the chassis foreground and `bg-rail`/
        // `text-rail` == the primary (cyan), so the 37 `text-ink` + `*-rail`
        // call sites re-theme with the dark default and flip correctly inside a
        // `.light` island. A merchant's brandColor still overrides via inline style.
        ink: 'hsl(var(--foreground))',
        rail: 'hsl(var(--primary))',
        // shadcn/ui tokens, driven by the CSS variables in globals.css. These
        // are additive: existing classes (text-ink, bg-rail) keep working, and
        // the new shadcn components reference bg-card, text-muted-foreground,
        // border-border, etc.
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [],
}

export default config
