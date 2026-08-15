# Project State

Updated after every phase closes. See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for phase definitions and exit gates.

---

**Last updated:** 2026-08-15

## Current Phase

Planning complete, including a Mandatory Architecture Corrections pass. Phase 0 (Foundations) not yet started — **explicit separate go-ahead required before starting**, per standing instruction (see [PROJECT_RULES.md](PROJECT_RULES.md) rule 5b and 14).

## Completed

- Full initial planning pass: product analysis, architecture, database blueprint, RLS matrix, user flows, screen map, phased implementation plan, test plan
- Three initial blocking business decisions resolved ([DECISIONS.md](DECISIONS.md) ADR-008, ADR-009, ADR-010): freeze extends expiry, per-branch invoice numbering, Arabic-first content
- **Mandatory Architecture Corrections pass (2026-08-15)** — 21 corrections applied across all docs, 11 new ADRs recorded (ADR-011 through ADR-021), new [RLS_SECURITY.md](RLS_SECURITY.md) file created. See "Mandatory Architecture Corrections Log" below for the full list.
- **Platform Billing domain added (2026-08-15, later same day)** — new V1 scope: Mala3by charges clubs a subscription to use the platform, structurally separate from a club's own customer billing. 5 new ADRs (ADR-022 through ADR-026), new Phase 3b in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), 4 new tables (`platform_plans`/`platform_subscriptions`/`platform_invoices`/`platform_payments`), `clubs.status` widened to include `grace_period`, new `auth.club_write_allowed()` RLS helper. Three business decisions resolved: single flat plan (manually priced per club), manual/offline platform payment collection, grace period is read+settle-existing (not full read-only) for 7 days default before full suspension.
- Local git repository initialized (`D:\Ai Projects\Mal3aby`, independent of any other repo)

## In Progress

Nothing — awaiting explicit go-ahead to start Phase 0.

## Blocked

Phase 0 start is blocked pending explicit user go-ahead (standing instruction, not a technical blocker).

## Deferred

See the full [V1 / Deferred Matrix](IMPLEMENTATION_PLAN.md#v1--deferred-matrix). Headline deferrals: `organizations` (fully removed from schema, not a placeholder — added fresh when a real need appears), Cash Shift, Expenses module, Utilization Heatmap, full booking state machine (Draft/Pending), full English content parity.

## Deferred / Technical Debt Notes

(Populated during implementation per [PROJECT_RULES.md](PROJECT_RULES.md) rule 14 — improvement ideas spotted mid-phase but out of that phase's scope get logged here rather than actioned immediately.)

None yet — no implementation has started.

## Known Issues

None yet — no code written.

## Mandatory Architecture Corrections Log (2026-08-15)

Applied before any production code was written, per explicit instruction. Full detail in [DECISIONS.md](DECISIONS.md) ADR-011 through ADR-021 and the correction report delivered in-conversation. Summary of what changed:

1. `organizations`/`organization_id` removed entirely (not kept as nullable placeholder) — ADR-011
2. `payments.invoice_id` removed; `payment_allocations` is the sole payment↔invoice link — ADR-011b
3. Refund model finalized: `refunds` table + reversing allocation, atomic RPC — ADR-011c
4. One subscription : one enrollment made an explicit, enforced rule — ADR-013b
5. Subscription activation policy made a club setting (`manual`/`first_payment`/`full_payment`) — ADR-013
6. Player QR (reusable) separated from Booking QR (consumable) — ADR-011d
7. `qr_scan_events` table added as the real audit/replay/attendance trail — ADR-011d
8. Booking check-in split into scan(validate) + confirm(mutate) as two explicit steps — ADR-011e
9. Exclusion constraint scope corrected to block on `pending_payment`/`confirmed`/`checked_in` — ADR-021
10. Booking creation transaction boundary clarified — QR generation never blocks a valid financial transaction
11. Invoice numbering uses `clubs.club_code`/`branches.branch_code`, never a hardcoded prefix
12. `customers.mobile` unique constraint replaced with `normalized_mobile` + non-unique lookup index — ADR-012
13. Phone normalization utility specified
14. `players.medical_notes` made permission-gated, excluded from default visibility and global search — ADR-019
15. `audit_logs` made immutable — no UPDATE/DELETE policy for any role — ADR-020
16. `SECURITY DEFINER` function discipline formalized in new [RLS_SECURITY.md](RLS_SECURITY.md)
17. Club suspension enforcement clarified as DB/RPC-level, never JWT-based
18. `club_memberships.branch_id` replaced by `membership_branches` join table — ADR-015
19. Role-key authorization checks explicitly forbidden in favor of permission-key checks — ADR-014
20. Money columns standardized to `numeric(12,2)` — ADR-016
21. Single currency per club confirmed, no per-row currency column — ADR-017
22. Timestamp/timezone conventions made explicit — ADR-018
23. Training session uniqueness strengthened to `(group_id, session_date, start_time)`
24. Attendance uniqueness `(session_id, player_id)` made explicit
25. Group enrollment capacity check made concurrency-safe (`SELECT ... FOR UPDATE`)
26. Subscription date logic clarified: `end_date` immutable, `effective_end_date` derived
27. No-hard-delete list expanded explicitly (`qr_scan_events`, `invoice_items` post-issue, etc.)
28. Reports/dashboards required to share one RPC/view definition per metric — no frontend recomputation
29. Git policy corrected to LOCAL ONLY — `git push`/GitHub/Cloudflare/production Supabase all blocked pending separate authorization
30. Phase discipline formalized: one phase at a time, stop-and-report after each, no opportunistic out-of-scope refactors

## Platform Billing Addition Log (2026-08-15, later same day)

New V1 scope, not a correction — a revenue-model layer added on top of the already-corrected architecture. Full detail in [DECISIONS.md](DECISIONS.md) ADR-022 through ADR-026.

1. Platform billing modeled as a structurally separate domain (`platform_plans`/`platform_subscriptions`/`platform_invoices`/`platform_payments`), never reusing `invoices`/`payments`/`payment_allocations` — ADR-022
2. Single flat plan in V1, price optionally overridden per club — ADR-023
3. Platform subscription payment collected manually/offline, recorded by Platform Owner — ADR-024
4. `clubs.status` widened to `active` | `grace_period` | `suspended`; grace period defaults to 7 days, per-club overridable, ends immediately on manual payment — ADR-025
5. Grace period is not blanket read-only: new commitments (`bookings`/`enrollments`/`subscriptions`) blocked, settling existing obligations (`payments`/`refunds`) and operational continuity (`attendance`) remain allowed — ADR-026
6. New `auth.club_write_allowed(p_club_id, p_action_category)` RLS helper centralizes the per-category distinction, used by every affected table's write policies
7. New Phase 3b in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), sequenced immediately after Staff/Permissions (Phase 3) and before any customer-facing domain, since later phases' RPCs depend on `auth.club_write_allowed()` existing first
8. Effective club status computed lazily on every request from `platform_subscriptions` + `now()` — no scheduled job/cron dependency, keeping V1 zero-cost

## Next Task

Awaiting explicit go-ahead to begin Phase 0 (repo scaffolding: Vite+React+TS+Tailwind+shadcn, Supabase CLI local init). Per standing instruction, Phase 0 does not start automatically after this correction pass, even though its readiness status is READY.
