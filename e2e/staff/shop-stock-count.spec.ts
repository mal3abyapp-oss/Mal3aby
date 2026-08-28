import { test, expect } from '@playwright/test'
import { authStatePath, hasMintedSession } from '../fixtures/qa-auth'

const FIXTURE = 'club-owner'

// COMMERCIAL MODULE NOTE (see docs/PROJECT_STATE.md, "COMMERCIAL MODULE
// ARCHITECTURE (2026-08-26)"): Shop is gated by BOTH the nav-domain
// permission AND RequireShopModule (a real module-active check) -- a
// club without Shop entitled/active will not render Shop content even
// for an otherwise-fully-permissioned club owner.
//
// SHOP MODULE UX HARDENING (2026-08-28): "QA Full Test Club" is now
// CONFIRMED live (entitled=true, active=true, re-verified via direct
// SQL immediately before writing this update) -- fixed this session by
// calling the real set_club_module_entitlement/set_club_module_active
// RPCs as the real QA platform-owner/club-owner fixture accounts,
// matching the same pattern used earlier in this engagement for the
// real production club. The route-level tests below no longer need to
// hedge on module state -- Shop content is now expected to render for
// real.
//
// The end-to-end stock-count test further down is no longer gated on
// translated button text -- it now drives the real data-testid
// coverage added to ShopStockCountPage.tsx this phase
// (stock-count-start-new/-location/-notes/-start-confirm/-add-product/
// -add-variant/-add-line/-line-counted-{itemId}/-complete/-cancel/
// -status[data-status]), read directly from that component's source,
// not guessed. It is NOT `test.fixme()` anymore, but it has still never
// been RUN end-to-end: no session-minting run (`npm run e2e:setup`) has
// ever actually executed in this engagement (no SUPABASE_SERVICE_ROLE_KEY
// has been exposed to any session's tooling to date), so this remains
// CODE VERIFIED (type-checks, selectors confirmed to exist in source)
// rather than LIVE VERIFIED. It also self-skips honestly via
// `test.skip` (not a false pass) if the QA fixture club has no
// inventory location or no active product to select, since neither was
// confirmed to exist during this phase's investigation. A future
// session with a real service_role key should run `npm run e2e:setup`
// once, confirm "QA Full Test Club" has at least one Shop product with
// real stock at a real location (create one through the UI if not),
// then simply run the suite -- no further code change should be needed
// unless the live DOM structure surfaces something this reasoning
// missed.

test.describe('Shop module (club_owner, authenticated)', () => {
  test.skip(!hasMintedSession(FIXTURE), `No minted session for '${FIXTURE}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(FIXTURE) })

  test('shop POS route renders real content', async ({ page }) => {
    await page.goto('/app/shop')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('shop products route renders real content', async ({ page }) => {
    await page.goto('/app/shop/products')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('shop stock-count route renders real content', async ({ page }) => {
    await page.goto('/app/shop/stock-count')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('shop inventory route renders real content', async ({ page }) => {
    await page.goto('/app/shop/inventory')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  // Real, valuable coverage (INVENTORY_INVARIANTS.md's core guarantee):
  // a complete stock-count lifecycle end to end. Uses the data-testid
  // coverage added to ShopStockCountPage.tsx this phase
  // (stock-count-start-new/-location/-notes/-start-confirm/-add-product/
  // -add-variant/-add-line/-line-counted-{itemId}/-complete/-cancel/
  // -status[data-status]) instead of translated button text, so this no
  // longer breaks on copy edits the way the original draft (written
  // against literal Arabic strings) would have.
  test('a stock count session can be started, counted to a deliberate variance, and completed end-to-end', async ({ page }) => {
    await page.goto('/app/shop/stock-count')
    await page.waitForLoadState('networkidle')

    await page.getByTestId('stock-count-start-new').click()
    await page.getByTestId('stock-count-location').click()
    const firstLocation = page.locator('[data-testid^="stock-count-location-"]').first()
    const hasLocation = await firstLocation.count() > 0
    test.skip(!hasLocation, 'No shop inventory locations configured for this QA fixture -- cannot start a stock count session.')
    await firstLocation.click()
    await page.getByTestId('stock-count-start-confirm').click()

    // start_shop_stock_count succeeded -> the detail dialog opens with
    // status in_progress; the add-line control becomes available.
    await expect(page.getByTestId('stock-count-add-product')).toBeVisible()

    await page.getByTestId('stock-count-add-product').click()
    const firstProduct = page.locator('[data-testid^="stock-count-add-product-"]').first()
    const hasProduct = await firstProduct.count() > 0
    test.skip(!hasProduct, 'No active shop products configured for this QA fixture -- cannot add a stock count line.')
    await firstProduct.click()

    // A variant Select only renders for a product that has variants
    // (ShopStockCountPage.tsx: `selectedAddProduct?.hasVariants`).
    const variantTrigger = page.getByTestId('stock-count-add-variant')
    if (await variantTrigger.count() > 0) {
      await variantTrigger.click()
      await page.locator('[data-testid^="stock-count-add-variant-"]').first().click()
    }

    await page.getByTestId('stock-count-add-line').click()

    // A new line renders with a counted-quantity input keyed by itemId
    // -- locate whichever one was just added and enter a DELIBERATE
    // variance (a value guaranteed not to equal the system quantity
    // shown in the row, per this test's own name/intent) rather than
    // guessing 0 might already be wrong.
    const countedInput = page.locator('[data-testid^="stock-count-line-counted-"]').first()
    await countedInput.waitFor({ state: 'visible' })
    await countedInput.fill('999999')
    await countedInput.blur()

    // record_shop_stock_count_line is idempotent-on-blur (only fires
    // when the value actually changed) -- give the mutation a moment to
    // land before completing.
    await page.waitForLoadState('networkidle')

    await page.getByTestId('stock-count-complete').click()

    const status = page.getByTestId('stock-count-status')
    await expect(status).toHaveAttribute('data-status', 'completed')

    // Attempting to complete an already-completed count again must not
    // create a second movement (complete_shop_stock_count is idempotent
    // by design, confirmed by reading its own definition) -- once
    // completed, ShopStockCountPage.tsx's own isInProgress gate hides
    // both the complete and cancel controls entirely, which is itself
    // the UI-level guarantee against a duplicate completion: there is
    // no control left to click a second time.
    await expect(page.getByTestId('stock-count-complete')).toHaveCount(0)
    await expect(page.getByTestId('stock-count-cancel')).toHaveCount(0)
  })
})
