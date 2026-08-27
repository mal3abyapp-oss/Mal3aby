# Staging Architecture

**Status: DECISION MADE, applied where it required no live production write; one narrow piece proposed-but-blocked (see "What is NOT done" below).**

Phase 4 (Staging + Automated E2E) of the production-launch-hardening directive. Written 2026-08-28. This is the honest record of the environment-separation investigation the directive required, the strategy actually adopted, and exactly what "staging" means for this project going forward.

---

## The constraint this document works within

This project has, confirmed live this phase:

- **One Supabase project**: `gxkrtlvpjwxhcqdisyob` (`eu-central-1`, Postgres 17.6, **Free tier**), inside **one organization**: `bmqsldayximwywutofgi`. Confirmed via `list_projects` — no second project exists anywhere in this account.
- **One Cloudflare Worker**: `mala3by-frontend`, bound to the real production domain `mal3aby.app` (+ `www`), per `cloudflare/frontend-worker/wrangler.jsonc`.

Both facts were re-confirmed live this session, not assumed from a prior session's notes.

## Options investigated, cheapest-first (per the directive's own ordering)

### 1. A dedicated QA tenant *within* the existing production Supabase project — ADOPTED

This project already has extensive real precedent for QA-labeled clubs and accounts living inside the one production database, using the exact same RLS/RPC/schema boundaries every real tenant depends on. Confirmed live this phase (not assumed):

- **"QA Full Test Club"** (`6ca5315e-e199-4531-9fb1-1df358cda087`) — the one club in the entire database holding a **complete 9-role membership matrix**, each a real `auth.users` row with a confirmed email:
  `mal3aby.qa.{platform-owner,club-owner,club-manager,branch-manager,receptionist,accountant,academy-manager,coach,scanner}.20260821@example.com`, plus a `customer` and `guardian` account in the same `20260821` batch.
- Several other QA-labeled clubs/accounts also exist (`Mala3by Test Club One/Two`, `Mala3by Verification Club`/`Club 2`, `qa-audit-*@example.com`, `qa.*@mal3aby-qa-fixture.test`) — narrower, single-purpose fixtures from earlier sessions' specific investigations, left as-is (not consolidated — out of scope for this phase, and this project's own convention has consistently been "extend, don't invent a parallel system").

This satisfies the directive's own reasoning exactly: real E2E tests running against real tenant-isolated QA data in the SAME project the app already trusts for its real security boundary is a legitimate, zero-new-cost staging strategy for a schema/RLS/RPC-testing purpose. It is **not** a substitute for a genuinely separate *deployed build* environment (see option 2) — it answers "where does E2E test data live," not "which built frontend/JS bundle is being tested."

**Real finding, and what this phase did about it:** "QA Full Test Club" was **not usable as found**. Confirmed live (via `get_club_platform_access()`, called with a real club-owner caller — the function has caller-scoping, see below) as of 2026-08-28:

- `clubs.status = 'suspended'`
- Its `platform_subscriptions` row: `lifecycle_status = 'trial'`, `end_at = 2026-08-23` (5 days in the past relative to today), `grace_period_days_snapshot = 0`
- Net result: `get_club_platform_access() = 'blocked'`, even when correctly scoped as the club's own real owner.

