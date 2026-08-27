import { test, expect } from '@playwright/test'
import { authStatePath, hasMintedSession } from '../fixtures/qa-auth'

const CUSTOMER = 'customer'
const GUARDIAN = 'guardian'

test.describe('Customer self-service portal (customer, authenticated)', () => {
  test.skip(!hasMintedSession(CUSTOMER), `No minted session for '${CUSTOMER}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(CUSTOMER) })

  test('portal root loads for a claimed customer account', async ({ page }) => {
    await page.goto('/portal')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('portal bookings tab loads', async ({ page }) => {
    await page.goto('/portal/bookings')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('portal QR tab loads', async ({ page }) => {
    await page.goto('/portal/qr')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('portal profile tab loads', async ({ page }) => {
    await page.goto('/portal/profile')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('portal payments tab loads', async ({ page }) => {
    await page.goto('/portal/payments')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })
})

test.describe('Guardian self-service portal (guardian, authenticated)', () => {
  test.skip(!hasMintedSession(GUARDIAN), `No minted session for '${GUARDIAN}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(GUARDIAN) })

  test('portal academy/children tab loads for a guardian', async ({ page }) => {
    await page.goto('/portal/academy')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('portal memberships tab loads for a guardian', async ({ page }) => {
    await page.goto('/portal/memberships')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })
})

test.describe('Portal cross-persona authorization (client-side signal only)', () => {
  // The authoritative proof of portal ownership-security boundaries
  // (a signed-in account never seeing another customer's bookings/
  // children/payments) lives in this project's own
  // portal-cross-persona-authorization.integration.test.ts (real RLS
  // testing, real access tokens, real REST calls) -- not duplicated
  // here. This suite only proves the browser-level route/nav
  // contract, per this whole file's established pattern.
  test.skip(!hasMintedSession(CUSTOMER), `No minted session for '${CUSTOMER}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(CUSTOMER) })

  test('a customer account cannot reach /platform', async ({ page }) => {
    await page.goto('/platform')
    await expect(page).toHaveURL(/\/app|\/login/)
  })
})
