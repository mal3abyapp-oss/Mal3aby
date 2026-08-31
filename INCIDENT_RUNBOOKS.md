# Mal3aby — Incident Runbooks

Command/action-oriented. Written 2026-08-31 as part of the Production
Operations, Observability & DR acceptance pass. WhatsApp is out of
scope for every runbook below — do not touch it during any incident
response unless separately, explicitly authorized.

## Incident severity model

**SEV-1** — financial data corruption or mismatch, cross-tenant data
leakage, auth takeover, entire production down (frontend or DB
unreachable for all tenants).

**SEV-2** — a major feature outage (bookings/payments broken for one or
more tenants but not all), notification queue stuck/failing broadly,
single-tenant severe outage (that tenant fully down, others fine).

**SEV-3** — minor degraded functionality, a single failed notification,
a cosmetic defect, one-off transient error with no repeat.

## Incident response checklist (all severities)

1. **DETECT** — Workers Logs, `/api/client-error` beacon reports,
   `notification_queue` status distribution, direct user/tenant report,
   CI failure notification.
2. **CONFIRM** — reproduce or verify via a real read-only query/log
   check. Confirm build SHA (Settings footer / console log) matches
   intended deployed commit.
3. **CONTAIN** — stop the bleeding first. Frontend: `wrangler rollback`
   (stateless, instant, safe). Tenant-specific: `platform_suspend_club`
   (real, proven, does not affect other tenants — see Tenant
   Suspension runbook below). Do NOT touch the database schema/data as
   a containment step unless the incident IS a bad migration (see
   Database Migration Failure runbook).
4. **PRESERVE EVIDENCE** — **do not mutate historical data before
   reading it.** `audit_logs` and `notification_queue`/
   `notification_events` are read-only-by-policy for every ordinary
   role (confirmed: zero UPDATE/DELETE RLS policy exists on
   `audit_logs`) — query freely, this step is about YOUR actions, not
   about the data's own protection. Capture the exact query results
   (screenshot/copy) before any recovery action that could change them.
5. **RECOVER** — apply the specific runbook below for the incident
   type.
6. **VERIFY** — production build-SHA check on a fresh, cache-cleared
   session; spot-check a real read against a known record; re-run the
   relevant regression gate if code changed.
