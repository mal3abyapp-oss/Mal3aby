# Production Monitoring — Phase 3 (Error Monitoring)

**Status: COMPLETE** (2026-08-28), built on top of Phase 2 (Multi-Gateway
Online Payments). Directive constraint honored throughout: no new paid
service, subscription, or external dependency was introduced. Everything
below runs on the current Cloudflare Workers free tier and Supabase Free
tier.

This document distinguishes three things explicitly, per the directive:
what already existed before this phase, what was built new in this phase,
and an honest list of what still doesn't exist (gaps that would require
either more engineering effort within the free tier, or a genuinely paid
capability — each one is labeled).

---

## 1. What already existed (confirmed real, not duplicated)

These were investigated and verified directly against the live Supabase
project (`gxkrtlvpjwxhcqdisyob`) and the repository before building
anything new, per the directive's instruction not to duplicate existing
groundwork.

### 1.1 `write_audit_log` / `audit_logs` — business-event audit trail
A durable, queryable audit log (170+ migration call sites), covering
booking/payment/refund/discount/subscription lifecycle events with
before/after JSON state. **This is not an error-monitoring system and
was not touched or extended in this phase** — it already correctly
serves its own distinct purpose (who did what, when), and mixing it with
error/incident logging would blur two concepts that should stay separate
(a business event is not the same thing as a system failure).

### 1.2 `payment_gateway_transactions.correlation_id`
`uuid not null default gen_random_uuid()` — confirmed live in the schema.
Ties together checkout → webhook → canonical payment posting for the
payment domain. Reused conceptually (see §3.4) but not modified — Phase 2
is closed and its gateway RPCs/tables were not touched.

### 1.3 Every gateway Edge Function's `sanitize*Error()` helper
Confirmed present via direct grep across all 15 gateway functions
(`stripe-*`, `paymob-*`, `kashier-*`, `fawry-*`, `paypal-*`):
`sanitizeStripeError`, `sanitizePaypalError`, `sanitizePaymobError`,
`sanitizeKashierError`, `sanitizeFawryError` — each strips a raw provider
error body down to a small set of safe fields before it is ever logged
or returned to a client. This is the discipline every new piece of
monitoring built in this phase follows (see §3).

### 1.4 `payment_gateway_webhook_events.processing_error`
Confirmed real column, populated by every gateway webhook Edge Function
on a processing failure (`fawry-gateway-webhook`, `kashier-gateway-webhook`,
`paymob-gateway-webhook`, `paypal-gateway-webhook`, `stripe-gateway-webhook`
all write to it — 13 call sites across the 5 webhook functions). Directly
queried the live table: **0 rows exist today**, which is expected and
correct — no gateway has live credentials connected yet (Phase 2 built
the adapters as verified skeletons; none is a real, connected production
integration). The column is correctly positioned to catch a real failure
the moment one occurs. **The real gap found here was not data capture —
it was that nobody could see this without writing a manual SQL query.**
Closed in §3.3.

### 1.5 `gateway_reconciliation_report(p_club_id, p_date_from, p_date_to)`
Confirmed real, `SECURITY DEFINER`, permission-gated on
`payment.methods.view` (or platform support access), read-only. Read its
full definition directly from `pg_proc`: it returns a transactions list,
an `exceptions[]` array (three exception types — succeeded transaction
with no linked payment, payment with zero allocations, transaction/
payment amount mismatch), and a summary. **This RPC had zero UI
consumers anywhere in the app** — confirmed by grepping `src/` for its
name (it appeared only in the generated TypeScript types, never called).
Closed in §3.3.

### 1.6 `src/lib/version.ts`
Confirmed working: `__MAL3ABY_BUILD_SHA__`/`__MAL3ABY_BUILD_TIME__` are
real `vite.config.ts` `define`-time constants (actual git SHA + build
timestamp), logged to console on load and shown in the Settings footer.
Already solves "which build is a user's browser running." Extended in
this phase (see §3.1) to also appear in the ErrorBoundary crash screen
and in every client-error beacon payload, so a reported incident always
carries its build SHA.

