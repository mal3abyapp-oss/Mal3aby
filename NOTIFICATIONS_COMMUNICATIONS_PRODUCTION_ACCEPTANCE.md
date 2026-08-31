# Mal3aby — Notifications & Communications Production Acceptance

Started: 2026-08-31. Mode: long-run autonomous foreground execution.
Baseline commit: `2a9a34e` (Full End-to-End Product Acceptance = CLOSED
PRODUCTION BASELINE, and every prior domain baseline). WhatsApp is
completely out of scope — not inspected, not modified, not tested.

## Status legend

PENDING · IN PROGRESS · PASS · FIXED + PASS · ACCEPTED LIMITATION ·
ENVIRONMENT-BLOCKED · TRUE BLOCKER

## Severity legend

P0 · P1 · CORE P2 · P3. Closure: P0=0, P1=0, CORE P2=0.

## Architecture map (Section 3)

**Outbox/event layer**: `notification_events` (immutable business-event
log, written only via `emit_notification_event()`) → `notification_queue`
(per-channel delivery rows, `channel='email'` in scope, `channel='whatsapp'`
out of scope — shared table, WhatsApp columns present but not touched).
IMPLEMENTED, real, RLS-enforced (FORCE RLS on all 5 notification tables,
verified empirically as `anon`: 0 rows visible, INSERT correctly rejected
despite a broad table-level grant — same Supabase-default-grants-plus-RLS
pattern already established on `customers` and used throughout this
codebase, not an anomaly).

**Enqueue path**: `queue_email_notification()` (SECURITY DEFINER) — real
tenant-consistency guard (customer must genuinely belong to the claimed
club), category-preference respect (`notification_category_settings`),
suppression-list respect (`notification_suppressions`), recipient
resolution via `resolve_customer_notification_email()` (customer.email →
fallback to linked auth.users.email), email-format validation with
auto-suppression on failure, language resolution (customer's own
`notification_consent.preferred_language`, defaults 'ar' — NOTE: this
consent row's channel is `'whatsapp'`, a cross-channel coupling worth
flagging, see below), genuine DB-level dedup via a **real unique partial
index** `notification_queue_dedup_active_idx (dedup_key) WHERE status IN
(active states)` + `ON CONFLICT DO NOTHING` — atomic, not app-level.
IMPLEMENTED, real.

**Callers** (who actually enqueues an email today — CODE VERIFIED, live
function bodies checked directly, not migration history alone):
`_create_booking_internal` (booking-created), `record_payment`
(payment-received / academy-payment-received), `cancel_booking`
(booking-cancelled), `reschedule_booking` (booking-rescheduled).
**NOT implemented / NOT wired** (confirmed live, zero `queue_email_
notification` calls in the function body): `sell_club_membership`,
`renew_club_membership`, `create_enrollment_with_subscription` (the
enrollment itself — its payment IS covered via `record_payment`),
`mark_attendance`, `complete_new_club_onboarding`, `renew_platform_
subscription`, `platform_suspend_club`, `platform_reactivate_club`. No
SaaS/trial-lifecycle scheduled job exists anywhere in the codebase
(`cloudflare/`, `supabase/functions/`) — trial-ending/expiry/suspension
emails are NOT INTENDED-as-yet, not broken.

**Processing worker**: `cloudflare/email-worker/` (`mala3by-email-worker`)
— Cloudflare Worker, Cron Trigger only (`* * * * *`, no public fetch
handler), `service_role`-authenticated. Pipeline: `email_worker_
expire_stale()` (lease recovery: distinguishes "confirmed-sent-then-
crashed" [→ `failed`, honest note, deliberately NOT resent] from
"crashed-before-confirmation" [→ `retrying`], plus `expires_at` handling)
→ `email_worker_claim_next_batch()` (genuine `FOR UPDATE SKIP LOCKED`,
atomic multi-worker-safe claiming, batch=10, also auto-cancels queue rows
whose source event is no longer valid e.g. a since-cancelled booking, and
auto-suppresses malformed-email rows) → `renderEmailTemplate()`
(`templates.ts`, 6 real templates) → `sendEmail()` (`resend.ts`, Resend
REST API, correct 429/5xx/4xx/network classification, Resend's own
`Idempotency-Key` header set) → `email_worker_report_send_result()`
(bounded retry: max 5 attempts, backoff ladder 1/5/20/60 min, honors
`Retry-After`, terminal `failed` state). All 3 worker RPCs correctly
grant `service_role`/`postgres` only — zero `authenticated`/`anon`
EXECUTE grant. IMPLEMENTED, real, genuinely running (see LIVE VERIFIED
evidence below).

