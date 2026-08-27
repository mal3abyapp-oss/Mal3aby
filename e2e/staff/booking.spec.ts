import { test, expect } from '@playwright/test'
import { authStatePath, hasMintedSession } from '../fixtures/qa-auth'

const FIXTURE = 'club-owner'

test.describe('Booking module (staff, authenticated)', () => {
  test.skip(!hasMintedSession(FIXTURE), `No minted session for '${FIXTURE}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(FIXTURE) })

  test('bookings calendar loads for an authenticated club owner', async ({ page }) => {
    await page.goto('/app/bookings')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('bookings calendar has no console errors on load', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto('/app/bookings')
    await page.waitForLoadState('networkidle')
    expect(errors, `Uncaught page errors on /app/bookings: ${errors.join('; ')}`).toEqual([])
  })

  // TIMEZONE REGRESSION GUARD (D-001, docs/AUTONOMOUS_DECISION_LOG.md):
  // a real P0 was found and fixed where a clicked booking slot stored a
  // time ~2-3h off due to a naive-datetime-string bug. A full create-a-
  // booking-and-verify-the-exact-stored-instant E2E test needs a
  // concrete field/slot selector this codebase's lack of data-testid
  // coverage makes fragile to write blind (see E2E_TEST_STRATEGY.md's
  // selector-strategy note) -- rather than write a selector-guessing
  // test likely to be flaky/wrong, this is left as an explicit, real,
  // documented gap: the next session with either (a) real
  // data-testid coverage on QuickBookingSheet's slot buttons, or (b) a
  // read of the actual rendered DOM via a live Playwright trace, should
  // fill this in. The existing src/lib/domain/time.ts unit-level
  // coverage plus D-001's own live verification remain the currently
  // proven layers for this specific regression class.
  test.fixme('creating a booking at a specific hour stores the exact matching UTC instant (timezone regression guard)', async () => {
    // Intentionally not implemented -- see comment above.
  })
})

test.describe('Field block / conflict handling (staff, authenticated)', () => {
  test.skip(!hasMintedSession(FIXTURE), `No minted session for '${FIXTURE}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(FIXTURE) })

  test.fixme('creating a field block over an existing booking surfaces the conflict without cancelling the booking', async () => {
    // Real, valuable regression coverage for the exact scenario Phase 6
    // documented (docs/PROJECT_STATE.md, "Flow 6b") -- deferred for the
    // same selector-stability reason as the timezone test above.
  })
})
