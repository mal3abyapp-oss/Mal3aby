# Architecture

> **Corrected 2026-08-15** per Mandatory Architecture Corrections. See [DECISIONS.md](DECISIONS.md) ADR-011 through ADR-021 for full reasoning behind changes in this revision.
>
> **Added 2026-08-15 (public site)** per Public Website + Signup + Free Trial addition. New sections: [Public Website & Layout Strategy](#public-website--layout-strategy), [Signup & Onboarding Strategy](#signup--onboarding-strategy). Trial is folded into the existing [Platform Access Strategy](#platform-access-strategy) as a `subscription_kind`, not a new system. See [DECISIONS.md](DECISIONS.md) ADR-036 through ADR-046.
>
> **Added 2026-08-15 (final pre-implementation)** per the Final Pre-Implementation Directive. Security and anti-fraud controls consolidated into [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md) — read alongside [RLS_SECURITY.md](RLS_SECURITY.md) before implementing any domain, not only at hardening time (see [DECISIONS.md ADR-050](DECISIONS.md#adr-050--security-and-design-are-built-with-each-domain-not-deferred-to-a-late-hardeningpolish-phase)). Visual design system established in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md), built in Phase 1 before real screens. New sections: [Recurring Booking Strategy](#recurring-booking-strategy), [Outstanding Payments Strategy](#outstanding-payments-strategy), [Quick Field Block Strategy](#quick-field-block-strategy).
>
> **Corrected 2026-08-15 (final two decisions)** per the Final Two Decisions Closure. `complete_new_club_onboarding()` corrected: a user is **never** blocked from creating additional clubs — only the *automatic trial* is limited to one per user account, via a new `automatic_trial_entitlements` table, independent of the existing one-trial-per-club rule (see [DECISIONS.md ADR-051](DECISIONS.md#adr-051--automatic-trial-entitlement-is-one-per-user-account-enforced-via-a-dedicated-concurrency-safe-entitlement-table)). Recurring Booking Strategy confirmed final: one independent financial lifecycle per occurrence, no series-level invoice (see [DECISIONS.md ADR-052](DECISIONS.md#adr-052--recurring-booking-billing-granularity-one-financial-lifecycle-per-occurrence-no-series-level-invoice-in-v1)).

## System Architecture

**Frontend:** React + TypeScript + Vite SPA, Tailwind CSS + shadcn/ui, TanStack Query for server state and cache invalidation, React Router for routing. PWA via `vite-plugin-pwa` (Workbox), installable to home screen, no native wrapper.

**Backend:** Supabase Postgres only. No custom Node/Express/Nest server (see [DECISIONS.md ADR-004](DECISIONS.md#adr-004--no-custom-backend-server-supabase-rpc-covers-all-atomic-operations)). Business rules requiring atomicity — booking creation, invoice numbering, QR consume, refunds — live in PostgreSQL functions (RPC), called via `supabase.rpc()`.

**Core principle:** the database is the authority; the frontend is a client of it, never the source of truth for money or availability. See [PROJECT_RULES.md](PROJECT_RULES.md) rule 1.

**Deployment:** Cloudflare Pages — static SPA hosting, free tier, auto-deploys on push to `main`. No Cloudflare Workers needed (no custom backend to run).

## Domain Architecture

Feature-based structure. Each `features/*` module owns its queries, mutations, and components. Pure business logic lives in `lib/domain/` — testable, UI-agnostic, imported by both UI and tests, so price calculation or subscription-status logic is never duplicated between a form and a report.

```
src/
  app/
    layouts/
      PublicLayout/         # public site header/footer shell — see Public Website strategy below
      AppLayout/             # authenticated club-side shell (existing sidebar/bottom-nav)
      PlatformLayout/        # /platform Control Center shell
    routing/                # route guards per layout — see Route Guards below
    providers/
  components/             # shared/dumb UI (shadcn-based)
  features/
    public-site/            # home, pricing, contact, FAQ — reads public_plans/platform_settings only
    auth/                   # login, signup, forgot/reset password
    onboarding/              # complete_new_club_onboarding wizard + first-run checklist
    clubs/                # club + branch admin
    staff/                # roles, permissions, memberships
    customers/             # customers + guardian_links
    players/
    fields/                 # fields, operating hours, pricing rules
    bookings/              # calendar, booking engine, check-in
    academy/                # programs, groups, enrollments, sessions, attendance
    billing/                # invoices, payments, refunds
    subscription/            # club-side /app/subscription screen (own-club summary view)
    scanner/                # QR generation + /scan
    reports/
    dashboard/
    settings/
    platform/                # /platform Control Center — clubs, subscriptions, payments, reports, leads
  lib/
    supabase/              # client, generated types
    domain/                 # pure business logic, testable, UI-agnostic
  hooks/
supabase/
  migrations/
  seed.sql
  tests/                    # pgTAP / SQL-based RLS + logic tests
docs/
public/
```

## Authentication & Authorization Strategy

**Authentication** (who you are): Supabase Auth. **Per-persona login method differs deliberately** — see the Persona Authentication Matrix below (added 2026-08-31, [DECISIONS.md ADR-053](DECISIONS.md#adr-053--customer-authentication-is-email-otp-staffownerplatform-remain-password)). `auth.users` → `profiles` 1:1 via a trigger on signup, for every persona regardless of login method.

### Persona Authentication Matrix

| Persona | Login method | Recovery method | Session authority | Business-identity linkage |
|---|---|---|---|---|
| **Customer** (portal) | Email OTP (`supabase.auth.signInWithOtp`/`verifyOtp`, `/portal/login`, `PortalLoginPage.tsx`) | Re-request a new OTP (no separate password to forget) | Standard Supabase session, same `auth.uid()` mechanism as every other persona | `customers.user_id` — set ONLY via the (now phone-corroboration-hardened) `claim_customer_self_service()`. OTP success alone never auto-creates or auto-claims a customer record; `RequirePortalCustomer` gates `/portal` on a real linkage existing. |
| **Staff** | Email + password (`supabase.auth.signInWithPassword`, shared `/login`, `LoginPage.tsx`) | `/forgot-password` → `supabase.auth.resetPasswordForEmail` (Supabase's built-in flow, ADR-041) | Standard Supabase session | `club_memberships` (role_id/custom_role_id, status, branch scope via `membership_branches`) |
| **Tenant Owner** | Email + password (same shared `/login`; `/signup` for first club creation via `complete_new_club_onboarding()`) | Same as Staff | Standard Supabase session | `club_memberships` with role `club_owner` |
| **Platform Staff** | Email + password (same shared `/login`; account created via the `platform-staff-admin` Edge Function's Admin API `createUser`+`generateLink({type:'recovery'})`, never emails a raw password) | Same as Staff | Standard Supabase session | `platform_staff_memberships` (a genuinely separate authorization domain from club-level `has_permission()`, by design) |
| **Platform Owner** | Email + password (same shared `/login`) | Same as Staff | Standard Supabase session | A `club_memberships` row with role key `platform_owner` — `is_platform_owner()` is a plain server-side table query, never a client-editable flag |

**Why the split**: only the customer persona has a large, low-trust, frequently-forgetful user base for whom password fatigue/reset friction is a real conversion cost — the exact use case Email OTP fits. Staff/tenant-owner/platform accounts are fewer, professionally managed, and already have a working, hardened password + Supabase-native reset flow (ADR-041) with no reported friction — migrating them to OTP would be a real, non-trivial UI change for personas the directive explicitly instructed not to disturb without cause. See ADR-053 for the full reasoning and alternatives considered.

**Authorization** (what you can do): entirely separate from authentication, for every persona. `club_memberships` (which club, which role) + `membership_branches` (which specific branches, or all if unset — see [DECISIONS.md ADR-015](DECISIONS.md#adr-015--membership-branch-scope-is-a-join-table-not-a-single-column)) + `role_permissions` (which role has which permission) decide access. **Authorization checks are always expressed as permission keys (e.g. `payment.refund`), never as role-key comparisons (`if role === 'accountant'`)** — see [DECISIONS.md ADR-014](DECISIONS.md#adr-014--permissions-not-role-keys-are-the-authorization-source-of-truth). Never encoded only in frontend route guards — those are UX convenience; RLS policies and RPC-internal permission checks are the actual gate, re-evaluated on every request from `auth.uid()`, never trusted from client-cached state.

See [RLS_MATRIX.md](RLS_MATRIX.md) for the full policy pattern and per-role permission table, and [RLS_SECURITY.md](RLS_SECURITY.md) for the mandatory `SECURITY DEFINER` function discipline.

## RLS Strategy

Every tenant-scoped table carries a denormalized `club_id` column (not just inferable via join) — this keeps RLS policies simple and fast. Core helper:

```sql
create or replace function auth.user_club_ids() returns setof uuid
language sql security definer stable
set search_path = public, pg_temp as $$
  select club_id from club_memberships
  where user_id = auth.uid() and status = 'active'
$$;
```

Every tenant table gets a `SELECT` policy filtering on `club_id in (select auth.user_club_ids())`, plus `INSERT`/`UPDATE` policies that additionally check `role_permissions` for the specific permission key via `auth.has_permission(permission_key, target_club_id)`. Financial tables have **no DELETE policy at all** — hard delete is impossible through RLS, not just discouraged by convention. **`audit_logs` additionally has no `UPDATE` policy for any role** (see [DECISIONS.md ADR-020](DECISIONS.md#adr-020--audit-logs-are-immutable-no-role-can-update-or-delete-them)).

Branch-scoped roles (Branch Manager, Receptionist) narrow further via `membership_branches` — a membership with zero rows there has access to all branches of its club; one or more rows restricts it to exactly those branches. Platform Owner bypasses per-club scoping through a distinct policy checked against a platform-level permission, not `user_club_ids()`.

**Every `SECURITY DEFINER` function pins `search_path` explicitly, re-verifies any client-supplied `club_id` against actual membership, resolves identity via `auth.uid()` only, checks the specific permission internally, and grants `EXECUTE` only to roles that need it.** This is not optional per-function discretion — see [RLS_SECURITY.md](RLS_SECURITY.md) for the full mandatory checklist, which every privileged function in this codebase must satisfy before merge.

Full matrix: [RLS_MATRIX.md](RLS_MATRIX.md). Full `SECURITY DEFINER` discipline: [RLS_SECURITY.md](RLS_SECURITY.md).

## Club Suspension Enforcement

`clubs.status` is `active` | `suspended` | `closed` — **an administrative decision only, never derived from or set based on platform billing lateness** (see [DECISIONS.md ADR-027](DECISIONS.md#adr-027--clubsstatus-and-platform-subscription-status-are-fully-independent-grace_period-is-never-a-club-status)). `clubs.status = 'suspended'` blocks all non-platform-owner access to that club's data; `closed` is a permanent, deliberate shutdown (data retained, not deleted). **This check happens at the RLS/RPC layer on every request, never by mutating or trusting a claim baked into the JWT** — a JWT issued before suspension remains structurally valid; what changes is that `auth.user_club_ids()` (and every downstream RLS policy and RPC permission check) re-evaluates the club's live `status` against the database on every call. A staff member with a still-valid session is locked out on their very next request after suspension, not just at their next login.

Platform subscription standing (`trial`/`active`/`grace_period`/`expired`/`cancelled`) is a **completely separate signal**, layered on top of `clubs.status` by `get_club_platform_access()` below — see [ARCHITECTURE.md](ARCHITECTURE.md#failure--recovery-strategy) for the full combined behavior table.

## Platform Access Strategy

Mala3by charging a club to use the platform is a **structurally separate domain** from a club's own customer billing — `platform_plans`/`platform_subscriptions`/`platform_invoices`/`platform_payments`, never `invoices`/`payments`/`payment_allocations` (see [DECISIONS.md ADR-028](DECISIONS.md#adr-028--platform-billing-is-a-structurally-separate-domain-from-club-billing)). Platform-Owner-only access; club-side roles (Club Owner only) see a read-only summary of their own club's subscription status via a restricted view, never the underlying tables (see [DECISIONS.md ADR-035](DECISIONS.md#adr-035--club-owner-subscription-visibility-is-scoped-own-clubs-commercial-summary-only)).

**Real billing intervals, snapshotted pricing** (see [DECISIONS.md ADR-029](DECISIONS.md#adr-029--platform-plan-supports-real-billing-intervals-monthly-quarterly-semi-annual-annual) and [ADR-030](DECISIONS.md#adr-030--platform-plan-pricing-is-snapshotted-onto-each-subscription-period)): `platform_plans` seeds Monthly/Quarterly/Semi-Annual/Annual (`interval` + `interval_count`, e.g. quarterly = `month × 3`), editable by Platform Owner at any time. Every `platform_subscriptions` row snapshots the plan's terms at creation (`plan_name_snapshot`, `price_snapshot`, `currency_snapshot`, `interval_snapshot`, `interval_count_snapshot`, `grace_period_days_snapshot`) — editing `platform_plans` later never changes an already-created period's terms.

**One subscription row per billing period, not one mutable row per club** (see [DECISIONS.md ADR-031](DECISIONS.md#adr-031--renewal-creates-a-new-subscription-period-row-periods-are-never-mutatedextended-in-place)): a renewal inserts a new `platform_subscriptions` row with `previous_subscription_id` pointing at the prior period, preserving full renewal history. Overlapping periods for the same club are prevented by the same exclusion-constraint pattern already used for `bookings`, while adjacent back-to-back renewals remain legal under `[)` range semantics (see [DECISIONS.md ADR-032](DECISIONS.md#adr-032--overlapping-subscription-periods-are-prevented-adjacent-renewal-periods-are-allowed)):

```sql
alter table platform_subscriptions add column during tstzrange
  generated always as (tstzrange(start_at, end_at, '[)')) stored;

alter table platform_subscriptions add constraint no_overlapping_subscription_periods
  exclude using gist (club_id with =, during with &&)
  where (lifecycle_status != 'cancelled');
```

**Effective subscription status is derived, never a scheduled-job-maintained flag** (V1 has no cron/scheduled-function infrastructure, deliberately, to stay zero-cost):

```sql
-- effective subscription status, computed from the current period row + now():
-- lifecycle_status = 'cancelled'            → cancelled
-- lifecycle_status = 'trial'                → trial
-- now() < end_at                            → active
-- end_at <= now() < end_at + grace_days     → grace_period
-- now() >= end_at + grace_days              → expired
```

**A single centralized function combines both signals** — `clubs.status` (administrative) and the derived subscription status (billing) — into one access level, so no table's RLS policy re-derives this logic independently (see [DECISIONS.md ADR-033](DECISIONS.md#adr-033--platform-access-is-full--grace--blocked-derived-by-one-centralized-db-function)):

```sql
create or replace function get_club_platform_access(p_club_id uuid)
returns text  -- 'full' | 'grace' | 'blocked'
language plpgsql security definer stable
set search_path = public, pg_temp as $$
declare
  v_club_status text;
  v_sub record;
begin
  select status into v_club_status from clubs where id = p_club_id;
  if v_club_status in ('suspended', 'closed') then
    return 'blocked';
  end if;

  select * into v_sub from platform_subscriptions
    where club_id = p_club_id and lifecycle_status != 'cancelled'
    order by start_at desc limit 1;

  if v_sub is null or v_sub.lifecycle_status = 'cancelled' then
    return 'blocked';
  elsif now() < v_sub.end_at or v_sub.lifecycle_status = 'trial' then
    return 'full';
  elsif now() < v_sub.end_at + (v_sub.grace_period_days_snapshot || ' days')::interval then
    return 'grace';
  else
    return 'blocked';  -- expired past grace
  end if;
end;
$$;

-- thin wrapper used by grace-gated write policies:
create or replace function auth.club_write_allowed(p_club_id uuid, p_action_category text)
returns boolean
language sql security definer stable
set search_path = public, pg_temp as $$
  select case get_club_platform_access(p_club_id)
    when 'full' then true
    when 'grace' then p_action_category in ('settle_existing', 'operational_continuity')
    else false  -- blocked
  end
$$;
```

`p_action_category` is `'new_commitment'` (blocked in `grace` — new `bookings`, `enrollments`, `subscriptions`, `groups`/`programs`, new field/branch expansion), `'settle_existing'` (allowed in `grace` — `payments`, `payment_allocations`, `refunds` against existing invoices/subscriptions), or `'operational_continuity'` (allowed in `grace` — `attendance` marking for already-scheduled sessions, completing already-created bookings). `SELECT` access is never restricted by this helper — `grace` and `full` read identically. Platform Owner is never subject to `get_club_platform_access()` — they retain full access to every club regardless of that club's own status, by a separate bypass policy (see [RLS_MATRIX.md](RLS_MATRIX.md)).

A manual `platform_payments` record, marking its `platform_invoices.status = 'paid'`, restores `full` access on the very next request — no separate status field to flip, since access is derived live from the period's dates each time.

**Trial is a `subscription_kind`, not a separate system** (see [DECISIONS.md ADR-038](DECISIONS.md#adr-038--trial-is-a-subscription_kind-not-a-new-concept-trial-expiry-defaults-to-blocked-not-automatic-conversion)). A trial period is a `platform_subscriptions` row exactly like a paid period — same exclusion constraint, same `get_club_platform_access()` derivation, same renewal-chain mechanism if it later converts to paid. The only differences: `subscription_kind = 'trial'`, `grace_period_days_snapshot = 0` (trial expiry goes straight from `full` to `blocked` — there is no "grace" concept for a period that was never paid for), `plan_id` is nullable (a trial has no underlying plan), and it never has a `platform_invoices`/`platform_payments` row. `end_at` is computed from `platform_settings.default_trial_days`, not a plan's interval. A database-level unique partial index (`WHERE subscription_kind = 'trial'`) guarantees a club can never have more than one non-cancelled trial, ever — enforced independently of the general exclusion constraint, which only prevents *overlapping* periods, not a second non-overlapping trial after the first one expired.

## Public Website & Layout Strategy

**Three fully separate layouts, never merged**, matching three fully separate authorization contexts:

- `PublicLayout` — the marketing site (`/`, `/pricing`, `/contact`, `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/terms`, `/privacy`). No authentication required. Reads only `public_plans` and `platform_settings.default_trial_days` — never any tenant-scoped or Platform-Owner-only table.
- `AppLayout` — the authenticated club-side application (`/app/*`). Requires an authenticated user with an active `club_memberships` row and `full`/`grace` platform access (see Route Guards below).
- `PlatformLayout` — the Platform Owner console (`/platform/*`). Requires an authenticated user holding the `platform_owner` role, independent of any club membership.

A user who is both a Platform Owner and a club member (uncommon but possible) switches between `AppLayout` and `PlatformLayout` explicitly — the two contexts are never blended into one navigation.

**Public data exposure is minimal and view-gated**: the public site never queries `platform_plans`, `clubs`, `platform_subscriptions`, or any club-side table directly — only `public_plans` (a narrow, explicit-column view — see [DECISIONS.md ADR-040](DECISIONS.md#adr-040--public-plan-data-is-exposed-through-a-restricted-viewrpc-never-the-raw-platform_plans-table)) and a similarly narrow read of `platform_settings.default_trial_days`. The `contact_requests` table accepts anonymous `INSERT` only — no anonymous `SELECT`, so a submitter can never enumerate other submissions.

**No fake checkout language** (see [DECISIONS.md brief](../README.md) Section 44): the public site never presents "Buy Now"/"Checkout"/"Pay" — every plan CTA is "ابدأ تجربتك المجانية" (Start your free trial), since there is no online payment gateway to check out through. Post-trial, the messaging is "تواصل معنا لتفعيل الاشتراك" (contact us to activate) or an in-app "renewal pending Platform Owner activation" state — never an implied self-service purchase flow that doesn't exist.

## Signup & Onboarding Strategy

**Atomic finalization via one RPC** — `complete_new_club_onboarding()` (see [DECISIONS.md ADR-042](DECISIONS.md#adr-042--onboarding-finalization-is-one-atomic-rpc-client-never-sets-privileged-values)) — creates `clubs`, the first `branches` row, and the `club_memberships` row (role hardcoded to `club_owner`) **unconditionally** — a user is never blocked from creating an additional club. The trial `platform_subscriptions` row, by contrast, is created **only if the calling user has never consumed an automatic trial before** (see [DECISIONS.md ADR-051](DECISIONS.md#adr-051--automatic-trial-entitlement-is-one-per-user-account-enforced-via-a-dedicated-concurrency-safe-entitlement-table)) — club creation succeeding and trial creation succeeding are two independent outcomes of the same transaction, not one combined pass/fail:

```sql
create or replace function complete_new_club_onboarding(
  p_business_type text,
  p_club_name text,
  p_club_name_ar text,
  p_branch_name text,
  p_city text,
  p_phone text,
  p_owner_email text,      -- for the entitlement snapshot only, not for auth
  p_owner_mobile text       -- for the entitlement snapshot only, not for auth
) returns table(club_id uuid, trial_granted boolean)
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_club_id uuid;
  v_branch_id uuid;
  v_trial_days int;
  v_trial_granted boolean := false;
begin
  -- caller must be authenticated; auth.uid() is the only identity source, never a parameter
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  -- club + branch + owner membership: always created, unconditionally.
  -- Owning multiple clubs is explicitly allowed (see DECISIONS.md ADR-051) --
  -- this is not a "does the user already have a club" gate.
  insert into clubs (name, name_ar, status) values (p_club_name, p_club_name_ar, 'active')
    returning id into v_club_id;

  insert into branches (club_id, name, address, status)
    values (v_club_id, p_branch_name, p_city, 'active') returning id into v_branch_id;

  insert into club_memberships (user_id, club_id, role_id, status)
    values (auth.uid(), v_club_id, (select id from roles where key = 'club_owner'), 'active');

  -- Automatic trial: attempt to consume the one-per-user entitlement.
  -- The unique constraint on automatic_trial_entitlements.user_id IS the
  -- concurrency guard -- no separate SELECT-then-INSERT check beforehand.
  begin
    insert into automatic_trial_entitlements (
      user_id, club_id, owner_normalized_mobile_snapshot, owner_email_snapshot, consumed_at
    ) values (
      auth.uid(), v_club_id, normalize_mobile(p_owner_mobile), lower(p_owner_email), now()
    );
    v_trial_granted := true;
  exception when unique_violation then
    -- user already consumed their one automatic trial on an earlier club.
    -- This is NOT a transaction failure -- club creation still succeeds.
    v_trial_granted := false;
  end;

  if v_trial_granted then
    select default_trial_days into v_trial_days from platform_settings limit 1;

    insert into platform_subscriptions (
      club_id, subscription_kind, trial_origin, plan_name_snapshot, price_snapshot,
      grace_period_days_snapshot, start_at, end_at, lifecycle_status
    ) values (
      v_club_id, 'trial', 'automatic', 'تجربة مجانية', 0,
      0, now(), now() + (v_trial_days || ' days')::interval, 'trial'
    );
  end if;

  return query select v_club_id, v_trial_granted;
end;
$$;
```

Every privileged value — `role_id = club_owner`, `subscription_kind = 'trial'`, `trial_origin = 'automatic'`, `grace_period_days_snapshot = 0`, trial duration from `platform_settings`, and trial eligibility itself — is **derived inside the function, never accepted as a client parameter**. This is the critical security property: unlike every other privileged RPC in this system, this one is reachable by a user with *no* existing `club_memberships` row to validate against, so the function body itself is the entire trust boundary (see [DECISIONS.md ADR-042](DECISIONS.md#adr-042--onboarding-finalization-is-one-atomic-rpc-client-never-sets-privileged-values) and [RLS_SECURITY.md](RLS_SECURITY.md) for the general `SECURITY DEFINER` discipline this follows).

**The function returns an explicit `trial_granted` flag** rather than only a `club_id` — the frontend uses this to show one of two onboarding-completion states, never inferring it from a subsequent query: `trial_granted = true` → "تم إنشاء ناديك بنجاح، تم تفعيل التجربة المجانية" (Trial Activated); `trial_granted = false` → "تم إنشاء النادي — الاشتراك مطلوب" (Club Created — Subscription Required), with a "Choose a plan / Contact Mala3by" action. Neither outcome is an error state — both are successful, known business outcomes.

**Business type is a classification label only** (`نادي`/`أكاديمية`/`ملاعب`/`مركز رياضي`) — stored for reporting/segmentation, never branches Core Architecture. A club of any business type gets the identical schema, RLS, and feature set.

**Duplicate detection is advisory, not blocking** (see [DECISIONS.md ADR-045](DECISIONS.md#adr-045--duplicate-club-detection-flags-for-review-never-hard-blocks-signup)) — a normalized-name/phone/email match sets a flag visible to Platform Owner, never rejects the signup. This is separate from the trial entitlement check: a flagged club still creates normally, and its automatic-trial outcome is decided purely by the user's entitlement state.

**First-run setup is a dismissible checklist**, not a continuation of the mandatory wizard (see [DECISIONS.md ADR-043](DECISIONS.md#adr-043--first-run-setup-is-a-checklist-not-a-multi-step-wizard)): add a field, add a staff member, add a first customer, create a first booking — each independently completable in any order, sourced from simple existence checks (`EXISTS (SELECT 1 FROM fields WHERE club_id = ...)`, etc.) rather than a stored progress state.

**The trial clock starts at club creation, not first use** — `platform_subscriptions.start_at = now()` inside the onboarding RPC, regardless of whether the club immediately creates a booking or waits three days to explore the product.

**Platform Owner manual override** — a club that didn't receive an automatic trial (or any club at all) can still be granted a trial or complimentary access by Platform Owner via the existing `create_platform_subscription(...)` RPC (see [Platform Access Strategy](#platform-access-strategy)) with `subscription_kind = 'trial'` and `trial_origin = 'manual'`, or `subscription_kind = 'complimentary'`. This path is entirely independent of `automatic_trial_entitlements` — Platform Owner can grant a manual trial to a club whose owner already consumed their automatic trial elsewhere, since the entitlement table only ever gates the *automatic* signup path. Every manual grant is logged to `audit_logs` with actor/club/reason/`start_at`/`end_at`/`subscription_kind` — never silent (see [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md#audit-log-coverage)).

## Booking Engine Strategy

Day-view grid (rows = time slots derived from field duration + operating hours, columns = fields), computed from a single query per date range — no per-cell fetch.

Double-booking is prevented at the database layer via a PostgreSQL exclusion constraint (see [DECISIONS.md ADR-007](DECISIONS.md#adr-007--double-booking-prevention-via-postgresql-exclusion-constraint) and [ADR-021](DECISIONS.md#adr-021--exclusion-constraint-covers-pending_payment-confirmed-and-checked_in)):

```sql
alter table bookings add column during tstzrange
  generated always as (tstzrange(start_at, end_at, '[)')) stored;

alter table bookings add constraint no_overlapping_bookings
  exclude using gist (field_id with =, during with &&)
  where (status in ('pending_payment', 'confirmed', 'checked_in'));
```

The constraint blocks on `pending_payment`, `confirmed`, and `checked_in` — a booking awaiting payment still holds the slot, closing the race window that would otherwise exist between "slot picked" and "payment confirmed." `completed` is excluded because a completed booking's time range is necessarily in the past and cannot structurally conflict with a new booking; `cancelled`/`no_show` are excluded because they explicitly freed the slot. `[)` semantics confirmed: `10:00–11:00` and `11:00–12:00` do not overlap.

This holds against every write path, not just the RPC the app author remembers to guard. Booking creation still goes through an RPC (`create_booking`) for atomicity across booking + invoice + invoice_item + (optionally) payment + payment_allocation, but conflict-proofing itself lives in the constraint.

**Transaction boundary:** the atomic core is `validate availability → create booking → create invoice → optionally create payment → create payment allocation → commit`. QR credential creation is **not** inside this same transaction as a hard dependency — it happens either within the same transaction if it's a pure DB-local token insert with no external dependency, or immediately after as a separate, idempotent step exposed as `ensure_booking_qr(booking_id)`. A QR generation failure never rolls back or blocks a financially-valid booking; "Regenerate QR" is always safely re-callable. See [DECISIONS.md ADR-011e](DECISIONS.md#adr-011e--qr-scan-validates-explicit-staff-confirmation-performs-the-check-in-mutation) for how this connects to check-in.

**No direct client `INSERT` into `bookings` for the primary operational flow** — every booking creation goes through `create_booking`, which performs the full validation chain (auth, membership, permission, platform access, field/hours/blocks, price recomputation, discount authorization, customer validity) before the row is written. See [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md#booking-security) for the exact ordered checklist and [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md#price-security) for why the price shown to the client during selection is a preview only, never the value actually charged.

## Recurring Booking Strategy

A recurring booking (e.g. "every Tuesday 20:00–21:00 for 8 weeks") produces **N real `bookings` rows**, each independently subject to the exact same exclusion constraint, pricing recomputation, permission checks, and audit trail as a single manually-created booking — never a single row with a lazily-expanded pattern. An optional `booking_series` row links the occurrences for "view/manage the rest of this series" UX only; it is never a data-integrity or conflict-checking structure, and the exclusion constraint is never bypassed for series members (see [DECISIONS.md ADR-047](DECISIONS.md#adr-047--recurring-booking-is-a-linking-table-over-real-individual-booking-rows-never-a-shortcut-around-conflict-checking)).

**Conflict handling is explicit, never silent:** before confirming, the creation RPC checks all N requested occurrences against the exclusion constraint and returns the result to the UI (e.g. "8 requested, 7 available, 1 conflict"). The user then explicitly chooses — create the available occurrences only, or cancel and review conflicts first — but the system never silently creates a partial series without the user knowing exactly what happened.

Cancelling a series does not cascade a silent bulk mutation — each linked booking is cancelled individually through the normal cancellation flow (permission check, mandatory reason, audit entry per booking), even when initiated "for the whole series" from a UI convenience action.

**Billing granularity: one independent financial lifecycle per occurrence, confirmed final** (see [DECISIONS.md ADR-052](DECISIONS.md#adr-052--recurring-booking-billing-granularity-one-financial-lifecycle-per-occurrence-no-series-level-invoice-in-v1)). Series creation does **not** auto-generate N invoices as a side effect — each occurrence's invoice is issued through the normal `create_booking`/billing flow, whenever that occurrence is actually processed, exactly like a standalone booking. Each occurrence can independently be paid, cancelled, marked no-show, or refunded with zero effect on any other occurrence in the series. No `series_invoice` concept exists in V1. If a customer prepays for multiple occurrences, the existing `payment_allocations` many-to-many model handles it without any schema change: one `payments` row, N `payment_allocations` rows (one per occurrence's invoice) — `payment_allocations` remains the sole payment↔invoice relationship, `payments.invoice_id` is never reintroduced.

## Outstanding Payments Strategy

`/app/outstanding` (or an equivalent Billing sub-view) is a **read-only projection over the existing financial ledger** — `outstanding = invoice.total − valid payment_allocations + refund/reversal effect`, computed live by the `outstanding_invoices` view, using the exact same derivation already used everywhere else outstanding balance appears (booking detail, subscription detail, financial reports). See [DECISIONS.md ADR-048](DECISIONS.md#adr-048--outstanding-payments-is-a-single-ledger-derived-view-not-a-new-stored-value) — no new stored "outstanding" value is introduced anywhere in the schema. Filters (All / Due Today / Overdue / Academy / Bookings) apply at the query layer against this same view, never a separately-maintained dataset.

## Quick Field Block Strategy

A "Block Field" action from the Booking Calendar (Start, End, Reason, Type) inserts a `field_blocks` row, which the exclusion-constraint-adjacent availability logic then treats as unavailable for new bookings. **Creating a block never silently cancels an existing booking that falls inside the block window.** The creation RPC checks for overlapping non-cancelled `bookings` first; if any exist, it returns them to the UI (e.g. "3 existing bookings conflict") and requires an explicit follow-up decision — the manager either adjusts the block window or cancels the conflicting bookings individually through the normal cancellation flow (permission + reason + audit) — before the block is created. See [DECISIONS.md ADR-049](DECISIONS.md#adr-049--quick-field-block-requires-explicit-confirmation-when-existing-bookings-conflict).

## Billing & Financial Integrity Strategy

**`payments` has no `invoice_id` column.** The only relationship between a payment and the invoice(s) it funds is `payment_allocations(payment_id, invoice_id, amount)` — this bridges `payments` and `invoices` many-to-many, so a single payment can fund multiple invoices or partially fund one (e.g. a walk-in payment covering both today's booking and an old balance). See [DECISIONS.md ADR-011b](DECISIONS.md#adr-011b--paymentsinvoice_id-removed-payment_allocations-is-the-only-payment-invoice-relationship) — this corrects an internal contradiction in an earlier draft that had both a direct `payments.invoice_id` column and `payment_allocations` as competing sources of truth for the same relationship.

Outstanding balance is always `invoice.total - SUM(payment_allocations.amount) + SUM(applicable refunds)`, computed at query time — never a hand-maintained `amount_paid`/`amount_remaining` column on `invoices` or `subscriptions` (see [PROJECT_RULES.md](PROJECT_RULES.md) rule 8).

`SUM(payment_allocations.amount) per payment_id` is enforced by trigger to never exceed `payments.amount`.

**Refunds** (see [DECISIONS.md ADR-011c](DECISIONS.md#adr-011c--refund-model-refunds-table--reversing-allocation-atomic-rpc)) never mutate `payments.amount` and never delete the payment. A single atomic RPC:

```sql
-- inside one transaction:
-- 1. validate: p_amount <= (payment.amount - sum of prior completed refunds for this payment)
-- 2. insert into refunds (payment_id, amount, reason, refunded_by, refunded_at)
-- 3. insert a reversing payment_allocations adjustment so derived outstanding balance reflects it
-- 4. insert audit_logs entry
-- 5. commit
```

This guarantees: original payment unchanged, partial refunds supported, multiple refunds against one payment cannot exceed its refundable balance (checked inside the same transaction as the insert — no TOCTOU gap), every refund has actor/time/reason, balance is always derivable from the ledger, the whole operation is atomic, and an audit entry always exists.

Invoice numbering is concurrency-safe via a single-row `UPDATE ... RETURNING` inside an RPC (row-level locking makes concurrent calls serialize automatically):

```sql
update invoice_number_sequences
  set last_number = last_number + 1
  where branch_id = p_branch_id and year = p_year
  returning last_number into v_next;

select club_code into v_club_code from clubs where id = v_club_id;
select branch_code into v_branch_code from branches where id = p_branch_id;
-- v_invoice_number := v_club_code || '-' || v_branch_code || '-' || v_year || '-' || lpad(v_next::text, 6, '0');
```

Format: `{club_code}-{branch_code}-{YEAR}-{000001}` (per-branch sequence — see [DECISIONS.md ADR-009](DECISIONS.md#adr-009--invoice-numbering-is-per-branch)). **`club_code`/`branch_code` are read from `clubs`/`branches` at generation time — no prefix is hardcoded in function logic.** Unique constraint on `(branch_id, invoice_number)` is verified under a concurrency test (see [TEST_PLAN.md](TEST_PLAN.md)).

**Reports and dashboards never recompute these figures independently in the frontend.** Revenue, outstanding, refunded, and collected figures always come from the same underlying RPC/view definition, so a dashboard number and a report number for the same metric can never diverge (see [Reporting Strategy](#reporting-strategy) below).

## Subscription Activation & Effective Expiry

**Activation policy is a club setting, not a hardcoded rule** (see [DECISIONS.md ADR-013](DECISIONS.md#adr-013--subscription-activation-policy-is-a-club-setting-not-a-hardcoded-rule)). `clubs.subscription_activation_policy` is `manual` | `first_payment` | `full_payment` (default `first_payment`). The subscription-activation RPC branches on this value:

```
manual        → status only ever moves to 'active' via an explicit staff action, payment received or not
first_payment → status moves to 'active' as soon as payment_allocations for this subscription's invoice(s) sum > 0
full_payment  → status moves to 'active' only once payment_allocations sum >= subscription price net of discount
```

**One subscription belongs to exactly one enrollment** — `subscriptions.enrollment_id` is a required, unique FK (see [DECISIONS.md ADR-013b](DECISIONS.md#adr-013b--one-subscription--one-enrollment-in-v1-is-a-deliberate-rule)). This is a deliberate V1 business rule, not a limitation to work around.

**Effective expiry after freeze** is always derived, never overwrites the original `subscriptions.end_date`:

```sql
-- effective_end_date, computed by RPC/view, not stored:
select
  s.end_date
  + coalesce(sum(f.end_date - f.start_date) filter (where f.extends_expiry), interval '0')
    as effective_end_date
from subscriptions s
left join subscription_freezes f on f.subscription_id = s.id
where s.id = p_subscription_id
group by s.end_date;
```

This preserves `end_date` as a permanent, auditable original fact while correctly gating access via the derived `effective_end_date`. See [DECISIONS.md ADR-008](DECISIONS.md#adr-008--subscription-freeze-extends-expiry-by-default) for the `extends_expiry` default.

## QR Strategy

Open-source only: `qrcode` for generation, `@zxing/browser` or `html5-qrcode` for camera scanning — no external QR service.

QR encodes an opaque 256-bit random token, never a database ID. The server stores only `SHA-256(token)`. **Consumption behavior now varies by credential type** (see [DECISIONS.md ADR-011d](DECISIONS.md#adr-011d--player-qr-is-reusable-booking-qr-is-consumable-scans-are-a-separate-log)):

- **`player_membership` credentials are reusable** (`single_use = false`) — a coach scans a player's QR every training day for attendance; scanning validates and logs the event but never consumes/mutates the credential.
- **`booking` credentials are typically single-use** (`single_use = true`), but — critically — **scanning alone does not consume them.** Scan = validate + display only. A separate, explicit staff "Confirm Check-in" action performs the atomic consume + state mutation together (see [DECISIONS.md ADR-011e](DECISIONS.md#adr-011e--qr-scan-validates-explicit-staff-confirmation-performs-the-check-in-mutation)):

```sql
-- validate (scan) — read-only, no mutation:
select * from qr_credentials
where token_hash = $1 and status = 'active' and expires_at > now() and club_id = v_caller_club_id;

-- confirm check-in (separate RPC, called only after staff taps "Confirm") — atomic consume + mutate:
with consumed as (
  update qr_credentials
    set status = 'consumed', used_at = now(), used_by = auth.uid()
    where token_hash = $1 and status = 'active' and expires_at > now()
    returning reference_id
)
update bookings set status = 'checked_in'
where id = (select reference_id from consumed)
returning *;
```

Zero rows returned from the consume step means already-consumed or invalid — replay protection by construction, no separate check-then-update race. See [DECISIONS.md ADR-005](DECISIONS.md#adr-005--qr-tokens-are-opaque-random-values-hashed-at-rest).

**Every scan is logged to `qr_scan_events`** — successful, replayed, expired, wrong-club, or invalid — independent of whatever happened (or didn't) to the credential. `qr_credentials.used_at`/`used_by` remain a convenience "last use" snapshot; `qr_scan_events` is the actual audit/replay/attendance trail (see [DECISIONS.md ADR-011d](DECISIONS.md#adr-011d--player-qr-is-reusable-booking-qr-is-consumable-scans-are-a-separate-log)).

**Invoice QR**, if used, is explicitly a lookup/verification reference — never an access credential, never a `qr_credentials` row in the access-control sense, and scanning it never consumes anything.

**Offline handling:** scanning fails closed — no network, no automated check-in. Staff can perform a manual override with a mandatory reason, logged to `audit_logs`. This is safer than fail-open while still giving staff a path forward when connectivity is patchy.

## Printing Strategy

No PDF library, no print server. Browser `window.print()` with two `@media print` stylesheets: one for A4 (`@page { size: A4 }`), one for 80mm thermal (`@page { size: 80mm auto; margin: 2mm }`). Same invoice data, two layouts, zero external dependency.

## Reporting Strategy

No BI tool. Reports are parameterized SQL views/RPCs (e.g. `get_revenue_report(club_id, date_range, group_by)`) returning JSON, rendered with existing table/chart components. Each report ships in the implementation phase that owns its underlying data (revenue reports land with billing, academy reports with academy) rather than one late catch-all reporting phase.

**Export:** CSV only in V1 — a client-side string build + browser download, no export library, no external service (XLSX only if achievable with a small dependency-free approach; otherwise deferred). Export always applies the same `club_id`/`branch_id`/permission scoping and active filters as the on-screen report — a URL/parameter manipulation attempt to export another club's data goes through the identical RLS-scoped query as viewing it, so it's rejected the same way (see [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md#multi-tenant-security)). Not every report supports export in V1 — only the specific reports listed in [SCREEN_MAP.md](SCREEN_MAP.md)/[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), never a blanket "export everything" claim.

**Quick Actions:** desktop supports a keyboard shortcut (Ctrl/Cmd+K) or a clearly visible button opening a small palette — New Booking, New Customer, Collect Payment, Scan QR, Find Invoice. This is a desktop convenience only; mobile is not required to support a command palette (its bottom navigation + prominent Scan action already serves the equivalent purpose).

## PWA Strategy

`vite-plugin-pwa` + Workbox. Caches **app shell and static assets only** — no offline database, no offline mutation queue. Service worker: `NetworkFirst` for API calls (financial data is never served stale silently), `CacheFirst` for static assets. If network drops during a financial operation, the operation is not considered successful until the database confirms it — no optimistic "success" UI for money (see [PROJECT_RULES.md](PROJECT_RULES.md) and the failure-scenario table below).

## Deployment Strategy

> **⚠️ Currently LOCAL ONLY.** Per an explicit, current directive, everything below describing GitHub push, Cloudflare Pages, and production Supabase is the *target* end-state, not an action to take now. `git init`, local commits, local branches, and local history are the only permitted git operations until a separate, explicit go-ahead is given. **`git push`, GitHub repo creation, GitHub Actions, Cloudflare deployment, and production Supabase are all blocked until then** — see [PROJECT_RULES.md](PROJECT_RULES.md) rule 5b.

Target end-state (not yet authorized): Local → GitHub (manual push) → Cloudflare Pages (connected to `main`, auto-builds on push) → environment variables (Supabase URL + anon key) set in the Cloudflare dashboard, never committed. Supabase migrations deployed separately via `supabase db push` against the linked remote project — deliberately decoupled from the frontend deploy, so a schema change is a reviewed, explicit action rather than a side effect of a frontend push.

**Rollback (target end-state):** Cloudflare Pages keeps prior deploys one click away. Supabase migrations are forward-only, with manually written down-migrations for anything genuinely reversible.

**Environments (target end-state):** local (Supabase CLI via Docker) → production (hosted Supabase project). No independent paid staging environment in V1 — a second free-tier Supabase project can serve as staging if/when needed, without cost.

## Local Development Workflow

```
supabase start   # local Postgres + Auth + Storage
npm install
npm run dev
```

Loop: edit → local test (`vitest` + `supabase test db`) → local build (`npm run build`) → review `git diff` → local stable commit → **stop** (no push). No step touches production, and no step pushes to a remote. See [PROJECT_RULES.md](PROJECT_RULES.md) rule 5/5b and [TEST_PLAN.md](TEST_PLAN.md).

## Money, Currency & Timezone Conventions

- **All money columns are `numeric(12,2)`**, never `float`/`double` — floating-point binary representation cannot exactly represent decimal currency values, which silently corrupts totals over enough operations (see [DECISIONS.md ADR-016](DECISIONS.md#adr-016--money-is-numeric1220-never-floatdouble)).
- **Single currency per club, no multi-currency in V1.** `clubs.currency` is the one operating currency; `payments`/`invoices` do not carry their own currency column (see [DECISIONS.md ADR-017](DECISIONS.md#adr-017--single-currency-per-club-no-multi-currency-in-v1)).
- **All timestamps are `timestamptz`**, never naive local timestamps. `clubs.timezone` (default `Africa/Cairo`) governs *display* only — storage is always UTC-normalized under the hood (see [DECISIONS.md ADR-018](DECISIONS.md#adr-018--all-timestamps-are-timestamptz-club-owns-a-display-timezone)).

## Performance Principles

- No per-cell/per-row queries in loops (booking grid fetches once per date range, not once per slot)
- Pagination on any list that can grow past ~50-100 rows
- No `SELECT *` across joins without a defined column set in hot paths
- Realtime subscriptions used sparingly and only where staleness is operationally unacceptable (e.g. live booking grid during peak hours), not by default on every list

## Zero-Cost Architecture Review

| Service | Why needed | Free tier | At limit | Avoidable? | Replacement |
|---|---|---|---|---|---|
| Supabase | DB, Auth, Storage, RPC | 500MB DB, 50k MAU, 1GB storage, 2GB bandwidth/mo | Upgrade to Pro (~$25/mo) — only once a real paying club outgrows it | No — core dependency | — |
| Cloudflare Pages | Static hosting | Unlimited requests, 500 builds/mo | Effectively never hit for this app | No | — |
| `qrcode` / `@zxing/browser` | QR generation/scanning | Open source npm packages, no service | N/A | N/A | — |
| `vite-plugin-pwa` | PWA/offline shell | Open source | N/A | N/A | — |
| GitHub | Source control | Free for private repos | N/A | No | — |
| Browser print (`window.print`) | Invoices, A4 + 80mm | Native, free | N/A | No | — |
| Supabase Auth built-in email (verification, password reset) | Signup verification, forgot-password flow | Included free with Supabase Auth, rate-limited | If limits are hit or delivery proves unreliable, verification becomes a soft prompt, never a hard gate (see [DECISIONS.md ADR-041](DECISIONS.md#adr-041--email-verification-uses-supabase-auths-built-in-flow-no-paid-email-provider-dependency)) | Yes — verification is never load-bearing for trial start | No paid provider added; degrade gracefully instead |
| Signup rate limiting | Trial-abuse mitigation | DB-level checks (per-IP/per-time-window counts via a table or Postgres logic), no external service | N/A | N/A — this is DB logic, not a service | Cloudflare Turnstile noted as a possible free future addition, not a V1 dependency |
| CSV export | Reports export | Native browser CSV generation (client-side string build + download), no library, no export service | N/A | N/A | XLSX only if achievable with a small open-source client-side library with no server dependency — CSV alone is sufficient for V1, per [DECISIONS.md](DECISIONS.md) brief Section 43 |
| Icon library, `IBM Plex Sans Arabic` / `Inter` fonts | Design System (see [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)) | Open source / open license, self-hosted or bundled, no paid font/icon service | N/A | N/A | — |

**Projected V1 monthly cost: 0 EGP**, until Supabase free-tier limits are hit — comfortably beyond a single pilot club's real usage. First paid step, when it arrives, is Supabase Pro (~$25/mo), never earlier than actually needed. The public site and trial signup add zero new paid dependencies — every new capability (public plan display, contact form, email verification, rate limiting) is either pure database logic or already-included Supabase Auth functionality. The Final Pre-Implementation Directive's additions (Recurring Booking, Outstanding Payments, Quick Field Block, Export, Design System) add zero new paid dependencies — all are pure database/frontend logic or open-source assets.

## Security Threat Review

> **See [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md) for the full business-abuse threat model** (booking fraud, financial fraud, QR abuse, the Abuse Test Catalogue, and the per-phase Security Gate). The list below covers infrastructure/platform-level threats; SECURITY_ANTI_FRAUD.md covers domain-specific abuse scenarios.

- **Cross-tenant IDOR:** closed by RLS `club_id in user_club_ids()` on every tenant table, tested explicitly per table (Club A user cannot SELECT/INSERT/UPDATE Club B rows via any path, including a raw PostgREST call bypassing the UI).
- **Privilege escalation:** `role_permissions` is not editable by any role below Platform Owner. `club_memberships.role_id` changes require the `staff.update` permission and are logged to `audit_logs`.
- **QR forgery:** 256-bit random tokens, hashed at rest, computationally infeasible to guess or reverse from the hash.
- **Service role key exposure:** never shipped to the frontend. Only the anon/publishable key ships. Privileged multi-table operations go through `SECURITY DEFINER` RPCs that still re-check `auth.uid()` membership internally — they bypass table-level RLS to write atomically across tables, not authorization itself. See [RLS_SECURITY.md](RLS_SECURITY.md) for the full mandatory discipline (`search_path` pinning, no trusting client-supplied `club_id`, `auth.uid()`-only identity, internal permission checks, scoped `EXECUTE` grants, cross-tenant tests).
- **Storage policy:** player/club photos live in Supabase Storage buckets with policies mirroring `club_id` membership — not public by default.
- **Financial mutation integrity:** no DELETE RLS policy exists on `payments`/`invoices`/`refunds` at all — even a compromised service-role misuse is bounded by what an explicit function allows.
- **Audit log tampering:** no `UPDATE`/`DELETE` policy exists on `audit_logs` for any role, including Club Owner and Platform Owner — the trail is immutable through every client-facing path (see [DECISIONS.md ADR-020](DECISIONS.md#adr-020--audit-logs-are-immutable-no-role-can-update-or-delete-them)).
- **Sensitive field exposure:** `players.medical_notes` is gated behind `player.medical_notes.view`/`.update`, not visible to Receptionist by default, never in global search results (see [DECISIONS.md ADR-019](DECISIONS.md#adr-019--medical-notes-are-a-permission-gated-field-not-a-default-visible-one) and [RLS_SECURITY.md](RLS_SECURITY.md#sensitive-column-protection-medical_notes)).
- **Accidental QR check-in:** scanning a booking QR never mutates state by itself — an explicit staff "Confirm Check-in" is required, preventing an accidental camera pass from silently checking a customer in (see [DECISIONS.md ADR-011e](DECISIONS.md#adr-011e--qr-scan-validates-explicit-staff-confirmation-performs-the-check-in-mutation)).
- **Public signup privilege escalation:** `complete_new_club_onboarding()` derives `role_id = club_owner`, `subscription_kind = 'trial'`, `grace_period_days_snapshot = 0`, and trial duration entirely server-side — no client-supplied value can request `platform_owner`, a `paid`/`complimentary` subscription, or a non-default trial length (see [DECISIONS.md ADR-042](DECISIONS.md#adr-042--onboarding-finalization-is-one-atomic-rpc-client-never-sets-privileged-values)).
- **Trial abuse (per club):** a database-level unique partial index guarantees at most one trial per club, ever — adding a second user to a club cannot create a second trial (see [DECISIONS.md ADR-039](DECISIONS.md#adr-039--trial-belongs-to-the-club-not-the-user-one-trial-per-club-ever)).
- **Trial abuse (per user, via multiple clubs):** a single user creating unlimited clubs to harvest unlimited automatic trials is closed by `automatic_trial_entitlements`' unique `user_id` constraint — the second onboarding call from the same user still creates a club successfully but never a second automatic trial (see [DECISIONS.md ADR-051](DECISIONS.md#adr-051--automatic-trial-entitlement-is-one-per-user-account-enforced-via-a-dedicated-concurrency-safe-entitlement-table)). **Residual risk, explicitly accepted for V1**: a determined abuser can still create new user accounts (new email/auth identity) to reset this — defending against that requires device/phone/CAPTCHA-level tooling explicitly out of scope; this is a known, bounded gap, not an unaddressed one. Lightweight rate limiting and advisory duplicate-detection (never a hard block) cover the mass-fake-signup case at V1's proportional risk level (see [DECISIONS.md ADR-046](DECISIONS.md#adr-046--signup-rate-limiting-and-duplicate-club-flagging-are-lightweight-not-blocking)).
- **Public data leakage:** anonymous/public roles can `SELECT` only `public_plans` (an explicit narrow-column view, never the base `platform_plans` table) and `INSERT`-only on `contact_requests` (no `SELECT` — a submitter cannot enumerate other leads). No public role ever reads `clubs`, `platform_subscriptions`, or any club-side operational table (see [DECISIONS.md ADR-040](DECISIONS.md#adr-040--public-plan-data-is-exposed-through-a-restricted-viewrpc-never-the-raw-platform_plans-table)).

## Failure & Recovery Strategy

| Scenario | System behavior |
|---|---|
| DB migration fails mid-deploy | Migrations tested locally first, applied to prod as a single transaction-wrapped file; failure rolls back, prod stays on prior schema version |
| Payment recorded but invoice creation fails | Both happen inside one RPC transaction — either both commit or neither does |
| Invoice created but QR generation fails | QR generation is a separate, retryable step after the financial transaction commits (`ensure_booking_qr`, idempotent); a "Regenerate QR" action is always available |
| Two employees book the same slot | Exclusion constraint (blocking on `pending_payment`/`confirmed`/`checked_in`) rejects the second INSERT; UI shows "slot just taken, pick another" |
| Two devices scan the same booking QR | Scan itself never mutates — only "Confirm Check-in" does, atomically (`UPDATE ... WHERE status = 'active'`); only the first confirm succeeds, the second sees "Already Checked In" with original timestamp + staff member, and both scan attempts are recorded in `qr_scan_events` regardless of outcome |
| Network disconnect during payment | UI shows pending/unconfirmed until the RPC response returns; no optimistic success state for money |
| User's permission is revoked mid-session | Every mutation re-checks RLS/RPC permission server-side using current `auth.uid()` state — a stale frontend session cannot act on a revoked permission |
| Club is disabled by Platform Owner (manual suspension or closure) | `clubs.status = 'suspended'` or `'closed'` — an administrative decision, independent of billing; RLS for non-platform-owner roles requires `status = 'active'`, re-checked on every request (not via JWT mutation) — all staff of that club are locked out on their next request, data retained (no deletes), reactivation available for `suspended` |
| Club's platform subscription lapses (unpaid, `clubs.status` unaffected) | `get_club_platform_access()` returns `grace` for up to the period's `grace_period_days_snapshot` (default 7, per-club/period overridable) past `end_at` — staff retain read access and can still settle existing payments/attendance/complete existing bookings but cannot create new bookings/enrollments/subscriptions (see [Platform Access Strategy](#platform-access-strategy)); returns `blocked` (full operational lockout, `clubs.status` itself still unchanged) once the grace window elapses, computed live on every access, not via a scheduled job; a manual `platform_payments` record at any point restores `full` access immediately, next request |
| Subscription expires mid-session | The in-progress session's attendance is unaffected; the *next* session's enrollment check flags expired status (via the derived `effective_end_date`) and blocks further attendance until renewed |
| Two receptionists enroll the last group spot simultaneously | Enrollment RPC locks the `groups` row (`SELECT ... FOR UPDATE`) and re-checks capacity inside the same transaction as the insert — only one enrollment succeeds, the second sees "Group is full" |
| Club's 7-day trial expires with no paid plan activated | `get_club_platform_access()` returns `blocked` immediately at `end_at` — trial's `grace_period_days_snapshot = 0` means no grace window, unlike a paid subscription; data fully retained, staff see a clear "trial expired, contact us to activate" state, Platform Owner sees it in the Trials report and can activate a paid plan at any time to restore access |
| Onboarding RPC fails partway through (e.g. trial insert violates the one-trial-per-club constraint on a retry) | The entire `complete_new_club_onboarding()` transaction rolls back — never a state with a `clubs` row but no membership, or a membership but no trial; the user sees a clear error and can retry safely (retry is itself safe because nothing partial was committed) |
| Email verification never arrives (delivery failure) | Trial start is not blocked by this — verification is a soft prompt, not a gate (see [DECISIONS.md ADR-041](DECISIONS.md#adr-041--email-verification-uses-supabase-auths-built-in-flow-no-paid-email-provider-dependency)); the club operates normally, verification can be re-sent or the user can proceed unverified |
| Manager tries to block a field for maintenance during a window with existing bookings | Never auto-cancelled — the block-creation RPC surfaces the specific conflicting bookings ("3 existing bookings conflict") and requires the manager to explicitly adjust the window or cancel those bookings individually (permission + reason + audit) before the block is created (see [DECISIONS.md ADR-049](DECISIONS.md#adr-049--quick-field-block-requires-explicit-confirmation-when-existing-bookings-conflict)) |
| Recurring booking series has some occurrences that conflict with existing bookings | Never silently creates a partial series without telling the user — shows "8 requested, 7 available, 1 conflict" and lets the user choose to create the available occurrences or cancel and review, but the outcome is always explicit (see [DECISIONS.md ADR-047](DECISIONS.md#adr-047--recurring-booking-is-a-linking-table-over-real-individual-booking-rows-never-a-shortcut-around-conflict-checking)) |
