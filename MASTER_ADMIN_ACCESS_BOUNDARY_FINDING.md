# Master Admin — Access Boundary Finding (Phase 4 addendum)

**Status: LIVE VERIFIED finding — a real architectural fact, not a
newly-introduced defect, disclosed at the correct evidence tier rather
than reported as a silent PASS.** Written 2026-08-28, part of Phase 4.
Directive requirement under MASTER ADMIN: "no impersonation/escalation
leakage." This document gives that requirement its honest, precise
answer rather than a blanket PASS.

## What was tested

A real platform-owner QA fixture
(`mal3aby.qa.platform-owner.20260821@example.com`), confirmed to have
**zero active `platform_support_sessions` row** for Club A
("Mala3by Test Club One") at the time of the test — i.e., this account
had not started any Master Admin support context on this club at all —
was impersonated via this project's established RLS pattern and asked
to read Club A's real bookings.

```
select count(*) from public.bookings where club_id = '<Club A>';
→ 3   (real rows, correctly readable)
```

## Root cause: two coexisting, architecturally distinct access paths

**Path 1 — the newer "Master Admin support context" feature** (built
2026-08-26, `platform_support_session_rpcs.sql` et seq.): a platform
owner or Platform Support staff member explicitly calls
`start_platform_support_session(club_id, mode)`, creating a real,
time-boxed, audited row. Every RLS policy this feature added
(`*_platform_support_select`/`*_platform_support_write` — confirmed live
across `club_memberships`, `bookings`, `enrollments`, `groups`,
`invoices`, `payments`, `payment_allocations`, and more) gates on
`has_platform_support_access(club_id[, true])`, which requires that
session to exist, be unexpired, and (for MANAGE-mode checks) be in the
right mode. This path **is fully audited** — session start/end are real
rows with a real actor, real timestamps, real mode.

**Path 2 — a separate, older, unconditional `is_platform_owner()` RLS
policy**, pre-dating the support-session feature, confirmed live present
on **31 tables** including `bookings`, `invoices`, `customers`, `players`,
`club_memberships` (full access, not just select), `clubs` (full
access), and more (`select * from pg_policies where qual =
'is_platform_owner()'`). This path requires **no session, no mode, no
expiry, and produces no audit trail** — `is_platform_owner()` is a
simple boolean check against the caller's own role, nothing else.
Confirmed: **no `write_audit_log` call, no audit wrapper, and no
`platform_support_audit_wrapper`-equivalent mechanism exists anywhere in
this path** — a real platform owner reading any tenant's bookings,
invoices, or customer data through this path leaves zero record of
having done so.

**This is documented, not undisclosed**: the migration that added the
newer, audited path explicitly says so in its own header comment
(`platform_support_rls_operational_tables.sql`): *"Note:
invoices/customers/bookings already carry a separate, pre-existing
`*_platform_owner_select` policy (is_platform_owner() alone, no session
scoping) — that is untouched, pre-existing behavior from before this
feature and out of this migration's scope to alter."* A prior session
made a deliberate, disclosed decision not to touch this — this document
re-surfaces and confirms that decision is still live in production
today, with the exact table list, for the current Phase 4 report.

## Why this is not classified as a newly-found defect

This is a common, often-intentional design for a SaaS platform operator
role — the entity that owns the infrastructure and is contractually/
operationally responsible for every tenant on it typically does have
some form of always-on read access, and closing it entirely would be a
substantial architecture change (every operational RLS policy on every
table), not a Phase-4-scoped fix. It was already investigated and
explicitly left in place by a prior session with full awareness.

## Why it is still worth stating precisely rather than glossing over

The directive's literal requirement — "no impersonation/escalation
leakage" — is not fully true in the strictest reading for the
**platform owner** role specifically (as distinct from **Platform
Support staff**, who correctly have no access at all without an active,
audited, mode-scoped session — confirmed separately: `has_platform_permission`
gates their session-start capability, and `has_platform_support_access`
re-checks mode on every downstream access). The honest, correctly-scoped
claim is:

- **Platform Support staff → tenant data**: session-gated, audited,
  mode-scoped, expiring. No leakage. LIVE VERIFIED (this phase, code
  read + the `has_platform_support_access` definition).
- **Platform Owner → tenant data**: always-on, unaudited, no session
  required, by deliberate pre-existing design across 31 tables. This is
  standing platform-operator access, not "leakage" in the sense of a
  bug — but it is also not "no access without an explicit, logged
  session," which is what the directive's phrasing implies. **ACCEPTED
  RISK / pre-existing architectural decision**, not a TRUE STOP
  CONDITION and not silently reported as a full PASS.

## Recommendation, not executed this phase

If a future phase wants the platform-owner path to carry the same audit
trail as the support-session path, the narrowest fix would be adding a
lightweight audit-on-read mechanism to the `is_platform_owner()` policies
specifically (or migrating tenant-data reads to route through the
session-scoped path exclusively, retiring the older policies) — real,
non-trivial, cross-cutting work appropriately scoped as its own future
phase, not folded into Phase 4's E2E/staging goals.
