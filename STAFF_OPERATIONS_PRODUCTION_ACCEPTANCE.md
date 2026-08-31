# Staff Operations & Daily Club Management — Production Acceptance

Tracking document for the "MAL3ABY — STAFF OPERATIONS & DAILY CLUB MANAGEMENT,
FULL AUTONOMOUS END-TO-END PRODUCTION HARDENING" directive (2026-08-31).

Status values: `PENDING` / `IN PROGRESS` / `FIXED + PASS` / `PASS` /
`ACCEPTED LIMITATION` / `ENVIRONMENT-BLOCKED` / `TRUE BLOCKER`

Closure threshold: P0 = 0, P1 = 0, CORE P2 = 0.

## Phase A — Customer Portal daysRemaining() timezone defect

| Item | Status | Evidence |
|---|---|---|
| daysRemaining() club-timezone off-by-one | **FIXED + PASS** | `src/lib/domain/clubMembership.ts` rewritten to require club IANA timezone, compare business-date club-local days via `toInstant`/`fromInstant` (Gate 1 time model). Only real consumer (`PortalMembershipsPage.tsx`) wired via `useClubTimezone`. 10 new regression tests incl. fake-timer proof that club zone (not browser zone) is authoritative. Committed `30b021a`. CODE VERIFIED + AUTHENTICATED AUTOMATED VERIFIED (unit tests). |

## Phase B — Staff Operations Queue

| # | Item | Severity | Status | Evidence |
|---|---|---|---|---|
| B1 | Start of day / dashboard | - | PENDING | |
| B2 | Cash shift opening | - | PENDING | |
| B3 | Customer search/creation (staff) | - | PENDING | |
| B4 | Booking staff journey | - | PENDING | |
| B5 | Walk-in booking | - | PENDING | |
| B6 | Booking lifecycle actions | - | PENDING | |
| B7 | QR/check-in staff flow | - | PENDING | |
| B8 | Club membership staff journey | - | PENDING | |
| B9 | Academy reception journey | - | PENDING | |
| B10 | Academy attendance journey | - | PENDING | |
| B11 | Payment collection | - | PENDING | |
| B12 | Split/partial payment | - | PENDING | |
| B13 | Refund/reversal targeted regression | - | PENDING | |
| B14 | Expense staff journey | - | PENDING | |
| B15 | Cash drawer consistency (reconciliation invariant) | - | PENDING | |
| B16 | Shift closing | - | PENDING | |
| B17 | Staff handoff | - | PENDING | |
| B18 | Branch switching / multi-branch | - | PENDING | |
| B19 | Restricted staff persona | - | PENDING | |
| B20 | Custom role | - | PENDING | |
| B21 | Permission denial UX | - | PENDING | |
| B22 | Staff navigation / dead ends | - | PENDING | |

## Phase C — Cross-module operational consistency

| # | Item | Status | Evidence |
|---|---|---|---|
| C1 | Cross-module context (same QA customer) | PENDING | |
| C2 | Customer360 staff acceptance | PENDING | |
| C3 | Staff error recovery | PENDING | |
| C4 | Loading/empty states | PENDING | |
| C5 | Search & filters | PENDING | |
| C6 | Club timezone systemic staff check | PENDING | |

## Phase D — Security / permissions / branch isolation

| # | Item | Status | Evidence |
|---|---|---|---|
| D1 | Tenant isolation (bounded) | PENDING | |
| D2 | Branch isolation (bounded) | PENDING | |
| D3 | Auditability | PENDING | |

## Phase E — Visual / responsive / RTL-LTR acceptance

| # | Item | Status | Evidence |
|---|---|---|---|
| E1 | RTL / LTR | PENDING | |
| E2 | Responsive (375/768/1024/1440) | PENDING | |
| E3 | Keyboard / accessibility basics | PENDING | |
| E4 | Stale state / cache | PENDING | |
| E5 | Double-click / retry safety | PENDING | |
| E6 | Concurrency targeted checks | PENDING | |
| E7 | Printing targeted regression | PENDING | |
| E8 | Reporting targeted reconciliation | PENDING | |
| E9 | Operational efficiency review | PENDING | |

## Phase F — Final regression

| Item | Status | Evidence |
|---|---|---|
| TSC | PENDING | |
| LINT | PENDING | |
| UNIT | PENDING | |
| BUILD | PENDING | |
| TARGETED E2E | PENDING | |
| CI | PENDING | |
| PRODUCTION | PENDING | |

## Defect Log

### DL1 — record_expense() had no server-side idempotency protection (P2, FIXED)
- **Found**: while investigating B14 (expense staff journey) architecture, confirmed `record_expense()` accepted no `p_idempotency_key`, unlike every other financial-commitment RPC in this codebase (`record_payment`, `create_refund`). Client-side protection was only `disabled={recordMutation.isPending}` — exactly the insufficient guard the directive's Section 39 explicitly warns about.
- **Root cause**: `expenses` table had no `idempotency_key` column at all.
- **Fix**: `supabase/migrations/20260831073301_expenses_idempotency_key.sql` (add column + partial unique index on `(club_id, idempotency_key)`, add `p_idempotency_key` param with early-return-on-existing-key dedup, mirroring `record_payment`'s established pattern), plus two follow-up migrations discovered necessary live:
  - `20260831073342_drop_record_expense_old_overload.sql` — a `CREATE OR REPLACE` that adds a parameter creates a NEW Postgres function overload, not a replacement; the old 9-arg signature remained live and callable (would have let a caller bypass the dedup path entirely). Dropped.
  - `20260831073410_fix_record_expense_grant_leak.sql` — the new function object picked up Postgres's default PUBLIC EXECUTE grant on creation (confirmed live: `anon`/`PUBLIC` both had EXECUTE immediately after the first migration), breaking this codebase's established least-privilege convention. Re-applied the original `authenticated`-only grant.
  - Frontend: `src/features/finance/FinanceExpensesPage.tsx` now generates and passes a `useRef`-held idempotency key, rotated in `onSuccess` (same pattern as `PortalPaymentsPage.tsx`'s claim dialog).
  - Regenerated `src/lib/supabase/types.ts` (Supabase MCP `generate_typescript_types`), diff confirmed minimal/expected.
  - New test: `src/features/finance/expenses-idempotency.integration.test.ts` (3 scenarios: same-key dedup, distinct-key non-dedup, old-overload-removed). ENVIRONMENT-BLOCKED locally (no integration creds) but the exact same scenario was run live via direct SQL RPC calls with a real authenticated staff session — **SERVER VERIFIED**: 2 calls with the same idempotency key produced exactly 1 row in `expenses`; QA row voided afterward.
- **Status**: FIXED + PASS.

## Notes

- Bookings & Fields, Academy Operations, Customer/Parent Experience, Customer360
  core data, Finance/Reporting/Printing/Commerce/Inventory/Platform
  Owner/Payment-provider/PWA-cache architecture are CLOSED baselines — touched
  only when a Staff Operations journey exposes a concrete reproducible defect.
- WhatsApp: DO NOT MODIFY.