### 1.7 `cloudflare/frontend-worker/wrangler.jsonc` observability block
Confirmed already present as a bare `"observability": {"enabled": true}`
before this phase — this alone was already sufficient to activate
Workers Logs (confirmed via Cloudflare's current documentation: "All
newly created Workers will come with the observability setting enabled
by default," and `enabled: true` is documented as sufficient to capture
invocation logs, custom `console.*` logs, and uncaught exceptions).
Made more explicit in this phase (see §3.2) rather than left implicit.

---

## 2. Investigation before building (what "current capabilities" actually means)

Per the directive's non-negotiable constraint, the following was
researched directly against current Cloudflare documentation (via live
doc search this session, not assumed from training data) before
concluding anything:

- **Workers Logs** (`observability.enabled: true` + `head_sampling_rate`)
  — confirmed free-tier, no plan upgrade required, GA since April 2025.
  7-day retention, 5 billion logs/account/day limit, queryable via the
  dashboard's Query Builder and via public REST API endpoints. This
  project's traffic volume is nowhere near that limit.
- **Workers Traces** — a separate, newer observability surface
  (request-scoped binding-call spans). Investigated and deliberately
  NOT enabled: this Worker makes no D1/KV/Durable Object/service-binding
  calls Traces would usefully visualize (it does exactly one thing —
  proxy to Workers Static Assets and inject headers/handle one JSON
  beacon route). Revisit if that changes.
- **Tail Workers** — investigated as a candidate mechanism for
  programmatically forwarding logs/exceptions from the frontend Worker
  to a second processing Worker. Confirmed via Cloudflare's own
  documentation: **"Tail Workers are available to all customers on the
  Workers Paid and Enterprise tiers."** This is a genuine, confirmed
  paid-tier gate — **NOT built**, and NOT worked around. See §4 for the
  full honest accounting of what this means in practice.
- **Programmatic query of Workers Logs from this agent** — Cloudflare
  does publish public REST API endpoints for querying the Workers Logs
  dataset (list keys, run a query, list unique values per key), but no
  MCP tool exposed to this session surfaces them (only
  `workers_get_worker`, `workers_get_worker_code`, and `workers_list`
  were available — no logs/observability query tool). This means: the
  dashboard Query Builder and `wrangler tail` (real-time, CLI-based) are
  the current working ways to read Workers Logs; a future agent with a
  Cloudflare API token could call the REST endpoints directly, but this
  session did not have that credential surfaced to it. **This is a real,
  working, free capability — just not something this particular agent
  session could query hands-off.** Documented honestly rather than
  either claiming full programmatic access or overstating the gap as a
  paid-tier limitation (it is not; it's a tooling-access limitation for
  this session).

---

## 3. What was built new in this phase

### 3.1 Frontend error capture (React render errors + errors outside React)

**Files:** `src/lib/errorReporting.ts` (new), `src/components/ui/error-boundary.tsx`
(rewritten), `src/main.tsx` (extended).

- `generateIncidentId()` — a client-generated `crypto.randomUUID()`,
  deliberately separate from `payment_gateway_transactions.correlation_id`
  (see §3.4 for why these were kept as two distinct identifier spaces
  rather than unified).
- `reportClientError()` — fire-and-forget, sanitized (allow-listed
  fields only: incident id, capped error message, capped stack trace,
  build SHA, current path, source tag — never PII, never a raw object).
  Uses `navigator.sendBeacon` (survives the page unloading mid-crash)
  with a `fetch(..., {keepalive:true})` fallback. Never throws back to
  the caller — a broken error reporter must never itself become a
  second visible error.
- `ErrorBoundary` (React render-error safety net) now: generates an
  incident id on catch, shows it to the user (`errorBoundary.incidentId`
  i18n key, both locales) alongside the current build SHA, and fires the
  beacon. The stale "no external error-tracking integration — out of
  scope, needs a Sentry account" comment is replaced with an accurate
  description of what is actually built and why it satisfies the real
  requirement (native free-tier tooling, not "add Sentry specifically").
