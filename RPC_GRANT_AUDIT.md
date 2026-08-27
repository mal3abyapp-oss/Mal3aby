# RPC Grant Audit

Full-schema grant-hygiene audit (336 distinct function names, public
schema), verified live against `pg_proc`/`has_function_privilege`, not
assumed from migration history alone.

## Orphaned overloads

Only **one** function name in the entire public schema has more than
one overload: `record_staff_whatsapp_consent` — a 5-arg legacy form and
a 6-arg current form (adds `p_phone_e164`). Both overloads carry
**identical** grants (`anon_exec=false`, `authenticated_exec=true`) —
this is not a privilege-escalation orphan, just dead API surface (the
5-arg form has zero remaining callers in `src/` or `supabase/migrations/`).
Not dropped this session — the WhatsApp subsystem is under a standing
"don't touch without new proven cause" directive; flagged for the
user's explicit go-ahead rather than auto-applied.

Every other function-signature change across this project's ~400
migrations has, per its own history, been followed by an explicit
orphan-drop when one occurred (`drop_orphaned_activate_subscription_overload`,
`drop_orphaned_create_booking_overloads`, `drop_orphaned_return_shop_sale_overload`,
`fix_create_shop_sale_grant_leak_and_drop_orphaned_overload`, etc.) —
this is a real, recurring bug class in this codebase's history and
should be re-checked after every future signature-changing migration,
not just at audit time.

## anon/public-exposed functions (35 total)

34 of 35 are intentional, deliberate unauthenticated entry points —
public booking widget, invoice/QR verification, portal invite
landing/claim — each built on a consistent token-hash + status-gate +
`SECURITY DEFINER` pattern. Individually reviewed; no leak found in any
of them.

**2 fixed this session** (see `PRODUCTION_LAUNCH_READINESS.md` M-2):
`get_invoice_payment_summary` — `SECURITY INVOKER`, no internal gate,
directly anon-callable — anon/public EXECUTE revoked; the two
legitimate wrapper RPCs (`verify_invoice_public`, `verify_booking_qr_public`)
remain functional since both are owned by the same role
(`postgres`) that retains implicit execute on functions it owns.

**4 flagged, deliberately NOT revoked** (see `PRODUCTION_LAUNCH_READINESS.md`
L-1): `has_branch_access`, `user_club_ids`, `has_permission`,
`is_platform_owner`. The original audit recommended revoking anon
execute on these as "internal helpers with no legitimate anon caller."
That recommendation was checked against live RLS policy definitions
before applying anything, and found to be **incorrect for this specific
fix**: these four functions are referenced directly inside 45, 150,
131, and 38 RLS policy expressions respectively across the schema.
Revoking a role's EXECUTE on a function a policy calls would deny that
role from ever satisfying the policy at all — a schema-wide RLS outage
for that role, not a security improvement. Left as-is; documented here
so this recommendation is not silently reapplied by a future audit
without the same check.

**6 trigger functions carry default PUBLIC EXECUTE** (cosmetic,
low-priority, not fixed this session — see L-2 in the readiness
register): `check_payment_allocation_sum`, `check_guardian_link_same_club`,
`audit_messaging_safety_settings_change`, `ensure_messaging_safety_settings`,
`protect_subscription_price_immutable`, `set_updated_at`.

## SECURITY DEFINER audit

311 `SECURITY DEFINER` functions in public schema. **All 311 have an
explicit `search_path` set** (`search_path=public, pg_temp`) — zero
missing, matching the dedicated `harden_search_path_and_cleanup`
migration. 95/311 contain an explicit `auth.uid() IS NULL` guard
(heuristic text-match on the real mutation RPCs); the remaining ~216
were not individually re-verified for an equivalent alternate guard
(`has_permission()`, branch-scope helpers, custom-role checks) in this
pass — this is a genuine open coverage gap (`PRODUCTION_LAUNCH_READINESS.md`
EL-1), not a confirmed finding either way.

One non-`SECURITY DEFINER` function, `whatsapp_delivery_confirmation_overdue`,
has a mutable search_path (advisor WARN) — pure `STABLE` SQL with no
table access, minimal exploitability, not fixed this session per the
same WhatsApp-subsystem caution as the orphaned-overload item above.

## Advisor summary (post-fix)

`get_advisors(type='security')`: **0 ERROR**, 291 WARN (263 expected
"authenticated can execute this business-logic RPC" + 25 expected
"anon can execute this deliberate public-facing RPC" + the newly
tightened `payment_proofs` policy + 1 remaining `function_search_path_mutable`
+ 1 remaining `auth_leaked_password_protection` setting), 3 INFO
(`rls_enabled_no_policy`, all confirmed fail-closed/safe).

`get_advisors(type='performance')`: **0 ERROR**, 375 WARN (364 are the
project's own deliberate multi-permissive-policy design for expressing
distinct actor types per table — not a bug; 9 were the `auth_rls_initplan`
finding on the 2 platform-owner-convenience tables, fixed this session).
