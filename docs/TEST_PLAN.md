# Test Plan

> **Corrected 2026-08-15** per Mandatory Architecture Corrections. New coverage added: `SECURITY DEFINER` cross-tenant tests, group capacity race test, refund-exceeds-balance rejection, `qr_scan_events` completeness, exclusion-constraint boundary/state tests, phone normalization, medical_notes column protection, audit log immutability. See [DECISIONS.md](DECISIONS.md) ADR-011 through ADR-021.
>
> **Corrected 2026-08-15 (final)** per Final Platform SaaS Corrections. `clubs.status` never contains `grace_period` — replaced coverage below with `get_club_platform_access()` derivation tests, period-based subscription/renewal/overlap tests, and plan-price-snapshot immutability tests. See [DECISIONS.md](DECISIONS.md) ADR-027 through ADR-035.

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
- `clubs.status` constraint enforcement — attempting to write `'grace_period'` (or any value outside `active`/`suspended`/`closed`) into `clubs.status` is rejected at the check-constraint level, not just by application discipline
- `get_club_platform_access()` derivation correctness — for a club whose current period's `now() < end_at` returns `full`; `end_at <= now() < end_at + grace_days_snapshot` returns `grace`; `now() >= end_at + grace_days_snapshot` returns `blocked`; `lifecycle_status = 'cancelled'` returns `blocked` regardless of dates; `clubs.status IN ('suspended','closed')` returns `blocked` regardless of subscription standing — all purely from querying `platform_subscriptions` + `clubs.status` + `now()`, no reliance on a scheduled job having run
- `auth.club_write_allowed()` per-category correctness — `'new_commitment'` rejected in `grace`, `'settle_existing'` and `'operational_continuity'` allowed in `grace`, all three rejected in `blocked`, all three allowed in `full`
- Recording a `platform_payments` row immediately flips `get_club_platform_access()` to `full` on the next call, regardless of prior grace-period elapsed time, without any stored status column being updated
- Subscription period overlap prevention — two `platform_subscriptions` rows for the same club with overlapping `[start_at, end_at)` ranges → the second insert rejected by the exclusion constraint (tested both via direct SQL and simulated concurrent RPC calls); a renewal starting exactly at the prior period's `end_at` → succeeds
- Plan price/interval snapshot immutability — editing `platform_plans.price` after a subscription period was created does not change that period's `price_snapshot`; a new period created afterward reflects the new price
- Renewal history correctness — `renew_platform_subscription` creates a new row with `previous_subscription_id` correctly pointing at the prior period; walking the `previous_subscription_id` chain for a club reconstructs its full renewal history in order

### Integration
End-to-end against a local Supabase instance (not mocked): booking creation (slot search → price calc → RPC → invoice → QR), QR scan-then-confirm check-in as two distinct steps, subscription lifecycle (enroll → pay → activate per policy → freeze → derive effective expiry → expire), refund end-to-end, academy enrollment under simulated capacity contention, platform billing lifecycle (club subscription period lapses → `get_club_platform_access()` returns `grace` → attempt new booking [rejected] → attempt payment collection [succeeds] → grace window elapses → `blocked` → platform payment recorded against a renewal → `full` again, with `clubs.status` unchanged throughout), platform subscription renewal (create period 1 → renew into period 2 → verify no overlap, correct `previous_subscription_id`, correct snapshot values on period 2 if plan price changed between periods).

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
- `clubs.status` never accepts `'grace_period'` — check constraint enforced
- `get_club_platform_access()` (`full`/`grace`/`blocked`) correctness across all boundary conditions, computed live from `platform_subscriptions` + `clubs.status` + `now()`, not a stored-and-trusted flag alone
- `auth.club_write_allowed()` per-category gating correct in all three access levels × all three action categories
- Subscription period overlap prevention + adjacent-renewal legality
- Plan price/interval snapshot immutability across plan edits
- Renewal creates a correctly-linked new period row, never mutates the prior one

## What Is Explicitly Not Tested Formally in V1

UI pixel-perfect visual regression, exhaustive input-fuzzing of every form field, load testing beyond what a single pilot club would generate. These aren't ignored — they're just not automated test-suite items; manual QA covers what's needed for V1's actual scale.
