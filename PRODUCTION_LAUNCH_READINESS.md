# Production Launch Readiness Register

Methodology: a parallel multi-agent audit (security, tenant isolation,
RPC grants, finance/inventory integrity, storage, auth config,
production config/secrets) followed by a dedicated verification pass
that independently re-confirmed every claim against live database
state via direct SQL/`pg_get_functiondef`/`pg_policies` reads before
anything was trusted — plus one additional read-only pass this session
specifically closing the coverage gap the audit itself flagged
(Master Admin / platform-owner privilege boundaries, which one
sub-agent was correctly blocked from testing by the safety system
because its prompt would have permitted creating real support sessions
against production clubs at its own discretion).

**Overall result: 0 BLOCKER, 0 CRITICAL.** No confirmed cross-tenant
leak, no confirmed credential/secret exposure, no confirmed
unauthorized write path with real impact. All HIGH/MEDIUM findings
below have been fixed and live-reverified in this same session.

---

## BLOCKER

None found.

## CRITICAL

None found.

## HIGH

### H-1: `payment_proofs_bucket_insert` storage policy had no ownership/path scoping — FIXED

- **Area**: Storage / public upload surface (`payment-proofs` bucket)
- **Evidence**: `with_check: (bucket_id = 'payment-proofs'::text)` — the
  entire predicate, for roles `{anon, authenticated}`. Any caller,
  including unauthenticated, could write an arbitrary object to any
  path.
- **Risk**: Unauthenticated storage-squatting; orphaned objects when
  the follow-up `record_payment_proof_upload` RPC call never happens.
  **Not a read-exposure** — `payment_proofs_bucket_select` correctly
  gates reads through a join to the `payment_proofs` table (verified:
  requires club-staff `payment.create` permission or matching
  `customer_id`).
- **Affected flow**: Public booking payment-proof upload
  (`PaymentProofUpload.tsx`).
- **Fix**: Added a first-path-segment UUID-shape check to the INSERT
  policy, matching the pattern already used by
  `official_receipts_bucket_insert`. Migration:
  `20260827074701_tighten_payment_proofs_insert_policy.sql`.
- **Verification**: Policy re-read live post-fix, confirms the new
  `with_check` includes the regex constraint.
- **Status**: FIXED, VERIFIED.

## MEDIUM

### M-1: `official-receipts` storage bucket had no server-side size/MIME limits — FIXED

- **Area**: Storage
- **Evidence**: `storage.buckets` row for `official-receipts`:
  `file_size_limit: null`, `allowed_mime_types: null`. Contrast with
  `payment-proofs`: `10485760` / `{image/jpeg,image/png,application/pdf}`.
- **Risk**: Client-side checks exist
  (`official-collection-receipt-fields.tsx`) but weren't backstopped
  server-side — a legitimate authenticated staff caller with intent
  could bypass them via a direct API call.
- **Fix**: Set matching limits (10MB, same 3 MIME types). Migration:
  `20260827075241_set_official_receipts_bucket_limits.sql`.
- **Verification**: `storage.buckets` re-queried post-fix, values
  confirmed set.
- **Status**: FIXED, VERIFIED.

### M-2: `get_invoice_payment_summary` was directly anon-executable with no internal auth gate — FIXED

- **Area**: RPC grant hygiene
- **Evidence**: `SECURITY INVOKER` (not DEFINER), `anon_exec = true`,
  zero internal authorization check — relies entirely on RLS on
  `invoices`/`payment_allocations`/`refunds`. Those tables' SELECT
  policies correctly return zero rows for anon today, so this was not
  an active leak, but a second, unwrapped door alongside the two
  properly token-gated wrappers (`verify_invoice_public`,
  `verify_booking_qr_public`).
- **Risk**: Any future RLS regression on those three tables would turn
  this into a direct arbitrary-invoice-ID leak with no compensating
  control.
- **Fix**: Revoked `anon`/`public` EXECUTE. Verified safe before
  applying: both legitimate wrapper functions are owned by `postgres`
  (same owner as this function) — a `SECURITY DEFINER` wrapper's
  internal call is authorized via ownership, independent of grants to
  other roles. Migration: `20260827075254_revoke_anon_get_invoice_payment_summary.sql`.
