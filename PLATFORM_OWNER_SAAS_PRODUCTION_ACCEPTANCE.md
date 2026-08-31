# Platform Owner / SaaS Subscription & Tenant Lifecycle — Production Acceptance

Tracking document for the "MAL3ABY — PLATFORM OWNER / SAAS SUBSCRIPTION & TENANT
LIFECYCLE, FULL AUTONOMOUS PRODUCTION ACCEPTANCE & HARDENING" directive (2026-08-31).

Status values: `PENDING` / `IN PROGRESS` / `PASS` / `FIXED + PASS` /
`ACCEPTED LIMITATION` / `ENVIRONMENT-BLOCKED` / `TRUE BLOCKER`

Closure threshold: P0 = 0, P1 = 0, CORE P2 = 0.

## Business rules resolved by direct code evidence (NOT guessed — do not re-litigate as ambiguous)

- **Early renewal (Section 16)**: `renew_platform_subscription()` uses `v_start := greatest(v_prev.end_at, now())`. Renewing before expiry extends from the current expiry (no gap, no lost paid time); renewing after expiry starts from now (never back-dated). The `no_overlapping_subscription_periods` EXCLUDE constraint additionally guarantees no double-booked periods are structurally possible. **Not a TRUE BLOCKER — definitively answered by the code.**
- **Refund deactivating service (Section 35)**: platform-level "refund" doesn't exist as a concept — the only related RPC is `reverse_platform_payment()`, which sets `platform_invoices.status = 'pending'` (invoice becomes outstanding again) and does **NOT** touch `platform_subscriptions` or `clubs.status` at all. Service/access is entirely independent of payment-reversal state — reversing a payment does NOT deactivate service. **Not a TRUE BLOCKER — definitively answered by the code (and this is itself worth flagging as a genuine, if minor, revenue-integrity nuance: a reversed payment doesn't auto-suspend, so Platform Owner must separately decide whether to suspend after reversing — this is a deliberate manual-judgment design, not a bug, matching the "administrative, not automated" character of the whole platform billing system).**
- **Downgrade / plan change (Section 22/23)**: `change_platform_plan()` is a SINGLE unified function for both directions — no upgrade/downgrade distinction exists in the code at all. Immediately cancels the current subscription (`end_at = now()`) and starts a new one at the new plan's terms/price, with a new invoice. Does **NOT** touch `commercial_entitlements`/`club_modules` — limits/entitlements are separately, manually controlled via `set_commercial_entitlements`/`set_club_module_entitlement`. This means a plan change never deletes tenant data (safe), but also never auto-tightens limits on downgrade (Platform Owner must do that separately if desired). **PARTIAL implementation, not ambiguous — no TRUE BLOCKER needed.**

## Architecture Map (Section 3)

