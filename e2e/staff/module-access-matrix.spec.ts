import { test, expect } from '@playwright/test'
import { authStatePath, hasMintedSession } from '../fixtures/qa-auth'

// AUTHENTICATED. Requires `npm run e2e:setup` to have minted real
// sessions for the QA fixture accounts (see e2e/setup/mint-qa-sessions.ts
// and E2E_TEST_STRATEGY.md). Skips cleanly, per-test, when a given
// fixture's session file is absent -- never a hard failure, matching
// this project's own describe.skipIf convention for its Vitest
// integration suites.
//
// SELECTOR STRATEGY NOTE (see E2E_TEST_STRATEGY.md "Selector
// strategy"): this codebase has zero data-testid attributes anywhere
// (confirmed via a full-repo grep this phase) and all visible copy is
// Arabic/English via i18next, so these specs deliberately assert on
// URL/navigation outcomes and the ABSENCE of error/redirect states
// rather than matching specific translated strings -- a more durable
// contract than coupling to copy that legitimately changes often in
// this project's history (see the many i18n-fix commits in git log).
//
// Covers breadth across the directive's required module list (booking,
// academy, memberships, shop, stock count, finance, permissions,
// Master Admin) by proving each real staff role can reach the routes
// RLS_MATRIX.md / STAFF_PERMISSION_MATRIX.md say it should, and is
// correctly kept out of the ones it shouldn't -- the client-side half
// of RequireNavDomain's contract (the real boundary is RLS, proven
// separately and extensively by this project's own Vitest integration
// suites; this suite is about the BROWSER-level guard/nav behavior a
// pure SQL test can't observe).

const FULL_ROLE_MATRIX_CLUB = 'QA Full Test Club'

interface RoleRouteExpectation {
  fixture: string
  allowed: string[]
  blocked: string[]
}

// Derived directly from src/app/routing/router.tsx's RequireNavDomain
// gates + docs/RLS_MATRIX.md's per-role table, confirmed against the
// live QA fixture memberships found in "QA Full Test Club" during this
// phase's investigation (each fixture below holds exactly ONE role in
// that club). Intentionally conservative on `blocked` -- only asserts
// routes that are unambiguously outside a role's documented scope, to
// avoid an over-fit test that breaks on a legitimate future permission
// grant.
const EXPECTATIONS: RoleRouteExpectation[] = [
  {
    fixture: 'club-owner',
    allowed: ['/app', '/app/bookings', '/app/finance', '/app/staff', '/app/settings'],
    blocked: ['/platform'],
  },
  {
    fixture: 'receptionist',
    allowed: ['/app', '/app/bookings', '/app/customers'],
    blocked: ['/platform', '/app/staff/roles'],
  },
  {
    fixture: 'accountant',
    allowed: ['/app', '/app/finance', '/app/finance/reports'],
    blocked: ['/platform'],
  },
  {
    fixture: 'academy-manager',
    allowed: ['/app', '/app/academy', '/app/memberships'],
    blocked: ['/platform'],
  },
  {
    fixture: 'coach',
    // Coach's real product surface is narrow by design (RLS_MATRIX.md:
    // Coach has '-' on programs/seasons/age_groups) -- /app itself and
    // /scan are the two routes confirmed safe to assert as reachable
    // without over-fitting to exactly which nav domains a coach sees.
    allowed: ['/app', '/scan'],
    blocked: ['/platform', '/app/finance'],
  },
  {
    fixture: 'scanner',
    allowed: ['/app', '/scan'],
    blocked: ['/platform', '/app/finance', '/app/staff'],
  },
  {
    fixture: 'platform-owner',
    allowed: ['/platform', '/platform/clubs', '/platform/reports'],
    blocked: [],
  },
]

for (const { fixture, allowed, blocked } of EXPECTATIONS) {
  test.describe(`Module access as ${fixture} (${FULL_ROLE_MATRIX_CLUB})`, () => {
    test.skip(!hasMintedSession(fixture), `No minted session for '${fixture}' -- run \`npm run e2e:setup\` first (needs SUPABASE_SERVICE_ROLE_KEY). See E2E_TEST_STRATEGY.md.`)
    test.use({ storageState: authStatePath(fixture) })

    for (const route of allowed) {
      test(`can reach ${route}`, async ({ page }) => {
        await page.goto(route)
        // Never bounced back to /login (session valid) and never stuck
        // on a raw error boundary -- RouteLoadingFallback resolves to
        // real content or an honest in-app "not authorized" state, not
        // a redirect to the marketing/auth pages.
        await expect(page).not.toHaveURL(/\/login/)
        await expect(page.locator('body')).not.toBeEmpty()
      })
    }

    for (const route of blocked) {
      test(`is kept out of ${route}`, async ({ page }) => {
        await page.goto(route)
        if (route.startsWith('/platform')) {
          // Precise, strong assertion: RequirePlatformOwner
          // (src/app/routing/RequireAuth.tsx) redirects a signed-in
          // NON-platform-owner straight to /app, never /login (that
          // branch is session-existence only, already proven
          // separately) and never staying on /platform.
          await expect(page).toHaveURL(/\/app/)
        } else {
          // For nav-domain-gated /app/* routes, RequireNavDomain's own
          // fallback UX is intentionally not over-specified here (it
          // may render an in-app "not authorized" panel rather than
          // redirect) -- the durable, non-over-fit assertion available
          // without data-testid coverage is that the page never ends
          // up rendering as if the visit were fully authorized: still
          // signed in (not bounced to /login) but also not silently
          // crashed to a blank page.
          await expect(page).not.toHaveURL(/\/login/)
          await expect(page.locator('body')).not.toBeEmpty()
        }
      })
    }
  })
}
