# Decisions

Architecture Decision Records for Mala3by. Each entry: Decision, Reason, Alternatives considered, Trade-offs accepted. Newest first.

> **2026-09-04 (Sales Intelligence) — ADR-054 added.** A new Platform Owner bounded context for lead discovery, enrichment, scoring, CRM, AI offer generation, and governed tenant conversion. Entirely additive — no existing domain, table, RLS policy, or RPC is modified by this ADR; it establishes the isolation and reuse boundaries the new module must respect.

## ADR-054 — Sales Intelligence is a platform-owned bounded context, isolated from and never routed through club/tenant authorization

**Decision:** All Sales Intelligence data (`sales_*` tables) is platform-scoped, never tenant-scoped — no `club_id` foreign key exists anywhere in this domain except the one nullable `converted_club_id` link created only at the moment of conversion. Every table uses `FORCE ROW LEVEL SECURITY` with policies gated exclusively on `is_platform_owner()` or `has_platform_permission('platform.sales.<action>')` — the platform authorization domain established by ADR (platform_roles/platform_permissions, 2026-08-26), never the club-scoped `has_permission()`. New permission keys follow the existing `platform.<group>.<action>` convention with `group_key = 'sales'` (e.g. `platform.sales.discover`, `platform.sales.convert_to_tenant`) — not a bare `sales.*` prefix, which would not match how every other platform permission is grouped/rendered in the existing Platform Roles UI.

Routing: new pages live under `/platform/sales/*` (Dashboard, Discover, Leads, Pipeline, Campaigns, Follow-ups, Settings), registered in the existing `PlatformLayout` nav alongside other Platform Owner sections. The existing `/platform/leads` route (`PlatformLeadsPage.tsx`) is a pre-existing, unrelated inbound marketing "Contact Us" inbox over `contact_requests` — it is not touched, renamed, or merged. The naming is coincidental (both use the word "leads") but the domains are unrelated: `contact_requests` is inbound, org-initiated-by-visitor; Sales Intelligence leads are outbound, org-discovers-and-pursues. A future consideration (not part of this ADR) might rename `/platform/leads` to `/platform/contact-requests` for clarity — deferred as out of scope here.

Discovery/enrichment jobs mirror the existing `notification_queue` shape (status enum, `attempts`, `next_attempt_at`, `FOR UPDATE SKIP LOCKED` claim pattern from `whatsapp_connector_claim_next_batch()`) rather than inventing a new job-processing primitive.

Tenant conversion (Phase 14) calls the existing `complete_new_club_onboarding()` RPC unmodified — Sales Intelligence never duplicates onboarding logic, never writes `clubs`/`branches`/`club_memberships` directly, and never sets `is_test_fixture` (which the onboarding RPC never touches either — it defaults `false` and stays that way for a real converted tenant).

AI offer generation and website enrichment are new external-call surfaces with no precedent in this codebase (confirmed: zero existing AI/LLM integration). Both are built as an Edge Function following the exact pattern already established for payment gateway calls (`get_vault_secret_service()` for secrets, never raw vault access; `AbortSignal.timeout()`; sanitized error responses; dual-client split between caller-scoped auth and service-role execution) rather than inventing a new external-integration convention. If the required provider credential (Google Places API, an LLM API) is not configured, the integration is exposed as `CONFIGURATION_BLOCKED` in the UI and job records — the adapter boundary, mocks, and every non-blocked workflow (discovery via manual entry, scoring, CRM, campaigns, conversion) still function.

**Reason:** Sales Intelligence is inherently platform-operator tooling — it must never be reachable by a club owner, staff member, or customer, under any circumstance, including a bug in a future migration. Routing exclusively through the already-separate platform authorization domain (rather than reusing or bridging to `has_permission()`) makes that isolation structural rather than convention-dependent, matching the same reasoning that originally separated platform roles from club roles. Reusing `complete_new_club_onboarding()` for conversion avoids the exact "parallel implementation of the same invariant" defect class the prior production remediation found and fixed repeatedly (module gates, branch scope, subscription checks all duplicated per-RPC instead of shared) — onboarding correctness must have exactly one implementation, and Sales Intelligence must never become a second one.

**Alternatives considered:** Giving Sales Intelligence its own bespoke role/permission table (rejected — the master directive explicitly forbids inventing a parallel authorization system, and platform_roles/platform_permissions already exist and are extensible). Writing a lighter, sales-specific "quick onboarding" RPC instead of the full `complete_new_club_onboarding()` (rejected — this is exactly the duplication this ADR exists to prevent; any operational rule the real onboarding path enforces — trial entitlement limits, module activation defaults, audit logging — must apply identically to a converted lead). Building AI/enrichment calls directly from the frontend (rejected — would require exposing provider API keys client-side; the existing Edge Function + vault pattern is the established, correct place for any external-API-key-bearing call in this codebase).

**Trade-offs:** The `/platform/leads` naming collision is left unresolved by this ADR (documented, not fixed) — a minor but real UX ambiguity for a platform owner navigating by URL memory. Building a new job-processing table family (discovery jobs, enrichment jobs) rather than generalizing `notification_queue` into a shared job engine is more schema surface, but avoids retrofitting a notification-specific table (with WhatsApp/email-specific columns) into an unrelated domain — accepted as the lower-risk choice given `notification_queue`'s existing hardening history (rate limits, circuit breakers, dedup keys tuned specifically for outbound messaging) that Sales Intelligence jobs don't need and shouldn't inherit.

