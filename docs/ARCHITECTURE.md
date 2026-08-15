# Architecture

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

**Authorization** (what you can do): entirely separate from authentication. `club_memberships` (which club, which branch or all-branches, which role) + `role_permissions` (which role can do what) decide access. Never encoded only in frontend route guards — those are UX convenience; RLS policies and RPC-internal permission checks are the actual gate, re-evaluated on every request from `auth.uid()`, never trusted from client-cached state.

See [RLS_MATRIX.md](RLS_MATRIX.md) for the full policy pattern and per-role permission table.

## RLS Strategy

Every tenant-scoped table carries a denormalized `club_id` column (not just inferable via join) — this keeps RLS policies simple and fast. Core helper:

```sql
create or replace function auth.user_club_ids() returns setof uuid
language sql security definer stable as $$
  select club_id from club_memberships
  where user_id = auth.uid() and status = 'active'
$$;
```

Every tenant table gets a `SELECT` policy filtering on `club_id in (select auth.user_club_ids())`, plus `INSERT`/`UPDATE` policies that additionally check `role_permissions` for the specific permission key via `auth.has_permission(permission_key, target_club_id)`. Financial tables have **no DELETE policy at all** — hard delete is impossible through RLS, not just discouraged by convention.

Branch-scoped roles (Branch Manager, Receptionist) narrow further via `club_memberships.branch_id` when non-null. Platform Owner bypasses per-club scoping through a distinct policy checked against a platform-level permission, not `user_club_ids()`.

Full matrix: [RLS_MATRIX.md](RLS_MATRIX.md).

## Booking Engine Strategy

Day-view grid (rows = time slots derived from field duration + operating hours, columns = fields), computed from a single query per date range — no per-cell fetch.

