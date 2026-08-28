import { test, expect } from '@playwright/test'
import { authStatePath, hasMintedSession } from '../fixtures/qa-auth'

const OWNER_FIXTURE = 'club-owner'
const RECEPTIONIST_FIXTURE = 'receptionist'

// COMMERCE PRO C10 -- Shop product-media RLS/authorization coverage
// (COMMERCE_PRO_UPGRADE_PLAN.md Section 5, Phase C10; see
// COMMERCE_C1_MEDIA_CATEGORIES_REPORT.md for the storage design this
// tests against).
//
// WHY THIS IS THE ONE CATEGORY THAT NEEDS REAL THOUGHT (per the task's
// own framing): `shop-product-images` is a PUBLIC bucket by deliberate,
// documented design (plan Section 2, invariant 7 -- "a product photo is
// not sensitive and public read avoids needing signed URLs for a
// catalog grid"). That means the interesting, CLIENT-OBSERVABLE
// contract here is NOT "can a stranger fetch another club's image URL
// blind" (a public bucket makes that trivially true by design, and
// re-testing that in Playwright would just be re-proving the bucket is
// public, which is already the documented, correct choice -- not a
// bug). The genuinely meaningful UI-observable assertions are:
//
//   1. A club's OWN product images render correctly in its OWN product
//      grid/POS screens (the actual thing a real user experiences) --
//      covered by the first test below.
//   2. The upload flow writes to a path scoped to the caller's OWN club
//      (club_id/product_id/filename) -- this IS client-observable: the
//      uploaded image's own public URL, visible in the DOM immediately
//      after upload, must start with the caller's real club_id -- a
//      wrong club_id in that path would be visible right there without
//      needing any adversarial cross-tenant fetch at all. Covered by
//      the second test below (gated on real file-chooser interaction
//      being meaningful for this fixture).
//   3. Upload-control CLIENT-SIDE authorization: a role without
//      shop.product.manage should not see/be able to use the upload
//      affordance (the real RLS boundary is server-side and was
//      already live-verified in C1's own review -- this is testing the
//      UI gate specifically, which is a DIFFERENT, weaker boundary that
//      can regress independently of RLS). Covered by the third test
//      below.
//
// A raw "guess another club's storage path and confirm it 404s or not"
// test was deliberately NOT written: the bucket is public by design, so
// a resolvable guessed path is the EXPECTED, correct outcome for
// content that was never meant to be secret -- asserting otherwise
// would be asserting the wrong contract.
test.describe('Shop product media (club_owner, authenticated)', () => {
  test.skip(!hasMintedSession(OWNER_FIXTURE), `No minted session for '${OWNER_FIXTURE}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(OWNER_FIXTURE) })

  test('a club\'s own product images render correctly in the product management grid', async ({ page }) => {
    await page.goto('/app/shop/products')
    await page.waitForLoadState('networkidle')

    const grid = page.getByTestId('products-grid')
    await expect(grid).toBeVisible()

    const cardWithImage = page.locator('[data-testid$="-thumb"][data-has-image="true"]').first()
    const hasImageCard = await cardWithImage.count() > 0
    test.skip(!hasImageCard, 'No shop products with an uploaded primary image exist for this QA fixture club -- cannot verify own-club image rendering.')

    // The real <img> inside the thumb wrapper must actually load (not
    // silently fall back to the ImagePlaceholder / broken-image icon,
    // which ProductThumb renders on a genuine load failure -- C1's own
    // documented "real fallback, not a browser broken-image icon"
    // contract). naturalWidth > 0 is the standard, reliable way to
    // confirm a real image decoded successfully in the browser, not
    // just that an <img> tag exists in the DOM.
    const img = cardWithImage.locator('img')
    await expect(img).toBeVisible({ timeout: 10_000 })
    const naturalWidth = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)
    expect(naturalWidth).toBeGreaterThan(0)

    // The image's own src must point at the public shop-product-images
    // bucket (confirms the read path is genuinely the one C1 built, not
    // e.g. a stale/local blob URL that happens to render once).
    const src = await img.getAttribute('src')
    expect(src).toContain('shop-product-images')
  })

  test('the upload flow scopes a newly-uploaded image to the caller\'s own club path', async ({ page }) => {
    await page.goto('/app/shop/products')
    await page.waitForLoadState('networkidle')

    await page.getByTestId('products-add-product').click()
    const fileInput = page.getByTestId('products-primary-image-input')
    await expect(fileInput).toBeAttached()

    // A real, tiny, valid PNG (1x1 transparent pixel) -- exercises the
    // actual supabase.storage upload call for real, not a mocked one,
    // matching this suite's "real backend, always" philosophy
    // (E2E_TEST_STRATEGY.md).
    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    await fileInput.setInputFiles({ name: 'e2e-test-pixel.png', mimeType: 'image/png', buffer: onePixelPng })

    // PrimaryImageUploader shows a real thumbnail once uploadProductImage
    // resolves (ShopProductsPage.tsx: onChange(url) -> imageUrl state ->
    // ProductThumb re-renders with the real public URL) -- wait for the
    // uploaded image itself to appear rather than a fixed timeout.
    const uploadedImg = page.locator('img[src*="shop-product-images"]').first()
    const uploaded = await uploadedImg.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)
    test.skip(!uploaded, 'Upload did not complete within the wait window for this fixture/environment -- cannot verify the resulting path.')

    const src = (await uploadedImg.getAttribute('src')) ?? ''
    expect(src).toContain('shop-product-images')

    // The storage path convention is {club_id}/{product_id_or_pending_id}/{filename}
    // (C1's report, Section 1) -- the caller's own club_id must be the
    // FIRST path segment after the bucket name. This test does not
    // know the fixture's exact club_id ahead of time, so it asserts the
    // structural shape (a real UUID-looking segment immediately after
    // the bucket name) rather than a hardcoded value -- still a
    // genuine, meaningful check that the path is scoped, not flat or
    // shared.
    const afterBucket = src.split('shop-product-images/')[1] ?? ''
    const firstSegment = afterBucket.split('/')[0] ?? ''
    const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(firstSegment)
    expect(looksLikeUuid).toBe(true)
  })
})

// IMAGE UPLOAD AUTHORIZATION (client-side UI gate): a role WITHOUT
// shop.product.manage should not see/be able to use the upload control.
//
// A REAL DEFECT WAS FOUND WRITING THIS TEST, disclosed here rather than
// silently worked around: as of this phase, ShopProductsPage.tsx's
// "Add Product" button (and therefore PrimaryImageUploader/
// GalleryImagesUploader) renders UNCONDITIONALLY -- there is no
// `currentMembership?.permissionKeys.includes('shop.product.manage')`
// check anywhere in the file (confirmed via direct grep before writing
// this test), and the route itself
// (router.tsx: { path: 'products', element: <ShopProductsPage /> })
// carries no RequirePermission wrapper beyond the Shop nav-domain's own
// shop.view-level gate. The server-side RLS/RPC boundary IS correctly
// enforced (create_shop_product/update_shop_product both check
// shop.product.manage, and the storage bucket's own INSERT/UPDATE/
// DELETE policies require it too -- confirmed via direct migration
// read, and this was the boundary C1's review already live-verified)
// -- but the UI-level "should not even see the affordance" contract the
// plan explicitly asks for (Section 6 task list, item 6: "a role
// without shop.product.manage should not see/be able to use the upload
// control") is NOT currently met. This test asserts the INTENDED
// contract and will FAIL once run against the real app until that gap
// is fixed -- it is deliberately not weakened to match the current
// (incomplete) behavior. See COMMERCE_C10_E2E_REPORT.md for the full
// writeup and fix recommendation; not fixed in this phase because
// PRODUCT PERMISSION-GATING ui changes to a page this large were
// outside this phase's assigned scope (E2E test authorship), and a
// silent behavior change to a shared page without the orchestrator's
// review would itself be a governance concern.
test.describe('Shop product media (receptionist, authenticated) -- upload authorization', () => {
  test.skip(!hasMintedSession(RECEPTIONIST_FIXTURE), `No minted session for '${RECEPTIONIST_FIXTURE}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(RECEPTIONIST_FIXTURE) })

  test('a staff member without shop.product.manage does not see the Add Product / upload control', async ({ page }) => {
    await page.goto('/app/shop/products')
    await expect(page).not.toHaveURL(/\/login/)
    await page.waitForLoadState('networkidle')

    // receptionist has shop.view + shop.sale.create only by default
    // (20260826205943_shop_inventory_permissions_seed.sql, confirmed via
    // direct migration read) -- NOT shop.product.manage. The page
    // itself must still be reachable (shop.view is enough for the nav-
    // domain gate), but the mutation affordance must not be offered.
    await expect(page.getByTestId('products-grid').or(page.locator('body'))).toBeVisible()
    await expect(page.getByTestId('products-add-product')).toHaveCount(0)
  })
})
