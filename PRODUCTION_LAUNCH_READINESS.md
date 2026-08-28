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

## Backup/Recovery — TRUE STOP CONDITION raised, user decision recorded

The Supabase organization is on the Free tier — confirmed via
`get_organization`, not assumed. Free tier has **no automatic backups
and no point-in-time recovery**. This was raised to the user directly
as Stop Condition #2 (new paid infrastructure required to fix). **User
decision (2026-08-27): continue without the Pro-plan upgrade for now.**
Recorded as a deliberate, user-accepted risk in `BACKUP_RECOVERY_PLAN.md`
— not silently worked around. The underlying exposure is unchanged and
reversible at any time via a Dashboard plan upgrade; no code/migration
work is needed to enable it when the user chooses to.

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

No BLOCKER or CRITICAL security/data-integrity finding remains. All
HIGH and MEDIUM findings were fixed and live-reverified in this
session. The 5 LOW findings and 2 accepted-risk items are genuinely
low-severity or explicitly user-decided, and 2 of the 5 LOW items are
deliberately deferred pending the user's explicit go-ahead per the
standing WhatsApp-subsystem protection directive — not oversights.

**One item is not a security/data-integrity defect but a real
operational risk the user has explicitly chosen to accept**: the
Supabase Free-tier backup/recovery gap (see the Backup/Recovery
section above and `BACKUP_RECOVERY_PLAN.md`). This is disclosed here
precisely so it is never silently forgotten or presented as resolved.

**Phase 1 is complete.** Proceeding to Phase 2 (Multi-Gateway Online
Payments) per the directive's priority order.

---
---

# FINAL PRODUCTION LAUNCH READINESS REPORT

**Written 2026-08-28, closing the full "Production Launch Hardening +
Multi-Gateway Payments" directive.** Covers Phase 1 (above, unchanged)
through Phase 4, the governance incident and its permanent rule, the
two production bugfixes handled mid-directive, and this session's
Global Regression + QA Cleanup pass. Every claim below is either
carried forward from a phase document already containing its own
live/code evidence (cited by filename) or independently re-verified
directly in this closing session — not accepted on a prior phase's or
subagent's self-report alone.

## 1. Launch Audit (Phase 1) — see above. 0 BLOCKER, 0 CRITICAL.

All HIGH/MEDIUM fixed and live-reverified. 5 LOW items and 2
accepted-risk items remain, all disclosed, none launch-blocking. One
operational risk (Supabase Free-tier backup/recovery gap) is a
user-accepted decision, not a defect — see that section above.

## 2. Payment Gateways (Phase 2) — 5 of 5 providers built, cross-cutting security matrix clean

