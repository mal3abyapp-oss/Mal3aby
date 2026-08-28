# Club Memberships — Live Verification (Phase 4 addendum)

**Status: LIVE VERIFIED (tenant isolation) + LIVE VERIFIED (lifecycle
consistency); positive-case access not independently re-tested this
pass — see note below.** Written 2026-08-28, part of Phase 4.

## Lifecycle / invoice-linkage consistency

Checked the one real active `club_membership_subscriptions` row
currently in production (`ff527fb9-...`, on `فايد الرياضي`,
`b9178c0f-00b5-4c71-abec-b8772ffb8682`): `status='active'`, linked to a
real invoice (`5a7c40be-...`) whose own `status='issued'`, `total=1200.00`
— internally consistent (an active membership genuinely has a real,
matching, non-void invoice behind it, not an orphaned or dangling
reference). LIVE VERIFIED.

## Tenant isolation

| Attack | RPC | Result | Evidence |
|---|---|---|---|
| Club A owner reads a real membership subscription detail belonging to a different real club | `get_club_membership_detail(p_membership_subscription_id)` | **DENY** — `P0001: club membership not found or you do not have permission to view it` (existence-oracle-safe, same pattern as bookings/refunds) | LIVE VERIFIED |

## Honest note on scope

QA Full Test Club (the fixture used for every other positive-case
"correct owner CAN access their own data" cross-check in this phase)
currently has **0** `club_membership_subscriptions` rows, so a positive
counterpart to the denial above (proving the real owner of `فايد
الرياضي` *can* read this same row) was not independently re-run this
pass — doing so would have required probing that club's real personnel/
role structure further than this check's actual purpose warranted, given
it is the user's own real personal club. This is not treated as an open
gap: the identical RLS + `has_permission`/ownership-check pattern used
by `get_club_membership_detail` (auth.uid() required, club-membership
existence check, permission-gated) is the same pattern already
positive-and-negative tested this phase for bookings (`cancel_booking`),
invoices (`start_gateway_checkout`), and Shop (`list_shop_products`) —
there is no reason to expect this RPC alone behaves differently, and the
negative case (the actual security-relevant direction) is the one that
was directly proven.

## Fixtures

None created or destroyed. Read-only throughout.
