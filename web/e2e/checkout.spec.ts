/**
 * checkout.spec.ts — the buyer checkout journey.
 *
 * Covers the hosted checkout (/c/{slug}): resolve the branded tenant, render the
 * live USD→token quote, connect a wallet, Pay, and land on the receipt — then
 * assert the receipt's transaction-hash link renders to the chain explorer.
 *
 * The wallet + chain are fully mocked (no keys, no funds): the branding lookup,
 * the `/api/quote` price, the on-chain merchant read, and the settlement tx +
 * its `PaymentReceived` receipt log are all served deterministically by the
 * fixture. Base Sepolia is the target chain so a real `sepolia.basescan.org/tx/`
 * link is produced (the assertion below).
 */

import {
  test,
  expect,
  TEST_TX_HASH,
  TEST_CHAIN_ID,
} from './fixtures/wallet'

const SLUG = 'joes-barbershop'

test.describe('buyer checkout', () => {
  test('quote → pay → receipt renders the tx-hash explorer link', async ({ page, wallet }) => {
    await wallet.setup({ slug: SLUG, merchantName: "Joe's Barbershop", onChain: true, active: true })

    // The price comes from the URL (?amount); default checkout is $29.00.
    await page.goto(`/c/${SLUG}?amount=29.00`)

    // The branded header resolves from the (mocked) public branding endpoint.
    await expect(page.getByRole('heading', { name: /joe's barbershop/i }).first()).toBeVisible()

    // The live quote renders — the token amount (≈ 29.01 USDC) the mock returns,
    // distinct from the $29.00 USD price, proving it is the QUOTE not an echo.
    await expect(page.getByText('$29.00').first()).toBeVisible()
    await expect(page.getByText(/≈\s*29\.01\s*USDC/i)).toBeVisible()

    // Connect the mocked injected wallet so the Pay button appears.
    const connected = await wallet.connect()
    expect(connected, 'mocked injected wallet should connect').toBe(true)

    // Pay — the mocked send + receipt drive the success screen.
    const payButton = page.getByRole('button', { name: /^pay \$29\.00$/i })
    await expect(payButton).toBeEnabled()
    await payButton.click()

    // ── The receipt screen ─────────────────────────────────────────────────
    await expect(page.getByRole('heading', { name: /payment confirmed/i })).toBeVisible()
    // The USD echoed back is exactly the event's usdAmount8 ($29.00).
    await expect(page.getByText('$29.00 USD')).toBeVisible()

    // THE KEY ASSERTION: the transaction row renders a real, clickable explorer
    // link to the settlement tx (Base Sepolia → sepolia.basescan.org/tx/<hash>),
    // opening in a new tab. The link is shortened for display but hrefs the full
    // hash, so we assert on the href, not the visible text.
    const txLink = page.getByRole('link', { name: /0x/i }).first()
    await expect(txLink).toBeVisible()
    await expect(txLink).toHaveAttribute(
      'href',
      `https://sepolia.basescan.org/tx/${TEST_TX_HASH}`,
    )
    await expect(txLink).toHaveAttribute('target', '_blank')

    // Sanity: the chain the receipt links into is the one we configured.
    expect(TEST_CHAIN_ID).toBe(84532)
  })

  test('branded-but-not-on-chain merchant shows the honest "not switched on" card', async ({ page, wallet }) => {
    // A tenant who branded but has not registered on-chain: no merchantId, so the
    // page must render the brand honestly and say payments aren't on yet — never
    // a fake checkout (truth-in-copy law #4).
    await wallet.setup({ slug: SLUG, merchantName: "Joe's Barbershop", onChain: false })

    await page.goto(`/c/${SLUG}`)

    await expect(page.getByText(`Pay Joe's Barbershop`).first()).toBeVisible()
    await expect(page.getByText(/hasn.t switched on payments yet/i)).toBeVisible()
    // No pay button is offered in this state.
    await expect(page.getByRole('button', { name: /^pay/i })).toHaveCount(0)
  })

  test('unknown checkout slug shows the invalid-link message', async ({ page, wallet }) => {
    // The fixture answers 404 for any slug other than the scenario's.
    await wallet.setup({ slug: SLUG })

    await page.goto('/c/does-not-exist')

    await expect(page.getByText(/this payment link is not valid/i)).toBeVisible()
  })
})