- `src/main.tsx` gained `window.addEventListener('error', ...)` and
  `window.addEventListener('unhandledrejection', ...)` — a real,
  previously-nonexistent gap: `ErrorBoundary` only ever catches errors
  thrown during React's own render/lifecycle. An error thrown from a
  plain DOM event handler, a `setTimeout` callback, or an unawaited
  rejected Promise previously vanished with nothing beyond whatever the
  browser's own devtools console happened to show. Both listeners route
  through the same `reportClientError()` path.

### 3.2 Worker Logs configuration made explicit

**File:** `cloudflare/frontend-worker/wrangler.jsonc`.

`head_sampling_rate: 1` added explicitly (previously relied on an
undocumented-in-this-repo implicit default). Documented in-line why
`logs.invocation_logs` (the 2025-beta sub-key) was deliberately NOT
added — current GA docs confirm `observability.enabled: true` alone is
sufficient; the nested key is not required at the current Wrangler/API
version. Wrangler version confirmed installed: **4.123.0** (well above
the 3.78.6 minimum documented for Workers Logs support).

### 3.3 Client-error beacon route (Worker-side)

**File:** `cloudflare/frontend-worker/src/index.ts`.

Workers Logs only captures what happens *inside* a Worker's own `fetch`
handler — it has no visibility into browser-side JavaScript at all
(confirmed via Cloudflare doc search: Workers Logs is "logging data
emitted from Cloudflare Workers," not from arbitrary web clients). The
only way to get a browser-side error into Workers Logs without a
third-party service is to have the browser POST a small sanitized report
to this same-origin Worker and log it there with `console.error`, which
Workers Logs already captures for free. That is the entire purpose of
the new `POST /api/client-error` route:

- same-origin only (no CORS headers added; the CSP's `connect-src 'self'`
  already scopes what the page itself is allowed to call)
- hard body-size cap (8 KiB) enforced both via `Content-Length` and by
  actually measuring the read buffer (never trusts a lied-about or
  absent `Content-Length`)
- a strict allow-list of fields, each independently length-capped and
  coerced to `string` — the same "never forward an arbitrary/attacker-
  shaped object into a log" discipline every gateway `sanitize*Error()`
  helper already established
- never throws back to the caller on a malformed body (`204` in every
  degraded case, `405`/`413` only for wrong method / oversized body)
- structured `console.error('client_error_report', {...})` — lands in
  Workers Logs as a real error-level entry, filterable via Cloudflare's
  own documented `$metadata.error EXISTS` filter or by searching for the
  literal `client_error_report` tag or a specific `incident_id`

### 3.4 Correlation-id decision (documented, not built as a shared column)

Investigated whether to extend `payment_gateway_transactions.correlation_id`'s
pattern into a single shared identifier space with the new frontend
incident id. **Decision: keep them separate**, documented directly in
`src/lib/errorReporting.ts`'s header comment:

- A render error has no necessary relationship to any in-flight payment
  — forcing a shared column would leave it null in the overwhelming
  majority of error reports, or invite conflating two unrelated
  concepts (a payment-domain correlation id vs. a frontend-error
  incident id).
- Cross-referencing between the two remains fully possible without a
  shared column: both the payment `correlation_id` and the frontend
  `incident_id` are UUIDs a human can search for directly in their
  respective logs (Supabase logs / `payment_gateway_transactions` for
  the former, Workers Logs for the latter), and the frontend beacon
  additionally carries the build SHA and timestamp, so a support
  conversation can narrow to "this build, this time window" even
  without a literal foreign key between the two domains.

### 3.5 Proactive gateway-health surface (closing the "nobody sees this" gap)

**Files:** `src/features/reports/ReportGatewayHealthPage.tsx` (new),
`src/features/finance/FinanceReportsPage.tsx` (new tab wired in),
`src/features/reports/components/ReportsNav.tsx` (legacy-route deep-link
map extended), `src/app/routing/router.tsx` (standalone route registered).

Confirmed neither `gateway_reconciliation_report` nor
`payment_gateway_webhook_events.processing_error` had any UI consumer —
`ReportReconciliationPage.tsx` (the existing "Reconciliation" report tab)
calls a *different* RPC (`get_financial_reconciliation_report`, the
cash/shift/government-receipt cross-check from an earlier phase), and
`PlatformAlertsPage.tsx` only surfaces subscription-lifecycle alerts
(trial ending, grace period, etc.) — neither touches gateway data at all.
This was a real, disclosable gap, exactly as the directive anticipated.

New "Gateway health" tab, same pattern as every sibling tab in the
Financial Reports hub (`FinanceReportsPage.tsx`'s existing tab-switcher
architecture, unchanged):

- Calls `gateway_reconciliation_report` directly (not through the
  shared `useDateRangeReport` hook, since this RPC's parameters are
  named `p_date_from`/`p_date_to` rather than the hook's hardcoded
  `p_start_date`/`p_end_date` — a real, confirmed signature difference,
  not an oversight; a small dedicated `useQuery` call was written
  instead of touching either the RPC or the shared hook)
- Renders the summary counts (total/succeeded/failed/pending
  transactions) and the `exceptions[]` list (with a real, working
  "View invoice" link — resolved via the response's own `transactions[]`
  array cross-referenced through the existing `fetchPaymentInvoiceIds()`
  helper, the same one `ReportReconciliationPage.tsx` already uses, so
  no fabricated/unwired deep-link was shipped)
- Separately queries `payment_gateway_webhook_events` for any row with a
  non-null `processing_error`, scoped to the current club's own
  transactions in the selected date range (tenant-scoped by construction
  — the table has no direct `club_id` column, so scoping goes through
  `payment_gateway_transactions.club_id` first)
- Gated client-side on `payment.methods.view` (same permission the RPC
  itself enforces server-side) — UI hint only; RLS and the RPC's own
  `has_permission`/`has_platform_support_access` check independently
  re-enforce this regardless of what the client renders, matching the
  exact pattern `PaymentGatewayConnectionsCard.tsx` already established
- Deliberately shows an honest "no online gateway transactions yet is
  expected while gateways are not connected with live credentials"
  footer note, rather than presenting an empty state ambiguously (empty
  because nothing is wrong vs. empty because nothing has happened yet
  are different facts, and this report is currently in the second state
  — confirmed live: 0 rows in `payment_gateway_webhook_events` today)

Both English and Arabic i18n added in full (`reports.gatewayHealth.*`,
`reports.nav.gatewayHealth`, `finance.reportsPage.gatewayHealth`).

---

## 4. Honest gap assessment

What this phase does **not** give you, stated plainly rather than
implied as solved:

- **No alerting/paging.** Nothing pages anyone when an error occurs.
  Workers Logs and the new Gateway Health report are both *pull*
  surfaces (someone has to open the dashboard or the report) — there is
  no push notification. Building real push alerting on entirely free
  infrastructure was investigated as out of scope for this phase's time
  budget; the honest state is "observable if you look," not "you will
  be told."
- **No cross-session error grouping/dedup.** Each incident id is unique
  per error occurrence; there is no automatic "this is the 47th
  occurrence of the same underlying bug" clustering the way a real APM
  (Sentry, etc.) provides. A human reading Workers Logs has to do that
  correlation manually.
  **This is the actual "true stop condition" boundary of this phase**:
  that clustering/grouping capability is what a paid error-tracking
  service is fundamentally for, and building an equivalent from scratch
  on free-tier primitives (e.g., a new Postgres table to store and
  fingerprint every client error, with its own retention/cleanup
  policy) was judged to be materially new infrastructure beyond "enable
  what the current stack already supports" — it would be building a
  bespoke Sentry-lite, not configuring existing capability. Flagged
  here rather than silently built or silently skipped.
- **Tail Workers require the Workers Paid plan** — confirmed via
  Cloudflare's own docs (§2). Not built, not worked around. This means:
  no second Worker can programmatically intercept every log/exception
  from the frontend Worker to fan it out elsewhere (e.g. to a Discord
  webhook, a KV-backed dashboard, etc.) without that paid tier. Workers
  Logs itself (the dashboard-queryable 7-day log store) remains fully
  free and is the real, working capability documented in §3.2–3.3.
- **No programmatic (agent-side) Workers Logs query in this session** —
  see §2. Real, free, dashboard/`wrangler tail`-accessible today; not
  something this session could pull via an available tool.
- **Gateway Health report currently shows empty data** — correctly, not
  as a defect. No gateway has live credentials connected (confirmed:
  `payment_gateway_webhook_events` has 0 rows in production today). This
  report will start showing real activity the moment a gateway goes
  live; it was built now, ahead of that, specifically so the observability
  gap does not appear only after the fact.

## 5. Files changed in this phase

- `cloudflare/frontend-worker/wrangler.jsonc` — explicit `head_sampling_rate`,
  documented reasoning for what was and wasn't added.
- `cloudflare/frontend-worker/src/index.ts` — new `POST /api/client-error`
  sanitized beacon route.
- `src/lib/errorReporting.ts` — new. Shared incident-id + beacon helper.
- `src/lib/version.ts` — unchanged (confirmed already correct, reused).
- `src/components/ui/error-boundary.tsx` — incident id + build SHA shown
  to the user, beacon wired in, stale Sentry comment corrected.
- `src/main.tsx` — `window.error`/`unhandledrejection` listeners added.
- `src/features/reports/ReportGatewayHealthPage.tsx` — new.
- `src/features/finance/FinanceReportsPage.tsx` — new "Gateway health" tab.
- `src/features/reports/components/ReportsNav.tsx` — legacy-route deep-link
  map extended.
- `src/app/routing/router.tsx` — standalone `/app/reports/gateway-health`
  route registered.
- `src/lib/i18n/resources/en/common.json`, `src/lib/i18n/resources/ar/common.json`
  — `errorBoundary.incidentId`, `reports.gatewayHealth.*`,
  `reports.nav.gatewayHealth`, `finance.reportsPage.gatewayHealth`.
- `vitest.config.ts` — added the `define` block `vite.config.ts` already
  had for the real build, closing a latent (previously dormant) gap this
  phase's own new import graph surfaced: `src/App.test.tsx` failed with
  `__MAL3ABY_BUILD_SHA__ is not defined` once `error-boundary.tsx` began
  importing `version.ts` transitively — fixed at the actual source
  (test config parity with the real build config), not worked around.

No changes were made to any payment gateway adapter, RPC, the attack-
matrix doc, `write_audit_log`, or the business-event audit trail.

## 6. Verification evidence

- `npx tsc -b` — clean, 0 errors.
- `npm run lint` — 0 errors, 12 pre-existing warnings (all present before
  this phase's changes; none newly introduced — confirmed by diffing the
  lint output before and after the hooks-ordering fix in
  `ReportGatewayHealthPage.tsx`, which was the one real lint error this
  phase introduced and then fixed).
- `npm run build` — succeeds, produces `dist/` including the new
  `ReportGatewayHealthPage` chunk.
- `npm run test` — 106 passed, 95 skipped (pre-existing integration
  tests requiring live data, unaffected by this phase), 0 failed.
- Live database checks via direct SQL against project `gxkrtlvpjwxhcqdisyob`:
  `write_audit_log` definition, `payment_gateway_transactions`/
  `payment_gateway_webhook_events` schemas, `gateway_reconciliation_report`
  full definition, and a live row-count query on
  `payment_gateway_webhook_events` (0 total, 0 with a processing error —
  confirmed expected given no gateway has live credentials yet).