7. **DOCUMENT** — record what happened, what was found, what was
   fixed, in a dated entry (this project's own established convention
   — see `MAL3ABY_CLOUDFLARE_DEPLOYMENT_STATE.md`'s running log format).

---

## Runbook: DEPLOY

1. `git status` — confirm clean working tree, correct branch.
2. Local regression gate: `npx tsc --noEmit && npx eslint . && npx vitest run && npm run build`.
3. Commit, push once, watch CI (`gh run watch <run-id> --exit-status`).
4. Confirm `git rev-parse HEAD` = `origin/main` after CI green.
5. `rm -rf dist && npm run build` — fresh build from that exact HEAD.
6. `grep -o "<short-sha>[a-f0-9]*" dist/assets/index-*.js` — confirm the SHA is embedded.
7. `cd cloudflare/frontend-worker && npx wrangler deploy` — the existing `mala3by-frontend` Worker only. Never Pages, never a new Worker, never DNS.
8. Fresh browser session (clear service worker + caches) → confirm `[Mal3aby] build <sha>` console log matches deployed HEAD.

## Runbook: ROLLBACK (frontend)

1. `cd cloudflare/frontend-worker && npx wrangler deployments list` — identify the previous known-good version.
2. `npx wrangler rollback [deployment-id]` — stateless, no DB coupling, near-instant.
3. Fresh browser session → confirm console build tag now matches the rolled-back-to commit.
4. If the bad deploy included a DB migration, do NOT assume rollback undoes it — see Database Migration Failure below; frontend and DB rollback are independent.

## Runbook: DATABASE MIGRATION FAILURE

Production DB rollback is NOT equivalent to frontend rollback. There is
no safe generic "down migration" in this project's discipline.

1. Do NOT attempt to reverse the migration with a hand-written DOWN script.
2. Classify the migration: additive (new column/table/function) → usually safe to leave, fix forward. Destructive (dropped column/table) → data may already be gone; assess exactly what was lost before deciding next step. Data-transforming/backfill → check `audit_logs` for the affected rows' before/after state if available. Function replacement → `CREATE OR REPLACE` the previous known-good definition (get it from git history: `git show <prior-commit>:supabase/migrations/<file>.sql`) as a NEW forward migration, not a revert of the bad one.
3. Write and apply a genuine corrective forward migration via `apply_migration` (governed path — never a raw `execute_sql` DDL workaround).
4. Verify: live function/schema state, grants, RLS, no orphaned overload (a signature change creates a NEW function object — the old one needs an explicit `DROP`).
5. Rename the local migration file to match the exact remote-applied timestamp (`supabase_migrations.schema_migrations`) — this project's own established discipline throughout its history.

## Runbook: SUPABASE OUTAGE

1. Confirm via `get_project` (status field) or a direct `execute_sql` timeout/connection-refused.
2. Frontend degrades gracefully by architecture: Supabase-js calls fail with real errors, not silent success — confirm no destructive client-side retry loop exists for the affected flow (spot-check the specific broken feature's code).
3. Do not attempt to take any action requiring the database (deploys, migrations) until Supabase's own status is confirmed recovering.
4. Once recovered: verify a real read (any RLS-scoped query) succeeds before declaring resolved. Check `pg_cron`'s `cron.job_run_details` for any jobs that failed/were skipped during the outage window — the three real jobs (`expire_stale_booking_holds`, `auto_complete_past_bookings`, `expire_due_academy_subscriptions`) are all catch-up-safe by construction (query by stable predicate, not "since last run"), so a gap self-heals on the next successful run — no manual catch-up script needed.

## Runbook: CLOUDFLARE OUTAGE (frontend Worker)

1. Confirm via direct `curl -I https://mal3aby.app` or Cloudflare's own status page.
2. This is a genuine external-provider outage — no code-level mitigation exists (the entire frontend architecture is Cloudflare Workers, deliberately, per this project's own architecture decision).
3. Once recovered: fresh-session build-SHA check to confirm the Worker is serving the expected version (a Cloudflare-side incident should never itself change what's deployed, but verify rather than assume).

## Runbook: EMAIL WORKER FAILURE

1. Check `cron.job_run_details`-equivalent for the Cloudflare Worker (Workers Logs / `wrangler tail` against `mala3by-email-worker`) for recent invocation failures.
2. Check `notification_queue` status distribution (`channel='email'`): a growing `pending`/`retrying` count with no matching growth in `sent`/`failed` indicates the worker itself isn't running; a growing `failed` count indicates it's running but every send fails (check Resend's own status, or a bad `RESEND_API_KEY`).
3. `email_worker_expire_stale()` runs automatically at the start of every worker invocation — no manual stuck-row recovery needed once the worker resumes; it distinguishes confirmed-sent-then-crashed (→ `failed`, correctly not resent) from crashed-before-confirmation (→ safely `retrying`).
4. Do not manually mark queue rows as `sent`/`failed` — let the worker's own lease-recovery and retry ladder handle it once it resumes.
5. Redeploy the worker only if the code itself is the problem (confirmed via Workers Logs showing a real exception, not just a Resend-side failure).

## Runbook: QUEUE BACKLOG

1. Query `notification_queue` grouped by `status`/`channel` for the affected window.
2. A large `retrying` count with increasing `attempts` approaching 5 indicates a systemic failure (bad template, Resend outage) — check `last_error` values (already coarse/safe, never raw provider internals) for the common cause.
3. A large `pending` count with `attempts=0` and old `created_at` indicates the worker isn't running at all — see Email Worker Failure runbook.
4. Never manually bulk-delete or bulk-mark queue rows — this destroys the retry/audit trail. Let the existing bounded retry (5 attempts, backoff ladder) resolve naturally, or fix the root cause so future attempts succeed.

## Runbook: AUTH INCIDENT (compromised account suspected)

1. **Customer account**: no direct "disable" RPC found this phase for a self-service customer account specifically — the practical mitigation is removing any `customers.user_id` linkage (unclaims the record) via a governed migration if urgent, or waiting for the account's own session to expire (Supabase Auth JWTs are short-lived + refresh-token-based; a compromised session cannot be instantly revoked without Supabase Admin API access, which requires `service_role`, not available to this session's tooling — see Secret Rotation below for what IS actionable).
2. **Staff account**: `deactivate_staff_member(membership_id)` — already proven live this session (Full Product E2E phase) to immediately and correctly block all further access for that person in that club, verified via a real stale-session write attempt failing server-side right after deactivation.
3. **Platform staff/owner**: equivalent platform-side role-removal RPCs exist (`platform_staff_management_rpcs` migration family) — not independently re-tested this phase (would require impersonating a real platform-staff QA fixture; already covered by the same `has_permission`/RLS mechanism proven correct everywhere else this session).
4. **Audit evidence**: `audit_logs` retains the full history of the compromised account's actions regardless of the deactivation — immutable by RLS policy (no UPDATE/DELETE grant to any ordinary role), safe to review after containment.
5. Sensitive-action audit entries (`staff.suspended`, `customer.self_service_claim`, etc.) are already proven to exist and be complete — confirmed this and the prior two phases.

## Runbook: TENANT SUSPENSION

1. `platform_suspend_club(p_club_id, p_reason)` — already empirically proven this session (Full Product E2E phase) to: correctly set `clubs.status='suspended'`, correctly block a stale-authenticated staff session's next business write server-side (`club subscription does not allow new bookings`), and NOT affect any other tenant's data or access.
2. Historical data for the suspended tenant is untouched — confirmed (suspension is a status flag, not a data operation).
3. `platform_reactivate_club(p_club_id)` restores normal operation immediately — also already proven live.
4. Both actions are captured in `audit_logs` (`platform_suspend_club`/`platform_reactivate_club` action rows, confirmed present with correct actor/entity/timestamp this session).

## Runbook: SECRET LEAK

**Never expose the actual secret value anywhere, including in this
runbook, chat, or a committed file.**

1. Identify which secret: `RESEND_API_KEY`, `CLOUDFLARE_API_TOKEN`,
   `SUPABASE_SERVICE_ROLE_KEY`, or a Worker-specific secret
   (`whatsapp-worker`'s secrets are out of scope — do not touch).
2. **Resend key**: rotate via the Resend dashboard (generate new key,
   revoke old), then `cd cloudflare/email-worker && npx wrangler secret
   put RESEND_API_KEY` with the new value. Old key stops working
   immediately on revoke; no other system depends on it (confirmed:
   grep-clean, only referenced in `cloudflare/email-worker/src/
   index.ts`'s one outbound call).
3. **Cloudflare API token**: rotate in the Cloudflare dashboard
   (`My Profile → API Tokens`), update the `CLOUDFLARE_API_TOKEN` GitHub
   repository secret (`gh secret set CLOUDFLARE_API_TOKEN`) if CI/deploy
   tooling depends on it.
4. **Supabase service_role key**: rotate via the Supabase dashboard
   (Project Settings → API). This is the highest-impact rotation —
   every `service_role`-authenticated caller (email worker, any admin
   edge function) needs the new value simultaneously
   (`wrangler secret put SUPABASE_SERVICE_ROLE_KEY` for each affected
   Worker) or those systems go down until updated. Plan for brief,
   coordinated downtime of the affected Worker(s), not a live
   zero-downtime rotation.
5. After any rotation: verify the affected system resumes (email
   worker's next Cron tick succeeds; check Workers Logs).
6. Audit evidence of what the leaked key may have been used for:
   Workers Logs (request history), `audit_logs` (any RPC-level actions
   attributable to a specific actor), Resend's own dashboard send
   history (external, not queryable from this session's tools).

## Runbook: DATA RESTORE

**Current honest state**: no platform-provided backup/PITR exists
(Free plan — see `BACKUP_RECOVERY_PLAN.md`, already-decided, user-
accepted risk as of 2026-08-27). This runbook applies once/if the plan
is upgraded.

1. Do not attempt destructive recovery on the live project directly.
2. Via Supabase Dashboard → Database → Backups: select the
   appropriate restore point.
3. Post-restore: `list_migrations` (or `supabase db diff` locally) to
   confirm the restored schema matches `supabase/migrations/` — a
   restore landing slightly before the most recent migration needs
   that migration re-applied (this project's migrations are written
   `CREATE OR REPLACE`/`IF NOT EXISTS` throughout — safe to re-run).
4. Re-point any secrets if the restore produced a new project ref
   (rare).
5. Run Post-Restore Verification (below) before resuming normal
   traffic.
6. **External side-effect check**: diff the restored `notification_
   queue`'s most recent real `sent` rows against the actual incident
   window — anything in that gap may have already been delivered
   externally by Resend before the restore point; do not naively
   re-trigger those business events without checking (no automated
   safeguard exists for this today — see DR Tabletop 2 in
   `PRODUCTION_OPERATIONS_DR_ACCEPTANCE.md`).

## Runbook: POST-RESTORE VERIFICATION

Bounded, targeted checks — not a full E2E re-run:

1. `payments ↔ invoices`: `sum(payment_allocations.amount) grouped by
   invoice_id` must never exceed `invoices.total`.
2. `refunds ↔ payments`: every `refunds.payment_id` must resolve to a
   real payment; cumulative refunded amount ≤ original payment amount.
3. `cash shifts ↔ transactions`: `get_open_cash_shift_status`'s
   expected-cash formula (opening float + collected − refunded −
   expenses) should reconcile against a manual spot-check of a known
   real shift.
4. `membership ↔ invoice`: every `club_membership_subscriptions.
   invoice_id` resolves to a real invoice with matching club_id.
5. `academy subscription ↔ invoice`: same pattern via `subscriptions.
   invoice_id`.
6. `booking ↔ invoice/customer`: `bookings.invoice_id`/`customer_id`
   both resolve, and `bookings.club_id` matches the invoice's.
7. `tenant ↔ membership`: spot-check a known real club's
   `club_memberships` count matches expectation.
8. `audit entity references`: spot-check a few recent `audit_logs`
   rows' `entity_id` actually resolves in the named `entity_type`
   table.
9. Smoke-test: a real staff login (or RLS-impersonated equivalent) can
   read a known real booking/invoice and see correct figures.
10. Only after all of the above pass: resume normal write traffic /
    notify affected tenants.
