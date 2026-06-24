/**
 * onboard.spec.ts — the merchant onboarding journey.
 *
 * Covers the non-coder "Make it yours" flow (/onboard): connect a wallet, fill
 * the plain-English branding fields (name + checkout link), Save, and land on
 * the "you're live" done screen that hands back the shareable checkout link, the
 * copy-embed tag, and a "Test it" button.
 *
 * Everything external is mocked by the wallet fixture (no keys, no funds, no
 * Dynamic backend, no chain): the slug-availability check, the branding save,
 * and the wallet connection are all answered deterministically.
 */

import { test, expect, TEST_ACCOUNT } from './fixtures/wallet'

test.describe('merchant onboarding', () => {
  test('connect → brand → save yields the live checkout link', async ({ page, wallet }) => {
    // The slug the mocked save returns; the done screen builds the link from it.
    const scenario = await wallet.setup({ merchantName: "Joe's Barbershop", slug: 'joes-barbershop' })

    await page.goto('/onboard')

    // The page header is the non-coder "Make it yours" screen.
    await expect(page.getByRole('heading', { name: /make it yours/i })).toBeVisible()

    // Before sign-in the form prompts to connect; connect the mocked wallet.
    const connected = await wallet.connect()
    expect(connected, 'mocked injected wallet should connect').toBe(true)

    // Once signed in the branding fields render (keyed off the wallet address).
    const nameField = page.getByPlaceholder("e.g. Joe's Barbershop")
    await expect(nameField).toBeVisible()

    // Fill the business name — this also auto-fills the checkout-link tail and
    // drives the live "Pay {name}" preview.
    await nameField.fill(scenario.merchantName)
    await expect(page.getByText(`Pay ${scenario.merchantName}`).first()).toBeVisible()

    // The checkout-link availability check resolves to "available" (mocked).
    await expect(page.getByText('✓ available').first()).toBeVisible()

    // Save and get the checkout link.
    await page.getByRole('button', { name: /save and get my checkout link/i }).click()

    // ── The "you're live" done screen ──────────────────────────────────────
    await expect(page.getByRole('heading', { name: /joe's barbershop is set up/i })).toBeVisible()

    // The shareable checkout link points at the slug's hosted checkout.
    const checkoutLink = page.getByText(new RegExp(`/c/${scenario.slug}$`)).first()
    await expect(checkoutLink).toBeVisible()

    // The embed tag is offered, and "Test it" links to the live checkout page.
    await expect(page.getByText('Copy embed tag')).toBeVisible()
    const testIt = page.getByRole('link', { name: /test it/i })
    await expect(testIt).toBeVisible()
    await expect(testIt).toHaveAttribute('href', new RegExp(`/c/${scenario.slug}$`))
  })

  test('signed-out onboard prompts to connect a wallet', async ({ page, wallet }) => {
    // Set up the mocks but DON'T connect — the form must gate on sign-in.
    await wallet.setup()
    await page.goto('/onboard')

    // The form's signed-out branch asks the merchant to sign in first; the name
    // field is absent until a wallet (tenant) is connected.
    await expect(page.getByText(/sign in to set your name, description, and logo/i)).toBeVisible()
    await expect(page.getByPlaceholder("e.g. Joe's Barbershop")).toHaveCount(0)

    // A Connect wallet affordance is offered (the only way forward).
    await expect(page.getByRole('button', { name: /connect wallet/i }).first()).toBeVisible()
    // Sanity: the fixture account is the deterministic dummy, never a real key.
    expect(TEST_ACCOUNT).toMatch(/^0x1{40}$/)
  })
})