> **2026-08-31 (auth architecture reconciliation) — ADR-053 added.** The implemented customer authentication was found to be password-based (matching every other persona), which had silently drifted from the actually-approved product policy. ADR-053 reconciles this: customer-facing portal login is now genuinely Email OTP via Supabase Auth, while staff/tenant-owner/platform-staff/platform-owner all correctly remain password-based, unchanged. See [ARCHITECTURE.md's Persona Authentication Matrix](ARCHITECTURE.md#persona-authentication-matrix) for the full per-persona breakdown, so this cannot drift again without an explicit, visible documentation update.

## ADR-053 — Customer authentication is Email OTP; staff/owner/platform remain password

**Decision:** The customer-facing Portal (`/portal`) now authenticates exclusively via Supabase Auth's native Email OTP (`signInWithOtp`/`verifyOtp`), on a dedicated `/portal/login` route (`PortalLoginPage.tsx`) — genuinely separate from the shared `/login` page (`LoginPage.tsx`), which remains completely unmodified and password-based for every other persona (staff, tenant owner, platform staff, platform owner). Phone remains corroboration/operational data only — never a login credential, never OTP-delivered — matching the already-hardened `claim_customer_self_service()` phone-corroboration check. No SMS OTP, no WhatsApp OTP, no new paid auth provider was introduced. `signInWithOtp`'s `shouldCreateUser: true` (Supabase's own default) means the same flow correctly handles both a brand-new customer (creates the bare `auth.users` identity, same 1:1 `profiles` trigger as any other signup path) and an existing, already-password-authenticated customer (Supabase Auth resolves by email uniqueness in `auth.users` — the SAME row and the SAME `email`-provider `auth.identities` row is reused, verified by inspecting a real existing password customer's `auth.identities` row before this change shipped; verifying via OTP never creates a second/duplicate identity). A customer who already has a password set can still use it if they navigate to the shared `/login` page directly (that page is untouched, still fully functional for anyone with a password) — but the customer-facing UI now only ever surfaces the OTP flow as the primary path.

**Reason:** This corrects a genuine architecture-vs-documentation drift discovered during a broader auth production-acceptance pass: `docs/ARCHITECTURE.md` had said "email/password for V1" with no persona-specific carve-out, but the actually-approved product policy for the customer persona specifically was always Email OTP (phone stays corroboration-only, matching the anti-fraud posture the hardened claim flow already enforces). Splitting the entry point (a new page) rather than adding persona-detection branching logic to the existing shared `LoginPage.tsx` was the deliberate minimal-blast-radius choice — it makes the change impossible to accidentally regress staff/owner/platform-owner login, since that file has zero lines touched by this ADR.

**Alternatives considered:** Branching logic inside the existing `LoginPage.tsx` to detect "does this email belong to a customer-only identity" and switch to OTP inline (rejected — meaningfully more complex, and any bug in that detection risks the shared login page every other persona depends on, for zero benefit over a dedicated route). Migrating every persona to OTP for consistency (rejected — explicitly out of scope; staff/tenant-owner/platform accounts are professionally managed, already have a working hardened password+reset flow with no reported friction, and forcing an OTP migration onto them serves no real problem). Adding phone OTP as an alternative/additional customer login method (rejected — explicitly against the approved policy; phone remains corroboration-only everywhere in this codebase).

**Trade-offs:** A customer must have working access to their email inbox for every login, not just account recovery — accepted, since this is the whole point of OTP-based auth and email was already the customer's account identifier either way. `signInWithOtp`'s own send-rate limiting (Supabase project-level, confirmed live and reachable during this ADR's own verification) means a customer who requests many codes in quick succession will be temporarily rate-limited — mapped to a specific, helpful (not raw) error message rather than the fully generic fallback.

---

> **2026-08-15 (final two decisions) — Final Two Decisions Closure applied.** ADR-051 (Automatic Trial Entitlement) and ADR-052 (Recurring Booking Billing Granularity) close the last two open decisions before Phase 0. Neither reopens prior architecture — ADR-051 adds a concurrency-safe entitlement guard on top of the existing one-trial-per-club rule; ADR-052 confirms, rather than changes, the already-implied per-occurrence financial independence of recurring bookings.
>
> **2026-08-15 (final pre-implementation) — Final Pre-Implementation Directive applied.** ADR-047 through ADR-050 add the last operational necessities (Recurring Booking, Outstanding Payments view, Quick Field Block) and formalize security/design as first-class, always-applied concerns rather than late-phase hardening — see the new [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md) and [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md). No prior decision is reopened; this pass is additive and clarifying only.
>
> **2026-08-15 (public site) — Public Website + Signup + Free Trial added.** ADR-036 through ADR-046 introduce the public marketing site, self-service signup, first-time onboarding, and a 7-day free trial. The trial is **not** a new concept or table — it is `platform_subscriptions.subscription_kind = 'trial'`, a value on the exact same period-based subscription model built in the prior corrections pass. This is the key design decision: everything already built (snapshots, exclusion constraint, renewal chain, `get_club_platform_access()`) applies to trials for free, because a trial is just a subscription period like any other, distinguished only by `subscription_kind` and how it started.
>
> **2026-08-15 (final) — Final Platform SaaS Corrections applied.** The first Platform Billing pass (originally ADR-022 through ADR-026) is fully replaced by ADR-027 through ADR-035 below — the original entries' text has been superseded in place, not preserved as separate historical records, since the correction is a structural redesign of the same domain rather than an addable refinement. The core fix: `grace_period` was wrongly modeled as a `clubs.status` value — it is a **subscription** status, not a **club** status, and the two are now fully independent. Subscriptions are now period-based (one row per billing cycle, not one row mutated forever), with price/plan snapshots, real billing intervals (monthly/quarterly/semi-annual/annual), and a single centralized access-derivation function.
>
> **2026-08-15 — Mandatory Architecture Corrections applied.** ADR-011 through ADR-021 below were added in a dedicated correction pass before any production code was written. ADR-006 (organizations) is **superseded** by ADR-011 — its original nullable-placeholder approach was rejected in favor of full removal. See each entry for details.

---

## ADR-052 — Recurring booking billing granularity: one financial lifecycle per occurrence, no series-level invoice in V1

**Decision:** Every occurrence created by a recurring booking is financially and operationally independent. An 8-week series produces 8 real `bookings` rows, and each one independently: gets its own invoice (issued according to the normal booking billing flow, not automatically at series-creation time), can be paid, cancelled, marked no-show, refunded, or rescheduled without touching any other occurrence. **No `series_invoice`/`booking_series_invoice`/bundle-invoice concept exists in V1** — series-level invoicing is explicitly deferred until a real operational need appears. Cancelling one occurrence never cascades to the rest of the series unless the user explicitly chooses a "cancel future occurrences" action (if that UX exists) — a single "cancel this occurrence" action affects only that one booking. If a customer pays in advance for multiple occurrences, this is handled entirely by machinery that already exists: one `payments` row, multiple `payment_allocations` rows (one per invoice being funded) — `payment_allocations` remains the sole payment↔invoice relationship, and `payments.invoice_id` is not reintroduced.

**Reason:** This confirms, rather than introduces, the design already implied by [ADR-047](#adr-047--recurring-booking-is-a-linking-table-over-real-individual-booking-rows-never-a-shortcut-around-conflict-checking) (recurring booking is N real rows, `booking_series` is bookkeeping-only, never a financial source of truth) — that ADR left the exact invoice granularity as an open implementation detail, and this closes it explicitly so it isn't decided ad hoc during implementation. Per-occurrence independence is the only granularity consistent with everything already built: the exclusion constraint, cancellation flow, refund flow, and no-show flow all operate on individual `bookings` rows, and a series-level invoice would require either duplicating all of that logic at the series level or building a translation layer between series-level and booking-level state — real added complexity with no current business requirement driving it. The existing `payment_allocations` many-to-many model already handles "one payment covers several things" without any new schema.

**Alternatives considered:** A single invoice per series, generated at series-creation time (rejected — forces creating N invoices' worth of financial commitment before any occurrence has actually happened, and doesn't compose with per-occurrence cancellation/no-show/refund, which must remain possible). Auto-generating all N invoices immediately on series creation, even if kept per-occurrence (rejected — explicitly instructed against; invoices are issued through the normal billing flow as each booking is actually processed, not pre-generated in bulk as a side effect of creating the series).

**Trade-offs:** A customer who wants to see "my total commitment across this series" needs a view that sums across `booking_series_id`-linked bookings/invoices rather than reading one row — acceptable, since `booking_series` already exists specifically to support that kind of grouped query, it's just never the financial source of truth itself.

---

## ADR-051 — Automatic trial entitlement is one per user account, enforced via a dedicated concurrency-safe entitlement table

**Decision:** Two independent rules now govern trial creation, both enforced at the database level:
1. **One trial per club, ever** — already enforced by the existing unique partial index on `platform_subscriptions` (see [ADR-039](#adr-039--trial-belongs-to-the-club-not-the-user-one-trial-per-club-ever)), unchanged.
2. **One *automatic* trial per user account, ever** — enforced by a new table, `automatic_trial_entitlements` (`user_id` unique, `club_id`, `consumed_at`), consumed inside the exact same transaction as `complete_new_club_onboarding()`.

A user is never blocked from creating additional clubs — `clubs` carries no `UNIQUE(owner)`-style constraint, and club creation itself is never gated by trial eligibility. What's gated is only whether that *specific* onboarding call also creates a trial `platform_subscriptions` row. Inside `complete_new_club_onboarding()`, after creating `clubs`/`branches`/`club_memberships` (always, unconditionally, per the existing atomicity guarantee), the function attempts `INSERT INTO automatic_trial_entitlements (user_id, club_id, consumed_at) VALUES (auth.uid(), v_club_id, now())`. If this insert succeeds (no prior entitlement row for this `user_id`), a trial `platform_subscriptions` row is created as before. If it fails on the `user_id` unique constraint (the user already consumed their one automatic trial on an earlier club), **the onboarding transaction still commits** — club, branch, and owner membership are created successfully — but no trial row is created, and the RPC returns an explicit outcome flag (`trial_granted: false`) rather than throwing an error, so the frontend can show "Club Created — Subscription Required" instead of "Trial Activated." A club created this way has `get_club_platform_access()` return `blocked` until Platform Owner activates a subscription (manual trial, complimentary, or paid).

`automatic_trial_entitlements` additionally snapshots `owner_normalized_mobile` and `owner_email` at consumption time (not hard-unique — normalized-mobile/email sharing is still legitimate per [ADR-012](#adr-012--phone-numbers-are-normalized-mobile-is-not-a-hard-unique-constraint)) purely for basic abuse review by Platform Owner, never as a blocking constraint.

Platform Owner retains a separate, always-available path to grant a **manual** trial or **complimentary** access to any club (including a club that already has an `automatic_trial_entitlements` row consumed by its creating user, since that constraint only ever blocked the *automatic* path) — this creates a `platform_subscriptions` row with `subscription_kind = 'trial'` (manual) or `'complimentary'` exactly as already supported, distinguished from an automatic trial only by which code path created it and who acted, and is always logged to `audit_logs` with actor/club/reason/`start_at`/`end_at`/`subscription_kind` — never silent.

**Reason:** The brief is explicit that "one trial per club" alone is insufficient — without a per-user limit, a single person can trivially harvest unlimited free trials by creating unlimited clubs, since nothing about the club-level uniqueness constraint touches who's creating it. A dedicated small entitlement table is the simplest concurrency-safe way to add this second, independent axis of uniqueness without inferring eligibility from `platform_subscriptions` (which has no natural `user_id` column to key off — a subscription belongs to a club, not a user — and inferring "has this user already had a trial" by joining through `club_memberships` → `platform_subscriptions` would be neither simple nor safe under concurrent onboarding attempts). This follows [PROJECT_RULES.md](PROJECT_RULES.md) rule 6's "keep it simple" instinct: a one-column-unique table is less machinery than trying to make an existing table answer a question it wasn't shaped to answer.

**Concurrency safety:** two simultaneous `complete_new_club_onboarding()` calls from the same brand-new user (e.g. a double-click creating two different clubs) cannot both succeed at granting a trial — the second call's `INSERT INTO automatic_trial_entitlements` fails on the `user_id` unique constraint regardless of timing, because Postgres's unique constraint enforcement is itself the concurrency guard; no `SELECT`-then-`INSERT` race window exists because there is no separate `SELECT` — the `INSERT` either succeeds or fails atomically. This is deliberately simpler than an advisory lock or a `SELECT ... FOR UPDATE` pattern, because a unique constraint on a single-purpose table *is* the simplest correct primitive for "has this happened before, exactly once" — no lock scope to reason about, no held-lock duration to worry about, just an insert that either lands or doesn't.

**Alternatives considered:** Inferring eligibility by querying `platform_subscriptions` joined through the user's `club_memberships` (rejected — no direct `user_id` relationship on `platform_subscriptions`, and reconstructing "has this user ever triggered an automatic trial" from that join is both more complex and not naturally concurrency-safe without additional locking). `SELECT COUNT(*) ... THEN INSERT IF NOT EXISTS` (rejected — the classic TOCTOU race the project has rejected everywhere else, e.g. booking/enrollment; a real risk under concurrent onboarding attempts). Device fingerprinting, CAPTCHA, SMS OTP, IP reputation, or an external fraud service (rejected — explicitly out of scope, disproportionate to V1's actual risk level, and against the zero-cost-first rule).

**Trade-offs:** A determined abuser can still get unlimited trials by creating new user accounts (new email + new auth identity) — explicitly accepted as out of scope for V1, since defending against that requires the device/phone/CAPTCHA-level tooling this ADR explicitly declines to add. This is a known, bounded residual risk, not an unaddressed one.

---

## ADR-050 — Security and Design are built with each domain, not deferred to a late hardening/polish phase

**Decision:** RLS, permission checks, database constraints, secure RPCs, and audit requirements are built **as part of** each domain's phase (e.g. `bookings`' exclusion constraint and RLS ship in the Booking Engine phase, not retrofitted in a later "security hardening" phase). Similarly, the Design System (see [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)) is established in Phase 1, before any real screen is built, not polished-in after screens already exist. A dedicated hardening/QA phase still exists late in the plan (Phase 14 for security, Phase 15 for responsive/print QA) — but its job is an *independent verification pass* and fine polish, not the first time these concerns are addressed.

**Reason:** Security and visual consistency retrofitted after the fact are both expensive and unreliable — a booking system built without RLS from day one, then "secured later," risks shipping real functionality on an insecure foundation in the interim and requires re-auditing everything rather than building it right once. The same logic applies to design: screens built without a design system, then "made consistent later," produce visible seams and rework. This restates and makes explicit a principle that was already implicit in every phase's structure throughout this plan (every phase already includes RLS/security/test work, not just feature work) — this ADR exists so the principle is never accidentally violated as new phases get added.

**Alternatives considered:** A single late "Security Hardening" phase doing all RLS/permission/audit work at once (rejected — this is explicitly the anti-pattern being guarded against; also already rejected implicitly by the phase structure in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), which has always embedded RLS/tests in every phase). A late "Visual Polish" phase doing all design work at once (rejected — same reasoning, and screens without a shared design system from the start produce real rework, not just missed polish).

**Trade-offs:** None — this codifies what the phase plan already does; it does not add scope, it prevents scope from silently drifting toward the anti-pattern in future phases.

---

## ADR-049 — Quick Field Block requires explicit confirmation when existing bookings conflict

**Decision:** From the Booking Calendar, a "Block Field" quick action (Start, End, Reason, Type — `maintenance`/`weather`/`private_event`/`manual`) inserts a `field_blocks` row, which prevents new bookings in that window. If the requested block window overlaps one or more existing (non-cancelled) bookings, the system **never silently cancels them** — it surfaces "3 existing bookings conflict" (with the specific bookings listed) and requires the manager to make an explicit decision (e.g. cancel the conflicting bookings individually with the normal cancellation flow, or adjust the block window) before the block is created.

**Reason:** Silently invalidating a customer's paid booking because a manager wanted to block the field for maintenance is a serious operational and trust failure — a customer could show up to a booking that was cancelled without anyone telling them. Requiring an explicit decision when a conflict exists costs the manager one extra confirmation step in the (presumably rare) case of an actual conflict, in exchange for eliminating a real risk of silently breaking a paying customer's booking.

**Alternatives considered:** Silently cancel conflicting bookings when a block is created (rejected — the failure mode described above). Simply disallow blocking any window with existing bookings (rejected — too rigid; sometimes a field genuinely needs to close and existing bookings must be moved/cancelled, the system just shouldn't do that invisibly).

**Trade-offs:** None significant — the confirmation step only appears when a real conflict exists, which should be the uncommon case for a block created with reasonable notice.

---

## ADR-048 — Outstanding Payments is a single ledger-derived view, not a new stored value

**Decision:** `/app/outstanding` (or an equivalent location within Billing) surfaces customers/invoices with `outstanding = invoice.total − valid payment_allocations + refund/reversal effect` — computed live from the existing financial ledger (`invoices`, `payment_allocations`, `refunds`), exactly the same derivation already used everywhere else outstanding balance is shown (booking detail, subscription detail, reports). No new stored "outstanding" column is introduced anywhere.

**Reason:** This restates [PROJECT_RULES.md](PROJECT_RULES.md) rule 8 (derived financial values are never stored as fact) applied to a new screen — introducing a second, screen-specific computation or stored value for the same concept "outstanding balance" that already has a canonical definition would create exactly the risk that rule exists to prevent: two numbers, in two places, that can silently disagree. The screen is a new *view* over existing data, not a new financial concept.

**Alternatives considered:** A materialized/cached `outstanding_balance` column updated by triggers (rejected — same reasoning as every other financial-value derivation decision in this project: a cache that can drift from the ledger is a bug waiting to happen, and V1's data volume doesn't need the query-performance trade-off a cache would buy).

**Trade-offs:** None — this is a read-only reporting screen with no new write path, following the exact same pattern already established for every other financial figure in the product.

---

## ADR-047 — Recurring Booking is a linking table over real individual booking rows, never a shortcut around conflict-checking

**Decision:** A "recurring booking" (e.g. every Tuesday 20:00–21:00 for 8 weeks) is created via an optional `booking_series` table (linking rows for grouping/management purposes only) plus **N real individual `bookings` rows**, one per occurrence — each subject to the exact same pricing, exclusion constraint, permission checks, and audit trail as a manually-created single booking. The series itself is never permitted to bypass the exclusion constraint — there is no "series-level" override of conflict checking.

**Before confirming**, the system checks all N requested occurrences against existing bookings/blocks and shows the result explicitly (e.g. "8 requested, 7 available, 1 conflict") — it never silently creates a partial series. The user chooses explicitly between creating only the available occurrences or cancelling to review conflicts first; either way, the outcome is shown, not assumed.

**Reason:** A recurring booking is fundamentally N bookings that happen to share an origin — modeling it as anything other than N real rows (e.g. a single "recurring booking" row with a pattern description that the system expands lazily) would mean every downstream piece of functionality that already works on `bookings` (the calendar, the exclusion constraint, invoicing, cancellation, audit, reports) would need a parallel implementation aware of recurrence. Real individual rows mean recurring bookings get all of that for free, and the `booking_series` link is purely optional bookkeeping for "show me/cancel the rest of this series" UX, never a data-integrity load-bearing structure.

**Alternatives considered:** A single row representing the whole series with a recurrence pattern, expanded virtually at read time (rejected — this is the parallel-implementation problem described above: pricing, conflict-checking, invoicing, and audit would all need recurrence-aware logic instead of reusing what already exists for a single booking). Silently creating only the available occurrences without surfacing the conflict count (rejected — a user must know they got 7 of 8 requested slots, not discover it later).

**Trade-offs:** N inserts instead of one for a recurring series — irrelevant at this data scale, and it's the correct trade for reusing all existing booking infrastructure unchanged.

---

## ADR-046 — Signup rate limiting and duplicate-club flagging are lightweight, not blocking

**Decision:** Basic trial-abuse protections only, all free-tier: Supabase Auth's built-in email verification (if usable without a paid email provider — see ADR-041), normalized-phone/email duplicate *detection* (flag, don't hard-block — see ADR-045), and simple rate limiting on the signup RPC (e.g. N signups per IP per hour, enforced at the RPC/DB level, no external service). No CAPTCHA service, no device fingerprinting, no manual approval queue in V1.

**Reason:** A real fraud-prevention system is disproportionate scope for a product with no paying customers yet and no evidence of abuse. The brief explicitly asks for "basic protection," not a fraud engine, and explicitly defers phone verification/device fingerprinting/manual approval to when they're actually needed. Cloudflare Turnstile is noted as a possible free future addition, not a V1 requirement.

**Alternatives considered:** Full KYC-style verification before trial start (rejected — kills self-service conversion, the whole point of a public trial signup). No protection at all (rejected — leaves an obvious mass-fake-account vector with zero cost to the attacker).

**Trade-offs:** Some fake trials will get through in V1 — acceptable, since they cost nothing (no payment involved) and are visible/prunable by Platform Owner via the Trials report (see ADR-044).

---

## ADR-045 — Duplicate club detection flags for review, never hard-blocks signup

**Decision:** Before finalizing onboarding, a lightweight check compares normalized club name, normalized owner phone, and owner email against existing clubs. A match sets a `flagged_duplicate` marker (visible to Platform Owner in the Clubs list) but **never** prevents the signup from completing.

**Reason:** Same reasoning already established for `customers.normalized_mobile` (see ADR-012) — name/phone similarity has too many legitimate false-positive cases (a franchise's second branch signing up separately, a common club name, a family member registering a related-but-distinct club) to justify blocking a real customer's self-service signup. Flagging for Platform Owner review captures the suspicious case without costing a legitimate signup its trial.

**Alternatives considered:** Hard block on exact match (rejected — blocks legitimate re-registration after a mistake, or a genuinely separate club with a common name). No detection at all (rejected — leaves an easy trial-abuse path: repeatedly signing up under trivially varied details).

**Trade-offs:** Requires Platform Owner to occasionally review flagged signups — acceptable at V1 volume, and this is exactly what the Contact Requests / Trials sections of the Platform Owner console already require reviewing anyway.

---

## ADR-044 — Platform Owner reports gain trial-specific metrics; public leads get their own report

**Decision:** The Platform Reports set (Subscription/Revenue/Renewal/Growth/Usage, from ADR-034's Control Center) gains trial-specific figures woven into Growth and a new lightweight view: Trials Started, Trials Active, Trials Expired, Trials Converted to Paid, Trial Conversion Rate. `contact_requests` gets its own simple status pipeline (`new`/`contacted`/`converted`/`closed`) surfaced as a Leads view under Platform Reports, not a separate CRM module.

**Reason:** Trial conversion rate is the single most important business metric for a self-service-trial SaaS product — Platform Owner needs it without building a BI tool. Contact requests are a legitimate second lead-generation channel (a prospect who wants to talk before self-serving) and deserve visibility, but a full CRM (pipelines, follow-up scheduling, assignment) is explicitly out of scope — see [PROJECT_BRIEF](../README.md) Section 56's "no CRM Marketing Engine in V1" and Section 51 of this brief, "no full CRM."

**Alternatives considered:** No trial/lead reporting in V1 (rejected — Platform Owner explicitly needs this to run the business, it's cheap to add since the underlying data already exists from Phase 3b/3c). Full CRM (rejected — explicitly out of scope, same reasoning as the original brief's CRM deferral).

**Trade-offs:** None significant — this is read-only reporting over data that already exists.

---

## ADR-043 — First-run setup is a checklist, not a multi-step wizard

**Decision:** After the 4-step onboarding wizard (business type → basic details → first branch → trial activation) completes and creates the club, subsequent setup (add a field, add a staff member, add a first customer, create a first booking) is presented as a dismissible checklist inside the app dashboard, not a continuation of the wizard.

**Reason:** A long linear wizard forces a rigid order and blocks a club owner from exploring the product; a checklist lets them do these steps in whatever order makes sense for their business, or skip some entirely (a club with no staff yet doesn't need to be forced through "add a staff member" before seeing their booking calendar). This matches the brief's own explicit preference (Section 46: "this is better than a long Wizard").

**Alternatives considered:** Continue the wizard through all setup steps (rejected — the brief explicitly prefers a checklist, and forcing order here has no correctness benefit unlike, say, forcing club-before-branch in the *required* onboarding steps).

**Trade-offs:** None — this is strictly more flexible for the user with no loss of correctness, since the checklist items are all genuinely optional/reorderable unlike the mandatory onboarding steps.

---

## ADR-042 — Onboarding finalization is one atomic RPC; client never sets privileged values

**Decision:** `complete_new_club_onboarding(p_full_name, p_mobile, p_business_type, p_club_name, p_branch_name, p_city, ...)` is a single `SECURITY DEFINER` RPC that, in one transaction: creates the `clubs` row, creates the first `branches` row, creates a `club_memberships` row with `role_id` hardcoded to the `club_owner` role (never accepted as a parameter), and creates the trial `platform_subscriptions` row with `subscription_kind` hardcoded to `'trial'` and duration read from `platform_settings.default_trial_days` (never accepted as a parameter). If any step fails, the whole transaction rolls back — never a state with a club but no membership, or a membership but no trial.

**Reason:** This is the same atomicity discipline already applied to booking creation (ADR-007) and refunds (ADR-011c), extended to onboarding — a multi-table operation that must succeed completely or not at all. The "client never sets privileged values" rule is critical specifically here because this RPC is reachable by an anonymous/newly-authenticated user with no existing permissions to check against — unlike every other privileged RPC in this system, there's no existing `club_memberships` row yet to validate the caller against. The RPC itself is the entire trust boundary: it must derive `role = club_owner`, `subscription_kind = trial`, and `trial_days = platform_settings.default_trial_days` internally, never from client input, or a malicious signup payload could grant itself `platform_owner`, a `paid` subscription, or a 365-day trial.

**Alternatives considered:** Separate client-driven inserts for club/branch/membership/subscription (rejected — exactly the partial-failure risk described above, and each individual insert would need its own privilege-escalation defense instead of one RPC bearing that responsibility once).

**Trade-offs:** None — this is strictly safer than the alternative with no functional cost.

---

## ADR-041 — Email verification uses Supabase Auth's built-in flow; no paid email provider dependency

**Decision:** If Supabase's free-tier email delivery (via its built-in Auth email templates) is sufficient to send verification/password-reset emails without a paid provider, use it. If Supabase free-tier email sending proves unreliable or rate-limited in practice, **email verification is not a hard gate on trial start** — a new club can begin its trial immediately upon signup, with verification treated as a soft prompt rather than a blocker. Password reset always uses Supabase Auth's built-in flow — no custom reset system is ever built (see [PROJECT_BRIEF](../README.md) Section 18: use Supabase Auth, don't build custom).

**Reason:** The brief is explicit: don't let V1 depend on a paid email provider, and don't build a custom password-reset system. Supabase's free tier includes basic transactional auth email, which is likely sufficient for V1's volume (one pilot club growing slowly) — but making verification a hard blocker on trial start risks losing a legitimate signup to an email delivery hiccup outside our control, which is a worse outcome than occasionally allowing an unverified email to start a free trial (a trial has no financial exposure — see ADR-036).

**Alternatives considered:** Hard-block trial start until email verified (rejected — couples trial activation, a core conversion moment, to email deliverability, an external dependency with failure modes outside V1's control). Add a paid transactional email provider now (rejected — explicitly against the zero-cost-first rule with no current justification).

**Trade-offs:** An unverified email can start a trial. Acceptable given a trial carries no payment obligation and is visible/monitorable by Platform Owner regardless.

---

## ADR-040 — Public plan data is exposed through a restricted view/RPC, never the raw `platform_plans` table

**Decision:** `platform_plans` gains `is_public boolean` (default `false`) and `display_order int`. Anonymous/public read access is granted only to a view (e.g. `public_plans`) selecting a fixed, safe column set (`name_ar`, `description_ar`, `billing_interval`, `billing_interval_count`, `price`, `currency`, `discount_label`, `features_summary`) filtered to `is_public = true`, ordered by `display_order`. The base `platform_plans` table itself remains Platform-Owner-only — no anonymous or authenticated-non-platform-owner role ever queries it directly.

**Reason:** `platform_plans` may eventually carry internal fields (cost basis, internal notes, unpublished draft plans) that must never be exposed publicly. A view with an explicit, narrow column allowlist is the same defense-in-depth pattern already used for `players.medical_notes` (ADR-019) and the Club Owner subscription summary (ADR-035) — expose only what's safe, through a boundary that can't accidentally leak a new sensitive column added to the base table later.

**Alternatives considered:** RLS policy on `platform_plans` directly allowing anonymous `SELECT` filtered to `is_public = true` (rejected — still exposes every column on that table to anonymous users for any published row, including columns not yet designed but added later without remembering to re-audit public exposure; a view's column list is an explicit, reviewable allowlist).

**Trade-offs:** One additional view to keep in sync if `platform_plans`' public-safe column set changes — minor, and worth the safety margin.

---

## ADR-039 — Trial belongs to the club, not the user; one trial per club, ever

**Decision:** A trial subscription period is tied to `platform_subscriptions.club_id`, exactly like any paid period. Adding a second user to a club that already has (or has ever had) a trial does not grant a new trial. The onboarding RPC creates a trial only as part of creating a *new* club — there is no path to create a second trial for an existing club.

**Reason:** The brief is explicit and this matches the natural shape of the existing model: a trial is a `platform_subscriptions` row like any other, and that table's exclusion constraint already prevents a club from having two overlapping periods — extending "trial" to be per-user instead of per-club would require an entirely parallel structure for no benefit, and would trivially allow trial-abuse by adding new user accounts to bypass a one-trial-per-club limit.

**Alternatives considered:** Trial per user account (rejected — explicitly wrong per the brief, and it's also just a worse design: it decouples the trial from the entity actually using the product, the club).

**Trade-offs:** None — this falls out for free from the existing period-based subscription model; no new enforcement code beyond checking "does this club already have any non-cancelled `platform_subscriptions` row" before allowing onboarding to create a trial.

---

## ADR-038 — Trial is a `subscription_kind`, not a new concept; trial expiry defaults to `blocked`, not automatic conversion

**Decision:** `platform_subscriptions` gains `subscription_kind` (`trial` | `paid` | `complimentary`, see ADR-054 in the original numbered brief — folded in here). A signup creates a `platform_subscriptions` row exactly like a renewal or a Platform-Owner-initiated activation would, with `subscription_kind = 'trial'`, `start_at = now()`, `end_at = now() + platform_settings.default_trial_days` (see ADR-037), and `grace_period_days_snapshot` — **trials get their own grace policy, which the brief sets to 0 by default** (trial expiry goes straight to `blocked`, not through a grace window, since "grace" exists to protect a paying customer's operational continuity during a billing hiccup — a concept that doesn't apply to an never-yet-paying trial). `get_club_platform_access()` (from ADR-033) needs no new logic — a trial period is just a period, and the same `full`/`grace`/`blocked` derivation already applies, with `grace = 0 days` for `subscription_kind = 'trial'` simply collapsing the `grace` window to zero width. Trial does **not** auto-convert to paid at expiry — expiry moves access to `blocked` (per ADR-033's existing derivation) until Platform Owner (or, later, an actual payment flow) creates the next period.

**Reason:** This is the central design insight of this addition: because the platform subscription model from the prior corrections pass is already period-based with snapshots and a derived-access function, "trial" requires **zero new architecture** — it's a value in an already-existing enum plus a zero-length grace window, not a new table, new state machine, or new access-derivation logic. This is exactly the kind of reuse the project's own rules reward (see [PROJECT_RULES.md](PROJECT_RULES.md) rule 6, no premature abstraction — the inverse insight applies here too: no premature *new* structure when the existing one already fits).

**Alternatives considered:** A separate `trials` table (rejected — the brief itself says "do not create a separate trial table if trial itself is a subscription period," and a separate table would need its own overlap-prevention, its own history-linking, its own access-derivation branch — pure duplication of what `platform_subscriptions` already does). Auto-converting trial to a paid subscription at expiry (rejected — there is no online payment gateway in V1, so there is nothing for it to auto-convert *into*; a club must be manually activated onto a paid plan by Platform Owner, exactly like any other activation).

**Trade-offs:** `get_club_platform_access()`'s grace-window calculation needs to read `grace_period_days_snapshot` (which is `0` for trials by convention) rather than assuming a nonzero grace always applies — already true of the existing derivation, just confirming trials naturally produce a zero-width grace window rather than needing a special case.

---

## ADR-037 — Trial length is a platform setting, not hardcoded

**Decision:** New table `platform_settings` (singleton — one row, or a simple key-value table) holds `default_trial_days` (default `7`). Every place that would otherwise hardcode "7 days" — the onboarding RPC, the marketing copy's "7 days free" claim, the trial reminder thresholds — reads this value at the point of use rather than embedding the literal `7`.

**Reason:** The number 7 appears in at least three independent places in this brief (RPC logic, landing page copy, in-app messaging) — hardcoding it in each means a future change to trial length requires finding and updating every occurrence, with real risk of missing one and shipping inconsistent messaging (marketing says "7 days," the RPC grants 10). One setting, read everywhere, eliminates that class of bug entirely. This is the same "single source of truth" principle already applied to pricing (ADR-030's snapshot-from-plan pattern) and financial figures (rule 8's "dashboards and reports share one RPC/view definition").

**Alternatives considered:** Hardcode `7` in the RPC and separately hardcode `7` in marketing copy with a manual "keep these in sync" discipline (rejected — exactly the fragile-consistency risk described above, easily avoided).

**Trade-offs:** Marketing copy (e.g. static landing page text) still needs to *read* this value somehow if it's server-rendered or fetched at build/runtime rather than hand-typed — handled by exposing `default_trial_days` through the same public-safe RPC/view used for plan data (see ADR-040), not by a separate mechanism.

---

## ADR-036 — Free trial requires no payment method; zero financial exposure by construction

**Decision:** Trial signup collects only Full Name, Mobile, Email, Password (plus club/branch details in onboarding) — no credit card, no payment gateway touchpoint of any kind, anywhere in the trial flow. This is not merely a UX choice; it's architecturally enforced by the fact that `platform_payments` has no relationship to trial creation at all — a trial `platform_subscriptions` row is created directly by the onboarding RPC, with no `platform_invoices` or `platform_payments` row involved.

**Reason:** Matches the brief's explicit requirement and the project's standing zero-cost/no-payment-gateway rule (see [PROJECT_RULES.md](PROJECT_RULES.md) rule 4) — there is no payment gateway in V1 at all, so a "free trial, no card required" design isn't a marketing choice layered on top of payment infrastructure, it's the *only* option available, which conveniently also happens to be the better conversion-optimized choice for a self-service SaaS trial.

**Alternatives considered:** None seriously — collecting card details with no gateway to actually charge them would be actively worse (security liability for storing/transmitting card data with no functional payment capability behind it) and directly contradicts explicit instruction.

**Trade-offs:** No "convert automatically at trial end" capability (see ADR-038) — accepted, consistent with the rest of V1's manual billing model.

---

## ADR-035 — Club Owner subscription visibility is scoped: own club's commercial summary only

**Decision:** Club Owner can see, for their own club only: current plan, start date, expiry, grace status, days remaining, renewal status, payment summary. Club Owner cannot see other clubs, platform-wide revenue, internal platform financial reports, or the Platform Owner audit trail. This is exposed via a restricted read-only view (`club_platform_subscription_summary` or equivalent), never direct access to `platform_subscriptions`/`platform_invoices`/`platform_payments`.

**Reason:** A club legitimately needs to know its own commercial standing with Mala3by (it affects their own planning — e.g. "renew before the season starts"). It has no legitimate need to see Mala3by's business performance across other customers. This mirrors the same pattern already used for `players.medical_notes` — a summary view for broad-but-limited consumption, full table access reserved for the party with a legitimate need for the whole picture.

**Alternatives considered:** No visibility at all (rejected — a club genuinely needs to know when its own subscription is expiring, this is basic transparency). Direct table access with RLS filtering to own club (rejected — same reasoning as ADR-028's structural separation: a restricted view is simpler to reason about and audit than table-level RLS with a "but only these columns" carve-out).

**Trade-offs:** One additional view to maintain in step with `platform_subscriptions`' shape. Worth it for a clean, auditable boundary.

---

## ADR-034 — Platform Owner Control Center: full navigation, not a single billing screen

**Decision:** Platform Owner gets a dedicated `/platform` area with: Overview, Clubs, Subscriptions, Payments, Renewals, Reports, Alerts, Audit, Settings — not a single flat "Billing" screen. Each club has a detail view (`/platform/clubs/:clubId`) with Overview, Current Subscription, Subscription History, Platform Payment History, Usage, Access Status, Audit, and an Actions panel (Activate, Start Trial, Renew, Change Plan, Extend Grace Period, Suspend Club, Reactivate Club, Cancel Subscription, Record Payment, Reverse Payment).

**Reason:** Managing a growing base of paying club customers is Platform Owner's actual day-to-day job in this product — it deserves a real operational console, not an afterthought screen bolted onto club administration. This mirrors the same reasoning already applied to Reception's operational dashboard (Section 50/51 of the original brief) — the primary user of a screen should get a screen shaped around their actual workflow, not a generic CRUD table.

**Alternatives considered:** A single flat billing list with inline actions (rejected — doesn't scale past a handful of clubs, and conflates distinct concerns — overview/monitoring vs. per-club management vs. reporting vs. audit — into one crowded view).

**Trade-offs:** More screens to build than a single billing table (see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) Phase 3b's expanded frontend scope). Judged worth it since this is the Platform Owner's primary working surface, not a rarely-touched settings page.

---

## ADR-033 — Platform access is `full` / `grace` / `blocked`, derived by one centralized DB function

**Decision:** A single function, `get_club_platform_access(club_id) returns text` (`'full'` | `'grace'` | `'blocked'`), is the **only** place that combines `clubs.status` + the club's current/most-recent `platform_subscriptions` row + `now()` into an access decision. Every RLS policy and RPC that needs to know "can this club do X right now" calls this function (directly or via a thin wrapper like `auth.club_write_allowed()`) rather than re-deriving the logic inline.

**Full policy** (see [ARCHITECTURE.md](ARCHITECTURE.md#platform-access-strategy)):
- `full`: all operations permitted (subject to normal role/permission checks).
- `grace`: read existing data, collect existing outstanding payments, mark attendance for already-created academy sessions, complete existing bookings — but cannot create a new booking, new enrollment, new academy subscription, or new field/branch expansion (treated as a new commitment).
- `blocked`: no new operational writes; data is never deleted; Platform Owner retains full access regardless.

**Reason:** The first Platform Billing pass's original ADR-026 (superseded, see the note at the top of this file — its text has been replaced in place by this entry, not kept as a separate historical record) scattered the "is this club's subscription in good standing" logic across every affected table's RLS policy as an inline condition. That's exactly the kind of duplicated business logic this project's own rules reject (see [PROJECT_RULES.md](PROJECT_RULES.md) rule 13's spirit — one source of truth, checked everywhere, not reimplemented everywhere). A single function makes the access rule auditable in one place and guarantees every table applies the identical rule.

**Alternatives considered:** Inline per-policy checks (the original, superseded approach — rejected: duplicated logic is a correctness and maintenance hazard, and a future change to the grace-period rule would require touching every policy instead of one function).

**Trade-offs:** Every grace-gated write now does one extra function call (`get_club_platform_access`) before its permission check — negligible cost, and it's `STABLE` so the planner can avoid re-evaluating it redundantly within a single statement.

---

## ADR-032 — Overlapping subscription periods are prevented; adjacent renewal periods are allowed

**Decision:** `platform_subscriptions` gets the same category of protection as `bookings`: a generated `during tstzrange` column and a `GIST` exclusion constraint on `(club_id, during)`, excluding `cancelled` rows, using `[)` range semantics — so a period ending `2026-03-31` and the next starting `2026-04-01`... wait, more precisely `end_at` of period 1 equals `start_at` of period 2 exactly, which is legal under `[)` semantics (period 1 covers `[start1, end1)`, period 2 covers `[end1, end2)` — no overlap, back-to-back is fine).

**Reason:** A club must never end up with two genuinely overlapping active/planned billing periods by accident (double-charged, ambiguous which period's status governs access) — but a renewal must be creatable *before* the current period ends (e.g. Platform Owner processes next quarter's renewal a few days early), which requires the new period to start exactly when the old one ends, not strictly after. The `[)` exclusion pattern already proven correct for `bookings` (see [ADR-021](#adr-021--exclusion-constraint-covers-pending_payment-confirmed-and-checked_in)) handles this identically.

**Alternatives considered:** Application-level check-then-insert (rejected — same TOCTOU race already rejected for bookings). Requiring a strict gap between periods (rejected — makes same-day renewal impossible, an artificial restriction with no business reason).

**Trade-offs:** None beyond the `btree_gist` extension dependency already accepted for `bookings`.

---

## ADR-031 — Renewal creates a new subscription-period row; periods are never mutated/extended in place

**Decision:** `platform_subscriptions` is **one row per billing period**, not one row per club that gets its dates pushed forward on renewal. A renewal inserts a new row with `previous_subscription_id` pointing at the prior period's row. Example: Subscription #1 (`01 Jan`–`31 Mar`), Subscription #2 (`01 Apr`–`30 Jun`, `previous_subscription_id` = #1's id).

**Reason:** Mutating one row's `end_at` forward on every renewal destroys the club's billing history — there would be no record of when each period actually started/ended, what was charged for period 2 vs period 5, or how many times the club has renewed. A period-based model preserves full renewal history for free (it's just the row history), which directly enables the Subscription History view (Section 9) and the Renewal/Growth reports (Section 10) without needing a separate audit-log reconstruction.

**Alternatives considered:** Single mutable row per club, dates extended on renewal (rejected — the original, now-corrected approach; loses history, and doesn't support "one subscription row per billing period" as explicitly required).

**Trade-offs:** Slightly more rows over a club's lifetime (one per billing period, e.g. 4/year for quarterly) — trivial at this data scale. Querying "the club's current subscription" requires finding the period where `now()` falls within `[start_at, end_at)` (or the most recent one if none currently active) rather than a flat single-row lookup — handled by `get_club_platform_access()` and a `current_platform_subscription` view, not scattered ad hoc queries.

---

## ADR-030 — Platform plan pricing is snapshotted onto each subscription period

**Decision:** `platform_plans` remains editable by Platform Owner (price changes over time are normal business reality). Every `platform_subscriptions` row captures a **snapshot** at creation time: `plan_name_snapshot`, `price_snapshot`, `currency_snapshot`, `interval_snapshot`, `interval_count_snapshot`, `grace_period_days_snapshot`. Editing `platform_plans` later never changes any existing subscription period's snapshotted values.

**Reason:** If a subscription read its price live from `platform_plans` and Platform Owner later raised the price, every historical period's invoice/report would retroactively show the new price — corrupting financial history in exactly the way [PROJECT_RULES.md](PROJECT_RULES.md) rule 3/8 already forbids for club-level billing. The same principle applies here: a financial record must reflect what was actually agreed and charged at the time, permanently.

**Alternatives considered:** Always read current plan price live (rejected — corrupts historical financial accuracy, see reasoning above). Store only a `plan_id` FK with no snapshot (rejected — same problem, just one join away instead of zero).

**Trade-offs:** Minor denormalization (the same plan name/price/interval values are duplicated across every period row for a club on an unchanged plan). Accepted — this is the standard, correct pattern for any subscription billing system (Stripe, for reference, does the same thing with invoice line item snapshots).

---

## ADR-029 — Platform plan supports real billing intervals: monthly, quarterly, semi-annual, annual

**Decision:** `platform_plans` (and the snapshot on `platform_subscriptions`) uses `billing_interval` (`month` | `year`) + `billing_interval_count` (int) rather than a single flat "the plan" concept with no duration structure. Monthly = `month × 1`, Quarterly = `month × 3`, Semi-Annual = `month × 6`, Annual = `year × 1`. All plans can offer the same feature set in V1 — the only variation is duration, price, and discount.

**Reason:** A real subscription product needs real billing periods — a club choosing "pay annually for a discount" vs "pay monthly" is a normal, expected commercial choice, and the schema needs to represent an arbitrary future duration (not just today's four options) without a migration. `interval` + `interval_count` is the standard two-column pattern (same shape Stripe uses) that covers today's four durations and any future one (e.g. bi-monthly = `month × 2`) with no schema change.

**Alternatives considered:** A single hardcoded duration with no concept of interval (the original, now-corrected "single flat plan" approach — rejected: explicitly insufficient per this correction). An enum of named periods (`monthly`/`quarterly`/`semi_annual`/`annual`) with no way to add a new one without a migration (rejected — `interval`+`interval_count` covers the same four values today and any future value for free).

**Trade-offs:** Slightly more computation to turn `interval`+`interval_count` into an actual `end_at` date (`start_at + (interval_count * interval)`) versus reading a flat duration — trivial, handled once in the renewal RPC.

---

## ADR-028 — Platform billing is a structurally separate domain from club billing

**Decision:** Mala3by charging a club to use the platform is modeled with its own tables — `platform_plans`, `platform_subscriptions`, `platform_invoices`, `platform_payments` — entirely distinct from `invoices`/`payments`/`payment_allocations`/`subscriptions`, which represent money flowing between a club and *its own* customers. (Unchanged from the original ADR-022 — restated here as the still-current decision since ADR-022 itself is superseded below along with the rest of the original pass.)

**Reason:** These are two unrelated financial relationships that happen to both be called "billing": one is Mala3by↔Club (platform revenue), the other is Club↔Customer (club revenue). Conflating them into the same tables — e.g. adding a `payer_type` discriminator to `invoices` — would repeat exactly the kind of dual-purpose-table hazard already corrected once in this project (see [ADR-011b](#adr-011b--paymentsinvoice_id-removed-payment_allocations-is-the-only-payment-invoice-relationship)). Separate tables make the two ledgers impossible to accidentally cross.

**Alternatives considered:** Reuse `invoices`/`payments` with a `scope`/`payer_type` discriminator (rejected — same anti-pattern already corrected once).

**Trade-offs:** Some structural duplication (platform billing needs its own numbering, its own status concepts, its own "payment" concept) rather than reusing club-billing machinery. Accepted because the duplication is small and isolation is the actual safety property being bought.

---

## ADR-027 — `clubs.status` and platform subscription status are fully independent; `grace_period` is never a club status

**Decision:** `clubs.status` is `active` | `suspended` | `closed` — and **nothing else**. It answers "is this club allowed to operate at all," a decision Platform Owner makes deliberately (suspend for cause, close permanently). It has no `grace_period` value and is never set based on billing lateness. Platform subscription standing is a **separate** concept entirely: the *effective subscription status* — `trial` | `active` | `grace_period` | `expired` | `cancelled` — lives on/is derived from `platform_subscriptions`, never on `clubs`.

**Reason:** The first Platform Billing pass's original decision put `grace_period` inside `clubs.status`, conflating two genuinely different questions: "is this club account allowed to exist/operate" (an administrative decision) vs. "is this club's Mala3by subscription currently paid up" (a billing/time-derived fact). Conflating them means a club that's perfectly fine operationally but has a subscription hiccup gets the same status field mutated as a club Platform Owner deliberately suspended for cause — two unrelated reasons producing the same-looking state, which is confusing to reason about, audit, and query. Keeping them separate means `clubs.status = 'active'` always simply means "this club account is allowed to exist and operate," full stop — the subscription's own state answers the billing question independently.

**Alternatives considered:** Keep `grace_period` on `clubs.status` (the original, now-corrected approach — rejected per explicit correction). A single combined status enum covering both dimensions (rejected — conflates two independent axes into one enum, the same problem in different clothing).

**Trade-offs:** Access-control logic now reads two independent signals (`clubs.status` and the derived subscription status) instead of one — handled by centralizing both into `get_club_platform_access()` (see [ADR-033](#adr-033--platform-access-is-full--grace--blocked-derived-by-one-centralized-db-function)) so nothing downstream needs to know there are two signals being combined.

---

## ADR-021 — Exclusion constraint covers `pending_payment`, `confirmed`, and `checked_in`

**Decision:** The `bookings` double-booking exclusion constraint's `WHERE` clause is `status IN ('pending_payment', 'confirmed', 'checked_in')` — i.e. it blocks overlap for any non-terminal booking state. `completed`, `cancelled`, and `no_show` are excluded from the constraint.

**Reason:** `cancelled`/`no_show` explicitly free the slot — no correction needed there, this matches the original design. `completed` needed explicit reasoning: a completed booking's time range is necessarily in the past (you can't complete a future booking), so it can never structurally overlap with a new booking being created for a future or current slot — excluding it from the constraint is safe and avoids the constraint doing unnecessary work on historical rows. `pending_payment` was added to the blocking set — a booking awaiting payment still holds the slot; if it didn't, two receptionists could each create a `pending_payment` booking for the same slot while sorting out payment, and the constraint's whole purpose would be defeated at exactly the highest-race-risk moment (peak booking hours, near-simultaneous walk-ins/calls).

**Alternatives considered:** Only blocking on `confirmed`/`checked_in` (rejected — leaves a real race window during the payment-pending moment, which is exactly when double-booking risk is highest).

**Trade-offs:** A `pending_payment` booking that's abandoned (never paid, never explicitly cancelled) holds a slot until someone cancels it. This is an acceptable operational cost given the booking flow is designed to be seconds long (see [USER_FLOWS.md](USER_FLOWS.md)) — a stale `pending_payment` booking is a training/process issue to catch via the dashboard's "upcoming" list, not a data integrity problem.

**Boundary test confirmed:** `10:00–11:00` and `11:00–12:00` do not overlap under `[)` range semantics — `tstzrange(..., '[)')` makes the end time exclusive, so back-to-back bookings are always legal.

---

## ADR-020 — Audit logs are immutable: no role can update or delete them

**Decision:** `audit_logs` has an RLS `SELECT` policy only. There is no `UPDATE` or `DELETE` policy for any role — not Club Owner, not Platform Owner. `INSERT` happens exclusively via `SECURITY DEFINER` triggers/RPCs, never direct client insert.

**Reason:** An audit trail that any privileged user can edit is not an audit trail — it's a log that a sufficiently privileged actor can rewrite to hide their own actions. Platform Owner has no legitimate V1 need to alter historical audit data; if a correction is ever needed, the correct pattern is a new audit entry noting the correction, not mutating history.

**Alternatives considered:** Allow Platform Owner UPDATE for "fixing mistakes" (rejected — creates exactly the tamper vector audit logs exist to prevent; a "fix" is itself just a new fact, recorded as a new row).

**Trade-offs:** None — this is strictly a security improvement with no legitimate workflow it blocks.

---

## ADR-019 — Medical notes are a permission-gated field, not a default-visible one

**Decision:** `players.medical_notes` requires the explicit permissions `player.medical_notes.view` / `player.medical_notes.update`, granted by default to Academy Manager, Club Manager, and a Coach for their assigned players only. Receptionist does not see this field by default. It never appears in global search result previews.

**Reason:** Medical information is sensitive personal data with a materially different exposure risk than a name or phone number. A Receptionist's job (booking, payment, check-in) never requires reading it; defaulting it to visible-to-everyone-who-can-see-a-player-record is an unnecessary exposure with no operational benefit.

**Alternatives considered:** Same visibility as the rest of the player record (rejected — no business justification for the exposure, and it's cheap to gate properly from the start rather than retrofit after a privacy concern is raised).

**Trade-offs:** One additional permission pair to seed and check; UI needs a conditional render for this one field. Minor cost for a real privacy improvement.

---

## ADR-018 — All timestamps are `timestamptz`; club owns a display timezone

**Decision:** Every timestamp column in the schema is `timestamptz`. No booking time, session time, or audit timestamp is ever stored as a naive local timestamp. `clubs.timezone` (default `Africa/Cairo`) is the single source for how timestamps are *displayed* to that club's staff; storage is always UTC-normalized `timestamptz` under the hood.

**Reason:** This was already implicit in the original blueprint but is now stated as an explicit rule because booking/session times are exactly the kind of data that silently corrupts under DST changes or multi-timezone confusion if a naive timestamp type is ever used by mistake in a future migration.

**Alternatives considered:** None seriously — this is a correctness baseline, not a trade-off decision.

**Trade-offs:** None.

---

## ADR-017 — Single currency per club, no multi-currency in V1

**Decision:** Each club has exactly one operating `currency` (stored on `clubs`). `payments`/`invoices` do not carry their own `currency` column in V1 — they are assumed to match their club's currency. If a genuine historical/multi-currency need arises later, a `currency` column can be added to those tables at that point, constrained to match the club's currency unless multi-currency is explicitly built.

**Reason:** No V1 use case requires a club to transact in more than one currency simultaneously. Adding a per-row currency column now, with no logic that ever varies it, is a placeholder with no function — the same anti-pattern already rejected for `organization_id` (see ADR-011).

**Alternatives considered:** Add `currency` to every financial row now "just in case" (rejected — same reasoning as removing `organization_id`: no schema placeholders for unused capability).

**Trade-offs:** A genuine future multi-currency requirement (e.g. a club chain spanning two countries) requires a migration at that time. Acceptable — it's a rare, clearly-triggered event, not a silent gap.

---

## ADR-016 — Money is `numeric(12,2)`, never `float`/`double`

**Decision:** Every money-valued column (`price_per_hour`, `total_price`, `amount`, `total`, `subtotal`, `discount`, `tax`, etc.) is `numeric(12,2)` in PostgreSQL.

**Reason:** Floating-point binary representation cannot exactly represent most decimal currency values (`0.1 + 0.2 ≠ 0.3` in IEEE 754), which silently corrupts financial totals over enough operations. `numeric` is PostgreSQL's exact decimal type — no rounding drift, and `(12,2)` comfortably covers any realistic club revenue figure with 2 decimal places of currency precision.

**Alternatives considered:** Integer minor-units (piastres) storage (rejected as unnecessary complexity for this domain — `numeric(12,2)` is exact and requires no unit-conversion logic scattered through the app, unlike the integer-cents pattern common in USD-cents systems).

**Trade-offs:** None meaningful — `numeric` arithmetic is marginally slower than native float ops, utterly irrelevant at this application's data volume.

---

## ADR-015 — Membership branch scope is a join table, not a single column

**Decision:** `club_memberships` has no `branch_id` column. A new `membership_branches(membership_id, branch_id)` join table expresses branch scope. **Semantics: zero rows for a membership = all branches of that club. One or more rows = restricted to exactly those branches.**

**Reason:** The original single nullable `branch_id` column could not express "this Branch Manager works across two specific branches, but not all branches of the club" — only "one specific branch" or "all branches" (via null). A real club can absolutely have a manager covering two of three branches. A join table expresses the full range of real scoping needs without inventing a special multi-value encoding inside a single column.

**Alternatives considered:** Array column (`branch_ids uuid[]`) on `club_memberships` (rejected — join tables are easier to index, foreign-key-constrain, and query/join against cleanly in RLS policies than array-containment checks; also easier to audit membership-branch grant/revoke as discrete events later if needed).

**Trade-offs:** One additional table and join in RLS branch-scoping checks. Worth it for correctly modeling a real operational case instead of hitting a wall the first time a multi-branch manager is hired.

---

## ADR-014 — Permissions, not role keys, are the authorization source of truth

**Decision:** No application code — frontend or database function — makes an authorization decision by comparing a role key (e.g. `if role === 'accountant'`). Every authorization check, in both the UI (to decide what to show) and the RPC/RLS layer (to decide what to allow), is expressed as a permission key check (e.g. `has_permission('payment.refund')`).

**Reason:** This was already the intent of the original RLS design (`role_permissions` exists specifically for this) but is now stated as an explicit rule because it's easy to accidentally shortcut with a role-key `if` statement during UI development, which silently reintroduces the exact rigid role-coupling the permission model exists to avoid. `roles` remains a real, seeded table — it's a convenient labeling/grouping mechanism for assigning a bundle of permissions to a person — but it is never itself the thing being checked.

**Alternatives considered:** None — this is a discipline rule restating and hardening the existing design, not a new architecture.

**Trade-offs:** None. Marginally more verbose than a role check in places, in exchange for a system that survives adding a new role or adjusting one role's capabilities without a code change.

---

## ADR-013 — Subscription activation policy is a club setting, not a hardcoded rule

**Decision:** `clubs.subscription_activation_policy` is one of `manual` | `first_payment` | `full_payment`, default `first_payment`. The subscription-activation RPC branches on this value rather than hardcoding "any partial payment activates the subscription."

**Reason:** "Does a deposit activate a subscription, or does it need to be paid in full, or does staff decide manually?" is a business policy question, not a technical fact — different clubs may reasonably want different answers, and hardcoding one as if it were universally true was flagged as a real risk. A single nullable-free enum column on `clubs`, checked inside one RPC, supports all three behaviors without complex UI — it's a setting, not a feature.

**Alternatives considered:** Hardcode `first_payment` behavior only (rejected — the exact anti-pattern flagged; would require an RPC rewrite, not just a data change, the first time a club needs `manual` or `full_payment`). Build a rich policy-configuration UI (rejected — over-engineered for what is genuinely a single enum setting; a simple dropdown in club settings is sufficient).

**Trade-offs:** One additional column and one `CASE`/`IF` branch in the activation RPC. Negligible cost for avoiding a rebuild.

---

## ADR-013b — One subscription : one enrollment in V1 is a deliberate rule

**Decision:** `subscriptions.enrollment_id` is a required, unique foreign key — each subscription belongs to exactly one enrollment, and each enrollment has at most one subscription. This is enforced by a unique constraint on `subscriptions.enrollment_id`, not just documented as a convention.

**Reason:** Explicitly recorded as an intentional V1 business rule, not an oversight or an accidental limitation discovered later. It keeps the billing model simple and matches the actual V1 use case (a player's group membership is billed as one subscription). A membership/package product spanning multiple groups or sports is a materially different model — different renewal logic, different capacity implications, different pricing — and should be designed as its own thing when there's a real need for it, not bolted onto this table by loosening the constraint.

**Alternatives considered:** Allow a subscription to span multiple enrollments now, "just in case" (rejected — exactly the kind of premature generalization the project's guiding principles reject; no current use case needs it, and it would complicate every subscription-status/billing calculation for a hypothetical).

**Trade-offs:** When a genuine multi-group package product is needed, it's a new table/model, not a migration loosening this constraint — which is the intended, cleaner path.

---

## ADR-012 — Phone numbers are normalized; `mobile` is not a hard unique constraint

**Decision:** `customers` stores both `mobile_display` (as entered) and `normalized_mobile` (run through a shared normalization utility handling `010...`, `+2010...`, `002010...` as the same number). There is **no unique constraint** on phone number — instead, a non-unique index on `(club_id, normalized_mobile)` powers duplicate-detection in the UI at creation/search time.

**Reason:** A hard unique constraint on mobile number was flagged as unsafe for the real usage pattern in this market: a father may use one number for himself and multiple children's player records, a family may share one number, a customer may have no phone on file at all, and the same person may be typed in with different formats over time. A strict constraint would either reject legitimate shared-number cases or (if scoped to avoid that) fail to catch real duplicates typed in different formats — normalization plus a soft duplicate-check UI solves both problems without blocking legitimate saves.

**Alternatives considered:** Hard `UNIQUE(club_id, mobile)` (rejected — blocks legitimate shared-family-number cases). No normalization at all (rejected — `010...`/`+2010...`/`002010...` would silently register as three different customers, defeating search and creating real operational confusion).

**Trade-offs:** Duplicate customer records are still *possible* (not database-prevented) — mitigated by the UI surfacing likely matches before save, which is judged sufficient for V1 given the false-positive cost of a hard constraint would be worse than the false-negative cost of an occasional missed duplicate.

---

## ADR-011d — Player QR is reusable; Booking QR is consumable; scans are a separate log

**Decision:** Three logically distinct QR concerns, previously conflated:
1. `qr_credentials.type` is `booking` or `player_membership` only (not `subscription`).
2. `player_membership` credentials have `single_use = false` — scanning does not consume/mutate the credential; it is a lookup/validation event only.
3. `booking` credentials have `single_use = true` by default, but **consumption happens on explicit staff confirmation, not on scan alone** (see ADR-011e below).
4. Every scan — successful, replayed, expired, wrong-club, whatever — is logged to a new `qr_scan_events` table, independent of whatever state change (or lack thereof) happened to the credential. `qr_credentials.used_at`/`used_by` remain as a convenience "last use" snapshot but are not the audit trail.
5. An invoice QR (if used) is explicitly documented as a lookup/verification reference, never an access credential, and is not a `qr_credentials` row at all in the access-control sense.

**Reason:** The original design implicitly treated all QR types the same way (single-use, consumed on scan), which is wrong for a player membership card that a coach scans every training day — consuming it after the first scan would break attendance entirely. Separating "credential state" from "scan history" also fixes an audit gap: without `qr_scan_events`, there was no way to see a full history of repeated valid scans (e.g. every time a player's card was scanned for attendance) or a security-relevant pattern of failed/rejected scan attempts.

**Alternatives considered:** One generic `qr_credentials` table with `single_use` as the only variation, no separate scan log (rejected — insufficient audit trail, and conflates "current credential state" with "full history," which are different concerns with different retention/query needs).

**Trade-offs:** One additional table (`qr_scan_events`) and one more INSERT per scan. Necessary cost for correct attendance behavior and a real audit trail.

---

## ADR-011e — QR scan validates; explicit staff confirmation performs the check-in mutation

**Decision:** For booking check-in specifically: scanning a QR **only validates and displays** the booking (customer, field, time, payment status) — it does not, by itself, consume the credential or change `bookings.status`. A separate, explicit "Confirm Check-in" action performs the atomic state mutation: consumes the credential (if single-use) and transitions `bookings.status → checked_in` together, in one RPC.

**Reason:** The brief flagged a real contradiction risk: if scanning alone both consumed the QR and changed booking state, then a QR that merely passes in front of a camera (accidental scan, camera testing, a customer showing it to a friend) could silently check someone in. Requiring staff to see the validated result and explicitly confirm removes that failure mode while still keeping the overall flow fast (scan → glance → tap confirm is still a 2-3 second operation).

**Alternatives considered:** Scan = atomic validate-and-check-in in one step (rejected — the accidental-scan risk above; also removes the staff's chance to notice something wrong — e.g. wrong booking, unpaid balance — before committing the check-in).

**Trade-offs:** One extra tap in the check-in flow versus a fully automatic scan-to-checked-in. Judged worth it for the error-prevention benefit; still well within the "fast operational flow" goal.

---

## ADR-011c — Refund model: `refunds` table + reversing allocation, atomic RPC

**Decision:** Refunds use the simpler of the two options considered (a dedicated `refunds` table referencing the original `payment_id`, rather than a full generalized ledger/reversal-entry system), executed through a single atomic RPC that: (1) validates the requested refund amount does not exceed the payment's current refundable balance (`payment.amount − sum of prior completed refunds`), (2) inserts the `refunds` row, (3) inserts a reversing `payment_allocations` adjustment so the invoice's derived outstanding balance reflects the refund, (4) writes an `audit_logs` entry — all in one transaction.

**Reason:** A full double-entry ledger/reversal-entry system (Option B) was considered and rejected as more machinery than V1's actual requirement — the brief's own list of what a refund must guarantee (original payment unchanged, partial refund supported, cannot exceed refundable balance, actor/time/reason captured, balance always derivable, atomic, audited) is fully satisfiable with a dedicated `refunds` table plus a reversing allocation, without introducing a generalized ledger abstraction this product doesn't otherwise need.

**Alternatives considered:** Option B, a generalized ledger/reversal-entry model (rejected for V1 as over-engineered relative to the actual requirement — see [PROJECT_RULES.md](PROJECT_RULES.md) rule 6 on avoiding unnecessary abstraction). Mutating `payments.amount` directly on refund (rejected outright — destroys the historical record of what was actually originally paid).

**Trade-offs:** If a future need arises for more complex financial event sourcing (e.g. multi-step reconciliation workflows), this model would need to be extended — judged unlikely to be needed at this product's scale and deferred until evidence says otherwise.

---

## ADR-011b — `payments.invoice_id` removed; `payment_allocations` is the only payment↔invoice relationship

**Decision:** `payments` has no `invoice_id` column. The relationship between a payment and the invoice(s) it funds exists exclusively through `payment_allocations(payment_id, invoice_id, amount)`.

**Reason:** The original blueprint had a genuine internal contradiction — `payments.invoice_id` implied a one-payment-to-one-invoice relationship, while `payment_allocations` was simultaneously introduced specifically to support one payment funding multiple invoices (or partially funding one). Two sources of truth for the same relationship is a data-integrity hazard: which one wins if they disagree? Removing `payments.invoice_id` entirely and keeping `payment_allocations` as the single relationship path resolves this cleanly.

**Alternatives considered:** Keep both, with `payments.invoice_id` as a denormalized "primary" invoice for convenience (rejected — reintroduces exactly the dual-source-of-truth problem; any convenience query can instead join through `payment_allocations`, which is not meaningfully more expensive at this data scale).

**Trade-offs:** Looking up "which invoice does this payment belong to" always requires a join through `payment_allocations` rather than a direct column read — correct trade for a payment that may legitimately fund more than one invoice.

---

## ADR-011 — `organizations` removed entirely from V1 schema

**Decision:** No `organizations` table exists in V1. No `organization_id` column exists on `clubs` or anywhere else — not even as a nullable placeholder. Confirmed architecture: `Platform → Clubs → Branches`, full stop. **This supersedes ADR-006's original "nullable placeholder" approach.**

**Reason:** ADR-006 originally kept `clubs.organization_id` as an unused nullable column "for later." On reflection this is itself a schema placeholder for a capability with zero V1 users — exactly the anti-pattern the project's own principles reject (see [PROJECT_RULES.md](PROJECT_RULES.md) rule 6, "no premature abstraction"). A nullable unused column still shows up in every schema diagram, every generated TypeScript type, and every developer's mental model of `clubs`, for a concept that may never be needed, or may need a different shape than guessed today when it actually is needed.

**Alternatives considered:** ADR-006's original approach — nullable placeholder column (superseded, reasoning above). Full 3-layer hierarchy built now (still rejected, same reasoning as ADR-006 — no V1 user populates it).

**Trade-offs:** If a genuine multi-club-operator customer signs on later, adding `organizations` + `clubs.organization_id` at that point is a normal additive migration (new table, new nullable FK column, backfill as needed) — no different in cost from what ADR-006 originally proposed, just deferred until the column would actually be used by something instead of sitting empty from day one.

---

## ADR-010 — Arabic-first content, English best-effort toggle

**Decision:** V1 ships full Arabic content on every screen. English exists as a locale toggle at the architecture level (all strings i18n-keyed, `dir` attribute driven from locale) but English *content* is filled in opportunistically and may fall back to Arabic where untranslated.

**Reason:** Full bilingual content parity roughly doubles content-writing/review work across ~20 screens for no V1 benefit — the pilot club operates in Arabic. Confirmed with stakeholder (Section 35 of planning brief).

**Alternatives considered:** Full EN+AR parity from day one (rejected — schedule risk with no offsetting benefit for a single Arabic-speaking pilot club).

**Trade-offs:** English-speaking staff/customers see partial Arabic fallback until content is backfilled in V1.1. Architecture cost is zero — no rebuild needed to complete English later.

---

## ADR-009 — Invoice numbering is per-branch

**Decision:** `invoice_number_sequences` is keyed by `(branch_id, year)`. Format: `{club_code}-{branch_code}-{YEAR}-{000001}`, where `club_code` and `branch_code` are read from `clubs.club_code`/`branches.branch_code` at generation time — **never a hardcoded prefix like `MAL` inside database function logic.** A club can set its own code (e.g. a different club would not be `MAL`-prefixed).

**Reason:** Confirmed with stakeholder (Section 35 of planning brief). Gives each branch's front desk an independently verifiable, gapless sequence for daily cash/invoice reconciliation without cross-branch contention on a shared counter.

**Alternatives considered:** Per-club sequence (rejected — couples unrelated branches on one counter row, and branch identity would only appear via an embedded code rather than being the actual partitioning key).

**Trade-offs:** A club with multiple branches has multiple independent number sequences rather than one global one — acceptable since invoices are always viewed in branch context anyway.

---

## ADR-008 — Subscription freeze extends expiry by default

**Decision:** `subscription_freezes.extends_expiry` defaults to `true`. When a subscription is frozen, its `end_date` shifts forward by the frozen duration once the freeze ends.

**Reason:** Confirmed with stakeholder (Section 35 of planning brief). Matches customer expectation — a paying customer who freezes for travel keeps the full paid access period, which is the safer default for retention and avoids billing disputes.

**Alternatives considered:** Fixed expiry regardless of freeze (rejected — customers lose paid days, dispute risk). Per-club configurable policy (rejected for V1 — adds a settings field and branching logic in the status/expiry RPC for a decision that has one clear right answer for this business).

**Trade-offs:** None significant; `extends_expiry` remains a column (not hardcoded) so a future club with a different policy need doesn't require a schema change, only a data value + RPC branch — deferred until actually needed.

---

## ADR-007 — Double-booking prevention via PostgreSQL exclusion constraint

**Decision:** `bookings` gets a generated `tstzrange` column and a `GIST` exclusion constraint on `(field_id, during)`, rather than relying on application-level locking or a "check then insert" pattern in the RPC. **See [ADR-021](#adr-021--exclusion-constraint-covers-pending_payment-confirmed-and-checked_in) for the exact set of statuses the constraint blocks on** — this was refined after the original draft to explicitly include `pending_payment`, not just `confirmed`/`checked_in`.

**Reason:** An exclusion constraint is enforced by Postgres itself against every write path — including a hypothetical buggy RPC or a direct API call — not just the happy path the app author remembered to guard. This is strictly safer than app-level checks and requires no custom concurrency code.

**Alternatives considered:** Row locking (`SELECT ... FOR UPDATE`) inside the RPC (rejected as sole mechanism — protects only the one RPC path, not defense-in-depth). Application-level check-then-insert (rejected — classic TOCTOU race under concurrent requests).

**Trade-offs:** Exclusion constraints require the `btree_gist` extension (free, standard Postgres contrib module, no cost implication).

---

## ADR-006 — No `organizations` layer above `clubs` in V1 schema (SUPERSEDED by ADR-011)

**⚠️ Superseded 2026-08-15.** This entry's original decision — keeping a nullable, unused `clubs.organization_id` placeholder column — was itself identified as a schema placeholder anti-pattern and reversed. **See [ADR-011](#adr-011--organizations-removed-entirely-from-v1-schema) for the current, binding decision: no `organization_id` column exists anywhere in the schema.** This entry is kept for historical record only; do not implement against it.

**Original decision (no longer in effect):** Drop the `organizations → clubs → branches` hierarchy from the brief. Use `clubs → branches` directly, with `clubs.organization_id uuid` present but nullable and unused until a real multi-club operator customer exists.

**Original reason:** No V1 customer will populate this layer — the pilot is a single club. An always-empty ceremonial layer adds a join and a concept to every query and screen for zero near-term benefit.

**Why it was superseded:** The nullable placeholder column was itself judged to be exactly the kind of premature schema element the project's principles reject — see ADR-011.

---

## ADR-005 — QR tokens are opaque random values, hashed at rest

**Decision:** QR codes encode a 256-bit random token, not a database ID or any predictable identifier. The server stores only `SHA-256(token)` in `qr_credentials.token_hash`, never the raw token.

**Reason:** Prevents QR forgery (unguessable) and prevents any information leakage if the `qr_credentials` table were ever exposed (hash isn't reversible to a usable token). Matches the brief's explicit rejection of `booking_id=1234`-style QR content.

**Alternatives considered:** Signed JWT-style tokens embedding the booking ID (rejected — more moving parts, no benefit over opaque-token + server lookup for this use case, and a leaked signing key would be catastrophic vs. a leaked hash being safe).

**Trade-offs:** Every scan requires a database round-trip (no offline/client-side validation) — acceptable and actually required anyway, since replay protection must be atomic and server-side.

---

## ADR-004 — No custom backend server; Supabase RPC covers all atomic operations

**Decision:** All atomic/multi-table business operations (booking creation, invoice numbering, QR consume, refunds) are implemented as PostgreSQL functions called via `supabase.rpc()`. No Node/Express/Nest server is introduced.

**Reason:** Supabase RLS + Postgres functions + exclusion constraints cover every atomicity and authorization requirement in the brief. Introducing a separate backend would duplicate the authorization model (RLS already does this) and add a service to host, deploy, and pay for.

**Alternatives considered:** Custom API server as a thin layer over Supabase (rejected — no functional gap it fills; violates the brief's explicit "no custom backend server if Supabase covers the need" instruction).

**Trade-offs:** Business logic that would live in "controller" code in a traditional backend instead lives in SQL/PLpgSQL — requires the team to be comfortable writing and testing Postgres functions, which the Test Plan accounts for (pgTAP).

---

## ADR-003 — Financial values are always derived, never stored as authoritative

**Decision:** `subscriptions.amount_paid`, `amount_remaining`, and `invoices` outstanding balance are never stored columns treated as fact. They are computed from `payment_allocations` (net of `refunds`) at query time (or cached via trigger, but always re-derivable and reconciled against the ledger). See [ADR-011b](#adr-011b--paymentsinvoice_id-removed-payment_allocations-is-the-only-payment-invoice-relationship) — `payment_allocations` is the sole payment↔invoice relationship this derivation reads from.

**Reason:** Storing derived financial values invites drift between the "cached" number and the real ledger — a source of bugs and financial discrepancies that are hard to detect and worse to explain to a club owner.

**Alternatives considered:** Storing and manually updating running totals on `subscriptions`/`invoices` (rejected — exactly the inconsistency risk the brief explicitly warned against).

**Trade-offs:** Slightly more complex queries (joins/aggregates instead of a flat column read); acceptable given the volumes involved (a single club's invoice/payment history, not big data).

---

## ADR-002 — Guardian is not a separate entity from Customer

**Decision:** There is one `customers` table. A customer becomes a "guardian" by having one or more rows in `guardian_links(customer_id, player_id, relationship)`. No separate `guardians` table.

**Reason:** The brief's own example — a booking customer later enrolls their kid — would otherwise require either duplicating the person as both a `customer` and a `guardian` record, or an awkward "promote customer to guardian" migration step. A single people-table with a role-indicating join table avoids duplicate-person modeling entirely.

**Alternatives considered:** Separate `guardians` table (rejected — models a role as an entity, and the brief explicitly says a customer isn't necessarily a player but doesn't say a customer and a guardian are structurally different kinds of person).

**Trade-offs:** None identified; this is strictly simpler than the alternative.

---

## ADR-001 — Booking state machine reduced to 6 states

**Decision:** `bookings.status` is one of: `pending_payment, confirmed, checked_in, completed, cancelled, no_show`. `Draft` and `Pending` (as distinct pre-confirmation states) and `In Progress`/`Refunded` (as booking-level states) from the original brief are dropped.

**Reason:** The brief itself asks that booking creation be "as few steps as possible" — a receptionist's booking flow commits directly, it doesn't pass through a separate draft-then-pending UI step in practice. `In Progress` is redundant with `checked_in` for a same-day walk-in sport-facility booking (no meaningful UI/business action differs between "checked in" and "in progress" for this use case). `Refunded` is a property of the linked payment/invoice, not the booking itself — a booking is `cancelled`, and its payment is separately `refunded`.

**Alternatives considered:** Full 9-state machine from the brief (rejected — more states to build UI for and test, with no corresponding real-world transition that needs them in V1).

**Trade-offs:** If a future need for a true multi-step draft/approval booking flow emerges (e.g. requiring manager approval before confirmation), it can be added as new status values — additive, not a rebuild.
