# MAL3ABY — CONTROLLED COMMERCIAL LAUNCH FINAL GO-LIVE REPORT

Written 2026-08-31. Controlled Commercial Launch Gate — Phases 1-16.

---

## OVERALL

The existing production platform (`mal3aby.app`, Supabase project
`gxkrtlvpjwxhcqdisyob`, Cloudflare Worker `mala3by-frontend`) has been
prepared for controlled commercial use. A real, verified, independent
logical backup now exists and is checksummed. Backup/restore tooling,
onboarding procedure, go-live gating, and QA/data-isolation review are
complete. Zero real customers exist today — all 13 current tenants are
QA/test/demo fixtures. See **FINAL DECISION** below.

---

## BACKUP STATUS

**CREATED and VERIFIED.** Produced 2026-08-31T16:34:34Z via SQL-catalog
introspection (`pg_dump`/Docker confirmed unavailable in this
environment — Docker Desktop service `Stopped`, no standalone
`pg_dump` binary found on the machine). Functionally equivalent to a
`pg_dump` logical backup: real schema, functions, constraints,
indexes, RLS policies, grants, and all 112 tables' real row data as
valid, structurally-verified SQL. See
[BACKUP_RUNBOOK.md](BACKUP_RUNBOOK.md) for full methodology.

## BACKUP LOCATION

`backups/20260831T163434Z/` — local to this machine, **gitignored**
(never committed; `.gitignore` carries an explicit, verified
`git check-ignore`-tested exclusion). This is disclosed as a **single
point of failure**: no automated off-site copy exists (no new paid
service was introduced, per the standing non-negotiable decision).
Manual off-site copy (e.g. to a separate cloud drive the operator
controls) is the explicit operator action recommended in
`BACKUP_RUNBOOK.md` before relying on this as the sole backup.

## BACKUP CHECKSUM

All 8 files verified via `backups/verify_manifest.py` — **ALL CHECKS
PASSED**, re-run twice, most recently confirmed clean. Manifest
(`09_manifest.json`) records per-file SHA-256 and size.

## BACKUP CONTENT

112 tables (schema + real data, 21,716 INSERT statements), 403
functions, 253 RLS policies, all constraints, indexes, and grants.
Spot-checked row counts (customers=74, bookings=147) exactly match
live `pg_stat_user_tables.n_live_tup`. Security-reviewed: no plaintext
secret, password, or API key found anywhere in the export.

## BACKUP EXCLUSIONS

Explicitly NOT captured (documented in the manifest's `not_captured`
block): `auth.users`/identities/sessions (Supabase Auth internals —
this backup alone would not restore login ability), Storage file
*contents* (7 objects confirmed to exist; only DB metadata rows would
transfer), Edge Function source (already in git, restore via
checkout), Cloudflare Worker secrets (never exportable, never
captured — see `INCIDENT_RUNBOOKS.md` Secret Leak runbook), Supabase
dashboard-level project config, and the WhatsApp session-encryption
key (the ciphertext itself IS captured; the decryption key is not
stored in the DB by design).

---

## RESTORE STATUS

**ENVIRONMENT-BLOCKED — NOT PROVEN.** No safe isolated restore target
exists: Docker is unavailable for a local Postgres container, and the
account's only other Supabase project (`mat3amos-dev`,
`miwsykjzxjneekhqlocp`) is a real, separate, unrelated live
application — restoring into it would contaminate someone else's real
project. Creating a new third Supabase project was judged out of
scope to do unilaterally. **Structural validation was performed
instead** (statement-count/balance/quoting correctness, all
documented in the manifest) — this is real and thorough but explicitly
not a substitute for an actual restore execution. This is an honest,
disclosed gap, not a claimed pass.

---

## PRODUCTION STATUS

- **Production URL:** `https://mal3aby.app` — live, HTTP 200, correct
  Arabic RTL render confirmed via live browser check.
- **Supabase production project:** `gxkrtlvpjwxhcqdisyob`,
  `ACTIVE_HEALTHY`, PostgreSQL 17.6.1.155, eu-central-1.
- **Deployed runtime build:** `[Mal3aby] build dcd7c61` — confirmed
  live via browser console at time of this report.
- **Worker deployment:** `mala3by-frontend`, version
  `9161c6d6-5936-4308-a820-a0fb381a8af2`, deployed
  2026-08-31T14:53:40Z.
