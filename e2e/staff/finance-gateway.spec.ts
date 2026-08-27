import { test, expect } from '@playwright/test'
import { authStatePath, hasMintedSession } from '../fixtures/qa-auth'

const OWNER = 'club-owner'
const ACCOUNTANT = 'accountant'

test.describe('Finance module (club_owner, authenticated)', () => {
  test.skip(!hasMintedSession(OWNER), `No minted session for '${OWNER}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(OWNER) })

  test('finance overview loads', async ({ page }) => {
    await page.goto('/app/finance')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('finance payments tab loads', async ({ page }) => {
    await page.goto('/app/finance/payments')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('finance invoices tab loads', async ({ page }) => {
    await page.goto('/app/finance/invoices')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('finance cash tab loads', async ({ page }) => {
    await page.goto('/app/finance/cash')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })
})

test.describe('Finance reports (accountant, authenticated)', () => {
  test.skip(!hasMintedSession(ACCOUNTANT), `No minted session for '${ACCOUNTANT}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(ACCOUNTANT) })

  test('finance reports tab loads for an accountant', async ({ page }) => {
    await page.goto('/app/finance/reports')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('revenue report loads', async ({ page }) => {
    await page.goto('/app/reports/revenue')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('reconciliation report loads', async ({ page }) => {
    await page.goto('/app/reports/reconciliation')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('gateway health report loads (Phase 3 monitoring surface)', async ({ page }) => {
    await page.goto('/app/reports/gateway-health')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })
})

test.describe('Payment gateway checkout flow (Phase 2 — out of scope to modify, in scope to smoke-test)', () => {
  test.skip(!hasMintedSession(OWNER), `No minted session for '${OWNER}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(OWNER) })

  test('gateway-return landing route does not error with no query params (idle state)', async ({ page }) => {
    // GatewayReturnPage is the hosted-checkout redirect landing route
    // (stripe-create-checkout-session's success_url/cancel_url both
    // point here per Phase 2). This only proves the route itself
    // mounts safely with no gateway/session query params -- it does
    // NOT exercise a real gateway redirect (that would require a real
    // sandbox account with an external provider, out of scope for a
    // no-new-paid-infrastructure phase, and Phase 2/3 payment adapter
    // code is explicitly out of scope to touch this phase).
    await page.goto('/app/finance/gateway-return')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test.fixme('a completed gateway checkout correctly reconciles to a real payment record', async () => {
    // Requires a real (sandboxed) gateway account/credentials that do
    // not exist for this project (PAYMENT_GATEWAY_ARCHITECTURE.md:
    // every adapter is an honest GatewayNotConnectedError until real
    // credentials exist) -- correctly out of reach without new paid
    // infrastructure, not a gap this phase introduced or could close.
  })
})