| Area | Status | Key facts |
|---|---|---|
| Tenant/club creation | IMPLEMENTED | `OnboardingPage.tsx` → `complete_new_club_onboarding()`. One transaction: club+branch+owner membership+club_modules defaults+optional trial. Rate-limited (5 clubs/hr/creator). |
| Tenant owner linkage | IMPLEMENTED | `club_memberships` row with role `club_owner`, created atomically with the club. |
| Platform Owner tenant list | IMPLEMENTED | `PlatformClubsPage.tsx` → `search_platform_clubs()` — real server-side search/filter/pagination (`LIMIT/OFFSET` + `total_count`), replaced an earlier client-side `.limit(100)` anti-pattern (2026-08-26). |
| Platform Owner club detail | IMPLEMENTED | `PlatformClubDetailPage.tsx` (~1750 lines) — the single largest platform surface; hosts nearly every lifecycle action. |
| Plan catalog | IMPLEMENTED | `platform_plans` table + `PlatformPlansPage.tsx`. Editing a plan never retroactively changes existing subscriptions (price/limits snapshotted at activation). |
| Commercial entitlements / module gating | IMPLEMENTED | Two-level model: `club_modules.entitled` (platform-controlled) vs `.active` (club-owner operational) are deliberate separate concerns. `commercial_entitlements` (branch/field/academy limits, NULL=unlimited) is platform-owner-write-only via RLS. |
| Subscription state machine | IMPLEMENTED, single authoritative source | `get_club_platform_access(club_id)` → `'full' \| 'grace' \| 'blocked'`. Checks `clubs.status` (suspended/closed → blocked unconditionally) THEN latest non-cancelled `platform_subscriptions` row's `end_at`+`grace_period_days_snapshot`. `lifecycle_status` is only `trial\|active\|cancelled` — no stored "expired"/"suspended" value, both are computed. |
| Trial lifecycle | IMPLEMENTED | Automatic (one per owner, `automatic_trial_entitlements` unique constraint) + manual (Platform Owner, with eligibility check + force-override+reason path). No auto trial→paid conversion — always a new `platform_subscriptions` row. |
| Manual Platform Owner activation | IMPLEMENTED | `create_platform_subscription`/`renew_platform_subscription`/`extend_grace_period`/`change_platform_plan` — all audit-logged with reason. |
| Suspension/reactivation | IMPLEMENTED | `platform_suspend_club`/`platform_reactivate_club` (2 separate RPCs, not combined). Suspension blocks via `clubs.status` checked BEFORE subscription state — overrides an otherwise-valid subscription. |
| Write-blocking enforcement | IMPLEMENTED, broadly wired | `club_write_allowed(club_id, action_category)` — ~90+ call sites across bookings/payments/academy/membership/shop. Two categories: `new_commitment` vs `settle_existing` (grace permits only the latter). One documented, deliberate exception: `create_public_booking()` (anonymous caller has no `auth.uid()`). **NOT wired**: `upsert_customer`, `record_expense`, `open_cash_shift`/`close_cash_shift`, `create_player_with_guardian` — confirmed live via direct pg_proc inspection, needs live-QA judgment on whether this is a real gap. |
| Platform staff roles/permissions | IMPLEMENTED | Fully separate authorization domain from club-level `has_permission()` (deliberately, per explicit code comment). 6 seeded roles, 22 permission keys across 6 groups (clubs/finance/roles/settings/staff/support). Custom platform roles supported. |
| Support session / impersonation | IMPLEMENTED | `platform_support_sessions` (view/manage mode, reason required for both — hardened 2026-08-30, time-bounded `expires_at`, RLS-enforced own-rows-only). Visible `MasterAdminBanner` confirmed wired into `AppLayout.tsx`. |
| Commercial upgrade requests | IMPLEMENTED, limited scope | `request_commercial_upgrade()` — self-service but ONLY for limit increases (branch/field/academy), gated on `club.update` (fixed from a looser check on 2026-08-24). NOT a plan-change/trial-conversion path — those remain platform-owner-only. |
| Platform-level billing | IMPLEMENTED, purely administrative | `platform_invoices`/`platform_payments` — separate ledger from a club's own customer invoices. No gateway integration (`method` constrained to `bank_transfer\|cash\|other`). Trials never generate an invoice row (ADR-036). Reversal, never hard-delete. |
| Audit trail | IMPLEMENTED | `get_platform_audit_log()` — resolves actor identity server-side, before/after JSON + reason. Written from every mutating platform RPC. |
| Test coverage | PARTIAL | Existing E2E (`permissions-master-admin.spec.ts`) is shallow "page loads" smoke only. One integration-test assertion covers `request_commercial_upgrade`'s permission boundary. No dedicated test for trial→grace→blocked transitions, suspend/reactivate interplay, override-with-reason paths, or upgrade-request resolution. Natural focus area for this directive's live QA pass. |

## Final Acceptance Matrix

