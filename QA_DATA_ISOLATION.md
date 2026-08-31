# QA / Test / Demo Data Isolation

Written 2026-08-31, Controlled Commercial Launch Gate, Phase 6.

## Current state (verified live, not assumed)

**Every tenant in production today is a disposable QA/test/demo
fixture.** There is currently ZERO real paying customer. Confirmed by
listing every row in `public.clubs`:

| Club ID | Name | Created | Classification |
|---|---|---|---|
| `57ce89e4-184a-413f-bc47-ee0fdb878727` | Mala3by Test Club One | 2026-08-15 | QA fixture |
| `c0b02979-a49e-4338-bcac-d789ca397aeb` | Mala3by Test Club Two | 2026-08-15 | QA fixture |
| `0d533d74-c98e-49f1-a59b-b3d75a5af133` | Mala3by Verification Club | 2026-08-15 | QA fixture |
| `7f337c8c-f641-4f51-9d52-4a4e737b2934` | Mala3by Verification Club 2 | 2026-08-15 | QA fixture |
| `b9178c0f-00b5-4c71-abec-b8772ffb8682` | Test | 2026-08-15 | QA fixture |
| `6ca5315e-e199-4531-9fb1-1df358cda087` | QA Full Test Club | 2026-08-16 | QA fixture |
| `a6bf6b6d-9a58-4636-bc6b-8ab0e7ed0b50` | Demo Club | 2026-08-29 | Demo fixture |
| `da916cde-3e66-4010-9fee-020ae981758c` | QA_Lifecycle_Club_A | 2026-08-31 | QA fixture |
| `91b90fe2-4edb-4fd1-93b8-f0e5beaa7a9a` | QA_Lifecycle_Club_A2 | 2026-08-31 | QA fixture |
| `563eb7d0-8615-4021-a70b-f79560f63243` | QA_Lifecycle_Club_B | 2026-08-31 | QA fixture |
| `774aea41-f7f7-4952-96c4-4e02ea87fa65` | QA_Lifecycle_RegressionCheck | 2026-08-31 | QA fixture |
| `f8376f07-2b53-4146-a7fd-411c2672115a` | Mal3aby E2E QA Club | 2026-08-31 | QA fixture (real financial history — see below) |
| `676ea358-0db4-49e5-bfc6-e6d21abf960b` | Mal3aby E2E Tenant B | 2026-08-31 | QA fixture (attack-testing only) |

**All 13 are safe to leave exactly as they are.** None is a real
customer, so no live contamination of "real tenant reporting" is
currently possible — that risk only becomes real the moment the first
genuine paying tenant is onboarded (see
`FIRST_CUSTOMER_ONBOARDING_RUNBOOK.md`).

## Why these are NOT mass-deleted

Two of these (`f8376f07...` and `676ea358...`, from the Full Product
E2E Production Acceptance phase) carry **real, deeply cross-referenced
financial/audit history** — real bookings, payments, refunds, cash
shifts, membership sales, academy enrollments, all with correct
cross-module reconciliation already proven exact. Per this project's
own standing discipline (already documented in that phase's own
acceptance report): deleting this history for cosmetic cleanup risks
orphaned foreign-key references and destroys real, already-verified
proof of the platform's own correctness — never done for cosmetic
reasons. **Left intact and clearly identifiable by this document.**

The remaining 11 are lighter-weight fixtures from earlier phases,
similarly left intact rather than risking a destructive cleanup pass
this launch-gate mission was not asked to perform.

## Real gap found: platform-level views have no QA/real distinction

`PlatformOverviewPage.tsx` (and by extension any other platform-owner
screen that lists all clubs) queries `public.clubs` with **no filter
distinguishing QA/demo fixtures from real tenants** — confirmed via
direct source read (`supabase.from('clubs').select('id, status,
created_at, flagged_duplicate')`, unfiltered). The existing
`flagged_duplicate` column is semantically for name-collision detection
at signup time (a different, real, already-working feature) — reusing
it to also mean "this is test data" would conflate two different
concerns and was deliberately NOT done.

**Classified as CORE P2, not a launch blocker, for one concrete
reason**: there is no real tenant yet, so no real contamination
exists today. This becomes a live concern the moment tenant #1 truly
onboards — at that point, the 13 QA tenants above would appear
alongside it in every platform-owner list/report with no visual
distinction. **Recommended, not built this pass** (would be a real
schema change + UI change, correctly out of scope for "the smallest
bounded fix" when the actual failure condition doesn't exist yet): add
a genuine `is_test_fixture boolean default false` column to `clubs`,
set `true` for the 13 IDs above via one governed migration, and filter
platform-owner list views to exclude it by default (with an explicit
toggle to show them, for support/QA purposes). This is a real,
concrete, well-scoped follow-up — not invented busywork — and should
be done before or immediately after the very first real tenant signs
up, not deferred indefinitely.

## Customer-facing / tenant-facing isolation — already correct

Per every prior phase's own tenant-isolation testing (Full Product
E2E: 6 live cross-tenant attacks all correctly blocked; Notifications:
zero cross-tenant recipient mismatches found database-wide; this
phase: RLS confirmed forced on every table) — **a real tenant can
never see another tenant's data, QA or otherwise, regardless of this
platform-level visibility gap.** RLS scoping is per-`club_id`
unconditionally; the gap identified above is specifically and only a
**platform-owner-side visual/reporting** concern (an operator seeing
QA clutter mixed with real tenants), never a security or customer-facing
leak.

## Search / Customer360 / notification history

Same analysis: these are all correctly `club_id`-scoped by RLS. A real
tenant's staff searching their own customers, viewing their own
Customer360 records, or reading their own notification history can
never see another tenant's (QA or real) records — already proven this
entire engagement.