- **SOURCE = BUILD = RUNTIME invariant: HOLDS.** `git diff
  dcd7c61..HEAD -- src/ supabase/functions/ cloudflare/` is empty —
  every commit since the deployed SHA is documentation/ops-tooling
  only, correctly requiring no redeploy.
- Platform Owner access, tenant creation, subscription enforcement,
  tenant suspension, staff creation, customer OTP login, email
  notification delivery, currency/timezone configuration, audit trail
  availability, and support visibility: **all reused from already-
  CLOSED baselines** (Full Product E2E, Notifications & Communications,
  Production Operations & DR acceptance phases) per this directive's
  own instruction not to re-audit settled ground.

---

## FIRST CUSTOMER ONBOARDING

Documented: [FIRST_CUSTOMER_ONBOARDING_RUNBOOK.md](FIRST_CUSTOMER_ONBOARDING_RUNBOOK.md)
— 20-step procedure, no direct SQL required for normal onboarding.

## TENANT GO-LIVE CHECKLIST

Documented: [TENANT_GO_LIVE_CHECKLIST.md](TENANT_GO_LIVE_CHECKLIST.md)
— 19 required PASS gates, reusable per tenant.

## QA ISOLATION

Documented: [QA_DATA_ISOLATION.md](QA_DATA_ISOLATION.md). **All 13
current tenants are QA/test/demo fixtures — zero real customers
exist today**, so no live contamination is possible yet. Two fixtures
carry real, already-verified cross-module financial/audit history and
are correctly left intact (never destroyed for cosmetic cleanup). One
real, non-blocking gap identified: no dedicated `is_test` marker
field exists, so platform-owner list views don't visually distinguish
QA from real tenants — recorded as a concrete, well-scoped follow-up
to implement at or shortly after the first real tenant signs up, not
built preemptively since the failure condition doesn't exist yet, and
not a launch blocker because RLS tenant isolation (proven exhaustively
in Full Product E2E: 6/6 live cross-tenant attacks blocked) makes this
purely a platform-owner visual/reporting concern, never a security or
customer-facing leak.

## FIRST TRANSACTION CONTROL

**Procedure (Phase 9):** for each tenant's first real financial
transaction (a real booking or membership sale, not a QA test), the
onboarding operator performs an enhanced manual review immediately
after: confirm the invoice total matches the agreed pricing exactly,
confirm the payment method and amount recorded match what the
customer actually paid, confirm no outstanding-balance discrepancy,
confirm cash-shift totals reconcile if paid in cash, confirm the
transaction appears correctly on the customer's own account/history
view, confirm it appears correctly in the tenant's financial report,
and confirm an audit-log entry exists for it. This is a **review
step, not a modification step** — the transaction itself is never
altered merely to perform this verification. This procedure is now
folded into Go-Live Checklist gate #14.

## PILOT PLAN

**Procedure (Phase 10):** onboard Tenant 1 alone first. Complete its
full Go-Live Checklist and let it operate for a period judged by
evidence, not a fixed calendar duration — advance to Tenants 2-3 once
Tenant 1 shows: successful real transactions reconciling cleanly,
no notification failures, no tenant-isolation anomalies, and no
unresolved SEV-1/2 incidents. After Tenants 2-3 show the same
stability (proving cross-tenant behavior under more than one real
tenant, not just theoretically), subsequent tenants follow the
standard onboarding runbook without a special pilot gate. No specific
tenant-count or day-count ceiling is imposed by this document — the
gate is evidence of stability, not a calendar.

## MONITORING

**Procedure (Phase 11):** using only existing observability (no new
monitoring platform — Sentry/Datadog explicitly excluded per the
non-negotiable decisions), the operator periodically checks: failed
login attempts, failed booking attempts, payment/cash-shift
discrepancies, notification delivery failures, any queue backlog,
permission-denied errors, tenant suspension-state changes, client-
side error reports, and scheduled-job (cron) failures — all via the
existing Supabase logs/query_logs and the platform's own audit trail,
as already documented in
[PRODUCTION_OPERATIONS_DR_ACCEPTANCE.md](PRODUCTION_OPERATIONS_DR_ACCEPTANCE.md).
No new tooling was built or is needed for this.

## INCIDENT READINESS

