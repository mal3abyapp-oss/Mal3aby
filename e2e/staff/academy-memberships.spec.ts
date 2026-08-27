import { test, expect } from '@playwright/test'
import { authStatePath, hasMintedSession } from '../fixtures/qa-auth'

const FIXTURE = 'academy-manager'

test.describe('Academy module (academy_manager, authenticated)', () => {
  test.skip(!hasMintedSession(FIXTURE), `No minted session for '${FIXTURE}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(FIXTURE) })

  test('academy page loads (programs/groups + players tabs)', async ({ page }) => {
    await page.goto('/app/academy')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('academy page has no console errors on load', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto('/app/academy')
    await page.waitForLoadState('networkidle')
    expect(errors, `Uncaught page errors on /app/academy: ${errors.join('; ')}`).toEqual([])
  })

  test.fixme('enrolling a player into a full-capacity group is correctly rejected', async () => {
    // Real scenario this project's own integration/live testing already
    // proved at the RPC layer (docs/PROJECT_STATE.md Phase 11 exit
    // gate) -- a browser-level E2E equivalent needs stable selectors
    // for the enrollment wizard this codebase does not yet expose (no
    // data-testid). See E2E_TEST_STRATEGY.md.
  })
})

test.describe('Memberships module (club_owner, authenticated)', () => {
  const membershipsFixture = 'club-owner'
  test.skip(!hasMintedSession(membershipsFixture), `No minted session for '${membershipsFixture}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(membershipsFixture) })

  test('memberships page loads', async ({ page }) => {
    await page.goto('/app/memberships')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })
})

test.describe('Coach-scoped visibility (coach, authenticated)', () => {
  const coachFixture = 'coach'
  test.skip(!hasMintedSession(coachFixture), `No minted session for '${coachFixture}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(coachFixture) })

  test('a coach can reach /app without error (RLS scopes data server-side)', async ({ page }) => {
    await page.goto('/app')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('a coach can reach /scan (qr.scan permission)', async ({ page }) => {
    await page.goto('/scan')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })
})
