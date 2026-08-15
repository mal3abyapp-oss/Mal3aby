# Architecture

> **Corrected 2026-08-15** per Mandatory Architecture Corrections. See [DECISIONS.md](DECISIONS.md) ADR-011 through ADR-021 for full reasoning behind changes in this revision.

## System Architecture

**Frontend:** React + TypeScript + Vite SPA, Tailwind CSS + shadcn/ui, TanStack Query for server state and cache invalidation, React Router for routing. PWA via `vite-plugin-pwa` (Workbox), installable to home screen, no native wrapper.

**Backend:** Supabase Postgres only. No custom Node/Express/Nest server (see [DECISIONS.md ADR-004](DECISIONS.md#adr-004--no-custom-backend-server-supabase-rpc-covers-all-atomic-operations)). Business rules requiring atomicity — booking creation, invoice numbering, QR consume, refunds — live in PostgreSQL functions (RPC), called via `supabase.rpc()`.

**Core principle:** the database is the authority; the frontend is a client of it, never the source of truth for money or availability. See [PROJECT_RULES.md](PROJECT_RULES.md) rule 1.

**Deployment:** Cloudflare Pages — static SPA hosting, free tier, auto-deploys on push to `main`. No Cloudflare Workers needed (no custom backend to run).

## Domain Architecture

Feature-based structure. Each `features/*` module owns its queries, mutations, and components. Pure business logic lives in `lib/domain/` — testable, UI-agnostic, imported by both UI and tests, so price calculation or subscription-status logic is never duplicated between a form and a report.

```
src/
  app/                    # routing, providers, layout shells
  components/             # shared/dumb UI (shadcn-based)
  features/
    auth/
    clubs/                # club + branch admin
    staff/                # roles, permissions, memberships
    customers/             # customers + guardian_links
    players/
    fields/                 # fields, operating hours, pricing rules
    bookings/              # calendar, booking engine, check-in
    academy/                # programs, groups, enrollments, sessions, attendance
    billing/                # invoices, payments, refunds
    scanner/                # QR generation + /scan
    reports/
    dashboard/
    settings/
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

**Authentication** (who you are): Supabase Auth, email/password for V1. `auth.users` → `profiles` 1:1 via a trigger on signup.

**Authorization** (what you can do): entirely separate from authentication. `club_memberships` (which club, which role) + `membership_branches` (which specific branches, or all if unset — see [DECISIONS.md ADR-015](DECISIONS.md#adr-015--membership-branch-scope-is-a-join-table-not-a-single-column)) + `role_permissions` (which role has which permission) decide access. **Authorization checks are always expressed as permission keys (e.g. `payment.refund`), never as role-key comparisons (`if role === 'accountant'`)** — see [DECISIONS.md ADR-014](DECISIONS.md#adr-014--permissions-not-role-keys-are-the-authorization-source-of-truth). Never encoded only in frontend route guards — those are UX convenience; RLS policies and RPC-internal permission checks are the actual gate, re-evaluated on every request from `auth.uid()`, never trusted from client-cached state.

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

`clubs.status = 'suspended'` blocks all non-platform-owner access to that club's data. **This check happens at the RLS/RPC layer on every request, never by mutating or trusting a claim baked into the JWT** — a JWT issued before suspension remains structurally valid; what changes is that `auth.user_club_ids()` (and every downstream RLS policy and RPC permission check) re-evaluates the club's live `status` against the database on every call. A staff member with a still-valid session is locked out on their very next request after suspension, not just at their next login. `clubs.status = 'grace_period'` (see [Platform Billing Strategy](#platform-billing-strategy) below) applies the same on-every-request enforcement pattern but with a finer-grained per-action rule rather than a blanket lockout. See [ARCHITECTURE.md](ARCHITECTURE.md#failure--recovery-strategy) for the full suspension behavior table.

## Platform Billing Strategy

Mala3by charging a club to use the platform is a **structurally separate domain** from a club's own customer billing — `platform_plans`/`platform_subscriptions`/`platform_invoices`/`platform_payments`, never `invoices`/`payments`/`payment_allocations` (see [DECISIONS.md ADR-022](DECISIONS.md#adr-022--platform-billing-is-a-structurally-separate-domain-from-club-billing)). Platform-Owner-only access; club-side roles see only a read-only summary of their own club's subscription status via a restricted view, never the underlying tables.

**Single flat plan, manual billing** (see [DECISIONS.md ADR-023](DECISIONS.md#adr-023--single-flat-platform-plan-manually-managed-in-v1) and [ADR-024](DECISIONS.md#adr-024--platform-subscription-payment-is-manualoffline-in-v1)): one seeded `platform_plans` row, price optionally overridden per club, payment collected offline and manually recorded by Platform Owner. Recording a `platform_payments` row against a `platform_invoices` row moves the club back to `active`.

**Status transitions are computed lazily, on access — not by a scheduled job** (V1 has no cron/scheduled-function infrastructure, deliberately, to stay zero-cost). `auth.user_club_ids()` and related RLS helpers derive the club's *effective* status from `platform_subscriptions` (due date, `grace_period_started_at`, `grace_period_days`) and `now()` at query time:

```sql
-- effective status, computed not stored-and-trusted blindly:
-- active        : no overdue platform_invoices, or within current_period_end
-- grace_period   : overdue, and now() - grace_period_started_at < grace_period_days
-- suspended      : overdue, and now() - grace_period_started_at >= grace_period_days
```

`grace_period_days` defaults to 7, per-club overridable via `platform_subscriptions.grace_period_days` (see [DECISIONS.md ADR-025](DECISIONS.md#adr-025--grace-period-is-7-days-by-default-per-club-overridable-ends-early-on-manual-payment-confirmation)). A manual payment recorded at any point immediately restores `active`, regardless of where the club was in the countdown.

**Grace period is not a blanket read-only switch** (see [DECISIONS.md ADR-026](DECISIONS.md#adr-026--grace-period-blocks-new-commitments-but-allows-collecting-on-existing-ones)). A single helper centralizes the distinction so it isn't duplicated ad hoc across every table's RLS policy:

```sql
create or replace function auth.club_write_allowed(p_club_id uuid, p_action_category text)
returns boolean
language sql security definer stable
set search_path = public, pg_temp as $$
  select case
    when (select status from clubs where id = p_club_id) = 'active' then true
    when (select status from clubs where id = p_club_id) = 'grace_period'
      then p_action_category in ('settle_existing', 'operational_continuity')
    else false  -- suspended: no writes at all
  end
$$;
```

`p_action_category` is `'new_commitment'` (blocked in grace period — new `bookings`, `enrollments`, `subscriptions`, `groups`/`programs`), `'settle_existing'` (allowed — `payments`, `payment_allocations`, `refunds` against existing invoices/subscriptions), or `'operational_continuity'` (allowed — `attendance` marking for already-scheduled sessions, since a training session happening today shouldn't be unrecordable over a billing lapse). `SELECT` access is never restricted by this helper — grace period and active read identically.

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

**Projected V1 monthly cost: 0 EGP**, until Supabase free-tier limits are hit — comfortably beyond a single pilot club's real usage. First paid step, when it arrives, is Supabase Pro (~$25/mo), never earlier than actually needed.

## Security Threat Review

- **Cross-tenant IDOR:** closed by RLS `club_id in user_club_ids()` on every tenant table, tested explicitly per table (Club A user cannot SELECT/INSERT/UPDATE Club B rows via any path, including a raw PostgREST call bypassing the UI).
- **Privilege escalation:** `role_permissions` is not editable by any role below Platform Owner. `club_memberships.role_id` changes require the `staff.update` permission and are logged to `audit_logs`.
- **QR forgery:** 256-bit random tokens, hashed at rest, computationally infeasible to guess or reverse from the hash.
- **Service role key exposure:** never shipped to the frontend. Only the anon/publishable key ships. Privileged multi-table operations go through `SECURITY DEFINER` RPCs that still re-check `auth.uid()` membership internally — they bypass table-level RLS to write atomically across tables, not authorization itself. See [RLS_SECURITY.md](RLS_SECURITY.md) for the full mandatory discipline (`search_path` pinning, no trusting client-supplied `club_id`, `auth.uid()`-only identity, internal permission checks, scoped `EXECUTE` grants, cross-tenant tests).
- **Storage policy:** player/club photos live in Supabase Storage buckets with policies mirroring `club_id` membership — not public by default.
- **Financial mutation integrity:** no DELETE RLS policy exists on `payments`/`invoices`/`refunds` at all — even a compromised service-role misuse is bounded by what an explicit function allows.
- **Audit log tampering:** no `UPDATE`/`DELETE` policy exists on `audit_logs` for any role, including Club Owner and Platform Owner — the trail is immutable through every client-facing path (see [DECISIONS.md ADR-020](DECISIONS.md#adr-020--audit-logs-are-immutable-no-role-can-update-or-delete-them)).
- **Sensitive field exposure:** `players.medical_notes` is gated behind `player.medical_notes.view`/`.update`, not visible to Receptionist by default, never in global search results (see [DECISIONS.md ADR-019](DECISIONS.md#adr-019--medical-notes-are-a-permission-gated-field-not-a-default-visible-one) and [RLS_SECURITY.md](RLS_SECURITY.md#sensitive-column-protection-medical_notes)).
- **Accidental QR check-in:** scanning a booking QR never mutates state by itself — an explicit staff "Confirm Check-in" is required, preventing an accidental camera pass from silently checking a customer in (see [DECISIONS.md ADR-011e](DECISIONS.md#adr-011e--qr-scan-validates-explicit-staff-confirmation-performs-the-check-in-mutation)).

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
| Club is disabled by Platform Owner (manual suspension) | `clubs.status = 'suspended'`; RLS for non-platform-owner roles requires `status = 'active'`, re-checked on every request (not via JWT mutation) — all staff of that club are locked out on their next request, data retained (no deletes), reactivation available |
| Club's platform subscription lapses (unpaid) | `clubs.status` computed as `grace_period` for up to `grace_period_days` (default 7, per-club overridable) — staff retain read access and can still settle existing payments/attendance but cannot create new bookings/enrollments/subscriptions (see [Platform Billing Strategy](#platform-billing-strategy)); auto-transitions to `suspended` (full lockout) once the grace period elapses, computed lazily on next access, not via a scheduled job; a manual `platform_payments` record at any point restores `active` immediately |
| Subscription expires mid-session | The in-progress session's attendance is unaffected; the *next* session's enrollment check flags expired status (via the derived `effective_end_date`) and blocks further attendance until renewed |
| Two receptionists enroll the last group spot simultaneously | Enrollment RPC locks the `groups` row (`SELECT ... FOR UPDATE`) and re-checks capacity inside the same transaction as the insert — only one enrollment succeeds, the second sees "Group is full" |
