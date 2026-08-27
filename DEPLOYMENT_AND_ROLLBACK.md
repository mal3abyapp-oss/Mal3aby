# Deployment and Rollback

Phase 4 (Staging + Automated E2E) of the production-launch-hardening directive. Written 2026-08-28.

This document is a focused complement to the existing, more detailed `MAL3ABY_DEPLOYMENT_RUNBOOK.md` (last updated 2026-08-18, covers the full Cloudflare architecture including the WhatsApp Container) — it does not repeat that document's WhatsApp/Container detail. This one documents, precisely and re-confirmed live this phase, the actual rollback mechanics for the two things this project genuinely deploys on a normal release cadence: the frontend Worker and Supabase migrations.

---

## 1. Frontend deployment (real mechanism, unchanged from the existing runbook)

```bash
npm run build                          # tsc -b && vite build — repo root
cd cloudflare/frontend-worker
npx wrangler deploy
```

`wrangler.jsonc`'s `assets.directory` points at `../../dist` — the same build output the existing runbook describes, no separate build step, no duplicated frontend code.

## 2. Frontend rollback — commands confirmed to actually exist this phase

Re-verified live this phase (not assumed from the existing runbook's prose) via `npx wrangler deployments list --help` and `npx wrangler rollback --help` against this project's real `wrangler` version (`4.127.0`, confirmed via `npx wrangler --version`):

```bash
cd cloudflare/frontend-worker

# See the 10 most recent deployments (Worker Version IDs)
npx wrangler deployments list

# Roll back to a specific prior version
npx wrangler rollback <version-id> -m "reason for rollback"
```

Both commands are real, current, and free-tier-eligible (no Workers Paid requirement for either — confirmed via the command's own `--help` output, which lists no plan-gated flags). Cloudflare Workers keeps deployment history automatically; this is stateless and near-instant — no database coupling, no data migration involved, no user-facing downtime beyond the deploy propagation itself.

**When to use it**: a bad frontend build (broken bundle, a regression only visible in the compiled output, a bad environment variable baked into the build) — never for a backend/data problem, which needs the Supabase path below instead.

## 3. Supabase migrations — genuinely forward-only, confirmed by direct evidence, not assumed

**Claim to verify**: does this project ever roll back a migration, or does it "fix forward"? Checked directly this phase, not assumed:

```bash
grep -ril "rollback\|revert" supabase/migrations/*.sql
```

Found real, concrete precedent — this project has **explicitly reverted forward**, twice, via a **new** migration file, never by deleting or rewriting an already-applied one:

- `20260815390000_temp_grant_club_manager_for_academy_smoke_test.sql` → reverted by `20260815390500_revert_temp_club_manager_grant.sql`
- `20260816030000_temp_grant_for_group_edit_regression.sql` → reverted by `20260816030500_revert_temp_grant_for_group_edit_regression.sql`

Both revert files are separate, later-timestamped migrations that undo the effect of an earlier one — never an edit to the original file, never a deleted migration record. This confirms: **this project's real, established practice is fix-forward, not true down-migrations.** 445 total migration files exist (`supabase/migrations/`), and none of them is a Supabase-CLI-style `.down.sql` companion — there is no such mechanism in use anywhere in this history.

**Rollback procedure for a bad migration, therefore**:
1. Do **not** attempt to delete, edit, or reorder the already-applied migration file — `supabase/migrations/` is the append-only source of truth this project's own `RPC_GRANT_AUDIT.md`/`DECISIONS.md` discipline depends on, and this repo's CI (`ci.yml`'s "Migration filename sanity check" step) already enforces new-file-only, collision-free timestamps going forward.
2. Author a **new** migration that reverses the specific change (a `DROP`/`ALTER`/`CREATE OR REPLACE` back to the prior definition, or a narrowly-scoped data correction) — exactly the `revert_*` pattern demonstrated twice above.
3. Apply it the same way every other migration in this project is applied (`apply_migration` via the Supabase MCP tooling, or the Supabase CLI in a context with direct database access) — never a manual, unaudited `ALTER`/`UPDATE` outside the migration history.
4. Update `docs/PROJECT_STATE.md` / `AUTONOMOUS_DECISION_LOG.md` with what broke and why, matching this project's own established documentation discipline.

**Migration success vs. data correctness — the distinction this document is required to make explicit**: an `apply_migration` call returning success only proves the DDL/DML executed without a Postgres error. It does **not** by itself prove the resulting data is correct. This phase's own investigation is a live, real example of exactly this gap: `get_club_platform_access()`'s caller-scoping migration (`20260818142000_scope_club_platform_access_caller.sql`, applied cleanly, no error) worked exactly as designed — but a *separate*, correct application of it still surfaced a real, live data problem (QA Full Test Club's expired trial) that no migration's own success/failure status could have revealed. The only way to actually know is to query the real, current state afterward and reason about it against the intended invariant — which is what this phase's own investigation did, and what `STAGING_ARCHITECTURE.md` documents the findings of.

## 4. WhatsApp Worker / Container rollback

Unchanged from the existing, more detailed `MAL3ABY_DEPLOYMENT_RUNBOOK.md` §4 — not re-documented here to avoid drift between two competing sources. Summary only: redeploy a previous `wrangler` version; never rename a Durable Object class carelessly once production state exists (use `wrangler`'s migration tags); version/tag container images explicitly. Session state lives in Supabase, not the container/Worker, so a rollback there does not require re-pairing WhatsApp as long as `WHATSAPP_SESSION_ENCRYPTION_KEY` stays constant.

## 5. What this phase did NOT need to roll back, and why that matters here

This phase's one live-database action — the `extend_club_qa_subscription` migration (see `STAGING_ARCHITECTURE.md`) — was **not applied** (blocked by the permission classifier, per `AGENT_ORCHESTRATION_GOVERNANCE.md`). There is therefore nothing to roll back from this phase's own database work; the migration file sits reviewed and ready in this worktree branch for the orchestrator to apply through the normal channel.
