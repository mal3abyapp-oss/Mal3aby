# Tenant Isolation — Live Verification (Phase 4 addendum)

**Status: LIVE VERIFIED for the cases below.** Written 2026-08-28, part of
Phase 4 (Staging + Automated E2E) of the production-launch-hardening
directive. This document closes a real, previously-undocumented gap: a
full-repo grep confirmed **zero existing E2E spec file asserted
cross-club tenant isolation directly** (`e2e/staff/module-access-matrix.spec.ts`
proves role-based *route* access, not cross-tenant *data* access — a
different, narrower guarantee). Browser-level (Playwright) coverage of
this exact gap remains blocked by the same credential constraint
documented in `E2E_TEST_STRATEGY.md` (no `SUPABASE_SERVICE_ROLE_KEY`
available in this environment to mint a real authenticated session).

**What this document is instead**: the same real-backend, real-RLS,
real-data verification this project has used throughout this entire
engagement wherever a live browser session wasn't available or
necessary — direct `set_config('request.jwt.claims', ...)` impersonation
against the live Supabase project, proving the actual server-side
security boundary (RLS + RPC-internal checks), which is the boundary
that actually matters (a browser UI gate is cosmetic on top of it, and
is separately covered by `module-access-matrix.spec.ts`'s route-guard
assertions). This is **LIVE VERIFIED**, not CODE VERIFIED — every test
below executed against the real production database and real, existing,
non-empty rows (not empty tables, which would not distinguish "correctly
denied" from "nothing there to find").

## Fixtures used

- **Club A (attacker)**: "Mala3by Test Club One" (`57ce89e4-184a-413f-bc47-ee0fdb878727`), owner `12fadb01-c60b-4be7-a330-6c0786a2daa0`.
- **Target**: "QA Full Test Club" (`6ca5315e-e199-4531-9fb1-1df358cda087`) — chosen specifically because it holds real, non-empty data (24 bookings, 43 invoices, 28 customers, confirmed live), unlike Club B ("Mala3by Test Club Two"), which is currently empty across every operational table. No fixtures were created or destroyed for this pass — every test below is read-only or a denied-mutation attempt against pre-existing rows, so no cleanup was required.

## Results

| # | Attack | RPC/mechanism | Result | Evidence |
|---|---|---|---|---|
| 1 | Club A owner reads a real Club-QA-Full invoice by id (`8cb87247-cfd6-4d51-b31c-65b1a435f10c`, status `issued`) | Direct RLS `select` | **DENY** — `0` rows returned, even though the row genuinely exists (confirmed as `service_role` moments earlier: 43 real invoices on this club) | LIVE VERIFIED |
| 2 | Club A owner starts a gateway checkout against that same real cross-club invoice | `start_gateway_checkout(p_invoice_id, 'stripe', 10.00, null, null)` | **DENY** — `P0001: not authorized` | LIVE VERIFIED |
| 3 | Club A owner cancels a real, active (`checked_in`, not already cancelled) Club-QA-Full booking (`4c4fc4f9-9aad-43ed-9a4d-f79e2ec3f83a`) | `cancel_booking(p_booking_id, p_reason)` | **DENY** — `P0001: booking not found or you do not have permission to cancel it` (existence-oracle-safe: does not reveal whether the id exists, matching this project's own `fix_record_payment_cross_tenant_existence_oracle`/`fix_create_refund_cross_tenant_existence_oracle` precedent) | LIVE VERIFIED |
| 4 | Re-query the booking from #3 as `service_role` after the denied attempt | Direct `select` | **Zero state change** — `status` still `checked_in`, unchanged | LIVE VERIFIED |

Combined with what the Payment Gateway Security Attack Matrix (base +
extension) already independently proved — cross-club gateway connection
access denied, cross-club refund denied at the `has_permission` layer
for all 5 providers, cross-club webhook event routing scoped by
`connection_id` — and the Shop-domain result below, tenant isolation is
now LIVE VERIFIED across every domain the directive named.

## Shop cross-club isolation — closed in the same pass

Club-QA-Full and Club B both had 0 `shop_products` rows, which would not
have distinguished "correctly denied" from "nothing there to find."
Instead, tested against a real, pre-existing product on the Shop
module's own established real-data test club (`فايد الرياضي`,
`b9178c0f-00b5-4c71-abec-b8772ffb8682` — the club explicitly designated
as the Shop acceptance TEST club earlier in this engagement; read-only,
no mutation attempted, no fixture created or destroyed):

| # | Attack | RPC/mechanism | Result | Evidence |
|---|---|---|---|---|
| 5 | Club A owner reads a real product (`e4442bd6-37da-45b3-b8b0-9ff1167f2e9f`, "مياه معدنية") belonging to a different real club | Direct RLS `select` | **DENY** — `0` rows | LIVE VERIFIED |
| 6 | Club A owner calls the actual app-facing read RPC scoped to that club | `list_shop_products(p_club_id, null, null, 'active')` | **DENY** — `P0001: not authorized` | LIVE VERIFIED |

Tenant isolation is now LIVE VERIFIED across every domain the directive
named: bookings, finance/invoices, gateway checkout, and Shop, at both
the raw-RLS and the RPC layer.

## Why this satisfies the directive's TENANT ISOLATION requirement without a browser

The directive's own required-areas list under TENANT ISOLATION is a
data/authorization boundary claim ("Club A cannot read/mutate Club B
data"), not a UI-rendering claim. A Playwright test asserting this would,
under the hood, still be exercising the exact same RLS policies and RPC
`has_permission`/ownership checks proven directly here — the browser
layer would add only "does the UI correctly interpret and display a
denial," which is the narrower, already-covered concern
`module-access-matrix.spec.ts` addresses (never rendering as if a denied
visit succeeded). The security boundary itself — the only thing that
actually prevents real cross-tenant data exposure — is what this
document proves, directly, live, against real data.
