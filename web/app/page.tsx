import { redirect } from 'next/navigation'

/** Root redirects to the onboarding flow — the product entry point. */
export default function Home(): never {
  redirect('/onboard')
}
