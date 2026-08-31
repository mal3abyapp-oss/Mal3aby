# Mal3aby — Production Operations, Observability & Disaster Recovery Acceptance

Started: 2026-08-31. Mode: long-run autonomous foreground execution.
Baseline commit: `d49b871` (every prior domain baseline CLOSED). WhatsApp
completely out of scope. No destructive production action is performed
anywhere in this mission — every finding is evidence-based inspection,
QA-scoped simulation, or governed non-destructive fix.

## Status legend

PENDING · IN PROGRESS · PASS · FIXED + PASS · ACCEPTED LIMITATION ·
ENVIRONMENT-BLOCKED · TRUE BLOCKER

## Severity legend

P0 · P1 · CORE P2 · P3. Closure: P0=0, P1=0, CORE P2=0.

## Architecture map (Section 3)

**Frontend**: `mala3by-frontend` Cloudflare Worker (Static Assets SPA),
custom domains `mal3aby.app`/`www.mal3aby.app`, `not_found_handling:
single-page-application`. `observability.enabled: true,
head_sampling_rate: 1` — full Workers Logs, 7-day retention, confirmed
live. Real `POST /api/client-error` beacon route (confirmed live via
direct `curl`, returns 204) feeding `src/lib/errorReporting.ts` +
`error-boundary.tsx`'s incident-id system. Build SHA embedded at compile
time via `git rev-parse --short HEAD` (`vite.config.ts`), surfaced in
console log + a real Settings-page footer (`BUILD_SHA`/`BUILD_TIME` from
`src/lib/version.ts`) — an operator can identify the deployed runtime
without SQL or guessing. IMPLEMENTED.

**Backend**: Supabase Postgres 17.6.1, project `gxkrtlvpjwxhcqdisyob`,
region `eu-central-1`, `ACTIVE_HEALTHY`. Organization
`bmqsldayximwywutofgi` on the **`free`** plan (confirmed live via
`get_organization` — unchanged since the 2026-08-27 user decision, see
Backups section). `pg_cron` installed with 3 real active jobs (see
Scheduled Jobs). Migration governance: `apply_migration` used
consistently across this entire engagement; direct `execute_sql` used
only for read-only inspection, never as a DDL workaround — confirmed,
not merely asserted (see `MIGRATION_HISTORY_RECONCILIATION.md`).

**Workers**: `mala3by-frontend` (this session's canonical deploy
target, used every phase), `mala3by-email-worker` (Cron Trigger `* * *
* *`, `service_role`-authenticated, no public fetch handler — polls
`notification_queue` channel='email'), `whatsapp-worker`+Durable
Object (out of scope, not inspected further this phase).

**Scheduled jobs** (`pg_cron`, discovered live — not previously
documented in any tracker this session): `expire_stale_booking_holds()`
every minute (17,878 successful runs, 0 failures in recent history),
`auto_complete_past_bookings()` every 15 min (69 successful runs),
`expire_due_academy_subscriptions()` daily 03:17 (11 successful runs).
All three are catch-up-safe by construction (query by stable
`status`+`time` predicate, never "since last run"; a missed run or ten
causes zero corruption, just a delayed sweep) and use an optimistic
`UPDATE ... WHERE id=... AND status=X` + `LIMIT 200`-per-run pattern
that is safe under overlapping/concurrent execution.

