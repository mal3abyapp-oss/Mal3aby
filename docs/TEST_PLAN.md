# Test Plan

> **Corrected 2026-08-15** per Mandatory Architecture Corrections. New coverage added: `SECURITY DEFINER` cross-tenant tests, group capacity race test, refund-exceeds-balance rejection, `qr_scan_events` completeness, exclusion-constraint boundary/state tests, phone normalization, medical_notes column protection, audit log immutability. See [DECISIONS.md](DECISIONS.md) ADR-011 through ADR-021.
>
> **Added 2026-08-15 (later):** Platform Billing coverage — `grace_period`/`suspended` status transitions, per-action-category write-gating (`auth.club_write_allowed()`), platform billing table isolation from all non-Platform-Owner roles. See [DECISIONS.md](DECISIONS.md) ADR-022 through ADR-026.

Not aiming for 100% coverage as a formal goal. Aiming to make the critical, hard-to-reverse business logic provably correct — especially anything touching money, availability, or tenant isolation. Everything below runs locally against `supabase start` — no test ever depends on production. See [PROJECT_RULES.md](PROJECT_RULES.md) rule 5.

## Layers

### Unit (Vitest)
Pure functions in `lib/domain/` only — no Supabase client, no DOM. Price calculation (pricing rule resolution/priority), subscription effective-expiry derivation, installment/outstanding-balance math, invoice total calculation, phone number normalization utility (`010...`/`+2010...`/`002010...` → same `normalized_mobile`).

