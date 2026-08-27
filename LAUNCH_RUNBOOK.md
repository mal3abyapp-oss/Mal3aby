# Launch Runbook

Phase 4 (Staging + Automated E2E) of the production-launch-hardening directive. Written 2026-08-28. A concrete, project-specific step-by-step for a real production deploy of Mal3aby as it exists today — not a generic template. Cross-references `MAL3ABY_DEPLOYMENT_RUNBOOK.md` (full Cloudflare architecture), `DEPLOYMENT_AND_ROLLBACK.md` (rollback mechanics), and `E2E_TEST_STRATEGY.md` (this phase's new automated suite) rather than repeating their content.

---

## Pre-deploy checks

Run these from the repo root, in order, before touching `wrangler deploy`:

```bash
# 1. Typecheck — the whole workspace, including the new e2e/ project
#    reference added this phase (tsconfig.e2e.json)
npx tsc -b

# 2. Lint
npm run lint

# 3. Unit + integration tests (Vitest) — integration suites skip
#    cleanly without QA credentials, per their own header comments
npm test

# 4. Zero-credential E2E suites — public pages, auth route guards,
#    responsive viewport checks (see E2E_TEST_STRATEGY.md)
npx playwright install chromium   # first time only
npm run test:e2e -- --project=chromium-desktop e2e/public e2e/auth e2e/responsive

# 5. (If a service_role key is available) authenticated E2E suites
npm run e2e:setup
npm run test:e2e
```

All five must be clean (0 TypeScript errors, 0 lint errors, all runnable tests passing) before proceeding. Step 5 is conditional — see `E2E_TEST_STRATEGY.md` for exactly what's covered by steps 4 vs. 5.

**Migration check**: if this deploy includes new `supabase/migrations/*.sql` files, confirm they've already been applied to the live project (via `apply_migration`, the same mechanism every one of this project's 445 prior migrations went through) and that `get_advisors(security)` returns 0 ERROR-level findings — this project's own established per-phase discipline, re-confirm it wasn't skipped for this release.

## Deploy command sequence

```bash
# Frontend build (repo root)
npm run build

# Frontend deploy
cd cloudflare/frontend-worker
npx wrangler deploy
```

This is the real, current mechanism per `MAL3ABY_DEPLOYMENT_RUNBOOK.md` — `mal3aby.app` and `www.mal3aby.app` are both bound as Custom Domains to this Worker already; this command deploys a new version to the same binding, no DNS/domain step needed for a routine release.

If this release also touches the WhatsApp Worker/Container, follow `MAL3ABY_DEPLOYMENT_RUNBOOK.md` §3 separately — that deploy path is independent of the frontend one (two separately-deployed Cloudflare projects, per that document's architecture recap).

## Post-deploy verification

Real, concrete checks this project has already established patterns for (not invented fresh here):

1. **Confirm the new build is actually live** — the Settings page (`/app/settings`, authenticated) renders `BUILD_SHA`/`BUILD_TIME` from `src/lib/version.ts`'s compile-time constants (`__MAL3ABY_BUILD_SHA__`, injected by `vite.config.ts`'s `readBuildGitSha()` at build time). Compare against `git rev-parse --short HEAD` for the commit just deployed.
   ```bash
   git rev-parse --short HEAD
   ```
   Then visually confirm the same short SHA appears on the live Settings page.

2. **Confirm security headers are present** — `MAL3ABY_DEPLOYMENT_RUNBOOK.md` §6 already establishes this exact check; re-run it after every deploy, not just once historically:
   ```bash
   curl -sI https://mal3aby.app/ | grep -iE "strict-transport-security|x-content-type-options|x-frame-options|content-security-policy"
   ```
   All four must be present. A missing set is the same class of regression this project already found and fixed once (`run_worker_first: true` gap) — this check exists specifically so that class of regression can't ship silently again.

3. **Confirm the SPA fallback still works on real deep links** — a direct browser navigation (not a client-side route change) to at least one route in each of the four route groups must return a real 200, not a raw 404:
   ```bash
   for path in /login /app/bookings /portal/bookings /verify/e2e-smoke-check; do
     echo "$path: $(curl -s -o /dev/null -w '%{http_code}' https://mal3aby.app$path)"
   done
   ```
   Every line should print `200` (Cloudflare's `not_found_handling: single-page-application` serving `index.html`).

4. **Run the zero-credential E2E suite against the live production URL** — the same suite from pre-deploy step 4, pointed at the real deployed target instead of localhost, closing the loop on "does the thing that just went live actually behave correctly" rather than only "did the local dev server behave correctly before deploy":
   ```bash
   E2E_BASE_URL=https://mal3aby.app npm run test:e2e -- --project=chromium-desktop e2e/public e2e/auth e2e/responsive
   ```
   This is genuinely safe to run against production — every spec in these three suites is either fully read-only (page loads, route guards, viewport checks) or uses intentionally-garbage tokens against public verification routes that are designed to handle exactly that input safely (see `E2E_TEST_STRATEGY.md`). It writes nothing.

5. **Spot-check `get_advisors(security)`** if this release touched the database — 0 ERROR-level findings, matching this project's own established per-phase gate.

## Rollback (if verification fails)

See `DEPLOYMENT_AND_ROLLBACK.md` for the full mechanics. Quick reference:

```bash
# Frontend
cd cloudflare/frontend-worker
npx wrangler deployments list
npx wrangler rollback <prior-version-id> -m "reason"
```

Database changes are never rolled back destructively — author a new forward-fixing migration (see `DEPLOYMENT_AND_ROLLBACK.md` §3 for the real, twice-precedented pattern this project already uses).

## What this runbook deliberately does not cover

- WhatsApp Container build/deploy — see `MAL3ABY_DEPLOYMENT_RUNBOOK.md` §3, currently blocked on one external `CLOUDFLARE_API_TOKEN` GitHub secret, unrelated to this phase's work.
- Supabase Auth URL configuration, plan upgrades, transactional email — all documented as pending external/human input in `MAL3ABY_DEPLOYMENT_RUNBOOK.md` §2, unchanged by this phase.
- A genuinely separate staging deployment — see `STAGING_ARCHITECTURE.md` for what exists today (`workers.dev` fallback) and what's recommended-but-not-built (`[env.staging]`).
