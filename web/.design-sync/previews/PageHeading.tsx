import { PageHeading } from '@access0x1/web'

// The shared merchant-page title grammar. Real call sites split into two
// shapes: a bare title (Dashboard) and an eyebrow + title pair (every
// settings/onboarding sub-page) — that's the one axis worth sweeping.

// DashboardView.tsx: <PageHeading title="Dashboard" />
export const NoEyebrow = () => <PageHeading title="Dashboard" />

// SettingsBrandingView.tsx:
// <PageHeading eyebrow="Settings · Branding" title="Name, description, logo" />
export const WithEyebrow = () => (
  <PageHeading eyebrow="Settings · Branding" title="Name, description, logo" />
)