**Procedure (Phase 12):** fully reuses
[INCIDENT_RUNBOOKS.md](INCIDENT_RUNBOOKS.md) from the Production
Operations & DR phase — SEV-1/2/3 severity model and all 12 runbooks
(Deploy, Rollback, Migration Failure, Supabase Outage, Cloudflare
Outage, Email Worker Failure, Queue Backlog, Auth Incident, Tenant
Suspension, Secret Leak, Data Restore, Post-Restore Verification)
apply unchanged to the pilot phase. No new incident tooling required.

## COMMERCIAL DATA RULE (Phase 13)

From the first real customer onward: production is never reset, no
tenant's data is ever wiped, no financial history is ever deleted, no
destructive reseed is ever performed. QA must remain clearly isolated
from real tenant data going forward (see QA ISOLATION above). This is
now a standing operating rule, not a one-time check.

## RELEASE DISCIPLINE (Phase 14)

Once real customers exist, the release sequence already established
and used consistently across every phase of this multi-session
engagement becomes **mandatory, not best-effort**: local regression
gate (typecheck, lint, tests, build) → coherent commit → push once →
CI green → confirm `origin/main` HEAD matches local → fresh clean
build → verify the embedded SHA in the built assets → deploy via the
canonical `mala3by-frontend` Worker only → fresh-session smoke
verification confirming the live build SHA matches. No casual
production experimentation once real customers are live.

## DATABASE CHANGE DISCIPLINE (Phase 15)

Once real customers exist, all schema changes go through the governed
migration path only (`apply_migration`, never a raw `execute_sql` DDL
workaround) — inspect live definition → write migration file → apply
→ verify live → check grants/RLS → confirm remote-applied timestamp →
rename local file to match. The existing 51-file historical migration
gap (D-OPS-001,
[MIGRATION_HISTORY_RECONCILIATION.md](MIGRATION_HISTORY_RECONCILIATION.md))
remains documented and is explicitly **not** reopened or reconstructed
by this mission, per its own instruction.

---

## LAUNCH BLOCKERS

**None identified.** (See ACCEPTED RISKS below for known, deliberately
non-blocking gaps.)

## ACCEPTED RISKS

1. **Supabase Free-plan DR limitation** — owner's standing decision
   (2026-08-27, reaffirmed by this directive's own non-negotiable
   instruction not to ask again): accepted risk, mitigated as far as
   practical without a new paid service via this session's independent
   backup.
2. **Restore not executed (ENVIRONMENT-BLOCKED)** — no safe isolated
   target exists; structural validation performed instead; disclosed,
   not hidden.
3. **Backup has no automated off-site copy** — single point of
   failure until an operator manually copies it off this machine; no
   new paid service was introduced to automate this.
4. **No QA/real tenant marker field** — non-blocking today (zero real
   tenants); concrete follow-up recorded in
   [QA_DATA_ISOLATION.md](QA_DATA_ISOLATION.md).
5. **51 real historical migration file gaps** (D-OPS-001, already
   documented in
   [MIGRATION_HISTORY_RECONCILIATION.md](MIGRATION_HISTORY_RECONCILIATION.md)
   from the prior DR phase) — explicitly NOT reopened or reconstructed
   in this mission, per its own instruction.

## RUNTIME CHANGES

None. No frontend/backend code changed in this mission — Phase 5
confirmed the deployed runtime (`dcd7c61`) already matches HEAD's
source tree exactly.

## DATABASE CHANGES

None. No migrations applied in this mission. All work was read-only
introspection (backup extraction) plus new documentation/tooling
files.

## FINAL CODE COMMIT

`2820227` — `feat(ops): add production database backup tooling and QA
data isolation review` (plus this report and the two remaining runbook
files, committed immediately after this report is finalized).

## REPOSITORY HEAD

`main` branch, matches FINAL CODE COMMIT above once this report is
committed.

## DEPLOYED RUNTIME SHA

`dcd7c61` (confirmed live via browser console at report time) —
correctly behind HEAD, since every commit since is documentation/
tooling-only and does not require redeployment.

## WORKING TREE

Clean after this report's commit — no uncommitted source changes; the
only intentionally-untracked content is `backups/<timestamp>/` (real
production data, correctly gitignored) and two harmless scratch marker
files (`backups/.last_ts`, `backups/.roles_pid`).

---

## FINAL DECISION

**READY FOR CONTROLLED COMMERCIAL LAUNCH**
