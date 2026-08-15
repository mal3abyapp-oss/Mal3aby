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
- **Platform Billing domain added (2026-08-15, later same day) — [SUPERSEDED, see next entry]** — first pass introduced platform-level billing with `clubs.status` including `grace_period`. This design was corrected in the same day's final pass below.
- **Final Platform SaaS Corrections applied (2026-08-15, final)** — the first Platform Billing pass's core flaw (`grace_period` modeled as a `clubs.status` value) fixed: `clubs.status` is now `active`/`suspended`/`closed` only, fully independent of platform subscription standing. Subscriptions are now period-based (one row per billing cycle with `previous_subscription_id` renewal chain), with snapshotted plan/price/interval terms and real billing durations (Monthly/Quarterly/Semi-Annual/Annual). A single `get_club_platform_access()` function centralizes access derivation. Platform Owner Control Center expanded into a full `/platform` navigation with 5 report types. 9 ADRs (ADR-027 through ADR-035) replace the original 5 (ADR-022 through ADR-026). Phase 3b split into 3b (data model) + 3c (Control Center UI). See "Final Platform SaaS Corrections Log" below for the full list.
- **Public Website + Signup + Free Trial added (2026-08-15, public site)** — new mandatory pre-Phase-0 addition: public marketing site (`/`, `/pricing`, `/contact`, `/terms`, `/privacy`), self-service `/signup` + `/login` + forgot/reset-password (Supabase Auth built-in), 4-step `/onboarding` wizard, and a 7-day free trial. **Key design insight: trial is not a new system — it's `platform_subscriptions.subscription_kind = 'trial'`, a value on the already-existing period-based subscription model**, requiring zero new architecture beyond one enum value and a zero-width grace window. 11 new ADRs (ADR-036 through ADR-046). New atomic RPC `complete_new_club_onboarding()` (highest-risk RPC in the system — reachable with no prior membership to validate against). New Phase 3d in the implementation plan, pulled forward to immediately follow the Platform Owner Control Center rather than deferred to project end. New tables: `platform_settings`, `contact_requests`, `public_plans` view; `platform_plans` gains `is_public`/`display_order`/marketing fields. See "Public Website & Trial Addition Log" below for the full list.
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

## Platform Billing Addition Log (2026-08-15, later same day) — SUPERSEDED

**⚠️ Superseded by the Final Platform SaaS Corrections Log below.** Kept for historical record only — do not implement against this list.