Double-booking is prevented at the database layer via a PostgreSQL exclusion constraint (see [DECISIONS.md ADR-007](DECISIONS.md#adr-007--double-booking-prevention-via-postgresql-exclusion-constraint)):

```sql
alter table bookings add column during tstzrange
  generated always as (tstzrange(start_at, end_at, '[)')) stored;

alter table bookings add constraint no_overlapping_bookings
  exclude using gist (field_id with =, during with &&)
  where (status not in ('cancelled', 'no_show'));
```

This holds against every write path, not just the RPC the app author remembers to guard. Booking creation still goes through an RPC (`create_booking`) for atomicity across booking + invoice + invoice_item, but conflict-proofing itself lives in the constraint.

## Billing & Financial Integrity Strategy

`payment_allocations` bridges `payments` and `invoices` many-to-many, so a single payment can fund multiple invoices or partially fund one (e.g. a walk-in payment covering both today's booking and an old balance). Outstanding balance is always `invoice.total - SUM(allocations)`, computed at query time — never a hand-maintained column (see [PROJECT_RULES.md](PROJECT_RULES.md) rule 8).

Refunds never mutate `payments.amount` — they insert a `refunds` row plus a reversing allocation, keeping the ledger append-only with a full audit trail.

Invoice numbering is concurrency-safe via a single-row `UPDATE ... RETURNING` inside an RPC (row-level locking makes concurrent calls serialize automatically):

```sql
update invoice_number_sequences
  set last_number = last_number + 1
  where branch_id = p_branch_id and year = p_year
  returning last_number into v_next;
```

Format: `{CLUB_CODE}-{BRANCH_CODE}-{YEAR}-{000001}` (per-branch sequence — see [DECISIONS.md ADR-009](DECISIONS.md#adr-009--invoice-numbering-is-per-branch)).

## QR Strategy

Open-source only: `qrcode` for generation, `@zxing/browser` or `html5-qrcode` for camera scanning — no external QR service.

QR encodes an opaque 256-bit random token, never a database ID. The server stores only `SHA-256(token)`. Validation + single-use consumption happens atomically in one RPC statement:

```sql
update qr_credentials
  set status = 'consumed', used_at = now(), used_by = auth.uid()
  where token_hash = $1 and status = 'active' and expires_at > now()
  returning *;
```

Zero rows returned means already-consumed or invalid — replay protection by construction, no separate check-then-update race. See [DECISIONS.md ADR-005](DECISIONS.md#adr-005--qr-tokens-are-opaque-random-values-hashed-at-rest).

**Offline handling:** scanning fails closed — no network, no automated check-in. Staff can perform a manual override with a mandatory reason, logged to `audit_logs`. This is safer than fail-open while still giving staff a path forward when connectivity is patchy.

## Printing Strategy

No PDF library, no print server. Browser `window.print()` with two `@media print` stylesheets: one for A4 (`@page { size: A4 }`), one for 80mm thermal (`@page { size: 80mm auto; margin: 2mm }`). Same invoice data, two layouts, zero external dependency.

## Reporting Strategy

No BI tool. Reports are parameterized SQL views/RPCs (e.g. `get_revenue_report(club_id, date_range, group_by)`) returning JSON, rendered with existing table/chart components. Each report ships in the implementation phase that owns its underlying data (revenue reports land with billing, academy reports with academy) rather than one late catch-all reporting phase.

## PWA Strategy

`vite-plugin-pwa` + Workbox. Caches **app shell and static assets only** — no offline database, no offline mutation queue. Service worker: `NetworkFirst` for API calls (financial data is never served stale silently), `CacheFirst` for static assets. If network drops during a financial operation, the operation is not considered successful until the database confirms it — no optimistic "success" UI for money (see [PROJECT_RULES.md](PROJECT_RULES.md) and the failure-scenario table below).

## Deployment Strategy

Local → GitHub (manual push) → Cloudflare Pages (connected to `main`, auto-builds on push) → environment variables (Supabase URL + anon key) set in the Cloudflare dashboard, never committed. Supabase migrations are deployed separately via `supabase db push` against the linked remote project — deliberately decoupled from the frontend deploy, so a schema change is a reviewed, explicit action rather than a side effect of a frontend push.

**Rollback:** Cloudflare Pages keeps prior deploys one click away. Supabase migrations are forward-only, with manually written down-migrations for anything genuinely reversible.

**Environments:** local (Supabase CLI via Docker) → production (hosted Supabase project). No independent paid staging environment in V1 — a second free-tier Supabase project can serve as staging if/when needed, without cost.

## Local Development Workflow

```
supabase start   # local Postgres + Auth + Storage
npm install
npm run dev
```

Loop: edit → local test (`vitest` + `supabase test db`) → local build (`npm run build`) → review `git diff` → stable commit → manual push. No step touches production. See [PROJECT_RULES.md](PROJECT_RULES.md) rule 5 and [TEST_PLAN.md](TEST_PLAN.md).

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
- **Service role key exposure:** never shipped to the frontend. Only the anon/publishable key ships. Privileged multi-table operations go through `SECURITY DEFINER` RPCs that still re-check `auth.uid()` membership internally — they bypass table-level RLS to write atomically across tables, not authorization itself.
- **Storage policy:** player/club photos live in Supabase Storage buckets with policies mirroring `club_id` membership — not public by default.
- **Financial mutation integrity:** no DELETE RLS policy exists on `payments`/`invoices`/`refunds` at all — even a compromised service-role misuse is bounded by what an explicit function allows.

## Failure & Recovery Strategy

| Scenario | System behavior |
|---|---|
| DB migration fails mid-deploy | Migrations tested locally first, applied to prod as a single transaction-wrapped file; failure rolls back, prod stays on prior schema version |
| Payment recorded but invoice creation fails | Both happen inside one RPC transaction — either both commit or neither does |
| Invoice created but QR generation fails | QR generation is a separate, retryable step after the financial transaction commits; a "Regenerate QR" action is always available |
| Two employees book the same slot | Exclusion constraint rejects the second INSERT; UI shows "slot just taken, pick another" |
| Two devices scan the same QR | Atomic `UPDATE ... WHERE status = 'active'` — only the first succeeds; the second sees "Already Checked In" with original timestamp + staff member |
| Network disconnect during payment | UI shows pending/unconfirmed until the RPC response returns; no optimistic success state for money |
| User's permission is revoked mid-session | Every mutation re-checks RLS/RPC permission server-side using current `auth.uid()` state — a stale frontend session cannot act on a revoked permission |
| Club is disabled by Platform Owner | `clubs.status = 'suspended'`; RLS for non-platform-owner roles requires `status = 'active'` — all staff of that club are locked out immediately, data retained, reactivation available |
| Subscription expires mid-session | The in-progress session's attendance is unaffected; the *next* session's enrollment check flags expired status and blocks further attendance until renewed |