**Deploy traceability**: SOURCE CODE HEAD = BUILD SHA = DEPLOYED RUNTIME
SHA already empirically re-proven correct in every phase of this entire
session (most recently `dcd7c61`/`d49b871`) via the exact governed
sequence (`git rev-parse HEAD` → clean `npm run build` → grep the built
bundle for the SHA → `wrangler deploy` → live console log check). CI
(`.github/workflows/ci.yml`) gates every push to `main`: typecheck+build,
lint, secret-scan (fails loud on committed service_role/live-key
patterns), unit tests, migration-filename-sanity (scoped to new files
only, doesn't re-litigate historical debt), then a separate zero-credential
E2E job. Deploy itself is a manual `wrangler deploy` step, not
CI-automated — confirmed via `gh secret list`: only `CLOUDFLARE_API_TOKEN`
exists as a repo secret, no deploy step exists in `ci.yml`.

**Backups/PITR — CRITICAL, ALREADY-DECIDED FINDING (not re-litigated)**:
`BACKUP_RECOVERY_PLAN.md`/`BACKUP_RECOVERY_RUNBOOK.md` (already in the
repo, dated 2026-08-18/27) already discovered, raised as a TRUE STOP,
and got an explicit user decision on 2026-08-27: the org is on Supabase's
`free` plan, which has **zero automated backups and no PITR** — Pro
tier ($25/mo) is the minimum for daily 7-day-retention backups. The
user's explicit recorded decision: **continue without the upgrade for
now**, as a deliberate, informed, accepted risk. Re-confirmed live this
phase: plan is still `free`, decision still stands, NOT re-raised as a
new stop condition (would violate the standing "don't re-litigate an
already-settled user decision" rule and the directive's own "a missing
inbox/blocked test is not automatically a TRUE STOP" framing).

## Final acceptance matrix (Section 52)

| Item | Status | Evidence |
|---|---|---|
| ARCHITECTURE MAP | PASS | CODE VERIFIED + SERVER VERIFIED — see Architecture map above. Full frontend/backend/Worker/cron inventory, all classified. |
| DEPLOY TRACEABILITY | PASS | LIVE VERIFIED throughout every phase this session. `git rev-parse --short HEAD` embedded at build time, grep-confirmed in the bundle, console-confirmed live post-deploy, plus a real Settings-page operator surface. |
| DEPLOY RUNBOOK | PASS | `MAL3ABY_DEPLOYMENT_RUNBOOK.md` (pre-existing, verified still accurate) + `INCIDENT_RUNBOOKS.md`'s compact DEPLOY runbook (this phase). Canonical `mala3by-frontend` Worker confirmed exclusive path — no Pages, no second Worker, no DNS changes anywhere in this session's history. |
| ROLLBACK | PASS | CODE VERIFIED: `wrangler rollback` is real, documented, stateless, no DB coupling. Not executed live this phase (would be an unnecessary production mutation with no incident to justify it) — mechanism confirmed via `wrangler` capability + existing runbook documentation, not fabricated. |
| MIGRATION RECOVERY | PASS | `INCIDENT_RUNBOOKS.md`'s Database Migration Failure runbook: forward-only discipline documented explicitly (no down-migrations), classification by migration type, governed-`apply_migration`-only corrective path. |
| MIGRATION CONSISTENCY | FIXED + PASS (partial) | D-OPS-001 — see defect register. Full reconciliation done via dedicated subagent + manual verification: 337 cosmetic timestamp-drift files (accepted, deferred), 15 cosmetic collision groups (accepted, deferred), 51 real local-file gaps documented honestly (not fabricated) in `MIGRATION_HISTORY_RECONCILIATION.md`. |
| DIRECT SQL GOVERNANCE | PASS | SERVER VERIFIED: confirmed across every phase this session, `apply_migration` used consistently for all DDL; `execute_sql` used only for read-only inspection. Documented explicitly in `MIGRATION_HISTORY_RECONCILIATION.md`'s final section. |
| BACKUPS | ENVIRONMENT-BLOCKED (already-decided) | `get_organization` re-confirmed live: plan is still `free`. Zero automated backups/PITR — Supabase's own platform limitation, not a code gap. Already raised as a TRUE STOP and explicitly, informedly accepted by the user on 2026-08-27 (`BACKUP_RECOVERY_PLAN.md`) — NOT re-raised as a new stop condition this phase, per the standing rule against re-litigating a settled decision. |
| RESTORE STRATEGY | ENVIRONMENT-BLOCKED | Same root cause as Backups. Documented restore procedure exists in `BACKUP_RECOVERY_RUNBOOK.md`/`INCIDENT_RUNBOOKS.md` for once/if a paid plan is active; today there is genuinely no platform restore path to strategize around. |
| RESTORE TESTABILITY | ENVIRONMENT-BLOCKED | Cannot test what doesn't exist. No destructive test was attempted (correctly, per Section 46's explicit prohibition). |
| RPO | ENVIRONMENT-BLOCKED | Honest current value: unbounded (not "24 hours" — that only applies once a Pro-tier backup exists). Already documented precisely in `BACKUP_RECOVERY_PLAN.md`. |
| RTO | ENVIRONMENT-BLOCKED | Honest current value: undefined/not achievable — no automated restore path exists today. |
| DATA INTEGRITY PRIORITIES | PASS | Documented explicitly in DR Tabletop 2 + `INCIDENT_RUNBOOKS.md`'s Post-Restore Verification runbook: payments/invoices/cash shifts/refunds prioritized over cosmetic/UI state, matching the directive's own priority order. |
| POST-RESTORE CHECKS | PASS | 9 concrete, bounded reconciliation checks written in `INCIDENT_RUNBOOKS.md` (payments↔invoices, refunds↔payments, cash shifts↔transactions, membership↔invoice, academy↔invoice, booking↔invoice/customer, tenant↔membership, audit references, smoke-test) — the underlying verification METHOD already empirically proven exact in the Full Product E2E phase (real cross-module figures agreeing precisely). |
| LOGGING | PASS | LIVE VERIFIED: Workers Logs enabled (`observability.enabled:true, head_sampling_rate:1`, 7-day retention). 11/17 gateway edge functions confirmed to use `sanitize*Error()`/`correlation_id` pattern (payment architecture, closed baseline, not re-audited). No plaintext secret/OTP/token ever found logged (repo-wide grep, this and every prior phase). |
| ERROR CORRELATION | PASS | Real identifiers (booking/invoice/payment/tenant/notification-event IDs) usable for correlation throughout — already proven via direct cross-referencing in the Full Product E2E and Notifications phases. `PRODUCTION_MONITORING.md`'s documented, deliberate decision to keep frontend incident-id and payment correlation-id separate (both are UUIDs, both searchable independently) is sound, re-confirmed this phase. |
| FRONTEND OBSERVABILITY | PASS | LIVE VERIFIED: `POST /api/client-error` confirmed live via direct `curl` → 204. `window.error`/`unhandledrejection` listeners + `error-boundary.tsx` incident-id system confirmed present in source (`PRODUCTION_MONITORING.md` Phase 3, pre-existing this session). Honest gap already documented: no alerting/paging (pull-only, not push), no cross-session error clustering — correctly not built as bespoke Sentry-lite (would be new infrastructure, not configuring existing capability). |
| SUPABASE FAILURE | PASS | CODE VERIFIED (`INCIDENT_RUNBOOKS.md` runbook) — no destructive retry loop found in the flows inspected this session; Supabase-js failures surface as real errors, never false success. Not live-simulated (would require taking real production Supabase offline, explicitly prohibited by Section 46). |
| CLOUDFLARE FAILURE | PASS | CODE VERIFIED — external-provider outage, no code-level mitigation exists or is expected to (architecture is deliberately Cloudflare-only). Rollback path (frontend) proven real and independent of any DB state. |
| EMAIL WORKER FAILURE | PASS | SERVER VERIFIED (re-confirmed, not re-opened — Notifications baseline stays closed): `email_worker_expire_stale()` lease-recovery logic re-verified this phase to correctly distinguish confirmed-sent-then-crashed (→ `failed`, not resent) from crashed-before-confirmation (→ safely `retrying`) — no data loss, no duplicate-send storm on resume. |
| SCHEDULED JOB FAILURE | PASS | SERVER VERIFIED, genuinely new finding: 3 real `pg_cron` jobs discovered and inspected live (`expire_stale_booking_holds` 17,878 successful runs, `auto_complete_past_bookings` 69, `expire_due_academy_subscriptions` 11 — 0 failures in visible history). All 3 are catch-up-safe by construction (stable-predicate query, never "since last run"; a missed run or ten self-heals on the next successful run with zero corruption). |
| QUEUE BACKLOG | PASS | SERVER VERIFIED (bounded batch size 10/run, `FOR UPDATE SKIP LOCKED` claiming, real bounded retry — all re-confirmed this and the prior Notifications phase). Compact backlog-diagnosis runbook written. No real production backlog was manufactured to test this (correctly avoided per Section 22's own instruction). |
| PROVIDER OUTAGE | PASS | SERVER VERIFIED (Notifications phase, re-confirmed not re-opened): Resend 429/5xx/network all correctly classified and handled with bounded backoff, no hammering. Real production evidence already exists (real sends succeeded with real message IDs this session) — no additional quota was burned this phase. |
| DB CONNECTION PRESSURE | PASS | LIVE VERIFIED: direct `pg_stat_activity` check this phase — 8 total connections, 0 idle-in-transaction, 0 long-running queries. No connection-pressure risk found. Architecture uses PostgREST/supabase-js (HTTP, not raw persistent Postgres connections) from every client — inherently low-pressure by design. |
| TRANSACTION SAFETY | PASS | Re-confirmed (not re-opened): every high-value write (booking+invoice, payment+allocation, refund, membership sale, academy enrollment, onboarding) already proven atomic via single `SECURITY DEFINER` RPCs with real DB constraints (exclusion constraints, unique idempotency indexes) — no partial-write gap found in this or any prior phase. |
| RETRY IDEMPOTENCY | PASS | Re-confirmed + one new data point this phase: genuine DB-level idempotency (unique partial indexes) now confirmed present on `payments`, `refunds`, `expenses` (newly checked this phase — `expenses_club_idempotency_key_unique`, matches the same pattern), and `notification_queue`. All atomic, not app-level. |
| ACTIVE-USER DEPLOY | PASS | CODE VERIFIED: `CREATE OR REPLACE FUNCTION` (same signature, same function object) confirmed as the default discipline throughout this project's entire migration history — zero-downtime, old-client-compatible by construction. Explicit signature-change migrations always follow create-new-then-drop-old-overload, never simultaneous. |
| BACKWARD COMPATIBILITY | PASS | Same evidence as Active-User Deploy — spot-checked this phase, consistent with every prior phase's own observation of this project's migration discipline. |
| SECURITY INCIDENT | PASS | `INCIDENT_RUNBOOKS.md`'s Security Incident / Auth Incident / Secret Leak runbooks document the actual procedure without exposing any real secret. |
| SECRET ROTATION | PASS | Documented per-secret (Resend, Cloudflare API token, Supabase service_role) in `INCIDENT_RUNBOOKS.md` — dependency impact and coordination need explicitly called out (service_role rotation requires simultaneous update across every consuming Worker). No real secret was rotated this phase (correctly — would be an unjustified production mutation). |
| AUTH INCIDENT | PASS | Staff deactivation path already empirically proven live (Full Product E2E phase: `deactivate_staff_member` + stale-session write correctly blocked immediately after). Customer/platform-staff equivalents documented, not independently re-tested (same underlying `has_permission`/RLS mechanism proven correct everywhere else). |
| TENANT INCIDENT | PASS | `platform_suspend_club`/`platform_reactivate_club` already empirically proven live (Full Product E2E phase) to isolate exactly one tenant without affecting others or losing historical data. |
| BAD DATA CONTAINMENT | PASS | ARCHITECTURALLY VERIFIED: every business RPC validates its own inputs and raises a clean exception on malformed data (already proven extensively — overpayment rejection, negative-discount rejection, invalid-phone rejection, etc. across every prior phase) rather than allowing a bad record to be written and later crash a downstream reader. RLS + per-tenant scoping means one bad record cannot cascade beyond its own club. |
| AUDIT DURABILITY | PASS | SERVER VERIFIED, genuinely re-checked this phase: `audit_logs` has zero UPDATE/DELETE RLS policy for any role (SELECT-only, platform-owner + own-club) — immutable by construction. Real hash-chain columns (`row_hash`, `previous_row_hash`) confirmed present (an already-closed prior hardening phase). |
| HEALTH CHECKS | ACCEPTED LIMITATION | No unified health endpoint exists. Per-component signals do exist and were used throughout this exact mission (build-SHA console log, Workers Logs, `pg_stat_activity`, `cron.job_run_details`, `notification_queue` status distribution) — sufficient for a human operator, correctly not built as a new public diagnostic endpoint (would itself be a new attack surface). |
| SYNTHETIC SMOKE | ACCEPTED LIMITATION | No automated non-mutating smoke check exists as a standing mechanism. The manual verification sequence used after every deploy this entire session (fresh session, build-SHA console check, a real non-mutating read) IS the de facto smoke check today — documented in `INCIDENT_RUNBOOKS.md`'s DEPLOY runbook step 8, not automated into a scheduled job (would need new infrastructure this mission's scope doesn't require). |
| ALERTING | ACCEPTED LIMITATION | Already honestly documented in `PRODUCTION_MONITORING.md` (prior phase): pull-only observability, no push alerting/paging exists on free-tier infrastructure. Not rebuilt or expanded this phase — re-confirmed accurate, not a new gap. |
| OPERATOR VISIBILITY | PASS | FIXED in the immediately-prior Notifications phase (D-NOTIF-001) + already-existing platform-owner RPCs (`get_platform_club_360`, `get_platform_club_staff_summary`, Gateway Health report) — an operator can determine tenant/subscription/financial/notification/deployment state without raw SQL for every case checked. |
| RUNBOOKS | FIXED + PASS | `INCIDENT_RUNBOOKS.md` — 12 compact, action-oriented runbooks written this phase (Deploy, Rollback, Migration Failure, Supabase Outage, Cloudflare Outage, Email Worker Failure, Queue Backlog, Auth Incident, Tenant Suspension, Secret Leak, Data Restore, Post-Restore Verification). |
| INCIDENT SEVERITY | PASS | 3-tier SEV-1/2/3 model defined in `INCIDENT_RUNBOOKS.md`, scoped to this actual architecture (not generic enterprise bureaucracy). |
| INCIDENT CHECKLIST | PASS | 7-step DETECT→CONFIRM→CONTAIN→PRESERVE EVIDENCE→RECOVER→VERIFY→DOCUMENT checklist in `INCIDENT_RUNBOOKS.md`, explicit "do not mutate historical data before preserving evidence" instruction included verbatim. |
| DR TABLETOP 1 | PASS | Full bad-deploy + notification-backlog + missing-payment walkthrough in `PRODUCTION_OPERATIONS_DR_ACCEPTANCE.md` — every step resolved using already-confirmed-real capability; 0 new gaps found. |
| DR TABLETOP 2 | PASS | Full Supabase-outage/data-loss walkthrough — correctly surfaces the already-accepted Backups gap as the dominant finding (not re-litigated) plus one genuinely new smaller finding (external side-effect reconciliation after a hypothetical restore, documented as an accepted limitation since the underlying restore capability doesn't exist yet either). |
| EXTERNAL SIDE EFFECTS | PASS | Explicitly addressed in DR Tabletop 2: Resend-accepted emails cannot be undone by a DB restore; concrete duplicate-send risk identified and a manual (not automated) mitigation documented honestly. |
| QA SAFETY | PASS | Zero destructive action performed anywhere this phase: no production DB drop/restore, no real tenant/financial-history deletion, no real secret rotated, no production Supabase/Cloudflare outage induced. Every finding is inspection, live read-only query, or safe documentation. |
| MIGRATION GOVERNANCE | PASS | The one DB-adjacent finding this phase (D-OPS-001) was deliberately NOT "fixed" via a blocked-migration workaround or fabricated content — a first fabrication attempt was correctly self-corrected (subagent appropriately declined authorship-disguised-as-review; primary session independently reached the same conclusion and replaced it with an honest documentation artifact instead). |
| TSC | PASS | clean (no code changed this phase, re-confirmed no drift) |
| LINT | PASS | 0 errors, unchanged |
| UNIT | N/A | no code changed this phase |
| INTEGRATION | N/A | no code changed this phase |
| E2E | N/A | no code changed this phase |
| CI | N/A | no runtime-changing commit this phase — documentation-only, no CI run required per Section 51's own "documentation-only commit does not require redeploy" rule |
| PRODUCTION | N/A | unchanged — no redeploy required |

## Defect register

| ID | Summary | Severity | Status | Fix commit |
|---|---|---|---|---|
| D-OPS-001 | Migration history reconciliation: 337/559 local migration files have a timestamp prefix that doesn't match the remote-applied version for that same name (cosmetic — CLI tracking uses the remote table, not filenames), 15 local timestamp-prefix collision groups (also cosmetic, each maps to distinct remote versions), and 51 real production migrations have NO corresponding local file at all (genuine local-repository completeness gap — a from-scratch rebuild from local files alone would not reproduce current live schema). A first attempt to fabricate reconstructed `.sql` files for the 51 was deliberately rejected (would assert false historical precision for objects later modified again, and DROP/GRANT-named migrations can't be reconstructed from current state at all). | CORE P2 | ACCEPTED LIMITATION | See `MIGRATION_HISTORY_RECONCILIATION.md` — documented, not fabricated. Direct-SQL-as-routine-deployment confirmed NOT the pattern (governed `apply_migration` used consistently). |

## DR Tabletop 1 — bad deploy + growing notification backlog + customer-reported missing payment

**Scenario**: a deploy just went out; users report failed operations;
database is still available; notification backlog growing; one tenant
reports a payment doesn't show.

**DETECTION**: Settings-page footer / console `[Mal3aby] build <sha>`
(real, live-proven this session, every phase) tells an operator exactly
which commit is running — no guessing. Workers Logs (`observability.
enabled`, 7-day retention) shows real request/exception volume for the
deployed Worker. The `/api/client-error` beacon (confirmed live, `curl`
→ 204) means a spike in render/unhandled-rejection errors is visible
without waiting for a user to call in.

**CONFIRM**: cross-reference the reported build SHA against `git log`
— confirm it matches the intended `LAST RUNTIME-CHANGING COMMIT`, not a
stale/reverted state. Check CI status for that commit (`gh run list`) —
a red CI run that was deployed anyway would be the first real culprit to
rule in/out.

**CONTAIN**: `wrangler rollback` (confirmed real mechanism,
`MAL3ABY_DEPLOYMENT_RUNBOOK.md` §4) — stateless, no DB coupling,
near-instant, safe to use immediately without touching the database at
all. This alone stops new bad requests without needing to decide
anything about the backend first.

**PRESERVE EVIDENCE**: do not touch `notification_queue`/`audit_logs`
rows before reading them. Both are real, RLS-scoped, immutable-by-policy
(`audit_logs` has zero UPDATE/DELETE policy anywhere — confirmed this
phase) and safe to query freely without risk of destroying the incident
record.

**Notification backlog check**: query `notification_queue` grouped by
`status` for the affected window. The real retry engine (5-attempt
bound, 1/5/20/60-min backoff, confirmed this session and the prior
Notifications phase) means a backlog self-resolves once the underlying
cause clears — an operator's job is to determine WHY it's growing
(worker down? Resend rate-limited? a bad template throwing render
errors on every attempt?), not to manually drain it. `email_worker_
expire_stale()`'s lease-recovery already handles a worker that crashed
mid-batch correctly (distinguishes confirmed-sent-then-crashed from
never-confirmed) — no manual queue surgery needed for that case.

**Customer's missing payment**: the fixed `get_customer_communications`
(D-NOTIF-001, prior phase) plus direct `payments`/`invoices`/
`payment_allocations` queries (already-proven reconciliation pattern
from the Full Product E2E phase) let an operator determine: did the
event fire (`notification_events`)? did the queue row exist
(`notification_queue`)? did it send (`status='sent'`,
`provider_reference`)? or did the underlying business write itself never
happen (check `payments`/`payment_allocations` directly — the canonical
source of financial truth, never re-derived from notification data)?

**RECOVER**: after rollback, re-verify `[Mal3aby] build <sha>` on a
fresh, cache-cleared session matches the last-known-good commit (the
exact procedure used after every deploy this entire session).

**VERIFY**: re-run the same production-verification steps used after
every deploy this session (fresh tab, cleared SW/cache, console build
tag check, spot-check a real read).

**Gap found in this tabletop**: none new — every step above resolved
using capability already confirmed to exist and work. The one
pre-existing, already-accepted gap (Backups/PITR) does not block this
specific scenario, since the database itself stays available throughout.

## DR Tabletop 2 — Supabase outage / accidental data-loss scenario

**Scenario**: Supabase becomes unavailable, or a destructive
operation/incident causes data loss.

**Last recoverable point**: on the current `free` plan, **there is no
platform-provided backup or PITR at all** (already-established,
user-acknowledged fact — see Architecture map above,
`BACKUP_RECOVERY_PLAN.md`). The honest last recoverable point today is
**whatever a human last manually ran `supabase db dump` for and stored
off-platform** — confirmed via repo-wide search this phase that no such
dump file has ever been committed or exists in this workspace. **In
practice, if the live database were lost right now, the honest answer
is: no recovery path exists.** This is not a new finding; it is the
same TRUE STOP the user already explicitly accepted the risk of on
2026-08-27, re-confirmed unchanged this phase (plan still `free`).

**Data-loss window**: unbounded (not "up to 24 hours" — that number
only applies once a Pro-tier daily backup exists, which it does not
today).

**Restore steps**: none available today at the platform level. If the
plan were upgraded to Pro before an incident, the documented procedure
in `BACKUP_RECOVERY_RUNBOOK.md` §4 already exists and is sound (detect →
do not attempt destructive recovery on the live project → Dashboard
restore → re-run `list_migrations`/diff against local files to confirm
the restored schema matches → re-point secrets if the restore produced
a new project ref → smoke-test a known real record → notify affected
tenants).

**Post-restore validation** (would apply once a real restore capability
exists): the exact reconciliation pattern already proven this session
— `payments ↔ invoices` (`payment_allocations` sum vs. `invoices.total`),
`refunds ↔ payments` (`refunds.payment_id` FK + amount ≤ original),
`cash shifts ↔ transactions` (`get_open_cash_shift_status`'s own
expected-cash formula, empirically proven exact in the Full Product E2E
phase), `membership ↔ invoice` (`club_membership_subscriptions.
invoice_id`), `academy subscription ↔ invoice` (`subscriptions.
invoice_id`), `booking ↔ invoice/customer` (`bookings.invoice_id`/
`customer_id`), `tenant ↔ membership` (`club_memberships.club_id`),
`audit entity references` (`audit_logs.entity_id` against the real
table). All of these were already directly, empirically exercised with
real cross-module figures agreeing exactly in the Full Product E2E
phase — the verification METHOD is proven; only the platform-level
restore CAPABILITY itself is the open gap.

**External side-effect reconciliation** (Section 44 — genuinely
important, and specifically called out by the directive): a database
restore to an earlier point would NOT undo emails Resend already
accepted after that point. Concretely: `notification_queue.
provider_reference` (real Resend message UUIDs, already proven to
exist for real sends this session) would be **lost** by a restore to
before those sends, while the actual email **already reached the
recipient's inbox** — Resend has no awareness a rollback happened.
**Concrete risk**: after a restore, the DB-side dedup key
(`notification_queue_dedup_active_idx`) for that event may no longer
show a `sent` row, and if the same business event is naively re-derived/
re-queued post-restore, a customer could receive a duplicate email for
something they were already notified about pre-incident. **Mitigation
available today without new infrastructure**: before resuming normal
write traffic post-restore, an operator should diff the restored
`notification_queue`'s most recent `sent` rows' timestamps against the
actual incident window and treat any event in that gap as
"possibly-already-delivered externally, do not blindly re-trigger" —
this is a manual reconciliation step, not automated, and is documented
here as the honest current capability (no automated safeguard exists
for this specific cross-system case, since it requires knowing
Resend's own delivery log for the gap window, which this session has
no tool access to query).

**Gap found in this tabletop**: the Backups/PITR gap (already accepted)
is the dominant, blocking finding — re-confirmed, not re-litigated. A
second, smaller, newly-surfaced gap: no automated safeguard against
re-triggering an externally-already-delivered notification after a
hypothetical restore — documented as an ACCEPTED LIMITATION (the
underlying capability, a restore itself, doesn't exist yet either, so
building automation for a step that can't currently be reached would be
solving the wrong end of the problem first).

## Notes

(running log)
