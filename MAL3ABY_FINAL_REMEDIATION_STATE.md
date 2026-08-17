# MAL3ABY_FINAL_REMEDIATION_STATE.md

Live state tracker for the **MAL3ABY FINAL AUTONOMOUS REMEDIATION & LAUNCH READINESS** directive. Updated continuously as work progresses — not a final report, a working log.

**Current phase:** Security P0 ✅ closed → Finance P0 ✅ closed → Booking Integrity ✅ verified sound → WhatsApp C4 ✅ closed → Backup/Deployment runbooks ✅ written (external blockers documented) → **now running Phase 2 parallel work: Observability, Auth flow verification, E2E core scenarios (background workflow `wf_616f1628-534`)**.

---

## Completed

### Security P0 (CRITICAL — closed)
- **C1 (privilege escalation)**: `club_memberships` UPDATE policy had no `WITH CHECK` — `club_manager` could self-promote to `club_owner`. Fixed via `protect_club_membership_identity_columns()` BEFORE UPDATE trigger, unconditionally locking `role_id`/`club_id`/`user_id`. **Verified live**: real RLS-authenticated self-escalation attempt blocked, `role_id` unchanged.
- **C2 (cross-tenant contamination)**: same missing-`WITH CHECK` pattern on bookings/customers/payments/invoices/players/subscriptions/enrollments/fields/branches — a multi-club staff member could reassign a row's `club_id`. Fixed via `protect_tenant_id_immutable()` trigger on all 9 tables. **Verified live**: real cross-tenant `club_id` reassignment attempt blocked.
- Migration: `20260818140000_protect_tenant_and_identity_columns.sql`. Commit `583c04b`.

### Security HIGH (closed)
- **FORCE RLS** on 44 tables that had RLS enabled-not-forced. Migration `20260818141000_force_rls_defense_in_depth.sql`. Commit `25e03c0`. Verified live: real client reads/RPCs still work post-migration.
- **`get_club_platform_access()` info leak**: no caller-scope check, any authenticated user could probe any club's subscription status. Fixed with a platform-owner-or-member check. Migration `20260818142000_scope_club_platform_access_caller.sql`. Commit `710ff97`. Verified live: unrelated user now gets `'blocked'`, legitimate callers unaffected.
- Tenant-isolation spot-checks (SELECT/INSERT on customers/payments/invoices/bookings) all confirmed denied cross-tenant.

### Finance P0 (CRITICAL — closed)
- **C3 (payment idempotency/race)**: `record_payment()` had no row lock (race condition risk) and no idempotency key (double-click/retry duplication risk) — a real near-duplicate payment pattern was found in live data before this fix. Fixed with `select ... for update` on the invoice row + new optional `p_idempotency_key uuid` param + partial unique index on `payments(club_id, idempotency_key)`. Old 4-arg overload explicitly dropped (same overload-identity pitfall this project hit twice before). Frontend callers (`BookingDetailSheet.tsx`, `BillingPage.tsx`) updated to generate/reuse real idempotency keys. Migration `20260818150000_payment_idempotency_and_locking.sql`. Commit `93ee654`. **Verified live**: identical-key retry returned the same payment id (no duplicate row); overpayment guard still correctly rejects post-lock; full partial→full payment flow correct.
- **Refund integrity**: verified already sound (no fix needed) — `create_refund()` already uses `for update` + re-checks refundable balance. Live-attacked: over-refund and double-refund both correctly rejected.
- **Cash shifts**: verified already sound (no fix needed) — `close_cash_shift()` already documented as using `for update`, unique partial index prevents multiple open shifts per branch.

### Booking Integrity (verified sound, no fix needed)
- **Double booking**: real `EXCLUDE USING gist` constraint on `bookings(field_id, during)` confirmed live via `pg_constraint`. Live-attacked: exact overlap rejected, partial overlap rejected, adjacent non-overlapping slot correctly succeeds (half-open interval semantics confirmed). Frontend error translation (`23P01` → Arabic message) confirmed present.