- **Verification (live)**:
  ```
  anon_can_exec: false, auth_can_exec: true, owner_can_exec: true
  ```
  `anon` denied directly; `authenticated` (real staff/customer callers)
  unaffected; `postgres` (and therefore every `SECURITY DEFINER`
  function it owns, including both public wrappers) retains implicit
  execute.
- **Status**: FIXED, VERIFIED.

### M-3: `payment_gateway_configs`/`payment_gateway_transactions` carried direct anon/authenticated table grants — FIXED

*(Found independently while reviewing the payment-gateway schema for
Phase 2, not by the audit workflow — included here since it's the same
class of finding.)*

- **Area**: RLS / grant hygiene
- **Evidence**: Both tables had full default INSERT/UPDATE/DELETE/SELECT
  grants to `anon` and `authenticated`. RLS is enabled+forced on both;
  `payment_gateway_configs` has a real scoped write policy;
  `payment_gateway_transactions` had **no write policy at all** (writes
  denied by FORCE RLS default, but incidentally, not by explicit design).
- **Risk**: A future policy addition for an unrelated purpose could
  silently reopen the transaction table to direct writes; violates this
  project's own established "RPC-only, no direct table grants"
  convention.
- **Fix**: Revoked all direct grants on both tables, re-granted SELECT
  only. Discovered this broke `PaymentGatewaysCard.tsx`'s existing
  direct `.upsert()` call — replaced with a new `upsert_payment_gateway_config()`
  RPC (temporary bridge, will be superseded by the full multi-provider
  connection model in Phase 2). Migrations:
  `20260827073323_revoke_direct_payment_gateway_table_grants.sql`,
  `20260827073355_upsert_payment_gateway_config_rpc.sql`.
- **Verification (live)**: RPC write succeeds for an authorized club
  owner (`has_server_credentials` correctly stays `false`, never
  client-settable); direct table UPDATE now denied at the grant layer
  (`permission denied for table payment_gateway_configs`).
- **Status**: FIXED, VERIFIED.

## LOW

### L-1: `has_branch_access` is a raw membership-existence oracle — NOT FIXED, recommendation revised

- **Original recommendation** (from the audit): revoke anon/public
  EXECUTE.
- **Re-verification found this recommendation unsafe to apply as
  stated**: `has_branch_access` is referenced directly inside **45 RLS
  policy expressions**. RLS policies evaluate in the calling role's own
  context — revoking a role's EXECUTE on a function used inside a
  policy it needs to evaluate would break every one of those 45
  policies for that role, not just remove an unnecessary RPC surface.
- **Same issue found for the audit's other 3 "internal helper" revoke
  recommendations**: `user_club_ids` (150 policy references),
  `has_permission` (131 policy references), `is_platform_owner` (38
  policy references) — all four are load-bearing inside RLS policy
  definitions across nearly the entire schema, not just called
  internally by other RPCs.
