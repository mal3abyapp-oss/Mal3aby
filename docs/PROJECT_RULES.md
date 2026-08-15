# Project Rules

Non-negotiable engineering rules for Mala3by. If a change conflicts with one of these, the change is wrong, not the rule — raise it as a new entry in [DECISIONS.md](DECISIONS.md) instead of silently working around it.

> **Corrected 2026-08-15** per Mandatory Architecture Corrections — rules 3, 5, 6, 8, 11 updated; new rules 5b, 13, 14, 15 added. See [DECISIONS.md](DECISIONS.md) for full reasoning.
>
> **Added 2026-08-15 (final pre-implementation)** per the Final Pre-Implementation Directive — new rules 16, 17, 18 added. See [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md) and [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).

## 1. The database is the authority

Business rules that must be atomic or must hold under concurrency — booking creation, QR consume/confirm, invoice numbering, payment allocation, refunds, enrollment capacity checks — live in PostgreSQL (constraints, RPC functions), never only in frontend/JS. The frontend is a client of the database, never the source of truth for money or availability.

## 2. Tenant isolation is enforced at the database layer

Every tenant-scoped table has RLS policies keyed off `club_memberships` (and `membership_branches` for branch scope — see [DECISIONS.md ADR-015](DECISIONS.md#adr-015--membership-branch-scope-is-a-join-table-not-a-single-column)). No table relies on the frontend to filter by `club_id`. Every new tenant-scoped table must ship with a cross-club-denial test before it's considered done.

## 3. No hard deletes on financial or operational history

At minimum, the following are never `DELETE`d once operationally or financially recorded: `bookings`, `invoices`, `invoice_items` (after the parent invoice is issued), `payments`, `payment_allocations`, `refunds`, `subscriptions`, `attendance` (once marked), `qr_scan_events`, `audit_logs`. Use status transitions (`void`, `cancelled`, `reversed`, `refunded`) with `who`, `when`, `reason` captured. RLS explicitly has no DELETE policy on financial tables, and **no UPDATE or DELETE policy at all on `audit_logs`, for any role** (see [DECISIONS.md ADR-020](DECISIONS.md#adr-020--audit-logs-are-immutable-no-role-can-update-or-delete-them)). Master/reference data with no operational history (e.g. an unused field) is disabled via `status = 'inactive'`, not deleted, in the common case.

## 4. Zero-cost-first

No paid service is added to V1 unless there is a genuine architectural blocker that no free/open-source option solves. See the cost review in [ARCHITECTURE.md](ARCHITECTURE.md#zero-cost-architecture-review). Before adding any dependency, classify it explicitly as **open-source/free** or **external paid/service dependency** — the second category is not permitted in V1 without an explicit decision recorded in [DECISIONS.md](DECISIONS.md). Before adding any dependency, ask: does Supabase already cover this? Is there an open-source library that does this locally?

## 5. Local development first

Local is where development happens. The loop is: edit → local test → local build → review `git diff` → stable commit → manual push (when pushing is authorized — see rule 5b). GitHub is not the development environment. No blind staging, no auto-push, no committing `.env` or secrets.

## 5b. LOCAL ONLY until explicitly authorized otherwise

**Current status: local-only.** Permitted: `git init`, local commits, local branches, local history. **Blocked until a separate, explicit go-ahead:** `git push`, GitHub repository creation, GitHub Actions, Cloudflare deployment, production Supabase project creation/use. This is a standing instruction, not a one-time note — check it before any git/deployment action, including ones that might seem like an obviously-safe next step (e.g. "the code looks stable, let's push it").

## 6. No premature abstraction, no cutting corners on critical paths

Do not build: microservices, custom event buses, CQRS, a custom backend server (Supabase covers V1's needs), complex state management beyond TanStack Query + Supabase client state, schema placeholders for entities with zero current users (e.g. no `organizations` table or `organization_id` column — see [DECISIONS.md ADR-011](DECISIONS.md#adr-011--organizations-removed-entirely-from-v1-schema)).

Do not simplify away: RLS, transactions around financial/availability mutations, the booking-conflict exclusion constraint, audit trail on sensitive actions, QR token security, migration discipline, `SECURITY DEFINER` function discipline (see [RLS_SECURITY.md](RLS_SECURITY.md)).

## 7. Migrations are the only schema authority

All schema changes go through `supabase/migrations/`. No manual edits via the Supabase Dashboard that aren't captured in a migration file. Schema must be fully reproducible from `supabase start` + migrations + `seed.sql`.

## 8. Derived financial values are never stored as fact

Outstanding balance, subscription paid/remaining amounts, and similar figures are computed from the ledger (`invoices`, `payment_allocations`, `refunds` — **never `payments.invoice_id`, which does not exist**, see [DECISIONS.md ADR-011b](DECISIONS.md#adr-011b--paymentsinvoice_id-removed-payment_allocations-is-the-only-payment-invoice-relationship)) at query time, or via a trigger-maintained cache that is always re-derivable. They are never hand-set values that can silently drift from the ledger. Dashboards and reports read the same underlying RPC/view definitions as each other for any given metric — a dashboard figure and a report figure for the same metric can never diverge (see [ARCHITECTURE.md](ARCHITECTURE.md#billing--financial-integrity-strategy)).

## 9. Definition of Done

A feature is not complete because it renders in the UI. Per the feature's needs, "done" includes: business logic, database schema + constraints, RLS policies, validation, loading/error/empty states, responsive behavior (mobile/tablet/desktop), relevant tests, documentation updated, build passing with no type errors.

## 10. Scope control

New feature requests default to `DEFERRED` unless they affect core architecture (data model, RLS, tenant boundary) in a way that would be expensive to retrofit later. Deferred items are tracked in the V1/Deferred matrix in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), not silently dropped.

## 11. Naming conventions

- Database: `snake_case` for tables/columns, plural table names (`bookings`, not `booking`)
- `id uuid default gen_random_uuid()` primary key on every table
- `created_at timestamptz default now()` on every table; `updated_at timestamptz` trigger-maintained where rows are mutable
- `created_by uuid references auth.users` where provenance matters
- `status` columns use explicit enums/check constraints, never free-text
- All money columns are `numeric(12,2)`, never `float`/`double` (see [DECISIONS.md ADR-016](DECISIONS.md#adr-016--money-is-numeric1220-never-floatdouble))
- All timestamps are `timestamptz`; display-only conversion uses `clubs.timezone` (see [DECISIONS.md ADR-018](DECISIONS.md#adr-018--all-timestamps-are-timestamptz-club-owns-a-display-timezone))
- TypeScript/React: `PascalCase` components, `camelCase` functions/variables, feature-based folders (see [ARCHITECTURE.md](ARCHITECTURE.md#domain-architecture))

## 12. Documentation stays current

`PROJECT_STATE.md` is updated after every phase closes — current phase, completed, in progress, blocked, deferred, known issues, next task. Every non-trivial architectural choice gets an entry in `DECISIONS.md` before or immediately after it's implemented, not retroactively months later.

## 13. Authorization is permission-based, never role-key-based

No code — frontend or database — ever branches on a role key (`if role === 'accountant'`). Every authorization decision, in the UI and at the RPC/RLS layer, is a permission-key check (`has_permission('payment.refund')`). `roles` remains a real, seeded table used to bundle permissions for assignment convenience, but it is never itself the thing checked. See [DECISIONS.md ADR-014](DECISIONS.md#adr-014--permissions-not-role-keys-are-the-authorization-source-of-truth).

## 14. Phase discipline

Work on one phase at a time (see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)) unless a task is a genuine same-gate dependency. At the end of every phase, in order: run tests → run build → review migrations → review RLS → review `git diff` → update relevant docs → update `PROJECT_STATE.md` → local stable commit → **stop and report** — do not auto-continue into the next phase. During a phase, do not modify modules outside that phase's scope for the sake of a better approach spotted along the way, unless it's a bug/security issue directly affecting the current phase; log the improvement idea under a Deferred/Technical Debt note in `PROJECT_STATE.md` instead and continue the current task.

## 15. `SECURITY DEFINER` functions follow a fixed checklist

Every function using `SECURITY DEFINER` must: pin `search_path` explicitly, never trust a client-supplied `club_id`/user-id without re-verifying against actual membership, resolve identity only via `auth.uid()`, check the specific required permission internally (not rely solely on the outer RLS policy, which the function itself bypasses), grant `EXECUTE` only to the roles that need it, and ship with a cross-tenant rejection test. Full checklist and reasoning: [RLS_SECURITY.md](RLS_SECURITY.md).

## 16. Trust nothing from the frontend

Design assuming any user may attempt an unauthorized operation, tamper with any frontend-supplied value, or call the API/RPC directly, bypassing the UI entirely. The frontend is never the security boundary — real protection is, in order: PostgreSQL constraints → RLS → permissions → secure RPCs → transactions → audit logs. Specific values that are never trusted as client input when they should be database-derived: `club_id`, `branch_id`, `price`, `discount`, `role`, `permission`, `status` (of any entity), `trial_days`, `subscription_kind`, `invoice_total`, `payment_status`, `booking_status`. Full threat model and the mandatory Abuse Test Catalogue: [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md).

## 17. Security and design are built with each domain, not deferred to a late phase

RLS, permission checks, database constraints, secure RPCs, and audit requirements ship **as part of** the phase that introduces the domain they protect — never retrofitted in a later "hardening" phase. The Design System ([DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)) is established in Phase 1, before any real screen is built. A late Security Hardening phase (Phase 14) and a late Responsive/Print QA phase (Phase 15) still exist — their job is independent re-verification and fine polish, not the first time these concerns are addressed. See [DECISIONS.md ADR-050](DECISIONS.md#adr-050--security-and-design-are-built-with-each-domain-not-deferred-to-a-late-hardeningpolish-phase).

## 18. Every phase has both a Functional Gate and a Security Gate

A phase is not COMPLETE until both pass. The Security Gate checks: tenant isolation, permission checks, direct API abuse tests (the relevant rows from the Abuse Test Catalogue), business constraints under concurrency, financial integrity, audit coverage, no secret exposure, RLS enabled and tested. Findings are severity-classified P0 (Critical) through P3 (Low) — any open P0 or P1 blocks the Exit Gate outright. Full checklist: [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md#security-gate-checklist-applied-per-phase-where-applicable).