1. ~~Platform billing modeled as a structurally separate domain — ADR-022~~ (concept retained, restated as ADR-028)
2. ~~Single flat plan in V1 — ADR-023~~ (superseded: real billing intervals required, see ADR-029)
3. ~~Platform subscription payment collected manually/offline — ADR-024~~ (concept retained, restated as part of ADR-028's neighborhood)
4. ~~`clubs.status` widened to `active` | `grace_period` | `suspended` — ADR-025~~ (**superseded — this was the core flaw corrected below**)
5. ~~Grace period write-gating — ADR-026~~ (concept retained, redesigned around the corrected access model as ADR-033)

## Final Platform SaaS Corrections Log (2026-08-15, final)

Applied before any production code was written. Full detail in [DECISIONS.md](DECISIONS.md) ADR-027 through ADR-035.

1. **Core fix:** `clubs.status` reverted to `active` | `suspended` | `closed` — `grace_period` removed entirely from this column. It is an administrative-only field, never derived from or set based on billing lateness — ADR-027
2. Platform subscription *effective status* (`trial`/`active`/`grace_period`/`expired`/`cancelled`) is a fully independent, time-derived concept living on `platform_subscriptions`, never on `clubs`
3. Platform billing remains a structurally separate domain from club billing (restated, unchanged concept) — ADR-028
4. Platform plans now support real billing intervals: Monthly (`month×1`), Quarterly (`month×3`), Semi-Annual (`month×6`), Annual (`year×1`), via `billing_interval`+`billing_interval_count` — ADR-029
5. Plan pricing is snapshotted onto each subscription period (`plan_name_snapshot`/`price_snapshot`/`currency_snapshot`/`interval_snapshot`/`interval_count_snapshot`/`grace_period_days_snapshot`) — editing `platform_plans` never retroactively changes an existing period — ADR-030
6. `platform_subscriptions` is now period-based: **one row per billing cycle**, never a single row mutated forever. Renewal creates a new row with `previous_subscription_id` linking to the prior period, preserving full history — ADR-031
7. Overlapping subscription periods for one club are prevented via a GIST exclusion constraint on `(club_id, during)`; adjacent renewal periods (new period starts exactly when old one ends) remain legal under `[)` semantics — ADR-032
8. New `get_club_platform_access(club_id)` function returns `full`/`grace`/`blocked`, combining `clubs.status` + the derived subscription status into one centralized decision — no table re-derives this logic independently — ADR-033
9. Platform Owner Control Center expanded from a single billing screen into a full `/platform` navigation: Overview, Clubs, Subscriptions, Payments, Renewals, Reports, Alerts, Audit, Settings — ADR-034
10. Platform Reports added: Subscription Report, Revenue Report, Renewal Report, Growth Report, Usage Report (per club)
11. Club Owner subscription visibility formally scoped: own club's commercial summary only, never other clubs/platform revenue/internal reports/platform audit — ADR-035
12. `platform_payments` gained reversal columns (`reversed_at`/`reversed_by`/`reversal_reason`) — a mistaken payment record is reversed, never hard-deleted
13. Implementation phase split: Phase 3b (data model + access control) and Phase 3c (Control Center UI + reports), so each stays a manageable single-sitting unit of work

## Public Website & Trial Addition Log (2026-08-15, public site)

New V1 scope added before any production code was written. Full detail in [DECISIONS.md](DECISIONS.md) ADR-036 through ADR-046.

1. **Core design insight:** trial is `platform_subscriptions.subscription_kind = 'trial'` — a value on the existing period-based subscription table, not a new table or system. Reuses the exclusion constraint, `get_club_platform_access()` derivation, and renewal-chain mechanism already built for paid subscriptions — ADR-038
2. Trial requires no payment method anywhere in the flow — zero financial exposure by construction, no `platform_invoices`/`platform_payments` row ever created for a trial — ADR-036
3. Trial length is a `platform_settings.default_trial_days` setting (default 7), read everywhere instead of hardcoded in RPC logic, marketing copy, and in-app messaging separately — ADR-037
4. Trial belongs to the club, not the user — a database-level unique partial index guarantees at most one non-cancelled trial per club, ever, regardless of how many users are added to that club later — ADR-039
5. Public plan data exposed only through a narrow `public_plans` view (`is_public`/`display_order` added to `platform_plans`) — the base table itself is never queried by `anon` — ADR-040
6. Email verification uses Supabase Auth's built-in flow, never a paid provider; verification is a soft prompt, never a hard gate blocking trial start — ADR-041
7. Onboarding finalization (`clubs`+`branches`+`club_memberships`+trial `platform_subscriptions`) is one atomic `SECURITY DEFINER` RPC, `complete_new_club_onboarding()`, with every privileged value (`role_id`, `subscription_kind`, trial duration) derived server-side — never accepted from the client — ADR-042
8. First-run setup after onboarding is a dismissible checklist, not a forced wizard continuation — ADR-043
9. Platform Owner reports gain trial-specific metrics (Trials Started/Active/Expired/Converted, conversion rate) and a `contact_requests` leads view (not a CRM) — ADR-044
10. Duplicate-club detection is advisory (flags for Platform Owner review), never blocks a legitimate signup — ADR-045
11. Signup rate limiting and abuse protection are lightweight (DB-level, no paid CAPTCHA service) — ADR-046
12. Three fully separate layouts confirmed: `PublicLayout`, `AppLayout`, `PlatformLayout` — never merged navigation
13. New Phase 3d in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), landing immediately after the Platform Owner Control Center (3c) rather than deferred to project end, per explicit instruction that this should not wait
14. Phase 1 (shells) and Phase 2 (auth) scopes adjusted: Phase 1 now builds all three layouts; Phase 2's frontend work narrows to `/login` only, with signup/onboarding moved to 3d where it belongs alongside the rest of the conversion flow

## Next Task

Awaiting explicit go-ahead to begin Phase 0 (repo scaffolding: Vite+React+TS+Tailwind+shadcn, Supabase CLI local init). Per standing instruction, Phase 0 does not start automatically after this correction pass, even though its readiness status is READY.
