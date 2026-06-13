import type { Config } from 'tailwindcss'

/**
 * Tailwind config for checkout-web.
 *
 * Brand defaults from the spec:
 *   - text / ink:   #0A0A0A
 *   - accent (rail) #6366F1  (the Access0x1 default; a merchant's on-chain
 *                             brand color overrides this at render time)
 */
const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        ink: '#0A0A0A',
        rail: '#6366F1',
      },
    },
  },
  plugins: [],
}

export default config
