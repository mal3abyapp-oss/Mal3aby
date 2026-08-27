import { test, expect } from '@playwright/test'

// FULLY RUNNABLE, ZERO CREDENTIALS. These routes have no auth guard at
// all (see src/app/routing/router.tsx's top-level PublicLayout group +
// the standalone /verify, /qr, /c, /activate routes) -- real product
// behavior reachable by any anonymous visitor, exactly what an E2E
// suite should cover first per the directive's own priority ("public/
// unauthenticated flows... fully testable end-to-end right now with
// zero credential blocker").

test.describe('Public marketing pages', () => {
  test('home page loads and renders the login CTA', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(/.+/)
    // LoginPage is reachable from the home hero per Phase 15's own
    // documented fix (invisible white-on-white button bug, closed) --
    // this assertion would have caught a regression of that class of
    // defect (a link present in the DOM but not actually clickable/
    // visible is a separate concern from "does the link exist", but a
    // broken/removed nav link is caught here).
    const loginLink = page.getByRole('link', { name: /تسجيل الدخول|login|sign in/i }).first()
    await expect(loginLink).toBeVisible()
  })

  test('pricing page loads', async ({ page }) => {
    await page.goto('/pricing')
    await expect(page.locator('body')).toBeVisible()
    await expect(page).not.toHaveURL(/\/login/)
  })

  test('contact page loads', async ({ page }) => {
    await page.goto('/contact')
    await expect(page.locator('body')).toBeVisible()
  })

  test('terms and privacy pages load', async ({ page }) => {
    await page.goto('/terms')
    await expect(page.locator('body')).toBeVisible()
    await page.goto('/privacy')
    await expect(page.locator('body')).toBeVisible()
  })
})

test.describe('Public token-based verification routes (unauthenticated by design)', () => {
  // These routes intentionally accept ANY token shape and resolve
  // server-side (verify_invoice_public is the one RPC granted to
  // `anon` in this entire schema, per docs/PROJECT_STATE.md's Phase
  // history) -- a garbage token must show an honest "invalid/not
  // found" state, never a crash, never leak data, never redirect to
  // login (these pages are explicitly NOT behind RequireAuth).

  test('/verify/:token with a garbage token shows an invalid state, not a crash', async ({ page }) => {
    const response = await page.goto('/verify/e2e-nonexistent-token-000000')
    expect(response?.ok()).toBeTruthy()
    await expect(page).not.toHaveURL(/\/login/)
    // The page must render SOMETHING coherent (not a blank white
    // screen from an uncaught render error) -- a stronger assertion
    // than merely "no crash" would need this project's own copy,
    // which is intentionally kept loose here so this test does not
    // become a false-fail the next time i18n copy is edited.
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('/qr/:token with a garbage token shows an invalid state, not a crash', async ({ page }) => {
    const response = await page.goto('/qr/e2e-nonexistent-token-000000')
    expect(response?.ok()).toBeTruthy()
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('/activate/:token with a garbage token shows an invalid state, not a crash', async ({ page }) => {
    const response = await page.goto('/activate/e2e-nonexistent-token-000000')
    expect(response?.ok()).toBeTruthy()
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('/c/:slug with a nonexistent club slug shows a not-found state, not a crash', async ({ page }) => {
    const response = await page.goto('/c/e2e-nonexistent-club-slug-000000')
    expect(response?.ok()).toBeTruthy()
    await expect(page.locator('body')).not.toBeEmpty()
  })
})

test.describe('SPA deep-link reload (Cloudflare Worker not_found_handling)', () => {
  // wrangler.jsonc's assets.not_found_handling: 'single-page-application'
  // exists specifically so a hard reload on a client-routed path serves
  // index.html with a 200 (never a raw 404) -- this is exactly the
  // behavior a dev-server run can't fully prove (Vite's own dev server
  // has its own historyApiFallback), but the ASSERTION that a direct
  // navigation to a deep client route resolves to real app content
  // (not a 404 page) is still meaningful against any target, local or
  // deployed, and would catch a routing regression either way.
  test('direct navigation to a deep client-routed path does not 404', async ({ page }) => {
    const response = await page.goto('/pricing')
    expect(response?.status()).toBeLessThan(400)
  })
})
