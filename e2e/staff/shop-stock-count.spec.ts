import { test, expect } from '@playwright/test'
import { authStatePath, hasMintedSession } from '../fixtures/qa-auth'

const FIXTURE = 'club-owner'

// COMMERCIAL MODULE NOTE (see docs/PROJECT_STATE.md, "COMMERCIAL MODULE
// ARCHITECTURE (2026-08-26)"): Shop is gated by BOTH the nav-domain
// permission AND RequireShopModule (a real module-active check) --
// a club without Shop entitled/active will not render Shop content
// even for an otherwise-fully-permissioned club owner. These tests
// assert only "does not error / does not redirect to login", which is
// true in BOTH the entitled and not-entitled cases -- they intentionally
// do not assert on Shop being visually present, since whether "QA Full
// Test Club" has the Shop module active was not confirmed live during
// this phase (see E2E_TEST_STRATEGY.md's coverage notes) and asserting
// presence would be a guess, not a verified fact.

test.describe('Shop module (club_owner, authenticated)', () => {
  test.skip(!hasMintedSession(FIXTURE), `No minted session for '${FIXTURE}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(FIXTURE) })

  test('shop POS route does not error (module-gated — see note above)', async ({ page }) => {
    await page.goto('/app/shop')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('shop products route does not error', async ({ page }) => {
    await page.goto('/app/shop/products')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('shop stock-count route does not error', async ({ page }) => {
    await page.goto('/app/shop/stock-count')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('shop inventory route does not error', async ({ page }) => {
    await page.goto('/app/shop/inventory')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test.fixme('a stock count session can be started, counted, and reconciled end-to-end', async () => {
    // Real, valuable coverage (INVENTORY_INVARIANTS.md's core
    // guarantee) -- deferred pending stable selectors AND confirmation
    // that "QA Full Test Club" (or another QA fixture) has both the
    // Shop module active and at least one real product/stock row to
    // exercise a count against. See E2E_TEST_STRATEGY.md.
  })
})