This is not a defect in `get_club_platform_access()` itself — its caller-scoping (added `20260818142000_scope_club_platform_access_caller.sql`, a real prior security fix: any authenticated user could previously probe any club's subscription health by guessing a UUID) worked exactly as designed when this investigation first queried it unscoped and got `'blocked'` for every club in the database. Re-testing scoped as a real member resolved that false alarm — the *remaining* `'blocked'` result for QA Full Test Club specifically is real: the fixture's trial had simply expired between sessions, with no grace period to cushion it.

**Fix authored, not yet applied (see "What is NOT done" below):** `supabase/migrations/20260828100000_qa_fixture_club_platform_access_maintenance.sql` adds a small, reusable, `platform_owner`-gated RPC, `extend_club_qa_subscription(club_id, days, reason)`, that un-suspends a club and extends its subscription window (converting a `trial`-kind row to `complimentary`, since keeping a QA fixture alive is not a real paid conversion) — with a real `write_audit_log` entry, not a raw unaudited `UPDATE`. The migration then calls it once, as the real `platform_owner`-role QA fixture, to give "QA Full Test Club" a 365-day healthy window. This is genuinely reusable maintenance infrastructure, not a one-off script — the next session (or a scheduled job) can call it again whenever a QA fixture's trial next lapses, without hand-authoring another migration.

Other clubs checked and correctly ruled out as the E2E fixture: `"Test"` (active status, healthy future-dated subscription) is the **user's own real personal club** (owned by `moustafa.elsafy@hotmail.com`, not a QA fixture) — deliberately not reused for automated E2E, since mixing a real account's data with a repeatable, possibly-destructive test suite would contaminate it. `Mala3by Test Club One/Two` and both `Verification Club` entries each hold only 1–4 memberships, not the full role matrix the directive's breadth requirement needs.

### 2. A second free Cloudflare deployment (`workers.dev` fallback or `[env.staging]`) — PARTIALLY ALREADY TRUE, DOCUMENTED HERE

`cloudflare/frontend-worker/wrangler.jsonc` already sets `"workers_dev": true` explicitly, with this exact comment already in the file (from earlier deployment work, re-confirmed this phase, not newly added):

> "Keep workers.dev alive as a technical fallback/debugging address — NOT the customer-facing canonical URL (that's mal3aby.app), but useful for verifying a deploy independent of DNS/domain state."

This means a genuinely separate, free, Cloudflare-hosted URL (`mala3by-frontend.<account-subdomain>.workers.dev`) already exists for this exact purpose — a real deployed environment distinct from the production custom domain, at zero additional cost, on the free tier's own terms (Workers `workers.dev` subdomains do not require a paid plan). `playwright.config.ts`'s `E2E_BASE_URL` override (see `E2E_TEST_STRATEGY.md`) is built to point at this URL directly, or at a future `[env.staging]` Wrangler environment if one is added later.

**Not built this phase:** a genuinely separate `[env.staging]` Wrangler environment block (which would allow deploying a *different git ref* to a *different* `workers.dev` subdomain, independent of whatever is currently live on the production domain). This is a real, low-cost, technically-available next step (Wrangler environments are free-tier-eligible) but was not needed to satisfy this phase's actual requirement — the E2E suite talks to the SAME single Supabase backend regardless of which frontend build serves the page, so "environment" for this project's real purposes is about test **data** isolation (solved by option 1) far more than about frontend **build** isolation. Recommended as a genuine next step if a future session wants to test an unreleased frontend build before promoting it to `mal3aby.app` — see "Recommended next step" below.

### 3. A genuinely separate Supabase project — INVESTIGATED, NOT PURSUED (not a TRUE STOP; a deliberate choice)

Researched precisely, per the directive's own instruction not to assume: Supabase's Free tier does permit multiple free projects per organization (this is not gated behind a paid add-on in the general case). Creating a second free project would therefore **not**, by itself, cross into "new paid infrastructure" and does not constitute the directive's TRUE STOP CONDITION.

It was still not created this phase, for a reason grounded in the directive's own risk-aversion instruction ("if you're not fully confident it's genuinely zero-cost and reversible, prefer NOT creating it"): a second Supabase project would require either (a) re-running all 445 existing migrations against a fresh database to reconstruct the real schema/RLS/RPC surface this app depends on, or (b) building a schema-dump/restore pipeline — both real, non-trivial undertakings whose main payoff (a frontend build and backend genuinely isolated from any effect on the live production database) is not actually needed by anything in this phase's real requirements, since option 1 already gives the E2E suite safe, isolated, real test data inside the existing trusted boundary. Creating it now would be infrastructure ahead of a proven need, not a response to one.

**Recommended, not executed**: if a future phase needs a frontend/backend pair that is *fully* isolated (e.g. to safely test a destructive schema migration before it touches real production data — see `migration-rehearsal` discipline), a second free Supabase project + a `[env.staging]` Cloudflare Worker environment (option 2) together would be the correct, genuinely zero-cost pairing. Left as a documented recommendation, not built, per the directive's own "treat cost uncertainty itself as a reason to stop" instruction — the uncertainty here is about scope/effort proportionality, not price, but the same caution applies.

## What is NOT done (the one real block hit this phase)

The migration described above (`20260828100000_qa_fixture_club_platform_access_maintenance.sql`) exists, reviewed, in this worktree — but **could not be applied to the live database this session**: the `apply_migration` call was denied by the permission classifier as a write to the live production Supabase project. Per `AGENT_ORCHESTRATION_GOVERNANCE.md`'s explicit rule ("a blocked Git/write operation is an explicit boundary... must never be bypassed"), no alternate route was attempted.

**Practical consequence**: "QA Full Test Club" remains, as of this document's writing, in the same suspended/expired state described above. The migration file is ready for the orchestrator to review and apply (via the same `apply_migration` mechanism this entire project's 445 prior migrations were applied through) whenever a session with write authorization runs it. Until then, any E2E test that depends on this specific club being platform-access-healthy will observe the real `'blocked'` gate — which is itself accurate, reproducible product behavior (not a test flake), just not the state this phase intended to leave the fixture in.

## Summary: what "staging" means for this project today

- **Test data isolation**: the existing, extended QA fixture matrix inside the one production Supabase project (option 1) — the real mechanism.
- **Test build isolation**: the existing `workers.dev` fallback URL (option 2, already live) — usable today via `E2E_BASE_URL`; a dedicated `[env.staging]` block is a recommended, not-yet-built future refinement.
- **A fully separate database**: deliberately not built (option 3) — investigated, found genuinely possible on the free tier, but not proportionate to this phase's real needs.

No new paid infrastructure was required, used, or recommended as necessary to complete this phase's E2E and staging goals.