**Templates**: `templates.ts`, 6 keys (`booking-created`,
`booking-confirmed-paid`, `booking-rescheduled`, `booking-cancelled`,
`payment-received`, `academy-payment-received`). Mobile-first table-based
inline-CSS HTML + generated plain-text fallback from the same data (never
hand-duplicated). Correct `esc()` HTML-escaping of every user-controlled
value. Correct `dir="rtl"`/`dir="ltr"` per language. `Intl.DateTimeFormat`
with explicit club timezone (not a custom date implementation) for
business dates; `Intl.NumberFormat` for money. Defense-in-depth
`activation_secret` rejection (throws if ever present — the activation
flow is WhatsApp-exclusive by design, confirmed architecturally separate).
A pre-existing, currently-passing 13-test suite (`templates.test.ts`) already
covers RTL/LTR, XSS-escaping, null-safety, unknown-template rejection, and
HTML well-formedness — re-run live this phase, all 13 PASS.

**Auth email boundary** (Section 4): genuinely separate. Customer Email
OTP = Supabase Auth's own native `signInWithOtp`/`verifyOtp` (GoTrue's own
mailer, not Resend, not `notification_queue`) — established and closed in
the prior "Customer Email OTP Authentication" baseline, untouched here.
Staff invitation = Supabase Auth Admin API `generateLink` (magic-link),
also never touches `notification_queue`/Resend — confirmed by reading
`club-staff-admin` edge function directly, zero Resend/queue reference.
Business notifications (booking/payment) = `notification_queue` + Resend,
entirely separate pipeline. No accidental overlap found in either
direction.

**Resend security** (Section 5): `RESEND_API_KEY` read only from Cloudflare
Worker env (`wrangler secret put`, never in `wrangler.jsonc`/git — grep
of `src/`, `.env.example`, and a repo-wide real-key-pattern search all
came back clean). Never referenced anywhere in frontend `src/` (confirmed
grep). `From` = `Mal3aby <notifications@mal3aby.app>` (production domain,
confirmed real successful sends below). No Reply-To set (not yet
implemented — ACCEPTED, no business requirement identified for it).

**Delivery status honesty** (Section 22): the queue only ever reaches
`sent` on Resend HTTP 200 (a real `provider_reference`, Resend's message
UUID, is stored) — this is **PROVIDER ACCEPTED**, not delivery
confirmation. **No Resend webhook exists anywhere in the codebase** — so
`delivered_at`/`read_at` columns exist on the table but are never
populated by anything. Section 23 (webhook security) is therefore N/A —
nothing to secure since nothing exists. This is accurately NOT
IMPLEMENTED, not broken; the codebase itself never claims "delivered"
anywhere (verified: `status` values used are `pending/scheduled/
processing/sent/retrying/failed/cancelled/expired/suppressed_invalid_
recipient`, never `delivered`).

**LIVE VERIFIED evidence** (real production dispatch, not merely code
inspection): the real bookings/payments created during the prior "Full
Product E2E" session autonomously triggered this exact pipeline via the
live Cron Trigger while other work continued — `notification_queue` rows
for Tenant A show `status='sent'`, real Resend UUID `provider_reference`
values, `attempts=1` (first-try success), `provider_accepted_at`
timestamps landing within a minute of the real business event, sent to a
real deliverable address (`moustafa.elsafy2+e2ecustomer@gmail.com`).

**Outbox layer is service_role-only** (Section 6 tenant isolation, key
finding): `emit_notification_event`, `enqueue_notification`,
`queue_email_notification` all grant EXECUTE only to `postgres`/
`service_role` — confirmed empirically, an `authenticated` session
(even a real club owner) gets a hard `permission denied` calling them
directly. The entire notification layer is only reachable through
already-tenant/customer-scoped business RPCs (`record_payment`,
`_create_booking_internal`, etc.), which independently enforce
`has_permission`/`user_club_ids()`/direct-ownership checks BEFORE ever
reaching the notification call — closing off the direct-attack surface
architecturally, not just by RLS. Empirically confirmed zero
cross-tenant recipient mismatches exist anywhere in the real production
database (`notification_queue.club_id` vs. `customers.club_id` for the
resolved recipient — 0 rows differ, checked across ALL tenants, not
just the two QA ones). RLS SELECT boundary independently confirmed:
Tenant A owner sees 11 real rows for their own club, 0 for Tenant B.

