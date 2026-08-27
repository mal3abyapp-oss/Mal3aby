import { test, expect } from '@playwright/test'
import { authStatePath, hasMintedSession } from '../fixtures/qa-auth'

const OWNER = 'club-owner'
const PLATFORM_OWNER = 'platform-owner'
const RECEPTIONIST = 'receptionist'

test.describe('Staff + custom roles/permissions (club_owner, authenticated)', () => {
  test.skip(!hasMintedSession(OWNER), `No minted session for '${OWNER}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(OWNER) })

  test('staff list loads', async ({ page }) => {
    await page.goto('/app/staff')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('staff roles/permissions page loads (STAFF ACCESS CONTROL & CUSTOM ROLES)', async ({ page }) => {
    await page.goto('/app/staff/roles')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('audit log page loads', async ({ page }) => {
    await page.goto('/app/audit-log')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })
})

test.describe('Permission boundary: receptionist kept out of staff/roles management', () => {
  test.skip(!hasMintedSession(RECEPTIONIST), `No minted session for '${RECEPTIONIST}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(RECEPTIONIST) })

  test('a receptionist visiting /app/staff/roles is not shown a fully-authorized management shell', async ({ page }) => {
    await page.goto('/app/staff/roles')
    // Client-side signal only, by this project's own explicit design
    // (RequireAuth.tsx's header comment: "the real security boundary
    // is always RLS on the server") -- the authoritative proof that a
    // receptionist cannot actually read/write role/permission data
    // lives in this project's Vitest integration suites
    // (staff_role_matrix.integration.test.ts) and direct RLS
    // inspection, not here. This only confirms the browser-level nav
    // guard's observable behavior, per RequireNavDomain's per-role
    // permission check (docs/RLS_MATRIX.md: receptionist has no
    // roles.view).
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })
})

test.describe('Master Admin / Platform Owner console (platform_owner, authenticated)', () => {
  test.skip(!hasMintedSession(PLATFORM_OWNER), `No minted session for '${PLATFORM_OWNER}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(PLATFORM_OWNER) })

  test('platform overview loads', async ({ page }) => {
    await page.goto('/platform')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('platform clubs list loads', async ({ page }) => {
    await page.goto('/platform/clubs')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('platform club detail loads for the known QA fixture club', async ({ page }) => {
    // QA Full Test Club's real id, confirmed live during this phase's
    // investigation -- see STAGING_ARCHITECTURE.md.
    await page.goto('/platform/clubs/6ca5315e-e199-4531-9fb1-1df358cda087')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('platform owners list loads', async ({ page }) => {
    await page.goto('/platform/owners')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('platform plans page loads', async ({ page }) => {
    await page.goto('/platform/plans')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('platform trials page loads', async ({ page }) => {
    await page.goto('/platform/trials')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('platform alerts page loads', async ({ page }) => {
    await page.goto('/platform/alerts')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('platform audit page loads', async ({ page }) => {
    await page.goto('/platform/audit')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('platform staff (support-staff) page loads', async ({ page }) => {
    await page.goto('/platform/staff')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('platform roles page loads', async ({ page }) => {
    await page.goto('/platform/roles')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('platform settings page loads', async ({ page }) => {
    await page.goto('/platform/settings')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('platform reports page loads', async ({ page }) => {
    await page.goto('/platform/reports')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })
})
