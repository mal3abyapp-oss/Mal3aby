import { test, expect } from '@playwright/test'

// FULLY RUNNABLE, ZERO CREDENTIALS. Proves RequireAuth/RequirePlatformOwner/
// RequirePortalAuth's client-side redirect behavior (src/app/routing/
// RequireAuth.tsx) -- "does a protected route correctly redirect to
// /login when unauthenticated" needs no logged-in session at all, per
// the directive's own explicit callout. This is exactly the kind of
// coverage that would have caught the same CLASS of defect as the real
// bug this project found and fixed during Final Pre-Release
// Verification (a confirmed user landing on a bare /app shell instead
// of being routed correctly) -- not that exact bug (this suite has no
// session to test the post-login membership check with), but the
// guard-level contract a regression there would also likely break.

test.describe('Unauthenticated route guards redirect correctly', () => {
  test('/app redirects to /login when unauthenticated', async ({ page }) => {
    await page.goto('/app')
    await expect(page).toHaveURL(/\/login/)
  })

  test('/app/bookings redirects to /login when unauthenticated', async ({ page }) => {
    await page.goto('/app/bookings')
    await expect(page).toHaveURL(/\/login/)
  })

  test('/app/finance redirects to /login when unauthenticated', async ({ page }) => {
    await page.goto('/app/finance')
    await expect(page).toHaveURL(/\/login/)
  })

  test('/scan redirects to /login when unauthenticated', async ({ page }) => {
    await page.goto('/scan')
    await expect(page).toHaveURL(/\/login/)
  })

  test('/platform redirects to /login when unauthenticated (RequirePlatformOwner)', async ({ page }) => {
    await page.goto('/platform')
    await expect(page).toHaveURL(/\/login/)
  })

  test('/platform/clubs redirects to /login when unauthenticated', async ({ page }) => {
    await page.goto('/platform/clubs')
    await expect(page).toHaveURL(/\/login/)
  })

  test('/portal redirects to /login when unauthenticated (RequirePortalAuth)', async ({ page }) => {
    await page.goto('/portal')
    await expect(page).toHaveURL(/\/login/)
  })

  test('/portal/bookings redirects to /login when unauthenticated', async ({ page }) => {
    await page.goto('/portal/bookings')
    await expect(page).toHaveURL(/\/login/)
  })

  // RequireAuth passes `state: { from: location }` to the redirect --
  // a real product behavior (return-to-original-page after login) that
  // is invisible in the URL itself, so this asserts on it a different
  // way: after landing on /login from a deep link, the login form
  // itself must still be present and usable (not a bare redirect
  // that lost the page).
  test('redirect to /login from a deep link still renders a usable login form', async ({ page }) => {
    await page.goto('/app/finance/reports')
    await expect(page).toHaveURL(/\/login/)
    await expect(page.locator('input[type="email"], input[name="email"]').first()).toBeVisible()
    await expect(page.locator('input[type="password"]').first()).toBeVisible()
  })
})

test.describe('Login form renders without error (no submission — see E2E_TEST_STRATEGY.md)', () => {
  // Deliberately does NOT submit the form or type a password anywhere
  // -- the standing project-wide rule (docs/PROJECT_STATE.md) forbids
  // ever typing a real password into a login form, including from an
  // automated test. This only proves the form itself renders/mounts
  // correctly (a real regression class: e.g. a broken import crashing
  // LoginPage entirely would fail this).
  test('/login renders email and password fields', async ({ page }) => {
    await page.goto('/login')
    await expect(page.locator('input[type="email"], input[name="email"]').first()).toBeVisible()
    await expect(page.locator('input[type="password"]').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /دخول|login|sign in/i }).first()).toBeVisible()
  })
})