### WhatsApp P0 (CRITICAL — closed)
- **C4 (stuck queue)**: pilot club's `whatsapp_accounts` row predated the `messaging_safety_settings` auto-provisioning migration/trigger by ~3 hours, so it was never backfilled — `whatsapp_connector_claim_next_batch()`'s INNER JOIN silently excluded it from every poll forever. Fixed by re-running the original (idempotent, `on conflict do nothing`) backfill INSERT. Migration `20260818151000_backfill_missing_messaging_safety_settings.sql`. Commit `915e75a`. **Verified live**: settings row now exists; the 2 previously-stuck real messages are now correctly included in the connector's claim query (still legitimately quiet-hours-deferred to 08:00 Cairo time, not force-sent per the no-unnecessary-real-messages rule).

### Backup & Deployment (C5/C6 — documented, genuinely external-blocked)
- **C6 root cause confirmed live**: Supabase org `bmqsldayximwywutofgi` is on the `free` plan (`get_organization`) — free tier has zero automated backups (no daily, no PITR). This is a real, confirmed billing blocker, not a guess. `BACKUP_RECOVERY_RUNBOOK.md` written: RPO 24h / RTO 4h targets, restore procedure, and a genuine architectural finding that WhatsApp session state rides along with any DB backup (stored in Postgres, not connector-local disk) — except the encryption key itself, flagged as needing independent secure backup.
- **C5**: `MAL3ABY_DEPLOYMENT_RUNBOOK.md` written — confirms (by reading the connector's own entrypoint/package.json) it needs a persistent VM/PaaS, never serverless/edge. Documents frontend deploy steps, required env vars, rollback plan for all 3 components. Everything preparable without a domain/hosting account/payment is done; the rest is explicitly `PENDING EXTERNAL INPUT`.
- Commits `7b151e7`.

---

## In Progress

Background workflow `wf_616f1628-534` (3 parallel agents, no shared file edits):
1. **Observability**: adding a minimal top-level ErrorBoundary (prevents blank-screen failures) if none exists; checking `pg_cron` availability; scoping (not building) platform-owner WhatsApp health visibility as Phase B.
2. **Auth flows**: verifying login/signup/password-reset/session-guard code paths exist and are correct; re-confirming the known email-confirmation gap is genuinely external (needs a transactional email provider) rather than fixable in-repo; checking the staff-invite flow is real UI, not SQL-only.
3. **E2E core scenarios**: live RPC-level tests for cancellation→QR-revocation, QR lifecycle (valid→used), full finance flow (partial→paid), and tenant-crossing denial across bookings/customers/payments/invoices.

Orchestrator (this session) will review every finding before applying any further fix, per the standing multi-agent discipline rule.

---

## Remaining (not yet started)

- Testing gate: mandatory automated test additions for the P0 fixes just made (currently only verified live via SQL, not captured as an automated regression test — root suite still has only 2 smoke tests).
- Performance: index review for `whatsapp_connection_events` (largest table, no secondary index) and a few FK columns.
- UX regression: three-tier screen sweep (Platform Owner / Club / Customer) at defined breakpoints — largely already covered by prior session work per `MAL3ABY_IA_RESTRUCTURE_STATE.md`, needs a final confidence pass, not a rebuild.
- Final gates (build/typecheck/lint/root tests/connector tests/security/finance/E2E) — run once more, all together, before writing the final report.
- Re-score `MAL3ABY_PRODUCTION_READINESS.md` based on everything closed in this pass — do NOT keep the old 52/100.
- Final single-message report per the directive's required format (not sent yet — waiting for the phase-2 workflow + remaining items above).

## Exact Next Action

Await `wf_616f1628-534` completion (background), triage its 3 result sets, apply any additional safe fixes it surfaces, then move to the Testing gate (add regression tests for the 3 P0 fixes made so far) before the final gate sweep.
