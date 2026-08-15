# Project Rules

Non-negotiable engineering rules for Mala3by. If a change conflicts with one of these, the change is wrong, not the rule — raise it as a new entry in [DECISIONS.md](DECISIONS.md) instead of silently working around it.

## 1. The database is the authority

Business rules that must be atomic or must hold under concurrency — booking creation, QR consume, invoice numbering, payment allocation, refunds — live in PostgreSQL (constraints, RPC functions), never only in frontend/JS. The frontend is a client of the database, never the source of truth for money or availability.

## 2. Tenant isolation is enforced at the database layer

Every tenant-scoped table has RLS policies keyed off `club_memberships`. No table relies on the frontend to filter by `club_id`. Every new tenant-scoped table must ship with a cross-club-denial test before it's considered done.

## 3. No hard deletes on financial or operational history

`bookings`, `invoices`, `payments`, `refunds`, `subscriptions`, `attendance` and similar rows are never `DELETE`d after they matter. Use status transitions (`void`, `cancelled`, `reversed`, `refunded`) with `who`, `when`, `reason` captured. RLS explicitly has no DELETE policy on financial tables.

## 4. Zero-cost-first

No paid service is added to V1 unless there is a genuine architectural blocker that no free/open-source option solves. See the cost review in [ARCHITECTURE.md](ARCHITECTURE.md#zero-cost-architecture-review). Before adding any dependency, ask: does Supabase already cover this? Is there an open-source library that does this locally?

## 5. Local development first

Local is where development happens. The loop is: edit → local test → local build → review `git diff` → stable commit → manual push. GitHub is not the development environment. No blind staging, no auto-push, no committing `.env` or secrets.

## 6. No premature abstraction, no cutting corners on critical paths

Do not build: microservices, custom event buses, CQRS, a custom backend server (Supabase covers V1's needs), complex state management beyond TanStack Query + Supabase client state.

Do not simplify away: RLS, transactions around financial/availability mutations, the booking-conflict exclusion constraint, audit trail on sensitive actions, QR token security, migration discipline.

## 7. Migrations are the only schema authority

All schema changes go through `supabase/migrations/`. No manual edits via the Supabase Dashboard that aren't captured in a migration file. Schema must be fully reproducible from `supabase start` + migrations + `seed.sql`.

## 8. Derived financial values are never stored as fact

Outstanding balance, subscription paid/remaining amounts, and similar figures are computed from the ledger (`invoices`, `payments`, `payment_allocations`) at query time or via a trigger-maintained cache that is always re-derivable. They are never hand-set values that can silently drift from the ledger.

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
- TypeScript/React: `PascalCase` components, `camelCase` functions/variables, feature-based folders (see [ARCHITECTURE.md](ARCHITECTURE.md#domain-architecture))

## 12. Documentation stays current

`PROJECT_STATE.md` is updated after every phase closes — current phase, completed, in progress, blocked, deferred, known issues, next task. Every non-trivial architectural choice gets an entry in `DECISIONS.md` before or immediately after it's implemented, not retroactively months later.