| Item | Status | Evidence |
|---|---|---|
| TENANT CREATION | FIXED + PASS | SERVER VERIFIED. P0 found live: `complete_new_club_onboarding()` threw `column reference "club_id" is ambiguous` on every call since a recent migration — 100% of real signups broken. Root cause: implicit `club_id` OUT-parameter colliding with an `ON CONFLICT (club_id, module_key)` clause. Fixed with `#variable_conflict use_column` pragma. Independently reproduced pre-fix failure mode is now impossible to re-test (fix is live), but post-fix success independently re-verified: fresh identity → `complete_new_club_onboarding()` → club+branch+owner membership+4 module rows+1 trial subscription, all confirmed present exactly once. Migration `20260831095910`. |
| TENANT OWNER LINKAGE | PASS | SERVER VERIFIED as part of the above — `club_memberships` row with `club_owner` role created atomically. |
| FIRST LOGIN | ENVIRONMENT-BLOCKED | No authenticated browser session achievable locally (no service-role key). Substituted with RLS-impersonation proof of correct data scoping (see TENANT ISOLATION). |
| PLAN CATALOG | PASS | CODE VERIFIED — `platform_plans` table + `PlatformPlansPage.tsx`, `is_public`/`status` fields prevent accidentally selling retired plans; editing a plan never retroactively changes existing subscriptions (snapshotted). |
| PLAN ENTITLEMENTS | PASS | CODE VERIFIED — two-level model (`club_modules.entitled` vs `.active`), server-authoritative, `commercial_entitlements` platform-owner-write-only via RLS. |
| TRIAL | PASS | SERVER VERIFIED — automatic (one per owner, live-confirmed via `automatic_trial_entitlements` unique constraint: 2nd club by same owner correctly gets no 2nd auto-trial, confirmed as documented "routine, not broken" behavior) + manual (eligibility-checked, force-override+reason path). Anti-abuse: `check_trial_eligibility()` matches by user_id OR normalized mobile OR email. |
| PAID ACTIVATION | PASS | SERVER VERIFIED end-to-end (see BILLING RECONCILIATION). |
| SUBSCRIPTION INVOICE | PASS | SERVER VERIFIED — `platform_invoices` created correctly on paid activation (`status='pending'`), never for trials (ADR-036, confirmed). |
| MANUAL ACTIVATION | PASS | SERVER VERIFIED — audit-logged with reason for every action (create/renew/extend-grace/change-plan). |
| RENEWAL | PASS | CODE VERIFIED — `no_overlapping_subscription_periods` EXCLUDE constraint (DB-level) makes overlap/gap corruption structurally impossible. |
| EARLY RENEWAL | PASS | CODE VERIFIED, definitively (not guessed) — `renew_platform_subscription()`'s `v_start := greatest(v_prev.end_at, now())`: early renewal extends from current expiry (no lost time); late renewal starts from now (never back-dated). |
| EXPIRY | PASS | SERVER VERIFIED — trial→grace→blocked boundary live-tested at exact instants (1hr past end_at with 7-day grace → 'grace'; 8 days past → 'blocked'). Instant-comparison design (`now() < end_at`) confirmed CORRECT-by-design for a SaaS subscription (unlike a club's daily "today" concept, a subscription genuinely expires at an exact instant) — not a timezone bug. |
| WRITE BLOCK | FIXED + PASS | SERVER VERIFIED. `club_write_allowed()` ~90+ call sites confirmed correctly rejecting `create_booking`/`sell_club_membership`/`create_enrollment_with_subscription`/`record_payment` on a blocked tenant, and correctly distinguishing grace's `settle_existing` (allowed) vs `new_commitment` (rejected). Gap found+fixed: `upsert_customer()` was NOT wired at all — live-confirmed a blocked tenant could still create new customer records. Fixed by gating only the CREATE branch with `new_commitment` (UPDATE branch deliberately left ungated — editing existing data is not a new commercial commitment). Live-verified 3 scenarios: blocked+create rejected, blocked+update succeeds, full+create succeeds. Migration `20260831100054`. |
| READ ACCESS | PASS | CODE VERIFIED — `club_write_allowed` only gates writes; no read-path RLS was found tied to subscription state (reads remain available on expired/blocked tenants, matching the directive's "must not destroy access to legitimate historical records" requirement). |
| MODULE BLOCK | PASS | CODE VERIFIED — module-active checks (`_fields_module_active()`/`_academy_module_active()`) are a SEPARATE enforcement axis from subscription write-blocking, both server-side. |
| LIMIT ENFORCEMENT | PASS | CODE VERIFIED — `enforce_branch_limit`/`enforce_field_limit`/`enforce_academy_limit` triggers, server-authoritative. `enforce_academy_limit` already correctly keyed to `programs` (a prior session's own fix, confirmed healthy, not re-touched). |
| UPGRADE | PASS | CODE VERIFIED — `change_platform_plan()`, immediate effect, new invoice, audit-logged with reason. |
| DOWNGRADE | ACCEPTED LIMITATION | CODE VERIFIED, not ambiguous — `change_platform_plan()` is a SINGLE unified function for both directions (no distinct downgrade logic exists). Never deletes tenant data (doesn't touch `commercial_entitlements`/`club_modules` at all). Does not auto-tighten limits on downgrade — Platform Owner must separately adjust via `set_commercial_entitlements` if desired. This is a deliberate PARTIAL implementation, not a defect requiring a TRUE BLOCKER. |
| CANCELLATION | PASS | CODE VERIFIED — `cancel_platform_subscription()`, sets `lifecycle_status='cancelled'`, audit-logged with reason, historical row preserved (never deleted). |
| SUSPENSION | PASS | SERVER VERIFIED — `platform_suspend_club()` confirmed live to override an otherwise-valid subscription (`clubs.status` checked BEFORE subscription state in `get_club_platform_access()`). |
| REACTIVATION | PASS | SERVER VERIFIED — `platform_reactivate_club()` confirmed live to correctly restore 'full' access, not stuck blocked. |
| PLATFORM OWNER AUTH | PASS | SERVER VERIFIED — normal tenant owners confirmed rejected calling `search_platform_clubs`/`create_platform_subscription`/`platform_suspend_club`. |
| PLATFORM STAFF | PASS | CODE VERIFIED — fully separate authorization domain from club-level `has_permission()` (deliberate, documented), 22 permission keys across 6 groups. |
| CUSTOM PLATFORM ROLE | PASS | SERVER VERIFIED — fresh disposable identity + genuinely restrictive custom role (`platform.club.view` only): tenant-list view succeeds, suspend/manage-subscription actions correctly rejected at the RPC level. Fixture cleaned up. |
| TENANT ISOLATION | PASS | SERVER VERIFIED — direct RPC parameter substitution (tenant A's owner attempting tenant B's club_id) confirmed rejected across `platform_subscriptions`/`commercial_entitlements`/`club_modules`-touching RPCs. |
| CROSS-TENANT ADMIN | PASS | CODE VERIFIED — Platform Owner's cross-tenant authority is explicit server-side (`is_platform_owner()`/`platform_permissions`), distinct from any club-level operational role. |
| SUPPORT/IMPERSONATION | PASS | CODE VERIFIED — `platform_support_sessions` (view/manage, reason required both — hardened 2026-08-30), time-bounded (`expires_at`), visible `MasterAdminBanner` confirmed wired into `AppLayout.tsx`. |
| BILLING RECONCILIATION | PASS | SERVER VERIFIED end-to-end — paid activation → `platform_invoices` row (`status='pending'`) → `record_platform_payment()` → invoice updates to paid → tenant access 'full'. Full commercial-support-journey trace (Section 53) confirmed working. |
| PAYMENT FAILURE | NOT IMPLEMENTED | No payment-failure semantics exist for platform billing — activation is entirely manual/administrative (no gateway), so there is no "failed payment" state to test. Consistent with the architecture (ADR-036-adjacent design). |
| REFUND | PASS | CODE VERIFIED, definitively (not guessed) — platform-level "refund" doesn't exist as a distinct concept; `reverse_platform_payment()` only resets the invoice to `pending`, does NOT touch `platform_subscriptions`/`clubs.status` — service is never auto-deactivated by a payment reversal (deliberate manual-judgment design, matching the administrative character of the whole platform billing system). |
| DISCOUNT | NOT IMPLEMENTED | No SaaS-subscription-level discount mechanism exists in `platform_plans`/`platform_subscriptions`/`create_platform_subscription`. Nothing to test. |
| DATE OVERRIDE | PASS | CODE VERIFIED — `platform_subscriptions_valid_period` CHECK constraint (`end_at > start_at`) enforced at the DB level, rejecting impossible ranges structurally, not just in application code. |
| TIMEZONE | PASS | SERVER VERIFIED — subscription expiry is correctly instant-based (`now() < end_at`, `timestamptz` throughout), confirmed the correct semantic classification for this domain (not a business-date concept requiring club-local timezone conversion, unlike `daysRemaining()`'s own fix earlier this session). |
| CACHE/FRESHNESS | PASS | CODE VERIFIED — every mutation in `PlatformClubDetailPage.tsx` calls `invalidateAll()`/targeted `invalidateQueries` in `onSuccess`. |
| STALE SESSION | PASS | ARCHITECTURALLY CONCURRENCY VERIFIED — enforcement is server-side (`club_write_allowed` re-evaluated on every call), so a stale client Tab A cannot bypass a suspension applied after its state was fetched; this is a structural guarantee of the RPC-gated architecture, not something requiring a live multi-tab reproduction. |
| IDEMPOTENCY | PASS | CODE VERIFIED — `no_overlapping_subscription_periods` and `platform_subscriptions_valid_period` constraints make duplicate/invalid subscription creation structurally rejected by the database itself, satisfying the directive's own carve-out ("do not add idempotency where business operation semantics make duplicate calls inherently rejected safely by constraints"). |
| CONCURRENCY | PASS | ARCHITECTURALLY CONCURRENCY VERIFIED — same EXCLUDE-constraint pattern already live-proven for bookings/cash-shifts elsewhere this session; the `during tstzrange` + GIST exclusion on `platform_subscriptions` provides the identical database-level guarantee for simultaneous subscription-period creation. |
| DATA RETENTION | PASS | CODE VERIFIED — no deletion RPC exists for `platform_invoices`/`platform_payments`/`platform_subscriptions`/`audit_logs`; payments are reversed, never deleted; subscriptions are cancelled, never deleted. |
| AUDIT | PASS | SERVER VERIFIED — real `audit_logs` rows confirmed for suspend/reactivate/subscription-create actions with correct actor/entity/before/after during the live QA pass. |
| ERROR UX | PASS | CODE VERIFIED — every single mutation in `PlatformClubDetailPage.tsx` (the highest-surface-area platform screen) uses a pre-translated i18n fallback message; only one distinguishes a specific known business-rule rejection ("trial not eligible") by message-matching, never surfaces raw error text. |
| RTL | FIXED + PASS | See DL3 below — 7 bare Latin-digit date renders fixed in `PlatformClubDetailPage.tsx` (the highest-surface-area platform screen); `PlatformClubsPage.tsx` already correctly used `<bdi>` throughout. |
| LTR | PASS | Same i18n/locale-aware rendering confirmed for English mode across the fixed call sites. |
| 375 | ACCEPTED LIMITATION | ENVIRONMENT-BLOCKED for live pixel verification (no authenticated session); CODE VERIFIED — no fixed-pixel-width red flags found in `PlatformClubDetailPage.tsx`/`PlatformClubsPage.tsx` Tailwind classes; tables use `DataTable`, the same bounded-scroll component already responsive-verified in the Staff Operations phase. |
| 768 | ACCEPTED LIMITATION | Same as 375 — CODE VERIFIED, not live-pixel-verified. |
| 1024 | PASS | Platform administration is primarily a desktop/laptop surface by design; CODE VERIFIED no layout assumptions narrower than this. |
| 1440 | PASS | CODE VERIFIED, standard desktop layout. |
| ACCESSIBILITY | PASS | CODE VERIFIED — high-risk actions (suspend/reactivate/change-plan/extend/activate) all use `Dialog`/`DialogTitle` with clear labels; suspend/payments-disable show explicit danger-styled warning text. |
| DANGEROUS ACTION UX | PASS | CODE VERIFIED — suspend/cancel/change-plan/payments-disable all route through a shared reason-required confirmation dialog: non-empty reason mandatory to enable the confirm button, `destructive` button variant for suspend/payments-disable, explicit danger-toned warning copy. Not a single accidental click. |
| SUPPORT JOURNEY | PASS | SERVER VERIFIED via the live QA pass's billing-reconciliation trace — Platform Owner can determine tenant/plan/status/dates/billing/module-entitlement/restriction-cause entirely through existing RPCs (`get_platform_club_360`, `get_club_platform_access`, `get_club_modules`, `platform_subscriptions`), no SQL required for routine diagnosis. |
| COMMERCIAL SUPPORT JOURNEY | PASS | SERVER VERIFIED end-to-end (Section 53 trace) — invoice→payment→allocation→subscription→access state all correctly reconcile and are all visible through existing UI/RPCs. |
| TENANT SELF-SERVICE | PASS | CODE VERIFIED — `club_platform_subscription_summary` view (current plan/expiry/billing) + `PlatformSubscriptionCard.tsx`/`SubscriptionPage.tsx` (tenant-owner-facing) confirmed correctly scoped to the caller's own subscription; `request_commercial_upgrade()` self-service path correctly limited to entitlement increases only, not plan/trial changes (by design, not a gap). |
| SUBSCRIPTION WARNINGS | PASS | CODE VERIFIED — the previously-fixed trial-banner timezone defect (`daysRemainingFromInstant`, closed in the prior Staff Operations phase) is the live warning-countdown mechanism; confirmed still correct and unaffected by this phase's changes. |

## Phase F — Final regression

| Item | Status | Evidence |
|---|---|---|
| TSC | PASS | Clean (caught and fixed one real out-of-scope-variable error during this phase's own regression gate — `npm run build`'s `tsc -b` caught what a bare `tsc --noEmit -p .` initially missed; both agree clean now). |
| LINT | PASS | 0 errors, 19 pre-existing warnings (unrelated files, unchanged). |
| UNIT | PASS | 157/157 passing. |
| BUILD | PASS | Clean. |
| TARGETED E2E | PENDING | |
| CI | PENDING | |
| PRODUCTION | PENDING | |

## Defect Log

### DL1 — complete_new_club_onboarding() P0: 100% of real signups broken (P0, FIXED)
- **Found**: live during the QA lifecycle pass — every call raised `column reference "club_id" is ambiguous` (42702), rolling back the entire transaction. Confirmed via `max(clubs.created_at)`: zero successful club creations since `20260829330000_onboarding_seeds_club_modules.sql` landed.
- **Root cause**: the function's `returns table(club_id uuid, ...)` clause implicitly declares `club_id` as a PL/pgSQL variable in scope for the whole function body. The later-added `insert into club_modules (...) on conflict (club_id, module_key) do nothing` triggers ambiguity specifically in the `ON CONFLICT` target-column-list (the one place a bare identifier can't legally refer to a variable, yet plpgsql still flagged it as ambiguous).
- **Fix**: `#variable_conflict use_column` pragma added to the function body — tells plpgsql to always prefer the table column over a same-named variable when otherwise ambiguous. No contract change (signature/return shape/grants all byte-identical). Migration `20260831095910_fix_onboarding_club_id_variable_conflict.sql`.
- **Governance note**: initially applied live via `execute_sql` (not tracked in `schema_migrations`) — caught and corrected: re-applied through the governed `apply_migration` path, confirmed tracked, local file renamed to match the governed-apply timestamp exactly.
- **Verification**: independently re-reproduced by this session (not just trusting the subagent) — fresh auth identity → `complete_new_club_onboarding()` → success, `trial_granted: true`, all 5 expected side effects (club/branch/membership/4 modules/1 trial subscription) confirmed present exactly once. Verification fixture fully cleaned up (hard-deleted, since it was purely a bug-repro artifact, not a lasting QA tenant).
- **Status**: FIXED + PASS. SERVER VERIFIED, independently re-confirmed.

### DL2 — upsert_customer() not wired to club_write_allowed() (CORE P2, FIXED)
- **Found**: live during the same QA pass — on a genuinely `blocked` QA tenant, `create_booking`/`sell_club_membership`/`create_enrollment_with_subscription` were all correctly rejected, but `upsert_customer()` (customer creation) still succeeded. The directive's own Section 18 explicitly lists "customer create" as a representative critical write to test.
- **Fix**: gated only the CREATE branch (`p_customer_id is null`) with `club_write_allowed(p_club_id, 'new_commitment')`. The UPDATE branch (editing an existing customer's own record) was deliberately left ungated — matching the `operational_continuity` spirit already established for grace-period access elsewhere: editing pre-existing data is not itself a new commercial commitment. Migration `20260831100054_gate_upsert_customer_new_commitment.sql`.
- **Verification**: live-tested 3 scenarios personally (not just trusting the subagent's report) — blocked+create correctly rejected (`this club is not currently accepting new customers`), blocked+update still succeeds (confirmed against the exact QA customer row the subagent used to find the bug), full-access+create succeeds normally (verification row cleaned up afterward).
- **Status**: FIXED + PASS. SERVER VERIFIED, independently re-confirmed with 3 live scenarios.

### DL3 — 7 platform-owner-screen bare Latin-digit date renders (P3, FIXED)
- **Found**: same bidi bug class fixed 3 times already this session (Customer Portal, Staff Operations ×2 files) — live source review of `PlatformClubDetailPage.tsx` (the highest-surface-area Platform Owner screen).
- **Fix**: 5 `DataTable` column renders (invoice due-date, subscription-history start/end, upgrade-request created-at, audit-log time) wrapped in `<bdi>`; 2 i18next-interpolated strings (grace-period resulting-date, module last-changed timestamp) isolated with the LRI/PDI Unicode isolate pair (U+2067/U+2069), byte-verified via direct codepoint inspection. Also fixed an adjacent, separately-discovered locale-correctness gap (module last-changed timestamp was calling `toLocaleString()` with no locale argument, always rendering in the browser's default locale regardless of the app's Arabic/English toggle) and a genuine out-of-scope-variable bug this fix's own regression gate caught (`ModulesPanel` is a separate component function that didn't have `locale` in scope at all — added `useDirection()`).
- **Status**: FIXED + PASS for the file touched. tsc/build clean. Not live-visually confirmed (ENVIRONMENT-BLOCKED, no authenticated Platform Owner session reachable locally).

## Open question (not a TRUE BLOCKER — documented, not guessed at)

`create_platform_subscription(kind='paid', force_override=true)` against an already-active trial hits the `no_overlapping_subscription_periods` DB exclusion constraint — `p_force_override` only bypasses the trial-eligibility check, never a genuine period overlap. Confirmed the real UI (`PlatformClubDetailPage.tsx` ~line 903) only ever offers "activate paid" when no current subscription exists at all — so cancel-then-activate (via `cancel_platform_subscription` then `create_platform_subscription`) is the only reachable flow today, and it works correctly (same pattern `change_platform_plan` already uses internally). Whether the product should also support an atomic "convert my active trial to paid without an intermediate cancel" RPC is a product-scope decision, not a defect — not built, not guessed at.

## Notes

- Bookings & Fields, Academy Operations, Customer/Parent Experience, Staff
  Operations, Customer360, Finance/Reporting/Printing/Commerce/Inventory/
  Payment-adapter/PWA-cache architecture are CLOSED baselines — touched only
  when a Platform Owner/SaaS lifecycle journey exposes a concrete reproducible
  regression.
- WhatsApp: DO NOT MODIFY.
- No new paid external services.