- **Decision**: none of these four revokes were applied. Today's actual
  exposure is limited to "an authenticated/anon caller can learn a
  boolean fact keyed on an arbitrary UUID they already control no
  other data through" (e.g. `has_branch_access(random_membership_id,
  random_branch_id)` returns true/false with no other data returned) —
  a narrow existence-oracle, not a data leak. Revoking would have
  caused a real, self-inflicted RLS outage across the majority of
  tenant-scoped tables in the app. **Status: ACCEPTED RISK** — the
  original audit recommendation was itself incorrect for this specific
  fix; documented here so it isn't silently reapplied by a future pass
  without the same policy-reference check.

### L-2: 6 trigger functions carry default `PUBLIC EXECUTE`

- **Evidence**: `check_payment_allocation_sum`, `check_guardian_link_same_club`,
  `audit_messaging_safety_settings_change`, `ensure_messaging_safety_settings`,
  `protect_subscription_price_immutable`, `set_updated_at`.
- **Risk**: Minimal — these are trigger bodies, not designed to be
  called as standalone RPCs, and calling them directly via
  `/rest/v1/rpc/<name>` outside their trigger context does not bypass
  any enforcement they perform (they act on trigger-supplied `NEW`/`OLD`
  rows, not client input).
- **Status**: NOT FIXED this session — routine defensive cleanup,
  genuinely low priority, deferred to a future grant-hygiene pass. Not
  launch-blocking.

### L-3: `record_staff_whatsapp_consent(uuid,uuid,boolean,text,text)` (5-arg) is a dead orphaned overload

- **Evidence**: Both the 5-arg and 6-arg forms exist with **identical**
  grant posture (`anon_exec=false`, `authenticated_exec=true` for
  both) — not a privilege-escalation bug, just dead API surface. Only
  caller (`set_customer_whatsapp_consent` in `Customer360Page.tsx`)
  always uses the 6-arg form.
- **Status**: NOT FIXED. This touches the WhatsApp subsystem, which
  per this session's standing memory directive ("WhatsApp transport
  itself is now protected/closed, don't touch without new proven
  cause") requires the user's explicit go-ahead even for a low-risk
  cleanup. **Flagged, not auto-applied.**

### L-4: `whatsapp_delivery_confirmation_overdue` has mutable search_path

- **Evidence**: Advisor finding `function_search_path_mutable`. Not a
  `SECURITY DEFINER` function (fell outside the project-wide search_path
  hardening migration's scope). Function body is pure `STABLE` SQL with
  no table access — minimal exploitability.
- **Status**: NOT FIXED — same WhatsApp-subsystem caution as L-3.
  **Flagged, not auto-applied.**

### L-5: `QAFULL-MAIN-2026-000028` invoice has a real accounting anomaly (QA residue, not launch-relevant)

- **Evidence**: Invoice `a0658739-eea6-4cff-9030-5e88a83d6c25`, club
  "QA Full Test Club", status `issued`, `total = 200.00`, **zero**
  `invoice_items` rows, but **2 real `payment_allocations`** (cash
  120 + cash 80 = 200, both recorded 2026-08-17). Not linked to any
  booking/shop-sale/subscription.
- **Root cause**: leftover artifact from an earlier session's
  partial-payment E2E test against a club literally named "QA Full
  Test Club" — not production data, not created this session.
- **Risk to real launch**: none directly (test club, test money), but
  the underlying code gap it may represent (an invoice created without
  its line items in the same transaction, or a scenario where partial
  payments were recorded against a since-modified invoice) is worth
  understanding before real money flows through the same code paths.
- **Status**: NOT independently investigated further or deleted this
  session — flagged for the QA-cleanup pass (Section 21/101 of the
  directive), where the whole "QA Full Test Club" tenant should be
  inventoried and cleaned as a unit rather than this one row in
  isolation.

## ACCEPTED RISK (confirmed safe, no action needed)

### AR-1: `whatsapp_accounts` — RLS enabled, zero policies, broad table grants

- **Evidence**: `relrowsecurity=true, relforcerowsecurity=true`, zero
  policies, yet full anon+authenticated table grants.
- **Why safe**: FORCE RLS + zero policies = default-deny for every
  role including the table owner. Independently re-confirmed live.
  The broad grants are vestigial and harmless underneath a forced,
  policy-less table.
- **Status**: ACCEPTED RISK, confirmed safe, no action needed.

### AR-2: `auth_leaked_password_protection` disabled in Supabase Auth settings

- **Evidence**: Advisor WARN, re-confirmed present in the current
  advisor run (not stale).
- **Fix**: This is a project **setting**, not a code change — enable
  in Supabase Dashboard → Authentication → Policies → Password
  protection. No WhatsApp-directive conflict.
- **Status**: NOT FIXED this session (dashboard-only setting, outside
  what a migration can change) — **recommend enabling before launch**,
  genuinely actionable and currently outstanding. This is the one
  item in this entire register that requires a manual dashboard action
  rather than code/migration.

## ENVIRONMENT LIMITATION

### EL-1: 216 of 311 `SECURITY DEFINER` functions not individually re-verified for internal authorization

- The discovery pass used a heuristic (literal `auth.uid() IS NULL`
  string match) to find 95/311 functions with an explicit
  unauthenticated-caller guard. The remaining 216 were not individually
  proven to have equivalent protection via `has_permission()`/branch-scope
  helpers/etc. — every function spot-checked in the verification pass
  (5 of them) turned out correctly analyzed, which is a good signal but
  not a substitute for a full pass over the remaining ~211.
- **Status**: genuine open coverage gap — not a confirmed finding
  either way. A dedicated permission-boundary-prover pass over the
  full function list is recommended as ongoing security maintenance,
  not a one-time pre-launch gate (this project's own migration history
  shows this kind of audit already happens repeatedly as new features
  ship).

## Tenant Isolation — LIVE E2E VERIFIED

Real Club A vs Club B (both real production clubs with real data —
69 bookings, 25 customers, 83 invoices on the victim club), RLS
impersonation of both owners. Every cross-tenant attempt across
bookings, customers, academy enrollments, club memberships, invoices,
invoice_items, payments, staff, players, shop inventory/sales, QR
credentials, official receipts, audit logs, and every reports/financial
RPC was **DENIED** — including harder edge cases: a spoofed `p_club_id`
parameter on RPCs, a mixed valid-own-club/foreign-object-id parameter
combination, and a revoked/inactive membership attempting access (also
correctly denied, not just wrong-club).

## Master Admin / Platform-Owner Privilege Boundaries — LIVE E2E VERIFIED (this session, closing the audit's own flagged coverage gap)

The original audit's `master_admin_security` task was correctly
blocked by the safety system (its prompt would have permitted creating
real support sessions against production clubs at its own discretion
— exactly the kind of action that needs explicit authorization, not a
sub-agent's discretion). Closed this gap directly, read-only, without
ever creating a real support session:

- `has_platform_support_access()` read via `pg_get_functiondef`:
  requires the caller to hold the specific
  `platform.support.start_manage`/`start_view` permission (or be a
  real platform owner) **and** an actual live, unexpired, non-ended
  session scoped to the exact target `club_id`.
- **Live test**: a real club owner (holding neither platform permission)
  calling `start_platform_support_session()` against another real club
  → `ERROR: not authorized`, denied before any row was ever inserted.
- **Live test**: the same club owner calling `set_platform_staff_role()`
  (the newer platform RBAC self-role-edit surface) → `ERROR: not
  authorized`, denied before any lookup happened.
- Read `set_platform_staff_role()`'s full body: it also contains a
  "cannot grant a role with permissions you do not hold yourself"
  escalation guard (mirroring this project's established
  `permission_set_escalates()` pattern for club-level custom roles),
  plus a "last remaining assigner" lockout guard preventing the
  platform from accidentally losing every `platform.staff.role.assign`
  holder.
- Session-expiry data check: 10 historical support sessions exist, 0
  currently active, 0 in an "expired but not properly ended" state —
  consistent with `has_platform_support_access()`'s own `expires_at >
  now()` check.

## Finance / Inventory Integrity — LIVE E2E VERIFIED (6 of 7 checks clean, 1 finding — see L-5)

Read-only SELECT audit, no data modified: negative stock (0), duplicate
balance rows (0), over-returns (0), overpaid invoices (0), orphaned
movements (0), stuck stock counts (0). Invoice-total reconciliation:
143 of 144 invoices match `sum(invoice_items.line_total)` exactly; the
one mismatch is L-5 above (identified QA residue, not a systemic gap
— every other invoice, including several `void`-status ones, reconciles
exactly).

## Backup/Recovery — see `BACKUP_RECOVERY_PLAN.md`

## Storage — see H-1/M-1 above; club-logo/shop-product-image upload
paths do not exist in this codebase (nothing to audit there — if/when
built, follow the `payment-proofs` pattern: bucket-level limits +
`club_id`-prefixed path + RLS or RPC-validated prefix).

## Production Config — CLEAN

No hardcoded secrets, service_role keys, SMTP credentials, or
passwords found in `src/` or `cloudflare/`. All three Cloudflare Worker
configs use only the real `mal3aby.app` production domain, no
dev/localhost/staging URLs. Frontend Supabase URL/key is fully
env-driven (zero hardcoded literals). The three workers' hardcoded
project ref (`gxkrtlvpjwxhcqdisyob`) is internally consistent. Neither
GitHub Actions workflow echoes a secret into logs.

## QA Residue — 1 item identified, not yet cleaned (see L-5)

The "QA Full Test Club" tenant (and its one anomalous invoice) is the
only QA residue surfaced by this audit. Full inventory/cleanup deferred
to this directive's own Section 21/101 QA-cleanup step, to be done once
alongside any new QA fixtures created during Phase 2/3/4 work — cleaning
it now, mid-audit, in isolation risked missing related rows the
cleanup step's own systematic sweep would catch.

---

## Launch Blockers Remaining: 0

No BLOCKER or CRITICAL finding remains. All HIGH and MEDIUM findings
were fixed and live-reverified in this session. The 5 LOW findings and
1 accepted-risk item are genuinely low-severity, and 2 of the 5 LOW
items are deliberately deferred pending the user's explicit go-ahead
per the standing WhatsApp-subsystem protection directive — not
oversights.
