# Project State

Updated after every phase closes. See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for phase definitions and exit gates.

---

**Last updated:** 2026-08-15

## Current Phase

**Autonomous execution underway.** Phase 0 + Phase 1 **complete**. Phase 2 database/RLS/security/frontend work **complete and verified**; one item outstanding (see below).

### Phase 2 — Auth + Multi-Tenant Core + RLS: DB/RLS/SECURITY COMPLETE, test-user login pending external unblock
- Confirmed real Supabase Cloud project `gxkrtlvpjwxhcqdisyob` (mal3abyapp-oss's Project, eu-central-1, Postgres 17.6.1.155) as the approved final database via Supabase MCP `list_projects`/`list_tables`/`list_migrations` (was empty, 0 tables, 0 migrations before this phase).
- Migration `supabase/migrations/20260815120000_phase2_identity_multitenant_rls.sql` applied: `clubs`, `branches`, `profiles`, `roles`, `permissions`, `role_permissions`, `club_memberships`, `membership_branches` — all 8 tables, RLS enabled on every one.
- **Deviation from RLS_SECURITY.md naming (forced, documented):** helper functions (`user_club_ids`, `has_permission`, `has_branch_access`, `is_platform_owner`) live in `public.*`, not `auth.*` — the migration role gets `permission denied for schema auth` on CREATE FUNCTION (Supabase reserves that schema). Functionally identical; every actual checklist item (pinned `search_path`, `auth.uid()`-only identity, no trusted client `club_id`, per-role `EXECUTE` grants) is unaffected by the schema name. Docs (`RLS_SECURITY.md`, `DECISIONS.md`) still need a follow-up note recording this as a platform constraint, not a design change — do that at the next docs pass, not urgent enough to block progression.
- `get_advisors(security)` run twice: first pass flagged `anon`-executable SECURITY DEFINER functions (schema-level default grants on `public` survive an explicit `revoke ... from public`); fixed with explicit `revoke ... from anon` on all 4 helpers + full lockdown of `handle_new_user` (trigger-only, now uncallable by anyone via RPC). Second pass: clean except the 4 expected `authenticated`-only warnings, which are correct-by-design (any signed-in user checks their own `auth.uid()`-scoped access).
- Seed data applied: 9 roles, 5 baseline permissions, 10 role→permission grants (club_owner/club_manager/branch_manager), verified via `list_tables` row counts.
- TypeScript types regenerated from live schema → `src/lib/supabase/types.ts`.
- Frontend: `AuthProvider` (session + club_memberships join, localStorage-persisted current-club selection), `RequireAuth`/`RequirePlatformOwner` route guards wired into `router.tsx`, real `/login` page (`supabase.auth.signInWithPassword`, generic error message per error-state pattern), club-switcher + sign-out wired into `AppLayout` sidebar.
- Verified: build ✅ (`tsc -b && vite build`), lint ✅ (0 errors, pre-existing fast-refresh warnings only), tests ✅ (2/2).
- **Outstanding, external, non-security:** Supabase's built-in mailer is rate-limiting confirmation emails (`email rate limit exceeded`, 0 rows in `auth.users` after 2 real `signUp()` attempts ~5 min apart) — blocks creating the two real seeded test users needed to prove `/login` end-to-end per this phase's Functional Gate. No MCP tool exposes Auth-config management (can't toggle "Confirm email" off programmatically). User confirmed: wait and retry later rather than have me hand-insert rows into `auth.users` directly (rejected as unsupported/fragile — bypasses GoTrue's own invariants and wouldn't actually prove the real login flow works). Will retry signup periodically; once it succeeds, seed `club_memberships` for 2 test clubs and close this phase's Functional Gate, then proceed immediately to Phase 3 without further pause.

### Phase 1 — Design System + Shells: COMPLETE
- Shared component foundation on shadcn/ui: Button, Input, Select, Card, Dialog, Sheet, Tabs, Badge, DropdownMenu, Separator, Skeleton, Avatar + custom StatusBadge/MoneyDisplay/StatCard/EmptyState/ErrorState/PageHeader/DataTable per DESIGN_SYSTEM.md
- Three layout shells built and verified in-browser: `PublicLayout` (header/footer, marketing nav), `AppLayout` (dark sidebar desktop + bottom nav mobile), `PlatformLayout` (dark console sidebar, full Overview/Clubs/.../Settings nav)
- Full route map wired in `src/app/routing/router.tsx` matching SCREEN_MAP.md exactly — all public/auth/onboarding/app/platform routes present as placeholder pages tagged with their owning phase
- `DirectionProvider` — Arabic/RTL is the default (`dir="rtl"`, `lang="ar"` on `<html>`), toggle-ready for LTR
- Verified: build ✅, typecheck ✅, lint (0 errors) ✅, tests (2/2) ✅; in-browser smoke test confirmed `/`, `/app`, `/platform`, `/pricing` all render correct content inside the correct layout with no client-side routing errors
- No route guards yet (by design — Phase 2/3d), no real data (by design)

### Phase 0 — Foundations: COMPLETE
- Vite + React 18 + TypeScript (strict) + Tailwind + shadcn/ui (`new-york` style) scaffolded at repo root
- Domain-based `src/` layout per ARCHITECTURE.md (`app/{layouts,routing,providers}`, `components/ui`, `features/`, `lib/{supabase,domain}`, `hooks/`)
- Dependencies installed: react-router-dom, @tanstack/react-query, @supabase/supabase-js, qrcode, @zxing/browser, vite-plugin-pwa, vitest + testing-library
- Design tokens from DESIGN_SYSTEM.md wired into `tailwind.config.ts` + `src/index.css` (CSS vars, HSL-mapped for shadcn component compatibility)
- `.env.example` / `.gitignore` verified — no secrets committed, service_role key never referenced client-side
- `supabase init` run — `supabase/{config.toml,migrations/,seed.sql,tests/}` scaffolded, no migrations yet (Phase 2)
- Build/typecheck/lint/test all pass: `npm run build` ✅, `tsc -b` ✅, `eslint` (0 errors, 1 benign shadcn-file warning) ✅, `vitest run` (1/1) ✅
- Dev server verified in-browser: renders Arabic RTL shell, zero console errors
- **Known gap (non-blocking):** Docker Desktop not running locally, so `supabase start` (local Postgres stack) has not been verified end-to-end yet. Will retry when Phase 2 needs local RLS testing; not required for Phase 0/1 (no schema work yet).
- **Deferred, low-risk:** react-router-dom has an unpatched moderate CVE (open-redirect) pending an upstream non-breaking fix; not exploitable in this app's server-authoritative model. Re-check when upgrading.

## Completed

- Full initial planning pass: product analysis, architecture, database blueprint, RLS matrix, user flows, screen map, phased implementation plan, test plan
- Three initial blocking business decisions resolved ([DECISIONS.md](DECISIONS.md) ADR-008, ADR-009, ADR-010): freeze extends expiry, per-branch invoice numbering, Arabic-first content
- **Mandatory Architecture Corrections pass (2026-08-15)** — 21 corrections applied across all docs, 11 new ADRs recorded (ADR-011 through ADR-021), new [RLS_SECURITY.md](RLS_SECURITY.md) file created. See "Mandatory Architecture Corrections Log" below for the full list.
- **Platform Billing domain added (2026-08-15, later same day) — [SUPERSEDED, see next entry]** — first pass introduced platform-level billing with `clubs.status` including `grace_period`. This design was corrected in the same day's final pass below.
- **Final Platform SaaS Corrections applied (2026-08-15, final)** — the first Platform Billing pass's core flaw (`grace_period` modeled as a `clubs.status` value) fixed: `clubs.status` is now `active`/`suspended`/`closed` only, fully independent of platform subscription standing. Subscriptions are now period-based (one row per billing cycle with `previous_subscription_id` renewal chain), with snapshotted plan/price/interval terms and real billing durations (Monthly/Quarterly/Semi-Annual/Annual). A single `get_club_platform_access()` function centralizes access derivation. Platform Owner Control Center expanded into a full `/platform` navigation with 5 report types. 9 ADRs (ADR-027 through ADR-035) replace the original 5 (ADR-022 through ADR-026). Phase 3b split into 3b (data model) + 3c (Control Center UI). See "Final Platform SaaS Corrections Log" below for the full list.
- **Public Website + Signup + Free Trial added (2026-08-15, public site)** — new mandatory pre-Phase-0 addition: public marketing site (`/`, `/pricing`, `/contact`, `/terms`, `/privacy`), self-service `/signup` + `/login` + forgot/reset-password (Supabase Auth built-in), 4-step `/onboarding` wizard, and a 7-day free trial. **Key design insight: trial is not a new system — it's `platform_subscriptions.subscription_kind = 'trial'`, a value on the already-existing period-based subscription model**, requiring zero new architecture beyond one enum value and a zero-width grace window. 11 new ADRs (ADR-036 through ADR-046). New atomic RPC `complete_new_club_onboarding()` (highest-risk RPC in the system — reachable with no prior membership to validate against). New Phase 3d in the implementation plan, pulled forward to immediately follow the Platform Owner Control Center rather than deferred to project end. New tables: `platform_settings`, `contact_requests`, `public_plans` view; `platform_plans` gains `is_public`/`display_order`/marketing fields. See "Public Website & Trial Addition Log" below for the full list.
- **Final Pre-Implementation Directive applied (2026-08-15, final pre-implementation)** — the last mandatory pass before Phase 0: security/anti-fraud consolidated into a new [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md) (Trust-Nothing-From-Frontend principle, per-domain fraud controls, 13-item Abuse Test Catalogue, P0–P3 severity classification, per-phase Security Gate checklist); full visual identity established in a new [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) (color/type/spacing tokens, component foundation, responsive matrix, public/platform visual language); 4 new ADRs (ADR-047 through ADR-050); last three operational necessities added (Recurring Booking, Outstanding Payments view, Quick Field Block) plus CSV export/Global Search/Quick Actions; every implementation phase now carries an explicit Security Gate alongside its Functional Gate. See "Final Pre-Implementation Directive Log" below for the full list.
- **Final Comprehensive Pre-Implementation Audit performed (2026-08-15, comprehensive audit)** — full cross-document consistency audit across all 14 docs (manual close-reading + automated 12-category sweep via a background subagent). Found and fixed 5 real defects: an undefined `booking.discount` permission key used in USER_FLOWS.md (actual keys are `.apply`/`.override`), Global Search + Quick Actions marked shipped but absent from SCREEN_MAP.md's inventory and unscheduled in any phase (now added and scheduled in Phase 7/9), `profiles` and `invoice_number_sequences` missing from RLS_MATRIX.md's role×table matrix, a desync between RLS_MATRIX.md's and SECURITY_ANTI_FRAUD.md's audit-scope lists, and no consolidated `SECURITY DEFINER` function inventory anywhere (now added to RLS_SECURITY.md, 25 functions named with purpose/justification). Verdict: ARCHITECTURE/SECURITY/DATA INTEGRITY/DOCUMENTATION all PASS, V1 SCOPE LOCKED, PHASE 0 READY (pending explicit go-ahead). Two open decisions flagged for later closure: trial-abuse-via-multiple-clubs policy, recurring-booking invoice granularity. Local commit `06b1dfb`.
- **Final Two Decisions Closure applied (2026-08-15, final two decisions)** — closes the two decisions flagged by the comprehensive audit. **Automatic Trial Entitlement** (ADR-051): one automatic trial per user account (new `automatic_trial_entitlements` table, unique `user_id`, consumed inside the onboarding transaction, concurrency-safe by construction — no `SELECT`-then-`INSERT` race), independent of and additional to the existing one-trial-per-club rule; a user is never blocked from creating additional clubs, only from receiving a second automatic trial; `complete_new_club_onboarding()` now returns an explicit `trial_granted` boolean rather than throwing, so a second club still creates successfully with a "Subscription Required" outcome instead of "Trial Activated"; Platform Owner retains an always-available, always-audited manual trial/complimentary grant path, fully independent of the entitlement table. **Recurring Booking Billing Granularity** (ADR-052): confirmed final — one fully independent financial lifecycle per booking occurrence, no series-level invoice concept in V1, `booking_series` remains bookkeeping-only; this closes what was previously left open as an implementation-time detail in USER_FLOWS.md Flow 1b. 2 new ADRs (ADR-051, ADR-052). Fixed a real contradiction found during this pass: USER_FLOWS.md Flow 8 and IMPLEMENTATION_PLAN.md Phase 3d both previously stated that an existing club owner "cannot reach this flow to create a second club" — directly contradicted by the new policy — corrected in both files.
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

## Final Pre-Implementation Directive Log (2026-08-15, final pre-implementation)

Applied before any production code was written. Full detail in [DECISIONS.md](DECISIONS.md) ADR-047 through ADR-050, new [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md), new [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).

1. **Trust Nothing From Frontend** formalized as [PROJECT_RULES.md](PROJECT_RULES.md) rule 16 — `club_id`/`branch_id`/`price`/`discount`/`role`/`permission`/`status`/`trial_days`/`subscription_kind`/`invoice_total`/`payment_status`/`booking_status` are never trusted as client-supplied values where they should be database-derived
2. New [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md) consolidates per-domain fraud controls: booking security (secure RPC, price recomputation, discount permissions), financial security (issued invoice lock, payment reversal not edit, refund atomicity), QR security, multi-tenant security, separation of duties, audit coverage
3. **Abuse Test Catalogue** — 13 specific abuse scenarios (club_id spoofing, price manipulation, role spoofing, expired-club booking, overlapping booking, refund overpayment, QR replay, over-capacity enrollment, issued invoice edit, payment deletion, cross-club read, platform_owner claim, 365-day trial claim) — each mapped to a specific control and required test
4. **Security Gate** added to every implementation phase alongside the existing Functional Gate — a phase is not complete until both pass; findings severity-classified P0 (Critical) through P3 (Low), any open P0/P1 blocks the Exit Gate — [PROJECT_RULES.md](PROJECT_RULES.md) rule 18
5. **Security and design built with each domain, not deferred** — [PROJECT_RULES.md](PROJECT_RULES.md) rule 17 / [DECISIONS.md ADR-050](DECISIONS.md#adr-050--security-and-design-are-built-with-each-domain-not-deferred-to-a-late-hardeningpolish-phase) — restates and makes explicit what the phase plan already did; Phase 14/15 are independent re-verification passes, not the first time these concerns are addressed
6. New [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) — brand direction (Modern Sports Operations SaaS), color/typography/spacing/radius/shadow tokens, icon system, RTL-first component rules, App Shell/Tablet/Mobile responsive rules, component foundation (18 shared components), Booking Calendar/Dashboard/Academy/Scanner/Billing UX patterns, Public Website + Platform Owner visual language, Design QA checklist — built in Phase 1, before any real screen
7. **Recurring Booking** — `booking_series` linking table + N real individually-conflict-checked `bookings` rows, never a bypass of the exclusion constraint; explicit conflict reporting, never a silent partial series — ADR-047
8. **Outstanding Payments** — `outstanding_invoices` view, ledger-derived, no new stored financial value — ADR-048
9. **Quick Field Block** — never silently cancels existing bookings; surfaces conflicts for explicit manager decision — ADR-049
10. CSV export (client-side, no library), Global Search, Quick Actions (Ctrl/Cmd+K, desktop) added as the last operational necessities — no new modules beyond these
11. Phase 6 (Booking) expanded to include Recurring Booking + Quick Field Block; Phase 7 (Billing) expanded to include Outstanding Payments + CSV export — fitting inside the domains that already own that data, per rule 17, not new phases
12. Full cross-document contradiction sweep completed — no stale references found; all ADR/anchor links verified

## Final Comprehensive Audit Log (2026-08-15, comprehensive audit)

Full detail in the "FINAL COMPREHENSIVE AUDIT REPORT" delivered in-conversation. Five real defects found and fixed:

1. `booking.discount` (bare, undefined) used in USER_FLOWS.md — corrected to `booking.discount.apply`, ambiguous three-form listing in IMPLEMENTATION_PLAN.md Phase 6 disambiguated
2. Global Search + Quick Actions marked ✅-shipped in the V1/Deferred Matrix, present in USER_FLOWS.md, but absent from SCREEN_MAP.md's screen inventory and unscheduled in any phase — added to inventory, scheduled in Phase 7 (Search) and Phase 9 (Quick Actions)
3. `profiles` and `invoice_number_sequences` missing rows in RLS_MATRIX.md's role×table matrix — added
4. RLS_MATRIX.md's and SECURITY_ANTI_FRAUD.md's audit-scope lists disagreed (invoice-void, field-block-creation, onboarding-completion inconsistently present) — synchronized
5. No consolidated `SECURITY DEFINER` function inventory existed anywhere; two RPCs had no canonical name — added a 25-function inventory table to RLS_SECURITY.md

Two open decisions flagged at the end of this pass (both now closed — see the Final Two Decisions Closure Log below): trial-abuse-via-multiple-clubs policy, recurring-booking invoice granularity.

## Final Two Decisions Closure Log (2026-08-15, final two decisions)

Full detail in [DECISIONS.md](DECISIONS.md) ADR-051, ADR-052.

1. **Automatic Trial Entitlement** (ADR-051) — one automatic trial per user account via new `automatic_trial_entitlements` table (unique `user_id`), independent of and additional to the existing one-trial-per-club rule; concurrency-safe via the unique-constraint-as-guard pattern, no `SELECT`-then-`INSERT` race
2. A user is never blocked from creating additional clubs — only the automatic trial grant is limited; `complete_new_club_onboarding()` now returns `trial_granted: boolean` explicitly rather than throwing, enabling a "Club Created — Subscription Required" outcome as a known business result, not an error
3. Platform Owner's manual trial/complimentary grant path is fully independent of `automatic_trial_entitlements` and always audited (actor/club/reason/dates/`subscription_kind`)
4. **Recurring Booking Billing Granularity** (ADR-052) confirmed final — one independent financial lifecycle per occurrence, no series-level invoice, `booking_series` remains bookkeeping-only; closes what USER_FLOWS.md Flow 1b had left as an open implementation-time detail
5. **Contradiction found and fixed:** USER_FLOWS.md Flow 8 and IMPLEMENTATION_PLAN.md Phase 3d both stated a user with an existing club membership "cannot reach this flow to create a second club" — directly contradicted the new policy from item 2 above; corrected in both files, plus the Phase 3d route-guard description and Security Threat Review section in ARCHITECTURE.md
6. Risk Register updated: "Trial abuse via many fake clubs from one user" moved from P2 Open to **Mitigated** (residual risk: new-account creation remains possible, explicitly accepted as out of V1 scope); "Recurring booking invoice granularity" moved from P3 Open to **Resolved**
7. Remaining Open Decisions: **NONE**

## Next Task

Awaiting explicit go-ahead to begin Phase 0 (repo scaffolding: Vite+React+TS+Tailwind+shadcn, Supabase CLI local init). Per standing instruction, Phase 0 does not start automatically after this correction pass, even though its readiness status is READY.