### Database / RLS (pgTAP, via `supabase test db`)
- Cross-club isolation matrix (see [RLS_MATRIX.md](RLS_MATRIX.md#verification-checklist-phase-2-gate)) — run per tenant-scoped table, not just spot-checked
- **Every `SECURITY DEFINER` function** — cross-tenant rejection test per the [RLS_SECURITY.md](RLS_SECURITY.md#verification-checklist-part-of-phase-14-gate) checklist: pinned `search_path` present, spoofed `club_id` argument rejected, identity resolved only from `auth.uid()`, internal permission check present, `EXECUTE` grants role-scoped not blanket
- Double-booking exclusion constraint under direct SQL insert (bypassing the RPC) and under simulated concurrent connections; constraint blocks on `pending_payment`/`confirmed`/`checked_in` and does **not** block on `completed`/`cancelled`/`no_show`; boundary test confirms `10:00–11:00` and `11:00–12:00` do not overlap (`[)` semantics)
- QR validate (scan) never mutates `qr_credentials` or `bookings` by itself; confirm-check-in RPC atomically consumes + transitions booking status together; replay of confirm returns zero rows on second attempt; player QR (`single_use=false`) can be scanned repeatedly without consumption, each scan producing its own `qr_scan_events` row
- `qr_scan_events` completeness — every scan outcome (success/already_used/expired/invalid/wrong_club/permission_denied) produces exactly one row, regardless of what happened to the credential
- Invoice numbering under concurrent calls — no duplicates, no gaps beyond intentional voids; `club_code`/`branch_code` correctly read from `clubs`/`branches`, never a hardcoded prefix
- Payment allocation sum trigger — rejects over-allocation (`SUM(payment_allocations.amount) per payment_id > payments.amount`)
- Refund correctness — original `payments.amount` unchanged and payment never deleted; a refund request exceeding the payment's refundable balance (amount minus prior completed refunds) is rejected atomically, including under concurrent refund attempts on the same payment; ledger balances correctly after refund; audit log entry always created
- Subscription freeze — `subscriptions.end_date` is never mutated; derived `effective_end_date` correctly shifts forward by frozen duration when `extends_expiry = true`, unchanged when `false`
- Subscription activation — all three `subscription_activation_policy` values (`manual`/`first_payment`/`full_payment`) produce correct activation behavior against the same underlying payment data
- Group enrollment capacity — concurrent enrollment attempts for the last open spot in a group; exactly one succeeds, verified via the `SELECT ... FOR UPDATE` lock on `groups`
- Session generation idempotency — re-running generation for an already-covered date range creates zero duplicate `training_sessions` rows (`(group_id, session_date, start_time)` constraint)
- Attendance uniqueness — marking the same player twice for one session always results in one row (`UPDATE`, not a second `INSERT`), per `(session_id, player_id)`
- `audit_logs` immutability — `UPDATE`/`DELETE` attempts rejected for every role, including Club Owner and Platform Owner
- `players.medical_notes` column protection — a role without `player.medical_notes.view` never receives the column in any query result, including a raw PostgREST call; never present in global search results
- Role/permission checks — a role without a given permission is rejected on INSERT/UPDATE at the RLS layer, not just hidden in the UI
- Branch scope via `membership_branches` — a membership with explicit rows is restricted to exactly those branches; a membership with zero rows has access to all branches of its club
- Platform Billing table isolation — `platform_plans`/`platform_subscriptions`/`platform_invoices`/`platform_payments` inaccessible to every non-`platform_owner` role, including Club Owner querying their own club's rows directly
- Effective club status derivation — a club with an overdue `platform_invoices` row and unpaid `platform_subscriptions` computes as `grace_period` within its `grace_period_days` window and `suspended` after, purely from querying `platform_subscriptions` + `now()` (no reliance on a scheduled job having run)
- `auth.club_write_allowed()` per-category correctness — `'new_commitment'` rejected in `grace_period`, `'settle_existing'` and `'operational_continuity'` allowed in `grace_period`, all three rejected in `suspended`, all three allowed in `active`
- Recording a `platform_payments` row immediately flips effective status back to `active` on the next request, regardless of prior grace-period elapsed time

### Integration
End-to-end against a local Supabase instance (not mocked): booking creation (slot search → price calc → RPC → invoice → QR), QR scan-then-confirm check-in as two distinct steps, subscription lifecycle (enroll → pay → activate per policy → freeze → derive effective expiry → expire), refund end-to-end, academy enrollment under simulated capacity contention, platform billing lifecycle (club overdue → grace_period → attempt new booking [rejected] → attempt payment collection [succeeds] → suspended → platform payment recorded → active again).

### Manual QA
Responsive pass across mobile/tablet/desktop breakpoints; print QA (A4 + 80mm thermal — real printer if available, otherwise accurate print-preview); camera QA for `/scan` on an actual phone (desktop browser camera permission behavior differs from mobile); verify a QR scan alone never checks a booking in without the explicit confirm tap.

## Critical Test List

Every item below must have a passing automated test (pgTAP or Vitest/integration) before the owning phase's exit gate is considered met:

- RLS isolation (per table, per role where relevant)
- Cross-club access denial (SELECT/INSERT/UPDATE/DELETE attempts), including via every `SECURITY DEFINER` function
- Double booking prevention (direct SQL + concurrent RPC calls), correct status scope (`pending_payment`/`confirmed`/`checked_in` blocked, `completed`/`cancelled`/`no_show` not)
- Concurrent booking race (two simultaneous requests for the same slot)
- Invoice total correctness (subtotal + tax − discount = total, across multiple line items)
- Payment allocation correctness (partial payments, multi-invoice payments) — verified with **no reliance on any `payments.invoice_id` column**, which does not exist
- Refund correctness (ledger consistency, original payment untouched, cannot exceed refundable balance even concurrently)
- Subscription activation under each of the three `subscription_activation_policy` values
- Subscription expiry (active → expired when derived `effective_end_date` passes with no active freeze)
- Installment / outstanding balance correctness against the ledger (via `payment_allocations`, never a stored `amount_paid`/`amount_remaining`)
- QR validate-vs-confirm separation (scan alone never mutates; confirm is atomic and idempotent-safe against replay)
- QR expiry (expired token rejected even if otherwise valid)
- `qr_scan_events` records every scan attempt regardless of outcome
- Group capacity race (concurrent enrollment into the last spot — exactly one succeeds)
- Session generation idempotency
- Attendance uniqueness per `(session_id, player_id)`
- Role permission enforcement (unauthorized action rejected server-side, not just hidden client-side) — via permission keys, never role-key comparisons
- Branch-scoped permission enforcement via `membership_branches` (explicit rows restrict; zero rows means all branches)
- Invoice numbering concurrency (no duplicate numbers under parallel connections; correct club/branch code substitution)
- Audit log immutability (no role can UPDATE/DELETE)
- `medical_notes` column protection
- Phone normalization correctness (multiple input formats resolve to the same `normalized_mobile`)
- Platform Billing table isolation from all non-Platform-Owner roles
- `active` → `grace_period` → `suspended` → `active` transition correctness, computed lazily from `platform_subscriptions`, not a stored-and-trusted flag alone
- `auth.club_write_allowed()` per-category gating correct in all three club statuses × all three action categories

## What Is Explicitly Not Tested Formally in V1

UI pixel-perfect visual regression, exhaustive input-fuzzing of every form field, load testing beyond what a single pilot club would generate. These aren't ignored — they're just not automated test-suite items; manual QA covers what's needed for V1's actual scale.