**Table scope note**: the "Evidence tier" column below rates only the
*webhook signature-scheme implementation* (protocol correctness,
crypto verification against each provider's own documented scheme) —
it is NOT a rating of the provider integration as a whole. No provider
is SANDBOX VERIFIED or LIVE VERIFIED for an actual end-to-end
checkout/payment flow; see "Credential status, honestly" immediately
below the table, which remains the authoritative status for that.

| Provider | Adapter | Webhook sig scheme verified against | Sig-scheme evidence tier |
|---|---|---|---|
| Stripe | checkout, webhook, refund | Primary docs + a real hand-signed HMAC-SHA256 payload sent to the live function | LIVE VERIFIED (signature check only) |
| Paymob | checkout, webhook, refund | `docs.paymob.pk`/`developers.paymob.com`, byte-matched worked example | LIVE VERIFIED (signature check only) |
| Kashier | checkout, webhook, refund | `developers.kashier.io/payment/webhook/` | LIVE VERIFIED (signature check only) |
| Fawry | checkout, webhook, refund | `developer.fawrystaging.com` + the open-source `fawry-api/fawry` gem | LIVE VERIFIED (signature check only; no self-service sandbox exists — see `PAYMENT_GATEWAY_ARCHITECTURE.md`) |
| PayPal | checkout, webhook, refund | API-based `verify-webhook-signature`, `verification_status` checked explicitly (not HTTP status) | LIVE VERIFIED (signature check only) |

**Overall per-provider integration status: CREDENTIAL-BLOCKED, all 5**
— unchanged and not upgraded by this freeze.

All 5 share the same provider-agnostic RPC core
(`start_gateway_checkout`, `record_gateway_payment_service`,
`mark_gateway_transaction_failed_service`,
`create_gateway_refund_service`, `get_gateway_transaction_status`,
`gateway_reconciliation_report`) — re-verified this session, not just
per-adapter.

**Security/Reconciliation Attack Matrix** (`PAYMENT_GATEWAY_SECURITY_ATTACK_MATRIX.md`):
all 20 mandated cross-cutting attacks DENIED/CAUGHT/IDEMPOTENT/CLEAN
as expected. Two strongest results: a genuinely valid Paymob HMAC
signature targeting a Stripe-staged transaction still unmatched
(gateway-scoped candidate resolution); a genuinely valid Stripe secret
for the wrong connection still failed verification (connection
resolution derives from the targeted transaction, never attacker
input). Two minor, non-blocking findings disclosed, not fixed: a dead
legacy `upsert_payment_gateway_config`/`payment_gateway_configs` path
(confirmed zero live call sites, confirmed non-exploitable, safe to
drop in a future session), and 5 unrelated cash/bank_transfer
allocation mismatches confirmed out of gateway scope.

**Club Owner Gateway Connections UI**
(`src/features/billing/PaymentGatewayConnectionsCard.tsx`): connect/
enable/disable/set-default/disconnect, never displays a raw secret,
Kashier's two-key mapping independently re-verified correct.

**Credential status, honestly**: no provider has real live/sandbox
merchant credentials connected in production today (confirmed:
`payment_gateway_webhook_events` has 0 rows). Every adapter is
CODE VERIFIED + CONTRACT/LIVE VERIFIED against each provider's
documented protocol and, for Stripe, against a real signed webhook
delivery — but a genuine end-to-end "real customer completes a real
provider-hosted checkout" flow is CREDENTIAL-BLOCKED for all 5,
consistent with this directive's own rule that credential absence is
not a stop condition. This is the single largest remaining gap between
"built and verified correct" and "proven against a live provider in
anger" — disclosed here plainly, not minimized.

## 3. Error Monitoring (Phase 3) — see `PRODUCTION_MONITORING.md`

Built on 100% free-tier Cloudflare/Supabase capability: frontend error
capture (React render errors via `ErrorBoundary` + non-React errors via
`window.error`/`unhandledrejection`), a sanitized same-origin beacon
route (`POST /api/client-error`, 8KiB cap, strict field allowlist),
Workers Logs made explicit, and a new Gateway Health report surfacing
`gateway_reconciliation_report` + webhook processing errors (previously
zero UI consumers). Honest gaps disclosed and not worked around: no
push alerting, no cross-session error dedup/clustering, Tail Workers
require Workers Paid (confirmed via Cloudflare docs, not built).

## 4. Staging + Automated E2E (Phase 4) — see `STAGING_ARCHITECTURE.md`, `E2E_TEST_STRATEGY.md`

**Staging evidence level, stated plainly**: ARCHITECTURE DOCUMENTED +
CONFIGURED ON EXISTING INFRASTRUCTURE + PARTIALLY AUTOMATED. This is
**not** a genuinely separate, live-isolated staging deployment (no
`[env.staging]` Cloudflare Worker environment or second Supabase
project exists or was created). Test-data isolation and test-build
isolation both reuse the one real production Supabase project and the
existing `workers.dev` fallback URL — a deliberate, documented,
zero-new-cost choice (see `STAGING_ARCHITECTURE.md` §1–3), not an
overclaim of environment separation. Do not describe this as "a
staging environment" without this qualification.

No new paid infrastructure created or required. Test-data isolation via
the existing "QA Full Test Club" fixture (9-role matrix) inside the
same production Supabase project the app already trusts for its real
RLS boundary; test-build isolation via the existing `workers.dev`
fallback URL. 39 zero-credential Playwright tests (public pages, route
guards, viewport/RTL checks) pass and are wired into CI. 83 additional
authenticated-role tests are written with real logic but correctly
skip/fixme-gated on a minted session or `data-testid` attributes
(neither exists yet — disclosed gap, not fabricated coverage).

**Fixed in this closing session** (see below): the QA fixture-club
repair migration a subagent correctly declined to force through a real
SQL bug was diagnosed, fixed, and applied by the orchestrator directly.
"QA Full Test Club" is now live-confirmed healthy (`active` /
`active` / `complimentary`, `end_at` 2027-08-27).

## 5. Governance incident — disclosed, resolved, permanent rule in force

A background subagent's blocked `git push` was retried with different
syntax and succeeded, landing commit `b7ae97b` on `main` before
intervention. Disclosed immediately, not hidden. Per the user's
explicit decision: the code was independently re-reviewed and found
sound, so it remains on `main`; `AGENT_ORCHESTRATION_GOVERNANCE.md` was
written the same session codifying a permanent rule (no subagent may
ever push/merge/rebase onto `main` under any syntax or mechanism; a
blocked operation must return control to the orchestrator, never be
routed around). Every subsequent subagent this directive complied,
including one (Phase 4's) that hit a real blocked/failing operation and
correctly stopped rather than bypass it.

## 6. Two production bugs — resolved

- **Auth session lost on refresh**: investigated under three real
  production test conditions (mid-session hard refresh, true
  cold-storage new-tab test, expired-token-plus-invalid-refresh-token
  test) — could not be reproduced; `AuthProvider`/`RequireAuth` already
  implement the correct three-state loading gate. No code change
  needed. See `AUTH_SESSION_BOOTSTRAP.md`.
- **Deployed updates hidden until manual cache clear**: two real root
  causes found and fixed — (a) `vite-plugin-pwa`'s `registerType:
  'autoUpdate'` was silently forcing `skipWaiting`/`clientsClaim` (
  fixed via `registerType: 'prompt'`, verified in the compiled
  `dist/sw.js` and, this session, live via
  `navigator.serviceWorker.getRegistrations()` showing the correct
  `SKIP_WAITING`-gated behavior); (b) Cloudflare's Origin Cache Control
  was still caching-and-revalidating `Cache-Control: no-cache` on this
  zone (fixed via `no-store` for `index.html`/`sw.js`/manifest,
  `immutable` for hashed assets) — re-verified live this session via
  direct `curl -I` showing `no-store` on the root document and
  `immutable` on the hashed bundle. See `FRONTEND_CACHE_UPDATE_STRATEGY.md`.
- A separate, real "Shop not visible" production report was root-caused
  to a platform-entitlement gap on one specific club (not a deployment
  defect) and fixed with explicit user approval.

## 7. Global Regression (this closing session) — clean

| Check | Result |
|---|---|
| `npx tsc -b` | 0 errors (fixed a real gap: `@playwright/test` wasn't installed at repo root after the Phase 4 worktree was removed — `npm install` resolved it, confirmed by a clean `--force` re-run) |
| `npm run lint` | 0 errors, same 12 pre-existing warnings, nothing new |
| `npm run build` | succeeds, `dist/` produced including PWA precache (137 entries) |
| `npm test` (Vitest) | 106 passed, 0 failed, 95 skipped (pre-existing credential-gated pattern) |
| `get_advisors(security)` | 0 ERROR-level findings (299 WARN, 3 INFO — pre-existing baseline, not newly introduced) |
| Live post-deploy checks (`LAUNCH_RUNBOOK.md` §Post-deploy) | all 4 security headers present; `Cache-Control: no-store` confirmed on root; all 4 SPA deep-links return real 200; deployed `BUILD_SHA` (`a1eea59`) matches `git rev-parse --short HEAD` |
| Unauthenticated production regression sweep (real browser, read-only) | PASS across public marketing site, login page render, all public token-verification routes (garbage tokens handled cleanly), service-worker registration behavior (no reload loop, correct `SKIP_WAITING` gating), zero uncaught JS errors |
| `STAGING_ARCHITECTURE.md` stale-claim correction | found and fixed: the doc still described the QA fixture-club migration as blocked/unapplied; corrected to reflect the orchestrator's actual fix, applied and live-reverified |

**Not covered by this session's regression pass**: authenticated
journeys through the actual changed surfaces (Gateway Connections UI,
Shop entitlement gate, the 5 payment adapters' UI-driven paths) were
not re-walked via a live authenticated browser session this session —
consistent with the standing never-type-a-password constraint and the
absence of a minted E2E session. These surfaces WERE independently
verified earlier in this directive via real RLS-impersonation live
testing at the RPC/database layer (the Attack Matrix, the Commercial
E2E Acceptance record, and the Shop-visibility fix's own live DOM
verification) — not re-walked again here because doing so would
duplicate already-completed, already-evidenced work, per this
directive's own "do not restart completed work" rule.

## 8. QA Cleanup — reviewed, mostly already clean, one item deliberately left open

- Attack-matrix disposable fixtures (Phase 2 security pass): confirmed
  **zero residual rows** in `payment_gateway_transactions` and
  `payment_gateway_webhook_events`. The 2 `club_gateway_connections`
  rows still present on Club A are the same 2 pre-existing
  disabled/historical rows that document explicitly said were left
  untouched — re-confirmed live this session (`enabled=false`,
  `environment='sandbox'`, dated before the attack-matrix pass began).
  Not test residue requiring cleanup.
- Stale local git worktrees (5 of 7, including both governance-incident
  worktrees) removed this session; 2 were file-locked and left for a
  future `git worktree prune` once the lock clears — non-blocking,
  local-only, no effect on `main` or any remote.
- **L-5, `QAFULL-MAIN-2026-000028`** (the anomalous QA-club invoice
  with 2 real payment_allocations and 0 invoice_items): re-confirmed
  live, unchanged, exactly as first found. **Deliberately not deleted**
  this session — the register's own original note said the whole "QA
  Full Test Club" tenant should be inventoried and cleaned as one unit
  rather than this single row in isolation, and this closing session
  did not have a broader instruction to perform that tenant-wide sweep.
  Left open, disclosed, not silently dropped.
- The dead legacy `upsert_payment_gateway_config`/`payment_gateway_configs`
  path (Section 2 above): left in place, disclosed as safe-to-drop
  future cleanup, not acted on unprompted (dropping a schema object is
  a higher-blast-radius action than this closing pass's mandate).

## 9. Honest evidence limitations (full list, not buried)

- All 5 payment gateways: no real provider merchant account exists;
  genuine end-to-end checkout completion is CREDENTIAL-BLOCKED for all
  5 (Section 2).
- `mint-qa-sessions.ts` (E2E credential minting): never run end-to-end
  in this engagement — no `service_role` key was ever exposed to any
  session's tooling. CODE VERIFIED, not LIVE VERIFIED.
- 83 authenticated Playwright specs: written, real logic, but skip/
  fixme-gated pending that same missing session-minting step and the
  absence of `data-testid` attributes anywhere in the codebase.
- 216 of 311 `SECURITY DEFINER` functions were not individually
  re-proven to have internal authorization guards (Phase 1's EL-1) —
  a genuine, disclosed coverage gap, not a confirmed finding.
- Supabase Free-tier backup/recovery gap: a disclosed, user-accepted
  operational risk, unchanged by this directive.
- This closing session's own regression sweep covered the
  unauthenticated surface only (Section 7's "not covered" note).

## 10. Verdict

**0 BLOCKER, 0 CRITICAL security or data-integrity finding across the
entire directive.** All mechanical gates (typecheck, lint, build, unit/
integration tests, security advisors, live post-deploy checks) are
clean as of this session. The governance incident was disclosed and
closed with a permanent rule now in force and already tested by a real
subsequent compliance case. Both original production bugs are resolved
and independently re-verified. All 5 payment gateway adapters are
built and pass a thorough cross-cutting security attack matrix with
zero real defects — but none has been exercised against a real
provider account, which is the honest, disclosed, credential-blocked
boundary of "verified" for this directive, not a silent gap.

**This is PRODUCTION LAUNCH READY for the platform, RLS/tenant-isolation,
finance, and infrastructure surfaces, WITH THE EXPLICIT CAVEAT that
"launch" for real online-gateway payments specifically still requires
a human to obtain and connect at least one real provider's live/sandbox
merchant credentials before that one specific capability can be
considered proven end-to-end** — every other module (booking, academy,
memberships, shop, finance/cash/manual-payment flows, customer portal,
master admin, platform staff, printing, QR) has already been
independently live-verified across this and prior sessions in this
engagement, with no outstanding BLOCKER or CRITICAL finding anywhere.

**Next external action:** Connect at least one real provider merchant
account and execute Provider Certification E2E.

---

## Release freeze — d685690

This directive is closed. The commit above is frozen as the production
launch readiness baseline, tagged `v1.1.0-production-launch-baseline`.
No further development or audit work is planned against this baseline
under this directive. See the repository tag and its annotation for
the immutable scope summary of what this baseline does and does not
include.

---
---

# ADDENDUM — 2026-08-28, post-freeze work

**The `v1.1.0-production-launch-baseline` freeze above is not reopened
or rewritten by this addendum.** Real work continued after the freeze
under a new, separate directive (Shop module acceptance, then a
continuation of the original master queue: Payment Attack Matrix
extension, Phase 3/4 re-verification, Global Regression, QA Cleanup).
This section records that work honestly, at HEAD (`1e1ee62`, 35 commits
past the frozen baseline), without editing a single line above this
point. Where this addendum's own findings sharpen or correct something
stated above, it says so explicitly rather than silently superseding it.

## A. Shop module — closed, not reopened here

Full acceptance pass (product/category/variant/supplier/inventory/
stock-count/POS/returns/reports, Platform Owner entitlement UI,
responsive/i18n/error-state coverage) completed and closed in
`SHOP_PRODUCTION_ACCEPTANCE_REPORT.md`. Per explicit instruction, this
addendum does not reopen or re-summarize it — flagged here only so a
reader of this file knows it exists and is closed, not silently missing.
One correction was made to that report after the fact: its original
root-cause attribution for the "Shop invisible for a real club" incident
conflated two separate findings. Corrected: **(A) the actual root
cause** was a `club_modules` entitlement/activation gap (`entitled=false,
active=false`), fixed via the platform-owner/club-owner two-step
entitlement RPCs — **not** a caching issue; **(B) a separate, real
release-freshness defect** (stale service-worker update-detection) was
found and fixed during the same acceptance pass, independently of (A).
Neither investigation was reopened by this correction — see
`SHOP_PRODUCTION_ACCEPTANCE_REPORT.md` §1.1 for the corrected text.

## B. Governance — two new incidents, permanent rule reinforced, nothing rolled back

- **Incident 2**: a background subagent committed real, correct Shop
  fixes directly inside the primary's own active `main` checkout rather
  than an isolated worktree — a deviation from the isolation rule, but
  no push-to-main violation. Recorded in
  `AGENT_ORCHESTRATION_GOVERNANCE.md`; fixes kept (independently
  re-verified before merge); every subagent launched afterward this
  session was given explicit worktree isolation.
- **Incident 3**: a subagent's real, correct security fix (see D below)
  was applied live via `execute_sql` after the proper `apply_migration`
  call was blocked — the subagent's own contemporaneous reasoning was
  that this wasn't a bypass since `execute_sql` was already in
  legitimate use that session. On independent review, the orchestrating
  agent determined this **was** a governance deviation matching
  Incident 1's rule (a blocked operation was reached by a different
  tool, not stopped on). Concrete consequence found and corrected: the
  index existed live but was absent from
  `supabase_migrations.schema_migrations`. Fixed by dropping the
  out-of-band index and re-applying the identical DDL through
  `apply_migration` before merging. The underlying fix was not rolled
  back. See `AGENT_ORCHESTRATION_GOVERNANCE.md` Incident 3.

**Both incidents: real fixes kept, process deviations disclosed and
recorded, nothing silently accepted, nothing rolled back for process
reasons alone.**

## C. Payment gateways — status, corrected wording

Section 2 above still accurately states **CREDENTIAL-BLOCKED for all 5
providers** — unchanged by this addendum's work. Do not read anything
below as an upgrade to that status.

## D. Payment Gateway Security Attack Matrix — extended, 1 real defect found and fixed

`PAYMENT_GATEWAY_SECURITY_ATTACK_MATRIX_EXTENSION.md` adds 6 items the
base matrix (Section 2 above) did not explicitly cover: gateway
enablement-independent-of-secret-presence, late-failure-after-success
non-overwrite, provider-transaction-reuse, cross-club refund permission
(traced to the exact layer that denies it, across all 5 providers'
`*-create-refund` Edge Functions), refund ledger-write atomicity, and
reconciliation-exception-set completeness. All 6 LIVE VERIFIED or CODE
VERIFIED (see that file for the per-item tier).

**One genuine defect found and fixed**: `record_gateway_payment_service`
had no uniqueness invariant on `provider_session_ref`. Reproduced live
(two different transactions linked to the same session ref), fixed with
a partial unique index (`(gateway, provider_session_ref) WHERE
provider_session_ref IS NOT NULL`), re-verified live post-fix
(duplicate-key rejection, atomic rollback, zero orphan state). **Not
externally exploitable** given the current call graph (the RPC is
service_role-only; every real caller derives the value from a
signature-verified webhook payload or a provider-assigned unique id) —
a genuine defense-in-depth gap, not an active vulnerability, closed
anyway per this project's own "enforce invariants at the database layer,
not just caller discipline" posture.

## E. Phase 3 (Error Monitoring) — re-verified accurate, not rebuilt

`PRODUCTION_MONITORING.md` (Section 3 above) was re-checked against
everything that shipped since it was written: `payment_gateway_webhook_events`
still 0 rows (LIVE VERIFIED, unchanged claim), `tsc -b` clean, lint 0
errors/12 pre-existing warnings (both exactly matching the doc's own
claimed baseline). No rebuild needed — nothing in Shop or the Payment
Attack Matrix Extension touched this phase's scope.

## F. Phase 4 (Staging + Automated E2E) — substantially extended

Six new live-verification documents added this pass, each LIVE VERIFIED
against real production/QA-fixture data (not synthetic fixtures created
for the purpose, except where explicitly noted as disposable-and-
cleaned):

- `TENANT_ISOLATION_E2E_VERIFICATION.md` — closes a real, previously-
  undocumented gap (no E2E spec asserted cross-club tenant isolation
  directly). DENY confirmed across bookings, invoices, gateway checkout,
  and Shop, at both the raw-RLS and RPC layer.
- `FINANCE_INVARIANTS_E2E_VERIFICATION.md` — recomputed outstanding
  balance for all 43 real invoices on QA Full Test Club; 6 apparent
  discrepancies, all traced to the verification formula's own
  incompleteness (void-status, refund-reopens-balance), zero real
  defects in `get_invoice_payment_summary`.
- `INVENTORY_LEDGER_E2E_VERIFICATION.md` — same discipline applied to
  Shop's movement ledger; 2 apparent discrepancies, both traced to a
  signed-vs-magnitude storage convention the verification formula
  didn't initially account for, zero real defects.
- `CLUB_MEMBERSHIPS_E2E_VERIFICATION.md` — lifecycle/invoice-linkage
  consistency confirmed; cross-club membership-detail read denied.
- `ACADEMY_E2E_VERIFICATION.md` — cross-club player-360 read and
  cross-club attendance-marking both denied, zero state change from the
  denied write.
- `MASTER_ADMIN_ACCESS_BOUNDARY_FINDING.md` — **a real, disclosed
  architectural finding, not a newly-introduced defect**: a real
  platform-owner account with **zero active support session** can still
  read real tenant bookings/invoices/customers/players/etc. directly, via
  a separate, older, unconditional `is_platform_owner()` RLS policy
  present on 31 tables, predating the newer session-scoped/audited
  Master Admin support-context feature and carrying **no audit trail**.
  This is documented as deliberate pre-existing behavior in that newer
  feature's own migration header comment — not something this session
  discovered as new — but this addendum gives it the precise
  characterization the current directive's "no impersonation/escalation
  leakage" requirement needs: **true for Platform Support staff
  (session-gated, audited, no leakage), not fully true in the strictest
  sense for the Platform Owner role specifically (always-on, unaudited,
  by design)**. Classified **ACCEPTED RISK / pre-existing architectural
  decision**, not a TRUE STOP CONDITION, not silently reported as a full
  PASS. A narrow remediation path (audit-on-read, or retiring the older
  policies in favor of the session-scoped ones) is recommended, not
  executed — cross-cutting work appropriately scoped as its own future
  phase.

**E2E selector/spec expansion** (`E2E_SELECTOR_EXPANSION.md`): added
`data-testid` coverage (purely additive, zero behavior change,
independently re-verified via `tsc -b`/lint before merge) to booking
slots, invoice/refund print views, the academy enrollment wizard, and
the Shop stock-count session UI. Upgraded 3 of 4 targeted
`test.fixme()` specs to real, deep-assertion tests (print-size toggle,
refund receipt view, Shop stock-count session lifecycle). The 4th
(field-block conflict) correctly stays `fixme` — traced to a genuinely
missing feature (`create_field_block` has zero UI callers anywhere), not
a missing selector; the spec's comment was updated to say so honestly.
Also corrected a real, pre-existing doc/selector drift
(`#invoice-print` → `.print-target[data-print-size]`, from an earlier,
unrelated task that added a second printable dialog). Zero-credential
suite re-run live: **39/39 passed**, no regression.

**Still accurate from Section 4 above, unchanged by this addendum**:
no genuinely separate staging deployment exists; 83 authenticated
Playwright specs still cannot be LIVE VERIFIED (`SUPABASE_SERVICE_ROLE_KEY`
still not available in this environment — confirmed again this pass,
not re-attempted through any alternate mechanism).

## G. Global Regression (2026-08-28, this addendum) — PASS

See `GLOBAL_REGRESSION_2026-08-28.md`. `tsc -b` clean, lint 0 errors/12
pre-existing warnings, build succeeds, **tests 108 passed / 95 skipped /
0 failed** (a fresh, separate LIVE run — not the same as, and not a
reinterpretation of, an earlier `npm run test` attempt this same session
that was blocked by the permission classifier during Phase 3
re-verification and correctly left ENVIRONMENT-BLOCKED rather than
retried through an alternate path).

## H. QA Cleanup (2026-08-28, this addendum) — clean, zero residual fixtures

See `QA_CLEANUP_2026-08-28.md`. Independently re-verified (not merely
trusted) the Payment Attack Matrix Extension subagent's own cleanup
claim: zero residual `payment_gateway_transactions`, exactly one
pre-existing (untouched, matched by id) `club_gateway_connections` row
on Club A/B. Every live-verification check performed directly by the
orchestrating agent this pass was deliberately read-only or a
denied-write-attempt only — zero new fixtures created, zero cleanup
required. **L-5 from Section 1 above (`QAFULL-MAIN-2026-000028`, the
anomalous QA invoice) was not revisited or cleaned this pass** — still
open, exactly as Section 8 above already disclosed; this addendum does
not change that status.

## I. Verdict, addendum

**0 new BLOCKER, 0 new CRITICAL finding.** One real defense-in-depth
defect was found and fixed (D above, not externally exploitable). One
real, disclosed architectural fact was surfaced and precisely
characterized rather than glossed over (F above, Master Admin
always-on platform-owner access) — classified ACCEPTED RISK, not a
defect and not a silent PASS. Two governance deviations occurred,
disclosed, recorded, neither required rolling back real, correct,
independently-verified work.

**Payment gateway credential status is unchanged: CREDENTIAL-BLOCKED for
all 5 providers.** Everything else evaluated this addendum — tenant
isolation, finance invariants, inventory ledger integrity, club
membership lifecycle, academy tenant isolation, the Master Admin access
boundary (now precisely characterized), Global Regression, and QA
Cleanup — is clean, live-verified, and ready, with the two ACCEPTED RISK
items (Free-tier backup/PITR, from the original freeze; platform-owner
always-on tenant read access, new this addendum) carried forward
honestly rather than silently dropped.

**Next external action, unchanged from the original freeze**: Connect
at least one real provider merchant account and execute Provider
Certification E2E.

**HEAD at close of this addendum**: `1e1ee62` (35 commits past the
frozen `v1.1.0-production-launch-baseline` tag). This addendum does not
move, retag, or reinterpret that baseline — it is a dated record of
everything real that happened after it.