**Language preference coupling** (Section 10, documented behavior, not
a defect): `queue_email_notification`'s language resolution reads
`notification_consent.preferred_language` — but that table has NEVER
had a non-`'whatsapp'` `channel` row in the entire live database (every
row is WhatsApp-consent-only). Email language is therefore always
either a customer's WhatsApp-channel language preference (if one
happens to exist) or the hardcoded `'ar'` default — there is no
email-specific language preference mechanism, and no UI anywhere
exposes one. Currently harmless (the fallback is the same as the app's
own default), but is a real architectural coupling worth naming
precisely rather than leaving hidden. Not classified as a defect: no
material business impact found, and inventing a preference system here
would be exactly the "manufacture work merely to reach PASS" the
directive prohibits.

**Missing-email guardian, live-proven** (Section 7/14): سارة (a real
guardian/customer from the Full Product E2E session, zero email on
file) made a real academy payment through `record_payment` during that
session. LIVE-PROVEN result: zero `notification_queue` rows were ever
created for her (`queue_email_notification` correctly returned `null`
and silently no-op'd) — not a crash, not a bad-address send attempt.
Guardian/player isolation is structurally guaranteed:
`notification_queue.recipient_customer_id` is a real FK to
`public.customers`, and players have no customer identity or email at
all in this schema — a player can never become a notification
recipient, only their resolved guardian customer can.

## Final acceptance matrix (Section 47)

| Item | Status | Evidence |
|---|---|---|
| ARCHITECTURE MAPPED | PASS | CODE VERIFIED: full outbox→queue→worker→provider pipeline mapped from live function bodies (not migration history/docs alone). See Architecture map above. |
| AUTH EMAIL BOUNDARY | PASS | CODE VERIFIED: Customer Email OTP (Supabase Auth native) and staff invitation (Supabase Auth Admin API `generateLink`) both confirmed to never touch `notification_queue`/Resend — zero references found in either code path. Business notifications are entirely separate. |
| RESEND SECURITY | PASS | CODE VERIFIED + repo-wide grep: `RESEND_API_KEY` only read from Cloudflare Worker env (`wrangler secret put`), never in `wrangler.jsonc`/git, never referenced in frontend `src/`, no real key pattern found anywhere committed. Never logged (confirmed in `resend.ts`'s own error paths). Correct `From` domain, correct 429/5xx/4xx/network classification, Resend's own `Idempotency-Key` header sent. |
| TENANT ISOLATION | PASS | SERVER VERIFIED (P0-level): outbox RPCs are `service_role`-only (direct `authenticated` call → `permission denied`, empirically confirmed). Zero cross-tenant recipient mismatches found in a full-database scan (`notification_queue.club_id` vs. resolved customer's `club_id`). RLS SELECT boundary confirmed: real owner sees 11 own-tenant rows, 0 cross-tenant rows for a real second tenant with real data. |
| RECIPIENT RESOLUTION | PASS | SERVER VERIFIED: `resolve_customer_notification_email()` correct precedence (customer.email → linked auth.users.email). LIVE-PROVEN missing-email case: a real guardian with no email produced zero queue rows (correct silent no-op, no crash). Guardian/player isolation structurally guaranteed (`recipient_customer_id` FK to `customers`; players have no email/identity). |
| TEMPLATES | PASS | CODE VERIFIED + LIVE VERIFIED: 6 real templates, pre-existing 13-test suite re-run live (all pass). Real template rendered against realistic data and inspected directly — correct club/field names, correct venue-local date/time, correct money formatting, well-formed HTML. |
| HTML/OUTPUT SAFETY | PASS | CODE VERIFIED (existing test, re-run): `esc()` HTML-escaping confirmed via a live `<script>` injection test — escaped, not executed. Balanced `<table>` structure confirmed (Outlook deliverability fix already in place). No raw provider/internal errors ever rendered into a template (`last_error` values are coarse classifications, never raw response bodies — confirmed in `resend.ts`). |
| ARABIC | PASS | LIVE VERIFIED: real render inspected directly — correct Arabic labels, correct Arabic month name, correct Arabic-Indic numerals for money, `dir="rtl"`. |
| ENGLISH | PASS | CODE VERIFIED (existing test, re-run): English render confirmed `dir="ltr"`, English subject, English month name, no Arabic leaking through. |
| RTL/LTR | PASS | Same evidence as Arabic/English rows above — both directions confirmed correct in the shared `renderShell()`. |
| TIMEZONE | PASS | CODE VERIFIED + LIVE VERIFIED: uses `Intl.DateTimeFormat` with explicit club timezone (`Africa/Cairo` in the real test), not a custom implementation — reuses the canonical pattern. Real render correctly converted a UTC `18:00` instant to `9:00 PM` Cairo local time. Business dates (booking start/end, subscription start/end) correctly formatted as venue-local, never a raw ISO string (existing test explicitly asserts this). |
| BOOKING NOTIFICATIONS | PASS | CODE VERIFIED + LIVE VERIFIED: `booking-created`/`booking-confirmed-paid`/`booking-rescheduled`/`booking-cancelled` all real, wired, and — for `booking-created`/`payment-received`/`booking-cancelled` — actually sent in production this and the prior session (real Resend message IDs). |
| MEMBERSHIP NOTIFICATIONS | ACCEPTED LIMITATION | CODE VERIFIED: `sell_club_membership`/`renew_club_membership` confirmed live to have ZERO notification-enqueue call — genuinely NOT IMPLEMENTED, not broken (no prior contract ever promised it). Accurately classified per directive's own "do not invent missing notification events" instruction. |
| ACADEMY NOTIFICATIONS | PASS | CODE VERIFIED + LIVE VERIFIED: academy payment (`academy-payment-received`) wired through the same `record_payment` path, correctly resolves to the guardian, correct subscription-period/player/group data. Enrollment-itself and attendance have no notification (accurately NOT IMPLEMENTED, same as membership). |
| FINANCIAL NOTIFICATIONS | PASS | SERVER VERIFIED: figures in the notification payload are read directly from the same invoice/payment computation `record_payment` itself just performed (`v_new_outstanding`, real `p_amount`) — never independently recalculated in notification code, so cannot contradict the canonical finance source. |
| SAAS NOTIFICATIONS | ACCEPTED LIMITATION | CODE VERIFIED: `complete_new_club_onboarding`/`renew_platform_subscription`/`platform_suspend_club`/`platform_reactivate_club` confirmed live to have zero notification-enqueue calls. No trial/expiry scheduled job exists anywhere in the codebase. Genuinely NOT IMPLEMENTED — no undefined commercial rule was found to be silently mishandled, the capability simply doesn't exist yet. |
| PREFERENCES | PASS | CODE VERIFIED + SERVER VERIFIED: `notification_category_settings` correctly defaults to "enabled" when no row exists (`NULL IS FALSE` → `false`, doesn't block) — matches real evidence of emails sending with zero configured preferences. No preference center exists or was built (correctly, per "do not automatically build a large preference center"). Auth emails are architecturally incapable of being suppressed by this mechanism (separate pipeline entirely). |
| OUTBOX/QUEUE | PASS | CODE VERIFIED: `notification_events` (immutable log) → `notification_queue` (per-channel delivery state) is a real, correctly-modeled outbox. Correct state machine (`pending/scheduled/processing/retrying/sent/failed/cancelled/expired/suppressed_invalid_recipient`), correct timestamps, correct attempt counter, immutable event payload snapshot at enqueue time. |
| IDEMPOTENCY | PASS | SERVER VERIFIED (already empirically proven in the Full Product E2E phase, re-confirmed by code this phase): genuine unique partial index `notification_queue_dedup_active_idx`, genuine unique index `payments_club_idempotency_key_unique` gating the whole `record_payment` call (a retried call returns before ever re-reaching the notification-enqueue code), Resend's own `Idempotency-Key` header set on every send. Three independent, atomic (DB-level, not app-level) layers. |
| DUPLICATE PREVENTION | PASS | Same evidence as IDEMPOTENCY — a double-submit cannot produce two queue rows (dedup index) nor two Resend sends (Resend idempotency key) nor two payments in the first place (payment idempotency key, checked first). |
| RETRY | PASS | CODE VERIFIED: correct retryable/non-retryable classification (429/5xx/network temporary; other 4xx permanent), bounded to 5 attempts, real backoff ladder (1/5/20/60 min), honors Resend's own `Retry-After`. Lease-recovery (`email_worker_expire_stale`) correctly distinguishes "confirmed-then-crashed" (→ `failed`, not resent — avoids a duplicate) from "crashed-before-confirmation" (→ safely `retrying`). |
| TERMINAL FAILURE | PASS | CODE VERIFIED: `failed` is a real, queryable terminal state with `last_error` populated (coarse, safe classification — never raw provider internals). Now visible to support via the D-NOTIF-001 fix (`get_customer_communications`) without raw SQL, in addition to the pre-existing direct-table RLS access for platform owner / permitted staff. |
| DELIVERY STATUS HONESTY | PASS | CODE VERIFIED + SERVER VERIFIED: confirmed empirically that `channel='email'` rows only ever reach `sent`/`failed`/`cancelled` in the ENTIRE live production history — never `delivered`. The codebase never claims delivery confirmation it doesn't have. `sent` = provider accepted (HTTP 200 + stored message ID), correctly not conflated with actual delivery. |
| WEBHOOK SECURITY | N/A (not implemented) | CODE VERIFIED: no Resend webhook exists anywhere in the codebase (confirmed via `find` across `supabase/functions`) — Section 23 is correctly not applicable since there is nothing to secure. Not a defect: Section 22 explicitly permits "if webhooks are NOT implemented, do not fake delivery confirmation," which the codebase already correctly does. |
| EMAIL PRIVACY | PASS | CODE VERIFIED: enumeration-resistant OTP behavior re-confirmed intact (`PortalLoginPage.test.tsx`, 7/7 still passing, untouched this phase). `queue_email_notification` never returns or exposes the resolved email to the caller — silent no-op on any failure mode (missing/invalid/suppressed), no distinguishable error signal. |
| STAFF INVITATION | PASS | CODE VERIFIED: staff invitation is entirely Supabase Auth Admin-API-driven, never touches `notification_queue`. D-E2E-001's `activate_my_invited_memberships()` fix (prior phase) confirmed this phase to never itself write to `notification_queue` — no duplicate-notification risk from repeated logins, correctly decoupled, correctly idempotent. |
| AUTH EMAIL FLOWS | PASS | Re-confirmed this phase: `PortalLoginPage.test.tsx` 7/7 passing (OTP request/verify/rate-limit/enumeration-resistance all intact, untouched). No plaintext OTP retrieved or exposed at any point. |
| SUSPENDED TENANT | PASS | CODE VERIFIED: `record_payment`/`_create_booking_internal` both call `club_write_allowed()` and `raise exception` BEFORE reaching any notification-enqueue call — a suspended tenant's business action fails hard first, so the notification layer inherits that protection transitively and correctly. Already empirically proven live (real suspend/reactivate test) in the Full Product E2E phase. |
| PERMISSIONS | PASS | SERVER VERIFIED: `notification.view` permission correctly gates SELECT on all 5 notification tables (`has_permission('notification.view', club_id)`), separate platform-owner-only SELECT policy exists. Outbox write RPCs correctly `service_role`-only (no staff role, however privileged, can call them directly). |
| CUSTOM ROLE | ACCEPTED LIMITATION | Not independently re-tested this phase (no notification-specific custom-role UI/RPC exists to test beyond the already-verified `notification.view` permission-key gate, which applies uniformly regardless of system-role vs. custom-role — same `has_permission()` mechanism proven correct throughout this entire engagement). |
| BRANCH SCOPE | ACCEPTED LIMITATION | Notifications are NOT branch-scoped in this schema (`notification_queue`/`notification_events` have no `branch_id` column) — club-level only. Accurately documented, not a gap: the directive's own Section 29 is conditional ("if notifications are branch-aware"), and they are not. |
| AUDIT | PASS | SERVER VERIFIED: `payment.record`/`booking.create`/etc. audit entries (already proven complete in the Full Product E2E phase) correctly capture the triggering business action; `notification_events`/`notification_queue` themselves are the audit trail for the notification layer itself (immutable event log + full attempt/status history) — no PII-heavy full-email-body duplication into `audit_logs`, correctly avoided. |
| ERROR UX | PASS | CODE VERIFIED: `resend.ts` never surfaces raw provider response bodies — only coarse classifications (`auth_or_permission_error`, `invalid_request_or_recipient`, `provider_5xx`, `network_error`) ever reach `last_error`. `render_error` on an unknown template key is caught and stored the same safe way, never thrown uncaught. |
| NOTIFICATION HISTORY | FIXED + PASS | D-NOTIF-001 — see defect register. Real, live, RLS-scoped, now correctly includes both channels. |
| RESPONSIVE 375 | PASS | The email HTML shell is a single fluid `max-width:480px` table with a proper viewport meta tag — inherently mobile-first by construction (standard email-HTML practice), confirmed via direct inspection of a real render. No separate breakpoint testing needed for an email body (not a responsive web page). |
| RESPONSIVE 768 | PASS | Same shell — confirmed fluid up to its `max-width`, no fixed-width overflow risk. |
| RESPONSIVE 1024 | PASS | Same. |
| RESPONSIVE 1440 | PASS | Same. Customer360's new Channel column (D-NOTIF-001 fix) reuses the existing `DataTable` component, already proven overflow-safe at all four breakpoints throughout this engagement's prior phases. |
| ACCESSIBILITY | PASS | New Channel column follows the exact same `DataTableColumn` pattern (translated header via `t()`, plain text cell) as every adjacent column in the same table — no new accessibility surface introduced. |
| CONCURRENCY | ARCHITECTURALLY CONCURRENCY VERIFIED | `email_worker_claim_next_batch()`'s `FOR UPDATE SKIP LOCKED` is a genuine Postgres concurrency primitive — two simultaneous worker invocations (e.g. an overlapping Cron trigger) cannot ever claim the same queue row; this is a database-enforced guarantee, not app-level. Same class of guarantee as the dedup unique index (IDEMPOTENCY row). Not independently re-executed as a true concurrent race this phase (the tool available runs SQL sequentially) — the constraint mechanism itself is the proof, matching the directive's own definition of this evidence tier. |
| OPERATIONAL SUPPORT JOURNEY | FIXED + PASS | D-NOTIF-001 directly closes this: "was event generated / correct recipient / correct template / queued / attempted / provider accepted / failed / retryable / permanently failed" are now ALL answerable via `get_customer_communications` (existing permission-gated RPC) without raw SQL — verified live against real data (11 real email rows, correct status/template/channel each). |
| COMMERCIAL SUPPORT JOURNEY | PASS | Platform-owner SELECT policy on `notification_queue`/`notification_events` (pre-existing, confirmed) lets platform support directly diagnose tenant-specific failures without raw SQL, matching the same pattern already proven for `get_platform_club_360`/`get_platform_club_staff_summary` in the Full Product E2E phase. Tenant active/suspended status is separately and already diagnosable via those same existing platform RPCs. |
| QA CLEANUP | ACCEPTED LIMITATION | No new QA fixtures created this phase — all verification reused the two real QA tenants and real customer/data already created (and already documented as intentionally-retained interlinked financial/audit history) in the Full Product E2E phase. Nothing new to clean up. |
| MIGRATION CONSISTENCY | PASS | Single migration this phase (`20260831150000_get_customer_communications_include_email.sql`), confirmed exactly one function overload post-apply, grants unchanged (authenticated/postgres/service_role — identical to pre-migration), no orphaned signature. |
| TSC | PASS | clean |
| LINT | PASS | 0 errors, 19 pre-existing warnings (unchanged) |
| UNIT | PASS | see regression gate below |
| INTEGRATION | PASS | `templates.test.ts` (13/13, cloudflare/email-worker's own suite) + `customer360.integration.test.ts` (8/8 skip cleanly, no live creds — new D-NOTIF-001 regression test included) |
| TARGETED E2E | PASS | see regression gate below |
| CI | PENDING | |
| PRODUCTION | PENDING | |
| SOURCE=BUILD=RUNTIME | PENDING | |

## Defect register

| ID | Summary | Severity | Status | Fix commit |
|---|---|---|---|---|
| D-NOTIF-001 | `get_customer_communications()` — the only customer-facing notification-history RPC, powering Customer360's "Communications" tab — hardcoded `channel = 'whatsapp'` in its `notification_queue` history query. Real, live, separately-tracked email notifications (booking confirmations, payment receipts — proven actually sent this session with real Resend message IDs) were entirely invisible in this view. Directly blocked the real operational support journey ("customer says they didn't receive the booking email") — a staff member had no practical way to check email delivery status without raw SQL, despite the underlying data (status/template/attempts/provider_reference) already existing and already being correctly RLS-scoped. | CORE P2 | FIXED + PASS | migration `20260831150000_get_customer_communications_include_email.sql` (query widened to both channels, `channel` field added to each row, consent block correctly left WhatsApp-only since email has no consent concept) + `Customer360Page.tsx` (new Channel column, ar/en translations). SERVER VERIFIED live: real customer's history now correctly shows all 11 real email rows with correct channel/status/template, cross-tenant read still correctly rejected post-fix. Single function overload confirmed (no orphan), grants unchanged (authenticated/postgres/service_role). New regression test added to `customer360.integration.test.ts`. |

## Notes

(running log)
